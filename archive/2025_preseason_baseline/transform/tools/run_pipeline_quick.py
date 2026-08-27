# Quick runner to rebuild merged stats and final outputs using local data files
from stat_utils.project_dataframe_utils import fetch_and_normalize_stat_tables, merge_stats, append_rookies_to_stats, unify_player_column, unify_specific_columns, fill_identity_columns, auto_unify_columns, clean_all, save_and_report_merged_stats, build_final_player_stats
from stat_utils.data_analytics.fantasy_points import calculate_and_save_fantasy_points
import os

if __name__ == '__main__':
    output_dir = 'output'
    data_dir = 'data'
    stat_urls = {'Passing': '', 'Rushing': '', 'Receiving': ''}
    # Instead of fetching, read local files by invoking the fetch_and_normalize_stat_tables logic
    # which expects URLs but reads data/stats/<category>_2024.csv; ensure files exist
    tables = fetch_and_normalize_stat_tables({'Passing': '', 'Rushing': '', 'Receiving': ''})
    merged = merge_stats(tables)
    rookie_file = os.path.join(data_dir, 'stats', '2025 Rookie Prediction Stats - Sheet1.csv')
    merged = append_rookies_to_stats(merged, rookie_file)
    merged = unify_player_column(merged)
    merged = unify_specific_columns(merged, target_columns=["g", "gs"])
    merged = fill_identity_columns(merged, identity_cols=["age", "team", "pos", "fmb"])
    merged = auto_unify_columns(merged)
    merged = clean_all(merged)
    os.makedirs(output_dir, exist_ok=True)
    save_and_report_merged_stats(merged, output_dir)
    build_final_player_stats()
    calculate_and_save_fantasy_points(input_path=os.path.join(output_dir,'final_player_stats.csv'), output_path=os.path.join(output_dir,'final_player_stats_with_fantasy.csv'))
    print('Quick pipeline finished')
