-- Row-level security: riders, anonymous visitors, staff roles, other operators.
--
-- Fixture
--   Operator A (default visibility invited_eta)
--     route A1  default (→ invited_eta)   audience aud_A1 (can_see_map true, but the route is eta-only)
--     route A2  invited_map               audience aud_A2 (map), aud_A2eta (arrival times only)
--     route A3  public
--     route A4  public, inactive
--   Operator B: route B1 public, B2 invited_eta
--   Operator C: route C1 invited_eta (nobody in this test is a member)
--   rider1: member of aud_A1, revoked membership in aud_A2
--   rider2: member of aud_A2 (map)
--   rider3: member of aud_A2eta (arrival times only)
--   Staff: ownerA, editorA, driverA (operator A), ownerB (operator B)
--   Active trip instance with a vehicle state on A1, A2, A3 and C1.
begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

-- Users ----------------------------------------------------------------------
insert into auth.users (id, email, is_anonymous) values
  ('e0000000-0000-4000-8000-0000000000a1', 'owner-a@example.test', false),
  ('e0000000-0000-4000-8000-0000000000a2', 'editor-a@example.test', false),
  ('e0000000-0000-4000-8000-0000000000a3', 'driver-a@example.test', false),
  ('e0000000-0000-4000-8000-0000000000a4', 'new-staff-a@example.test', false),
  ('e0000000-0000-4000-8000-0000000000b1', 'owner-b@example.test', false),
  ('f0000000-0000-4000-8000-000000000001', null, true),
  ('f0000000-0000-4000-8000-000000000002', null, true),
  ('f0000000-0000-4000-8000-000000000003', null, true);

insert into public.device (id) values
  ('f0000000-0000-4000-8000-000000000001'),
  ('f0000000-0000-4000-8000-000000000002'),
  ('f0000000-0000-4000-8000-000000000003');

-- Operators and staff --------------------------------------------------------
insert into public.operator (id, slug, name, default_visibility) values
  ('a0000000-0000-4000-8000-000000000001', 'test-a', '{"en": "A"}', 'invited_eta'),
  ('b0000000-0000-4000-8000-000000000001', 'test-b', '{"en": "B"}', 'invited_eta'),
  ('c0000000-0000-4000-8000-000000000001', 'test-c', '{"en": "C"}', 'invited_eta');

insert into public.staff_role (operator_id, user_id, role) values
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a2', 'editor'),
  ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a3', 'driver'),
  ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000b1', 'owner');

-- Routes, stops, shapes, patterns -------------------------------------------
insert into public.route (id, operator_id, name, visibility, active) values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '{"en": "A1"}', null, true),
  ('a1000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '{"en": "A2"}', 'invited_map', true),
  ('a1000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '{"en": "A3"}', 'public', true),
  ('a1000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', '{"en": "A4"}', 'public', false),
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '{"en": "B1"}', 'public', true),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', '{"en": "B2"}', null, true),
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', '{"en": "C1"}', null, true);

insert into public.stop (id, operator_id, name, location)
select s.id::uuid, s.op::uuid, '{"en": "stop"}', 'SRID=4326;POINT(135.19 34.70)'
from (values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
  ('a2000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001')
) as s (id, op);

insert into public.shape (id, operator_id, geom, source)
select s.id::uuid, s.op::uuid, 'SRID=4326;LINESTRING(135.19 34.70, 135.20 34.71)', 'drawn'
from (values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
  ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')
) as s (id, op);

-- pattern N uses route N, stop N and (where it exists) shape N.
insert into public.trip_pattern (id, operator_id, route_id, shape_id, name)
select p.id::uuid, p.op::uuid, p.route::uuid, p.shape::uuid, 'pattern'
from (values
  ('a4000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001'),
  ('a4000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002'),
  ('a4000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'a3000000-0000-4000-8000-000000000003'),
  ('a4000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004', null),
  ('b4000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001'),
  ('b4000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', null),
  ('c4000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', null)
) as p (id, op, route, shape);

insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset)
select ps.op::uuid, ps.pattern::uuid, 1, ps.stop::uuid, 0, 0
from (values
  ('a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000004'),
  ('b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001')
) as ps (op, pattern, stop);

-- Access ---------------------------------------------------------------------
insert into public.audience (id, operator_id, name) values
  ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '{"en": "aud_A1"}'),
  ('a5000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '{"en": "aud_A2"}'),
  ('a5000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '{"en": "aud_A2eta"}'),
  ('b5000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', '{"en": "aud_B"}');

insert into public.audience_route (operator_id, audience_id, route_id, can_see_map) values
  ('a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', true),
  ('a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', true),
  ('a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', false);

insert into public.invite_code (operator_id, audience_id, code_hash) values
  ('a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', private.hash_invite_code('TEST-A1'));

insert into public.membership (operator_id, device_id, audience_id, revoked_at) values
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', null),
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', now()),
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000002', null),
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003', 'a5000000-0000-4000-8000-000000000003', null);

insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence) values
  ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000002', 1);

-- Live operation -------------------------------------------------------------
insert into public.vehicle (id, operator_id, name)
select v.id::uuid, v.op::uuid, 'bus'
from (values
  ('a6000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001'),
  ('c6000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001')
) as v (id, op);

insert into public.trip_instance (id, operator_id, service_date, kind, pattern_id, vehicle_id, status)
select t.id::uuid, t.op::uuid, current_date, 'live', t.pattern::uuid, t.vehicle::uuid, 'active'
from (values
  ('a7000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001'),
  ('a7000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000002'),
  ('a7000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000003'),
  ('c7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001')
) as t (id, op, pattern, vehicle);

insert into public.vehicle_state (vehicle_id, operator_id, trip_instance_id, location, recorded_at)
select ti.vehicle_id, ti.operator_id, ti.id, 'SRID=4326;POINT(135.19 34.70)', now()
from public.trip_instance ti
where ti.id::text like '_7000000-%';

insert into public.stop_event (operator_id, trip_instance_id, stop_sequence)
select ti.operator_id, ti.id, 1
from public.trip_instance ti
where ti.id::text like '_7000000-%';

-- Content --------------------------------------------------------------------
insert into public.post (id, operator_id, title, body, audience_id, published_at) values
  ('a8000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '{"en": "all"}', '{"en": "x"}', null, now() - interval '1 hour'),
  ('a8000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', '{"en": "aud_A1"}', '{"en": "x"}', 'a5000000-0000-4000-8000-000000000001', now() - interval '1 hour'),
  ('a8000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', '{"en": "aud_A2"}', '{"en": "x"}', 'a5000000-0000-4000-8000-000000000002', now() - interval '1 hour'),
  ('a8000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', '{"en": "draft"}', '{"en": "x"}', null, null),
  ('c8000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', '{"en": "C"}', '{"en": "x"}', null, now() - interval '1 hour');

-- =============================================================================
-- rider1: member of aud_A1 (route A1, arrival times only)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-000000000001", "role": "authenticated", "is_anonymous": true}', true);

select set_eq(
  $$ select id from public.route where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003',
        'b1000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees its audience''s route and public routes; not A2 (revoked), inactive A4, private B2 or C'
);
select set_eq(
  $$ select id from public.operator where id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees operator A (member) and B (public route), not C'
);
select set_eq(
  $$ select id from public.stop where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000003',
        'b2000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees stops of visible routes'
);
select throws_ok(
  $$ select location from public.stop $$,
  '42501', null, 'riders cannot read stop.location directly'
);
select set_eq(
  $$ select id from public.stop_location where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 gets locations of map-level stops only (not the eta-only A1 stop)'
);
select set_eq(
  $$ select id from public.shape where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees shapes of map-level routes only'
);
select set_eq(
  $$ select id from public.trip_pattern where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000003',
        'b4000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees patterns of visible routes'
);
select set_eq(
  $$ select id from public.trip_instance $$,
  array['a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000003']::uuid[],
  'rider1 sees trip instances of visible routes'
);
select set_eq(
  $$ select trip_instance_id from public.stop_event $$,
  array['a7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000003']::uuid[],
  'rider1 sees ETAs of visible trips, including the eta-only route'
);
select set_eq(
  $$ select vehicle_id from public.vehicle_state $$,
  array['a6000000-0000-4000-8000-000000000003']::uuid[],
  'rider1 sees the vehicle position on the public route only (A1 is eta-only)'
);
select set_eq(
  $$ select id from public.post $$,
  array['a8000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000002']::uuid[],
  'rider1 sees general and own-audience posts; not drafts, other audiences or operator C'
);
select set_eq(
  $$ select id from public.audience $$,
  array['a5000000-0000-4000-8000-000000000001']::uuid[],
  'rider1 sees only its own active audience'
);
select is((select count(*) from public.membership), 2::bigint, 'rider1 sees its own memberships (active and revoked)');
select is((select count(*) from public.device), 1::bigint, 'rider1 sees only its own device');
select is_empty($$ select 1 from public.invite_code $$, 'riders see no invite codes');
select is_empty($$ select 1 from public.staff_role $$, 'riders see no staff roles');
select is_empty($$ select 1 from public.vehicle $$, 'riders see no vehicles');
select is_empty($$ select 1 from public.subscription $$, 'rider1 does not see rider2''s subscription');
select is(private.route_topic_access('route:a1000000-0000-4000-8000-000000000001'), 1::smallint,
  'rider1 may not join the realtime channel of eta-only route A1');
select is(private.route_topic_access('route:a1000000-0000-4000-8000-000000000003'), 2::smallint,
  'rider1 may join the realtime channel of public route A3');

select lives_ok(
  $$ insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
     values ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
             'a4000000-0000-4000-8000-000000000001', 1) $$,
  'rider1 can subscribe to a stop of its route'
);
select throws_ok(
  $$ insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
     values ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
             'a4000000-0000-4000-8000-000000000002', 1) $$,
  '42501', null, 'rider1 cannot subscribe to a route it cannot see'
);
select throws_ok(
  $$ insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
     values ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
             'a4000000-0000-4000-8000-000000000001', 1) $$,
  '42501', null, 'rider1 cannot create a subscription for another device'
);
select throws_ok(
  $$ insert into public.membership (operator_id, device_id, audience_id)
     values ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
             'a5000000-0000-4000-8000-000000000002') $$,
  '42501', null, 'riders cannot create memberships directly'
);
update public.route set name = '{"en": "hacked"}' where id = 'a1000000-0000-4000-8000-000000000001';
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('a0000000-0000-4000-8000-000000000001', '{"en": "x"}') $$,
  '42501', null, 'riders cannot create routes'
);

-- =============================================================================
-- rider2: member of aud_A2 (route A2, map)
-- =============================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-000000000002", "role": "authenticated", "is_anonymous": true}', true);

select is(
  (select name ->> 'en' from public.route where id = 'a1000000-0000-4000-8000-000000000001'),
  null,
  'rider2 does not see route A1'
);
select ok(
  exists (select 1 from public.stop_location where id = 'a2000000-0000-4000-8000-000000000002'),
  'rider2 gets the location of the A2 stop (map level)'
);
select ok(
  exists (select 1 from public.shape where id = 'a3000000-0000-4000-8000-000000000002'),
  'rider2 sees the A2 shape'
);
select set_eq(
  $$ select vehicle_id from public.vehicle_state $$,
  array['a6000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000003']::uuid[],
  'rider2 sees the vehicle positions on A2 (map) and A3 (public)'
);
select is((select count(*) from public.subscription), 1::bigint, 'rider2 sees its own subscription');

reset role;
update public.trip_instance set off_route_since = now() where id = 'a7000000-0000-4000-8000-000000000002';
update public.trip_instance set status = 'completed' where id = 'a7000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-000000000002", "role": "authenticated", "is_anonymous": true}', true);

select is_empty(
  $$ select 1 from public.vehicle_state $$,
  'no position while the vehicle is off route or the trip is not active'
);
select is(
  (select count(*) from public.trip_instance where off_route_since is not null),
  1::bigint,
  'rider2 still sees that the trip is off route'
);

reset role;
update public.trip_instance set off_route_since = null where id = 'a7000000-0000-4000-8000-000000000002';
update public.trip_instance set status = 'active' where id = 'a7000000-0000-4000-8000-000000000003';

-- =============================================================================
-- rider3: member of aud_A2eta (route A2 with map, but this audience has
-- arrival times only)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-000000000003", "role": "authenticated", "is_anonymous": true}', true);

select ok(
  exists (select 1 from public.route where id = 'a1000000-0000-4000-8000-000000000002'),
  'rider3 sees route A2'
);
select ok(
  not exists (select 1 from public.stop_location where id = 'a2000000-0000-4000-8000-000000000002')
  and not exists (select 1 from public.shape where id = 'a3000000-0000-4000-8000-000000000002')
  and not exists (select 1 from public.vehicle_state where vehicle_id = 'a6000000-0000-4000-8000-000000000002'),
  'rider3 gets no stop location, shape or position for A2'
);
select ok(
  exists (select 1 from public.stop_event where trip_instance_id = 'a7000000-0000-4000-8000-000000000002'),
  'rider3 gets ETAs for A2'
);

-- =============================================================================
-- Not signed in (anon)
-- =============================================================================
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select set_eq(
  $$ select id from public.route where operator_id <> 'd0000000-0000-4000-8000-000000000001' $$,
  array['a1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001']::uuid[],
  'anon sees public routes only'
);
select set_eq(
  $$ select vehicle_id from public.vehicle_state $$,
  array['a6000000-0000-4000-8000-000000000003']::uuid[],
  'anon sees the vehicle position on the public route only'
);
select is_empty(
  $$ select 1 from public.route where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'anon sees nothing of the demo school (invited routes only)'
);
select throws_ok(
  $$ select * from public.redeem_invite_code('TEST-A1') $$,
  '42501', null, 'anon cannot redeem invite codes (sign in anonymously first)'
);

-- =============================================================================
-- Staff of operator A
-- =============================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-4000-8000-0000000000a3", "role": "authenticated"}', true);

-- driver
select is(
  (select count(*) from public.route where operator_id = 'a0000000-0000-4000-8000-000000000001'),
  4::bigint,
  'driver sees all routes of its operator, including inactive and invited ones'
);
select is_empty(
  $$ select 1 from public.route where operator_id = 'c0000000-0000-4000-8000-000000000001'
     union all select 1 from public.vehicle where operator_id = 'c0000000-0000-4000-8000-000000000001'
     union all select 1 from public.trip_instance where operator_id = 'c0000000-0000-4000-8000-000000000001' $$,
  'driver sees nothing of operator C'
);
select is((select count(*) from public.vehicle), 3::bigint, 'driver sees its operator''s vehicles');
select is_empty(
  $$ select 1 from public.invite_code union all select 1 from public.membership
     union all select 1 from public.subscription union all select 1 from public.audience $$,
  'driver sees no invite codes, memberships, subscriptions or audiences'
);
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('a0000000-0000-4000-8000-000000000001', '{"en": "x"}') $$,
  '42501', null, 'driver cannot create routes'
);
select lives_ok(
  $$ insert into public.trip_instance (operator_id, service_date, kind, pattern_id, started_by, status, title)
     values ('a0000000-0000-4000-8000-000000000001', current_date, 'live',
             'a4000000-0000-4000-8000-000000000001', 'driver', 'active', '{"en": "Excursion"}') $$,
  'driver can start a live trip'
);

-- editor
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-4000-8000-0000000000a2", "role": "authenticated"}', true);

select lives_ok(
  $$ insert into public.route (operator_id, name) values ('a0000000-0000-4000-8000-000000000001', '{"en": "new"}') $$,
  'editor can create routes for its operator'
);
select throws_ok(
  $$ insert into public.route (operator_id, name) values ('b0000000-0000-4000-8000-000000000001', '{"en": "x"}') $$,
  '42501', null, 'editor cannot create routes for another operator'
);
select is((select count(*) from public.membership), 4::bigint, 'editor sees its operator''s memberships');
select is(
  (select count(*) from public.stop_location where operator_id = 'a0000000-0000-4000-8000-000000000001'),
  4::bigint,
  'editor gets all stop locations of its operator'
);
select matches(
  (select code from public.create_invite_code('a5000000-0000-4000-8000-000000000001', 'test')),
  '^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$',
  'editor can create an invite code; the plain code is returned once'
);
select throws_ok(
  $$ select * from public.create_invite_code('b5000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'editor cannot create invite codes for another operator'
);
select throws_ok(
  $$ insert into public.staff_role (operator_id, user_id, role)
     values ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a4', 'editor') $$,
  '42501', null, 'editor cannot manage staff'
);
update public.operator set plan = 'pro' where id = 'a0000000-0000-4000-8000-000000000001';

-- owner
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-4000-8000-0000000000a1", "role": "authenticated"}', true);

select lives_ok(
  $$ insert into public.staff_role (operator_id, user_id, role)
     values ('a0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a4', 'driver') $$,
  'owner can add staff'
);
select throws_ok(
  $$ insert into public.staff_role (operator_id, user_id, role)
     values ('a0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'driver') $$,
  '23514', null, 'an anonymous rider cannot become staff'
);
select throws_ok(
  $$ insert into public.staff_role (operator_id, user_id, role)
     values ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000a1', 'owner') $$,
  '42501', null, 'owner cannot grant itself a role at another operator'
);

-- owner of operator B
select set_config('request.jwt.claims', '{"sub": "e0000000-0000-4000-8000-0000000000b1", "role": "authenticated"}', true);

select is_empty(
  $$ select 1 from public.invite_code where operator_id = 'a0000000-0000-4000-8000-000000000001'
     union all select 1 from public.membership where operator_id = 'a0000000-0000-4000-8000-000000000001'
     union all select 1 from public.vehicle where operator_id = 'a0000000-0000-4000-8000-000000000001'
     union all select 1 from public.staff_role where operator_id = 'a0000000-0000-4000-8000-000000000001'
     union all select 1 from public.audience where operator_id = 'a0000000-0000-4000-8000-000000000001' $$,
  'owner of B sees no private data of A'
);
select set_eq(
  $$ select id from public.route where operator_id = 'a0000000-0000-4000-8000-000000000001' $$,
  array['a1000000-0000-4000-8000-000000000003']::uuid[],
  'owner of B sees only A''s public route, like anyone'
);

-- Effects of the forbidden updates above --------------------------------------
reset role;
select is(
  (select name ->> 'en' from public.route where id = 'a1000000-0000-4000-8000-000000000001'),
  'A1',
  'rider1''s update of a route changed nothing'
);
select is(
  (select plan from public.operator where id = 'a0000000-0000-4000-8000-000000000001'),
  'demo',
  'editor''s update of the operator changed nothing (owners only)'
);

select * from finish();
rollback;
