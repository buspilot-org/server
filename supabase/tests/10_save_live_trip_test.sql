-- save_live_trip (one call, one transaction) and the purge of subscriptions
-- on finished live trips.
--
-- Fixture (operator O, default visibility invited_eta; operator O2)
--   vehicles V1, V2; stops S1–S4 of O, SX of O2
--   route R (invited_eta) with route audience RA
--   audiences A, B, C (chosen per trip)
--   staff: editor E, driver D (drives V1), driver D2 (drives V2)
--   riders: rA (A), rB (B), rAC (A and C), rRC (C and RA)
-- The trip made by the first save is T1; its id comes back from the RPC and
-- is kept in the setting test.r1.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

insert into auth.users (id, email, is_anonymous) values
  ('aa000000-0000-4000-8000-0000000000e1', 'editor-slt@example.test', false),
  ('aa000000-0000-4000-8000-0000000000d1', 'driver-slt@example.test', false),
  ('aa000000-0000-4000-8000-0000000000d2', 'driver2-slt@example.test', false),
  ('ab000000-0000-4000-8000-00000000000a', null, true),
  ('ab000000-0000-4000-8000-00000000000b', null, true),
  ('ab000000-0000-4000-8000-00000000000c', null, true),
  ('ab000000-0000-4000-8000-00000000000d', null, true);
insert into public.device (id) values
  ('ab000000-0000-4000-8000-00000000000a'),
  ('ab000000-0000-4000-8000-00000000000b'),
  ('ab000000-0000-4000-8000-00000000000c'),
  ('ab000000-0000-4000-8000-00000000000d');

insert into public.operator (id, slug, name, default_visibility) values
  ('a0000000-0000-4000-8000-000000000001', 'save-live-trip-test', '{"en": "O"}', 'invited_eta'),
  ('a0000000-0000-4000-8000-000000000002', 'save-live-trip-test-2', '{"en": "O2"}', 'invited_eta');
insert into public.staff_role (operator_id, user_id, role) values
  ('a0000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000e1', 'editor'),
  ('a0000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000d1', 'driver'),
  ('a0000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000d2', 'driver');
insert into public.vehicle (id, operator_id, name) values
  ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'V1'),
  ('a5000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'V2');
insert into public.driver_vehicle (operator_id, user_id, vehicle_id) values
  ('a0000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000d1', 'a5000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-0000000000d2', 'a5000000-0000-4000-8000-000000000002');
insert into public.stop (id, operator_id, name, location)
select s.id::uuid, s.op::uuid, jsonb_build_object('en', s.n), 'SRID=4326;POINT(135.7 35.0)'
from (values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'S1'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'S2'),
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'S3'),
  ('a2000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'S4'),
  ('a2000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000002', 'SX')
) as s (id, op, n);
insert into public.route (id, operator_id, name) values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '{"en": "R"}');
insert into public.audience (id, operator_id, name) values
  ('a8000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', '{"en": "A"}'),
  ('a8000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000001', '{"en": "B"}'),
  ('a8000000-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001', '{"en": "C"}'),
  ('a8000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000001', '{"en": "RA"}');
insert into public.audience_route (operator_id, audience_id, route_id) values
  ('a0000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-00000000000f', 'a1000000-0000-4000-8000-000000000001');
insert into public.membership (operator_id, device_id, audience_id) values
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-00000000000a'),
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000b', 'a8000000-0000-4000-8000-00000000000b'),
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000c', 'a8000000-0000-4000-8000-00000000000a'),
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000c', 'a8000000-0000-4000-8000-00000000000c'),
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000d', 'a8000000-0000-4000-8000-00000000000c'),
  ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000d', 'a8000000-0000-4000-8000-00000000000f');

-- =============================================================================
-- New trip (driver D, vehicle V1)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);

select lives_ok(
  $$ select set_config('test.r1', public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Tour"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_service_date => '2026-12-05',
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1,
          "planned_arrival": "2026-12-05T10:00:00+09:00", "planned_departure": "2026-12-05T10:30:00+09:00"},
         {"stop_id": "a2000000-0000-4000-8000-000000000002", "stop_sequence": 2}
       ]',
       p_audiences => '[
         {"audience_id": "a8000000-0000-4000-8000-00000000000a", "can_see_map": false},
         {"audience_id": "a8000000-0000-4000-8000-00000000000b", "can_see_map": true}
       ]'
     )::text, true) $$,
  'driver D creates a live trip on V1 with planned stops and audiences in one call'
);
select ok((current_setting('test.r1')::jsonb ->> 'id') is not null, 'the new trip''s id is returned');
select is(current_setting('test.r1')::jsonb #>> '{trip,kind}', 'live', 'saved as a live trip');
select is(current_setting('test.r1')::jsonb #>> '{trip,started_by}', 'driver', '... started by the driver');
select is(jsonb_array_length(current_setting('test.r1')::jsonb -> 'stops'), 2, 'the saved planned stops are returned');
select is(jsonb_array_length(current_setting('test.r1')::jsonb -> 'audiences'), 2, 'the saved audiences are returned');
select is(
  (select count(*) from public.trip_instance where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid),
  1::bigint,
  'the driver reads the new trip back'
);

reset role;
select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select operator_id, service_date, status::text from public.trip_instance
      where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('a0000000-0000-4000-8000-000000000001'::uuid, '2026-12-05'::date, 'planned') $$,
  'operator, service date and status as given (status planned)'
);
select results_eq(
  $$ select stop_sequence, state::text from public.stop_event
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid order by 1 $$,
  $$ values (1, 'upcoming'), (2, 'upcoming') $$,
  'each planned stop gets an upcoming stop event'
);

-- Followers: rA, rAC follow stop 1; rB follows stops 1 and 2.
insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence)
select 'a0000000-0000-4000-8000-000000000001', d::uuid, (current_setting('test.r1')::jsonb ->> 'id')::uuid, seq
from (values
  ('ab000000-0000-4000-8000-00000000000a', 1),
  ('ab000000-0000-4000-8000-00000000000b', 1),
  ('ab000000-0000-4000-8000-00000000000b', 2),
  ('ab000000-0000-4000-8000-00000000000c', 1)
) as f (d, seq);

-- =============================================================================
-- Edit: stop and audience diff (driver D)
-- =============================================================================
-- Stop 1 gets new times, stop 2 another stop (S3), stop 5 (S4) is new;
-- audience A is removed, B loses the map, C is added.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);

select lives_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Tour 2"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1,
          "planned_arrival": "2026-12-05T11:00:00+09:00", "planned_departure": "2026-12-05T11:30:00+09:00"},
         {"stop_id": "a2000000-0000-4000-8000-000000000003", "stop_sequence": 2},
         {"stop_id": "a2000000-0000-4000-8000-000000000004", "stop_sequence": 5}
       ]',
       p_audiences => '[
         {"audience_id": "a8000000-0000-4000-8000-00000000000b", "can_see_map": false},
         {"audience_id": "a8000000-0000-4000-8000-00000000000c", "can_see_map": true}
       ]'
     ) $$,
  'driver D edits the trip, its stops and audiences'
);

reset role;
select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select stop_sequence, stop_id, planned_arrival from public.trip_instance_stop
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid order by 1 $$,
  $$ values (1, 'a2000000-0000-4000-8000-000000000001'::uuid, '2026-12-05T11:00:00+09:00'::timestamptz),
            (2, 'a2000000-0000-4000-8000-000000000003'::uuid, null),
            (5, 'a2000000-0000-4000-8000-000000000004'::uuid, null) $$,
  'planned stops: times updated, stop 2 replaced, stop 5 added'
);
select results_eq(
  $$ select stop_sequence, state::text from public.stop_event
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid order by 1 $$,
  $$ values (1, 'upcoming'), (2, 'upcoming'), (5, 'upcoming') $$,
  'stop events follow the planned stops'
);
select results_eq(
  $$ select audience_id, can_see_map from public.trip_instance_audience
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid order by 1 $$,
  $$ values ('a8000000-0000-4000-8000-00000000000b'::uuid, false), ('a8000000-0000-4000-8000-00000000000c'::uuid, true) $$,
  'audiences: A removed, B without map, C added'
);
select results_eq(
  $$ select title, service_date from public.trip_instance
      where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('{"en": "Tour 2"}'::jsonb, '2026-12-05'::date) $$,
  'title updated; no service date given keeps the saved one'
);
select set_eq(
  $$ select device_id, stop_sequence from public.subscription
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('ab000000-0000-4000-8000-00000000000b'::uuid, 1), ('ab000000-0000-4000-8000-00000000000c'::uuid, 1) $$,
  'followers: rA (only A) dropped, rB loses the replaced stop 2, rAC keeps stop 1 through C added in the same save'
);

-- rRC (C and route audience RA) follows stop 5.
insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence)
values ('a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000d',
        (current_setting('test.r1')::jsonb ->> 'id')::uuid, 5);

-- =============================================================================
-- Edit: route set and audience C removed in one save (editor E)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000e1", "role": "authenticated"}', true);

select lives_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Tour 2"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => 'a1000000-0000-4000-8000-000000000001',
       p_audiences => '[{"audience_id": "a8000000-0000-4000-8000-00000000000b", "can_see_map": false}]'
     ) $$,
  'editor E puts the trip on route R and removes audience C'
);

reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select route_id from public.trip_instance where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid),
  'a1000000-0000-4000-8000-000000000001'::uuid,
  'route saved'
);
select is(
  (select count(*) from public.trip_instance_stop where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid),
  3::bigint,
  'no stops given: planned stops stay as they are'
);
select set_eq(
  $$ select device_id, stop_sequence from public.subscription
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('ab000000-0000-4000-8000-00000000000b'::uuid, 1), ('ab000000-0000-4000-8000-00000000000d'::uuid, 5) $$,
  'rAC (lost A and C) dropped; rRC keeps stop 5 through the new route'' audience'
);

-- Driver D without audiences (drivers cannot read them): left as they are.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);
select is(
  public.save_live_trip(
    p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
    p_title => '{"en": "Tour 3"}',
    p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
    p_route_id => 'a1000000-0000-4000-8000-000000000001'
  ) -> 'audiences',
  '[{"audience_id": "a8000000-0000-4000-8000-00000000000b", "can_see_map": false}]'::jsonb,
  'no audiences given: audiences stay as they are'
);

-- =============================================================================
-- Rights
-- =============================================================================

-- Driver D2 (drives V2).
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d2", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Hijack"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000002'
     ) $$,
  '42501', null, 'a driver of another vehicle cannot edit the trip'
);
select throws_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Not mine"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001'
     ) $$,
  '42501', null, 'a driver cannot create a trip on a vehicle they do not drive'
);

-- Driver D: cannot hand the trip to V2.
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Tour 3"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000002',
       p_route_id => 'a1000000-0000-4000-8000-000000000001'
     ) $$,
  '42501', null, 'a driver cannot move the trip to a vehicle they do not drive'
);

-- Editor E: the operator must match.
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000e1", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_operator_id => 'a0000000-0000-4000-8000-000000000002',
       p_title => '{"en": "Tour 3"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => 'a1000000-0000-4000-8000-000000000001'
     ) $$,
  '22023', null, 'the operator given on update must be the trip''s'
);

-- Rider rB (member of B, sees the trip).
select set_config('request.jwt.claims', '{"sub": "ab000000-0000-4000-8000-00000000000b", "role": "authenticated", "is_anonymous": true}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Rider"}'
     ) $$,
  '42501', null, 'a rider who sees the trip cannot edit it'
);
select throws_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Rider"}'
     ) $$,
  '42501', null, 'a rider cannot create a live trip'
);

-- Anonymous visitor (no session).
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Anon"}'
     ) $$,
  '42501', null, 'anonymous callers cannot call save_live_trip'
);

reset role;
select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select title, vehicle_id from public.trip_instance where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('{"en": "Tour 3"}'::jsonb, 'a5000000-0000-4000-8000-000000000001'::uuid) $$,
  'refused saves changed nothing'
);

-- =============================================================================
-- All or nothing (driver D)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);

-- A stop of another operator, after the audiences and title would change.
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Broken"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => null,
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1},
         {"stop_id": "a2000000-0000-4000-8000-000000000009", "stop_sequence": 9}
       ]',
       p_audiences => '[]'
     ) $$,
  '23503', null, 'a planned stop of another operator refuses the save'
);

-- The bus has reached stop 1: removing it refuses the whole save.
reset role;
select set_config('request.jwt.claims', '', true);
update public.stop_event set state = 'arrived', arrived_at = now()
 where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid and stop_sequence = 1;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d1", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Broken"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => null,
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000003", "stop_sequence": 2},
         {"stop_id": "a2000000-0000-4000-8000-000000000004", "stop_sequence": 5},
         {"stop_id": "a2000000-0000-4000-8000-000000000002", "stop_sequence": 6}
       ]',
       p_audiences => '[]'
     ) $$,
  '23514', null, 'removing a stop the bus has reached refuses the save'
);
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Broken"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => 'a1000000-0000-4000-8000-000000000001',
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1},
         {"stop_id": "a2000000-0000-4000-8000-000000000002", "stop_sequence": 1}
       ]'
     ) $$,
  '22023', null, 'duplicate stop sequences are refused'
);
select throws_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Broken new"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1},
         {"stop_id": "a2000000-0000-4000-8000-000000000009", "stop_sequence": 2}
       ]'
     ) $$,
  '23503', null, 'a new trip with a bad stop is refused'
);
select throws_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001'
     ) $$,
  '23502', null, 'a live trip needs a title'
);
-- Audience C added (step 1) and stop 5 replaced, dropping rRC's follow
-- (step 2), then the trip update (step 3) is refused: all of it is undone.
select throws_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Broken"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000002',
       p_route_id => 'a1000000-0000-4000-8000-000000000001',
       p_stops => '[
         {"stop_id": "a2000000-0000-4000-8000-000000000001", "stop_sequence": 1},
         {"stop_id": "a2000000-0000-4000-8000-000000000003", "stop_sequence": 2},
         {"stop_id": "a2000000-0000-4000-8000-000000000002", "stop_sequence": 5}
       ]',
       p_audiences => '[
         {"audience_id": "a8000000-0000-4000-8000-00000000000b"},
         {"audience_id": "a8000000-0000-4000-8000-00000000000c", "can_see_map": true}
       ]'
     ) $$,
  '42501', null, 'a refusal in the last steps undoes the audience and stop writes before it'
);

reset role;
select set_config('request.jwt.claims', '', true);
select results_eq(
  $$ select title, route_id from public.trip_instance where id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('{"en": "Tour 3"}'::jsonb, 'a1000000-0000-4000-8000-000000000001'::uuid) $$,
  'failed saves left the trip as it was'
);
select results_eq(
  $$ select stop_sequence, stop_id from public.trip_instance_stop
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid order by 1 $$,
  $$ values (1, 'a2000000-0000-4000-8000-000000000001'::uuid),
            (2, 'a2000000-0000-4000-8000-000000000003'::uuid),
            (5, 'a2000000-0000-4000-8000-000000000004'::uuid) $$,
  '... and its planned stops'
);
select is(
  (select count(*) from public.trip_instance_audience where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid),
  1::bigint,
  '... and its audiences'
);
select set_eq(
  $$ select device_id, stop_sequence from public.subscription
      where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  $$ values ('ab000000-0000-4000-8000-00000000000b'::uuid, 1), ('ab000000-0000-4000-8000-00000000000d'::uuid, 5) $$,
  '... and its followers'
);
select is(
  (select count(*) from public.trip_instance where title ->> 'en' = 'Broken new'),
  0::bigint,
  'the refused new trip was not created'
);

-- Driver D2 may create a trip without a vehicle ("any vehicle").
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000d2", "role": "authenticated"}', true);
select lives_ok(
  $$ select public.save_live_trip(
       p_operator_id => 'a0000000-0000-4000-8000-000000000001',
       p_title => '{"en": "Any vehicle"}'
     ) $$,
  'a driver creates a live trip without a vehicle'
);

-- =============================================================================
-- Whole-form save: clearing the route and every audience (editor E)
-- =============================================================================
select set_config('request.jwt.claims', '{"sub": "aa000000-0000-4000-8000-0000000000e1", "role": "authenticated"}', true);
select lives_ok(
  $$ select public.save_live_trip(
       p_trip_id => (current_setting('test.r1')::jsonb ->> 'id')::uuid,
       p_title => '{"en": "Tour 3"}',
       p_vehicle_id => 'a5000000-0000-4000-8000-000000000001',
       p_route_id => null,
       p_audiences => '[]'
     ) $$,
  'editor E clears the route and all audiences'
);
reset role;
select set_config('request.jwt.claims', '', true);
select is(
  (select count(*) from public.trip_instance_audience where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid),
  0::bigint,
  'an empty audience list removes every audience'
);
select is_empty(
  $$ select 1 from public.subscription where trip_instance_id = (current_setting('test.r1')::jsonb ->> 'id')::uuid $$,
  'rRC (route only) and rB (audience B) lose their follows'
);

-- =============================================================================
-- Purge of subscriptions on finished live trips
-- =============================================================================
-- rB follows a stop on each: done (completed 2 h ago, stop S2), recent
-- (completed 10 min ago), expired (visible_until passed), stale (planned,
-- 8 days ago), running (active today), cancelled (no ended_at, last
-- updated 2 h ago).
insert into public.trip_instance (id, operator_id, service_date, kind, status, started_by, title, visible_until, ended_at) values
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', current_date, 'live', 'completed', 'driver', '{"en": "done"}', null, now() - interval '2 hours'),
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', current_date, 'live', 'completed', 'driver', '{"en": "recent"}', null, now() - interval '10 minutes'),
  ('a7000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', current_date, 'live', 'active', 'driver', '{"en": "expired"}', now() - interval '1 minute', null),
  ('a7000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', current_date - 8, 'live', 'planned', 'driver', '{"en": "stale"}', null, null),
  ('a7000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', current_date, 'live', 'active', 'driver', '{"en": "running"}', null, null);
insert into public.trip_instance (id, operator_id, service_date, kind, status, started_by, title, updated_at) values
  ('a7000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', current_date, 'live', 'cancelled', 'driver', '{"en": "cancelled"}', now() - interval '2 hours');
insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id) values
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 1, 'a2000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 1, 'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000003', 1, 'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000004', 1, 'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000005', 1, 'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000006', 1, 'a2000000-0000-4000-8000-000000000001');
insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence)
select 'a0000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-00000000000b', t::uuid, 1
from unnest(array[
  'a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002',
  'a7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000004',
  'a7000000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000006'
]) as t;

select is(
  (select released_at from private.followed_stop_log
    where device_id = 'ab000000-0000-4000-8000-00000000000b' and stop_id = 'a2000000-0000-4000-8000-000000000002'),
  null,
  'before the purge rB follows S2 (on the finished trip)'
);

select lives_ok($$ select private.purge_expired_data() $$, 'the daily retention job runs');
select set_eq(
  $$ select trip_instance_id from public.subscription where device_id = 'ab000000-0000-4000-8000-00000000000b' $$,
  array['a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000005']::uuid[],
  'subscriptions of trips completed or cancelled over an hour ago, past visible_until or stale are purged; others stay'
);
select isnt(
  (select released_at from private.followed_stop_log
    where device_id = 'ab000000-0000-4000-8000-00000000000b' and stop_id = 'a2000000-0000-4000-8000-000000000002'),
  null,
  'the purged follow of S2 is released in the followed-stop log'
);
select is(
  (select released_at from private.followed_stop_log
    where device_id = 'ab000000-0000-4000-8000-00000000000b' and stop_id = 'a2000000-0000-4000-8000-000000000001'),
  null,
  'S1, still followed on other trips, is not released'
);
select is(private.purge_finished_live_trip_subscriptions(), 0, 'a second purge finds nothing');

select * from finish();
rollback;
