"""Build market-anchored fantasy projections for rookies.

Season-long sportsbook totals provide the primary yardage and touchdown estimates.
When a market does not offer every stat needed for fantasy scoring, the missing
secondary stats are estimated with median 2025 NFL positional rates.  The source
betting lines remain unchanged in the generated projection file.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd


PROJECTION_COLUMNS = [
    "Player",
    "Pos",
    "Team",
    "Games",
    "Cmp",
    "Att",
    "Passing Yds",
    "Passing TD",
    "Int",
    "Rush Att",
    "Rush Yds",
    "Rush TDs",
    "Recs",
    "Rec Yds",
    "Rec TDs",
    "Fumbles",
    "Projection Method",
    "Market Snapshot Date",
    "Market Source",
]


def _numbers(series: pd.Series) -> pd.Series:
    """Return a numeric copy without changing the caller's DataFrame."""
    return pd.to_numeric(series, errors="coerce")


def _median_ratio(
    frame: pd.DataFrame,
    numerator: str,
    denominator: str,
    minimum_denominator: float,
) -> float:
    """Calculate a robust median rate for players with meaningful volume."""
    numerator_values = _numbers(frame[numerator])
    denominator_values = _numbers(frame[denominator])
    eligible = denominator_values >= minimum_denominator
    ratios = numerator_values[eligible] / denominator_values[eligible]
    ratios = ratios.replace([float("inf"), float("-inf")], pd.NA).dropna()
    if ratios.empty:
        raise ValueError(
            f"No eligible rows for {numerator}/{denominator} "
            f"with denominator >= {minimum_denominator}."
        )
    return float(ratios.median())


def calculate_positional_rates(stats: pd.DataFrame) -> dict[str, dict[str, float]]:
    """Calculate the 2025 positional rates used for uncovered fantasy stats."""
    required = {
        "position",
        "completions",
        "attempts",
        "passing_yards",
        "passing_interceptions",
        "carries",
        "rushing_yards",
        "rushing_tds",
        "receptions",
        "receiving_yards",
        "receiving_tds",
    }
    missing = sorted(required - set(stats.columns))
    if missing:
        raise ValueError(f"NFL stats file is missing required columns: {missing}")

    positions = stats["position"].astype(str).str.upper()
    qb = stats[positions == "QB"]
    rb = stats[positions == "RB"]
    wr = stats[positions == "WR"]
    te = stats[positions == "TE"]

    return {
        "QB": {
            "attempts_per_pass_yard": _median_ratio(
                qb, "attempts", "passing_yards", 1_500
            ),
            "completions_per_attempt": _median_ratio(
                qb, "completions", "attempts", 200
            ),
            "interceptions_per_pass_yard": _median_ratio(
                qb, "passing_interceptions", "passing_yards", 1_500
            ),
            "rush_yards_per_pass_yard": _median_ratio(
                qb, "rushing_yards", "passing_yards", 1_500
            ),
            "rush_tds_per_pass_yard": _median_ratio(
                qb, "rushing_tds", "passing_yards", 1_500
            ),
            "carries_per_pass_yard": _median_ratio(
                qb, "carries", "passing_yards", 1_500
            ),
        },
        "RB": {
            "carries_per_rush_yard": _median_ratio(
                rb, "carries", "rushing_yards", 300
            ),
            "rush_tds_per_rush_yard": _median_ratio(
                rb, "rushing_tds", "rushing_yards", 300
            ),
            "receptions_per_rush_yard": _median_ratio(
                rb, "receptions", "rushing_yards", 300
            ),
            "rec_yards_per_rush_yard": _median_ratio(
                rb, "receiving_yards", "rushing_yards", 300
            ),
            "rec_tds_per_rush_yard": _median_ratio(
                rb, "receiving_tds", "rushing_yards", 300
            ),
        },
        "WR": {
            "receptions_per_rec_yard": _median_ratio(
                wr, "receptions", "receiving_yards", 250
            ),
            "rec_tds_per_rec_yard": _median_ratio(
                wr, "receiving_tds", "receiving_yards", 250
            ),
        },
        "TE": {
            "receptions_per_rec_yard": _median_ratio(
                te, "receptions", "receiving_yards", 200
            ),
            "rec_tds_per_rec_yard": _median_ratio(
                te, "receiving_tds", "receiving_yards", 200
            ),
        },
    }


def _market_value(player_lines: pd.DataFrame, market: str) -> float | None:
    matches = player_lines[player_lines["Market"] == market]
    if matches.empty:
        return None
    return float(matches.iloc[0]["Line"])


def build_rookie_prop_projections(
    lines_path: str | Path,
    stats_path: str | Path,
    output_path: str | Path,
) -> pd.DataFrame:
    """Generate the rookie CSV consumed by the main fantasy pipeline."""
    lines = pd.read_csv(lines_path)
    stats = pd.read_csv(stats_path, low_memory=False)
    rates = calculate_positional_rates(stats)

    required_line_columns = {
        "Player",
        "Pos",
        "Team",
        "Market",
        "Line",
        "Snapshot_Date",
        "Sportsbook",
    }
    missing = sorted(required_line_columns - set(lines.columns))
    if missing:
        raise ValueError(f"Rookie betting lines file is missing columns: {missing}")

    lines["Line"] = pd.to_numeric(lines["Line"], errors="raise")
    rows: list[dict[str, object]] = []

    for player, player_lines in lines.groupby("Player", sort=False):
        first = player_lines.iloc[0]
        pos = str(first["Pos"]).upper()
        if pos not in rates:
            raise ValueError(f"Unsupported rookie position for {player}: {pos}")

        projection: dict[str, object] = {
            "Player": player,
            "Pos": pos,
            "Team": first["Team"],
            # Lines are full-season totals. Keeping Games at 17 prevents the
            # downstream 17-game normalizer from inflating them.
            "Games": 17,
            "Cmp": 0.0,
            "Att": 0.0,
            "Passing Yds": 0.0,
            "Passing TD": 0.0,
            "Int": 0.0,
            "Rush Att": 0.0,
            "Rush Yds": 0.0,
            "Rush TDs": 0.0,
            "Recs": 0.0,
            "Rec Yds": 0.0,
            "Rec TDs": 0.0,
            "Fumbles": 0.0,
            "Projection Method": (
                "Sportsbook season total(s); uncovered secondary stats use "
                "median 2025 NFL positional rates"
            ),
            "Market Snapshot Date": first["Snapshot_Date"],
            "Market Source": first["Sportsbook"],
        }

        if pos == "QB":
            pass_yards = _market_value(player_lines, "passing_yards")
            if pass_yards is None:
                raise ValueError(f"QB {player} has no passing-yards market.")
            pass_tds = _market_value(player_lines, "passing_touchdowns")
            qb_rates = rates["QB"]
            attempts = pass_yards * qb_rates["attempts_per_pass_yard"]
            projection.update(
                {
                    "Att": attempts,
                    "Cmp": attempts * qb_rates["completions_per_attempt"],
                    "Passing Yds": pass_yards,
                    "Passing TD": pass_tds if pass_tds is not None else 0.0,
                    "Int": pass_yards * qb_rates["interceptions_per_pass_yard"],
                    "Rush Att": pass_yards * qb_rates["carries_per_pass_yard"],
                    "Rush Yds": pass_yards * qb_rates["rush_yards_per_pass_yard"],
                    "Rush TDs": pass_yards * qb_rates["rush_tds_per_pass_yard"],
                }
            )
        elif pos == "RB":
            rush_yards = _market_value(player_lines, "rushing_yards")
            if rush_yards is None:
                raise ValueError(f"RB {player} has no rushing-yards market.")
            rush_tds = _market_value(player_lines, "rushing_touchdowns")
            rb_rates = rates["RB"]
            projection.update(
                {
                    "Rush Att": rush_yards * rb_rates["carries_per_rush_yard"],
                    "Rush Yds": rush_yards,
                    "Rush TDs": (
                        rush_tds
                        if rush_tds is not None
                        else rush_yards * rb_rates["rush_tds_per_rush_yard"]
                    ),
                    "Recs": rush_yards * rb_rates["receptions_per_rush_yard"],
                    "Rec Yds": rush_yards * rb_rates["rec_yards_per_rush_yard"],
                    "Rec TDs": rush_yards * rb_rates["rec_tds_per_rush_yard"],
                }
            )
        else:
            rec_yards = _market_value(player_lines, "receiving_yards")
            if rec_yards is None:
                raise ValueError(f"{pos} {player} has no receiving-yards market.")
            rec_tds = _market_value(player_lines, "receiving_touchdowns")
            receiver_rates = rates[pos]
            projection.update(
                {
                    "Recs": rec_yards * receiver_rates["receptions_per_rec_yard"],
                    "Rec Yds": rec_yards,
                    "Rec TDs": (
                        rec_tds
                        if rec_tds is not None
                        else rec_yards * receiver_rates["rec_tds_per_rec_yard"]
                    ),
                }
            )

        for column in PROJECTION_COLUMNS:
            if isinstance(projection[column], float):
                projection[column] = round(projection[column], 1)
        rows.append(projection)

    projections = pd.DataFrame(rows, columns=PROJECTION_COLUMNS)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    projections.to_csv(output_path, index=False)
    print(
        f"[OK] Built {len(projections)} market-anchored rookie projection(s) "
        f"at {output_path}"
    )
    return projections


if __name__ == "__main__":
    project_root = Path(__file__).resolve().parents[1]
    stats_dir = project_root / "data" / "stats"
    build_rookie_prop_projections(
        lines_path=stats_dir / "rookie_betting_lines_2026.csv",
        stats_path=stats_dir / "nflverse_player_stats_2025.csv",
        output_path=stats_dir / "2026 Rookie Prediction Stats - Sheet1.csv",
    )
