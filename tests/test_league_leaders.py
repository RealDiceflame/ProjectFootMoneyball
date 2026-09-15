import json
from pathlib import Path
import pytest
from app.league_leaders import build_stats_summary, rebuild_saved_summary


def make_summary(rows1, rows2=()):
    schedule = {
        "2026_01_BUF_BAL": {"game_id": "2026_01_BUF_BAL", "week": 1, "home": "BAL", "away": "BUF"},
        "2026_02_BUF_KC": {"game_id": "2026_02_BUF_KC", "week": 2, "home": "KC", "away": "BUF"},
    }
    games = {"2026_01_BUF_BAL": rows1, "2026_02_BUF_KC": rows2}
    return build_stats_summary(2026, schedule, games, schedule, "2026-09-22T12:00:00Z")


def player(identity, name="Same Name", team="BUF", **stats):
    return {"player_id": identity, "player_display_name": name, "team": team, "position": "QB", **stats}


def test_unique_ids_trades_and_week_totals_do_not_double_count():
    summary = make_summary(
        [player("a", passing_yards=200), player("b", passing_yards=150), player(None, passing_yards=900)],
        [player("a", team="KC", passing_yards=250)],
    )
    total = summary["periods"]["all"]["leaders"]["passing_yards"]
    assert [(row["player_id"], row["value"]) for row in total] == [("a", 450), ("b", 150)]
    assert total[0]["teams"] == ["BUF", "KC"]
    assert summary["periods"]["1"]["leaders"]["passing_yards"][0]["value"] == 200
    assert summary["periods"]["2"]["leaders"]["passing_yards"][0]["value"] == 250
    with pytest.raises(ValueError, match="Duplicate"):
        make_summary([player("a"), player("a")])


def test_fractional_sacks_negative_yards_maxima_and_rates():
    summary = make_summary(
        [player("a", def_sacks=0.5, rushing_yards=-2, fg_long=55, fg_pct=1, passing_cpoe=15)],
        [player("a", def_sacks=1.5, rushing_yards=1, fg_long=42, fg_pct=0.5, passing_cpoe=7)],
    )
    leaders = summary["periods"]["all"]["leaders"]
    assert leaders["def_sacks"][0]["value"] == 2
    assert leaders["rushing_yards"][0]["value"] == -1
    assert leaders["fg_long"][0]["value"] == 55
    assert "fg_pct" not in leaders and "passing_cpoe" not in leaders


def test_top_ten_ties_and_missing_values_are_not_padded():
    rows = [player(str(i), name=f"Player {i:02}", rushing_tds=2) for i in range(12)]
    rows += [player("zero", rushing_tds=0), player("missing", rushing_tds=None)]
    summary = make_summary(rows)
    leaders = summary["periods"]["all"]["leaders"]["rushing_tds"]
    assert len(leaders) == 10 and {row["rank"] for row in leaders} == {1}
    assert [row["player_id"] for row in leaders] == list(map(str, range(10)))
    assert summary["periods"]["2"]["leaders"]["rushing_tds"] == []


def test_saved_archive_totals_match_player_rows_without_redating(tmp_path):
    root = Path(__file__).resolve().parents[1]
    folder = root / "docs/data/game_stats/2026"
    index = json.loads((folder / "index.json").read_text())
    summary = json.loads((folder / "summary.json").read_text())
    sums = {}
    for game_id in index["games"]:
        bundle = json.loads((folder / f"{game_id}.json").read_text())
        for values in bundle["players"]:
            row = dict(zip(bundle["player_columns"], values))
            if row["player_id"]:
                sums[row["player_id"]] = sums.get(row["player_id"], 0) + (row["passing_yards"] or 0)
    leaders = summary["periods"]["all"]["leaders"]["passing_yards"]
    assert [row["value"] for row in leaders] == sorted(sums.values(), reverse=True)[:10]
    assert summary["periods"]["all"]["game_count"] == len(index["games"])
    assert summary["checked_at"] == index["checked_at"]
    assert all(row["value"] == sums[row["player_id"]] for row in leaders)

