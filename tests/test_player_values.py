"""Network-free contracts for full-archive value inputs, never leader subsets."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json

import pytest

from app.game_stats import encoded
from app.player_values import STAT_COLUMNS, build_player_value_inputs, export_player_value_inputs

NOW = datetime(2026, 9, 28, 9, tzinfo=timezone.utc)
GAME = {"game_id": "2026_03_BUF_BAL", "week": 3, "home": "BAL", "away": "BUF",
        "gameday": "2026-09-27", "kickoff": "2026-09-27T17:00:00Z", "home_score": 0, "away_score": 21}
COLUMNS = ["player_id", "player_display_name", "position", "team", "opponent_team",
           "game_id", "season", "season_type", "week", *STAT_COLUMNS, "fumbles_total"]


def player(game, identity="00-0000001", name="New Breakout", pos="WR", team="BUF", **stats):
    return {"player_id": identity, "player_display_name": name, "position": pos, "team": team,
            "opponent_team": game["home"] if team == game["away"] else game["away"],
            "game_id": game["game_id"], "season": 2026, "season_type": "REG", "week": game["week"],
            **dict.fromkeys(STAT_COLUMNS, 0), "fumbles_total": 3, **stats}


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded(value))


def setup_archive(tmp_path, *, games=None, archived=None, records=None, missing_columns=()):
    games = deepcopy(games or [GAME])
    archived = set(archived if archived is not None else [game["game_id"] for game in games])
    folder = tmp_path / "docs/data/game_stats/2026"
    entries = {}
    for game in games:
        if game["game_id"] not in archived:
            continue
        rows = records if records is not None else [player(game, targets=11, receptions=8, receiving_yards=122),
                                                    player(game, identity="00-0000002", team="BAL", pos="QB")]
        columns = [key for key in COLUMNS if key not in missing_columns]
        bundle = {"schema_version": 1, "season": 2026, "game": game,
                  "team_columns": ["game_id", "team"], "teams": [[game["game_id"], team] for team in (game["home"], game["away"])],
                  "player_columns": columns, "players": [[row.get(key) for key in columns] for row in rows]}
        bundle.update(content_sha256=hashlib.sha256(encoded(bundle)).hexdigest(),
                      first_collected_at="2026-09-27T22:00:00Z", updated_at="2026-09-28T01:00:00Z")
        save_json(folder / f"{game['game_id']}.json", bundle)
        entries[game["game_id"]] = {key: game[key] for key in ("week", "home", "away")}
        entries[game["game_id"]].update(player_rows=len(rows), updated_at=bundle["updated_at"])
    save_json(folder / "index.json", {"schema_version": 1, "season": 2026,
              "checked_at": "2026-09-28T02:00:00Z", "games": entries, "sources": {"players": {"sha256": "release-hash", "http_last_modified": "original-date"}}})
    save_json(tmp_path / "docs/data/scores.json", {"season": 2026, "checked_at": "2026-09-28T08:00:00Z",
                                                "score_type": "reported", "games": games})
    return folder


def observations(payload):
    return [dict(zip(payload["columns"], row)) for row in payload["rows"]]


def test_exports_full_observations_by_gsis_without_rankings_or_leader_files(tmp_path):
    rows = [player(GAME, identity=f"00-{index:07d}", name="Same Display Name", targets=index)
            for index in range(1, 14)]
    rows += [player(GAME, identity="00-0000020", team="BAL", pos="FB", rushing_yards=-3, fumbles_lost_total=1)]
    setup_archive(tmp_path, records=rows)
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    observed = observations(payload)
    assert len(observed) == payload["coverage"]["player_count"] == 14
    assert len({row["player_id"] for row in observed}) == 14
    assert observed[12]["targets"] == 13  # Not limited to top-ten league leaders.
    assert observed[-1]["pos"] == "RB" and observed[-1]["rushing_yards"] == -3
    assert observed[-1]["fumbles_lost_total"] == 1 and "fumbles_total" not in observed[-1]
    assert observed[0]["analysis_ready"] is True and observed[0]["provisional"] is True
    assert payload["games"][0]["completion_basis"] == "elapsed_8h_and_archived"


def test_missing_statistics_and_absent_player_games_are_never_filled_with_zero(tmp_path):
    missing_player = player(GAME, targets=None, receptions=None)
    setup_archive(tmp_path, records=[missing_player, player(GAME, identity="00-0000002", team="BAL")],
                  missing_columns=("fumbles_lost_total", "passing_2pt_conversions"))
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    row = observations(payload)[0]
    assert row["targets"] is None and row["receptions"] is None
    assert row["fumbles_lost_total"] is None and row["passing_2pt_conversions"] is None
    assert row["passing_yards"] == 0  # An actual source zero survives.
    assert payload["coverage"]["missing_stat_counts"]["targets"] == 1
    assert payload["coverage"]["missing_stat_counts"]["fumbles_lost_total"] == 2
    assert "No row" in payload["semantics"]["observations"]
    assert len(payload["rows"]) == 2


def test_schedule_coverage_keeps_pending_unknown_and_future_games_separate(tmp_path):
    pending = {**GAME, "game_id": "2026_03_LA_DEN", "home": "DEN", "away": "LA"}
    unknown = {**GAME, "game_id": "2026_03_MIA_NYJ", "home": "NYJ", "away": "MIA", "home_score": None, "away_score": None}
    future = {**GAME, "game_id": "2026_04_BAL_BUF", "week": 4, "home": "BUF", "away": "BAL",
              "gameday": "2026-10-04", "kickoff": "2026-10-04T17:00:00Z", "home_score": None, "away_score": None}
    setup_archive(tmp_path, games=[GAME, pending, unknown, future], archived=[GAME["game_id"]])
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    coverage = payload["coverage"]
    assert coverage["scheduled_games"] == 4 and coverage["completed_games"] == 2
    assert coverage["archived_games"] == coverage["analysis_ready_games"] == 1
    assert coverage["pending_stats_game_ids"] == [pending["game_id"]]
    assert coverage["completion_unknown_game_ids"] == [unknown["game_id"]]
    assert coverage["teams"]["BUF"]["remaining_game_ids"] == [future["game_id"]]
    assert len(payload["rows"]) == 2  # No synthetic observation for later team games.
    assert {game["game_id"]: game["status"] for game in payload["games"]}[unknown["game_id"]] == "started"


@pytest.mark.parametrize("hours,ready", [(7.999, False), (8, True), (8.001, True)])
def test_analysis_ready_eight_hour_boundary_is_not_a_certified_final(tmp_path, hours, ready):
    kickoff = NOW - timedelta(hours=hours)
    game = {**GAME, "gameday": kickoff.date().isoformat(), "kickoff": kickoff.isoformat()}
    setup_archive(tmp_path, games=[game])
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    assert payload["games"][0]["analysis_ready"] is ready
    assert observations(payload)[0]["analysis_ready"] is ready
    assert payload["games"][0]["provisional"] is True


@pytest.mark.parametrize("changes,ready,provisional", [
    ({"status": "final"}, True, False),
    ({"status": "live"}, False, True),
    ({"completed": False}, False, True),
    ({"home_score": None}, False, True),
])
def test_explicit_status_and_incomplete_score_pair_are_respected(tmp_path, changes, ready, provisional):
    setup_archive(tmp_path, games=[{**GAME, **changes}])
    game = build_player_value_inputs(tmp_path, 2026, now=NOW)["games"][0]
    assert game["analysis_ready"] is ready and game["provisional"] is provisional


def test_explicit_final_does_not_require_eight_hour_delay(tmp_path):
    game = {**GAME, "status": "final", "kickoff": (NOW - timedelta(hours=4)).isoformat(), "gameday": NOW.date().isoformat()}
    setup_archive(tmp_path, games=[game])
    assert build_player_value_inputs(tmp_path, 2026, now=NOW)["games"][0]["analysis_ready"] is True


def test_team_change_preserves_one_id_with_two_observed_teams(tmp_path):
    earlier = {**GAME, "game_id": "2026_02_BAL_BUF", "week": 2, "home": "BUF", "away": "BAL", "gameday": "2026-09-20", "kickoff": "2026-09-20T17:00:00Z"}
    folder = setup_archive(tmp_path, games=[earlier, GAME])
    bundle = json.loads((folder / f"{earlier['game_id']}.json").read_text())
    player_index = bundle["player_columns"].index("player_id")
    for row in bundle["players"]:
        row[player_index] = "00-0000002" if row[player_index] == "00-0000001" else "00-0000001"
    bundle.pop("content_sha256")
    save_json(folder / f"{earlier['game_id']}.json", bundle)
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    assert payload["coverage"]["player_count"] == 2
    assert {row["team"] for row in observations(payload) if row["player_id"] == "00-0000001"} == {"BAL", "BUF"}


@pytest.mark.parametrize("fault,message", [
    ("duplicate", "Duplicate archived player"), ("truncated", "Truncated"),
    ("checksum", "checksum"), ("wrong_week", "season/week/opponent"),
    ("wrong_team", "game/team"), ("missing_file", "Invalid saved game"),
    ("non_numeric", "Invalid archived statistic"), ("boolean", "Invalid archived statistic"),
    ("non_finite", "Invalid archived statistic"), ("bad_id", "GSIS"),
])
def test_invalid_archive_never_replaces_last_good_export(tmp_path, fault, message):
    folder = setup_archive(tmp_path)
    export_player_value_inputs(tmp_path, 2026, now=NOW)
    target = tmp_path / "docs/data/player_value_inputs.json"
    previous = target.read_bytes()
    path = folder / f"{GAME['game_id']}.json"
    bundle = json.loads(path.read_text())
    if fault == "missing_file":
        path.unlink()
    else:
        if fault != "checksum":
            bundle.pop("content_sha256")
        if fault == "duplicate":
            bundle["players"].append(deepcopy(bundle["players"][0]))
            index = json.loads((folder / "index.json").read_text())
            index["games"][GAME["game_id"]]["player_rows"] += 1
            save_json(folder / "index.json", index)
        elif fault == "truncated":
            bundle["players"][0].pop()
        else:
            key, value = {"checksum": ("targets", 99), "wrong_week": ("week", 4),
                          "wrong_team": ("team", "MIA"), "non_numeric": ("targets", "9"),
                          "boolean": ("targets", True), "non_finite": ("targets", float("nan")),
                          "bad_id": ("player_id", "name:player")}[fault]
            bundle["players"][0][bundle["player_columns"].index(key)] = value
        path.write_text(json.dumps(bundle))  # NaN intentionally tests rejected input.
    with pytest.raises(ValueError, match=message):
        export_player_value_inputs(tmp_path, 2026, now=NOW)
    assert target.read_bytes() == previous


def test_export_is_offline_and_does_not_modify_any_archive_or_redate_sources(tmp_path, monkeypatch):
    folder = setup_archive(tmp_path)
    original = {path: path.read_bytes() for path in folder.iterdir()}
    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: pytest.fail("Network is forbidden"))
    payload = export_player_value_inputs(tmp_path, 2026, now=NOW)
    assert all(path.read_bytes() == data for path, data in original.items())
    assert payload["generated_at"] == NOW.isoformat()
    assert payload["sources"]["archive"]["checked_at"] == "2026-09-28T02:00:00Z"
    assert payload["games"][0]["source_updated_at"] == "2026-09-28T01:00:00Z"
    assert payload["sources"]["archive"]["sources"]["players"]["http_last_modified"] == "original-date"
    assert json.loads((tmp_path / "docs/data/player_value_inputs.json").read_text()) == payload


def test_anonymous_and_non_offensive_rows_are_not_named_player_observations(tmp_path):
    rows = [player(GAME), player(GAME, identity=None, name="Team", team="BAL"),
            player(GAME, identity="00-0000003", pos="CB", team="BAL")]
    setup_archive(tmp_path, records=rows)
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    assert len(payload["rows"]) == 1
    assert payload["coverage"]["skipped_rows"] == {"non_offensive": 1, "unnamed_or_anonymous": 1}


def test_empty_archive_keeps_coverage_without_inventing_players(tmp_path):
    setup_archive(tmp_path, archived=[])
    payload = build_player_value_inputs(tmp_path, 2026, now=NOW)
    assert payload["rows"] == [] and payload["coverage"]["player_count"] == 0
    assert payload["coverage"]["pending_stats_game_ids"] == [GAME["game_id"]]


def test_score_season_mismatch_and_rescheduled_archive_are_rejected(tmp_path):
    setup_archive(tmp_path)
    path = tmp_path / "docs/data/scores.json"
    original = json.loads(path.read_text())
    save_json(path, {**original, "season": 2025})
    with pytest.raises(ValueError, match="matching saved score"):
        build_player_value_inputs(tmp_path, 2026, now=NOW)
    original["games"][0]["kickoff"] = "2026-09-27T18:00:00Z"
    save_json(path, original)
    with pytest.raises(ValueError, match="schedule identity changed"):
        build_player_value_inputs(tmp_path, 2026, now=NOW)
