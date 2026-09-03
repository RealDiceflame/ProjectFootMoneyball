import pandas as pd
from app.draft_board_service import DraftedPlayerStore, LeagueSettings, filter_rankings, load_rankings, prepare_rankings


def test_league_settings_select_correct_ranking_files():
    assert LeagueSettings().ranking_slug() == "12team_2qb_te_premium_half_ppr"
    assert LeagueSettings(10, "1QB", "Standard", "Off").ranking_slug() == "10team_1qb_standard"
    assert LeagueSettings(14, "2QB", "Full PPR", "+0.5").ranking_slug() == "14team_2qb_te_premium_full_ppr"


def test_load_rankings_adds_draft_tags(tmp_path):
    settings = LeagueSettings(8, "1QB", "Standard", "Off")
    pd.DataFrame({"value_vs_adp": [30, 12, 0, -15]}).to_csv(settings.ranking_path(tmp_path), index=False)
    result = load_rankings(tmp_path, settings)
    assert result["draft_tag"].tolist() == ["TARGET", "VALUE", "FAIR", "REACH"]


def test_drafted_players_persist_and_toggle(tmp_path):
    path = tmp_path / "drafted.json"
    store = DraftedPlayerStore(path)
    assert store.toggle("Josh Allen", "BUF") is True
    assert DraftedPlayerStore(path).contains("Josh Allen", "BUF")
    assert store.toggle("Josh Allen", "BUF") is False
    assert not DraftedPlayerStore(path).contains("Josh Allen", "BUF")


def test_column_filter_is_case_insensitive_and_literal():
    rankings = pd.DataFrame({"player": ["Josh Allen", "Saquon Barkley"], "pos": ["QB", "RB"]})
    assert filter_rankings(rankings, "pos", "qb")["player"].tolist() == ["Josh Allen"]
    assert filter_rankings(rankings, "player", "[invalid regex").empty


def test_numeric_range_and_comparison_filters():
    rankings = pd.DataFrame({"adp": [5, 15, 25, 35]})
    assert filter_rankings(rankings, "adp", ">=25")["adp"].tolist() == [25, 35]
    assert filter_rankings(rankings, "adp", "10..30")["adp"].tolist() == [15, 25]
    assert filter_rankings(rankings, "adp", "25")["adp"].tolist() == [25]


def test_categorical_filters_support_multiple_exact_values():
    rankings = pd.DataFrame({
        "player": ["Player A", "Player B", "Player C"],
        "pos": ["QB", "RB", "WR"],
    })
    result = filter_rankings(rankings, "pos", "QB, WR")
    assert result["player"].tolist() == ["Player A", "Player C"]


def test_invalid_drafted_filter_does_not_hide_players():
    rankings = pd.DataFrame({"drafted": [True, False]})
    assert len(filter_rankings(rankings, "drafted", "maybe")) == 2
    assert len(filter_rankings(rankings, "drafted", ",")) == 2


def test_prepare_rankings_filters_and_sorts_drafted_players(tmp_path):
    store = DraftedPlayerStore(tmp_path / "drafted.json")
    store.toggle("Player B", "BUF")
    rankings = pd.DataFrame({
        "overall_rank": [1, 2], "player": ["Player A", "Player B"],
        "team": ["KC", "BUF"], "value_vs_adp": [1, 2],
    })
    result = prepare_rankings(rankings, store, filter_column="drafted", query="yes",
                              sort_column="overall_rank", ascending=True)
    assert result["player"].tolist() == ["Player B"]


def test_prepare_rankings_sorts_provider_numbers_and_places_missing_last(tmp_path):
    store = DraftedPlayerStore(tmp_path / "drafted.json")
    rankings = pd.DataFrame({
        "overall_rank": [1, 2, 3],
        "player": ["Player A", "Player B", "Player C"],
        "team": ["KC", "BUF", "NYJ"],
        "Yahoo": ["100", "20", "-"],
    })
    result = prepare_rankings(
        rankings, store, filter_column="player", query="",
        sort_column="Yahoo", ascending=True,
    )
    assert result["player"].tolist() == ["Player B", "Player A", "Player C"]
