"""
project_dataframe_utils.py - cleaned utilities (ASCII-safe) for ProjectFootMoneyball
"""

import os
import re
from pathlib import Path
import pandas as pd
from functools import reduce
import stat_utils.pandas_helpers as pdh

# Canonical player alias map: map alternate display names to canonical pipeline name
# Keep keys normalized (lowercase, stripped) and values canonical lowercase form used across outputs
PLAYER_ALIAS_MAP = {
    'marquise brown': 'hollywood brown',
    'marquise b': 'hollywood brown',
    'marquisebrown': 'hollywood brown'
}

# --- Utility Functions ---

def fetch_and_normalize_stat_tables(stat_urls):
    """Fetch, flatten, normalize, and collect stat tables for all categories in stat_urls.

    Returns a list of (df, category) tuples.
    """
    tables = []
    for category, url in stat_urls.items():
        season_match = re.search(r"/years/(\d{4})/", url)
        season = season_match.group(1) if season_match else "latest"
        csv_path = os.path.join("data", "stats", f"{category.lower()}_{season}.csv")
        df = fetch_stat_category(category, url, csv_path)
        if df is None:
            # Skip categories we couldn't fetch
            continue
        # If the table has a MultiIndex header, flatten it first
        if hasattr(df.columns, 'nlevels') and getattr(df.columns, 'nlevels', 1) > 1:
            df = pdh.flatten_multiindex(df)
        # Normalize column names and player values
        df = normalize_stat_dataframe(df)
        df = clean_and_prepare(df, category)
        tables.append((df, category))
    return tables


def load_nflverse_stat_tables(csv_path):
    """Convert nflverse season totals into this project's three stat tables."""
    source = pd.read_csv(csv_path)
    if "season_type" in source.columns:
        source = source[source["season_type"].eq("REG")].copy()

    player = source["player_display_name"]
    player_id = source["player_id"] if "player_id" in source.columns else pd.Series(pd.NA, index=source.index)
    common = {
        "player": player,
        "player_id": player_id,
        "pos": source["position"],
        "team": source["recent_team"],
        "age": pd.NA,
        "g": source["games"],
        "gs": pd.NA,
        "fmb": source["fumbles_total"],
    }

    passing = pd.DataFrame({
        **common,
        "cmp": source["completions"],
        "att": source["attempts"],
        "yds": source["passing_yards"],
        "td": source["passing_tds"],
        "int": source["passing_interceptions"],
    })
    passing = passing[pd.to_numeric(passing["att"], errors="coerce").fillna(0).gt(0)]

    rushing = pd.DataFrame({
        **common,
        "rushing_att": source["carries"],
        "rushing_yds": source["rushing_yards"],
        "rushing_td": source["rushing_tds"],
    })
    rushing = rushing[pd.to_numeric(rushing["rushing_att"], errors="coerce").fillna(0).gt(0)]

    receiving = pd.DataFrame({
        **common,
        "receiving_tgt": source["targets"],
        "receiving_rec": source["receptions"],
        "receiving_yds": source["receiving_yards"],
        "receiving_td": source["receiving_tds"],
    })
    receiving = receiving[
        pd.to_numeric(receiving["receiving_tgt"], errors="coerce").fillna(0).gt(0)
    ]

    print(f"[OK] Loaded 2025 regular-season stats from nflverse: {csv_path}")
    return [(passing, "Passing"), (rushing, "Rushing"), (receiving, "Receiving")]

def save_and_report_merged_stats(df, output_dir, filename="all_stats_merged.csv"):
    """
    Save merged stats DataFrame to CSV and print summary info.
    """
    # Remove ambiguous base 'att' column if present (we keep passing_att/rushing_att)
    if 'att' in df.columns:
        print("[INFO] Removing ambiguous 'att' column from merged stats before save.")
        try:
            df = df.drop(columns=['att'])
        except Exception:
            pass

    merged_stats_path = os.path.join(output_dir, filename)
    df.to_csv(merged_stats_path, index=False, na_rep='-')
    print(f"[OK] Merged stats saved to: {merged_stats_path}")
    print(f"[INFO] DataFrame shape: {df.shape}")
    print("Columns:")
    for c in df.columns:
        print(f" - {c}")

def normalize_col(col):
    """Normalize column names.

    - lowercase, strip whitespace
    - remove common export artifacts like 'unnamed' and numeric level tags
    - replace spaces with underscores, remove non-alphanumeric except underscore
    - collapse repeated underscores and strip leading/trailing underscores
    """
    s = str(col).strip().lower()
    # remove typical multiindex/unnamed artifacts
    s = re.sub(r'unnamed[:_\s]*\d*', '', s)
    s = re.sub(r'level_\d+', '', s)
    # replace spaces with underscore, keep underscores and alphanumerics
    s = s.replace(' ', '_')
    s = re.sub(r'[^a-z0-9_]', '', s)
    # collapse multiple underscores and trim
    s = re.sub(r'_+', '_', s).strip('_')
    return s

def normalize_player(val):
    """Lowercase, strip, remove non-alphanumeric (except spaces), collapse whitespace."""
    val = str(val).strip().lower()
    val = re.sub(r'[^a-z0-9 ]', '', val)
    val = re.sub(r'\s+', ' ', val)

    # Apply module-level alias map if present
    if val in PLAYER_ALIAS_MAP:
        return PLAYER_ALIAS_MAP[val]
    return val
    
def normalize_stat_dataframe(df):
    """
    Normalize all column names and player names in a stat DataFrame.
    Ensures a single 'player' column, normalized values.
    """
    # Reset index if 'player' is index
    if df.index.name and str(df.index.name).lower() == 'player':
        df = df.reset_index()
    # Normalize all column names
    df.columns = [normalize_col(col) for col in df.columns]
    # Robustly detect and rename the player column (e.g., player, unnamed__player, etc.)
    player_col = next((col for col in df.columns if 'player' in col), None)
    if player_col and player_col != 'player':
        df = df.rename(columns={player_col: 'player'})
    # Remove all columns matching 'player' except the first occurrence
    player_indices = [idx for idx, col in enumerate(df.columns) if col == 'player']
    if len(player_indices) > 1:
        # keep first occurrence of 'player'
        keep_idx = player_indices[0]
        cols = list(df.columns)
        for idx in reversed(player_indices[1:]):
            del cols[idx]
        df = df[cols]
    # Remove any columns that are exact duplicates
    df = df.loc[:, ~pd.Index(df.columns).duplicated()]
    # Normalize all player names
    if 'player' in df.columns:
        df.loc[:, 'player'] = df['player'].apply(normalize_player)
    return df

def clean_adp_dataframe(adp_df):
    """Clean ADP DataFrame: normalize column names, add 'player_clean' for merging."""
    adp_df = pdh.normalize_column_names(adp_df)

    def clean_name(name):
        name = str(name).strip().lower()
        name = re.sub(r'[^\w\s]', '', name)  # Remove punctuation
        return name

    if 'player' in adp_df.columns:
        adp_df['player_clean'] = adp_df['player'].apply(clean_name)
    else:
        guessed_col = next((c for c in adp_df.columns if 'player' in c.lower()), None)
        if guessed_col:
            adp_df['player_clean'] = adp_df[guessed_col].apply(clean_name)
        else:
            # leave as-is; caller should handle missing player column
            adp_df['player_clean'] = None
    return adp_df

def normalize_name(name):
    """Normalize player name for matching: remove punctuation, lowercase, first/last word only."""
    name = str(name).strip()
    name = re.sub(r'[^\w\s]', '', name)
    parts = name.split()
    if len(parts) >= 2:
        # If the last token is a generational suffix (Jr, Sr, II, III, etc.),
        # skip it and use the preceding token as the last name for matching.
        suffixes = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}
        last = parts[-1].lower()
        if last in suffixes:
            # If name is "First Jr" -> return just the first name
            if len(parts) == 2:
                return parts[0].lower()
            # Otherwise use the token before the suffix as last name
            last = parts[-2].lower()
        canon = f"{parts[0].lower()} {last}"
        # Apply alias map: if this normalized name maps to a canonical player alias,
        # return the canonical name instead so ADP merges align with stat names.
        if canon in PLAYER_ALIAS_MAP:
            return PLAYER_ALIAS_MAP[canon]
        return canon
    return name.lower()

def merge_full_adp(stats_path, adp_path, output_path):
    """Merge fantasy stat CSV with ADP CSV on normalized player names."""
    if not os.path.exists(stats_path):
        print(f"[WARN] Stats file not found at {stats_path}. Skipping.")
        return
    if not os.path.exists(adp_path):
        print(f"[WARN] ADP file not found at {adp_path}. Skipping.")
        return

    stats_df = pd.read_csv(stats_path)
    adp_df = pd.read_csv(adp_path)

    stats_df['player'] = stats_df['player'].astype(str)
    stats_df['player_clean'] = stats_df['player'].apply(normalize_name)

    if 'player_clean' not in adp_df.columns:
        guessed_col = next((col for col in adp_df.columns if 'player' in col.lower()), None)
        if guessed_col:
            adp_df['player_clean'] = adp_df[guessed_col].apply(normalize_name)
        else:
            raise KeyError("No suitable 'player' column found in ADP file.")

    merged = stats_df.merge(
        adp_df,
        on='player_clean',
        how='outer',
        suffixes=('', '_adp')
    )
    merged['player'] = merged['player_clean']
    merged = merged.drop(columns=['player_clean'])
    cols = ['player'] + [col for col in merged.columns if col != 'player']
    merged = merged[cols]
    merged.to_csv(output_path, index=False, na_rep='-')
    print(f"[OK] Merged ADP and saved to {output_path}")

def build_final_player_stats(input_path, output_path):
    """Finalize player stats: clean, deduplicate, sort, save to CSV."""
    df = pd.read_csv(input_path)
    # Example: keep only relevant columns, drop duplicates, sort, etc.
    df = df.drop_duplicates(subset=["player"], keep="first")
    df = df.sort_values(by=["player"])
    df.to_csv(output_path, index=False, na_rep='-')
    print(f"[OK] Final player stats saved to: {output_path}")

def apply_aliases(df):
    alias_map = {
        'age': ['Age'], 'team': ['Team'], 'pos': ['Pos'], 'g': ['G'], 'gs': ['GS'],
        'fmb': ['Fmb', 'fmb'], 'awards': ['Awards'],
    }
    for standard_col, aliases in alias_map.items():
        df = pdh.alias_bfill(df, standard_col, aliases)
    return df

def drop_known_extras(df):
    return pdh.drop_columns(df, ['yds.1', 'awards', 'qbrec'])

def reorder_core_columns(df):
    return pdh.reorder_columns(df, ['player', 'pos', 'team', 'age', 'g', 'gs'])

def auto_unify_columns(df):
    suffixes = ["_x", "_y"]
    identity_cols = {"age", "team", "pos"}
    base_candidates = set()
    for col in df.columns:
        for suffix in suffixes:
            if col.endswith(suffix):
                base = col.rsplit(suffix, 1)[0]
                if base not in {"g", "gs"} and base not in identity_cols:
                    base_candidates.add(base)
    if base_candidates:
        print(f"[INFO] Auto-unifying columns: {sorted(base_candidates)}")
        for base_col in sorted(base_candidates):
            matches = [c for c in df.columns if c == base_col or c.startswith(base_col + "_")]
            # Backfill across matching columns and keep first non-null
            df[base_col] = df[matches].bfill(axis=1).iloc[:, 0]
            for col in matches:
                if col != base_col:
                    df.drop(columns=col, inplace=True, errors="ignore")
    else:
        print("[INFO] No _x/_y columns to unify.")
    return df

def clean_all(df):
    df = pdh.normalize_column_names(df)
    df = apply_aliases(df)
    df = drop_known_extras(df)
    df = auto_unify_columns(df)
    df = unify_specific_columns(df, ["g", "gs"])
    columns_file = Path(__file__).resolve().parents[1] / "resources" / "columns_to_drop.txt"
    try:
        df = pdh.drop_columns_from_file(df, filepath=columns_file)
    except FileNotFoundError:
        pass
    df = reorder_core_columns(df)
    df = pdh.fill_nulls(df)
    print("\n\nFinal columns after cleanup and consolidation:")
    for col in df.columns:
        print(f" - {col}")
    return df

# --- Project-specific player name normalization ---

def normalize_player_name(name):
    name = str(name)
    name = re.sub(r"[*+]", "", name)
    name = name.replace(".", "")
    name = re.sub(r"\s+", " ", name).strip()
    return name.lower()

def deduplicate_by_team(df):
    if 'team' not in df.columns:
        return df
    df = df.copy()
    df['player_team_key'] = df['player'].astype(str) + '_' + df['team'].fillna('')
    # simple sort then drop duplicates, keeping first occurrence
    df = df.sort_values(by=['player', 'team'])
    out = df.drop_duplicates(subset='player', keep='first').drop(columns=['player_team_key'])
    return out

def fetch_stat_category(label, url, output_path):
    from data_fetcher.data_fetcher import DataFetcher
    try:
        print(f"[INFO] Fetching {label} stats...")
        fetcher = DataFetcher(url=url, save_path=output_path)
        fetcher.fetch_data()
        df = fetcher.get_data()
        print(df.head())
        return df
    except Exception as e:
        import logging
        logging.error(f"Error while fetching {label} stats: {e}")
        if os.path.exists(output_path):
            logging.warning(
                "Using cached %s stats from %s because the live fetch failed.",
                label,
                output_path,
            )
            cached_df = pd.read_csv(output_path)
            if not any("player" in str(col).lower() for col in cached_df.columns):
                cached_df = pd.read_csv(output_path, header=[0, 1])
            return cached_df
        return None

def clean_and_prepare(df, source_name):
    df = df.copy()
    # Flatten MultiIndex if present
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [' '.join([str(p).strip() for p in col if str(p).strip() != '']) for col in df.columns.values]

    # Remove common header/export artifacts
    cleaned_cols = [re.sub(r"(?:unnamed[:_\s]*\d+|_?level_\d+|\d+_level_\d+)", "", str(col).strip(), flags=re.IGNORECASE).strip() for col in df.columns]
    # Normalize column names to a canonical form
    df.columns = [normalize_col(c) for c in cleaned_cols]

    print(f"[INFO] {source_name} columns after flattening:")
    print(list(df.columns))

    # Try to find a player-like column
    player_col = None
    # exact match
    if 'player' in df.columns:
        player_col = 'player'
    else:
        # contains 'player'
        player_col = next((c for c in df.columns if 'player' in c), None)

    # If not found, try using first row as header (some CSVs export headers as first row)
    if player_col is None and df.shape[0] > 0:
        first_row = df.iloc[0].astype(str).tolist()
        if any('player' in str(x).strip().lower() for x in first_row):
            df.columns = df.iloc[0].astype(str)
            df = df.drop(df.index[0]).reset_index(drop=True)
            df.columns = [normalize_col(c) for c in df.columns]
            player_col = next((c for c in df.columns if c == 'player' or 'player' in c), None)

    if player_col is None:
        # Last resort: check index name
        if df.index.name and str(df.index.name).strip().lower() == 'player':
            df = df.reset_index()
            player_col = 'player'

    if player_col is None:
        raise ValueError(f"{source_name} DataFrame does not contain a recognizable 'player' column.")

    # Create canonical lowercase 'player' column
    df.loc[:, 'player'] = df[player_col].astype(str).apply(normalize_player)

    # Ensure pos exists (try common variants)
    pos_col = next((col for col in df.columns if col.strip().lower() == 'pos' or 'pos' in col.lower()), None)
    if pos_col and pos_col != 'pos':
        df.rename(columns={pos_col: 'pos'}, inplace=True)

    # If this is the Passing source, create 'passing_' prefixed duplicates for all stat columns
    try:
        if isinstance(source_name, str) and 'pass' in source_name.strip().lower():
            identity = {'player', 'player_id', 'pos', 'team', 'age', 'g', 'gs', 'rk', 'awards', 'fmb'}
            for col in list(df.columns):
                col_l = str(col).strip().lower()
                if col_l in identity:
                    continue
                if col_l.startswith('passing_'):
                    continue
                pref = 'passing_' + col_l
                # only add if not present to avoid overwriting
                if pref not in df.columns:
                    df[pref] = df[col]
    except Exception:
        # Don't let prefixing break parsing
        pass

    return df

def merge_stats(dfs_with_labels):
    if not dfs_with_labels:
        return pd.DataFrame()
    cleaned_dfs = [clean_and_prepare(df, label) for df, label in dfs_with_labels]
    merged_df = reduce(lambda left, right: pd.merge(left, right, on="player", how="outer"), cleaned_dfs)
    print("[INFO] Final columns after cleaning in merged dataset:")
    for col in merged_df.columns:
        print(f" - {col}")
    return merged_df

def unify_player_column(df):
    player_cols = sorted({col for col in df.columns if "player" in col.lower()}, key=str.lower)
    if not player_cols:
        print("[WARN] No player-like columns found.")
        return df
    # Rename any non-canonical player columns to 'player' and backfill if necessary
    if 'player' not in df.columns:
        # take first player-like column
        df = df.rename(columns={player_cols[0]: 'player'})
    if df.filter(regex='(?i)player').shape[1] > 1:
        print("[INFO] Unifying duplicated 'player' columns...")
        df['player'] = df.filter(regex='(?i)player').bfill(axis=1).iloc[:, 0]
        df = df.loc[:, ~df.columns.duplicated()]
    df['player'] = df['player'].astype(str).str.strip().str.lower()
    # Move 'player' to front
    cols = df.columns.tolist()
    if 'player' in cols:
        cols.insert(0, cols.pop(cols.index('player')))
    return df[cols]

def unify_specific_columns(df, target_columns):
    for base_col in target_columns:
        matches = [col for col in df.columns if col == base_col or col.startswith(f"{base_col}_")]
        if len(matches) > 1:
            print(f"[INFO] Unifying manually: {matches}")
            df[base_col] = df[matches].bfill(axis=1).iloc[:, 0]
            df.drop(columns=[col for col in matches if col != base_col], inplace=True)
    return df

def fill_identity_columns(df, identity_cols=["age", "team", "pos"]):
    for col in identity_cols:
        matches = [c for c in df.columns if c.lower().startswith(col.lower())]
        if not matches:
            continue
        print(f"[INFO] Filling identity column: {col} from {matches}")
        temp = df[matches].bfill(axis=1).iloc[:, 0]
        # compute per-player mode
        mode_series = df.assign(_temp=temp).groupby('player')['_temp'].agg(lambda x: x.dropna().mode().iloc[0] if not x.dropna().empty else None)
        df[col] = df['player'].map(mode_series)
        for c in matches:
            if c != col:
                df.drop(columns=c, inplace=True, errors='ignore')
    return df


def ensure_pos_column(df):
    """
    Ensure there is a 'pos' column. If not present, attempt to find common variants
    (e.g., 'position', 'unnamed__pos') and create/rename to 'pos'. Returns df.
    """
    if 'pos' in df.columns:
        return df
    # common candidates
    candidates = [c for c in df.columns if c.strip().lower() == 'position' or c.strip().lower().endswith('pos') or 'pos' in c.lower()]
    if candidates:
        df['pos'] = df[candidates[0]]
        return df
    # not found — return df unchanged (caller can decide to raise)
    return df


def ensure_games_column(df):
    """
    Ensure there is a 'g' column representing games played. If missing, try 'games' or
    variants like 'unnamed__g'. Returns df.
    """
    # Accept common exact column names (case-insensitive)
    lower_cols = {c.strip().lower(): c for c in df.columns}
    for key in ('g', 'games', 'gp', 'games_played'):
        if key in lower_cols:
            df['g'] = df[lower_cols[key]]
            return df

    # Look for variants like 'g_x', 'g_y', or columns that end with '_g' or '__g'
    candidates = [c for c in df.columns if c.strip().lower().endswith('_g') or c.strip().lower().endswith('__g') or c.strip().lower() in ('g_x', 'g_y')]
    if candidates:
        df['g'] = df[candidates[0]]
        return df

    # If still not found, default to full season (17 games) so regression can proceed.
    # This is a safe fallback when games-played info is not available; caller will have a warning.
    df['g'] = 17
    print("[WARN] No games-played column found; defaulting 'g' to 17 for all players.")
    return df


def load_rookie_predictions(file_path):
    """Load rookie prediction CSV and normalize columns to project schema.

    Returns a DataFrame with canonical columns used by the pipeline (player, pos, team, g,
    yds, td, int, rushing_yds, rushing_td, receiving_rec, receiving_yds, receiving_td, fmb, etc.).
    """
    if not os.path.exists(file_path):
        print(f"[WARN] Rookie predictions file not found: {file_path}")
        return pd.DataFrame()

    df = pd.read_csv(file_path)
    # unify column names to lowercase without trailing _rookie
    df.columns = [re.sub(r'_?rookie$', '', str(c).strip(), flags=re.IGNORECASE).strip().lower() for c in df.columns]

    # Map incoming columns to canonical pipeline names
    col_map = {
        'player': 'player',
        'pos': 'pos',
        'team': 'team',
        'games': 'g',
        'cmp': 'cmp',
        'att': 'att',
        'passing yds': 'yds',
        'passing td': 'td',
        'int': 'int',
        'rush att': 'rushing_att',
        'rush yds': 'rushing_yds',
        'rush tds': 'rushing_td',
        'recs': 'receiving_rec',
        'rec yds': 'receiving_yds',
        'rec tds': 'receiving_td',
        'fumbles': 'fmb',
        'points': 'points_rookie'
    }

    renamed = {}
    for c in df.columns:
        key = c.strip().lower()
        if key in col_map:
            renamed[c] = col_map[key]
    df = df.rename(columns=renamed)

    # Ensure player column exists and normalize names
    if 'player' not in df.columns:
        # try alternative column names
        guessed = next((c for c in df.columns if 'player' in c.lower()), None)
        if guessed:
            df = df.rename(columns={guessed: 'player'})
        else:
            print("[WARN] No player column found in rookie predictions; skipping file.")
            return pd.DataFrame()

    df.loc[:, 'player'] = df['player'].astype(str).apply(normalize_player)

    # Ensure numeric columns exist and coerce types
    numeric_cols = ['g', 'cmp', 'att', 'yds', 'td', 'int', 'rushing_att', 'rushing_yds', 'rushing_td', 'receiving_rec', 'receiving_yds', 'receiving_td', 'fmb']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
        else:
            df[col] = 0

    df['is_rookie'] = True

    # Keep only canonical columns we care about
    keep_cols = [
        'player', 'pos', 'team', 'is_rookie', 'g', 'cmp', 'att', 'yds', 'td', 'int',
        'rushing_att', 'rushing_yds', 'rushing_td', 'receiving_rec', 'receiving_yds',
        'receiving_td', 'fmb',
    ]
    for c in keep_cols:
        if c not in df.columns:
            df[c] = 0

    return df[keep_cols]


def append_rookies_to_stats(stats_df, rookie_file_path):
    """Append rookie projections to stats_df for players not already present.

    - Loads rookie predictions, normalizes them, and appends rows whose `player` is not
      in stats_df['player']. Returns the combined DataFrame.
    """
    rookies = load_rookie_predictions(rookie_file_path)
    if rookies.empty:
        return stats_df

    # Normalize players in stats_df for matching
    stats_df = stats_df.copy()
    stats_df['player'] = stats_df['player'].astype(str).str.strip().str.lower()
    if 'is_rookie' not in stats_df.columns:
        stats_df['is_rookie'] = False
    else:
        stats_df['is_rookie'] = (
            stats_df['is_rookie'].fillna(False).astype(str).str.casefold().isin({'true', '1', 'yes'})
        )

    # Which rookies are new vs present
    stats_players = set(stats_df['player'])
    rookies_present = rookies[rookies['player'].isin(stats_players)].copy()
    rookies_to_add = rookies[~rookies['player'].isin(stats_players)].copy()

    updated = 0
    # Upsert: for rookies already present, fill missing/zero numeric fields from projections
    if not rookies_present.empty:
        # base numeric columns from rookies
        numeric_base = ['g', 'cmp', 'att', 'yds', 'td', 'int', 'rushing_att', 'rushing_yds', 'rushing_td', 'receiving_rec', 'receiving_yds', 'receiving_td', 'fmb']
        for _, rrow in rookies_present.iterrows():
            pname = rrow['player']
            mask = stats_df['player'] == pname
            if not mask.any():
                continue
            stats_df.loc[mask, 'is_rookie'] = True
            for base_col in numeric_base:
                # build candidate columns to try updating in the stats_df
                candidates = [base_col]
                # common passing bases often appear in stats as passing_<base>
                if base_col in {'cmp', 'att', 'yds', 'td', 'int'}:
                    candidates.append('passing_' + base_col)
                # ensure receiving/rushing canonical names are also considered without prefix
                if base_col in {'receiving_rec', 'receiving_yds', 'receiving_td'}:
                    # sometimes sources use 'rec' / 'recs' etc.; we'll also try base variants
                    candidates.append(base_col.replace('receiving_', ''))

                for col in candidates:
                    if col not in stats_df.columns:
                        # create column if missing in stats_df so we can upsert into it
                        stats_df[col] = pd.NA
                    try:
                        # consider missing or zero as replaceable
                        stats_vals = pd.to_numeric(stats_df.loc[mask, col], errors='coerce')
                        replace_mask = stats_vals.isna() | (stats_vals == 0)
                        if replace_mask.any():
                            stats_df.loc[mask, col] = stats_df.loc[mask, col].where(~replace_mask, other=rrow.get(base_col, 0))
                            updated += int(replace_mask.sum())
                    except Exception:
                        # if non-numeric column, skip
                        continue

    # Append rookies that are not present already
    combined = stats_df
    if not rookies_to_add.empty:
        # Before appending, create passing_ prefixed copies for passing-related rookie columns
        # so that downstream logic sees 'passing_' fields consistently.
        rookies_to_add = rookies_to_add.copy()
        for col in list(rookies_to_add.columns):
            if col in {'cmp', 'att', 'yds', 'td', 'int'}:
                pref = 'passing_' + col
                if pref not in rookies_to_add.columns:
                    rookies_to_add[pref] = rookies_to_add[col]

        combined = pd.concat([combined, rookies_to_add], ignore_index=True, sort=False)
        print(f"[INFO] Appended {len(rookies_to_add)} rookie projection(s) to stats.")
    else:
        print("[INFO] No new rookies to append — all present in stats.")

    if updated:
        print(f"[INFO] Updated {updated} numeric field(s) for existing players from rookie projections.")

    combined['is_rookie'] = combined['is_rookie'].fillna(False).astype(bool)
    return combined
