-- Private, additive shadow storage. No public API grants or live-site cutover.
CREATE TABLE ob_stats.source_snapshots (
    snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset text NOT NULL CHECK (dataset IN ('game', 'player_history')),
    object_key text NOT NULL,
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    source_path text NOT NULL,
    source_updated_at timestamptz NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    UNIQUE (dataset, object_key, content_sha256),
    UNIQUE (dataset, object_key, snapshot_id)
);
CREATE TABLE ob_stats.snapshot_heads (
    dataset text NOT NULL,
    object_key text NOT NULL,
    snapshot_id bigint NOT NULL,
    latest_source_at timestamptz NOT NULL,
    PRIMARY KEY (dataset, object_key),
    FOREIGN KEY (dataset, object_key, snapshot_id)
        REFERENCES ob_stats.source_snapshots(dataset, object_key, snapshot_id)
);
CREATE TABLE ob_stats.snapshot_observations (
    observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    snapshot_id bigint NOT NULL REFERENCES ob_stats.source_snapshots(snapshot_id),
    source_updated_at timestamptz NOT NULL,
    file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (snapshot_id, source_updated_at, file_sha256)
);
CREATE TABLE ob_stats.players (
    player_id text PRIMARY KEY CHECK (player_id ~ '^00-[0-9]{7}$'),
    display_name text NOT NULL,
    birth_date date,
    source_updated_at timestamptz NOT NULL,
    birth_source_at timestamptz,
    CHECK ((birth_date IS NULL) = (birth_source_at IS NULL))
);
CREATE TABLE ob_stats.games (
    game_id text PRIMARY KEY CHECK (game_id ~ '^[0-9]{4}_[0-9]{2}_[A-Z]{2,3}_[A-Z]{2,3}$'),
    season integer NOT NULL CHECK (season BETWEEN 1900 AND 2200),
    season_type text NOT NULL CHECK (season_type = 'REG'),
    week integer NOT NULL CHECK (week BETWEEN 1 AND 18),
    home_team text NOT NULL,
    away_team text NOT NULL,
    CHECK (home_team <> away_team)
);
CREATE TABLE ob_stats.game_revisions (
    snapshot_id bigint PRIMARY KEY REFERENCES ob_stats.source_snapshots(snapshot_id),
    game_id text NOT NULL REFERENCES ob_stats.games(game_id),
    metadata jsonb NOT NULL,
    UNIQUE (snapshot_id, game_id)
);
CREATE TABLE ob_stats.player_game_stats (
    snapshot_id bigint NOT NULL,
    game_id text NOT NULL,
    row_key text NOT NULL,
    player_id text REFERENCES ob_stats.players(player_id),
    player_name text,
    team text NOT NULL,
    opponent_team text NOT NULL,
    position text,
    stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    PRIMARY KEY (snapshot_id, row_key),
    FOREIGN KEY (snapshot_id, game_id) REFERENCES ob_stats.game_revisions(snapshot_id, game_id)
);
CREATE UNIQUE INDEX one_named_player_per_game_revision
    ON ob_stats.player_game_stats(snapshot_id, player_id) WHERE player_id IS NOT NULL;
CREATE INDEX player_game_history ON ob_stats.player_game_stats(player_id, game_id);
CREATE TABLE ob_stats.team_game_stats (
    snapshot_id bigint NOT NULL,
    game_id text NOT NULL,
    team text NOT NULL,
    opponent_team text NOT NULL,
    stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    PRIMARY KEY (snapshot_id, team),
    FOREIGN KEY (snapshot_id, game_id) REFERENCES ob_stats.game_revisions(snapshot_id, game_id)
);
CREATE TABLE ob_stats.player_season_stats (
    snapshot_id bigint NOT NULL REFERENCES ob_stats.source_snapshots(snapshot_id),
    player_id text NOT NULL REFERENCES ob_stats.players(player_id),
    season integer NOT NULL CHECK (season BETWEEN 1900 AND 2200),
    season_type text NOT NULL CHECK (season_type = 'REG'),
    recent_team text,
    position text NOT NULL,
    stats jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    PRIMARY KEY (snapshot_id, player_id, season, season_type)
);
CREATE INDEX player_season_history ON ob_stats.player_season_stats(player_id, season);

CREATE VIEW ob_stats.current_games WITH (security_invoker = true) AS
SELECT g.*, r.snapshot_id, r.metadata
FROM ob_stats.games g
JOIN ob_stats.game_revisions r USING (game_id)
JOIN ob_stats.snapshot_heads h ON h.snapshot_id = r.snapshot_id AND h.dataset = 'game';

CREATE VIEW ob_stats.current_player_game_stats WITH (security_invoker = true) AS
SELECT p.*, g.season, g.week, g.season_type,
       (p.stats->>'passing_yards')::numeric AS passing_yards,
       (p.stats->>'passing_tds')::numeric AS passing_tds,
       (p.stats->>'rushing_yards')::numeric AS rushing_yards,
       (p.stats->>'rushing_tds')::numeric AS rushing_tds,
       (p.stats->>'receptions')::numeric AS receptions,
       (p.stats->>'receiving_yards')::numeric AS receiving_yards,
       (p.stats->>'receiving_tds')::numeric AS receiving_tds,
       (p.stats->>'def_sacks')::numeric AS sacks,
       (p.stats->>'fantasy_points_ppr')::numeric AS fantasy_points_ppr
FROM ob_stats.player_game_stats p JOIN ob_stats.current_games g USING (snapshot_id, game_id);

CREATE VIEW ob_stats.current_team_game_stats WITH (security_invoker = true) AS
SELECT t.*, g.season, g.week, g.season_type
FROM ob_stats.team_game_stats t JOIN ob_stats.current_games g USING (snapshot_id, game_id);

CREATE VIEW ob_stats.current_player_season_stats WITH (security_invoker = true) AS
SELECT p.*,
       (p.stats->>'games')::numeric AS games,
       (p.stats->>'passing_yards')::numeric AS passing_yards,
       (p.stats->>'passing_tds')::numeric AS passing_tds,
       (p.stats->>'rushing_yards')::numeric AS rushing_yards,
       (p.stats->>'rushing_tds')::numeric AS rushing_tds,
       (p.stats->>'receptions')::numeric AS receptions,
       (p.stats->>'receiving_yards')::numeric AS receiving_yards,
       (p.stats->>'receiving_tds')::numeric AS receiving_tds
FROM ob_stats.player_season_stats p
JOIN ob_stats.snapshot_heads h ON h.snapshot_id = p.snapshot_id AND h.dataset = 'player_history';

-- Tables remain inaccessible to browser roles even if this schema is
-- accidentally added to Supabase's exposed schemas. Imports use the owner.
ALTER TABLE ob_stats.source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.snapshot_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.snapshot_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.game_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.player_game_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.team_game_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_stats.player_season_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA ob_stats FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ob_stats FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ob_stats FROM PUBLIC;
DO $$
DECLARE browser_role text;
BEGIN
    FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA ob_stats FROM %I', browser_role);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ob_stats FROM %I', browser_role);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ob_stats FROM %I', browser_role);
        END IF;
    END LOOP;
END $$;
