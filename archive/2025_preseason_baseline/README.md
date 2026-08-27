# 🏈 Fantasy Football Stat Scraper & Value Analyzer

This project scrapes and merges NFL player statistics (passing, rushing, receiving) and average draft position (ADP) data to build a full-season fantasy point projection system. It uses linear regression to determine whether a player is **overvalued or undervalued** at their draft position.

---

## 📦 Features

- ✅ Scrapes data from [Pro Football Reference](https://www.pro-football-reference.com/)
- ✅ Merges passing, rushing, and receiving stats
- ✅ Calculates fantasy points (Standard, Half-PPR, Full-PPR)
- ✅ Cleans and merges external ADP (e.g. from 4for4)
- ✅ Performs regression analysis to compare expected value vs ADP
- ✅ Outputs merged and cleaned CSVs at each stage

---

## 🧰 Requirements

Install dependencies:

```bash
pip install pandas numpy scikit-learn selenium
```

If you're downloading ADP using Selenium:

- Install Chrome
- Download [ChromeDriver](https://sites.google.com/a/chromium.org/chromedriver/) and add to your PATH

---

## 🚀 How to Run

```bash
python main.py
```

This will:

1. Scrape stats from Pro Football Reference
2. Merge and clean player data
3. Calculate fantasy points for all scoring formats
4. Merge with ADP from 4for4
5. Output:
   - `output/all_stats_merged.csv`
   - `output/final_player_stats_with_fantasy.csv`
   - `output/final_player_stats_with_fantasy_and_full_adp.csv`
   - `output/fantasy_value_vs_adp.csv`

---

## 📂 Project Structure

```
project_root/
├── main.py                         # Entry point
├── output/                         # Contains all generated CSVs
├── stat_utils/
│   ├── stat_helpers.py            # Merging + unifying stat logic
│   ├── dataframe_helpers.py       # Column formatting, null handling
│   ├── final_stat_builder.py      # Builds final stats from all sources
│   ├── fantasy_points.py          # Fantasy scoring logic
│   ├── merge_adp.py               # ADP merging + name normalization
│   ├── regression_analysis.py     # Regression vs ADP logic
├── data_fetcher/                  
│   └── data_fetcher.py            # Universal HTML/CSV fetcher
├── adp_downloader.py              # Optional Selenium-based ADP scraper
```

---

## 🧪 Optional: Use a Local ADP File

If you prefer not to use Selenium:
- Manually download the CSV from [4for4 ADP](https://www.4for4.com/adp)
- Save it as: `output/4for4-adp-table7-28.csv`

---

## 🛠️ To-Do / Improvements

- [ ] Add unit tests
- [ ] Create CLI options (e.g. `--skip-adp`, `--only-scrape`)
- [ ] Build a `streamlit` dashboard to visualize regression vs ADP
- [ ] Support custom scoring formats

---

## 📈 Sample Output

<table>
<tr><th>Player</th><th>ADP</th><th>Projected FP (Half-PPR)</th><th>Expected FP</th><th>Value Type</th></tr>
<tr><td>Amon-Ra St. Brown</td><td>15.3</td><td>268.7</td><td>243.2</td><td>Undervalued ✅</td></tr>
<tr><td>DK Metcalf</td><td>35.1</td><td>203.1</td><td>220.5</td><td>Overvalued ❌</td></tr>
</table>

---

## 🙌 Acknowledgments

- [Pro Football Reference](https://www.pro-football-reference.com/) for stat data
- [4for4.com](https://www.4for4.com/adp) for ADP tables
