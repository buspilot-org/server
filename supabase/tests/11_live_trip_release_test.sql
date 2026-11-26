-- progress_m only increases, except when the engine releases a live trip
-- (active → planned, 20261128100000_live_trip_release.sql).
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into public.operator (id, slug, name) values
  ('ac000000-0000-4000-8000-000000000001', 'release-test', '{"en": "Release test"}');
insert into public.trip_instance (id, operator_id, service_date, kind, started_by, title, status, progress_m, started_at) values
  ('ac000000-0000-4000-8000-0000000000a1', 'ac000000-0000-4000-8000-000000000001', '2027-03-06', 'live', 'driver', '{"en": "Live"}', 'active', 500, now()),
  ('ac000000-0000-4000-8000-0000000000a2', 'ac000000-0000-4000-8000-000000000001', '2027-03-06', 'live', 'driver', '{"en": "Live"}', 'active', 500, now()),
  ('ac000000-0000-4000-8000-0000000000a3', 'ac000000-0000-4000-8000-000000000001', '2027-03-06', 'live', 'driver', '{"en": "Live"}', 'active', 500, now());
-- a3 has reached a stop.
insert into public.stop_event (operator_id, trip_instance_id, stop_sequence, state, arrived_at) values
  ('ac000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-0000000000a3', 1, 'arrived', now());

select throws_ok(
  $$update public.trip_instance set progress_m = 100 where id = 'ac000000-0000-4000-8000-0000000000a1'$$,
  '23514', null, 'progress_m does not go back for a running trip'
);
select lives_ok(
  $$update public.trip_instance set status = 'planned', progress_m = 0, started_at = null
     where id = 'ac000000-0000-4000-8000-0000000000a1'$$,
  'a running live trip released to planned starts again from 0'
);
select is((select progress_m from public.trip_instance where id = 'ac000000-0000-4000-8000-0000000000a1'), 0::double precision, 'progress reset');
select throws_ok(
  $$update public.trip_instance set status = 'completed', progress_m = 0 where id = 'ac000000-0000-4000-8000-0000000000a2'$$,
  '23514', null, 'not when the trip is completed'
);
select throws_ok(
  $$update public.trip_instance set status = 'planned', progress_m = 100, started_at = null where id = 'ac000000-0000-4000-8000-0000000000a2'$$,
  '23514', null, 'only back to 0'
);
select throws_ok(
  $$update public.trip_instance set status = 'planned', progress_m = 0 where id = 'ac000000-0000-4000-8000-0000000000a2'$$,
  '23514', null, 'only when not started any more'
);
select throws_ok(
  $$update public.trip_instance set status = 'planned', progress_m = 0, started_at = null where id = 'ac000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'not once it has reached a stop'
);

select * from finish();
rollback;
