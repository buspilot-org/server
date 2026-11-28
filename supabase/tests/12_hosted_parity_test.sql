-- The hosted project enables RLS on new tables automatically; the local
-- database does not. Every table in `public` must enable RLS in its migration,
-- so local and hosted behave the same.
--
-- Also checks the keep-alive heartbeat (20261129100000_keep_alive.sql).
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is(
  array(
    select c.relname::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p')
       and not c.relrowsecurity
     order by 1
  ),
  '{}'::text[],
  'every table in public has row-level security enabled'
);
select ok(
  (select count(*) > 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'public has tables (the RLS check is not vacuous)'
);

-- Keep-alive heartbeat.
select is((select count(*)::int from private.heartbeat), 1, 'heartbeat has one row');
select throws_ok(
  $$insert into private.heartbeat (id) values (2)$$,
  '23514', null, 'heartbeat cannot get a second row'
);
select is(
  (select schedule || ' ' || command from cron.job where jobname = 'buspilot-keep-alive'),
  '41 */6 * * * update private.heartbeat set beat_at = now() where id = 1',
  'keep-alive job runs every 6 hours'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'private.heartbeat'::regclass),
  'heartbeat has RLS on'
);
select ok(
  not has_table_privilege('anon', 'private.heartbeat', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'private.heartbeat', 'select,insert,update,delete'),
  'API roles have no privileges on heartbeat'
);

select * from finish();
rollback;
