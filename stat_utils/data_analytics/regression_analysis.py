
"""
regression_analysis.py – Evaluates Player Value vs. ADP Using Linear Regression

Reads fantasy stats and ADP, normalizes projections to a 17-game season,
trains linear regression models per position, and calculates expected value vs. actual.
"""


import os
import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression


def calculate_fantasy_value_vs_adp(input_csv_path, output_csv_path):

    """Perform per-position linear regressions of fantasy points vs ADP for
    three scoring modes (standard, half, full) using 17-game projections.

    This writes a combined CSV at `output_csv_path` and individual CSVs
    with suffixes `_standard`, `_half`, and `_full`.

    Args:
        input_csv_path (str): Path to input CSV with fantasy points and ADP.
        output_csv_path (str): Path to save the combined output CSV.
    """

    df = pd.read_csv(input_csv_path)

    # Find the position column (pos or position)
    pos_col = None
    for c in df.columns:
        if c.lower() in ('pos', 'position'):
            pos_col = c
            break
    if pos_col is None:
        raise ValueError("No 'pos' or 'position' column found in input data.")

    # Find ADP column
    adp_col = None
    for c in df.columns:
        if c.strip().lower() == 'adp':
            adp_col = c
            break
    if adp_col is None:
        raise ValueError("No 'ADP' column found in input data.")

    # Games column
    games_col = 'g' if 'g' in df.columns else ('games' if 'games' in df.columns else None)
    if not games_col:
        raise ValueError("No 'g' or 'games' column found for games played.")

    # Scoring types to evaluate
    scoring = [
        ('fantasy_standard_ppr', 'standard'),
        ('fantasy_half_ppr', 'half'),
        ('fantasy_full_ppr', 'full'),
    ]

    combined_results = []

    # Ensure ADP numeric
    df[adp_col] = pd.to_numeric(df[adp_col], errors='coerce')

    for base_col, label in scoring:
        if base_col not in df.columns:
            raise ValueError(f"Required column '{base_col}' not found in input data.")

        per_game_col = f"{base_col}_per_game"
        proj_col = f"{base_col}_proj_17g"

        # Compute per-game and 17-game projections (safe division)
        df[per_game_col] = pd.to_numeric(df[base_col], errors='coerce') / pd.to_numeric(df[games_col], errors='coerce')
        df[proj_col] = df[per_game_col] * 17

        results_for_type = []

        # Iterate positions and fit model if there are enough samples
        for position in df[pos_col].dropna().unique():
            df_pos = df[df[pos_col] == position].copy()
            # Drop rows without ADP or projected points
            df_pos = df_pos.dropna(subset=[adp_col, proj_col])
            if len(df_pos) < 2:
                # Not enough data to fit a model
                continue

            X = df_pos[[adp_col]].astype(float).values
            y = df_pos[proj_col].astype(float).values

            model = LinearRegression()
            model.fit(X, y)

            df_pos['expected_points'] = model.predict(X)
            df_pos['value_diff'] = df_pos[proj_col] - df_pos['expected_points']
            df_pos['value_type'] = np.where(df_pos['value_diff'] > 0, 'undervalued', 'overvalued')
            df_pos['scoring_type'] = label
            df_pos['regression_coef'] = float(model.coef_[0])
            df_pos['regression_intercept'] = float(model.intercept_)
            # R^2 for the fit
            try:
                r2 = model.score(X, y)
            except Exception:
                r2 = np.nan
            df_pos['regression_r2'] = r2

            results_for_type.append(df_pos)

        if results_for_type:
            results_df = pd.concat(results_for_type)
            # Write per-scoring-type CSV next to the requested output
            base, ext = os.path.splitext(output_csv_path)
            per_out = f"{base}_{label}{ext}"
            results_df.to_csv(per_out, index=False, na_rep='-')
            combined_results.append(results_df)

    if combined_results:
        all_df = pd.concat(combined_results)
        # Write combined CSV
        all_df.to_csv(output_csv_path, index=False, na_rep='-')
    else:
        raise ValueError("No regression results generated. Check input data for sufficient ADP and projection values.")
