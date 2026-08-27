import pandas as pd
from pathlib import Path

OUT_DIR = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output")

csvs = list(OUT_DIR.glob('*.csv'))
import pandas as pd
from pathlib import Path

OUT_DIR = Path(r"c:\Users\djr11\OneDrive\Desktop\Coding Projects\ProjectFootMoneyball\output")

csvs = list(OUT_DIR.glob('*.csv'))
if not csvs:
    print('No CSVs found in', OUT_DIR)
    raise SystemExit(1)

for p in csvs:
    print('Processing', p.name)
    # Read everything as string to avoid dtype coercion
    df = pd.read_csv(p, dtype=str)

    # Replace NaN with '-' and any whitespace-only strings with '-'
    df = df.fillna('-')
    # Replace empty or whitespace-only cells (regex) with '-'
    df = df.replace(r'^\s*$', '-', regex=True)

    # Save back to same file, ensure any remaining NaNs are written as '-'
    df.to_csv(p, index=False, na_rep='-')
    print('Wrote', p.name)

print('Done')
