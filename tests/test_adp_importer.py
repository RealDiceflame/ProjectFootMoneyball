import pandas as pd
import requests
import pytest
import data_fetcher.adp_importer as importer

from data_fetcher.adp_importer import (
    adp_source_dates,
    build_combined_adp,
    build_direct_adp,
    parse_mfl_adp,
    parse_sleeper_adp,
    update_yahoo_snapshot,
)


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
    assert result.loc[0, "ADP"] == 11.0
    assert "NFL" not in result.columns


def test_provider_parsers_keep_skill_players_and_real_adp():
    sleeper = parse_sleeper_adp(
        [
            {
                "player_id": "1",
                "team": "BUF",
                "player": {"first_name": "Josh", "last_name": "Allen", "position": "QB"},
                "stats": {"adp_half_ppr": 20.5},
            },
            {
                "player_id": "2",
                "team": "JAX",
                "player": {"first_name": "Josh", "last_name": "Hines-Allen", "position": "DE"},
                "stats": {"adp_half_ppr": 25},
            },
        ]
    )
    assert sleeper[["Player", "Position", "Sleeper"]].to_dict("records") == [
        {"Player": "Josh Allen", "Position": "QB", "Sleeper": 20.5}
    ]


def test_mfl_parser_normalizes_names_and_teams():
    mfl = parse_mfl_adp(
        {"adp": {"player": [{"id": "10", "averagePick": "17.2"}]}},
        {"players": {"player": [{"id": "10", "name": "Brown, A.J.", "position": "WR", "team": "NEP"}]}},
    )

    assert mfl[["Player", "Team", "MFL"]].to_dict("records") == [
        {"Player": "A.J. Brown", "Team": "NE", "MFL": 17.2}
    ]


def test_provider_parsers_support_kickers_and_team_defenses():
    sleeper = parse_sleeper_adp(
        [{
            "player_id": "HOU",
            "team": "HOU",
            "player": {"first_name": "Houston", "last_name": "Texans", "position": "DEF"},
            "stats": {"adp_half_ppr": 104.8},
        }],
        positions={"K", "DST"},
    )
    mfl = parse_mfl_adp(
        {"adp": {"player": [{"id": "0532", "averagePick": "106.9"}]}},
        {"players": {"player": [{"id": "0532", "name": "Texans, Houston", "position": "Def", "team": "HOU"}]}},
        positions={"K", "DST"},
    )

    assert sleeper.iloc[0]["Position"] == "DST"
    assert mfl.iloc[0]["Position"] == "DST"


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_build_direct_adp_merges_live_feeds_and_preserves_yahoo(tmp_path):
    output = tmp_path / "combined.csv"
    pd.DataFrame(
        {
            "Player": ["Player 1"],
            "Team": ["BUF"],
            "Position": ["QB"],
            "Yahoo": [9.0],
            "Sleeper": [8.0],
            "NFL": [10.0],
            "MFL": [11.0],
            "ADP": [9.0],
            "Source_Updated": ["2026-08-29"],
        }
    ).to_csv(output, index=False)

    sleeper_payload = []
    mfl_adp_payload = {"adp": {"player": []}}
    mfl_players_payload = {"players": {"player": []}}
    positions = ("QB", "RB", "WR", "TE")
    for number in range(1, 121):
        position = positions[(number - 1) % len(positions)]
        sleeper_payload.append(
            {
                "player_id": str(number),
                "team": "BUF",
                "player": {"first_name": "Player", "last_name": str(number), "position": position},
                "stats": {"adp_half_ppr": float(number)},
            }
        )
        mfl_adp_payload["adp"]["player"].append(
            {"id": str(number), "averagePick": float(number + 6)}
        )
        mfl_players_payload["players"]["player"].append(
            {"id": str(number), "name": f"{number}, Player", "position": position, "team": "BUF"}
        )

    def fake_get(url, **kwargs):
        if "myfantasyleague.com" in url:
            payload = mfl_players_payload if kwargs.get("params", {}).get("TYPE") == "players" else mfl_adp_payload
            return _FakeResponse(payload)
        return _FakeResponse(sleeper_payload)

    result = build_direct_adp(
        output,
        season=2026,
        http_get=fake_get,
        update_date="2026-09-04",
    )

    player = result.loc[result["Player"] == "Player 1"].iloc[0]
    assert player["Yahoo"] == 9.0
    assert player["Sleeper"] == 1.0
    assert player["MFL"] == 7.0
    assert round(player["ADP"], 2) == 5.67
    assert player["Source_Count"] == 3
    assert player["ADP_Spread"] == 8.0
    assert round(player["ADP_StdDev"], 2) == 4.16
    assert "NFL" not in result.columns
    assert adp_source_dates(output) == {
        "Yahoo": "2026-08-29",
        "Sleeper": "2026-09-04",
        "MFL": "2026-09-04",
    }


def test_update_yahoo_snapshot_replaces_provider_without_name_collisions(tmp_path):
    output = tmp_path / "combined.csv"
    source = tmp_path / "4for4.csv"
    pd.DataFrame(
        {
            "Player": ["Josh Allen", "Josh Allen"],
            "Team": ["BUF", "JAX"],
            "Position": ["QB", "WR"],
            "Yahoo": [9.0, 45.0],
            "Sleeper": [10.0, 50.0],
            "NFL": [11.0, 55.0],
            "MFL": [12.0, 60.0],
            "ADP": [10.0, 50.0],
            "Source_Updated": ["2026-08-29", "2026-08-29"],
            "Yahoo_Updated": ["2026-08-29", "2026-08-29"],
            "Sleeper_Updated": ["2026-09-03", "2026-09-03"],
            "NFL_Updated": ["2026-09-03", "2026-09-03"],
            "MFL_Updated": ["2026-09-03", "2026-09-03"],
        }
    ).to_csv(output, index=False)
    pd.DataFrame(
        {
            "ADP": [1, 2],
            "Position": ["QB-01", "RB-01"],
            "Player": ["Josh Allen", "New Runner"],
            "Team": ["BUF", "DAL"],
            "Y!": [3.0, 14.0],
        }
    ).to_csv(source, index=False)

    result = update_yahoo_snapshot(
        source,
        output,
        update_date="2026-09-04",
        minimum_rows=1,
    )

    quarterback = result[(result["Player"] == "Josh Allen") & (result["Position"] == "QB")].iloc[0]
    receiver = result[(result["Player"] == "Josh Allen") & (result["Position"] == "WR")].iloc[0]
    rookie = result[result["Player"] == "New Runner"].iloc[0]
    assert quarterback["Yahoo"] == 3.0
    assert round(quarterback["ADP"], 2) == 8.33
    assert pd.isna(receiver["Yahoo"])
    assert receiver["ADP"] == 55.0
    assert rookie["Yahoo"] == 14.0
    assert rookie["ADP"] == 14.0
    assert "NFL" not in result.columns
    assert adp_source_dates(output)["Yahoo"] == "2026-09-04"


def test_failed_adp_downloads_keep_provider_dates_and_report_cached_state(tmp_path, capsys):
    output = tmp_path / "combined.csv"
    pd.DataFrame({
        "Player": ["Josh Allen"], "Team": ["BUF"], "Position": ["QB"],
        "Yahoo": [12], "Sleeper": [11], "MFL": [13],
        "Yahoo_Updated": ["2026-08-29"], "Sleeper_Updated": ["2026-09-04"],
        "MFL_Updated": ["2026-09-03"], "Source_Updated": ["2026-09-04"],
    }).to_csv(output, index=False)
    def unavailable(*args, **kwargs):
        raise requests.RequestException("https://provider.test/?apiKey=private-secret")
    result = build_direct_adp(output, season=2026, http_get=unavailable, update_date="2026-09-27")
    assert result.loc[0, "Source_Updated"] == "2026-09-04"
    assert result.loc[0, "Sleeper"] == 11
    health = result.attrs["source_health"]
    assert health["Yahoo"]["status"] == "manual"
    assert health["Yahoo"]["attempted_at"] is None
    assert health["Sleeper"]["status"] == "cached"
    assert health["Sleeper"]["last_success"] == "2026-09-04"
    assert "private-secret" not in capsys.readouterr().out


def test_absent_provider_values_do_not_borrow_another_sources_date(tmp_path):
    output = tmp_path / "combined.csv"
    pd.DataFrame({"Player": ["Josh Allen"], "Sleeper": [10], "Yahoo": [None], "Source_Updated": ["2026-09-27"]}).to_csv(output, index=False)
    assert adp_source_dates(output) == {"Sleeper": "2026-09-27"}


def test_mfl_empty_recent_window_is_explained_without_downloading_player_directory():
    calls = []
    def get(url, **kwargs):
        calls.append(kwargs["params"])
        return _FakeResponse({"adp": {"timestamp": "1790552841", "totalDrafts": "0", "totalPicks": "0"}})
    with pytest.raises(importer.ProviderDataUnavailable) as failure:
        importer.fetch_mfl_adp(2026, http_get=get)
    assert failure.value.reason_code == "no_recent_drafts"
    assert len(calls) == 1
    assert calls[0]["PERIOD"] == "RECENT"


def _special_snapshot(path):
    teams = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN"]
    frame = pd.DataFrame({
        "Player": [f"Kicker {index}" for index in range(10)] + [f"Defense {team}" for team in teams],
        "Position": ["K"] * 10 + ["DST"] * 10,
        "Team": teams * 2, "Sleeper": list(range(130, 150)), "MFL": list(range(140, 160)),
        "Sleeper_Updated": "2026-09-24", "MFL_Updated": "2026-09-24", "Source_Updated": "2026-09-24",
    })
    frame.to_csv(path, index=False)
    return frame


def test_special_teams_refreshes_good_provider_while_retaining_empty_mfl_snapshot(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    saved = _special_snapshot(output)
    fresh = saved.copy()
    fresh["Sleeper"] += 3
    fresh.loc[fresh["Position"] == "DST", "Player"] = "Updated defense names"
    monkeypatch.setattr(importer, "fetch_sleeper_adp", lambda *args, **kwargs: fresh)
    def empty(*args, **kwargs):
        raise importer.ProviderDataUnavailable("no_recent_drafts", "MFL reports no recent qualifying drafts.")
    monkeypatch.setattr(importer, "fetch_mfl_adp", empty)
    result = importer.build_special_teams_adp(output, season=2026, update_date="2026-09-27")
    assert len(result) == 20  # D/ST identity is the team, even when provider display names differ.
    assert result["Source_Count"].eq(2).all()
    assert result["Sleeper_Updated"].eq("2026-09-27").all()
    assert result["MFL_Updated"].eq("2026-09-24").all()
    assert result["Source_Updated"].eq("2026-09-27").all()
    row = result[result["Player"] == "Kicker 0"].iloc[0]
    assert row["Sleeper"] == 133
    assert row["MFL"] == 140
    assert row["ADP"] == 136.5
    health = result.attrs["source_health"]
    assert health["Sleeper"]["status"] == "success"
    assert health["MFL"]["status"] == "cached"
    assert health["MFL"]["reason_code"] == "no_recent_drafts"
    assert health["MFL"]["last_success"] == "2026-09-24"


def test_special_teams_keeps_original_dates_when_both_providers_fail(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    _special_snapshot(output)
    def fail(*args, **kwargs):
        raise requests.Timeout("unavailable")
    monkeypatch.setattr(importer, "fetch_sleeper_adp", fail)
    monkeypatch.setattr(importer, "fetch_mfl_adp", fail)
    result = importer.build_special_teams_adp(output, season=2026, update_date="2026-09-27")
    assert result["Source_Updated"].eq("2026-09-24").all()
    assert all(row["status"] == "cached" for row in result.attrs["source_health"].values())


def test_special_teams_cannot_replace_valid_snapshot_with_incomplete_provider_data(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    saved = _special_snapshot(output)
    saved["MFL"] = None
    saved.to_csv(output, index=False)
    before = output.read_bytes()
    monkeypatch.setattr(importer, "fetch_sleeper_adp", lambda *args, **kwargs: saved)
    monkeypatch.setattr(importer, "fetch_mfl_adp", lambda *args, **kwargs: pd.DataFrame())
    with pytest.raises(RuntimeError, match="two usable sources"):
        importer.build_special_teams_adp(output, season=2026, update_date="2026-09-27")
    assert output.read_bytes() == before
