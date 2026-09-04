import json

from app.player_intel import (
    build_request,
    extract_sources,
    load_ranked_players,
    player_key,
    update_reports,
)


def _rankings(path):
    payload = {
        "columns": ["overall_rank", "player", "team", "pos"],
        "boards": {
            "12team_2qb_te_premium_half_ppr": [
                [1, "Player One", "BUF", "QB"],
                [2, "Player Two", "KC", "WR"],
            ]
        },
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_player_key_matches_browser_format():
    assert player_key(" Player One ", "buf") == "player one|BUF"


def test_load_ranked_players_uses_board_order(tmp_path):
    rankings = tmp_path / "rankings.json"
    _rankings(rankings)
    players = load_ranked_players(rankings)
    assert [player["player"] for player in players] == ["Player One", "Player Two"]
    assert players[0]["key"] == "player one|BUF"


def test_build_request_forces_web_search_and_structured_output():
    request = build_request(
        {"player": "Player One", "team": "BUF", "pos": "QB"},
        model="test-model",
        as_of="2026-09-04",
    )
    assert request["tools"] == [{"type": "web_search", "search_context_size": "medium"}]
    assert request["tool_choice"] == {"type": "web_search"}
    assert request["text"]["format"]["type"] == "json_schema"
    assert "Player One" in request["input"]


def test_extract_sources_deduplicates_annotations_and_search_sources():
    response = {
        "output": [
            {"type": "web_search_call", "action": {"sources": [
                {"title": "Team report", "url": "https://example.com/report"}
            ]}},
            {"type": "message", "content": [{"annotations": [
                {"type": "url_citation", "url": "https://example.com/report", "title": "Duplicate"},
                {"type": "url_citation", "url": "https://example.com/news", "title": "News"},
            ]}]},
        ]
    }
    assert extract_sources(response) == [
        {"title": "Team report", "url": "https://example.com/report"},
        {"title": "News", "url": "https://example.com/news"},
    ]


def test_update_reports_saves_each_generated_report(tmp_path):
    rankings = tmp_path / "rankings.json"
    destination = tmp_path / "intel.json"
    _rankings(rankings)

    def fake_research(player, **_):
        return {"player": player["player"], "updated_at": "2026-09-04", "sources": []}

    update_reports(
        rankings,
        destination,
        api_key="test-key",
        limit=1,
        research=fake_research,
        status=lambda _: None,
    )
    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert list(payload["reports"]) == ["player one|BUF"]
    assert payload["report_count"] == 1
