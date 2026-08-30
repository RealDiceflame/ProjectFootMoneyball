import pandas as pd
from pathlib import Path

COMBINED = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp_combined.csv")
FINAL = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\final_player_stats_with_fantasy_and_full_adp.csv")
OUT = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp_combined_with_nfl.csv")

for p in (COMBINED, FINAL):
    if not p.exists():
        print('Required file not found:', p)
        raise SystemExit(1)

comb = pd.read_csv(COMBINED, dtype=str)
final = pd.read_csv(FINAL, dtype=str)

# Find NFL column in final (case-insensitive)
nfl_col = None
for c in final.columns:
    if c.strip().lower() == 'nfl':
        nfl_col = c
        break
if nfl_col is None:
    print('NFL column not found in', FINAL)
    raise SystemExit(1)

# Merge to bring in projection columns
key_cols = ['player', 'pos']
for k in key_cols:
    if k not in comb.columns or k not in final.columns:
        print('Key column missing for merge:', k)
        raise SystemExit(1)

merged = comb.merge(final[['player','pos', 'fantasy_standard_ppr_proj_17g', 'fantasy_half_ppr_proj_17g', 'fantasy_full_ppr_proj_17g', nfl_col]], on=['player','pos'], how='left', suffixes=('','_final'))

# Coerce NFL ADP to numeric
merged['NFL_adp_val'] = pd.to_numeric(merged[nfl_col], errors='coerce')

# For each scoring type, apply regression coefficients (if present) to NFL adp
types = ['standard','half','full']
for t in types:
    coef_col = f'regression_coef_{t}'
    int_col = f'regression_intercept_{t}'
    proj_col = f'fantasy_{t}_ppr_proj_17g'
    # In the merged dataframe, projection columns came from 'final' with names matching proj_col
    if coef_col not in merged.columns or int_col not in merged.columns:
        print(f'Missing regression params for {t}; skipping')
        continue
    # Coerce params to numeric
    merged[coef_col] = pd.to_numeric(merged[coef_col], errors='coerce')
    merged[int_col] = pd.to_numeric(merged[int_col], errors='coerce')

    out_expected = f'expected_points_{t}_using_NFL'
    out_diff = f'value_diff_{t}_using_NFL'
    out_type = f'value_type_{t}_using_NFL'

    merged[out_expected] = merged[coef_col] * merged['NFL_adp_val'] + merged[int_col]

    # Use the projection value from the final stats
    merged[proj_col] = pd.to_numeric(merged.get(proj_col, pd.Series(dtype=float)), errors='coerce')
    merged[out_diff] = merged[proj_col] - merged[out_expected]
    merged[out_type] = merged[out_diff].apply(lambda x: 'undervalued' if pd.notna(x) and x > 0 else ('overvalued' if pd.notna(x) else '-'))

# Write output
merged.to_csv(OUT, index=False, na_rep='-')
print('Wrote', OUT)
