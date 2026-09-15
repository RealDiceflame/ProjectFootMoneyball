from copy import deepcopy
import json
from pathlib import Path
import pytest
from app.stats_database import connection_options
from app.stats_import import import_plan, load_saved_stats, prepare_snapshot

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def game():
    return json.loads((ROOT / "docs/data/game_stats/2026/2026_01_NE_SEA.json").read_text(encoding="utf-8"))


def test_real_archive_plan_keeps_every_row_and_identity():
    snapshots = load_saved_stats(ROOT)
    plan = import_plan(snapshots)
    assert plan["games"] >= 16
    assert plan["player_season_rows"] >= 5050
    assert plan["players"] >= 2063
    assert sum(row["player_id"] is None for snap in snapshots for row in snap.player_games) >= 1
    history = next(s for s in snapshots if s.dataset == "player_history")
    assert len([p for p in history.players if p["name"] == "Josh Johnson"]) == 2


def test_stable_content_hash_ignores_refresh_clock_but_detects_corrections(game):
    original = prepare_snapshot(game, "game.json")
    changed = deepcopy(game)
    changed["updated_at"] = "2026-09-16T12:00:00Z"
    changed["sources"]["players"]["retrieved_at"] = "2026-09-16T12:00:00Z"
    same = prepare_snapshot(changed, "game.json")
    assert same.content_hash == original.content_hash
    assert same.file_hash != original.file_hash
    index = changed["player_columns"].index("rushing_yards")
    changed["players"][0][index] = -2
    assert prepare_snapshot(changed, "game.json").content_hash != original.content_hash


def test_invalid_rows_fail_before_a_connection_is_needed(game):
    game["players"][0].pop()
    with pytest.raises(ValueError, match="Incomplete"):
        prepare_snapshot(game, "game.json")


def test_duplicate_ids_wrong_teams_and_nonfinite_stats_are_rejected(game):
    bad = deepcopy(game);bad["players"].append(bad["players"][0])
    with pytest.raises(ValueError, match="Duplicate"):
        prepare_snapshot(bad, "game.json")
    bad = deepcopy(game);bad["players"][0][bad["player_columns"].index("team")] = "BUF"
    with pytest.raises(ValueError, match="team mismatch"):
        prepare_snapshot(bad, "game.json")
    bad = deepcopy(game);bad["players"][0][bad["player_columns"].index("passing_yards")] = float("nan")
    with pytest.raises(ValueError, match="Invalid statistic"):
        prepare_snapshot(bad, "game.json")


def test_plain_null_zero_negative_and_fractional_stats_survive(game):
    row = game["players"][0]
    for key,value in [("rushing_yards",-2),("def_sacks",0.5),("passing_yards",None),("receiving_yards",0),("fg_made_list","27;44")]:
        row[game["player_columns"].index(key)] = value
    stats = prepare_snapshot(game, "game.json").player_games[0]["stats"]
    assert {key:stats[key] for key in ["rushing_yards","def_sacks","passing_yards","receiving_yards","fg_made_list"]} == {
        "rushing_yards":-2,"def_sacks":0.5,"passing_yards":None,"receiving_yards":0,"fg_made_list":"27;44"}


def test_remote_connections_require_tls_and_errors_do_not_echo_passwords():
    assert connection_options("postgresql://u:secret@db.example.com/postgres")["sslmode"] == "require"
    assert connection_options("postgresql://u:secret@db.example.com/postgres?sslmode=verify-full")["sslmode"] == "verify-full"
    assert connection_options("postgresql://u:test@127.0.0.1/outlier_test")["sslmode"] == "disable"
    for url in ["password-secret", "", "postgresql://u:secret@db.example.com/postgres?sslmode=disable",
                "postgresql://u:secret@localhost/postgres?host=remote.example.com"]:
        with pytest.raises(ValueError) as error:
            connection_options(url)
        assert "secret" not in str(error.value)
