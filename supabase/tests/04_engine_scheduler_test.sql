-- Engine scheduler: trip instances and stop events from calendars, and the
-- default vehicle per trip. Uses the demo operator from seed.sql (two trips
-- of the morning loop, Monday–Friday, winter break removed).
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Start from the seed's two trips and no trip instances (local development
-- data may have added some; the transaction is rolled back at the end).
delete from public.trip_instance;
delete from public.trip
 where id not in ('d0000000-0000-4000-8000-000000000801', 'd0000000-0000-4000-8000-000000000802');

-- Trips get a default vehicle; it must belong to the same operator.
select is(
  (select count(*) from public.trip where vehicle_id = 'd0000000-0000-4000-8000-000000000701'),
  2::bigint,
  'seed: Bus 1 runs both morning trips'
);

insert into public.operator (id, slug, name) values
  ('e0000000-0000-4000-8000-000000000001', 'other-op', '{"en": "Other"}');
insert into public.vehicle (id, operator_id, name, traccar_device_id) values
  ('e0000000-0000-4000-8000-000000000701', 'e0000000-0000-4000-8000-000000000001', 'Other bus', 'other-1');
select throws_ok(
  $$ update public.trip set vehicle_id = 'e0000000-0000-4000-8000-000000000701'
      where id = 'd0000000-0000-4000-8000-000000000801' $$,
  '23503',
  null,
  'a trip cannot use another operator''s vehicle'
);

-- Scheduler job: today and tomorrow in the operator's time zone.
-- 2026-11-29 16:00 UTC is Monday 2026-11-30 01:00 in Tokyo. (The week before
-- has Labour Thanksgiving Day on Monday 2026-11-23: see 05_national_holidays_test.sql.)
select is(
  private.create_upcoming_trip_instances('2026-11-29T16:00:00Z'),
  4,
  'upcoming: two trips on Monday and Tuesday (Tokyo dates)'
);
select results_eq(
  $$ select distinct service_date from public.trip_instance order by 1 $$,
  $$ values ('2026-11-30'::date), ('2026-12-01'::date) $$,
  'service dates follow the operator time zone, not UTC'
);

-- A whole week: Monday–Friday only.
select is(
  private.create_trip_instances('2026-11-30', '2026-12-06'),
  6,
  'the rest of the week: Wednesday–Friday, two trips each; the weekend has none'
);
select is(
  private.create_trip_instances('2026-11-30', '2026-12-06'),
  0,
  'idempotent: running again creates nothing'
);

select results_eq(
  $$ select count(*), count(*) filter (where state = 'upcoming')
       from public.stop_event se
       join public.trip_instance ti on ti.id = se.trip_instance_id
      where ti.service_date = '2026-12-02' and ti.trip_id = 'd0000000-0000-4000-8000-000000000801' $$,
  $$ values (6::bigint, 6::bigint) $$,
  'one upcoming stop event per pattern stop, including both visits of the loop stop'
);
select results_eq(
  $$ select distinct status::text, kind::text, vehicle_id, route_id from public.trip_instance $$,
  $$ values ('planned', 'scheduled', null::uuid, 'd0000000-0000-4000-8000-000000000101'::uuid) $$,
  'instances are planned and scheduled, with the trip''s route; no vehicle until one runs it'
);

-- Exceptions.
select is(
  private.create_trip_instances('2026-12-24', '2026-12-25'),
  0,
  'winter break (removed exception) has no trips'
);
insert into public.calendar_exception (operator_id, calendar_id, start_date, end_date, type, reason)
values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000501',
        '2026-12-05', '2026-12-05', 'added', 'Saturday school event');
select is(
  private.create_trip_instances('2026-11-30', '2026-12-06'),
  2,
  'an added exception adds a Saturday'
);
select is(
  private.create_trip_instances('2027-04-05', '2027-04-09'),
  0,
  'no trips after the calendar ends'
);

-- Inactive routes are skipped.
update public.route set active = false where id = 'd0000000-0000-4000-8000-000000000101';
select is(
  private.create_trip_instances('2026-12-07', '2026-12-07'),
  0,
  'inactive routes get no trip instances'
);

-- API roles cannot run the scheduler.
select ok(
  not has_function_privilege('authenticated', 'private.create_trip_instances(date, date, uuid)', 'execute')
  and not has_function_privilege('anon', 'private.create_trip_instances(date, date, uuid)', 'execute'),
  'API roles cannot create trip instances'
);
select ok(
  not has_function_privilege('authenticated', 'private.create_upcoming_trip_instances(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'private.create_upcoming_trip_instances(timestamptz)', 'execute'),
  'API roles cannot run the scheduler job'
);

select * from finish();
rollback;
