import pandas as pd

from data_fetcher.adp_importer import build_combined_adp


def test_build_combined_adp_keeps_platform_values(tmp_path):
    source = tmp_path / "adp.html"
    output = tmp_path / "adp.csv"
    pd.DataFrame(
        {
            "Player": ["Example PlayerBUF"],
            "Pos": ["RB"],
            "Yahoo 1QB Half-PPRSame market": [12.0],
            "Sleeper Half-PPRPrimary market": [10.0],
            "ESPN 1QB PPRQueue reference": [14.0],
        }
    ).to_html(source, index=False)

    result = build_combined_adp(source, output)

    assert result.loc[0, "Player"] == "Example Player"
    assert result.loc[0, "Team"] == "BUF"
    assert result.loc[0, "ADP"] == 12.0
