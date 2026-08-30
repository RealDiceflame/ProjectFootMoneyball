"""Build a normalized 2026 ADP file from current platform market data."""

from pathlib import Path
import re

import pandas as pd


TEAM_CODES = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}


def _split_player_and_team(value):
    text = str(value).strip()
    team_pattern = "|".join(sorted(TEAM_CODES, key=len, reverse=True))
    match = re.match(rf"^(.*?)(?:({team_pattern}))$", text)
    if not match:
        return text, pd.NA
    return match.group(1).strip(), match.group(2)


def build_combined_adp(source, output_path):
    """Create Yahoo, Sleeper, and official-NFL-game ADP columns.

    NFL.com now directs fantasy players to ESPN, so the source site's ESPN
    column is retained as the official NFL-game reference and labeled clearly.
    """
    table = pd.read_html(source)[0]
    player_team = table["Player"].apply(_split_player_and_team)

    output = pd.DataFrame(
        {
            "Player": player_team.str[0],
            "Team": player_team.str[1],
            "Position": table["Pos"],
            "Yahoo": pd.to_numeric(
                table["Yahoo 1QB Half-PPRSame market"], errors="coerce"
            ),
            "Sleeper": pd.to_numeric(
                table["Sleeper Half-PPRPrimary market"], errors="coerce"
            ),
            "NFL": pd.to_numeric(
                table["ESPN 1QB PPRQueue reference"], errors="coerce"
            ),
        }
    )
    output["ADP"] = output[["Yahoo", "Sleeper", "NFL"]].mean(axis=1)
    output["NFL_Source"] = "ESPN (official fantasy game of NFL)"
    output["Source_Updated"] = "2026-08-29"

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(output_path, index=False)
    print(f"[OK] Saved {len(output)} combined ADP rows to {output_path}")
    return output


if __name__ == "__main__":
    project_root = Path(__file__).resolve().parents[1]
    build_combined_adp(
        project_root / "data" / "ADP" / "fantasydraft_half_ppr_2026.html",
        project_root / "data" / "ADP" / "combined_adp_2026.csv",
    )
