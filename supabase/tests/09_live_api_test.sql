-- Engine live API: route and stop slugs, change notifications.
--
-- Fixture
--   Demo operator from seed.sql (slugs morning-a, shin-kobe, …).
--   Operator L: public route LR, stop LS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into public.operator (id, slug, name, default_visibility) values
  ('90000000-0000-4000-8000-000000000001', 'live-test-hotel', '{"en": "Hotel"}', 'invited_eta');
insert into public.route (id, operator_id, name, visibility, slug) values
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '{"en": "LR"}', 'public', 'shuttle');
insert into public.stop (id, operator_id, name, location, slug) values
  ('92000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '{"en": "LS"}', 'SRID=4326;POINT(135.2 34.7)', 'lobby');
insert into public.trip_pattern (id, operator_id, route_id, name) values
  ('93000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'LR');
insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset) values
  ('90000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', 1, '92000000-0000-4000-8000-000000000001', 0, 0);

-- -----------------------------------------------------------------------------
-- Slugs
-- -----------------------------------------------------------------------------

select has_column('public', 'route', 'slug', 'route has a slug');
select has_column('public', 'stop', 'slug', 'stop has a slug');
select is(
  (select slug from public.route where id = 'd0000000-0000-4000-8000-000000000101'),
  'morning-a',
  'the seed route has a slug'
);
select results_eq(
  $$ select slug from public.stop where operator_id = 'd0000000-0000-4000-8000-000000000001' order by slug $$,
  $$ values ('kitano-zaka'), ('motomachi'), ('sannomiya'), ('school'), ('shin-kobe') $$,
  'the seed stops have slugs'
);

select throws_ok(
  $$ update public.route set slug = 'Shuttle' where id = '91000000-0000-4000-8000-000000000001' $$,
  '23514', null,
  'a route slug is lower case'
);
select throws_ok(
  $$ update public.stop set slug = 'lobby-' where id = '92000000-0000-4000-8000-000000000001' $$,
  '23514', null,
  'a stop slug does not end with a hyphen'
);
select throws_ok(
  $$ update public.route set slug = repeat('a', 64) where id = '91000000-0000-4000-8000-000000000001' $$,
  '23514', null,
  'a slug has at most 63 characters'
);
select throws_ok(
  $$ insert into public.route (operator_id, name, slug) values ('90000000-0000-4000-8000-000000000001', '{"en": "x"}', 'shuttle') $$,
  '23505', null,
  'route slugs are unique per operator'
);
select throws_ok(
  $$ insert into public.stop (operator_id, name, location, slug) values ('90000000-0000-4000-8000-000000000001', '{"en": "x"}', 'SRID=4326;POINT(135.2 34.7)', 'lobby') $$,
  '23505', null,
  'stop slugs are unique per operator'
);
select lives_ok(
  $$ insert into public.route (operator_id, name, slug) values ('d0000000-0000-4000-8000-000000000001', '{"en": "x"}', 'shuttle') $$,
  'another operator may use the same route slug'
);
select lives_ok(
  $$ insert into public.route (operator_id, name) values ('90000000-0000-4000-8000-000000000001', '{"en": "no slug 1"}'),
                                                    ('90000000-0000-4000-8000-000000000001', '{"en": "no slug 2"}') $$,
  'slugs are optional'
);

-- Visitors (anon) read the slugs of public routes and their stops.
set local role anon;
select is(
  (select slug from public.route where id = '91000000-0000-4000-8000-000000000001'),
  'shuttle',
  'anon reads the slug of a public route'
);
select is(
  (select slug from public.stop where id = '92000000-0000-4000-8000-000000000001'),
  'lobby',
  'anon reads the slug of a stop of a public route (column privilege)'
);
select is_empty(
  $$ select 1 from public.route where slug = 'morning-a' $$,
  'anon does not see the slug of an invited route'
);
reset role;

-- -----------------------------------------------------------------------------
-- Change notifications
-- -----------------------------------------------------------------------------

select has_trigger('public', 'membership', 'notify_live_change', 'membership changes notify the engine');
select has_trigger('public', 'trip_instance_audience', 'notify_live_change', 'live trip audience changes notify the engine');
select has_trigger('public', 'trip_instance', 'notify_live_change_update', 'staff changes of trip instances notify the engine');
-- The engine's own progress writes do not: only staff-relevant columns.
select ok(
  pg_get_triggerdef((select oid from pg_trigger where tgname = 'notify_live_change_update' and tgrelid = 'public.trip_instance'::regclass))
    !~ 'progress_m',
  'progress updates do not notify'
);
select lives_ok(
  $$ update public.membership set revoked_at = revoked_at where false $$,
  'the notify trigger runs without errors'
);

select * from finish();
rollback;
