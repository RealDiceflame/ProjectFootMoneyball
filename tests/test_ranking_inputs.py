from copy import deepcopy
from datetime import datetime, timezone
import hashlib

import pytest

from app.game_stats import encoded
from app.player_values import STAT_COLUMNS
from app.ranking_inputs import DEFENSE_STATS, defense_game, export_ranking_inputs

NOW = datetime(2026, 11, 20, tzinfo=timezone.utc)


def fixture():
    game = {"game_id": "2025_01_BUF_NYJ", "week": 1, "home": "NYJ", "away": "BUF", "gameday": "2025-09-07",
            "kickoff": "2025-09-07T17:00:00Z", "home_score": 7, "away_score": 21}
    teams, players = [], []
    for i, (team, opponent) in enumerate((("BUF", "NYJ"), ("NYJ", "BUF"))):
        common = {"game_id": game["game_id"], "season": 2025, "season_type": "REG", "week": 1, "team": team, "opponent_team": opponent}
        teams.append({**common, **dict.fromkeys(DEFENSE_STATS, 0)})
        players.append({**common, "player_id": f"00-{i:07d}", "position": "QB", "player_display_name": "Test", **dict.fromkeys(STAT_COLUMNS, 0)})
    bundle = {"schema_version": 1, "season": 2025, "game": game, "team_columns": list(teams[0]), "teams": [list(row.values()) for row in teams],
              "player_columns": list(players[0]), "players": [list(row.values()) for row in players]}
    return seal(bundle)


def seal(bundle):
    bundle.pop("content_sha256", None)
    bundle["content_sha256"] = hashlib.sha256(encoded(bundle)).hexdigest()
    return bundle


def test_defensive_fields_are_not_offensive_turnovers_and_missing_is_not_zero():
    bundle = fixture()
    row = bundle["teams"][0]
    for key, value in {"def_sacks": 1.5, "passing_interceptions": 3, "def_interceptions": 1, "fumble_recovery_opp": None}.items():
        row[bundle["team_columns"].index(key)] = value
    data = defense_game(seal(bundle), now=NOW)
    defense = data["teams"][0]
    assert defense["stats"]["def_sacks"] == 1.5
    assert defense["stats"]["def_interceptions"] == 1
    assert defense["stats"]["fumble_recovery_opp"] is None
    assert defense["points_allowed"] == 7 and defense["points_scored"] == 21
    assert defense["allowed"]["QB"]["passing_yards"] == 0
    assert defense["allowed"]["WR"]["receiving_yards"] is None


@pytest.mark.parametrize("mutation", ["checksum", "opponent", "duplicate", "future", "negative"])
def test_bad_defensive_evidence_is_rejected(mutation):
    data = deepcopy(fixture())
    if mutation == "checksum":
        data["game"]["home_score"] = 99
    elif mutation == "opponent":
        data["teams"][0][data["team_columns"].index("opponent_team")] = "KC"
        seal(data)
    elif mutation == "duplicate":
        data["players"].append(data["players"][0])
        seal(data)
    elif mutation == "negative":
        data["teams"][0][data["team_columns"].index("def_sacks")] = -1
        seal(data)
    else:
        data["updated_at"] = "2027-01-01T00:00:00Z"
    with pytest.raises(ValueError):
        defense_game(data, now=NOW)


def test_export_failure_preserves_last_published_file(tmp_path):
    target = tmp_path / "docs/data/ranking_inputs.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"last_good":true}')
    with pytest.raises(ValueError):
        export_ranking_inputs(tmp_path, 2026, now=NOW)
    assert target.read_text() == '{"last_good":true}'
