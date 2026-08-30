import pandas as pd
from pathlib import Path

IN = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp.csv")
OUT = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp_combined.csv")

if not IN.exists():
    print('Input file not found:', IN)
    raise SystemExit(1)

df = pd.read_csv(IN, dtype=str)
if 'scoring_type' not in df.columns:
    print('scoring_type column not found in input; run regression to generate it first.')
    raise SystemExit(1)

# Columns to pivot per scoring type
pivot_cols = ['expected_points', 'value_diff', 'value_type', 'regression_coef', 'regression_intercept', 'regression_r2']

# Keep identifying columns (take the first occurrence per player)
id_cols = [c for c in ['player','pos','team','ADP'] if c in df.columns]

# Pivot: create a wide-frame where each pivot_col becomes col_scoringtype
rows = []
for player, g in df.groupby('player'):
    base = {}
    # take first row for id columns
    first = g.iloc[0]
    for c in id_cols:
        base[c] = first.get(c, '')
    # for each scoring type, pull pivot columns
    for scoring in g['scoring_type'].unique():
        grp = g[g['scoring_type'] == scoring].iloc[0]
        suf = f"_{scoring}"
        for pc in pivot_cols:
            val = grp.get(pc, '')
            # prefix column
            base[f"{pc}{suf}"] = val
    rows.append(base)

out = pd.DataFrame(rows)
# Attempt to coerce numeric columns back to numeric where appropriate
for col in out.columns:
    if out[col].dtype == object:
        # try numeric coercion for expected/value/regression numeric cols
        if any(col.startswith(prefix) for prefix in ['expected_points','value_diff','regression_coef','regression_intercept','regression_r2']):
            out[col] = pd.to_numeric(out[col], errors='coerce')

out.to_csv(OUT, index=False, na_rep='-')
print('Wrote', OUT)
