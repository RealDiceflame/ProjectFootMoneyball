-- Run these read-only queries in Supabase's SQL Editor after the first import.
-- These views select current revisions, not every historical correction.

-- Ten rushing-yard leaders in a chosen regular season and week window.
SELECT p.player_id, p.display_name, SUM(s.rushing_yards) AS rushing_yards
FROM ob_stats.current_player_game_stats s
JOIN ob_stats.players p USING (player_id)
WHERE s.season = 2026 AND s.week BETWEEN 1 AND 4
GROUP BY p.player_id, p.display_name
HAVING SUM(s.rushing_yards) <> 0
ORDER BY rushing_yards DESC, p.display_name, p.player_id
LIMIT 10;

-- A player's maintained historical seasons. Change the ID, not a name match.
SELECT season, position, recent_team, games, rushing_yards, receiving_yards
FROM ob_stats.current_player_season_stats
WHERE player_id = '00-0033280'
ORDER BY season;

-- Game-week coverage: do not assume a missing game has zero statistics.
SELECT season, week, COUNT(*) AS archived_games
FROM ob_stats.current_games
GROUP BY season, week
ORDER BY season, week;

-- Which versions of a game were actually observed during database imports?
SELECT s.object_key, s.content_sha256, o.source_updated_at, o.imported_at
FROM ob_stats.source_snapshots s
JOIN ob_stats.snapshot_observations o USING (snapshot_id)
WHERE s.dataset = 'game' AND s.object_key = '2026_01_NE_SEA'
ORDER BY o.imported_at, o.observation_id;
