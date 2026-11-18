"""Aggregate-only database health reports and quiet monitor decisions."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path

COUNT_KEYS = {"snapshots", "players", "games", "player_game_rows", "team_game_rows", "player_season_rows"}
HEALTH_EVIDENCE_HOURS = 48
DEFAULTS = {"stale_hours": 10.0, "chain_grace_hours": 3.0,
            "warn_bytes": 1024 ** 3, "growth_bytes": 250 * 1024 ** 2,
            "growth_ratio": 0.25, "growth_window_hours": 24.0}


def timestamp(value):
    result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Health timestamps require a timezone")
    return result.astimezone(timezone.utc)


def _integer(value, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError("Invalid aggregate health value")
    return value


def validate_health(report, repository=None, run_id=None):
    required = {"schema_version", "verified", "completed_at", "repository", "run_id", "run_attempt",
                "event", "upstream_run_id", "counts", "storage", "website_changed"}
    if not isinstance(report, dict) or set(report) != required or type(report["schema_version"]) is not int or report["schema_version"] != 1:
        raise ValueError("Unsupported database health report")
    if report["verified"] is not True or report["website_changed"] is not False:
        raise ValueError("Unverified database health report")
    timestamp(report["completed_at"])
    _integer(report["run_id"], 1)
    _integer(report["run_attempt"], 1)
    if repository is not None and report["repository"] != repository:
        raise ValueError("Health report repository differs")
    if run_id is not None and report["run_id"] != run_id:
        raise ValueError("Health report workflow differs")
    if report["event"] not in {"workflow_dispatch", "workflow_run"}:
        raise ValueError("Unsupported sync trigger")
    if report["upstream_run_id"] is not None:
        _integer(report["upstream_run_id"], 1)
    if (report["event"] == "workflow_run") != (report["upstream_run_id"] is not None):
        raise ValueError("Health report upstream identity missing or unexpected")
    if not isinstance(report["counts"], dict) or set(report["counts"]) != COUNT_KEYS:
        raise ValueError("Health report counts differ")
    for value in report["counts"].values():
        _integer(value)
    if not isinstance(report["storage"], dict) or set(report["storage"]) != {"database_bytes", "application_relations_bytes"}:
        raise ValueError("Health report storage differs")
    for value in report["storage"].values():
        _integer(value)
    return report


def write_health_report(conn, sync_result, destination):
    """Record only verified counts and byte sizes using the restricted connection."""
    verification = sync_result.get("verification", {})
    if verification.get("verified") is not True:
        raise ValueError("Full verification is required before health reporting")
    with conn.transaction(force_rollback=True):
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SET LOCAL statement_timeout = '15s'")
        sizes = conn.execute("""SELECT pg_database_size(current_database()),
            COALESCE((SELECT sum(pg_total_relation_size(c.oid))::bigint
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'ob_stats' AND c.relkind IN ('r', 'm')), 0)""").fetchone()
    upstream = os.environ.get("STATS_SYNC_UPSTREAM_RUN_ID", "").strip()
    report = {
        "schema_version": 1, "verified": True,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "repository": os.environ.get("GITHUB_REPOSITORY", ""),
        "run_id": int(os.environ.get("GITHUB_RUN_ID", "0")),
        "run_attempt": int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")),
        "event": os.environ.get("GITHUB_EVENT_NAME", ""),
        "upstream_run_id": int(upstream) if upstream else None,
        "counts": {key: verification[key] for key in sorted(COUNT_KEYS)},
        "storage": {"database_bytes": sizes[0], "application_relations_bytes": sizes[1]},
        "website_changed": False,
    }
    validate_health(report)
    path = Path(destination)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)
    return report


def monitor_config(environment, *, now=None):
    names = {"stale_hours": "STATS_MONITOR_STALE_HOURS", "warn_bytes": "STATS_MONITOR_WARN_BYTES",
             "growth_bytes": "STATS_MONITOR_GROWTH_BYTES", "growth_ratio": "STATS_MONITOR_GROWTH_RATIO"}
    result = dict(DEFAULTS)
    for key, name in names.items():
        raw = environment.get(name, "").strip()
        if raw:
            value = int(raw) if key.endswith("bytes") else float(raw)
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Invalid database monitor threshold")
            result[key] = value
    active = environment.get("STATS_MONITOR_ACTIVE_SINCE", "").strip()
    result["active_since"] = timestamp(active) if active else None
    if result["active_since"] is not None and result["active_since"] > (now or datetime.now(timezone.utc)):
        raise ValueError("Monitor activation time cannot be in the future")
    return result


def evaluate_health(runs, reports, collectors, *, now, config=None):
    """Return stable incident categories, without writing issues or database data."""
    config = config or DEFAULTS
    alerts = {}
    usable = [run for run in runs if run.get("head_branch") == "main"
              and run.get("event") in {"workflow_run", "workflow_dispatch"}]
    # A retry retains its original created_at. Use the latest attempt start so a
    # successful retry can resolve a newer-created but older-executed failure.
    usable.sort(key=lambda run: timestamp(run.get("run_started_at") or run["created_at"]), reverse=True)
    completed = [run for run in usable if run.get("status") == "completed" and run.get("conclusion") != "skipped"]
    valid_reports = []
    run_by_id = {run["id"]: run for run in usable}
    for report in reports:
        run = run_by_id.get(report.get("run_id"))
        if not run or run.get("status") != "completed":
            continue
        validate_health(report, "RealDiceflame/ProjectFootMoneyball", run["id"])
        start = timestamp(run.get("run_started_at") or run["created_at"])
        end = timestamp(run["updated_at"])
        if (report["run_attempt"] != run.get("run_attempt", 1)
                or report["event"] != run["event"]
                or run.get("path") != ".github/workflows/sync-stats-database.yml"
                or run.get("head_repository", {}).get("full_name") != "RealDiceflame/ProjectFootMoneyball"
                or timestamp(report["completed_at"]) < start - timedelta(seconds=5)
                or timestamp(report["completed_at"]) > end + timedelta(seconds=5)
                or timestamp(report["completed_at"]) > now + timedelta(minutes=5)):
            raise ValueError("Health report attempt or timestamp differs")
        valid_reports.append(report)
    valid_reports.sort(key=lambda report: timestamp(report["completed_at"]), reverse=True)
    report_ids = {report["run_id"] for report in valid_reports}
    active = [run for run in usable if run.get("status") != "completed"]

    def cancellation_recovery_started(run):
        if run.get("conclusion") != "cancelled" or run["id"] in report_ids:
            return False
        cancelled_start = timestamp(run.get("run_started_at") or run["created_at"])
        return any(replacement.get("path") == ".github/workflows/sync-stats-database.yml"
                   and replacement.get("head_repository", {}).get("full_name") == "RealDiceflame/ProjectFootMoneyball"
                   and replacement.get("status") in {"queued", "pending", "in_progress", "waiting", "requested"}
                   and cancelled_start < timestamp(replacement.get("run_started_at") or replacement["created_at"]) <= now
                   for replacement in active)

    # GitHub may cancel a pending run when a newer run takes its concurrency
    # slot. Recovery in progress suppresses that cancellation alone; earlier
    # failures, verified post-sync cancellations, stalls and staleness remain.
    outcomes = [run for run in completed if not cancellation_recovery_started(run)]
    latest = outcomes[0] if outcomes else None
    if latest and latest["conclusion"] != "success":
        category = "shadow" if latest["id"] in report_ids else "sync"
        alerts[category] = {"code": "post_sync_check_failed" if category == "shadow" else "sync_failed",
                            "run_id": latest["id"]}
    # Bootstrap accepts a pre-instrumentation successful run as a heartbeat,
    # but cannot infer storage health from it. Once reports exist they prove
    # actual import+verification even when a subsequent shadow check fails.
    successes = [timestamp(run["updated_at"]) for run in completed if run["conclusion"] == "success"]
    successes += [timestamp(report["completed_at"]) for report in valid_reports]
    last_success = max(successes) if successes else None
    if "sync" not in alerts and (last_success is None or now - last_success > timedelta(hours=config["stale_hours"])):
        alerts["sync"] = {"code": "sync_overdue", "last_success": last_success.isoformat() if last_success else None}
    # A workflow can queue indefinitely while no fresh success is recorded.
    if active and now - min(timestamp(run.get("run_started_at") or run["created_at"]) for run in active) > timedelta(hours=config["chain_grace_hours"]):
        alerts["sync"] = {"code": "sync_stalled", "run_id": active[-1]["id"]}
    successful_collectors = []
    for name, source_runs in collectors.items():
        scheduled = sorted((run for run in source_runs if run.get("head_branch") == "main"
                            and run.get("event") == "schedule"), key=lambda run: timestamp(run["created_at"]), reverse=True)
        if not scheduled or now - timestamp(scheduled[0]["created_at"]) > timedelta(hours=config["stale_hours"]):
            alerts["collectors"] = {"code": "collector_schedule_overdue", "collector": name}
        elif scheduled[0].get("status") == "completed" and scheduled[0].get("conclusion") != "success":
            alerts["collectors"] = {"code": "collector_failed", "collector": name, "run_id": scheduled[0]["id"]}
        successful_collectors.extend(run for run in scheduled if run.get("conclusion") == "success")
    # After deployment, exact parent IDs in health reports provide chain evidence.
    # Activation starts this check even before the first health report arrives.
    linked = {report["upstream_run_id"] for report in valid_reports if report["event"] == "workflow_run"}
    chain_since = config.get("active_since")
    if chain_since is not None:
        chain_since = max(chain_since, now - timedelta(hours=HEALTH_EVIDENCE_HOURS))
    elif valid_reports:
        chain_since = min(timestamp(report["completed_at"]) for report in valid_reports)
    if chain_since is not None:
        missing = [run for run in successful_collectors if timestamp(run["updated_at"]) >= chain_since
                   and now - timestamp(run["updated_at"]) > timedelta(hours=config["chain_grace_hours"])
                   and run["id"] not in linked]
        if missing:
            # Coalescing is legitimate only when the automatic sync starts
            # after the collector finishes. An overlapping sync may have checked
            # out main before the collector committed its new data.
            latest_chain = max((timestamp(run_by_id[report["run_id"]].get("run_started_at")
                                          or run_by_id[report["run_id"]]["created_at"])
                                for report in valid_reports if report["event"] == "workflow_run"), default=None)
            pending = [run for run in missing if latest_chain is None or timestamp(run["updated_at"]) > latest_chain]
            if pending:
                alerts["sync"] = {"code": "collector_not_followed_by_sync", "run_id": max(pending, key=lambda run: run["updated_at"])["id"]}
    if valid_reports:
        recent = valid_reports[0]
        current_size = recent["storage"]["database_bytes"]
        reasons = []
        if current_size >= config["warn_bytes"]:
            reasons.append("database_size_warning")
        older = [report for report in valid_reports[1:] if timedelta(0) < timestamp(recent["completed_at"]) - timestamp(report["completed_at"]) <= timedelta(hours=config["growth_window_hours"])]
        growth = None
        if older:
            baseline = older[-1]["storage"]["database_bytes"]
            growth = current_size - baseline
            if growth >= config["growth_bytes"] and growth >= baseline * config["growth_ratio"]:
                reasons.append("unusual_database_growth")
        if reasons:
            alerts["storage"] = {"code": "+".join(reasons), "database_bytes": current_size,
                                 "growth_bytes": growth, "run_id": recent["run_id"]}
    return alerts
