"""
stat_helpers.py – Utilities for Fetching, Cleaning, and Merging Stat Data
"""
"""
stat_helpers.py – Utilities for Fetching, Cleaning, and Merging Stat Data
"""

import logging
import pandas as pd
import re
from functools import reduce

from data_fetcher.data_fetcher import DataFetcher
from stat_utils.pandas_helpers import (
    alias_bfill, drop_columns, reorder_columns, fill_nulls,
    normalize_column_names, drop_columns_from_file
)


def fetch_stat_category(label, url, output_path):
    """
    Downloads and returns a stats DataFrame for a given category (passing, rushing, etc.)
    """
    try:
        print(f"\nFetching {label} stats...")
        fetcher = DataFetcher(url=url, save_path=output_path)
        fetcher.fetch_data()
        df = fetcher.get_data()
        print(df.head())
        return df
    except Exception as e:
        logging.error(f"Error while fetching {label} stats: {e}")
        return None


def clean_and_prepare(df, source_name):
    """
    Cleans column names, flattens multi-index, and normalizes player names.
    """
    df = df.copy()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [' '.join(col).strip() for col in df.columns.values]

    # remove obvious header artifacts
    df.columns = [
        re.sub(r"(?:unnamed: \d+|_?level_\d+|\d+_level_\d+)", "", str(col).strip(), flags=re.IGNORECASE).strip()
        for col in df.columns
    ]

    print(f"\n[INFO] {source_name} columns after flattening:")
    print(df.columns)

    # Identify player column (try several fallbacks)
    player_col = next((col for col in df.columns if "player" in str(col).lower()), None)
    if player_col is None and df.shape[0] > 0:
        # Try using first row as header if data was exported with header row as values
        print(f"[WARN] {source_name}: 'Player' column not found — trying to use row 0 as header...")
        df.columns = df.iloc[0]
        df = df.drop(df.index[0]).reset_index(drop=True)
        player_col = next((col for col in df.columns if str(col).strip().lower() == "player"), None)

    if not player_col:
        raise ValueError(f"{source_name} DataFrame does not contain a recognizable 'Player' column.")

    # Create a normalized 'player' column while preserving originals
    df["player"] = (
        df[player_col]
        .astype(str)
        .str.replace(r"[*+]", "", regex=True)
        .str.replace(".", "", regex=False)
        .str.strip()
        .str.lower()
    )

    # Ensure pos exists (try common variants)
    pos_col = next((col for col in df.columns if str(col).strip().lower() == 'pos' or 'pos' in str(col).lower()), None)
    if pos_col and pos_col != 'pos':
        df.rename(columns={pos_col: 'pos'}, inplace=True)

    return df


def merge_stats(dfs_with_labels):
    """
    Merges multiple stat DataFrames into one using player names as the key.
    """
    cleaned_dfs = [clean_and_prepare(df, label) for df, label in dfs_with_labels]
    merged_df = reduce(lambda left, right: pd.merge(left, right, on="player", how="outer"), cleaned_dfs)

    print("Final columns after cleaning in merged dataset:")
    for col in merged_df.columns:
        print(f" - {col}")

    return merged_df


def unify_columns(df, columns_to_unify):
    """
    Collapses variants of a column (e.g., Age, Age_x, Age_y) into one.
    """
    for base_col in columns_to_unify:
        matching_cols = [col for col in df.columns if str(col).startswith(base_col)]
        if len(matching_cols) > 1:
            print(f"[INFO] Unifying columns: {matching_cols}")
            df[base_col] = df[matching_cols].bfill(axis=1).infer_objects(copy=False).iloc[:, 0]
            df.drop(columns=[col for col in matching_cols if col != base_col], inplace=True)
    return df


def preprocess_stat_df(df):
    """
    Flattens multi-index and normalizes column names.
    """
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [' '.join(col).strip() for col in df.columns.values]
    return normalize_column_names(df)


def apply_aliases(df):
    """
    Maps common field name variants to standard names using backfill logic.
    """
    alias_map = {
        'age': ['Age'],
        'team': ['Team'],
        'pos': ['Pos'],
        'g': ['G'],
        'gs': ['GS'],
        'fmb': ['Fmb', 'fmb'],
        'awards': ['Awards'],
    }
    for standard_col, aliases in alias_map.items():
        df = alias_bfill(df, standard_col, aliases)
    return df


def drop_known_extras(df):
    """
    Drops unnecessary or duplicated columns known to clutter merged data.
    """
    return drop_columns(df, ['yds.1', 'awards', 'qbrec'])


def reorder_core_columns(df):
    """
    Ensures important identifying columns appear first.
    """
    return reorder_columns(df, ['player', 'pos', 'team', 'age', 'g', 'gs'])


def clean_all(df):
    """
    Applies full cleaning pipeline to a merged stat DataFrame.
    """
    df = normalize_column_names(df)
    df = apply_aliases(df)
    df = drop_known_extras(df)
    df = auto_unify_columns(df)
    df = unify_specific_columns(df, ["g", "gs"])
    df = drop_columns_from_file(df)
    df = reorder_core_columns(df)
    df = fill_nulls(df)

    print("\n\nFinal columns after cleanup and consolidation:")
    for col in df.columns:
        print(f" - {col}")
    return df


def auto_unify_columns(df):
    """
    Automatically unifies columns with _x/_y suffixes, excluding identity columns.
    """
    suffixes = ["_x", "_y"]
    identity_cols = {"age", "team", "pos"}
    base_candidates = set()

    for col in df.columns:
        for suffix in suffixes:
            if str(col).endswith(suffix):
                base = str(col).rsplit(suffix, 1)[0]
                if base not in {"g", "gs"} and base not in identity_cols:
                    base_candidates.add(base)

    if base_candidates:
        print(f"\n[INFO] Auto-unifying columns: {sorted(base_candidates)}")
        for base_col in sorted(base_candidates):
            matches = [c for c in df.columns if c == base_col or str(c).startswith(base_col + "_")]
            df[base_col] = df[matches].bfill(axis=1).infer_objects(copy=False).iloc[:, 0]
            for col in matches:
                if col != base_col:
                    df.drop(columns=col, inplace=True, errors="ignore")
    else:
        print("\n[INFO] No _x/_y columns to unify.")

    return df


def unify_player_column(df):
    """
    Ensures only one consistent 'player' column exists and is normalized.
    """
    player_cols = sorted({col for col in df.columns if "player" in str(col).lower()}, key=str.lower)

    if not player_cols:
        print("[WARN] No player-like columns found.")
        return df

    for col in player_cols:
        if col != "player":
            df.rename(columns={col: "player"}, inplace=True)

    if df.columns.duplicated().any() or player_cols.count("player") > 1:
        print(f"[INFO] Unifying duplicated 'player' columns...")
        df["player"] = df.filter(regex="(?i)player").bfill(axis=1).iloc[:, 0]
        df = df.loc[:, ~df.columns.duplicated()]

    df["player"] = df["player"].astype(str).str.strip().str.lower()
    cols = df.columns.tolist()
    cols.insert(0, cols.pop(cols.index("player")))
    return df[cols]


def unify_specific_columns(df, target_columns):
    """
    Manually unifies a list of target columns (e.g., g, gs) across merged datasets.
    """
    for base_col in target_columns:
        matches = [col for col in df.columns if col == base_col or str(col).startswith(f"{base_col}_")]
        if len(matches) > 1:
            print(f"[INFO] Unifying manually: {matches}")
            df[base_col] = df[matches].bfill(axis=1).infer_objects(copy=False).iloc[:, 0]
            df.drop(columns=[col for col in matches if col != base_col], inplace=True)
    return df


def fill_identity_columns(df, identity_cols=["age", "team", "pos"]):
    """
    For each identity column, fills missing values by using the most common value per player.
    """
    for col in identity_cols:
        matches = [c for c in df.columns if str(c).lower().startswith(col.lower())]
        if not matches:
            continue

        print(f"[INFO] Filling identity column: {col} from {matches}")

        temp = df[matches].bfill(axis=1).iloc[:, 0]
        mode_series = df.assign(temp=temp).groupby("player")["temp"].agg(
            lambda x: x.dropna().mode().iloc[0] if not x.dropna().empty else None
        )

        df[col] = df["player"].map(mode_series)
        for c in matches:
            if c != col:
                df.drop(columns=c, inplace=True, errors="ignore")

    return df
