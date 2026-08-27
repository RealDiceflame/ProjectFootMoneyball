import pandas as pd
from pathlib import Path

COMBINED = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp_combined.csv")
FINAL = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\final_player_stats_with_fantasy_and_full_adp.csv")
OUT = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp_combined_with_yahoo.csv")

for p in (COMBINED, FINAL):
    if not p.exists():
        print('Required file not found:', p)
        raise SystemExit(1)

comb = pd.read_csv(COMBINED, dtype=str)
final = pd.read_csv(FINAL, dtype=str)

# Find Yahoo column in final (case-insensitive). Common column names: 'yahoo', 'yahoo_adp', 'Yahoo'
yahoo_col = None
for c in final.columns:
    low = c.strip().lower()
    # common yahoo column names: 'yahoo', 'yahoo_adp', 'y!', 'Y!'
    simple_alnum = ''.join(ch for ch in low if ch.isalnum())
    if 'yahoo' in low or 'yahoo' in simple_alnum or 'y!' in low or low == 'y' or simple_alnum == 'y':
        yahoo_col = c
        break
if yahoo_col is None:
    print('Yahoo ADP column not found in', FINAL)
    # show available ADP-like columns for debugging
    adp_like = [col for col in final.columns if any(tok in col.strip().lower() for tok in ('adp', 'nfl', 'cbs', 'espn', 'y!', 'yahoo', 'sleeper'))]
    print('ADP-like columns found:', adp_like)
    raise SystemExit(1)

# Merge to bring in projection columns
key_cols = ['player', 'pos']
for k in key_cols:
    if k not in comb.columns or k not in final.columns:
        print('Key column missing for merge:', k)
        raise SystemExit(1)

merged = comb.merge(final[['player','pos', 'fantasy_standard_ppr_proj_17g', 'fantasy_half_ppr_proj_17g', 'fantasy_full_ppr_proj_17g', yahoo_col]], on=['player','pos'], how='left', suffixes=('','_final'))

# Coerce Yahoo ADP to numeric
merged['Yahoo_adp_val'] = pd.to_numeric(merged[yahoo_col], errors='coerce')

# For each scoring type, apply regression coefficients (if present) to Yahoo adp
types = ['standard','half','full']
for t in types:
    coef_col = f'regression_coef_{t}'
    int_col = f'regression_intercept_{t}'
    proj_col = f'fantasy_{t}_ppr_proj_17g'
    if coef_col not in merged.columns or int_col not in merged.columns:
        print(f'Missing regression params for {t}; skipping')
        continue
    merged[coef_col] = pd.to_numeric(merged[coef_col], errors='coerce')
    merged[int_col] = pd.to_numeric(merged[int_col], errors='coerce')

    out_expected = f'expected_points_{t}_using_Yahoo'
    out_diff = f'value_diff_{t}_using_Yahoo'
    out_type = f'value_type_{t}_using_Yahoo'

    merged[out_expected] = merged[coef_col] * merged['Yahoo_adp_val'] + merged[int_col]

    merged[proj_col] = pd.to_numeric(merged.get(proj_col, pd.Series(dtype=float)), errors='coerce')
    merged[out_diff] = merged[proj_col] - merged[out_expected]
    merged[out_type] = merged[out_diff].apply(lambda x: 'undervalued' if pd.notna(x) and x > 0 else ('overvalued' if pd.notna(x) else '-'))

# Write output
merged.to_csv(OUT, index=False, na_rep='-')
print('Wrote', OUT)
