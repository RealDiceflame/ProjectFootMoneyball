"""One-command stats, ADP, rankings, and workbook refresh."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.request import Request, urlopen

from config import (
    ADP_DIR, ADP_FILENAME, IS_FROZEN, OUTPUT_DIR, PROJECT_ROOT,
    PROJECTION_SEASON, STAT_SEASON, STATS_DIR, seed_packaged_data,
)
from data_fetcher.adp_importer import (
    adp_source_dates,
    build_combined_adp,
    build_direct_adp,
    build_special_teams_adp,
    latest_adp_date,
    update_yahoo_snapshot,
)
from app.draft_board_exporter import export_switchable_draft_board
from app.web_exporter import export_special_teams, export_web_rankings
from pipeline.runner import run_pipeline

NFLVERSE_URL = ("https://github.com/nflverse/nflverse-data/releases/download/"
                "stats_player/stats_player_reg_{season}.csv")


def saved_adp_health(path, *, state="cached", attempted_at=None):
    """Describe retained values without claiming they were fetched this run."""
    return {provider: {
        "status": "manual" if provider == "Yahoo" else state,
        "freshness": "manual" if provider == "Yahoo" or state == "manual" else "stale" if state == "cached" else "unknown",
        "attempted_at": None if provider == "Yahoo" else attempted_at,
        "last_success": date, "data_updated_at": date,
        "timestamp_kind": "snapshot",
        "note": "User-supplied Yahoo snapshot; date records its import." if provider == "Yahoo" else "Saved snapshot capture date; provider publication time is not supplied.",
    } for provider, date in adp_source_dates(path).items()}


def attach_source_health(destination, health, previous):
    """Keep provider success times stable while publishing new diagnostics."""
    for key, row in health.items():
        old = previous.get(key, {})
        if row.get("status") in {"cached", "failed", "saved"} and old.get("last_success"):
            row["last_success"] = old["last_success"]
    destination = Path(destination)
    payload = json.loads(destination.read_text(encoding="utf-8"))
    payload["source_health"] = health
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(destination)


def existing_source_health(destination):
    try:
        return json.loads(Path(destination).read_text(encoding="utf-8")).get("source_health", {})
    except (OSError, ValueError):
        return {}


def download_file(url, destination):
    """Download without partially replacing a working snapshot."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    request = Request(url, headers={"User-Agent": "ProjectFootMoneyball/1.0"})
    with urlopen(request, timeout=90) as response, temporary.open("wb") as output:
        output.write(response.read())
    temporary.replace(destination)
    return destination


def parse_args():
    parser = argparse.ArgumentParser(description="Refresh data and export the switchable draft board.")
    source_group = parser.add_mutually_exclusive_group()
    source_group.add_argument("--adp-source", help="Current ADP comparison page URL or saved HTML file.")
    source_group.add_argument(
        "--yahoo-snapshot",
        type=Path,
        help="User-downloaded CSV containing Player, Position, and Yahoo or Y! ADP.",
    )
    parser.add_argument(
        "--saved-adp",
        action="store_true",
        help="Reuse the saved ADP instead of checking the direct public feeds.",
    )
    parser.add_argument("--keep-stats", action="store_true", help="Reuse the existing stats CSV.")
    parser.add_argument(
        "--skip-workbook",
        action="store_true",
        help="Update website rankings without creating the Excel workbook.",
    )
    parser.add_argument("--workbook", type=Path,
                        default=OUTPUT_DIR / "ProjectFootMoneyball_Draft_Board.xlsx")
    return parser.parse_args()


def refresh_draft_board(
    adp_source=None,
    keep_stats=False,
    workbook=None,
    *,
    direct_adp=True,
    skip_workbook=False,
    yahoo_snapshot=None,
    status=print,
):
    """Run the complete refresh for either the CLI or desktop application."""
    seed_packaged_data()
    workbook = Path(workbook) if workbook else OUTPUT_DIR / "ProjectFootMoneyball_Draft_Board.xlsx"
    stats_path = STATS_DIR / f"nflverse_player_stats_{STAT_SEASON}.csv"
    special_teams_path = ADP_DIR / f"special_teams_adp_{PROJECTION_SEASON}.csv"
    rankings_destination = PROJECT_ROOT / "docs" / "data" / "rankings.json"
    special_destination = PROJECT_ROOT / "docs" / "data" / "special_teams.json"
    previous_health = existing_source_health(rankings_destination)
    previous_special_health = existing_source_health(special_destination)
    attempted_at = datetime.now(timezone.utc).isoformat()
    health = {}
    special_health = saved_adp_health(special_teams_path, state="saved")
    if keep_stats:
        status(f"[1/4] Reusing {stats_path}")
    else:
        status(f"[1/4] Downloading {STAT_SEASON} season stats...")
        download_file(NFLVERSE_URL.format(season=STAT_SEASON), stats_path)
    if yahoo_snapshot:
        status(f"[2/4] Loading the Yahoo snapshot from {yahoo_snapshot}...")
        update_yahoo_snapshot(yahoo_snapshot, ADP_DIR / ADP_FILENAME)
    if adp_source:
        status(f"[2/4] Refreshing {PROJECTION_SEASON} ADP...")
        build_combined_adp(adp_source, ADP_DIR / ADP_FILENAME)
        health = saved_adp_health(ADP_DIR / ADP_FILENAME, state="manual")
    elif direct_adp:
        status(f"[2/4] Refreshing independent public ADP feeds...")
        refreshed = build_direct_adp(ADP_DIR / ADP_FILENAME, season=PROJECTION_SEASON)
        health = refreshed.attrs.get("source_health", {})
        try:
            special = build_special_teams_adp(special_teams_path, season=PROJECTION_SEASON)
            special_health = special.attrs.get("source_health", {})
        except RuntimeError:
            status("[WARN] Keeping the last K/DST market snapshot; providers unavailable or invalid.")
            special_health = saved_adp_health(special_teams_path, attempted_at=attempted_at)
            if not special_health:
                special_health = {"providers": {"status": "failed", "freshness": "unavailable", "attempted_at": attempted_at, "last_success": None, "note": "No usable K/DST snapshot."}}
    elif not (ADP_DIR / ADP_FILENAME).exists():
        raise FileNotFoundError("No ADP snapshot exists. Run without --saved-adp to fetch it.")
    else:
        status(f"[2/4] Reusing {ADP_DIR / ADP_FILENAME}")
        health = saved_adp_health(ADP_DIR / ADP_FILENAME, state="saved")
    health["stats"] = {
        "status": "historical", "freshness": "historical", "season": STAT_SEASON,
        "attempted_at": None if keep_stats else attempted_at,
        "last_success": previous_health.get("stats", {}).get("last_success") if keep_stats else attempted_at,
        "data_updated_at": None, "note": f"Completed {STAT_SEASON} season statistics; fixed historical baseline.",
    }
    status("[3/4] Rebuilding projections and all 60 ranking formats...")
    run_pipeline()
    if skip_workbook:
        status("[4/4] Skipping the spreadsheet for this website-only refresh.")
        result = workbook
    else:
        status("[4/4] Creating the switchable spreadsheet...")
        result = export_switchable_draft_board(OUTPUT_DIR, workbook)
    if not IS_FROZEN:
        status("[WEB] Updating the browser draft board data...")
        adp_path = ADP_DIR / ADP_FILENAME
        export_web_rankings(
            OUTPUT_DIR,
            rankings_destination,
            projection_season=PROJECTION_SEASON,
            stat_season=STAT_SEASON,
            adp_updated=latest_adp_date(adp_path),
            adp_sources=adp_source_dates(adp_path),
        )
        attach_source_health(rankings_destination, health, previous_health)
        if special_teams_path.exists():
            export_special_teams(
                special_teams_path,
                special_destination,
                projection_season=PROJECTION_SEASON,
            )
            attach_source_health(special_destination, special_health, previous_special_health)
    status(f"[OK] Draft board ready: {result}")
    return result


def main():
    args = parse_args()
    return refresh_draft_board(
        adp_source=args.adp_source,
        keep_stats=args.keep_stats,
        workbook=args.workbook,
        direct_adp=not args.saved_adp,
        skip_workbook=args.skip_workbook,
        yahoo_snapshot=args.yahoo_snapshot,
    )


if __name__ == "__main__":
    main()
