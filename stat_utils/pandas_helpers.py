
"""
pandas_helpers.py – Generic, reusable pandas DataFrame utilities
"""

import pandas as pd
import re

def alias_bfill(df, target_field, possible_columns):
    matching_cols = [col for col in df.columns if col.strip().lower() in [c.lower() for c in possible_columns]]
    if matching_cols:
        # Backfill across matching alias columns and assign to the canonical target field
        df[target_field] = df[matching_cols].bfill(axis=1).iloc[:, 0]
        # Drop only the alias columns that are different from the target_field to avoid
        # accidentally dropping the canonical column we just created/assigned.
        cols_to_drop = [col for col in matching_cols if col != target_field]
        if cols_to_drop:
            df.drop(columns=cols_to_drop, inplace=True, errors='ignore')
    return df

def drop_columns(df: pd.DataFrame, columns_to_drop: list[str]) -> pd.DataFrame:
    return df.drop(columns=[col for col in columns_to_drop if col in df.columns], errors='ignore')

def reorder_columns(df, preferred_order):
    existing_preferred = [col for col in preferred_order if col in df.columns]
    remaining_cols = [col for col in df.columns if col not in existing_preferred]
    return df[existing_preferred + remaining_cols]

def fill_nulls(df, fill_value=''):
    return df.fillna(fill_value)

def normalize_column_names(df):
    df.columns = [col.strip().lower() for col in df.columns]
    return df

def flatten_multiindex(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [' '.join(str(level).strip() for level in col if level) for col in df.columns]
    return df

def drop_columns_from_file(df, filepath="columns_to_drop.txt", keep_patterns=None):
    try:
        with open(filepath, "r") as f:
            patterns = [line.strip().lower() for line in f if line.strip()]
    except FileNotFoundError:
        print(f"[WARN] '{filepath}' not found. No columns dropped.")
        return df

    if not patterns:
        return df

    # Normalize column names to compare
    col_map = {col.lower(): col for col in df.columns}
    to_remove = set()

    keep_patterns = keep_patterns or []
    # normalize keep patterns and ensure we always keep passing-, rushing-, and receiving-prefixed columns
    default_keep = ["passing", "rushing", "receiving"]
    combined_keep = list(keep_patterns) + default_keep
    keep_norms = [re.sub(r"[^a-z0-9 ]", "", kp.lower()) for kp in combined_keep]

    # Treat each pattern as either exact or substring (allow flexible matching)
    for pat in patterns:
        pat_norm = re.sub(r"[^a-z0-9 ]", "", pat)
        # exact or substring match
        for lc, orig in col_map.items():
            lc_norm = re.sub(r"[^a-z0-9 ]", "", lc)
            # skip columns that match any keep pattern
            if any(k in lc_norm or lc_norm in k for k in keep_norms):
                continue
            if lc_norm == pat_norm or pat_norm in lc_norm or lc_norm in pat_norm:
                to_remove.add(orig)

    if to_remove:
        print(f"[INFO] Dropping columns from {filepath}: {sorted(to_remove)}")
        df = df.drop(columns=list(to_remove), errors='ignore')
    else:
        print(f"[INFO] No matching columns found to drop from {filepath}")

    return df
