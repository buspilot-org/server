-- Constraints that encode the design (data-model.md, arrival-alerts.md).
-- Uses the demo operator from seed.sql.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- Every table in public has RLS; anon has no write privileges.
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'RLS is enabled on every table in public'
);
select is_empty(
  $$ select table_name, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('anon', 'authenticated')
       and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
     union all
     select table_name, privilege_type from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE') $$,
  'anon cannot write; nobody but the owner can truncate'
);

-- Seed: the loop serves Kitano-zaka twice.
select is(
  (select count(*) - count(distinct stop_id) from public.pattern_stop
    where pattern_id = 'd0000000-0000-4000-8000-000000000301'),
  1::bigint,
  'seed pattern serves one stop twice'
);

-- trip_instance: unique (service_date, trip_id); route and pattern from the trip.
insert into public.trip_instance (id, operator_id, service_date, kind, trip_id)
values ('d0000000-0000-4000-8000-00000000a001', 'd0000000-0000-4000-8000-000000000001',
        '2026-11-24', 'scheduled', 'd0000000-0000-4000-8000-000000000801');

select is(
  (select route_id from public.trip_instance where id = 'd0000000-0000-4000-8000-00000000a001'),
  'd0000000-0000-4000-8000-000000000101'::uuid,
  'scheduled trip instance gets route_id from its trip'
);

select throws_ok(
  $$ insert into public.trip_instance (operator_id, service_date, kind, trip_id)
     values ('d0000000-0000-4000-8000-000000000001', '2026-11-24', 'scheduled',
             'd0000000-0000-4000-8000-000000000801') $$,
  '23505', null, 'one trip instance per trip and service date'
);

select lives_ok(
  $$ insert into public.trip_instance (operator_id, service_date, kind, trip_id)
     values ('d0000000-0000-4000-8000-000000000001', '2026-11-24', 'scheduled',
             'd0000000-0000-4000-8000-000000000802') $$,
  'the second trip of the day is a separate instance'
);

select throws_ok(
  $$ insert into public.trip_instance (operator_id, service_date, kind, trip_id)
     values ('d0000000-0000-4000-8000-000000000001', '2026-11-25', 'live',
             'd0000000-0000-4000-8000-000000000801') $$,
  '23514', null, 'a live trip instance has no trip_id'
);

update public.trip_instance set progress_m = 500 where id = 'd0000000-0000-4000-8000-00000000a001';
select throws_ok(
  $$ update public.trip_instance set progress_m = 400 where id = 'd0000000-0000-4000-8000-00000000a001' $$,
  '23514', null, 'progress_m only increases'
);

-- stop_event: states move forward only.
insert into public.stop_event (operator_id, trip_instance_id, stop_sequence)
select 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000a001', s
from generate_series(1, 6) s;

update public.stop_event set state = 'arrived', arrived_at = now()
 where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 1;
select throws_ok(
  $$ update public.stop_event set state = 'approaching'
      where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 1 $$,
  '23514', null, 'stop event cannot go back from arrived to approaching'
);

update public.stop_event set state = 'departed', departed_at = now()
 where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 1;
select throws_ok(
  $$ update public.stop_event set state = 'passed', passed_at = now(), arrived_at = null
      where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 1 $$,
  '23514', null, 'departed is final'
);

select throws_ok(
  $$ update public.stop_event set state = 'passed', passed_at = now(), arrived_at = now()
      where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 2 $$,
  '23514', null, 'passed means never arrived'
);

select throws_ok(
  $$ update public.stop_event set state = 'departed', departed_at = now()
      where trip_instance_id = 'd0000000-0000-4000-8000-00000000a001' and stop_sequence = 3 $$,
  '23514', null, 'departed requires arrived_at'
);

-- alert_delivery: one alert per subscription, trip instance, stop and kind.
insert into auth.users (id, is_anonymous) values ('f0000000-0000-4000-8000-0000000000c1', true);
insert into public.device (id) values ('f0000000-0000-4000-8000-0000000000c1');
insert into public.subscription (id, operator_id, device_id, pattern_id, stop_sequence)
values ('d0000000-0000-4000-8000-00000000b001', 'd0000000-0000-4000-8000-000000000001',
        'f0000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-000000000301', 5);

insert into public.alert_delivery (operator_id, subscription_id, trip_instance_id, stop_sequence, kind, sent_at)
values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000b001',
        'd0000000-0000-4000-8000-00000000a001', 5, 'approaching', now());

select throws_ok(
  $$ insert into public.alert_delivery (operator_id, subscription_id, trip_instance_id, stop_sequence, kind)
     values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000b001',
             'd0000000-0000-4000-8000-00000000a001', 5, 'approaching') $$,
  '23505', null, 'duplicate alert is rejected'
);

select lives_ok(
  $$ insert into public.alert_delivery (operator_id, subscription_id, trip_instance_id, stop_sequence, kind)
     values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000b001',
             'd0000000-0000-4000-8000-00000000a001', 5, 'passed') $$,
  'another kind for the same stop is allowed'
);

select throws_ok(
  $$ insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
     values ('d0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000c1',
             'd0000000-0000-4000-8000-000000000301', 99) $$,
  '23503', null, 'subscription must point to an existing pattern stop'
);

-- i18n text and times of day.
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('d0000000-0000-4000-8000-000000000001', '{"en": 1}') $$,
  '23514', null, 'i18n values must be strings'
);
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('d0000000-0000-4000-8000-000000000001', '"Route"') $$,
  '23514', null, 'i18n text must be an object keyed by language'
);
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('d0000000-0000-4000-8000-000000000001', '{"English": "Route"}') $$,
  '23514', null, 'i18n keys must be language tags'
);
select throws_ok(
  $$ insert into public.trip (operator_id, pattern_id, service_calendar_id, start_time)
     values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000301',
             'd0000000-0000-4000-8000-000000000501', 48 * 3600) $$,
  '23514', null, 'start_time is seconds since midnight, below 48 h'
);

-- Tenant integrity: no references to another operator's rows.
insert into public.operator (id, slug, name) values ('d0000000-0000-4000-8000-0000000000ff', 'other', '{"en": "Other"}');
select throws_ok(
  $$ insert into public.trip_pattern (operator_id, route_id, name)
     values ('d0000000-0000-4000-8000-0000000000ff', 'd0000000-0000-4000-8000-000000000101', 'stolen') $$,
  '23503', null, 'a pattern cannot use another operator''s route'
);

-- Route recordings: the raw track goes once converted.
select throws_ok(
  $$ insert into public.route_recording (operator_id, status, pattern_id, track)
     values ('d0000000-0000-4000-8000-000000000001', 'converted', 'd0000000-0000-4000-8000-000000000301',
             'SRID=4326;LINESTRING(135.19 34.70, 135.20 34.71)') $$,
  '23514', null, 'a converted recording keeps no raw track'
);

-- Invite code hash is case and dash insensitive.
select is(
  private.hash_invite_code('demo kobe-2026'),
  private.hash_invite_code('DEMO-KOBE-2026'),
  'invite code hash ignores case, spaces and dashes'
);

select * from finish();
rollback;
