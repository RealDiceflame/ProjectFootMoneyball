
"""
fantasy_points.py - Calculates Fantasy Points Across PPR Scoring Formats

Supports:
- Standard scoring (0 PPR)
- Half-PPR
- Full-PPR

Applies passing, rushing, receiving, and turnover formulas.
"""

import os
import re
import pandas as pd


def calculate_fantasy_points(df: pd.DataFrame, ppr_type: str = "full") -> pd.DataFrame:

    """
    Calculates fantasy points for a given PPR format.

    Args:
        df (pd.DataFrame): DataFrame with player stats.
        ppr_type (str): One of ['standard', 'half', 'full'].

    Returns:
        pd.DataFrame: Updated DataFrame with a 'fantasy_points' column.
    """
    df = df.copy()

    # Determine PPR multiplier
    ppr_map = {"standard": 0.0, "half": 0.5, "full": 1.0}
    ppr_value = ppr_map.get(ppr_type.lower(), 1.0)

    # Robustly map multiple possible incoming column names into canonical names we use
    def _norm(s: str) -> str:
        return re.sub(r'[^a-z0-9_]', '', s.lower().replace(' ', '_'))

    available = { _norm(c): c for c in df.columns }

    # candidate names for each canonical stat
    candidates = {
        'pass_yds': ['passing_yds', 'pass_yds', 'passing_yds', 'passing_yards', 'yds', 'pass_yds'],
        'pass_td': ['passing_td', 'pass_td', 'td', 'passing_tds'],
        'int': ['passing_int', 'int', 'interceptions'],
        'rush_yds': ['rushing_yds', 'rush_yds', 'rush_yards', 'rush_yds'],
        'rush_td': ['rushing_td', 'rush_td', 'rush_tds'],
        'rec': ['receiving_rec', 'rec', 'recs', 'receptions', 'targets'],
        'rec_yds': ['receiving_yds', 'rec_yds', 'rec_yards', 'receiving_yards'],
        'rec_td': ['receiving_td', 'rec_td', 'rec_tds'],
        'fmb': ['fmb', 'fumbles']
    }

    # pick first available column for each canonical stat; default to zero series
    for canon, prefs in candidates.items():
        found = None
        for p in prefs:
            key = _norm(p)
            if key in available:
                found = available[key]
                break
        if found is not None:
            df[canon] = pd.to_numeric(df[found], errors='coerce').fillna(0)
        else:
            df[canon] = 0

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
        df["fmb"] * -2
    )
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
        # compute per-game and 17-game projection for this scoring format
        games = pd.to_numeric(df['g'], errors='coerce') if 'g' in df.columns else pd.Series([17] * len(df))
        games_safe = games.where(games > 0)
        per_game = df[f"fantasy_{ppr_type.lower()}_ppr"] / games_safe
        per_game = per_game.fillna(df[f"fantasy_{ppr_type.lower()}_ppr"] / 17)
        df[f"fantasy_{ppr_type.lower()}_ppr_per_game"] = per_game
        df[f"fantasy_{ppr_type.lower()}_ppr_proj_17g"] = (per_game * 17)
    df = df.round(2)
    df.to_csv(output_path, index=False, na_rep='-')
    print(f"[OK] All fantasy formats saved to {output_path}")