"""Refresh independent site snapshots; retain last-good files when a stage fails."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
STATUS = ROOT / "docs/data/update_status.json"
STAGES = [
    ("rankings", ["refresh_draft_board.py", "--skip-workbook"],
     ["docs/data/rankings.json", "docs/data/special_teams.json", "data/ADP/combined_adp_2026.csv", "data/ADP/special_teams_adp_2026.csv", "data/stats/nflverse_player_stats_2025.csv"]),
    ("news", ["update_player_news.py"], ["docs/data/player_news.json"]),
    ("history", ["update_player_history.py"], ["docs/data/player_history.json"]),
    ("draft_capital", ["update_draft_capital_history.py"], ["docs/data/draft_capital_history.json"]),
    ("odds", ["update_odds_board.py"], ["docs/data/nfl_odds.json"]),
    ("teams", ["update_survivor_board.py"], ["docs/data/survivor.json"]),
]
DEGRADED = {"failed", "cached", "partial_failure", "stale", "behind", "unavailable", "unknown"}


def read_snapshot(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def source_result(name, ok, snapshot, previous, ended, *, extra_providers=None):
    """Separate a completed build from the freshness of its underlying providers."""
    result = {
        "execution_status": "success" if ok else "failed", "attempted_at": ended,
        "last_success": previous.get("last_success"),
        "data_updated_at": snapshot.get("generated_at"),
    }
    if not ok:
        return {**result, "status": "failed", "freshness": "stale", "note": "Refresh failed; last-good snapshot retained.", "providers": snapshot.get("source_health", {})}
    if name in {"history", "draft_capital"}:
        return {**result, "status": "historical", "freshness": "historical",
                "last_success": previous.get("last_success") or snapshot.get("generated_at"),
                "note": "Completed-season historical archive; not a live feed."}
    providers = {**snapshot.get("source_health", {}), **(extra_providers or {})}
    if providers:
        degraded = any(row.get("status") in DEGRADED for row in providers.values())
        result.update(status="partial_failure" if degraded else "success",
                      freshness="mixed" if degraded else "current", providers=providers,
                      note="Refresh completed with retained or unavailable provider data." if degraded else "Provider checks completed; manual and historical sources are labeled separately.")
        if not degraded:
            result["last_success"] = ended
        dates = [row["data_updated_at"] for row in providers.values() if row.get("data_updated_at")]
        result["data_updated_at"] = max(dates, default=None)
        kinds = {row.get("timestamp_kind", "source") for row in providers.values() if row.get("data_updated_at")}
        result["timestamp_kind"] = next(iter(kinds)) if len(kinds) == 1 else "mixed"
    elif name in {"rankings", "odds"}:
        result.update(status="unknown", freshness="unknown", data_updated_at=None,
                      note="Snapshot built, but provider diagnostics were not supplied.")
    else:
        result.update(status="success", freshness="current", last_success=ended,
                      note="Snapshot refreshed successfully.")
    return result


def refresh_stage(command, paths, *, root=ROOT, run=subprocess.run):
    before = {path: (root / path).read_bytes() if (root / path).exists() else None for path in paths}
    code = 1
    for attempt in range(2):
        try:
            code = run([sys.executable, *command], cwd=root, timeout=480, check=False).returncode
        except (subprocess.TimeoutExpired, OSError):
            code = 1
        if code == 0:
            try:
                for path in paths:
                    target = root / path
                    if not target.exists() or target.stat().st_size == 0:
                        raise ValueError("Missing snapshot")
                    if target.suffix == ".json":
                        json.loads(target.read_text(encoding="utf-8"))
                return True
            except (ValueError, OSError):
                code = 1
        # A partial stage cannot replace the last published good snapshots.
        for path, content in before.items():
            target = root / path
            if content is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(content)
        print(f"Stage failed (attempt {attempt + 1}/2); restored its prior snapshots.", flush=True)
    return False


def main():
    previous = read_snapshot(STATUS)
    started = datetime.now(timezone.utc).isoformat()
    results = {}
    for name, command, paths in STAGES:
        print(f"Refreshing {name}…", flush=True)
        ok = refresh_stage(command, paths)
        ended = datetime.now(timezone.utc).isoformat()
        snapshot = read_snapshot(ROOT / paths[0])
        extra = {}
        if name == "rankings":
            special = read_snapshot(ROOT / "docs/data/special_teams.json").get("source_health", {})
            extra = {f"special_teams_{key}": value for key, value in special.items()}
        if name == "news" and snapshot.get("injury_context"):
            context = snapshot["injury_context"]
            extra["injuries"] = {
                "status": "success" if context.get("status") == "current" else context.get("status", "unknown"),
                "freshness": context.get("status", "unknown"),
                "attempted_at": context.get("checked_at"),
                "data_updated_at": context.get("data_updated_at") or context.get("latest_report_date"),
                "expected_week": context.get("expected_week"),
                "season": context.get("season"),
                "latest_report_week": context.get("latest_report_week"),
                "latest_report_season": context.get("latest_report_season"),
                "note": context.get("note", "Injury coverage requires current-week reports."),
            }
        results[name] = source_result(name, ok, snapshot, previous.get("sources", {}).get(name, {}), ended, extra_providers=extra)
        if name == "news":
            headlines = snapshot.get("league_news", {})
            ready = headlines.get("status") == "ok" and bool(headlines.get("items"))
            results["headlines"] = {"status": "success" if ready and ok else "cached" if headlines.get("items") else "failed", "attempted_at": ended,
                "execution_status": "success" if ok else "failed", "freshness": "current" if ready and ok else "stale",
                "last_success": headlines.get("updated_at") if ready and ok else previous.get("sources", {}).get("headlines", {}).get("last_success"),
                "data_updated_at": headlines.get("updated_at"), "note": headlines.get("source", "NFL RSS")
                    if ready else "Headline providers failed; previous stories retained. Roster/injury refresh is independent."}
    payload = {"started_at": started, "completed_at": datetime.now(timezone.utc).isoformat(),
               "schedule": "00:00, 06:00, 12:00, 18:00 America/New_York; scheduling is best effort",
               "execution_status": "success" if all(row["execution_status"] == "success" for row in results.values()) else "partial_failure",
               "status": "partial_failure" if any(row["status"] in DEGRADED for row in results.values()) else "success",
               "sources": results}
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    temp = STATUS.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp.replace(STATUS)
    return 0 if payload["status"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
