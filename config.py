"""
config.py

Central settings for the fantasy football pipeline.

This file controls which NFL stat season and fantasy projection season
the project is currently preparing.
"""

from pathlib import Path


# Main project folder
PROJECT_ROOT = Path(__file__).resolve().parent


# --------------------------------------------------
# Season Settings
# --------------------------------------------------

# The NFL season the real stats came from.
# Example: 2024 stats were used for 2025 fantasy draft analysis.
STAT_SEASON = 2024

# The fantasy season we are preparing for.
PROJECTION_SEASON = 2025


# --------------------------------------------------
# ADP Settings
# --------------------------------------------------

ADP_PROVIDER = "4for4"
ADP_SNAPSHOT_DATE = "2025-08-27"


# --------------------------------------------------
# Folder Settings
# --------------------------------------------------

DATA_DIR = PROJECT_ROOT / "data"
STATS_DIR = DATA_DIR / "stats"
ADP_DIR = DATA_DIR / "ADP"

OUTPUT_DIR = PROJECT_ROOT / "output" / f"{PROJECTION_SEASON}_preseason"


# --------------------------------------------------
# Source URLs
# --------------------------------------------------

def get_stat_urls(stat_season: int) -> dict[str, str]:
    """
    Build the Pro Football Reference URLs for a given NFL stat season.

    Example:
    stat_season = 2024 gives us the 2024 passing, rushing, and receiving pages.
    """

    return {
        "Passing": f"https://www.pro-football-reference.com/years/{stat_season}/passing.htm#passing",
        "Rushing": f"https://www.pro-football-reference.com/years/{stat_season}/rushing.htm#rushing",
        "Receiving": f"https://www.pro-football-reference.com/years/{stat_season}/receiving.htm#receiving",
    }