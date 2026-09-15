import csv
from datetime import datetime, timezone
from io import StringIO
import json
import pytest
from app.game_stats import parse_stats, refresh_game_stats

NOW = datetime(2026,9,15,tzinfo=timezone.utc)
GAME = {"game_id":"2026_01_BUF_BAL","week":1,"home":"BAL","away":"BUF",
        "gameday":"2026-09-13","kickoff":"2026-09-13T17:00:00Z","home_score":0,"away_score":14}
BASE = ["game_id","season","season_type","week","team","opponent_team","passing_yards","rushing_yards","def_sacks","fg_made_list"]


def source(kind, *, bad=False, remove_column=False, corrected=False):
    columns = BASE + (["player_id","player_display_name","position"] if kind == "players" else [])
    if remove_column: columns = [key for key in columns if key != "def_sacks"]
    rows = []
    for team, opponent in [("BAL","BUF"),("BUF","BAL")]:
        row = dict(zip(BASE, [GAME["game_id"],2026,"REG",1,team,opponent,"broken" if bad else 0,-2,0.5,"27;44"]))
        row.update(player_id=("00-0099999" if corrected else "00-0000001") if team=="BAL" else "00-0000002",
                   player_display_name="A Player",position="QB")
        rows.append(row)
    output=StringIO();writer=csv.DictWriter(output,fieldnames=columns,extrasaction="ignore")
    writer.writeheader();writer.writerows(rows)
    return output.getvalue().encode()


def setup(tmp_path):
    (tmp_path/"docs/data").mkdir(parents=True)
    (tmp_path/"docs/data/scores.json").write_text(json.dumps({"season":2026,"games":[GAME]}))
    return lambda url:(source("players" if "stats_player" in url else "teams"),None)


def test_full_stat_values_and_identity_are_preserved():
    columns, groups = parse_stats(source("players"),"players",2026,{GAME["game_id"]:GAME})
    row=groups[GAME["game_id"]][0]
    assert row["player_id"]=="00-0000001" and row["passing_yards"]==0
    assert row["rushing_yards"]==-2 and row["def_sacks"]==0.5 and row["fg_made_list"]=="27;44"
    with pytest.raises(ValueError,match="Non-numeric"):
        parse_stats(source("players",bad=True),"players",2026,{GAME["game_id"]:GAME})
    with pytest.raises(ValueError,match="Unknown"):
        parse_stats(source("players"),"players",2026,{})


def test_archive_keeps_sources_prior_seasons_and_stable_unchanged_game(tmp_path):
    fetch=setup(tmp_path)
    (tmp_path/"docs/data/game_stats/2025").mkdir(parents=True)
    (tmp_path/"docs/data/game_stats/index.json").write_text(json.dumps({"schema_version":1,"seasons":[2025]}))
    historical=tmp_path/"docs/data/game_stats/2025/keep.json";historical.write_text('{"keep":true}')
    assert refresh_game_stats(tmp_path,2026,fetch=fetch,now=NOW)==1
    game=tmp_path/f"docs/data/game_stats/2026/{GAME['game_id']}.json"
    saved=game.read_bytes()
    assert (tmp_path/"data/game_stats/2026/players.csv").read_bytes()==source("players")
    refresh_game_stats(tmp_path,2026,fetch=fetch,now=datetime(2026,9,16,tzinfo=timezone.utc))
    assert game.read_bytes()==saved and historical.exists()
    assert json.loads((tmp_path/"docs/data/game_stats/index.json").read_text())["seasons"]==[2026,2025]


def test_bad_schema_or_network_cannot_replace_saved_data_but_credits_can_be_corrected(tmp_path):
    fetch=setup(tmp_path);refresh_game_stats(tmp_path,2026,fetch=fetch,now=NOW)
    game=tmp_path/f"docs/data/game_stats/2026/{GAME['game_id']}.json";saved=game.read_bytes()
    with pytest.raises(ValueError,match="columns disappeared"):
        refresh_game_stats(tmp_path,2026,fetch=lambda url:(source("players" if "stats_player" in url else "teams",remove_column=True),None),now=NOW)
    assert game.read_bytes()==saved
    def fail(url): raise OSError("offline")
    with pytest.raises(OSError): refresh_game_stats(tmp_path,2026,fetch=fail,now=NOW)
    assert game.read_bytes()==saved
    refresh_game_stats(tmp_path,2026,fetch=lambda url:(source("players" if "stats_player" in url else "teams",corrected=True),None),now=NOW)
    assert json.loads(game.read_text())["player_credit_changes"]["removed"]==[["BAL","00-0000001"]]
