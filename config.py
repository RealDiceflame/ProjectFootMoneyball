"""
config.py

Central settings for the fantasy football pipeline.

This file controls which NFL stat season and fantasy projection season
the project is currently preparing.
"""

from pathlib import Path
import sys


# During development, files live beside config.py. In the packaged Windows
# application they live beside the executable so data and output remain easy
# for the user to find and update.
if getattr(sys, "frozen", False):
    PROJECT_ROOT = Path(sys.executable).resolve().parent
else:
    PROJECT_ROOT = Path(__file__).resolve().parent


# --------------------------------------------------
# Season Settings
# --------------------------------------------------

# The NFL season the real stats came from.
# Example: 2024 stats were used for 2025 fantasy draft analysis.
STAT_SEASON = 2025

# The fantasy season we are preparing for.
PROJECTION_SEASON = 2026


# --------------------------------------------------
# ADP Settings
# --------------------------------------------------

ADP_PROVIDER = "Yahoo + Sleeper + ESPN/NFL"
ADP_SNAPSHOT_DATE = "2026-08-29"
ADP_FILENAME = "combined_adp_2026.csv"


# --------------------------------------------------
# League Format Settings
# --------------------------------------------------

# Default draft board: 12 teams, two starting QBs, and a 0.5-point
# reception bonus for tight ends on top of half-PPR scoring.
LEAGUE_TEAMS = 12
TE_RECEPTION_BONUS = 0.5


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
