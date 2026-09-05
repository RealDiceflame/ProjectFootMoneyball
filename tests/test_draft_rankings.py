import pandas as pd

from stat_utils.data_analytics.draft_rankings import (
    build_draft_ranking,
    calculate_market_expected_points,
    calculate_projected_points,
)


def _player(name, pos, points_stat, receptions=0, adp=100):
    row = {
        "player": name,
        "team": "TST",
        "pos": pos,
        "g": 17,
        "passing_yds": 0,
        "passing_td": 0,
        "passing_int": 0,
        "rushing_yds": 0,
        "rushing_td": 0,
        "receiving_rec": receptions,
        "receiving_yds": 0,
        "receiving_td": 0,
        "fmb": 0,
        "ADP": adp,
    }
    if pos == "QB":
        row["passing_yds"] = points_stat / 0.04
    else:
        row["rushing_yds"] = points_stat / 0.1
    return row


def test_te_premium_only_adds_points_to_tight_ends():
    df = pd.DataFrame(
        [
            _player("Tight End", "TE", 100, receptions=60),
            _player("Receiver", "WR", 100, receptions=60),
        ]
    )
    base = calculate_projected_points(df, base_ppr=0.5, te_premium=0.0)
    premium = calculate_projected_points(df, base_ppr=0.5, te_premium=0.5)
    assert premium.iloc[0] - base.iloc[0] == 30
    assert premium.iloc[1] == base.iloc[1]


def test_full_ppr_adds_reception_points_to_all_pass_catchers():
    df = pd.DataFrame(
        [
            _player("Tight End", "TE", 100, receptions=60),
            _player("Receiver", "WR", 100, receptions=60),
        ]
    )
    standard = calculate_projected_points(df, base_ppr=0.0)
    half_ppr = calculate_projected_points(df, base_ppr=0.5)
    full_ppr = calculate_projected_points(df, base_ppr=1.0)

    assert (half_ppr - standard).tolist() == [30, 30]
    assert (full_ppr - standard).tolist() == [60, 60]


def test_market_value_compares_projection_with_position_regression_at_adp():
    ranking = pd.DataFrame({
        "pos": ["QB", "QB", "QB", "QB"],
        "adp": [10, 20, 30, 20],
        "projected_points": [400, 350, 300, 400],
    })

    expected = calculate_market_expected_points(ranking)

    assert expected.round(1).tolist() == [412.5, 362.5, 312.5, 362.5]
    assert ranking.loc[3, "projected_points"] - expected.loc[3] == 37.5


def test_rankings_only_use_adp_sources_matching_the_selected_format():
    rows = []
    for number in range(1, 4):
        row = _player(f"RB {number}", "RB", 300 - number, adp=99)
        row.update({"Yahoo": number, "Sleeper": number + 2, "NFL": number + 10, "MFL": number + 12})
        rows.append(row)
    frame = pd.DataFrame(rows)

    half_ppr = build_draft_ranking(
        frame, format_name="half", teams=12, qb_starters=1, base_ppr=0.5
    )
    full_ppr = build_draft_ranking(
        frame, format_name="full", teams=12, qb_starters=1, base_ppr=1.0
    )
    two_qb = build_draft_ranking(
        frame, format_name="two", teams=12, qb_starters=2, base_ppr=0.5
    )

    assert half_ppr.loc[half_ppr["player"] == "RB 1", "adp"].iloc[0] == 2
    assert pd.isna(half_ppr.loc[half_ppr["player"] == "RB 1", "NFL"].iloc[0])
    assert full_ppr.loc[full_ppr["player"] == "RB 1", "adp"].iloc[0] == 12
    assert pd.isna(full_ppr.loc[full_ppr["player"] == "RB 1", "Yahoo"].iloc[0])
    assert two_qb["adp"].isna().all()
    assert two_qb["market_value"].isna().all()


def test_two_qb_replacement_level_uses_twice_as_many_qbs():
    rows = []
    for number in range(1, 27):
        rows.append(_player(f"QB {number}", "QB", 400 - number, adp=number))
    for pos in ("RB", "WR", "TE"):
        for number in range(1, 43):
            rows.append(_player(f"{pos} {number}", pos, 300 - number, adp=100))
    df = pd.DataFrame(rows)

    one_qb = build_draft_ranking(
        df, format_name="1QB", teams=12, qb_starters=1
    )
    two_qb = build_draft_ranking(
        df, format_name="2QB", teams=12, qb_starters=2
    )

    one_qb_value = one_qb.loc[one_qb["player"] == "QB 1", "vorp"].iloc[0]
    two_qb_value = two_qb.loc[two_qb["player"] == "QB 1", "vorp"].iloc[0]
    assert two_qb_value > one_qb_value
    qb1 = two_qb.loc[two_qb["player"] == "QB 1"].iloc[0]
    # The first non-starter in a 12-team 2QB league is QB25.
    assert qb1["replacement_points"] == 375


def test_larger_leagues_use_a_deeper_replacement_player():
    rows = []
    for number in range(1, 41):
        rows.append(_player(f"QB {number}", "QB", 400 - number, adp=number))
    for pos in ("RB", "WR", "TE"):
        for number in range(1, 61):
            rows.append(_player(f"{pos} {number}", pos, 300 - number, adp=100))
    df = pd.DataFrame(rows)

    eight_team = build_draft_ranking(
        df, format_name="8-team", teams=8, qb_starters=2
    )
    sixteen_team = build_draft_ranking(
        df, format_name="16-team", teams=16, qb_starters=2
    )

    eight_team_qb1 = eight_team.loc[
        eight_team["player"] == "QB 1", "vorp"
    ].iloc[0]
    sixteen_team_qb1 = sixteen_team.loc[
        sixteen_team["player"] == "QB 1", "vorp"
    ].iloc[0]
    assert sixteen_team_qb1 > eight_team_qb1
