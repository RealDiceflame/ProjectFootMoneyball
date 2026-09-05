"""Readable orchestration for the fantasy-football data pipeline."""

from pathlib import Path
import pandas as pd

from config import (
    ADP_DIR, ADP_FILENAME, ADP_SNAPSHOT_DATE, LEAGUE_TEAMS,
    OUTPUT_DIR, PROJECTION_SEASON, RESOURCE_DIR, STAT_SEASON, STATS_DIR,
    TE_RECEPTION_BONUS, get_stat_urls,
)
from data_fetcher.adp_importer import latest_adp_date
from data_fetcher.rookie_prop_projections import build_rookie_prop_projections
from stat_utils.data_analytics.draft_rankings import save_default_draft_rankings
from stat_utils.data_analytics.fantasy_points import calculate_and_save_fantasy_points
from stat_utils.data_analytics.regression_analysis import calculate_fantasy_value_vs_adp
from stat_utils.pipeline_cleaning import prepare_ranking_input
from stat_utils.project_dataframe_utils import (
    append_rookies_to_stats, auto_unify_columns, build_final_player_stats,
    clean_adp_dataframe, clean_all, fetch_and_normalize_stat_tables,
    fill_identity_columns, load_nflverse_stat_tables, merge_full_adp,
    merge_stats, save_and_report_merged_stats, unify_player_column,
    unify_specific_columns,
)


def _pipeline_paths():
    return {
        "nflverse": STATS_DIR / f"nflverse_player_stats_{STAT_SEASON}.csv",
        "rookies": STATS_DIR / f"{PROJECTION_SEASON} Rookie Prediction Stats - Sheet1.csv",
        "rookie_lines": STATS_DIR / f"rookie_betting_lines_{PROJECTION_SEASON}.csv",
        "merged_stats": OUTPUT_DIR / "all_stats_merged.csv",
        "final_stats": OUTPUT_DIR / "final_player_stats.csv",
        "fantasy": OUTPUT_DIR / "final_player_stats_with_fantasy.csv",
        "merged_adp": OUTPUT_DIR / "final_player_stats_with_fantasy_and_full_adp.csv",
        "adp_audit": OUTPUT_DIR / "final_player_stats_with_fantasy_and_full_adp_pre_filter.csv",
        "regression": OUTPUT_DIR / "fantasy_value_vs_adp.csv",
    }


def _load_stats(paths):
    if paths["nflverse"].exists():
        tables = load_nflverse_stat_tables(paths["nflverse"])
    else:
        tables = fetch_and_normalize_stat_tables(get_stat_urls(STAT_SEASON))
    stats = merge_stats(tables)
    if paths["rookie_lines"].exists() and paths["nflverse"].exists():
        build_rookie_prop_projections(
            lines_path=paths["rookie_lines"],
            stats_path=paths["nflverse"],
            output_path=paths["rookies"],
        )
    stats = append_rookies_to_stats(stats, paths["rookies"])
    stats = unify_player_column(stats)
    stats = unify_specific_columns(stats, target_columns=["g", "gs"])
    stats = fill_identity_columns(stats, identity_cols=["age", "team", "pos", "fmb"])
    return clean_all(auto_unify_columns(stats))


def _build_stat_outputs(paths):
    stats = _load_stats(paths)
    save_and_report_merged_stats(stats, OUTPUT_DIR)
    build_final_player_stats(paths["merged_stats"], paths["final_stats"])
    calculate_and_save_fantasy_points(paths["final_stats"], paths["fantasy"])


def _merge_and_clean_adp(paths):
    adp_path = ADP_DIR / ADP_FILENAME
    cleaned_path = ADP_DIR / f"cleaned_adp_{PROJECTION_SEASON}.csv"
    clean_adp_dataframe(pd.read_csv(adp_path)).to_csv(cleaned_path, index=False, na_rep="-")
    merge_full_adp(paths["fantasy"], adp_path, paths["merged_adp"])
    merged = pd.read_csv(paths["merged_adp"])
    cleaned = prepare_ranking_input(
        merged,
        columns_file=RESOURCE_DIR / "columns_to_drop.txt",
        audit_path=paths["adp_audit"],
    )
    cleaned.to_csv(paths["merged_adp"], index=False, na_rep="-")


def run_pipeline():
    """Build stats, projections, ADP analysis, and all ranking formats."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    paths = _pipeline_paths()
    _build_stat_outputs(paths)
    adp_path = ADP_DIR / ADP_FILENAME
    snapshot_date = latest_adp_date(adp_path, ADP_SNAPSHOT_DATE) or ""
    if not snapshot_date.startswith(str(PROJECTION_SEASON)):
        print(f"[WARN] ADP snapshot {snapshot_date} does not match {PROJECTION_SEASON}; rankings skipped.")
        return
    _merge_and_clean_adp(paths)
    calculate_fantasy_value_vs_adp(paths["merged_adp"], paths["regression"])
    save_default_draft_rankings(
        input_path=paths["merged_adp"], output_dir=OUTPUT_DIR,
        teams=LEAGUE_TEAMS, te_premium=TE_RECEPTION_BONUS,
    )
