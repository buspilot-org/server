-- Rider app needs: delete_my_device(), the own followed stop on a mini map,
-- stop_location for the service role, posts for members only, my_routes().
--
-- Fixture
--   Demo operator from seed.sql: route A (invited_eta), audience "parents",
--   general post "Welcome".
--   Operator P (hotel): public route PR with stop PS, invited route PI;
--   posts: general, on route PR, for audience aud_PI.
--   riderA: member of the demo audience. riderB: no membership.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email, is_anonymous) values
  ('f8000000-0000-4000-8000-00000000000a', null, true),
  ('f8000000-0000-4000-8000-00000000000b', null, true),
  ('e8000000-0000-4000-8000-000000000001', 'editor-demo-8@example.test', false);
insert into public.device (id) values
  ('f8000000-0000-4000-8000-00000000000a'),
  ('f8000000-0000-4000-8000-00000000000b');
insert into public.staff_role (operator_id, user_id, role) values
  ('d0000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001', 'editor');
insert into public.membership (operator_id, device_id, audience_id) values
  ('d0000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000601');

insert into public.operator (id, slug, name, default_visibility) values
  ('80000000-0000-4000-8000-000000000001', 'rider-test-hotel', '{"en": "Hotel"}', 'invited_eta');
insert into public.route (id, operator_id, name, visibility) values
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '{"en": "PR"}', 'public'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', '{"en": "PI"}', null);
insert into public.stop (id, operator_id, name, location) values
  ('82000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '{"en": "PS"}', 'SRID=4326;POINT(135.2 34.7)');
insert into public.trip_pattern (id, operator_id, route_id, name) values
  ('83000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'PR');
insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset) values
  ('80000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', 1, '82000000-0000-4000-8000-000000000001', 0, 0);
insert into public.audience (id, operator_id, name) values
  ('85000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '{"en": "aud_PI"}');
insert into public.audience_route (operator_id, audience_id, route_id) values
  ('80000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002');
insert into public.post (id, operator_id, title, body, audience_id, route_id, category, published_at) values
  ('86000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '{"en": "general"}', '{"en": "x"}', null, null, 'general', now() - interval '1 hour'),
  ('86000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', '{"en": "route PR"}', '{"en": "x"}', null, '81000000-0000-4000-8000-000000000001', 'delay', now() - interval '1 hour'),
  ('86000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000001', '{"en": "aud_PI"}', '{"en": "x"}', '85000000-0000-4000-8000-000000000001', null, 'event', now() - interval '1 hour');

-- =============================================================================
-- riderA: member of the demo audience (arrival times only)
-- =============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f8000000-0000-4000-8000-00000000000a", "role": "authenticated", "is_anonymous": true}', true);

select is_empty(
  $$ select 1 from public.stop_location where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'riderA (arrival times only) gets no stop locations before following a stop'
);
insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
values ('d0000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-00000000000a',
        'd0000000-0000-4000-8000-000000000301', 3);
select results_eq(
  $$ select id from public.stop_location where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  $$ values ('d0000000-0000-4000-8000-000000000203'::uuid) $$,
  'riderA gets the location of the followed stop (Sannomiya) only'
);
select throws_ok(
  $$ select location from public.stop $$,
  '42501', null, 'riders still cannot read stop.location directly'
);
select is_empty(
  $$ select 1 from public.shape where operator_id = 'd0000000-0000-4000-8000-000000000001'
     union all select 1 from public.vehicle_state where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'following a stop shows no shape or vehicle position'
);

select set_eq(
  $$ select title ->> 'en' from public.post $$,
  array['Welcome to Buspilot', 'route PR'],
  'riderA: general post of its operator and the public route''s post; not P''s general or audience post'
);
select results_eq(
  $$ select id from public.my_routes() $$,
  $$ values ('d0000000-0000-4000-8000-000000000101'::uuid) $$,
  'my_routes: the routes of riderA''s operator, not every public route'
);
select ok(
  (select count(*) from public.route where id = '81000000-0000-4000-8000-000000000001') = 1,
  'a public route is still readable by id (link or QR code)'
);

-- =============================================================================
-- riderB: no membership, follows the public route
-- =============================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f8000000-0000-4000-8000-00000000000b", "role": "authenticated", "is_anonymous": true}', true);

select is_empty($$ select 1 from public.my_routes() $$, 'my_routes: empty for a device that follows nothing');
insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
values ('80000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-00000000000b',
        '83000000-0000-4000-8000-000000000001', 1);
select results_eq(
  $$ select id from public.my_routes() $$,
  $$ values ('81000000-0000-4000-8000-000000000001'::uuid) $$,
  'my_routes: the public route riderB follows'
);
select set_eq(
  $$ select title ->> 'en' from public.post $$,
  array['route PR'],
  'riderB (visitor of a public route): only that route''s posts, no general posts'
);
select results_eq(
  $$ select r.id, p.title ->> 'en', p.category::text from public.my_routes() r
       join public.post p on p.route_id = r.id $$,
  $$ values ('81000000-0000-4000-8000-000000000001'::uuid, 'route PR', 'delay') $$,
  'posts carry their category'
);

-- =============================================================================
-- anon
-- =============================================================================
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select set_eq(
  $$ select title ->> 'en' from public.post $$,
  array['route PR'],
  'anon: only posts of public routes'
);
select throws_ok($$ select * from public.my_routes() $$, '42501', null, 'anon cannot call my_routes');
select throws_ok($$ select public.delete_my_device() $$, '42501', null, 'anon cannot call delete_my_device');

-- =============================================================================
-- Staff
-- =============================================================================
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e8000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select ok(
  (select count(*) from public.post where operator_id = 'd0000000-0000-4000-8000-000000000001') >= 1,
  'staff read their operator''s posts'
);
select is(
  (select count(*) from public.stop_location where operator_id = 'd0000000-0000-4000-8000-000000000001'),
  5::bigint,
  'staff get all of their operator''s stop locations'
);
select throws_ok(
  $$ select public.delete_my_device() $$,
  '42501', null, 'delete_my_device refuses staff accounts'
);

-- =============================================================================
-- Service role (engine, scripts)
-- =============================================================================
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select lives_ok($$ select count(*) from public.stop_location $$, 'service role reads stop_location (no permission error)');
select is(
  (select count(*) from public.stop_location),
  (select count(*) from public.stop),
  'service role gets every stop location'
);

-- =============================================================================
-- Losing access, then deleting the device
-- =============================================================================
reset role;
update public.membership set revoked_at = now()
 where device_id = 'f8000000-0000-4000-8000-00000000000a';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f8000000-0000-4000-8000-00000000000a", "role": "authenticated", "is_anonymous": true}', true);
select is_empty(
  $$ select 1 from public.stop_location where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'after the membership is revoked the followed stop''s location is gone too'
);
reset role;
update public.membership set revoked_at = null
 where device_id = 'f8000000-0000-4000-8000-00000000000a';
insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
values ('d0000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-00000000000a',
        'd0000000-0000-4000-8000-000000000301', 3);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f8000000-0000-4000-8000-00000000000a", "role": "authenticated", "is_anonymous": true}', true);
select lives_ok($$ select public.delete_my_device() $$, 'riderA deletes its data');
reset role;
select ok(
  not exists (select 1 from auth.users where id = 'f8000000-0000-4000-8000-00000000000a'),
  'the anonymous auth user is deleted'
);
select ok(
  not exists (select 1 from public.device where id = 'f8000000-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.membership where device_id = 'f8000000-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.subscription where device_id = 'f8000000-0000-4000-8000-00000000000a'),
  'device, memberships and subscriptions are gone'
);
select ok(
  exists (select 1 from auth.users where id = 'f8000000-0000-4000-8000-00000000000b')
  and exists (select 1 from public.subscription where device_id = 'f8000000-0000-4000-8000-00000000000b'),
  'other devices are untouched'
);
select ok(
  exists (select 1 from auth.users where id = 'e8000000-0000-4000-8000-000000000001'),
  'the staff account is still there'
);

select * from finish();
rollback;
