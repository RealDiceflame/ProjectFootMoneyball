"""Historical identity joins and safe snapshot maintenance (stdlib tests)."""

import json
from pathlib import Path
import tempfile
import unittest

from app.draft_capital_history import COLUMNS, SOURCE_FILTERS, STAT_COLUMNS, join_season, normalized_name, refresh_history


def fixtures():
    players, market, stats = [], [], []
    for index in range(60):
        players.append({"id": str(index), "name": f"Runner{index}, Test", "position": "RB"})
        market.append({"id": str(index), "averagePick": str(index + 1)})
        stats.append({"player_id": f"gsis-{index}", "player_display_name": f"Test Runner{index}",
                      "position": "RB", "season": "2020", "season_type": "REG",
                      **{key: "0" for key in STAT_COLUMNS}, "games": "16", "rushing_yards": "1000"})
    return {"adp": {"player": market, "totalDrafts": "100"}}, {"players": {"player": players}}, stats


class DraftCapitalHistoryTests(unittest.TestCase):
    def test_season_specific_names_positions_and_stable_output_ids(self):
        adp, players, stats = fixtures()
        output = join_season(2020, adp, players, stats)
        self.assertEqual(len(output["rows"]), 60)
        record = dict(zip(COLUMNS, output["rows"][0]))
        self.assertEqual(record["player_id"], "gsis-0")
        self.assertEqual(record["season"], 2020)
        self.assertEqual(record["rushing_yards"], 1000)
        self.assertEqual(normalized_name("Smith, DeVonta"), normalized_name("DeVonta Smith"))
        self.assertEqual(normalized_name("Smith Jr., John"), normalized_name("John Smith Jr."))

    def test_same_name_defender_does_not_replace_offensive_player(self):
        adp, players, stats = fixtures()
        players["players"]["player"].append({"id": "defender", "name": "Runner0, Test", "position": "DE"})
        adp["adp"]["player"].append({"id": "defender", "averagePick": "1"})
        output = join_season(2020, adp, players, stats)
        self.assertEqual(output["coverage"]["matched"], 60)
        self.assertEqual(output["coverage"]["adp_players"], 60)

    def test_missing_seasons_and_ambiguous_names_are_not_invented(self):
        adp, players, stats = fixtures()
        players["players"]["player"].append({"id": "ambiguous", "name": "Runner0, Test", "position": "RB"})
        stats.pop(1)
        output = join_season(2020, adp, players, stats)
        self.assertEqual(output["coverage"]["ambiguous"], 1)
        self.assertEqual(output["coverage"]["missing_stats"], 1)
        self.assertEqual(output["coverage"]["matched"], 58)
        self.assertFalse(any(row[1] in {"gsis-0", "gsis-1"} for row in output["rows"]))

    def test_duplicate_team_splits_and_wrong_seasons_are_excluded(self):
        adp, players, stats = fixtures()
        stats.append(dict(stats[0]))
        stats[1]["season"] = "2021"
        stats[2]["games"] = "0"
        output = join_season(2020, adp, players, stats)
        self.assertEqual(output["coverage"]["matched"], 57)
        self.assertEqual(output["coverage"]["ambiguous"], 1)

    def test_missing_network_response_preserves_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "history.json"
            path.write_text('{"previous":true}', encoding="utf-8")
            def fail(url):
                raise OSError("Unavailable")
            with self.assertRaises(OSError):
                refresh_history(path, [2020], fetch=fail)
            self.assertEqual(json.loads(path.read_text()), {"previous": True})

    def test_cached_completed_years_do_not_make_api_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "history.json"
            path.write_text(json.dumps({"schema_version": 1, "source_filters": SOURCE_FILTERS,
                                        "years": {"2020": {"rows": [[2020]], "coverage": {}}}}), encoding="utf-8")
            def no_network(url):
                raise AssertionError("Cached year must not be downloaded")
            first = refresh_history(path, [2020], fetch=no_network)
            contents = path.read_bytes()
            second = refresh_history(path, [2020], fetch=no_network)
            self.assertEqual(first, second)
            self.assertEqual(contents, path.read_bytes())

    def test_published_seasons_match_archive_and_have_unique_records(self):
        root = Path(__file__).resolve().parents[1] / "docs/data"
        bundle = json.loads((root / "draft_capital_history.json").read_text(encoding="utf-8"))
        history = json.loads((root / "player_history.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle["seasons"], history["seasons"])
        for year in bundle["years"].values():
            self.assertGreaterEqual(len(year["rows"]), 50)
            self.assertEqual(len({row[1] for row in year["rows"]}), len(year["rows"]))
            self.assertTrue(all(row[0] == year["season"] for row in year["rows"]))
            self.assertEqual(year["coverage"]["adp_players"], year["coverage"]["matched"] + year["coverage"]["ambiguous"] + year["coverage"]["missing_stats"])


if __name__ == "__main__":
    unittest.main()
