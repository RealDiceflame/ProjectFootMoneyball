
"""
pandas_helpers.py – Generic, reusable pandas DataFrame utilities
"""

import pandas as pd
import re
import logging

logger = logging.getLogger(__name__)


def log_column_changes(before, df, stage, **context):
    """Record ordered schemas (including duplicates) only when debugging."""
    if logger.isEnabledFor(logging.DEBUG):
        after = list(df.columns)
        logger.debug("Column transformation: %s", stage, extra={
            "event": "column_changes", "stage": stage,
            "columns_before": before, "columns_after": after, **context})


def warn_missing_columns(df, required, stage):
    missing = [col for col in required if col not in df.columns]
    if missing:
        logger.warning("Missing required fields in %s: %s", stage, missing, extra={
            "event": "missing_required_fields", "stage": stage, "missing_fields": missing})


def alias_bfill(df, target_field, possible_columns):
    before = list(df.columns)
    matching_cols = [col for col in df.columns if col.strip().lower() in [c.lower() for c in possible_columns]]
    if matching_cols:
        # Backfill across matching alias columns and assign to the canonical target field
        df[target_field] = df[matching_cols].bfill(axis=1).iloc[:, 0]
        # Drop only the alias columns that are different from the target_field to avoid
        # accidentally dropping the canonical column we just created/assigned.
        cols_to_drop = [col for col in matching_cols if col != target_field]
        if cols_to_drop:
            df.drop(columns=cols_to_drop, inplace=True, errors='ignore')
    if matching_cols:
        logger.debug("Consolidating aliases for %s", target_field, extra={
            "event": "alias_consolidation", "target": target_field, "aliases": matching_cols})
    log_column_changes(before, df, "alias_bfill")
    return df

def drop_columns(df: pd.DataFrame, columns_to_drop: list[str]) -> pd.DataFrame:
    result = df.drop(columns=[col for col in columns_to_drop if col in df.columns], errors='ignore')
    log_column_changes(list(df.columns), result, 'drop_columns')
    return result

def reorder_columns(df, preferred_order):
    existing_preferred = [col for col in preferred_order if col in df.columns]
    remaining_cols = [col for col in df.columns if col not in existing_preferred]
    return df[existing_preferred + remaining_cols]

def fill_nulls(df, fill_value=''):
    return df.fillna(fill_value)

def normalize_column_names(df):
    before = list(df.columns)
    df.columns = [col.strip().lower() for col in df.columns]
    log_column_changes(before, df, "normalize_column_names")
    return df

def flatten_multiindex(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [' '.join(str(level).strip() for level in col if level) for col in df.columns]
    return df

def drop_columns_from_file(df, filepath="columns_to_drop.txt", keep_patterns=None):
    try:
        with open(filepath, "r") as f:
            patterns = [line.strip().lower() for line in f if line.strip()]
    except FileNotFoundError:
        logger.warning("Column removal source file missing: %s", filepath, extra={"event": "missing_source_file", "source_path": str(filepath)})
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
        logger.debug("Dropping configured columns", extra={"event": "columns_dropped", "source_path": str(filepath), "dropped_columns": sorted(to_remove)})
        df = drop_columns(df, list(to_remove))
    else:
        logger.debug("No configured columns to drop", extra={"event": "columns_dropped", "source_path": str(filepath), "dropped_columns": []})

    return df
