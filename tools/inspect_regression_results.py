import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score

CSV = r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\fantasy_value_vs_adp.csv"
OUT = r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\regression_summary.txt"

df = pd.read_csv(CSV)
# Ensure numeric
for col in ['ADP','fantasy_half_ppr_proj_17g']:
    if col in df.columns:
        df[col] = pd.to_numeric(df[col], errors='coerce')

positions = df['pos'].dropna().unique().tolist()
positions.sort()

lines = []
lines.append('Per-position linear regression (ADP -> fantasy_half_ppr_proj_17g)')
lines.append('pos,n_samples,slope,intercept,R2')

for pos in positions:
    sub = df[df['pos']==pos].dropna(subset=['ADP','fantasy_half_ppr_proj_17g'])
    n = len(sub)
    if n < 5:
        lines.append(f"{pos},{n},<insufficient data>,<insufficient data>,<insufficient data>")
        continue
    X = sub[['ADP']].values.reshape(-1,1)
    y = sub['fantasy_half_ppr_proj_17g'].values
    model = LinearRegression().fit(X,y)
    ypred = model.predict(X)
    r2 = r2_score(y, ypred)
    slope = float(model.coef_[0])
    intercept = float(model.intercept_)
    lines.append(f"{pos},{n},{slope:.6f},{intercept:.4f},{r2:.4f}")

# Top undervalued (largest positive value_diff)
if 'value_diff' in df.columns:
    df['value_diff'] = pd.to_numeric(df['value_diff'], errors='coerce')
    undervalued = df[df['value_type']=='undervalued'].sort_values('value_diff', ascending=False).head(10)
    overvalued = df[df['value_type']=='overvalued'].sort_values('value_diff').head(10)

    lines.append('\nTop 10 undervalued players (by value_diff)')
    lines.append('player,pos,ADP,expected_points,value_diff')
    for _,r in undervalued.iterrows():
        lines.append(f"{r['player']},{r['pos']},{r.get('ADP','')},{r.get('expected_points','')},{r.get('value_diff','')}")

    lines.append('\nTop 10 overvalued players (by value_diff)')
    lines.append('player,pos,ADP,expected_points,value_diff')
    for _,r in overvalued.iterrows():
        lines.append(f"{r['player']},{r['pos']},{r.get('ADP','')},{r.get('expected_points','')},{r.get('value_diff','')}")

# Save and print
with open(OUT,'w',encoding='utf-8') as f:
    f.write('\n'.join(lines))

print('\n'.join(lines))
print('\nWrote summary to:', OUT)
