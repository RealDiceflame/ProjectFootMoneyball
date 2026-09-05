"""Create overall draft boards for common league formats.

Rankings use projected points above a position-specific replacement player
(VORP).  That lets a 2QB board reflect quarterback scarcity and lets a TE
premium board compare tight ends fairly with other positions.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd


SKILL_POSITIONS = ("QB", "RB", "WR", "TE")


def _numeric(df: pd.DataFrame, column: str) -> pd.Series:
    if column not in df.columns:
        return pd.Series(0.0, index=df.index)
    return pd.to_numeric(df[column], errors="coerce").fillna(0.0)


def calculate_projected_points(
    df: pd.DataFrame,
    base_ppr: float = 0.5,
    te_premium: float = 0.0,
) -> pd.Series:
    """Calculate a 17-game projection with an optional TE reception bonus."""
    positions = df["pos"].astype(str).str.upper()
    reception_value = pd.Series(base_ppr, index=df.index, dtype=float)
    reception_value.loc[positions == "TE"] += te_premium

    season_points = (
        _numeric(df, "passing_yds") * 0.04
        + _numeric(df, "passing_td") * 4
        - _numeric(df, "passing_int") * 2
        + _numeric(df, "rushing_yds") * 0.1
        + _numeric(df, "rushing_td") * 6
        + _numeric(df, "receiving_rec") * reception_value
        + _numeric(df, "receiving_yds") * 0.1
        + _numeric(df, "receiving_td") * 6
        - _numeric(df, "fmb") * 2
    )

    games = _numeric(df, "g").where(lambda values: values > 0, 17.0)
    return season_points / games * 17


def _replacement_ranks(teams: int, qb_starters: int) -> dict[str, int]:
    """Return starter counts for a 2RB/3WR/1TE/1FLEX league."""
    return {
        "QB": teams * qb_starters,
        # Split the 12 flex starters evenly between RB and WR.
        "RB": round(teams * 2.5),
        "WR": round(teams * 3.5),
        "TE": teams,
    }


def calculate_market_expected_points(ranking: pd.DataFrame) -> pd.Series:
    """Fit a position-specific points-vs-ADP line and return its expectation."""
    expected = pd.Series(float("nan"), index=ranking.index, dtype=float)
    for _position, group in ranking.groupby("pos"):
        adp = pd.to_numeric(group["adp"], errors="coerce")
        points = pd.to_numeric(group["projected_points"], errors="coerce")
        valid = adp.notna() & points.notna()
        if valid.sum() < 2:
            continue
        x = adp[valid]
        y = points[valid]
        denominator = ((x - x.mean()) ** 2).sum()
        slope = 0.0 if denominator == 0 else (((x - x.mean()) * (y - y.mean())).sum() / denominator)
        intercept = y.mean() - slope * x.mean()
        expected.loc[group.index] = adp * slope + intercept
    return expected


def build_draft_ranking(
    df: pd.DataFrame,
    *,
    format_name: str,
    teams: int = 12,
    qb_starters: int = 1,
    base_ppr: float = 0.5,
    te_premium: float = 0.0,
) -> pd.DataFrame:
    """Build one overall VORP-based draft ranking."""
    ranking = df.copy()
    if "pos" not in ranking.columns and "Position" in ranking.columns:
        ranking["pos"] = ranking["Position"]
    if "player" not in ranking.columns and "Player" in ranking.columns:
        ranking["player"] = ranking["Player"]
    if "team" not in ranking.columns and "Team" in ranking.columns:
        ranking["team"] = ranking["Team"]

    ranking["pos"] = ranking["pos"].astype(str).str.upper()
    ranking = ranking[ranking["pos"].isin(SKILL_POSITIONS)].copy()
    if "Player" in ranking.columns:
        display_names = ranking["Player"].astype(str).str.strip()
        ranking["player"] = display_names.where(display_names.ne(""), ranking["player"])
    ranking["projected_points"] = calculate_projected_points(
        ranking,
        base_ppr=base_ppr,
        te_premium=te_premium,
    )
    ranking["adp"] = pd.to_numeric(ranking.get("ADP"), errors="coerce")
    ranking["source_count"] = pd.to_numeric(ranking.get("Source_Count"), errors="coerce")
    ranking["adp_spread"] = pd.to_numeric(ranking.get("ADP_Spread"), errors="coerce")
    ranking["market_expected_points"] = calculate_market_expected_points(ranking)
    ranking["market_value"] = ranking["projected_points"] - ranking["market_expected_points"]

    starter_counts = _replacement_ranks(teams, qb_starters)
    replacement_points: dict[str, float] = {}
    for pos, starter_count in starter_counts.items():
        pos_scores = (
            ranking.loc[ranking["pos"] == pos, "projected_points"]
            .sort_values(ascending=False)
            .reset_index(drop=True)
        )
        if pos_scores.empty:
            replacement_points[pos] = 0.0
        else:
            # Zero-based index equal to the number of starters selects the
            # first non-starter: QB25 in a 12-team two-QB league.
            replacement_index = min(starter_count, len(pos_scores) - 1)
            replacement_points[pos] = float(pos_scores.iloc[replacement_index])

    replacement_ranks = {pos: count + 1 for pos, count in starter_counts.items()}
    ranking["replacement_rank"] = ranking["pos"].map(replacement_ranks)
    ranking["replacement_points"] = ranking["pos"].map(replacement_points)
    ranking["vorp"] = ranking["projected_points"] - ranking["replacement_points"]

    ranking["position_rank"] = (
        ranking.groupby("pos")["projected_points"]
        .rank(method="first", ascending=False)
        .astype(int)
    )
    ranking["position_rank"] = (
        ranking["pos"] + ranking["position_rank"].astype(str)
    )

    ranking = ranking.sort_values(
        ["vorp", "projected_points", "ADP"],
        ascending=[False, False, True],
        na_position="last",
    ).reset_index(drop=True)
    ranking.insert(0, "overall_rank", ranking.index + 1)
    ranking["value_vs_adp"] = ranking["adp"] - ranking["overall_rank"]
    ranking["format"] = format_name

    output_columns = [
        "overall_rank",
        "player",
        "player_id",
        "is_rookie",
        "team",
        "pos",
        "position_rank",
        "projected_points",
        "replacement_points",
        "vorp",
        "market_expected_points",
        "market_value",
        "adp",
        "source_count",
        "adp_spread",
        "value_vs_adp",
        "Yahoo",
        "Sleeper",
        "NFL",
        "FFC",
        "MFL",
        "format",
    ]
    for column in output_columns:
        if column not in ranking.columns:
            ranking[column] = pd.NA
    ranking = ranking[output_columns]
    numeric_columns = [
        "projected_points",
        "replacement_points",
        "vorp",
        "market_expected_points",
        "market_value",
        "adp",
        "source_count",
        "adp_spread",
        "value_vs_adp",
    ]
    ranking[numeric_columns] = ranking[numeric_columns].round(2)
    return ranking


def save_default_draft_rankings(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    teams: int = 12,
    team_sizes: tuple[int, ...] = (8, 10, 12, 14, 16),
    te_premium: float = 0.5,
) -> dict[str, Path]:
    """Save common team-size, QB, PPR, and TE-premium draft boards."""
    df = pd.read_csv(input_path, low_memory=False)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    ppr_modes = (
        ("standard", "standard", 0.0),
        ("half_ppr", "half-PPR", 0.5),
        ("full_ppr", "full-PPR", 1.0),
    )
    formats: dict[str, dict[str, float | int | str]] = {}
    legacy_slugs: dict[str, str] = {}
    for team_count in dict.fromkeys(team_sizes):
        for ppr_slug, ppr_label, base_ppr in ppr_modes:
            for qb_starters in (1, 2):
                base_slug = f"{qb_starters}qb_{ppr_slug}"
                slug = f"{team_count}team_{base_slug}"
                formats[slug] = {
                    "format_name": (
                        f"{team_count}-team {qb_starters}QB {ppr_label}"
                    ),
                    "teams": team_count,
                    "qb_starters": qb_starters,
                    "base_ppr": base_ppr,
                    "te_premium": 0.0,
                }
                if team_count == teams:
                    legacy_slugs[slug] = base_slug

                if ppr_slug == "half_ppr" and qb_starters == 1:
                    premium_base_slug = "te_premium_half_ppr"
                elif ppr_slug == "half_ppr":
                    premium_base_slug = "2qb_te_premium_half_ppr"
                else:
                    premium_base_slug = (
                        f"{qb_starters}qb_te_premium_{ppr_slug}"
                    )
                premium_slug = f"{team_count}team_{premium_base_slug}"
                formats[premium_slug] = {
                    "format_name": (
                        f"{team_count}-team {qb_starters}QB {ppr_label}"
                        f" + {te_premium:g} TE premium"
                    ),
                    "teams": team_count,
                    "qb_starters": qb_starters,
                    "base_ppr": base_ppr,
                    "te_premium": te_premium,
                }
                if team_count == teams:
                    legacy_slugs[premium_slug] = premium_base_slug

    paths: dict[str, Path] = {}
    for slug, settings in formats.items():
        result = build_draft_ranking(
            df,
            **settings,
        )
        output_path = output_dir / f"draft_rankings_{slug}.csv"
        result.to_csv(output_path, index=False)
        paths[slug] = output_path
        if slug in legacy_slugs:
            legacy_slug = legacy_slugs[slug]
            legacy_path = output_dir / f"draft_rankings_{legacy_slug}.csv"
            result.to_csv(legacy_path, index=False)
            paths[legacy_slug] = legacy_path
        print(f"[OK] Saved {settings['format_name']} rankings to {output_path}")

    return paths
