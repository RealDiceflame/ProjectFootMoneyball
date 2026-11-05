import pandas as pd
import requests
import pytest
import data_fetcher.adp_importer as importer

from data_fetcher.adp_importer import (
    adp_source_dates,
    build_combined_adp,
    build_direct_adp,
    parse_sleeper_adp,
    update_yahoo_snapshot,
)


def test_saved_dj_moore_aliases_coalesce_complementary_adp_without_new_dates():
    saved = pd.DataFrame([
        {"Player": "DJ Moore", "Position": "WR", "Team": "BUF", "Yahoo": 61.3,
         "Sleeper": 49.9, "MFL": None, "ADP": 55.6, "Source_Count": 2,
         "Yahoo_Updated": "2026-08-29", "Sleeper_Updated": "2026-10-30"},
        {"Player": "D.J. Moore", "Position": "WR", "Team": "BUF", "Yahoo": None,
         "Sleeper": None, "MFL": 63.89, "ADP": 63.89, "Source_Count": 1,
         "MFL_Updated": "2026-10-22", "MFL_Period": "ALL"},
    ])
    before = saved.copy(deep=True)
    result = importer.normalize_saved_adp(saved)
    assert len(result) == 1
    row = result.iloc[0]
    assert [row[key] for key in importer.ADP_PROVIDERS] == [61.3, 49.9]
    assert row["ADP"] == pytest.approx((61.3 + 49.9) / 2)
    assert row["Source_Count"] == 2
    assert row["ADP_Spread"] == pytest.approx(61.3 - 49.9)
    assert row["ADP_StdDev"] == pytest.approx(pd.Series([61.3, 49.9]).std())
    assert [row[key] for key in ["Yahoo_Updated", "Sleeper_Updated"]] == ["2026-08-29", "2026-10-30"]
    assert not any(c.startswith("MFL") for c in result)
    pd.testing.assert_frame_equal(saved, before)


def test_initial_alias_keys_keep_positions_and_ordinary_names_distinct():
    keys = {importer._player_key(name, "WR") for name in ["DJ Moore", "D.J. Moore", "D. J. Moore"]}
    assert len(keys) == 1
    assert importer._player_key("DJ Moore", "QB") not in keys
    assert importer._player_key("Jo Ann Smith", "WR") != importer._player_key("Joann Smith", "WR")


@pytest.mark.parametrize("column,values", [("Sleeper", [49.9, 52.0])])
def test_saved_adp_alias_conflicts_require_review(column, values):
    saved = pd.DataFrame({"Player": ["DJ Moore", "D. J. Moore"], "Position": ["WR", "WR"], column: values})
    with pytest.raises(ValueError, match="Conflicting saved ADP"):
        importer.normalize_saved_adp(saved)


def test_live_provider_merge_combines_dj_moore_initial_spellings(tmp_path, monkeypatch):
    monkeypatch.setattr(importer, "MIN_PROVIDER_ROWS", 1)
    monkeypatch.setattr(importer, "fetch_sleeper_adp", lambda *a, **k: pd.DataFrame([
        {"Player": "DJ Moore", "Position": "WR", "Team": "BUF", "Sleeper": 49.9}]))
    pd.DataFrame([{ "Player": "D. J. Moore", "Position": "WR", "Team": "BUF", "Yahoo": 63.89}]).to_csv(tmp_path / "adp.csv", index=False)
    result = build_direct_adp(tmp_path / "adp.csv", season=2026, update_date="2026-10-30")
    assert len(result) == 1
    assert result.iloc[0]["Source_Count"] == 2
    assert result.iloc[0]["ADP"] == pytest.approx((49.9 + 63.89) / 2)


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


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_build_direct_adp_merges_live_feeds_and_preserves_yahoo(tmp_path, monkeypatch):
    from data_fetcher import player_identity
    registry = player_identity.PlayerRegistry([dict(gsis_id=f"test-{n}", name=f"Player {n}", position=("QB", "RB", "WR", "TE")[(n-1)%4], sleeper_id=str(n), mfl_id=str(n)) for n in range(1,121)])
    monkeypatch.setattr(player_identity, "default_registry", lambda: registry)
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

    def fake_get(url, **kwargs):
        assert url.startswith("https://api.sleeper.com/")
        return _FakeResponse(sleeper_payload)

    result = build_direct_adp(
        output,
        season=2026,
        http_get=fake_get,
        update_date="2026-09-04",
    )

    player = result.loc[result["Player"] == "Player 1"].iloc[0]
    assert player["player_id"] == "test-1"
    assert player["Sleeper_ID"] == "1"
    assert player["Yahoo"] == 9.0
    assert player["Sleeper"] == 1.0
    assert not any(c.startswith("MFL") for c in result)
    assert round(player["ADP"], 2) == 5.0
    assert player["Source_Count"] == 2
    assert player["ADP_Spread"] == 8.0
    assert round(player["ADP_StdDev"], 2) == 5.66
    assert "NFL" not in result.columns
    assert adp_source_dates(output) == {
        "Yahoo": "2026-08-29",
        "Sleeper": "2026-09-04",
    }
    assert set(result.attrs["source_health"]) == {"Yahoo", "Sleeper"}


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
    assert round(quarterback["ADP"], 2) == 6.5
    assert pd.isna(receiver["Yahoo"])
    assert receiver["ADP"] == 50.0
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


def test_special_teams_uses_only_sleeper_and_has_no_cross_provider_spread(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    old = _special_snapshot(output)
    # The retired provider's values remain in this migration fixture deliberately.
    old["MFL"] = 1
    monkeypatch.setattr(importer, "fetch_sleeper_adp", lambda *a, **k: old)
    result = importer.build_special_teams_adp(output, season=2026, update_date="2026-11-05")
    assert len(result) == 20
    assert result["ADP"].eq(result["Sleeper"]).all()
    assert result["Source_Count"].eq(1).all()
    assert result[["ADP_Spread", "ADP_StdDev"]].isna().all().all()
    assert not any(c.startswith("MFL") for c in result)
    assert set(result.attrs["source_health"]) == {"Sleeper"}


def test_manual_import_drops_retired_provider_values_and_health(tmp_path):
    from refresh_draft_board import saved_adp_health

    output = tmp_path / "combined.csv"
    pd.DataFrame([dict(Player="Josh Allen", Position="QB", Team="BUF", Yahoo=10,
                       Sleeper=20, MFL=1, MFL_ID="old-unknown", MFL_Period="ALL",
                       Yahoo_Updated="2026-08-29", Sleeper_Updated="2026-11-04",
                       MFL_Updated="2026-11-05")]).to_csv(output, index=False)
    source = tmp_path / "yahoo.csv"
    pd.DataFrame([dict(Player="Josh Allen", Position="QB", Yahoo=12)]).to_csv(source, index=False)
    result = update_yahoo_snapshot(source, output, minimum_rows=1, update_date="2026-11-05")
    assert result.iloc[0]["ADP"] == 16
    assert result.iloc[0]["Source_Count"] == 2
    assert not any(c.startswith("MFL") for c in result)
    assert set(saved_adp_health(output)) == {"Yahoo", "Sleeper"}


def test_special_teams_keeps_original_dates_when_sleeper_fails(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    _special_snapshot(output)
    def fail(*args, **kwargs):
        raise requests.Timeout("unavailable")
    monkeypatch.setattr(importer, "fetch_sleeper_adp", fail)
    result = importer.build_special_teams_adp(output, season=2026, update_date="2026-09-27")
    assert result["Source_Updated"].eq("2026-09-24").all()
    assert all(row["status"] == "cached" for row in result.attrs["source_health"].values())


def test_special_teams_cannot_replace_valid_snapshot_with_incomplete_provider_data(tmp_path, monkeypatch):
    output = tmp_path / "special.csv"
    saved = _special_snapshot(output)
    saved["Sleeper"] = None
    saved.to_csv(output, index=False)
    before = output.read_bytes()
    monkeypatch.setattr(importer, "fetch_sleeper_adp", lambda *args, **kwargs: saved)
    with pytest.raises(RuntimeError, match="usable Sleeper snapshot"):
        importer.build_special_teams_adp(output, season=2026, update_date="2026-09-27")
    assert output.read_bytes() == before


def test_saved_adp_keeps_two_known_same_name_ids_separate():
    rows=pd.DataFrame([{'Player':'Alex Smith','Position':'WR','player_id':'one','Sleeper':10},
                       {'Player':'Alex Smith','Position':'WR','player_id':'two','Sleeper':20}])
    result=importer.normalize_saved_adp(rows)
    assert result.player_id.tolist()==['one','two']
    assert result.Sleeper.tolist()==[10,20]


def test_unresolved_adp_candidates_cannot_displace_identified_players(tmp_path, monkeypatch):
    from data_fetcher import player_identity
    monkeypatch.setattr(importer, 'MIN_PROVIDER_ROWS', 1)
    monkeypatch.setattr(importer, 'MAX_PUBLISHED_PLAYERS', 1)
    registry = player_identity.PlayerRegistry([dict(gsis_id='known',name='Known Player',position='RB',sleeper_id='known-provider')])
    monkeypatch.setattr(player_identity, 'default_registry', lambda: registry)
    monkeypatch.setattr(importer, 'fetch_sleeper_adp', lambda *a, **k: pd.DataFrame([
        dict(Player='Unknown',Position='RB',Team='BUF',Sleeper=1,Sleeper_ID='unresolved'),
        dict(Player='Known Player',Position='RB',Team='BUF',Sleeper=200,Sleeper_ID='known-provider')]))
    result=build_direct_adp(tmp_path/'adp.csv',season=2026)
    assert len(result)==2
    assert result.loc[result.Player.eq('Known Player'),'player_id'].iloc[0]=='known'
    assert result.loc[result.Player.eq('Unknown'),'identity_status'].iloc[0]=='unresolved_provider_id'
