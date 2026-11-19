-- Backend-only role. Do not grant membership to anon/authenticated clients.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vocabulary_api') THEN
    CREATE ROLE vocabulary_api NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vocabulary_api' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe pre-existing vocabulary_api role';
  END IF;
END;
$$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app.current_user_id() FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO vocabulary_api;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO vocabulary_api;
GRANT SELECT ON app.profiles TO vocabulary_api;
GRANT INSERT (user_id) ON app.profiles TO vocabulary_api;
GRANT UPDATE (display_name, timezone) ON app.profiles TO vocabulary_api;

CREATE POLICY profile_read_self ON app.profiles FOR SELECT TO vocabulary_api
  USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY profile_insert_self ON app.profiles FOR INSERT TO vocabulary_api
  WITH CHECK (user_id = (SELECT app.current_user_id()) AND deleted_at IS NULL);
CREATE POLICY profile_update_self ON app.profiles FOR UPDATE TO vocabulary_api
  USING (user_id = (SELECT app.current_user_id()) AND deleted_at IS NULL)
  WITH CHECK (user_id = (SELECT app.current_user_id()) AND deleted_at IS NULL);

-- The local Compose role is known. Remote deployments grant membership explicitly.
DO $$
BEGIN
  IF current_user='cam_migrator' AND current_database()='vocabulary'
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cam_backend') THEN
    GRANT vocabulary_api TO cam_backend;
  END IF;
END;
$$;
