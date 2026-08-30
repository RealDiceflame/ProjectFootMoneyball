"""One-command stats, ADP, rankings, and workbook refresh."""

import argparse
from pathlib import Path
from urllib.request import Request, urlopen

from config import ADP_DIR, ADP_FILENAME, OUTPUT_DIR, PROJECTION_SEASON, STAT_SEASON, STATS_DIR
from data_fetcher.adp_importer import build_combined_adp
from app.draft_board_exporter import export_switchable_draft_board
from pipeline.runner import run_pipeline

NFLVERSE_URL = ("https://github.com/nflverse/nflverse-data/releases/download/"
                "stats_player/stats_player_reg_{season}.csv")


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
    parser.add_argument("--adp-source", help="Current ADP comparison page URL or saved HTML file.")
    parser.add_argument("--keep-stats", action="store_true", help="Reuse the existing stats CSV.")
    parser.add_argument("--workbook", type=Path,
                        default=OUTPUT_DIR / "ProjectFootMoneyball_Draft_Board.xlsx")
    return parser.parse_args()


def refresh_draft_board(adp_source=None, keep_stats=False, workbook=None, status=print):
    """Run the complete refresh for either the CLI or desktop application."""
    workbook = Path(workbook) if workbook else OUTPUT_DIR / "ProjectFootMoneyball_Draft_Board.xlsx"
    stats_path = STATS_DIR / f"nflverse_player_stats_{STAT_SEASON}.csv"
    if keep_stats:
        status(f"[1/4] Reusing {stats_path}")
    else:
        status(f"[1/4] Downloading {STAT_SEASON} season stats...")
        download_file(NFLVERSE_URL.format(season=STAT_SEASON), stats_path)
    if adp_source:
        status(f"[2/4] Refreshing {PROJECTION_SEASON} ADP...")
        build_combined_adp(adp_source, ADP_DIR / ADP_FILENAME)
    elif not (ADP_DIR / ADP_FILENAME).exists():
        raise FileNotFoundError("No ADP snapshot exists. Pass --adp-source with a URL or saved HTML file.")
    else:
        status(f"[2/4] Reusing {ADP_DIR / ADP_FILENAME}")
    status("[3/4] Rebuilding projections and all 60 ranking formats...")
    run_pipeline()
    status("[4/4] Creating the switchable spreadsheet...")
    result = export_switchable_draft_board(OUTPUT_DIR, workbook)
    status(f"[OK] Draft board ready: {result}")
    return result


def main():
    args = parse_args()
    return refresh_draft_board(
        adp_source=args.adp_source,
        keep_stats=args.keep_stats,
        workbook=args.workbook,
    )


if __name__ == "__main__":
    main()
