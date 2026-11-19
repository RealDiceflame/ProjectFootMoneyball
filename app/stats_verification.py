"""Read-only parity checks for the optional statistics database.

This checks the complete supplied archive against the database's current heads.
It does not export, publish, or change the website's data source.
"""
from contextlib import contextmanager
from decimal import Decimal
import math
from uuid import uuid4

from app.league_leaders import MAXIMUM_STATS, STAT_GROUPS
from app.stats_import import import_plan, prepare_snapshot


GAME_METRICS = tuple(sorted({key for group in STAT_GROUPS.values() for key in group}))
HISTORY_METRICS = frozenset(GAME_METRICS) | {"games", "passing_interceptions", "fumbles_total"}
BULK_BATCH_SIZE = 1000


@contextmanager
def _read_snapshot(conn):
    """Use one database snapshot and roll back local settings on every exit.

An existing transaction must already provide a repeatable snapshot. This also
allows isolated integration tests to verify their own uncommitted fixture data.
"""
    status = conn.info.transaction_status.name
    if status not in {"IDLE", "INTRANS"}:
        raise ValueError("Verification requires an idle connection or a healthy transaction")
    with conn.transaction(force_rollback=True):
        if status == "IDLE":
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        else:
            isolation = conn.execute("SHOW transaction_isolation").fetchone()[0]
            if isolation not in {"repeatable read", "serializable"}:
                raise ValueError("Existing verification transactions must use REPEATABLE READ or SERIALIZABLE")
            conn.execute("SET LOCAL transaction_read_only = on")
        conn.execute("SET LOCAL statement_timeout = '60s'")
        conn.execute("SET LOCAL lock_timeout = '10s'")
        yield


def _bulk_rows(conn, query, params):
    """Transfer bounded batches within the caller's read-only snapshot.

    Each server-cursor FETCH retains the existing statement timeout. The SQL
    LIMIT still bounds the complete result, which parity checks need in memory.
    """
    with conn.cursor(name=f"ob_stats_verify_{uuid4().hex}") as cursor:
        cursor.itersize = BULK_BATCH_SIZE
        cursor.execute(query, params)
        return list(cursor)


def _same(left, right):
    """JSON semantic equality, keeping booleans, nulls and ordered lists distinct."""
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(_same(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)) and isinstance(right, (list, tuple)):
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float, Decimal)) and isinstance(right, (int, float, Decimal)):
        return Decimal(str(left)) == Decimal(str(right))
    return type(left) is type(right) and left == right


def _check_rows(label, actual, expected, key_columns):
    indexed = {}
    for row in actual:
        key = tuple(row[:key_columns])
        if key in indexed:
            raise ValueError(f"{label}: duplicate current row {key}")
        indexed[key] = row[key_columns:]
    if indexed.keys() != expected.keys():
        missing = len(expected.keys() - indexed.keys())
        extra = len(indexed.keys() - expected.keys())
        raise ValueError(f"{label}: current row identities differ ({missing} missing, {extra} extra)")
    for key, values in expected.items():
        if not _same(indexed[key], values):
            raise ValueError(f"{label}: fact mismatch at {key}")


def _accumulate(prior, value, metric):
    if value is None:
        return prior
    value = Decimal(str(value))
    if prior is None:
        return value
    return max(prior, value) if metric in MAXIMUM_STATS else prior + value


def _expected_game_totals(games, season, metric, week):
    totals = {}
    for snapshot in games:
        if snapshot.payload["season"] != season or (
                week is not None and snapshot.payload["game"]["week"] != week):
            continue
        for row in snapshot.player_games:
            player_id = row["player_id"]
            if player_id is not None:
                totals[player_id] = _accumulate(totals.get(player_id), row["stats"].get(metric), metric)
    return totals


def _check_totals(label, actual, expected, *, floating=False):
    if actual.keys() != expected.keys():
        raise ValueError(f"{label}: aggregate identities differ")
    for key, value in expected.items():
        observed = actual[key]
        if value is None or observed is None:
            matches = value is None and observed is None
        elif floating:
            # game_stat_totals exposes SQL numeric results as floats. Exact fact
            # equality above already checks every original numeric value.
            matches = math.isclose(float(observed), float(value), rel_tol=1e-12, abs_tol=1e-9)
        else:
            matches = Decimal(str(observed)) == value
        if not matches:
            raise ValueError(f"{label}: aggregate mismatch at {key}")


def _aggregate_columns(metrics):
    if not metrics or len(set(metrics)) != len(metrics) or not set(metrics) <= HISTORY_METRICS:
        raise ValueError("Unsupported aggregate statistics")
    # Only fixed SUM/MAX keywords enter SQL; JSON field names remain parameters.
    return ", ".join(("MAX" if metric in MAXIMUM_STATS else "SUM") + "((stats->>%s)::numeric)"
                     for metric in metrics)


def _index_totals(label, rows, metrics, *, floating=False):
    totals = {metric: {} for metric in metrics}
    identities = set()
    for row in rows:
        if len(row) != len(metrics) + 1:
            raise ValueError(f"{label}: aggregate columns differ")
        identity, *values = row
        if identity in identities:
            raise ValueError(f"{label}: duplicate aggregate identity")
        identities.add(identity)
        for metric, value in zip(metrics, values):
            totals[metric][identity] = float(value) if floating and value is not None else value
    return totals


def _game_totals_batch(conn, season, week, expected_players):
    """Read every metric for one period in one bounded SQL aggregate query."""
    query = "SELECT player_id, " + _aggregate_columns(GAME_METRICS) + """
        FROM ob_stats.current_player_game_stats
        WHERE season = %s AND player_id IS NOT NULL AND (%s::integer IS NULL OR week = %s)
        GROUP BY player_id ORDER BY player_id LIMIT %s"""
    rows = _bulk_rows(conn, query, (*GAME_METRICS, season, week, week, expected_players + 1))
    return _index_totals("Game totals", rows, GAME_METRICS, floating=True)


def _history_totals_batch(conn, metrics, expected_seasons):
    query = "SELECT season, " + _aggregate_columns(metrics) + """
        FROM ob_stats.current_player_season_stats GROUP BY season ORDER BY season LIMIT %s"""
    rows = _bulk_rows(conn, query, (*metrics, expected_seasons + 1))
    return _index_totals("Historical totals", rows, metrics)


def _verify(conn, snapshots):
    expected_heads = {(s.dataset, s.object_key): s for s in snapshots}
    plan = import_plan(snapshots)
    heads = _bulk_rows(conn, """SELECT h.dataset, h.object_key, h.snapshot_id, h.latest_source_at,
            s.content_sha256, s.source_updated_at, s.payload,
            EXISTS (SELECT 1 FROM ob_stats.snapshot_observations o
                    WHERE o.snapshot_id = h.snapshot_id AND o.source_updated_at = h.latest_source_at)
        FROM ob_stats.snapshot_heads h
        JOIN ob_stats.source_snapshots s USING (snapshot_id)
        ORDER BY h.dataset, h.object_key LIMIT %s""", (len(snapshots) + 1,))
    if {(row[0], row[1]) for row in heads} != expected_heads.keys() or len(heads) != len(snapshots):
        raise ValueError("Current snapshot heads do not match the complete saved archive")

    ids, metadata_limitations = {}, []
    for dataset, key, snapshot_id, latest_at, content_hash, stored_at, payload, observed in heads:
        saved = expected_heads[dataset, key]
        if content_hash != saved.content_hash or latest_at != saved.source_updated_at:
            raise ValueError(f"Current head differs from saved source: {dataset}/{key}")
        if not observed:
            raise ValueError(f"Current head has no matching source observation: {dataset}/{key}")
        stored = prepare_snapshot(payload, saved.source_path)
        if (stored.dataset, stored.object_key, stored.content_hash, stored.source_updated_at) != (
                dataset, key, content_hash, stored_at):
            raise ValueError(f"Stored source payload does not match its identity/hash/time: {dataset}/{key}")
        if stored_at > latest_at:
            raise ValueError(f"Stored source payload is newer than its current head: {dataset}/{key}")
        ids[dataset, key] = snapshot_id
        if not _same(payload, saved.payload):
            metadata_limitations.append({
                "dataset": dataset, "object_key": key,
                "stored_source_at": stored_at.isoformat(), "current_source_at": latest_at.isoformat(),
                "reason": "The stored content matches, but the full metadata of this observation was not retained."
            })

    games, player_games, team_games, player_seasons = {}, {}, {}, {}
    for snapshot in snapshots:
        snapshot_id = ids[snapshot.dataset, snapshot.object_key]
        if snapshot.dataset == "game":
            game = snapshot.payload["game"]
            common = (snapshot.payload["season"], game["week"], "REG")
            games[snapshot.object_key, snapshot_id] = (
                *common, game["home"], game["away"], game)
            for row in snapshot.player_games:
                player_games[snapshot_id, snapshot.object_key, row["row_key"]] = (
                    row["player_id"], row["player_name"], row["team"], row["opponent_team"],
                    row["position"], row["stats"], *common)
            for row in snapshot.team_games:
                team_games[snapshot_id, snapshot.object_key, row["team"]] = (
                    row["opponent_team"], row["stats"], *common)
        else:
            for row in snapshot.player_seasons:
                player_seasons[snapshot_id, row["player_id"], row["season"], "REG"] = (
                    row["recent_team"], row["position"], row["stats"])

    # LIMIT expected+1 detects extra current rows without scanning an unbounded
    # result into Python. Historical versions remain deliberately out of scope.
    for label, query, expected, key_columns in (
        ("Games", """SELECT game_id, snapshot_id, season, week, season_type, home_team, away_team, metadata
            FROM ob_stats.current_games LIMIT %s""", games, 2),
        ("Player games", """SELECT snapshot_id, game_id, row_key, player_id, player_name, team,
            opponent_team, position, stats, season, week, season_type
            FROM ob_stats.current_player_game_stats LIMIT %s""", player_games, 3),
        ("Team games", """SELECT snapshot_id, game_id, team, opponent_team, stats, season, week, season_type
            FROM ob_stats.current_team_game_stats LIMIT %s""", team_games, 3),
        ("Player seasons", """SELECT snapshot_id, player_id, season, season_type, recent_team, position, stats
            FROM ob_stats.current_player_season_stats LIMIT %s""", player_seasons, 4),
    ):
        _check_rows(label, _bulk_rows(conn, query, (len(expected) + 1,)), expected, key_columns)

    player_ids = {p["player_id"] for snapshot in snapshots for p in snapshot.players}
    existing_ids = {row[0] for row in conn.execute(
        "SELECT player_id FROM ob_stats.players WHERE player_id = ANY(%s)", (sorted(player_ids),)).fetchall()}
    if existing_ids != player_ids:
        raise ValueError("Stable player identities referenced by the archive are missing")

    game_snapshots = [s for s in snapshots if s.dataset == "game"]
    seasons = sorted({s.payload["season"] for s in game_snapshots})
    game_checks, periods = 0, {}
    for season in seasons:
        weeks = sorted({s.payload["game"]["week"] for s in game_snapshots if s.payload["season"] == season})
        periods[str(season)] = {"season_total": True, "weeks": weeks}
        for week in (None, *weeks):
            expected = {metric: _expected_game_totals(game_snapshots, season, metric, week)
                        for metric in GAME_METRICS}
            actual = _game_totals_batch(conn, season, week, len(expected[GAME_METRICS[0]]))
            for metric in GAME_METRICS:
                _check_totals(f"Game totals {season}/{week}/{metric}", actual[metric], expected[metric], floating=True)
                game_checks += 1

    history_rows = [row for s in snapshots for row in s.player_seasons]
    history_seasons = sorted({row["season"] for row in history_rows})
    history_fields = {key for row in history_rows for key in row["stats"]}
    history_metrics = sorted(history_fields & HISTORY_METRICS)
    history_totals = _history_totals_batch(conn, history_metrics, len(history_seasons)) if history_metrics else {}
    for metric in history_metrics:
        expected = {season: None for season in history_seasons}
        for row in history_rows:
            expected[row["season"]] = _accumulate(expected[row["season"]], row["stats"].get(metric), metric)
        _check_totals(f"Historical totals {metric}", history_totals[metric], expected)

    return {
        "verified": True, "scope": "complete saved archive versus current database heads",
        **plan, "game_metrics": len(GAME_METRICS), "game_metric_checks": game_checks,
        "game_periods": periods, "historical_seasons": history_seasons,
        "historical_metrics": history_metrics,
        "historical_metric_checks": len(history_seasons) * len(history_metrics),
        "historical_fields_checked_as_facts_only": sorted(history_fields - HISTORY_METRICS),
        "stored_payload_metadata_matches": not metadata_limitations,
        "metadata_limitations": metadata_limitations,
        "limitations": [
            "Index, schedule and summary artifacts are not verified or regenerated.",
            "Shared player names and birth dates follow archive-wide observation history; "
            "this check verifies stable IDs and the source-specific identities in facts and stored payloads.",
            "Semantic JSON parity does not assert original file formatting or byte-for-byte equality."
        ],
    }


def verify_database(conn, snapshots):
    """Return a JSON-compatible parity report; raise ValueError on any mismatch.

The inputs must be the complete intended current archive. An extra database
head is a mismatch, while archived non-current revisions are allowed. Missing
observation metadata is reported separately from statistical content parity.
No rows or files are written, even when a check fails.
"""
    snapshots = list(snapshots)
    if not snapshots or len({(s.dataset, s.object_key) for s in snapshots}) != len(snapshots):
        raise ValueError("Verification requires a nonempty archive with unique snapshot identities")
    with _read_snapshot(conn):
        return _verify(conn, snapshots)
