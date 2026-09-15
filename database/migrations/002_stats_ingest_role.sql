-- Run as the schema owner with CREATEROLE. No password or LOGIN is set here.
-- A role name collision is never adopted, even if it currently looks harmless:
-- roles are cluster-wide and an existing role may belong to another database.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob_stats_ingest') THEN
        RAISE EXCEPTION 'ob_stats_ingest already exists; review its ownership and memberships before applying this migration';
    END IF;
END $$;

CREATE ROLE ob_stats_ingest NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS NOINHERIT;

-- PostgreSQL 16+ automatically gives a non-superuser creator ADMIN membership
-- in its new role (SET FALSE, INHERIT FALSE). That direction lets the owner
-- administer this account; it gives the ingestion account no owner privileges.
DO $$
DECLARE ingest_oid oid;
BEGIN
    SELECT oid INTO ingest_oid FROM pg_roles WHERE rolname = 'ob_stats_ingest';
    IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = ingest_oid)
       OR EXISTS (
           SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
           WHERE m.roleid = ingest_oid AND (r.rolname <> current_user OR NOT m.admin_option)
       ) THEN
        RAISE EXCEPTION 'Unexpected ob_stats_ingest membership; migration refused';
    END IF;
    IF has_database_privilege('ob_stats_ingest', current_database(), 'CREATE') THEN
        RAISE EXCEPTION 'PUBLIC database CREATE privilege would let ingestion create schemas; migration refused';
    END IF;
END $$;

-- Keep every API role outside this private archive, including PostgREST's
-- authenticator. Never grant the ingestion role to an API role or PUBLIC.
REVOKE ALL ON SCHEMA ob_stats FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ob_stats FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ob_stats FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA ob_stats FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ob_stats FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA ob_stats FROM %I', api_role);
            IF has_schema_privilege(api_role, 'ob_stats', 'USAGE') THEN
                RAISE EXCEPTION 'An API role retains inherited or owner access to ob_stats; migration refused';
            END IF;
        END IF;
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA ob_stats TO ob_stats_ingest;
GRANT SELECT ON ob_stats.schema_migrations,
    ob_stats.source_snapshots, ob_stats.snapshot_heads, ob_stats.snapshot_observations,
    ob_stats.players, ob_stats.games, ob_stats.game_revisions,
    ob_stats.player_game_stats, ob_stats.team_game_stats, ob_stats.player_season_stats,
    ob_stats.current_games, ob_stats.current_player_game_stats,
    ob_stats.current_team_game_stats, ob_stats.current_player_season_stats
    TO ob_stats_ingest;
GRANT INSERT ON ob_stats.source_snapshots, ob_stats.snapshot_observations,
    ob_stats.games, ob_stats.game_revisions, ob_stats.player_game_stats,
    ob_stats.team_game_stats, ob_stats.player_season_stats TO ob_stats_ingest;
GRANT INSERT, UPDATE ON ob_stats.players, ob_stats.snapshot_heads TO ob_stats_ingest;
-- USAGE permits nextval for new identities, but not setval to rewrite them.
GRANT USAGE ON SEQUENCE ob_stats.source_snapshots_snapshot_id_seq,
    ob_stats.snapshot_observations_observation_id_seq TO ob_stats_ingest;

-- 001 already enabled RLS on data tables. Migration metadata also gets an
-- explicit SELECT-only policy. Owner operations still use PostgreSQL's normal
-- table-owner bypass; ingestion has neither ownership nor BYPASSRLS.
ALTER TABLE ob_stats.schema_migrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_read ON ob_stats.schema_migrations
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_read ON ob_stats.source_snapshots
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.source_snapshots
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.snapshot_observations
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.snapshot_observations
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.games
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.games
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.game_revisions
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.game_revisions
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.player_game_stats
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.player_game_stats
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.team_game_stats
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.team_game_stats
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.player_season_stats
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_append ON ob_stats.player_season_stats
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.players
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_insert ON ob_stats.players
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_update ON ob_stats.players
    FOR UPDATE TO ob_stats_ingest USING (true) WITH CHECK (true);
CREATE POLICY ingest_read ON ob_stats.snapshot_heads
    FOR SELECT TO ob_stats_ingest USING (true);
CREATE POLICY ingest_insert ON ob_stats.snapshot_heads
    FOR INSERT TO ob_stats_ingest WITH CHECK (true);
CREATE POLICY ingest_update ON ob_stats.snapshot_heads
    FOR UPDATE TO ob_stats_ingest USING (true) WITH CHECK (true);

-- No DELETE, TRUNCATE, DDL, role-management, grant options, or future-object
-- defaults are granted. A new table needs a reviewed migration of its own.
