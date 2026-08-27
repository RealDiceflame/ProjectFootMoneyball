import pandas as pd
from pathlib import Path

IN = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\final_player_stats_with_fantasy_and_full_adp.csv")
OUT = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output\final_player_stats_with_fantasy_and_full_adp_adp_only.csv")

if not IN.exists():
    print('Input file not found:', IN)
    raise SystemExit(1)

# Read as string to preserve '-' markers
df = pd.read_csv(IN, dtype=str)

# Normalize ADP column name (in case of surrounding spaces)
adp_col = None
for c in df.columns:
    if c.strip().lower() == 'adp':
        adp_col = c
        break

if adp_col is None:
    print('No ADP column found in', IN)
    raise SystemExit(1)

# Treat '-' or empty/whitespace as missing
df[adp_col] = df[adp_col].astype(str).replace(r'^\s*$', pd.NA, regex=True)
# Also replace literal '-' with NA
df[adp_col] = df[adp_col].replace({'-': pd.NA})

# Drop rows with missing ADP
before = len(df)
filtered = df.dropna(subset=[adp_col])
after = len(filtered)

print(f'Dropped {before-after} rows without ADP (kept {after} rows).')

# Write filtered file
filtered.to_csv(OUT, index=False, na_rep='-')
print('Wrote', OUT)
