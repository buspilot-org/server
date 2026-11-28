-- Keep-alive heartbeat.
--
-- Free-plan Supabase projects are paused after about a week of low database
-- activity, and a paused project has to be restored by hand. The hosted demo
-- project (buspilot-demo, README "Hosted project (demo)") may sit idle between
-- demos, so a pg_cron job writes one row every 6 hours. The write is real
-- database activity, needs no outside caller, and costs nothing.
--
-- The table holds one row (id is always 1) and is not exposed: it lives in
-- `private`, has RLS on with no policies, and API roles get no privileges.
-- Harmless locally and on paid plans; drop the job if it is ever not wanted:
--   select cron.unschedule('buspilot-keep-alive');

create table private.heartbeat (
  id smallint primary key default 1 check (id = 1),
  beat_at timestamptz not null default now()
);

alter table private.heartbeat enable row level security;
revoke all on private.heartbeat from public, anon, authenticated;

insert into private.heartbeat (id) values (1);

-- Every 6 hours at minute 41 (00:41, 06:41, 12:41, 18:41 UTC).
select cron.schedule(
  'buspilot-keep-alive',
  '41 */6 * * *',
  'update private.heartbeat set beat_at = now() where id = 1'
);
