import pandas as pd

from data_fetcher.rookie_prop_projections import build_rookie_prop_projections


def _stats_fixture():
    return pd.DataFrame(
        [
            {
                "position": "QB", "completions": 300, "attempts": 450,
                "passing_yards": 3000, "passing_interceptions": 10,
                "carries": 50, "rushing_yards": 300, "rushing_tds": 3,
                "receptions": 0, "receiving_yards": 0, "receiving_tds": 0,
            },
            {
                "position": "RB", "completions": 0, "attempts": 0,
                "passing_yards": 0, "passing_interceptions": 0,
                "carries": 200, "rushing_yards": 800, "rushing_tds": 8,
                "receptions": 40, "receiving_yards": 320, "receiving_tds": 2,
            },
            {
                "position": "WR", "completions": 0, "attempts": 0,
                "passing_yards": 0, "passing_interceptions": 0,
                "carries": 0, "rushing_yards": 0, "rushing_tds": 0,
                "receptions": 60, "receiving_yards": 900, "receiving_tds": 6,
            },
            {
                "position": "TE", "completions": 0, "attempts": 0,
                "passing_yards": 0, "passing_interceptions": 0,
                "carries": 0, "rushing_yards": 0, "rushing_tds": 0,
                "receptions": 50, "receiving_yards": 500, "receiving_tds": 5,
            },
        ]
    )


def test_market_lines_are_preserved_and_missing_stats_are_derived(tmp_path):
    lines = pd.DataFrame(
        [
            {
                "Player": "Rookie Runner", "Pos": "RB", "Team": "ARI",
                "Market": "rushing_yards", "Line": 775.5,
                "Snapshot_Date": "2026-08-29", "Sportsbook": "Test Book",
            },
            {
                "Player": "Rookie Runner", "Pos": "RB", "Team": "ARI",
                "Market": "rushing_touchdowns", "Line": 5.5,
                "Snapshot_Date": "2026-08-29", "Sportsbook": "Test Book",
            },
            {
                "Player": "Rookie Receiver", "Pos": "WR", "Team": "TEN",
                "Market": "receiving_yards", "Line": 650.5,
                "Snapshot_Date": "2026-08-29", "Sportsbook": "Test Book",
            },
        ]
    )
    lines_path = tmp_path / "lines.csv"
    stats_path = tmp_path / "stats.csv"
    output_path = tmp_path / "rookies.csv"
    lines.to_csv(lines_path, index=False)
    _stats_fixture().to_csv(stats_path, index=False)

    result = build_rookie_prop_projections(lines_path, stats_path, output_path)

    runner = result[result["Player"] == "Rookie Runner"].iloc[0]
    receiver = result[result["Player"] == "Rookie Receiver"].iloc[0]
    assert runner["Rush Yds"] == 775.5
    assert runner["Rush TDs"] == 5.5
    assert runner["Rec Yds"] > 0
    assert receiver["Rec Yds"] == 650.5
    assert receiver["Recs"] > 0
    assert receiver["Rec TDs"] > 0
    assert (result["Games"] == 17).all()
    assert output_path.exists()
