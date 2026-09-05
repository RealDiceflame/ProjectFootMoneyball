import pandas as pd

from data_fetcher.adp_importer import (
    adp_source_dates,
    build_combined_adp,
    build_direct_adp,
    parse_espn_adp,
    parse_sleeper_adp,
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
    assert result.loc[0, "ADP"] == 12.0


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
    espn = parse_espn_adp(
        {
            "players": [
                {
                    "player": {
                        "id": 1,
                        "fullName": "Josh Allen",
                        "defaultPositionId": 1,
                        "proTeamId": 2,
                        "ownership": {"averageDraftPosition": 19.2},
                        "draftRanksByRankType": {"PPR": {"rank": 25}},
                    }
                },
                {
                    "player": {
                        "id": 2,
                        "fullName": "Unranked Player",
                        "defaultPositionId": 3,
                        "proTeamId": 2,
                        "ownership": {"averageDraftPosition": 169.99},
                        "draftRanksByRankType": {"PPR": {"rank": 2000}},
                    }
                },
            ]
        }
    )

    assert sleeper[["Player", "Position", "Sleeper"]].to_dict("records") == [
        {"Player": "Josh Allen", "Position": "QB", "Sleeper": 20.5}
    ]
    assert espn[["Player", "Team", "NFL"]].to_dict("records") == [
        {"Player": "Josh Allen", "Team": "BUF", "NFL": 19.2}
    ]


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
            "ADP": [9.0],
            "Source_Updated": ["2026-08-29"],
        }
    ).to_csv(output, index=False)

    sleeper_payload = []
    espn_payload = {"players": []}
    positions = (("QB", 1), ("RB", 2), ("WR", 3), ("TE", 4))
    for number in range(1, 121):
        position, position_id = positions[(number - 1) % len(positions)]
        sleeper_payload.append(
            {
                "player_id": str(number),
                "team": "BUF",
                "player": {"first_name": "Player", "last_name": str(number), "position": position},
                "stats": {"adp_half_ppr": float(number)},
            }
        )
        espn_payload["players"].append(
            {
                "player": {
                    "id": number,
                    "fullName": f"Player {number}",
                    "defaultPositionId": position_id,
                    "proTeamId": 2,
                    "ownership": {"averageDraftPosition": float(number + 2)},
                    "draftRanksByRankType": {"PPR": {"rank": number}},
                }
            }
        )

    def fake_get(url, **_kwargs):
        return _FakeResponse(espn_payload if "espn.com" in url else sleeper_payload)

    result = build_direct_adp(
        output,
        season=2026,
        http_get=fake_get,
        update_date="2026-09-04",
    )

    player = result.loc[result["Player"] == "Player 1"].iloc[0]
    assert player["Yahoo"] == 9.0
    assert player["Sleeper"] == 1.0
    assert player["NFL"] == 3.0
    assert round(player["ADP"], 2) == 4.33
    assert adp_source_dates(output) == {
        "Yahoo": "2026-08-29",
        "Sleeper": "2026-09-04",
        "NFL": "2026-09-04",
    }
