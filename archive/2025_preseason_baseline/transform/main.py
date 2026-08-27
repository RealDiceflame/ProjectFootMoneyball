
"""
main.py – Fantasy Football Data Scraper & Scoring Calculator

Pipeline:
1. Fetch and normalize stat tables
2. Merge and clean all player stats
3. Build final player stats and calculate fantasy points
4. Clean and merge ADP data
5. Perform regression analysis to determine player value vs. ADP
"""


import os
import re
import pandas as pd
from stat_utils.project_dataframe_utils import (
    fetch_and_normalize_stat_tables, merge_stats, unify_player_column, unify_specific_columns, fill_identity_columns, auto_unify_columns, clean_all,
    save_and_report_merged_stats, build_final_player_stats, clean_adp_dataframe, merge_full_adp
)
from stat_utils.data_analytics.fantasy_points import calculate_and_save_fantasy_points
from stat_utils.data_analytics.regression_analysis import calculate_fantasy_value_vs_adp


def main():

    output_dir = "output"
    data_dir = "data"
    os.makedirs(output_dir, exist_ok=True)

    # --- 1. Fetch and normalize stat tables ---
    stat_urls = {
        "Passing": "https://www.pro-football-reference.com/years/2024/passing.htm#passing",
        "Rushing": "https://www.pro-football-reference.com/years/2024/rushing.htm#rushing",
        "Receiving": "https://www.pro-football-reference.com/years/2024/receiving.htm#receiving"
    }
    stat_tables = fetch_and_normalize_stat_tables(stat_urls)

    # --- 2. Merge and clean all player stats ---
    combined_stats = merge_stats(stat_tables)
    # --- Add rookie predictions (if available) ---
    from stat_utils.project_dataframe_utils import append_rookies_to_stats
    rookie_file = os.path.join(data_dir, 'stats', '2025 Rookie Prediction Stats - Sheet1.csv')
    combined_stats = append_rookies_to_stats(combined_stats, rookie_file)
    combined_stats = unify_player_column(combined_stats)
    combined_stats = unify_specific_columns(combined_stats, target_columns=["g", "gs"])
    # Include 'fmb' so fumbles (fmb_x/fmb_y/etc.) are unified into a canonical 'fmb' column
    combined_stats = fill_identity_columns(combined_stats, identity_cols=["age", "team", "pos", "fmb"])
    combined_stats = auto_unify_columns(combined_stats)
    combined_stats = clean_all(combined_stats)
    save_and_report_merged_stats(combined_stats, output_dir)

    # --- 3. Build final player stats and calculate fantasy points ---
    build_final_player_stats()
    final_stats_path = os.path.join(output_dir, "final_player_stats.csv")
    fantasy_output_path = os.path.join(output_dir, "final_player_stats_with_fantasy.csv")
    calculate_and_save_fantasy_points(input_path=final_stats_path, output_path=fantasy_output_path)

    # --- 4. Clean and merge ADP data ---
    adp_path = os.path.join(data_dir, "ADP", "4for4-adp-table8-27.csv")
    cleaned_adp_path = os.path.join(data_dir, "ADP", "cleaned_adp.csv")
    adp_raw_df = pd.read_csv(adp_path)
    adp_clean_df = clean_adp_dataframe(adp_raw_df)
    adp_clean_df.to_csv(cleaned_adp_path, index=False, na_rep='-')
    merged_adp_output_path = os.path.join(output_dir, "final_player_stats_with_fantasy_and_full_adp.csv")
    merge_full_adp(stats_path=fantasy_output_path, adp_path=adp_path, output_path=merged_adp_output_path)

    # --- 5. Regression analysis: player value vs. ADP ---
    regression_output_path = os.path.join(output_dir, "fantasy_value_vs_adp.csv")
    # Ensure required columns exist for regression (pos, g)
    df_merge = pd.read_csv(merged_adp_output_path)

    # Remove players who do not have ADP statistics: find an ADP-like column and filter
    adp_candidates = [c for c in df_merge.columns if 'adp' in str(c).lower()]
    if adp_candidates:
        # prefer exact 'adp' if present, otherwise use the first matching column
        adp_col = next((c for c in adp_candidates if str(c).strip().lower() == 'adp'), adp_candidates[0])
        before = len(df_merge)
        df_merge = df_merge[df_merge[adp_col].notna() & df_merge[adp_col].astype(str).str.strip().ne('')]
        after = len(df_merge)
        print(f"[INFO] Filtered players without ADP using column '{adp_col}': removed {before-after}, kept {after} rows.")
    else:
        print("[WARN] No ADP-like column found in merged ADP file; skipping ADP-based filtering.")
    # Drop any columns listed in columns_to_drop.txt
    from stat_utils.pandas_helpers import drop_columns_from_file
    # ensure we keep key passing and receiving metrics in the final output
    keep_cols = [
        "passing_att", "passing_cmp", "passing_yds", "passing_td", "passing_int",
        # preserve receiving fields so broad patterns like 'td%' don't remove them
        "receiving_tgt", "receiving_rec", "receiving_yds", "receiving_td", "receiving_tds"
    ]
    df_merge = drop_columns_from_file(df_merge, filepath="columns_to_drop.txt", keep_patterns=keep_cols)

    # Remove any other passing_* columns not explicitly allowed so the final CSV only contains
    # the requested passing metrics.
    allowed = {c.lower() for c in keep_cols}
    passing_cols = [c for c in df_merge.columns if c.lower().startswith('passing_')]
    to_drop_passing = [c for c in passing_cols if c.lower() not in allowed]
    if to_drop_passing:
        print(f"[INFO] Dropping unneeded passing columns: {sorted(to_drop_passing)}")
        df_merge = df_merge.drop(columns=to_drop_passing, errors='ignore')
    # Keep only specific rushing columns: rushing_att, rushing_yds, rushing_td
    allowed_rushing = {"rushing_att", "rushing_yds", "rushing_td"}
    rushing_cols = [c for c in df_merge.columns if c.lower().startswith('rushing_')]
    to_drop_rushing = [c for c in rushing_cols if c.lower() not in allowed_rushing]
    if to_drop_rushing:
        print(f"[INFO] Dropping unneeded rushing columns: {sorted(to_drop_rushing)}")
        df_merge = df_merge.drop(columns=to_drop_rushing, errors='ignore')
    # Keep only specific receiving columns: accept common variants/misspellings too
    allowed_receiving = {
        "receiving_tgt",
        "receiving_rec",
        "receiving_yds",
        # some sources use singular/plural or slightly different spellings
        "receiving_td",
        "receiving_tds",
        "recieving_tgt",
        "recieving_rec",
        "recieving_yds",
        "recieving_td",
        "recieving_tds",
    }
    receiving_cols = [c for c in df_merge.columns if c.lower().startswith('receiving_')]
    to_drop_receiving = [c for c in receiving_cols if c.lower() not in allowed_receiving]
    if to_drop_receiving:
        print(f"[INFO] Dropping unneeded receiving columns: {sorted(to_drop_receiving)}")
        df_merge = df_merge.drop(columns=to_drop_receiving, errors='ignore')
    from stat_utils.project_dataframe_utils import ensure_pos_column, ensure_games_column
    df_merge = ensure_pos_column(df_merge)
    df_merge = ensure_games_column(df_merge)
    # Remove Kickers (K) and Team Defenses (DEF) from the final merged ADP output
    # Strategy: save an audit copy, then build an authoritative canonical position by
    # coalescing stat 'pos' and any ADP 'Position' column (and other pos-like cols),
    # normalize values, extract the alpha prefix (handles 'K-1' and 'DEF-19'), and
    # filter rows where that prefix is K or DEF. As a guarded backup, scan ADP-specific
    # columns for K/DEF tokens.
    try:
        # save an audit copy so the full merged file is preserved before filtering
        audit_path = os.path.join(output_dir, "final_player_stats_with_fantasy_and_full_adp_pre_filter.csv")
        df_merge.to_csv(audit_path, index=False, na_rep='-')
        print(f"[INFO] Saved pre-filter ADP-merged audit copy to {audit_path}")

        # identify candidate position columns (case-insensitive match)
        pos_like_cols = [c for c in df_merge.columns if str(c).strip().lower() in ('pos', 'position') or str(c).strip().lower().endswith('pos')]
        # also prefer ADP 'Position' if present explicitly
        if 'Position' in df_merge.columns and 'Position' not in pos_like_cols:
            pos_like_cols.append('Position')

        # build canonical position series by left-to-right coalescing
        canonical_pos = pd.Series([pd.NA] * len(df_merge), index=df_merge.index, dtype=object)
        for col in pos_like_cols:
            # treat empty/blank strings as missing
            col_vals = df_merge[col].astype(str).replace(r'^\s*$', pd.NA, regex=True)
            canonical_pos = canonical_pos.fillna(col_vals)

        # Normalize to uppercase and extract leading alpha token (e.g. 'K' from 'K-1' or 'DEF' from 'DEF-19')
        canonical_pos = canonical_pos.fillna('').astype(str).str.strip().str.upper()
        prefix = canonical_pos.str.extract(r'^(?P<prefix>[A-Z]{1,4})')['prefix'].fillna('')

        before_pos = len(df_merge)
        mask = prefix.isin({'K', 'DEF'})
        df_merge = df_merge[~mask]
        after_pos = len(df_merge)
        print(f"[INFO] Removed players with canonical position prefix K/DEF using cols {pos_like_cols}: removed {before_pos-after_pos}, kept {after_pos} rows.")

        # Backup scan: if any remaining ADP-specific columns still contain K-/DEF- tokens,
        # remove those rows too. Restrict the scan to ADP provider columns to avoid
        # false positives from stat columns.
        adp_columns = [c for c in df_merge.columns if any(k in str(c).lower() for k in ('adp', 'position', 'player', 'team'))]
        if adp_columns:
            try:
                adp_pattern = re.compile(r'(?:\bK\b|\bDEF\b|\bK-|\bDEF-)', flags=re.IGNORECASE)
                def adp_row_has_k_def(row):
                    for col in adp_columns:
                        try:
                            val = row.get(col)
                            if val is None:
                                continue
                            if adp_pattern.search(str(val)):
                                return True
                        except Exception:
                            continue
                    return False

                adp_mask = df_merge.apply(adp_row_has_k_def, axis=1)
                if adp_mask.any():
                    before_adp_scan = len(df_merge)
                    df_merge = df_merge[~adp_mask]
                    after_adp_scan = len(df_merge)
                    print(f"[INFO] ADP-column scan removed {before_adp_scan-after_adp_scan} rows matching K/DEF in ADP columns ({adp_columns}).")
            except Exception as e:
                print(f"[WARN] ADP-column K/DEF scan failed: {e}")
        else:
            print("[WARN] No ADP-like columns found for ADP-column K/DEF backup scan.")
    except Exception as e:
        print(f"[WARN] K/DEF authoritative filtering failed: {e}")
    # Drop ambiguous base 'att' if present (we keep passing_att / rushing_att).
    att_candidates = [c for c in df_merge.columns if str(c).strip().lower() == 'att']
    if att_candidates:
        print(f"[INFO] Dropping ambiguous 'att' column(s) from merged ADP output: {att_candidates}")
        df_merge = df_merge.drop(columns=att_candidates, errors='ignore')

    # Final sanity filter: row-wise regex scan to remove Kickers/DEF entries reliably
    try:
        pattern = re.compile(r'(?:\bK\b|\bDEF\b|\bK-|\bDEF-)', flags=re.IGNORECASE)
        def row_has_k_def(row):
            for cell in row:
                try:
                    if cell is None:
                        continue
                    if pattern.search(str(cell)):
                        return True
                except Exception:
                    continue
            return False

        rows_with_tokens = df_merge.apply(row_has_k_def, axis=1)
        if rows_with_tokens.any():
            removed = int(rows_with_tokens.sum())
            df_merge = df_merge[~rows_with_tokens]
            print(f"[INFO] Final row-wise filter removed {removed} rows matching K/DEF before save.")
    except Exception as e:
        print(f"[WARN] Final row-wise K/DEF filter failed: {e}")

    df_merge.to_csv(merged_adp_output_path, index=False, na_rep='-')

    calculate_fantasy_value_vs_adp(input_csv_path=merged_adp_output_path, output_csv_path=regression_output_path)


if __name__ == "__main__":
    main()
