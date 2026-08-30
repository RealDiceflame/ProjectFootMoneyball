# Read existing merged stats, apply updated append_rookies_to_stats, and regenerate final and fantasy CSVs
import os
import pandas as pd
from stat_utils.project_dataframe_utils import append_rookies_to_stats, unify_player_column, unify_specific_columns, fill_identity_columns, auto_unify_columns, clean_all, save_and_report_merged_stats, build_final_player_stats
from stat_utils.data_analytics.fantasy_points import calculate_and_save_fantasy_points

output_dir = 'output'
data_dir = 'data'
merged_path = os.path.join(output_dir, 'all_stats_merged.csv')
if not os.path.exists(merged_path):
    raise FileNotFoundError(f"Expected merged stats at {merged_path}")

df = pd.read_csv(merged_path)
rookie_file = os.path.join(data_dir, 'stats', '2025 Rookie Prediction Stats - Sheet1.csv')

# apply upsert/append
updated = append_rookies_to_stats(df, rookie_file)
# run consolidation steps similar to main
updated = unify_player_column(updated)
updated = unify_specific_columns(updated, target_columns=["g", "gs"])
updated = fill_identity_columns(updated, identity_cols=["age", "team", "pos", "fmb"])
updated = auto_unify_columns(updated)
updated = clean_all(updated)

os.makedirs(output_dir, exist_ok=True)
# overwrite merged
save_and_report_merged_stats(updated, output_dir)
# rebuild final and fantasy
build_final_player_stats()
calculate_and_save_fantasy_points(input_path=os.path.join(output_dir,'final_player_stats.csv'), output_path=os.path.join(output_dir,'final_player_stats_with_fantasy.csv'))

print('Applied rookie upsert and regenerated outputs')
