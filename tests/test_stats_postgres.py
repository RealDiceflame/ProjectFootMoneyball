"""Real PostgreSQL tests; only an explicitly configured loopback test DB is allowed."""
from copy import deepcopy
from datetime import timedelta
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
import pytest

from app.league_leaders import MAXIMUM_STATS, STAT_GROUPS
from app.stats_import import load_saved_stats, prepare_snapshot
from app.stats_database import database_counts, game_stat_totals, import_snapshots, migrate

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def conn():
    url = os.environ.get("OUTLIER_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Real PostgreSQL test database not configured")
    target = urlsplit(url)
    if target.hostname not in {"127.0.0.1", "localhost", "::1"} or target.path != "/outlier_test" or target.query:
        pytest.fail("Tests require a disposable loopback database named outlier_test")
    import psycopg
    with psycopg.connect(url, autocommit=True) as connection:
        # Even schema creation is rolled back after each test; no DROP or DELETE.
        with connection.transaction(force_rollback=True):
            migrate(connection)
            yield connection


@pytest.fixture
def snapshots():
    return load_saved_stats(ROOT)


def test_real_archive_import_is_repeatable_and_all_metric_totals_match(conn, snapshots):
    assert import_snapshots(conn, snapshots)["inserted"] == len(snapshots)
    counts = database_counts(conn)
    assert counts["games"] == sum(s.dataset == "game" for s in snapshots)
    assert counts["player_season_rows"] == sum(len(s.player_seasons) for s in snapshots)
    assert counts["player_game_rows"] == sum(len(s.player_games) for s in snapshots)
    assert counts["team_game_rows"] == sum(len(s.team_games) for s in snapshots)
    assert counts["players"] == len({p["player_id"] for s in snapshots for p in s.players})
    assert import_snapshots(conn, snapshots)["inserted"] == 0
    assert database_counts(conn) == counts
    games = [s for s in snapshots if s.dataset == "game" and s.payload["season"] == 2026]
    for metric in [key for fields in STAT_GROUPS.values() for key in fields]:
        for week in (None, 1):
            expected = {}
            for snapshot in games:
                if week is not None and snapshot.payload["game"]["week"] != week:
                    continue
                for row in snapshot.player_games:
                    player = row["player_id"]
                    if not player:
                        continue
                    expected.setdefault(player, None)
                    value = row["stats"].get(metric)
                    if value is None:
                        continue
                    prior = expected[player]
                    expected[player] = max(prior, value) if metric in MAXIMUM_STATS and prior is not None else value if prior is None else prior + value
            actual = game_stat_totals(conn, 2026, metric, week)
            assert actual.keys() == expected.keys(), metric
            for player in actual:
                if expected[player] is None:
                    assert actual[player] is None
                else:
                    assert actual[player] == pytest.approx(expected[player]), (metric, player)


def test_corrections_replace_current_rows_without_erasing_versions(conn, snapshots):
    original = next(s for s in snapshots if s.dataset == "game")
    import_snapshots(conn, [original])
    changed = deepcopy(original.payload)
    # Remove a credited player to exercise full-revision replacement, not upsert.
    removed_id = changed["players"][0][changed["player_columns"].index("player_id")]
    changed["players"].pop(0)
    changed["updated_at"] = (original.source_updated_at + timedelta(days=1)).isoformat()
    correction = prepare_snapshot(changed, original.source_path)
    import_snapshots(conn, [correction])
    assert conn.execute("SELECT count(*) FROM ob_stats.player_game_stats WHERE player_id=%s", (removed_id,)).fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM ob_stats.current_player_game_stats WHERE player_id=%s", (removed_id,)).fetchone()[0] == 0
    assert import_snapshots(conn, [original])["older_archived"] == 1
    assert database_counts(conn)["snapshots"] == 2
    assert database_counts(conn)["player_game_rows"] == len(correction.player_games)
    # A later correction can deliberately restore a previous content version.
    restored = deepcopy(original.payload);restored["updated_at"] = (original.source_updated_at + timedelta(days=2)).isoformat()
    import_snapshots(conn, [prepare_snapshot(restored, original.source_path)])
    assert database_counts(conn)["snapshots"] == 2
    assert database_counts(conn)["player_game_rows"] == len(original.player_games)
    assert conn.execute("SELECT count(*) FROM ob_stats.snapshot_observations").fetchone()[0] == 3
    changed["game"]["home_score"] = (changed["game"]["home_score"] or 0) + 1
    with pytest.raises(ValueError, match="timestamp"):
        import_snapshots(conn, [prepare_snapshot(changed, original.source_path)])


def test_conflict_rolls_back_entire_batch_and_migrations_are_immutable(conn, snapshots):
    first, second = [s for s in snapshots if s.dataset == "game"][:2]
    import_snapshots(conn, [first]);before=database_counts(conn)
    conflict = deepcopy(first.payload)
    conflict["game"]["home_score"] = (conflict["game"]["home_score"] or 0) + 1
    with pytest.raises(ValueError, match="timestamp"):
        import_snapshots(conn, [second, prepare_snapshot(conflict, first.source_path)])
    assert database_counts(conn) == before
    assert migrate(conn) == []
    conn.execute("UPDATE ob_stats.schema_migrations SET checksum='changed'")
    with pytest.raises(ValueError, match="migration has changed"):
        migrate(conn)


def test_reused_snapshots_restore_identity_and_correct_birth_dates(conn, snapshots):
    original = next(s for s in snapshots if s.dataset == "player_history")
    payload = deepcopy(original.payload)
    key = next(iter(payload["players"]))
    player = payload["players"][key]
    player_id, original_name = player["player_id"], player["player"]
    import_snapshots(conn, [original])
    player["player"] = "Corrected Name"
    player["birth_date"] = "1997-01-02"
    payload["generated_at"] = (original.source_updated_at + timedelta(days=1)).isoformat()
    changed = prepare_snapshot(payload, original.source_path)
    import_snapshots(conn, [changed])
    assert conn.execute("SELECT display_name, birth_date::text FROM ob_stats.players WHERE player_id=%s", (player_id,)).fetchone() == ("Corrected Name", "1997-01-02")
    restored = deepcopy(original.payload)
    restored["generated_at"] = (original.source_updated_at + timedelta(days=2)).isoformat()
    import_snapshots(conn, [prepare_snapshot(restored, original.source_path)])
    assert conn.execute("SELECT display_name FROM ob_stats.players WHERE player_id=%s", (player_id,)).fetchone()[0] == original_name
    import_snapshots(conn, [changed])  # An older observation must not re-apply its name.
    assert conn.execute("SELECT display_name FROM ob_stats.players WHERE player_id=%s", (player_id,)).fetchone()[0] == original_name


def test_private_schema_and_raw_nulls_are_preserved(conn, snapshots):
    import_snapshots(conn, snapshots)
    anonymous = conn.execute("SELECT stats FROM ob_stats.current_player_game_stats WHERE player_id IS NULL").fetchone()
    assert anonymous is not None
    assert conn.execute("SELECT count(*) FROM ob_stats.players WHERE display_name='Josh Johnson'").fetchone()[0] == 2
    assert not conn.execute("SELECT has_schema_privilege('public','ob_stats','USAGE')").fetchone()[0]
    tables = conn.execute("""SELECT relname, relrowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='ob_stats' AND c.relkind='r' AND relname <> 'schema_migrations'""").fetchall()
    assert tables and all(rls for _, rls in tables)
