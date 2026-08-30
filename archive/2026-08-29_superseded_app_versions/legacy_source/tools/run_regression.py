import sys
from pathlib import Path
proj_root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(proj_root))
from stat_utils.data_analytics.regression_analysis import calculate_fantasy_value_vs_adp
import os

input_csv = os.path.join('output', 'final_player_stats_with_fantasy_and_full_adp.csv')
output_csv = os.path.join('output', 'fantasy_value_vs_adp.csv')

print(f"Running regression with input={input_csv}, output={output_csv}")
calculate_fantasy_value_vs_adp(input_csv_path=input_csv, output_csv_path=output_csv)
print('Regression completed.')
