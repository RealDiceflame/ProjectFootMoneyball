"""Offline corruption checks plus opt-in, rollback-only PostgreSQL verification."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import json
import os
from pathlib import Path
import re
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from app import stats_verification
from app.stats_database import game_stat_totals, import_snapshots, migrate
from app.stats_import import load_saved_stats, prepare_snapshot
from app.stats_verification import GAME_METRICS, verify_database


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def snapshots():
    saved = []
    for season, week in ((2025, 1), (2025, 2), (2026, 1)):
        game_id = f"{season}_{week:02d}_NE_SEA"
        columns = ["player_id", "player_display_name", "season", "season_type", "week", "game_id",
                   "team", "opponent_team", "position", "passing_yards", "def_sacks", "fg_long",
                   "pt_long", "fg_made_list", "receiving_yards"]
        payload = {
            "schema_version": 1, "season": season, "updated_at": f"{season}-10-15T12:00:00Z",
            "game": {"game_id": game_id, "week": week, "home": "SEA", "away": "NE",
                     "kickoff": f"{season}-09-15T12:00:00Z", "home_score": 20, "away_score": 10},
            "player_columns": columns,
            "players": [
                ["00-0000001", "Alex Player", season, "REG", week, game_id,
                 "NE", "SEA", "QB", 10 * week, 0.5, 47 + week, None, "27;44", 0],
                ["00-0000002", "Alex Player", season, "REG", week, game_id,
                 "SEA", "NE", "QB", 0, None, None, 40 + week, "", None],
                [None, None, season, "REG", week, game_id,
                 "SEA", "NE", None, None, None, None, None, None, -2],
            ],
            "team_columns": ["season", "season_type", "week", "game_id", "team", "opponent_team",
                             "passing_yards", "fg_made_list"],
            "teams": [[season, "REG", week, game_id, "NE", "SEA", 10 * week, "27;44"],
                      [season, "REG", week, game_id, "SEA", "NE", 0, None]],
            "sources": {"players": {"retrieved_at": f"{season}-10-15T12:00:00Z"}},
        }
        saved.append(prepare_snapshot(payload, f"docs/data/game_stats/{season}/{game_id}.json"))
    history = {
        "generated_at": "2026-10-15T12:00:00Z", "columns": ["season", "team", "pos", "games",
            "passing_yards", "passing_interceptions", "fumbles_total"],
        "player_season_count": 4,
        "players": {
            "first": {"player_id": "00-0000001", "player": "Alex Player", "birth_date": "1990-01-01",
                      "seasons": [[2024, "NE", "QB", 2, 23, 1, None], [2025, "NE", "QB", 2, 30, 0, 0]]},
            "second": {"player_id": "00-0000002", "player": "Alex Player", "birth_date": None,
                       "seasons": [[2024, "SEA", "QB", 1, 0, None, None], [2025, "SEA", "QB", 1, 0, 0, 0]]},
        },
    }
    return [prepare_snapshot(history, "docs/data/player_history.json"), *saved]


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class ArchiveCursor:
    """Named-cursor protocol; iteration records bounded transfer batches."""
    def __init__(self, connection, name):
        self.connection, self.name = connection, name
        self.itersize, self.closed = None, False
        self.batches = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def execute(self, query, params):
        assert not self.closed
        self.query, self.params = query, params
        self.rows = self.connection.execute(query, params).rows

    def __iter__(self):
        assert not self.closed and self.itersize > 0
        for offset in range(0, len(self.rows), self.itersize):
            batch = self.rows[offset:offset + self.itersize]
            self.batches.append(len(batch))
            yield from batch


class ArchiveConnection:
    """A small read-only database double with independently computed SQL totals."""
    def __init__(self, snapshots):
        self.info = SimpleNamespace(transaction_status=SimpleNamespace(name="IDLE"))
        self.isolation = "repeatable read"
        self.commands, self.transactions = [], []
        self.cursors = []
        self.snapshots = snapshots
        self.heads, self.games, self.player_games, self.team_games, self.player_seasons = [], [], [], [], []
        self.player_ids = {(p["player_id"],) for s in snapshots for p in s.players}
        self.aggregate_overrides = {}
        for snapshot_id, saved in enumerate(snapshots, 1):
            self.heads.append([saved.dataset, saved.object_key, snapshot_id, saved.source_updated_at,
                               saved.content_hash, saved.source_updated_at, deepcopy(saved.payload), True])
            if saved.dataset == "game":
                game = saved.payload["game"]
                common = [saved.payload["season"], game["week"], "REG"]
                self.games.append([saved.object_key, snapshot_id, *common, game["home"], game["away"], deepcopy(game)])
                for row in saved.player_games:
                    self.player_games.append([snapshot_id, saved.object_key, row["row_key"], row["player_id"],
                        row["player_name"], row["team"], row["opponent_team"], row["position"], deepcopy(row["stats"]), *common])
                for row in saved.team_games:
                    self.team_games.append([snapshot_id, saved.object_key, row["team"], row["opponent_team"],
                                           deepcopy(row["stats"]), *common])
            else:
                for row in saved.player_seasons:
                    self.player_seasons.append([snapshot_id, row["player_id"], row["season"], "REG",
                                               row["recent_team"], row["position"], deepcopy(row["stats"])])

    @contextmanager
    def transaction(self, **options):
        self.transactions.append(options)
        yield

    def cursor(self, *, name):
        cursor = ArchiveCursor(self, name)
        self.cursors.append(cursor)
        return cursor

    def execute(self, query, params=()):
        query = " ".join(query.split())
        self.commands.append((query, params))
        assert query.startswith(("SELECT ", "SHOW ", "SET ")), "Verifier attempted a write"
        if query.startswith("SET "):
            return Result([])
        if query.startswith("SHOW "):
            return Result([(self.isolation,)])
        if "FROM ob_stats.snapshot_heads h" in query:
            return Result(self.heads[:params[0]])
        if "GROUP BY player_id" in query:
            metrics, (season, week, _, limit) = params[:-4], params[-4:]
            reducers = re.findall(r"(SUM|MAX)\(\(stats->>%s\)::numeric\)", query)
            assert len(reducers) == len(metrics)
            totals = {}
            for saved in self.snapshots:
                if saved.dataset != "game" or saved.payload["season"] != season:
                    continue
                if week is not None and saved.payload["game"]["week"] != week:
                    continue
                for values in saved.payload["players"]:
                    row = dict(zip(saved.payload["player_columns"], values))
                    player = row["player_id"]
                    if player is None:
                        continue
                    totals.setdefault(player, []).append(row)
            result = {player: [] for player in totals}
            for metric, reducer in zip(metrics, reducers):
                values = {player: [Decimal(str(row[metric])) for row in rows if row.get(metric) is not None]
                          for player, rows in totals.items()}
                column = {player: (max(items) if reducer == "MAX" else sum(items)) if items else None
                          for player, items in values.items()}
                column.update(self.aggregate_overrides.get((season, week, metric), {}))
                for player, value in column.items():
                    result.setdefault(player, []).append(value)
            return Result([(player, *values) for player, values in sorted(result.items())][:limit])
        if "GROUP BY season" in query:
            metrics, limit = params[:-1], params[-1]
            reducers = re.findall(r"(SUM|MAX)\(\(stats->>%s\)::numeric\)", query)
            assert len(reducers) == len(metrics)
            values = {}
            for saved in self.snapshots:
                if saved.dataset != "player_history":
                    continue
                for player in saved.payload["players"].values():
                    for cells in player["seasons"]:
                        row = dict(zip(saved.payload["columns"], cells))
                        values.setdefault(row["season"], []).append(row)
            result = {season: [] for season in values}
            for metric, reducer in zip(metrics, reducers):
                numbers = {season: [Decimal(str(row[metric])) for row in rows if row.get(metric) is not None]
                           for season, rows in values.items()}
                column = {season: (max(items) if reducer == "MAX" else sum(items)) if items else None
                          for season, items in numbers.items()}
                column.update(self.aggregate_overrides.get(("history", metric), {}))
                for season, value in column.items():
                    result.setdefault(season, []).append(value)
            return Result([(season, *items) for season, items in sorted(result.items())][:limit])
        for table, rows in (("current_games", self.games), ("current_player_game_stats", self.player_games),
                            ("current_team_game_stats", self.team_games),
                            ("current_player_season_stats", self.player_seasons)):
            if f"FROM ob_stats.{table} " in query:
                return Result(rows[:params[0]])
        if "FROM ob_stats.players " in query:
            return Result(sorted(self.player_ids))
        raise AssertionError(f"Unexpected verification SQL: {query}")


def test_offline_complete_parity_covers_every_season_week_and_identity(snapshots):
    conn = ArchiveConnection(snapshots)
    report = verify_database(conn, snapshots)
    assert report["verified"] is True
    assert report["players"] == 2  # Identical display names never merge IDs.
    assert report["player_game_rows"] == 9  # Anonymous rows remain facts.
    assert report["game_metrics"] == 39
    assert report["game_metric_checks"] == 5 * len(GAME_METRICS)
    assert report["game_periods"] == {"2025": {"season_total": True, "weeks": [1, 2]},
                                       "2026": {"season_total": True, "weeks": [1]}}
    assert report["historical_seasons"] == [2024, 2025]
    assert report["historical_metric_checks"] == 8
    assert report["stored_payload_metadata_matches"] is True
    assert report["metadata_limitations"] == []
    assert conn.transactions == [{"force_rollback": True}]
    assert conn.commands[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
    assert ("SET LOCAL statement_timeout = '60s'", ()) in conn.commands
    assert len(conn.cursors) == 11  # Five fact reads, five game periods, one history batch.
    assert len({cursor.name for cursor in conn.cursors}) == 11
    assert all(cursor.name.startswith("ob_stats_verify_") and cursor.itersize == 1000
               and cursor.closed for cursor in conn.cursors)
    assert [cursor.params for cursor in conn.cursors[:5]] == [(5,), (4,), (10,), (7,), (5,)]
    assert all("LIMIT %s" in cursor.query for cursor in conn.cursors)
    aggregate_queries = [query for query, _ in conn.commands if "GROUP BY" in query]
    assert len(aggregate_queries) == 6
    assert len([query for query in aggregate_queries if "GROUP BY player_id" in query]) == 5
    assert report["game_metric_checks"] + report["historical_metric_checks"] == 203
    json.dumps(report)  # CLI output must not contain datetime/Decimal objects.


@pytest.mark.parametrize("fault", [None, "last_fact", "extra_row"])
def test_offline_bulk_reads_preserve_parity_across_batches(snapshots, monkeypatch, fault):
    monkeypatch.setattr(stats_verification, "BULK_BATCH_SIZE", 2)
    conn = ArchiveConnection(snapshots)
    if fault == "last_fact":
        conn.player_games[-1][8]["receiving_yards"] = 999
    elif fault == "extra_row":
        conn.player_games.append(deepcopy(conn.player_games[0]))
    if fault:
        message = "fact mismatch" if fault == "last_fact" else "duplicate current row"
        with pytest.raises(ValueError, match=message):
            verify_database(conn, snapshots)
    else:
        assert verify_database(conn, snapshots)["verified"] is True
        assert [cursor.batches for cursor in conn.cursors[:5]] == [
            [2, 2], [2, 1], [2, 2, 2, 2, 1], [2, 2, 2], [2, 2],
        ]
        assert [cursor.batches for cursor in conn.cursors[5:]] == [[2]] * 6
    assert all(cursor.closed and max(cursor.batches) <= 2 for cursor in conn.cursors)


@pytest.mark.parametrize("phase", ["execute", "fetch"])
def test_offline_bulk_cursor_closes_and_propagates_failure(snapshots, monkeypatch, phase):
    monkeypatch.setattr(stats_verification, "BULK_BATCH_SIZE", 2)
    original_iter = ArchiveCursor.__iter__

    def fail_execute(self, query, params):
        raise RuntimeError("synthetic cursor execution failure")

    def fail_fetch(self):
        for index, row in enumerate(original_iter(self)):
            if index == 2:
                raise RuntimeError("synthetic cursor fetch failure")
            yield row

    monkeypatch.setattr(ArchiveCursor, "execute" if phase == "execute" else "__iter__",
                        fail_execute if phase == "execute" else fail_fetch)
    conn = ArchiveConnection(snapshots)
    with pytest.raises(RuntimeError, match="synthetic cursor"):
        verify_database(conn, snapshots)
    assert len(conn.cursors) == 1 and conn.cursors[0].closed
    assert conn.transactions == [{"force_rollback": True}]
    if phase == "fetch":
        assert conn.cursors[0].batches == [2, 2]


@pytest.mark.parametrize("mutation, message", [
    (lambda c: c.player_games[1][8].update(passing_yards=None), "Player games: fact mismatch"),
    (lambda c: c.player_games[0][8].update(def_sacks=True), "Player games: fact mismatch"),
    (lambda c: c.player_games[0][8].update(fg_made_list="44;27"), "Player games: fact mismatch"),
    (lambda c: c.player_games[0].__setitem__(4, "Different Player"), "Player games: fact mismatch"),
    (lambda c: c.player_games[2].__setitem__(3, "00-0000001"), "Player games: fact mismatch"),
    (lambda c: c.team_games[0][4].update(passing_yards=999), "Team games: fact mismatch"),
    (lambda c: c.player_seasons[0].__setitem__(4, "BUF"), "Player seasons: fact mismatch"),
    (lambda c: c.player_seasons[0][6].update(fumbles_total=0), "Player seasons: fact mismatch"),
    (lambda c: c.games[0][7].update(home_score=999), "Games: fact mismatch"),
    (lambda c: c.player_games.pop(), "current row identities differ"),
    (lambda c: c.player_games.append(deepcopy(c.player_games[0])), "duplicate current row"),
    (lambda c: c.heads.pop(), "Current snapshot heads"),
    (lambda c: c.heads[0].__setitem__(7, False), "no matching source observation"),
    (lambda c: c.heads[0].__setitem__(4, "0" * 64), "Current head differs"),
    (lambda c: c.heads[0].__setitem__(3, c.heads[0][3] + timedelta(days=1)), "Current head differs"),
    (lambda c: c.heads[1][6]["players"][0].__setitem__(9, 999), "Stored source payload"),
    (lambda c: c.player_ids.remove(("00-0000001",)), "Stable player identities"),
])
def test_offline_corruption_is_rejected_before_a_success_report(snapshots, mutation, message):
    conn = ArchiveConnection(snapshots)
    mutation(conn)
    with pytest.raises(ValueError, match=message):
        verify_database(conn, snapshots)


@pytest.mark.parametrize("key, override, message", [
    ((2025, None, "passing_yards"), {"00-0000001": Decimal("999")}, "Game totals"),
    ((2025, 2, "fg_long"), {"00-0000001": Decimal("97")}, "Game totals"),
    ((2026, 1, "def_sacks"), {"00-0000002": Decimal("0")}, "Game totals"),
    (("history", "passing_yards"), {2024: Decimal("999")}, "Historical totals"),
    (("history", "fumbles_total"), {2024: Decimal("0")}, "Historical totals"),
])
def test_offline_sql_aggregates_are_independently_checked(snapshots, key, override, message):
    conn = ArchiveConnection(snapshots)
    conn.aggregate_overrides[key] = override
    with pytest.raises(ValueError, match=message):
        verify_database(conn, snapshots)


@pytest.mark.parametrize("group", ["player_id", "season"])
@pytest.mark.parametrize("fault", [None, "missing", "extra", "duplicate", "last_value", "fetch_error"])
def test_offline_aggregate_batches_preserve_identities_values_and_cleanup(snapshots, monkeypatch, group, fault):
    monkeypatch.setattr(stats_verification, "BULK_BATCH_SIZE", 1)
    original_execute, original_iter = ArchiveCursor.execute, ArchiveCursor.__iter__

    def change_rows(cursor, query, params):
        original_execute(cursor, query, params)
        if f"GROUP BY {group}" not in query:
            return
        assert params[-1] == 3  # Two independently expected IDs/seasons plus one extra.
        if fault == "missing":
            cursor.rows.pop()
        elif fault == "extra":
            identity = "00-9999999" if group == "player_id" else 2099
            cursor.rows.append((identity, *cursor.rows[-1][1:]))
        elif fault == "duplicate":
            cursor.rows.append(cursor.rows[-1])
        elif fault == "last_value":
            cursor.rows[-1] = (*cursor.rows[-1][:-1], Decimal("999"))

    def fail_fetch(cursor):
        for index, row in enumerate(original_iter(cursor)):
            if fault == "fetch_error" and f"GROUP BY {group}" in cursor.query and index == 1:
                raise RuntimeError("synthetic aggregate fetch failure")
            yield row

    monkeypatch.setattr(ArchiveCursor, "execute", change_rows)
    monkeypatch.setattr(ArchiveCursor, "__iter__", fail_fetch)
    conn = ArchiveConnection(snapshots)
    if fault == "fetch_error":
        with pytest.raises(RuntimeError, match="aggregate fetch failure"):
            verify_database(conn, snapshots)
    elif fault:
        with pytest.raises(ValueError, match="aggregate (identities differ|mismatch)|duplicate aggregate"):
            verify_database(conn, snapshots)
    else:
        assert verify_database(conn, snapshots)["verified"]
        assert [cursor.batches for cursor in conn.cursors[5:]] == [[1, 1]] * 6
    assert all(cursor.closed and max(cursor.batches) <= 1 for cursor in conn.cursors)
    assert conn.transactions == [{"force_rollback": True}]


def test_offline_aggregate_query_count_depends_on_periods_not_metric_count(snapshots, monkeypatch):
    for metrics in (("passing_yards", "fg_long"), GAME_METRICS):
        monkeypatch.setattr(stats_verification, "GAME_METRICS", metrics)
        conn = ArchiveConnection(snapshots)
        result = verify_database(conn, snapshots)
        assert result["game_metric_checks"] == 5 * len(metrics)
        assert len([query for query, _ in conn.commands if "GROUP BY" in query]) == 6
        game_queries = [(query, params) for query, params in conn.commands if "GROUP BY player_id" in query]
        assert all(all(metric not in query for metric in metrics) and params[:-4] == metrics
                   for query, params in game_queries)


@pytest.mark.parametrize("metrics", [(), ("passing_yards", "passing_yards"), ("not_an_allowed_metric",)])
def test_offline_aggregate_projection_rejects_unsupported_metrics(metrics):
    with pytest.raises(ValueError, match="Unsupported aggregate"):
        stats_verification._aggregate_columns(metrics)


@pytest.mark.parametrize("dataset", ["game", "player_history"])
def test_offline_same_content_reobservation_reports_missing_metadata(snapshots, dataset):
    conn = ArchiveConnection(snapshots)
    index = next(i for i, s in enumerate(snapshots) if s.dataset == dataset)
    original = snapshots[index]
    later = deepcopy(original.payload)
    later["updated_at" if dataset == "game" else "generated_at"] = (
        original.source_updated_at + timedelta(days=1)).isoformat()
    if dataset == "game":
        later["sources"]["players"]["retrieved_at"] = later["updated_at"]
    snapshots[index] = prepare_snapshot(later, original.source_path)
    conn.heads[index][3] = snapshots[index].source_updated_at
    report = verify_database(conn, snapshots)
    assert report["verified"] is True
    assert report["stored_payload_metadata_matches"] is False
    assert report["metadata_limitations"] == [{
        "dataset": dataset, "object_key": original.object_key,
        "stored_source_at": original.source_updated_at.isoformat(),
        "current_source_at": snapshots[index].source_updated_at.isoformat(),
        "reason": "The stored content matches, but the full metadata of this observation was not retained."
    }]


def test_offline_formatting_and_object_key_order_do_not_affect_parity(snapshots):
    conn = ArchiveConnection(snapshots)
    saved = snapshots[1]
    reordered = dict(reversed(list(saved.payload.items())))
    snapshots[1] = prepare_snapshot(reordered, saved.source_path, json.dumps(reordered, indent=4).encode())
    assert snapshots[1].file_hash != saved.file_hash
    report = verify_database(conn, snapshots)
    assert report["stored_payload_metadata_matches"] is True


def test_offline_transaction_guard_and_input_guard(snapshots):
    conn = ArchiveConnection(snapshots)
    conn.info.transaction_status.name = "INTRANS"
    conn.isolation = "read committed"
    with pytest.raises(ValueError, match="REPEATABLE READ"):
        verify_database(conn, snapshots)
    assert len(conn.commands) == 1
    conn.isolation = "repeatable read"
    assert verify_database(conn, snapshots)["verified"]
    assert ("SET LOCAL transaction_read_only = on", ()) in conn.commands
    with pytest.raises(ValueError, match="nonempty"):
        verify_database(conn, [])
    with pytest.raises(ValueError, match="unique"):
        verify_database(conn, [snapshots[0], snapshots[0]])


@pytest.fixture
def postgres():
    url = os.environ.get("OUTLIER_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Real PostgreSQL test database not configured")
    target = urlsplit(url)
    if target.hostname not in {"127.0.0.1", "localhost", "::1"} or target.path != "/outlier_test" or target.query:
        pytest.fail("Tests require a disposable loopback database named outlier_test")
    import psycopg
    with psycopg.connect(url, autocommit=True) as connection:
        with connection.transaction(force_rollback=True):
            connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            migrate(connection)
            yield connection


def test_postgres_entire_saved_archive_parity_and_readonly_settings_restore(postgres):
    saved = load_saved_stats(ROOT)
    import_snapshots(postgres, saved)
    report = verify_database(postgres, saved)
    assert report["verified"]
    assert report["stored_payload_metadata_matches"]
    assert report["player_game_rows"] == sum(len(s.player_games) for s in saved)
    assert report["player_season_rows"] == sum(len(s.player_seasons) for s in saved)
    assert postgres.execute("SHOW transaction_read_only").fetchone() == ("off",)
    assert postgres.execute("SELECT count(*) FROM pg_cursors WHERE name LIKE 'ob_stats_verify_%'").fetchone() == (0,)
    assert import_snapshots(postgres, saved)["inserted"] == 0


def test_postgres_batched_aggregates_match_unchanged_single_metric_queries(postgres, snapshots):
    prepared = []
    for saved in snapshots:
        payload = deepcopy(saved.payload)
        if saved.dataset == "game":
            payload["players"][0][payload["player_columns"].index("receiving_yards")] = -payload["game"]["week"]
        else:
            payload["columns"] += ["fg_long", "def_sacks"]
            for index, player in enumerate(payload["players"].values()):
                for cells in player["seasons"]:
                    cells.extend([40 + index, 0.5 if index == 0 else None])
        prepared.append(prepare_snapshot(payload, saved.source_path))
    import_snapshots(postgres, prepared)
    postgres.execute("SET LOCAL ROLE ob_stats_ingest")
    with stats_verification._read_snapshot(postgres):
        for season, week in ((2025, None), (2025, 1), (2025, 2), (2026, None), (2026, 1)):
            batched = stats_verification._game_totals_batch(postgres, season, week, 2)
            for metric in GAME_METRICS:
                assert batched[metric] == game_stat_totals(postgres, season, metric, week)
            assert set(batched["passing_yards"]) == {"00-0000001", "00-0000002"}
            assert batched["passing_yards"]["00-0000002"] == 0
            assert batched["def_sacks"]["00-0000002"] is None
            assert batched["receiving_yards"]["00-0000001"] < 0
        season = stats_verification._game_totals_batch(postgres, 2025, None, 2)
        assert season["passing_yards"]["00-0000001"] == 30
        assert season["fg_long"]["00-0000001"] == 49
        assert season["def_sacks"]["00-0000001"] == 1
        assert stats_verification._game_totals_batch(postgres, 2025, 1, 2)["def_sacks"]["00-0000001"] == 0.5
        history_metrics = ("games", "passing_yards", "passing_interceptions", "fumbles_total", "fg_long", "def_sacks")
        history = stats_verification._history_totals_batch(postgres, history_metrics, 2)
        for metric in history_metrics:
            reducer = "MAX" if metric == "fg_long" else "SUM"
            query = "SELECT season, " + reducer + """((stats->>%s)::numeric)
                FROM ob_stats.current_player_season_stats GROUP BY season ORDER BY season"""
            assert history[metric] == dict(postgres.execute(query, (metric,)).fetchall())
        assert history["fg_long"] == {2024: 41, 2025: 41}
        assert history["def_sacks"] == {2024: Decimal("0.5"), 2025: Decimal("0.5")}
        assert history["fumbles_total"] == {2024: None, 2025: 0}
    assert verify_database(postgres, prepared)["verified"]
    assert postgres.execute("SHOW transaction_read_only").fetchone() == ("off",)
    assert postgres.execute("SELECT count(*) FROM pg_cursors WHERE name LIKE 'ob_stats_verify_%'").fetchone() == (0,)


def test_postgres_current_head_and_later_observation_metadata(postgres, snapshots):
    import_snapshots(postgres, snapshots)
    original = snapshots[1]
    payload = deepcopy(original.payload)
    payload["updated_at"] = (original.source_updated_at + timedelta(days=1)).isoformat()
    payload["sources"]["players"]["retrieved_at"] = payload["updated_at"]
    updated = prepare_snapshot(payload, original.source_path)
    import_snapshots(postgres, [updated])
    with pytest.raises(ValueError, match="Current head differs"):
        verify_database(postgres, snapshots)
    snapshots[1] = updated
    report = verify_database(postgres, snapshots)
    assert len(report["metadata_limitations"]) == 1
    assert not report["stored_payload_metadata_matches"]


@pytest.mark.parametrize("query, message", [
    ("""UPDATE ob_stats.player_game_stats SET stats = jsonb_set(stats, '{passing_yards}', 'null'::jsonb)
        WHERE player_id = '00-0000002'""", "Player games: fact mismatch"),
    ("""UPDATE ob_stats.team_game_stats SET stats = jsonb_set(stats, '{fg_made_list}', '\"44;27\"'::jsonb)
        WHERE team = 'NE'""", "Team games: fact mismatch"),
    ("""UPDATE ob_stats.player_season_stats SET recent_team = 'BUF'
        WHERE player_id = '00-0000001'""", "Player seasons: fact mismatch"),
])
def test_postgres_equal_counts_cannot_hide_corrupted_facts(postgres, snapshots, query, message):
    import_snapshots(postgres, snapshots)
    postgres.execute(query)
    with pytest.raises(ValueError, match=message):
        verify_database(postgres, snapshots)
