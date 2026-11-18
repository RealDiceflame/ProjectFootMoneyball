"""Private, read-only website stats export with full artifact comparison.

This is a shadow export, never a publisher. Facts and source payloads come from
the database; collection envelopes and unarchived schedules remain explicit
file inputs until those datasets have their own database storage.
"""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from app.league_leaders import build_stats_summary
from app.stats_access import require_current_migrations
from app.stats_import import import_plan, load_saved_stats, prepare_snapshot
from app.stats_verification import _bulk_rows, _read_snapshot, _same, verify_database


EXCLUSIONS = [
    {"artifacts": "rankings.json, special_teams.json, player_value_inputs.json, player_values/**",
     "reason": "Ranking CSVs, projections, scoring settings, ADP markets and value-model inputs are not stored in the stats database."},
    {"artifacts": "scores.json, nfl_odds.json, survivor.json",
     "reason": "Live scores, complete schedules, weather, odds and survivor inputs have separate collectors."},
    {"artifacts": "player_news.json, player_intel.json, update_status.json",
     "reason": "News, scouting and collector-health observations are not stored in the stats database."},
    {"artifacts": "snap_counts/**, play_by_play/**",
     "reason": "Participation and play-by-play facts are not stored in the stats database."},
]


def _json(raw):
    def invalid(_):
        raise ValueError("Non-finite JSON is not exportable")
    return json.loads(raw, parse_constant=invalid)


def _encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("utf-8")


def _reference_files(root):
    data = root / "docs/data"
    paths = [data / "player_history.json", *sorted((data / "game_stats").rglob("*.json"))]
    return {path.relative_to(data).as_posix(): path.read_bytes() for path in paths}


def _destinations(root, output, report):
    root, output, report = Path(root).resolve(), Path(output).resolve(), Path(report).resolve()
    protected = {root, Path(__file__).resolve().parents[1]}
    for target in (output, report):
        if any(target == folder or folder in target.parents for folder in protected):
            raise ValueError("Shadow export destinations must be outside the reference checkout")
        if target.exists():
            raise ValueError("Shadow export destinations must be new")
        if not target.parent.is_dir():
            raise ValueError("Create the shadow export destination parent first")
    if output == report or output in report.parents or report in output.parents:
        raise ValueError("The comparison report must be separate from the export directory")
    return root, output, report


def _envelope(value, allowed, required):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= value.keys():
        raise ValueError("Unsupported companion artifact schema")
    if value.get("schema_version") != 1:
        raise ValueError("Unsupported companion artifact version")


def build_artifacts(snapshots, reference):
    """Build all covered artifacts without using reference statistic rows."""
    artifacts, companions, seasons = {}, [], {}

    def companion(path, fields, purpose, **counts):
        raw = reference[path]
        companions.append({"path": path, "sha256": sha256(raw).hexdigest(),
                           "origin": "reference_file", "fields_used": fields,
                           "purpose": purpose, **counts})
        return _json(raw)

    for snapshot in snapshots:
        if snapshot.dataset == "player_history":
            path = "player_history.json"
        else:
            year = snapshot.payload["season"]
            path = f"game_stats/{year}/{snapshot.object_key}.json"
            seasons.setdefault(year, {})[snapshot.object_key] = snapshot.payload
        if path in artifacts:
            raise ValueError("Duplicate export artifact identity")
        artifacts[path] = deepcopy(snapshot.payload)
    if "player_history.json" not in artifacts or not seasons:
        raise ValueError("Both maintained history and game snapshots are required")

    catalogue = companion("game_stats/index.json", ["checked_at", "current_season"],
                          "Collection clock and website season selection", season_count=len(seasons))
    _envelope(catalogue, ("schema_version", "seasons", "checked_at", "current_season"),
              ("seasons", "checked_at", "current_season"))
    artifacts["game_stats/index.json"] = {**catalogue, "seasons": sorted(seasons, reverse=True)}

    for year, games in sorted(seasons.items()):
        folder = f"game_stats/{year}"
        index = companion(f"{folder}/index.json",
                          ["checked_at", "sources", "historical", "expected_games", "coverage_status"],
                          "Collector provenance and historical coverage declarations", archived_games=len(games))
        _envelope(index, ("schema_version", "season", "checked_at", "sources", "games",
                          "historical", "expected_games", "coverage_status"),
                  ("season", "checked_at", "sources", "games"))
        if index["season"] != year:
            raise ValueError("Companion season does not match the database")
        entries = {key: {"week": item["game"]["week"], "home": item["game"]["home"],
                         "away": item["game"]["away"], "updated_at": item["updated_at"],
                         "player_rows": len(item["players"])} for key, item in sorted(games.items())}
        artifacts[f"{folder}/index.json"] = {**index, "games": entries}

        summary = _json(reference[f"{folder}/summary.json"])
        _envelope(summary, ("schema_version", "season", "season_type", "checked_at", "metrics",
                            "periods", "games", "historical", "coverage_status"),
                  ("season", "season_type", "checked_at", "metrics", "periods", "games"))
        if summary["season"] != year or summary["season_type"] != "REG":
            raise ValueError("Companion summary season does not match the database")
        schedule = {}
        for game in summary["games"]:
            key = game["game_id"]
            if key in schedule or not key.startswith(f"{year}_"):
                raise ValueError("Duplicate or mismatched companion schedule identity")
            schedule[key] = {field: value for field, value in game.items()
                             if field not in {"stats_available", "stats_updated_at"}}
        external_games = len(set(schedule) - games.keys())
        companion(f"{folder}/summary.json", ["games (unarchived only)", "historical", "coverage_status"],
                  "Schedule entries without archived box scores; summary facts and leaders are rebuilt",
                  unarchived_schedule_games=external_games, database_schedule_games=len(games))
        # Archived schedule details and all leader values use the DB payloads.
        schedule.update({key: item["game"] for key, item in games.items()})
        player_games = {key: [dict(zip(item["player_columns"], row)) for row in item["players"]]
                        for key, item in games.items()}
        rebuilt = build_stats_summary(year, schedule, player_games, entries, index["checked_at"])
        rebuilt.update({key: summary[key] for key in ("historical", "coverage_status") if key in summary})
        artifacts[f"{folder}/summary.json"] = rebuilt
    return artifacts, companions


def export_and_compare(conn, reference_root, output_dir, report_path):
    """Verify DB facts and export every covered artifact into a new private folder.

    No output directory is installed unless all artifacts compare equal. The
    report distinguishes exact JSON semantics from file formatting/byte hashes.
    Database or reference validation failures raise before accepting any output.
    """
    root, output, report = _destinations(reference_root, output_dir, report_path)
    reference = _reference_files(root)
    saved = load_saved_stats(root)
    for snapshot in saved:
        path = snapshot.source_path.removeprefix("docs/data/")
        if sha256(reference[path]).hexdigest() != snapshot.file_hash:
            raise ValueError("Reference files changed while loading the archive")

    with _read_snapshot(conn):
        require_current_migrations(conn)
        verification = verify_database(conn, saved)
        heads = _bulk_rows(conn, """SELECT h.dataset, h.object_key, h.latest_source_at,
                s.content_sha256, s.source_updated_at, s.payload, s.source_path
            FROM ob_stats.snapshot_heads h JOIN ob_stats.source_snapshots s USING (snapshot_id)
            ORDER BY h.dataset, h.object_key LIMIT %s""", (len(saved) + 1,))
        snapshots, vintages = [], []
        for dataset, key, latest_at, content_hash, stored_at, payload, path in heads:
            snapshot = prepare_snapshot(payload, path)
            expected_path = ("docs/data/player_history.json" if dataset == "player_history"
                             else f"docs/data/game_stats/{payload['season']}/{key}.json")
            if (snapshot.dataset, snapshot.object_key, snapshot.content_hash, snapshot.source_updated_at, path) != (
                    dataset, key, content_hash, stored_at, expected_path):
                raise ValueError("Database source identity, path or payload is inconsistent")
            snapshots.append(snapshot)
            if latest_at != stored_at:
                vintages.append({"path": path.removeprefix("docs/data/"),
                                 "stored_source_at": stored_at.isoformat(),
                                 "current_observation_at": latest_at.isoformat()})
    artifacts, companions = build_artifacts(snapshots, reference)
    compared, mismatches = [], []
    for path in sorted(artifacts.keys() | reference.keys()):
        raw = _encoded(artifacts[path]) if path in artifacts else None
        expected = reference.get(path)
        equal = raw is not None and expected is not None and _same(artifacts[path], _json(expected))
        entry = {"path": path, "semantic_equal": equal, "byte_equal": raw == expected,
                 "export_sha256": sha256(raw).hexdigest() if raw is not None else None,
                 "reference_sha256": sha256(expected).hexdigest() if expected is not None else None}
        compared.append(entry)
        if not equal:
            mismatches.append({"path": path, "reason": "missing_export" if raw is None else
                               "missing_reference" if expected is None else "json_content_differs"})
    # A collector may update files while the read-only DB comparison is running.
    if {key: sha256(raw).hexdigest() for key, raw in _reference_files(root).items()} != {
            key: sha256(raw).hexdigest() for key, raw in reference.items()}:
        raise ValueError("Reference files changed during export; retry against one saved revision")
    result = {"schema_version": 1, "verified": not mismatches, "database_verified": True,
              "scope": "player_history.json and every game_stats JSON artifact",
              "website_changed": False, "ready_for_cutover": False,
              "completed_at": datetime.now(timezone.utc).isoformat(),
              "database_snapshot_counts": import_plan(snapshots),
              "database_verification": {key: verification[key] for key in
                  ("game_metric_checks", "historical_metric_checks", "stored_payload_metadata_matches")},
              "artifacts_compared": len(compared), "artifacts_matched": len(compared) - len(mismatches),
              "byte_equal_artifacts": sum(entry["byte_equal"] for entry in compared),
              "artifacts": compared, "mismatches": mismatches,
              "companion_inputs": companions, "metadata_vintage_gaps": vintages,
              "excluded_artifacts": EXCLUSIONS,
              "limitations": ["This is not a database-only rebuild: listed file companions supply collection metadata and unarchived schedules.",
                              "JSON values and ordered rows are compared completely; formatting differences are reported separately.",
                              "Stored source metadata is preserved; a missing newer observation payload is never fabricated.",
                              "No website switch or publication is performed."],
              "output_created": False}
    if result["verified"]:
        with TemporaryDirectory(prefix=".stats-shadow-", dir=output.parent) as staging:
            stage = Path(staging)
            for path, payload in artifacts.items():
                destination = stage / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(_encoded(payload))
            if output.exists():
                raise ValueError("Shadow export destination appeared during comparison")
            os.rename(stage, output)
        result["output_created"] = True
    # Exclusive creation prevents replacing a previous comparison receipt.
    with report.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    return result
