
"""
fantasy_points.py - Calculates Fantasy Points Across PPR Scoring Formats

Supports:
- Standard scoring (0 PPR)
- Half-PPR
- Full-PPR

Applies passing, rushing, receiving, and turnover formulas.
"""

import re
import math
import pandas as pd


def calculate_fantasy_points(df: pd.DataFrame, ppr_type: str = "full", *, allow_legacy: bool = True) -> pd.DataFrame:

    """
    Calculates fantasy points for a given PPR format.

    Args:
        df (pd.DataFrame): DataFrame with player stats.
        ppr_type (str): One of ['standard', 'half', 'full'].
        allow_legacy (bool): Keep a disclosed partial subtotal when optional
            lost-fumble/conversion/return-touchdown evidence is unavailable.
            False requires all optional scoring fields to be known.

    Returns:
        pd.DataFrame: Updated DataFrame with 'fantasy_points' and
            'scoring_coverage' (full, core_only, or unavailable). Supplied
            unknown core statistics make the total unavailable.
    """
    df = df.copy()

    # Determine PPR multiplier
    ppr_map = {"standard": 0.0, "half": 0.5, "full": 1.0}
    scoring_format = ppr_type.strip().lower()
    if scoring_format not in ppr_map:
        raise ValueError(f"Unknown PPR format: {ppr_type!r}; expected standard, half, or full")
    ppr_value = ppr_map[scoring_format]

    # Robustly map multiple possible incoming column names into canonical names we use
    def _norm(s: str) -> str:
        return re.sub(r'[^a-z0-9_]', '', s.lower().replace(' ', '_'))

    available = { _norm(c): c for c in df.columns }

    # candidate names for each canonical stat
    candidates = {
        'pass_yds': ['passing_yds', 'pass_yds', 'passing_yds', 'passing_yards', 'yds', 'pass_yds'],
        'pass_td': ['passing_td', 'pass_td', 'td', 'passing_tds'],
        'int': ['passing_int', 'passing_interceptions', 'int', 'interceptions'],
        'rush_yds': ['rushing_yds', 'rushing_yards', 'rush_yds', 'rush_yards'],
        'rush_td': ['rushing_td', 'rushing_tds', 'rush_td', 'rush_tds'],
        'rec': ['receiving_rec', 'rec', 'recs', 'receptions'],
        'rec_yds': ['receiving_yds', 'rec_yds', 'rec_yards', 'receiving_yards'],
        'rec_td': ['receiving_td', 'receiving_tds', 'rec_td', 'rec_tds'],
        'fumbles_lost': ['fumbles_lost_total', 'fumbles_lost', 'lost_fumbles', 'fl']
    }

    # Targets are opportunities, not completed receptions: never award PPR for them.
    # Absent categories permit sparse legacy inputs; supplied unknown core values
    # propagate to an unavailable total. Coverage flags distinguish partial scores.
    # Total fumbles (fmb/fumbles) do not establish a turnover. Only explicit lost
    # fields incur the penalty; absent fields retain the sparse-input zero fallback.
    # Pick the first available alias without adding overlapping representations.
    supplied = set()
    for canon, prefs in candidates.items():
        found = None
        for p in prefs:
            key = _norm(p)
            if key in available:
                found = available[key]
                break
        if found is not None:
            supplied.add(canon)
            df[canon] = pd.to_numeric(df[found], errors='coerce')
            valid = df[canon].map(math.isfinite) & ~df[found].map(lambda value: isinstance(value, bool))
            if canon not in {"pass_yds", "rush_yds", "rec_yds"}:
                valid &= df[canon].ge(0)
            df[canon] = df[canon].where(valid)
        else:
            df[canon] = float("nan") if canon == "fumbles_lost" else 0

    # Apply scoring formula
    df["fantasy_points"] = (
        df["pass_yds"] * 0.04 +
        df["pass_td"] * 4 +
        df["int"] * -2 +
        df["rush_yds"] * 0.1 +
        df["rush_td"] * 6 +
        df["rec"] * ppr_value +
        df["rec_yds"] * 0.1 +
        df["rec_td"] * 6 +
        df["fumbles_lost"].fillna(0) * -2
    )
    # Sparse historical/rookie inputs cannot establish full scoring coverage.
    extras = ['passing_2pt_conversions', 'rushing_2pt_conversions',
              'receiving_2pt_conversions', 'special_teams_tds']
    complete = df['fumbles_lost'].notna()
    bonus = pd.Series(0.0, index=df.index)
    for column in extras:
        if column not in df.columns:
            complete &= False
            continue
        values = pd.to_numeric(df[column], errors='coerce')
        known = (values.notna() & values.map(math.isfinite) & values.ge(0)
                 & ~df[column].map(lambda value: isinstance(value, bool)))
        complete &= known
        bonus += values.where(known, 0) * (6 if column == 'special_teams_tds' else 2)
    df['fantasy_points'] += bonus
    if not allow_legacy:
        df.loc[~complete, 'fantasy_points'] = float('nan')
    full_coverage = complete & (set(candidates) <= supplied)
    df['scoring_coverage'] = full_coverage.map({True: 'full', False: 'core_only'})
    df.loc[df['fantasy_points'].isna(), 'scoring_coverage'] = 'unavailable'
    return df


def calculate_and_save_fantasy_points(input_path, output_path):

    """
    Loads stats from CSV and calculates fantasy points for all PPR types.

    Args:
        input_path (str): Path to the base stats CSV.
        output_path (str): Path to save the scored stats.
    """
    print(f"[INFO] Loading stats from {input_path} and calculating all scoring formats...")
    df = pd.read_csv(input_path)
    for ppr_type in ["standard", "half", "full"]:
        scored_df = calculate_fantasy_points(df.copy(), ppr_type)
        df[f"fantasy_{ppr_type.lower()}_ppr"] = scored_df["fantasy_points"]
        df['scoring_coverage'] = scored_df['scoring_coverage']
        # compute per-game and 17-game projection for this scoring format
        games = pd.to_numeric(df['g'], errors='coerce') if 'g' in df.columns else pd.Series(float('nan'), index=df.index)
        games_safe = games.where((games > 0) & games.map(math.isfinite))
        per_game = df[f"fantasy_{ppr_type.lower()}_ppr"] / games_safe
        df[f"fantasy_{ppr_type.lower()}_ppr_per_game"] = per_game
        df[f"fantasy_{ppr_type.lower()}_ppr_proj_17g"] = (per_game * 17)
    df = df.round(2)
    df.to_csv(output_path, index=False, na_rep='-')
    print(f"[OK] All fantasy formats saved to {output_path}")
