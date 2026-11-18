"""Watch GitHub sync evidence; never connect to PostgreSQL or read its secrets."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.stats_monitor import HEALTH_EVIDENCE_HOURS, evaluate_health, monitor_config, timestamp, validate_health

REPOSITORY = "RealDiceflame/ProjectFootMoneyball"
HEALTH_ARTIFACT = "stats-sync-health"
CATEGORIES = {"sync": "Sync", "storage": "Storage", "shadow": "Shadow export",
              "collectors": "Scheduled collectors", "monitor": "Monitoring"}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, token):
        if not token:
            raise ValueError("GitHub monitoring token is missing")
        self.token = token
        self.opener = build_opener(NoRedirect())

    def request(self, path, method="GET", body=None):
        if not path.startswith("/") or ".." in path:
            raise ValueError("Unexpected GitHub endpoint")
        url = f"https://api.github.com/repos/{REPOSITORY}{path}"
        headers = {"Accept":"application/vnd.github+json", "Authorization":f"Bearer {self.token}",
                   "X-GitHub-Api-Version":"2022-11-28", "User-Agent":"OutlierBaseline-database-monitor"}
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        with self.opener.open(Request(url, data=data, headers=headers, method=method), timeout=30) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("GitHub response exceeds monitoring limit")
        return json.loads(raw) if raw else None

    def runs(self, workflow):
        if workflow not in {"sync-stats-database.yml", "update-player-news.yml", "update-game-stats.yml"}:
            raise ValueError("Unexpected monitored workflow")
        return self.request(f"/actions/workflows/{workflow}/runs?branch=main&per_page=100")["workflow_runs"]

    def health(self, run, active_since):
        if (run.get("path") != ".github/workflows/sync-stats-database.yml"
                or run.get("head_repository", {}).get("full_name") != REPOSITORY):
            raise ValueError("Health workflow identity differs")
        artifacts = self.request(f"/actions/runs/{int(run['id'])}/artifacts?per_page=100")["artifacts"]
        matches = [artifact for artifact in artifacts if artifact["name"] == HEALTH_ARTIFACT and not artifact["expired"]]
        if not matches:
            if run.get("conclusion") == "success":
                # Creation selects the workflow version; a pre-deployment run
                # may start later from the queue using the old definition.
                if timestamp(run["created_at"]) >= active_since:
                    raise ValueError("A post-activation successful sync is missing its health artifact")
                jobs = self.request(f"/actions/runs/{int(run['id'])}/jobs?per_page=100")["jobs"]
                if any(step.get("name") == "Save aggregate sync health" for job in jobs for step in job.get("steps", [])):
                    raise ValueError("A successful instrumented sync is missing its health artifact")
            return None  # Supports pre-instrumentation successful runs during rollout.
        if len(matches) != 1 or matches[0]["size_in_bytes"] > 1_000_000:
            raise ValueError("Unexpected health artifact inventory")
        artifact = matches[0]
        url = f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{int(artifact['id'])}/zip"
        request = Request(url, headers={"Authorization":f"Bearer {self.token}", "Accept":"application/vnd.github+json",
                                       "User-Agent":"OutlierBaseline-database-monitor"})
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(1_000_001)
        except HTTPError as error:
            if error.code not in {301,302,303,307,308}:
                raise
            location = error.headers.get("Location", "")
            parsed = urlsplit(location)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("Unexpected artifact download redirect") from None
            # Never forward the GitHub token to signed object-storage URLs.
            with self.opener.open(Request(location, headers={"User-Agent":"OutlierBaseline-database-monitor"}), timeout=30) as response:
                raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Health artifact exceeds monitoring limit")
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = archive.infolist()
            if len(names) != 1 or names[0].filename != "stats-sync-health.json" or names[0].file_size > 16384:
                raise ValueError("Health artifact contains unexpected files")
            report = json.loads(archive.read(names[0]))
        validate_health(report, REPOSITORY, run["id"])
        return report

    def monitor_issues(self):
        found = []
        for page in range(1,21):
            values = self.request("/issues?" + urlencode({"state":"all", "creator":"github-actions[bot]", "per_page":100, "page":page}))
            found.extend(issue for issue in values if "pull_request" not in issue)
            if len(values) < 100:
                return found
        raise ValueError("Issue inventory exceeds bounded monitor search")


def marker(category):
    return f"<!-- outlier-stats-monitor:{category}:v1 -->"


def health_candidates(runs, now):
    """Keep evidence recent enough to survive pauses beyond artifact retention."""
    cutoff = now - timedelta(hours=HEALTH_EVIDENCE_HOURS)
    completed = [run for run in runs if run["status"] == "completed" and run["conclusion"] != "skipped"
                 and timestamp(run["updated_at"]) >= cutoff]
    # Repeated attempts keep their original creation date but update this time.
    return sorted(completed,key=lambda run: timestamp(run["updated_at"]),reverse=True)[:32]


def incident_body(category, alert):
    explanations = {
        "sync_failed":"The private database sync or its health-report step failed. Review the linked run before trusting freshness.",
        "sync_overdue":"No successful private database verification has been recorded within the freshness limit.",
        "sync_stalled":"A private database sync has been queued or running longer than the allowed delay.",
        "collector_not_followed_by_sync":"A successful scheduled collector has not been followed by a verified automatic database sync within the allowed delay.",
        "collector_schedule_overdue":"An expected scheduled collector has not started within the freshness limit.",
        "collector_failed":"The latest scheduled collector failed, so its saved source data may be stale.",
        "post_sync_check_failed":"The database import and verification succeeded, but a later reporting or shadow-export step failed. The live website source has not changed.",
        "monitoring_evidence_unavailable":"The monitor could not read or validate its GitHub evidence. Existing incidents were preserved; database health is unknown.",
    }
    if category == "storage":
        explanation = "Database storage needs review: " + alert["code"].replace("+", ", ").replace("_", " ") + "."
    else:
        explanation = explanations[alert["code"]]
    lines = [marker(category), explanation, ""]
    if alert.get("run_id"):
        lines += [f"[Review workflow run](https://github.com/{REPOSITORY}/actions/runs/{int(alert['run_id'])})", ""]
    if category == "storage":
        lines += [f"Measured database: {alert['database_bytes'] / 1024**2:.1f} MiB."]
        if alert.get("growth_bytes") is not None:
            lines += [f"Change within the last 24 hours: {alert['growth_bytes'] / 1024**2:+.1f} MiB."]
        lines += ["This measures PostgreSQL database bytes, not total provisioned disk, WAL, or a billing threshold.", ""]
    if alert.get("collector"):
        lines += [f"Collector: {alert['collector']}.", ""]
    lines += ["This issue is maintained automatically. Repeated unchanged checks do not create comments or additional issues. It closes when fresh evidence shows recovery."]
    return "\n".join(lines)


def reconcile(client, alerts, *, preserve_unmentioned=False, dry_run=False):
    issues = client.monitor_issues()
    changes = []
    for category, label in CATEGORIES.items():
        matches = [issue for issue in issues if marker(category) in (issue.get("body") or "")
                   and issue.get("user", {}).get("login") == "github-actions[bot]"]
        if len(matches) > 1:
            raise ValueError("Duplicate monitor issues require review")
        issue = matches[0] if matches else None
        alert = alerts.get(category)
        if alert:
            body = incident_body(category, alert)
            desired = {"title":f"[Database monitor] {label} needs attention", "body":body, "state":"open"}
            assigned = [value.get("login") if isinstance(value,dict) else value for value in (issue or {}).get("assignees", [])]
            if issue and "RealDiceflame" in assigned and all(issue.get(key) == value for key,value in desired.items()):
                continue
            desired["assignees"] = sorted(set(assigned) | {"RealDiceflame"})
            path, method = (f"/issues/{issue['number']}", "PATCH") if issue else ("/issues", "POST")
            changes.append({"category":category,"action":"update" if issue else "open"})
            if not dry_run:
                client.request(path, method, desired)
        elif issue and issue.get("state") == "open" and not preserve_unmentioned:
            changes.append({"category":category,"action":"close"})
            if not dry_run:
                client.request(f"/issues/{issue['number']}", "PATCH", {"state":"closed", "state_reason":"completed"})
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if os.environ.get("STATS_DATABASE_SYNC_ENABLED") != "true":
        print("Private database sync is disabled; no monitoring alerts were changed.")
        return 0
    client = GitHub(os.environ.get("GH_TOKEN", ""))
    try:
        config = monitor_config(os.environ)
        if config["active_since"] is None:
            raise ValueError("Monitor activation time is required")
        runs = client.runs("sync-stats-database.yml")
        collectors = {"Update site data":client.runs("update-player-news.yml"),
                      "Update game stats":client.runs("update-game-stats.yml")}
        reports = []
        # Keep 24-hour growth coverage with margin, without requiring expired
        # artifacts after a long pause. All run metadata still informs freshness.
        candidates = health_candidates(runs, datetime.now(timezone.utc))
        for run in candidates:
            report = client.health(run, config["active_since"])
            if report:
                reports.append(report)
        alerts = evaluate_health(runs, reports, collectors, now=datetime.now(timezone.utc), config=config)
    except Exception:
        # API exceptions may contain signed artifact URLs or request details.
        changes = reconcile(client, {"monitor":{"code":"monitoring_evidence_unavailable"}}, preserve_unmentioned=True, dry_run=args.dry_run)
        print(json.dumps({"monitor":"evidence_unavailable","changes":changes}))
        return 1
    changes = reconcile(client, alerts, dry_run=args.dry_run)
    print(json.dumps({"monitor":"checked","active_incidents":sorted(alerts),"changes":changes,
                      "verified_health_reports":len(reports),"automatic_chain_reports":sum(report["event"]=="workflow_run" for report in reports)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print("Database monitoring could not finish. Review workflow permissions and evidence; diagnostic details were suppressed.", file=sys.stderr)
        raise SystemExit(1) from None
