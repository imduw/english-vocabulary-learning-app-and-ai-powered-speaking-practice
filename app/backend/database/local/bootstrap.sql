-- ONLY for a disposable local Postgres container / embedded test database.
-- This is not Supabase Auth and cannot register users or issue tokens.
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE ROLE cam_backend LOGIN PASSWORD 'local_backend_only' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE vocabulary TO cam_backend;
