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
    previous = json.loads(STATUS.read_text(encoding="utf-8")) if STATUS.exists() else {}
    started = datetime.now(timezone.utc).isoformat()
    results = {}
    for name, command, paths in STAGES:
        print(f"Refreshing {name}…", flush=True)
        ok = refresh_stage(command, paths)
        ended = datetime.now(timezone.utc).isoformat()
        results[name] = {"status": "success" if ok else "failed", "attempted_at": ended,
                         "last_success": ended if ok else previous.get("sources", {}).get(name, {}).get("last_success"),
                         "note": "Refreshed configured sources; individual provider coverage may vary." if ok else "Refresh failed; last-good snapshot retained."}
    payload = {"started_at": started, "completed_at": datetime.now(timezone.utc).isoformat(),
               "schedule": "00:00, 06:00, 12:00, 18:00 America/New_York; scheduling is best effort",
               "status": "success" if all(row["status"] == "success" for row in results.values()) else "partial_failure",
               "sources": results}
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    temp = STATUS.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp.replace(STATUS)
    return 0 if payload["status"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
