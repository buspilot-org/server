-- Trip access: drivers see their vehicles' trips; live trips with planned
-- stops and audiences chosen per trip; subscriptions to a stop of a live
-- trip.
--
-- Fixture (operator T, default visibility invited_eta)
--   route R1 (invited_eta), pattern P1 with stops S1, S2; stops S3, S4 are on
--   no pattern (tour places)
--   vehicles V1, V2, V3
--   trips: T1 (default vehicle V1), T2 (default V2), T3 (any vehicle)
--   instances: I1 = T1, I2 = T2, I3 = T3, I4 = T2 with V1 for the day
--   live trip L1 without route on V3 (active), planned stops S3 (1), S4 (2)
--   audiences: aud_R1 (route R1), aud_L (live trip, arrival times),
--              aud_M (live trip, map)
--   riders: riderX in aud_R1, riderL in aud_L, riderM in aud_M
--   staff: editor E, driver D (drives V1), driver D2 (no vehicle)
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

insert into auth.users (id, email, is_anonymous) values
  ('e7000000-0000-4000-8000-0000000000e1', 'editor-t@example.test', false),
  ('e7000000-0000-4000-8000-0000000000d1', 'driver-t@example.test', false),
  ('e7000000-0000-4000-8000-0000000000d2', 'driver2-t@example.test', false),
  ('e7000000-0000-4000-8000-0000000000a1', 'owner-t@example.test', false),
  ('f7000000-0000-4000-8000-00000000000a', null, true),
  ('f7000000-0000-4000-8000-00000000000b', null, true),
  ('f7000000-0000-4000-8000-00000000000c', null, true);
insert into public.device (id) values
  ('f7000000-0000-4000-8000-00000000000a'),
  ('f7000000-0000-4000-8000-00000000000b'),
  ('f7000000-0000-4000-8000-00000000000c');

insert into public.operator (id, slug, name, default_visibility) values
  ('70000000-0000-4000-8000-000000000001', 'trip-access-test', '{"en": "T"}', 'invited_eta');
insert into public.staff_role (operator_id, user_id, role) values
  ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000a1', 'owner'),
  ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000e1', 'editor'),
  ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000d1', 'driver'),
  ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000d2', 'driver');

insert into public.route (id, operator_id, name) values
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', '{"en": "R1"}');
insert into public.stop (id, operator_id, name, location)
select s.id::uuid, '70000000-0000-4000-8000-000000000001', jsonb_build_object('en', s.n), 'SRID=4326;POINT(135.7 35.0)'
from (values
  ('72000000-0000-4000-8000-000000000001', 'S1'),
  ('72000000-0000-4000-8000-000000000002', 'S2'),
  ('72000000-0000-4000-8000-000000000003', 'S3'),
  ('72000000-0000-4000-8000-000000000004', 'S4')
) as s (id, n);
insert into public.trip_pattern (id, operator_id, route_id, name) values
  ('73000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
   '71000000-0000-4000-8000-000000000001', 'P1');
insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset) values
  ('70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 1, '72000000-0000-4000-8000-000000000001', 0, 0),
  ('70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', 2, '72000000-0000-4000-8000-000000000002', 300, 300);
insert into public.service_calendar (id, operator_id, name, weekdays, start_date, end_date) values
  ('74000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'all days', 127, '2026-01-01', '2027-12-31');
insert into public.vehicle (id, operator_id, name) values
  ('75000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'V1'),
  ('75000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', 'V2'),
  ('75000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', 'V3');
insert into public.trip (id, operator_id, pattern_id, service_calendar_id, start_time, vehicle_id) values
  ('76000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 25200, '75000000-0000-4000-8000-000000000001'),
  ('76000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 28800, '75000000-0000-4000-8000-000000000002'),
  ('76000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 32400, null);
insert into public.trip_instance (id, operator_id, service_date, kind, trip_id, vehicle_id) values
  ('77000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', '2026-12-01', 'scheduled', '76000000-0000-4000-8000-000000000001', null),
  ('77000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', '2026-12-01', 'scheduled', '76000000-0000-4000-8000-000000000002', null),
  ('77000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', '2026-12-01', 'scheduled', '76000000-0000-4000-8000-000000000003', null),
  ('77000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000001', '2026-12-02', 'scheduled', '76000000-0000-4000-8000-000000000002', '75000000-0000-4000-8000-000000000001');
insert into public.trip_instance (id, operator_id, service_date, kind, vehicle_id, status, started_by, title) values
  ('77000000-0000-4000-8000-0000000000b1', '70000000-0000-4000-8000-000000000001', current_date, 'live',
   '75000000-0000-4000-8000-000000000003', 'active', 'driver', '{"en": "Kyoto tour"}');
insert into public.vehicle_state (vehicle_id, operator_id, trip_instance_id, location, recorded_at) values
  ('75000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', null, 'SRID=4326;POINT(135.7 35.0)', now()),
  ('75000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000001', null, 'SRID=4326;POINT(135.7 35.0)', now()),
  ('75000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 'SRID=4326;POINT(135.7 35.0)', now());

insert into public.audience (id, operator_id, name) values
  ('78000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', '{"en": "aud_R1"}'),
  ('78000000-0000-4000-8000-00000000000b', '70000000-0000-4000-8000-000000000001', '{"en": "aud_L"}'),
  ('78000000-0000-4000-8000-00000000000a', '70000000-0000-4000-8000-000000000001', '{"en": "aud_M"}');
insert into public.audience_route (operator_id, audience_id, route_id) values
  ('70000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001');
insert into public.membership (operator_id, device_id, audience_id) values
  ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000a', '78000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000b', '78000000-0000-4000-8000-00000000000b'),
  ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000c', '78000000-0000-4000-8000-00000000000a');

-- =============================================================================
-- Editor: everything; sets up the driver's vehicle and the live trip
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-4000-8000-0000000000e1", "role": "authenticated"}', true);

select lives_ok(
  $$ insert into public.driver_vehicle (operator_id, user_id, vehicle_id)
     values ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-000000000001') $$,
  'editor links driver D to vehicle V1'
);
select throws_ok(
  $$ insert into public.driver_vehicle (operator_id, user_id, vehicle_id)
     values ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000a', '75000000-0000-4000-8000-000000000002') $$,
  '23503', null, 'only staff of the operator can be linked to a vehicle'
);
select is((select count(*) from public.trip_instance), 5::bigint, 'editor sees all trip instances');
select is((select count(*) from public.vehicle_state), 3::bigint, 'editor sees all vehicle positions');

select lives_ok(
  $$ insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id, planned_arrival, planned_departure) values
       ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 1, '72000000-0000-4000-8000-000000000003', now() + interval '1 hour', now() + interval '2 hours'),
       ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 2, '72000000-0000-4000-8000-000000000004', now() + interval '3 hours', null) $$,
  'editor plans the live trip''s stops'
);
select throws_ok(
  $$ insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000001', 9, '72000000-0000-4000-8000-000000000003') $$,
  '23514', null, 'scheduled trips get no planned stops (they follow their pattern)'
);
select throws_ok(
  $$ insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id, planned_arrival, planned_departure)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 3, '72000000-0000-4000-8000-000000000003', now(), now() - interval '1 minute') $$,
  '23514', null, 'planned departure cannot be before arrival'
);
select throws_ok(
  $$ update public.trip_instance_stop set stop_sequence = 5
      where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' and stop_sequence = 2 $$,
  '23514', null, 'planned stops are not renumbered in place'
);
select lives_ok(
  $$ insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id, can_see_map) values
       ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-00000000000b', false),
       ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', '78000000-0000-4000-8000-00000000000a', true) $$,
  'editor chooses the live trip''s audiences'
);
select throws_ok(
  $$ insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-00000000000b') $$,
  '23514', null, 'scheduled trips get no per-trip audiences'
);

reset role;
select results_eq(
  $$ select stop_sequence, state::text from public.stop_event
      where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' order by 1 $$,
  $$ values (1, 'upcoming'), (2, 'upcoming') $$,
  'each planned stop gets an upcoming stop event'
);

-- =============================================================================
-- Driver D (drives V1)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);

select set_eq(
  $$ select id from public.trip_instance $$,
  array['77000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000003',
        '77000000-0000-4000-8000-000000000004']::uuid[],
  'driver sees V1''s trips (default vehicle or override) and "any vehicle" trips, not V2''s or the live trip on V3'
);
select is_empty(
  $$ select 1 from public.stop_event where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' $$,
  'driver sees no stop events of another vehicle''s trip'
);
select set_eq(
  $$ select vehicle_id from public.vehicle_state $$,
  array['75000000-0000-4000-8000-000000000001']::uuid[],
  'driver sees only its own vehicle''s position'
);
select is((select count(*) from public.vehicle), 3::bigint, 'driver still sees the operator''s vehicles (names)');
select set_eq(
  $$ select vehicle_id from public.driver_vehicle $$,
  array['75000000-0000-4000-8000-000000000001']::uuid[],
  'driver reads its own vehicle links'
);
select throws_ok(
  $$ insert into public.driver_vehicle (operator_id, user_id, vehicle_id)
     values ('70000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-0000000000d1', '75000000-0000-4000-8000-000000000002') $$,
  '42501', null, 'driver cannot link itself to another vehicle'
);
select is_empty(
  $$ update public.trip_instance set status = 'active' where id = '77000000-0000-4000-8000-000000000002' returning 1 $$,
  'driver cannot update another vehicle''s trip'
);
select isnt_empty(
  $$ update public.trip_instance set status = 'active' where id = '77000000-0000-4000-8000-000000000001' returning 1 $$,
  'driver updates its own trip'
);
select throws_ok(
  $$ update public.trip_instance set vehicle_id = '75000000-0000-4000-8000-000000000002'
      where id = '77000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'driver cannot hand its trip to another vehicle'
);
select lives_ok(
  $$ insert into public.trip_instance (id, operator_id, service_date, kind, vehicle_id, started_by, status, title)
     values ('77000000-0000-4000-8000-0000000000b2', '70000000-0000-4000-8000-000000000001', current_date, 'live',
             '75000000-0000-4000-8000-000000000001', 'driver', 'active', '{"en": "Excursion"}') $$,
  'driver starts a live trip on its vehicle'
);
select throws_ok(
  $$ insert into public.trip_instance (operator_id, service_date, kind, vehicle_id, started_by, status, title)
     values ('70000000-0000-4000-8000-000000000001', current_date, 'live',
             '75000000-0000-4000-8000-000000000002', 'driver', 'active', '{"en": "Excursion"}') $$,
  '42501', null, 'driver cannot start a trip on another vehicle'
);
select lives_ok(
  $$ insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b2', 1, '72000000-0000-4000-8000-000000000003') $$,
  'driver plans stops of its own live trip'
);
select throws_ok(
  $$ insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 3, '72000000-0000-4000-8000-000000000003') $$,
  '42501', null, 'driver cannot plan stops of another vehicle''s live trip'
);
select lives_ok(
  $$ insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id)
     values ('70000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b2', '78000000-0000-4000-8000-00000000000b') $$,
  'driver chooses audiences when starting its live trip'
);

-- Driver D2 (no vehicle): only the "any vehicle" trip.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e7000000-0000-4000-8000-0000000000d2", "role": "authenticated"}', true);
select set_eq(
  $$ select id from public.trip_instance $$,
  array['77000000-0000-4000-8000-000000000003']::uuid[],
  'a driver without a vehicle sees only trips any vehicle may run'
);

-- =============================================================================
-- Riders
-- =============================================================================

-- riderL: aud_L (live trip, arrival times only).
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f7000000-0000-4000-8000-00000000000b", "role": "authenticated", "is_anonymous": true}', true);
select set_eq(
  $$ select id from public.trip_instance where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  array['77000000-0000-4000-8000-0000000000b1', '77000000-0000-4000-8000-0000000000b2']::uuid[],
  'riderL sees the live trips chosen for its audience, not route R1''s trips'
);
select results_eq(
  $$ select stop_sequence, stop_id from public.trip_instance_stop
      where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' order by 1 $$,
  $$ values (1, '72000000-0000-4000-8000-000000000003'::uuid), (2, '72000000-0000-4000-8000-000000000004'::uuid) $$,
  'riderL reads the planned stops'
);
select set_eq(
  $$ select id from public.stop where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  array['72000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000004']::uuid[],
  'riderL sees the names of the live trip''s stops, not route R1''s'
);
select is_empty(
  $$ select 1 from public.stop_location where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  'riderL (arrival times only) gets no stop locations before following a stop'
);
select is_empty(
  $$ select 1 from public.vehicle_state where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  'riderL sees no vehicle position'
);
select is_empty(
  $$ select 1 from public.trip_instance_audience $$,
  'riders do not read per-trip audiences'
);
select lives_ok(
  $$ insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence)
     values ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000b',
             '77000000-0000-4000-8000-0000000000b1', 1) $$,
  'riderL follows a stop of the live trip'
);
select results_eq(
  $$ select id from public.stop_location where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  $$ values ('72000000-0000-4000-8000-000000000003'::uuid) $$,
  'riderL now gets the followed stop''s location (mini map), nothing else'
);
select throws_ok(
  $$ insert into public.subscription (operator_id, device_id, pattern_id, trip_instance_id, stop_sequence)
     values ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000b',
             '73000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-0000000000b1', 2) $$,
  '23514', null, 'a subscription targets a pattern stop or a live trip stop, not both'
);

-- riderM: aud_M (live trip, map).
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f7000000-0000-4000-8000-00000000000c", "role": "authenticated", "is_anonymous": true}', true);
select set_eq(
  $$ select vehicle_id from public.vehicle_state where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  array['75000000-0000-4000-8000-000000000003']::uuid[],
  'riderM (map) sees the live trip''s vehicle position'
);
select set_eq(
  $$ select id from public.stop_location where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  array['72000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000004']::uuid[],
  'riderM (map) gets all of the live trip''s stop locations'
);

-- riderX: aud_R1 only.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f7000000-0000-4000-8000-00000000000a", "role": "authenticated", "is_anonymous": true}', true);
select set_eq(
  $$ select id from public.trip_instance where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  array['77000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000002',
        '77000000-0000-4000-8000-000000000003', '77000000-0000-4000-8000-000000000004']::uuid[],
  'riderX sees route R1''s trips, not the live trips of other audiences'
);
select throws_ok(
  $$ insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence)
     values ('70000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-00000000000a',
             '77000000-0000-4000-8000-0000000000b1', 1) $$,
  '42501', null, 'riderX cannot follow a stop of a live trip it cannot see'
);

-- anon: nothing of operator T.
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is_empty(
  $$ select 1 from public.trip_instance where operator_id = '70000000-0000-4000-8000-000000000001'
     union all select 1 from public.trip_instance_stop where operator_id = '70000000-0000-4000-8000-000000000001' $$,
  'anon sees no invited live trips'
);

-- =============================================================================
-- Changes
-- =============================================================================
reset role;
delete from public.trip_instance_stop
 where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' and stop_sequence = 2;
select results_eq(
  $$ select stop_sequence from public.stop_event where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' $$,
  $$ values (1) $$,
  'removing a planned stop removes its stop event'
);

delete from public.trip_instance_audience
 where trip_instance_id = '77000000-0000-4000-8000-0000000000b1' and audience_id = '78000000-0000-4000-8000-00000000000b';
select is(
  (select count(*) from public.subscription where device_id = 'f7000000-0000-4000-8000-00000000000b'),
  0::bigint,
  'removing the audience from the live trip deletes its members'' subscriptions to that trip'
);

update public.trip_instance set visible_until = now() - interval '1 minute'
 where id = '77000000-0000-4000-8000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f7000000-0000-4000-8000-00000000000c", "role": "authenticated", "is_anonymous": true}', true);
select is_empty(
  $$ select 1 from public.trip_instance where id = '77000000-0000-4000-8000-0000000000b1'
     union all select 1 from public.vehicle_state where vehicle_id = '75000000-0000-4000-8000-000000000003' $$,
  'after visible_until riders no longer see the live trip or its bus'
);

select * from finish();
rollback;
