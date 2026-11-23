-- Extensions used by the Buspilot schema.
--
-- PostGIS lives in the `extensions` schema (Supabase convention), so its many
-- functions and types do not show up in the `public` schema of the Data API.
-- Reference its types schema-qualified, e.g. `extensions.geography(Point, 4326)`.
create extension if not exists postgis with schema extensions;

-- pgcrypto (digest, gen_random_bytes) for invite code hashes. Supabase
-- installs it by default; make the dependency explicit.
create extension if not exists pgcrypto with schema extensions;

-- pg_cron runs the daily retention job (see the retention migration).
create extension if not exists pg_cron with schema pg_catalog;
