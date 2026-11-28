-- Keep-alive heartbeat.
--
-- Free-plan Supabase projects are paused after about a week of low database
-- activity, and a paused project has to be restored by hand. The hosted demo
-- project (buspilot-demo, README "Hosted project (demo)") may sit idle between
-- demos, so a pg_cron job writes one row every 6 hours. The write is meant to
-- count as database activity without an outside caller; Supabase does not
-- define exactly what counts, so check that the project stays up after more
-- than a week without use, and add an external ping if it still pauses.
--
-- The table holds one row (id is always 1) and is not exposed: it lives in
-- `private`, has RLS on with no policies, and the API roles (anon,
-- authenticated, service_role) get no privileges; the job runs as postgres.
-- Harmless locally and on paid plans. To remove it, add a migration with
-- select cron.unschedule('buspilot-keep-alive'), so hosted and local agree.

create table private.heartbeat (
  id smallint primary key default 1 check (id = 1),
  beat_at timestamptz not null default now()
);

alter table private.heartbeat enable row level security;
revoke all on private.heartbeat from public, anon, authenticated, service_role;

insert into private.heartbeat (id) values (1);

-- Every 6 hours at minute 41 (00:41, 06:41, 12:41, 18:41 UTC).
select cron.schedule(
  'buspilot-keep-alive',
  '41 */6 * * *',
  'update private.heartbeat set beat_at = now() where id = 1'
);
