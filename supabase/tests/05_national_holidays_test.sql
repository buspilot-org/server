-- National holidays: the table, the scheduler skipping them, and
-- service_days() for the apps. Uses the demo operator from seed.sql
-- (Monday–Friday calendar with skip_national_holidays, two trips).
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

delete from public.trip_instance;

-- The table ---------------------------------------------------------------------
select is(
  (select name from public.national_holiday where date = '2026-11-23'),
  '{"ja": "勤労感謝の日", "en": "Labour Thanksgiving Day", "de": "Tag des Dankes für die Arbeit"}'::jsonb,
  'Labour Thanksgiving Day 2026 in ja, en and de'
);
select results_eq(
  $$ select extract(year from date)::integer, count(*)::integer from public.national_holiday group by 1 order by 1 $$,
  $$ values (2026, 18), (2027, 17) $$,
  'the current and the next year from the Cabinet Office CSV (incl. substitute and bridge holidays)'
);
select ok(
  exists (select 1 from public.national_holiday where date = '2026-09-22' and name ->> 'ja' = '休日'),
  'bridge holiday 2026-09-22 (国民の休日) is listed'
);
select throws_ok(
  $$ insert into public.national_holiday (date, name) values ('2028-01-01', '{"en": "New Year"}') $$,
  '23514', null, 'a holiday needs a Japanese name'
);

-- Scheduler -------------------------------------------------------------------
select is(
  private.create_trip_instances('2026-11-23', '2026-11-24'),
  2,
  'Monday 2026-11-23 is a national holiday: only Tuesday''s two trips'
);
update public.service_calendar set skip_national_holidays = false
 where id = 'd0000000-0000-4000-8000-000000000501';
select is(
  private.create_trip_instances('2026-11-23', '2026-11-24'),
  2,
  'without skip_national_holidays the holiday gets its trips too'
);
update public.service_calendar set skip_national_holidays = true
 where id = 'd0000000-0000-4000-8000-000000000501';
insert into public.calendar_exception (operator_id, calendar_id, start_date, end_date, type, reason)
values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000501',
        '2027-03-22', '2027-03-22', 'added', 'School open on the substitute holiday');
select is(
  private.create_trip_instances('2027-03-22', '2027-03-22'),
  2,
  'an added exception wins over a national holiday'
);

-- service_days() ------------------------------------------------------------
insert into auth.users (id, is_anonymous) values ('f5000000-0000-4000-8000-000000000001', true);
insert into public.device (id) values ('f5000000-0000-4000-8000-000000000001');
insert into public.membership (operator_id, device_id, audience_id)
values ('d0000000-0000-4000-8000-000000000001', 'f5000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000601');

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select ok(
  exists (select 1 from public.national_holiday where date = '2027-01-01'),
  'anon reads national holidays'
);
select is_empty(
  $$ select 1 from public.service_days('2026-11-16', '2026-11-29') where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'anon gets no service days of the demo school (invited routes only)'
);
select throws_ok(
  $$ delete from public.national_holiday $$,
  '42501', null, 'anon cannot change national holidays'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f5000000-0000-4000-8000-000000000001", "role": "authenticated", "is_anonymous": true}', true);
select throws_ok(
  $$ update public.national_holiday set name = '{"ja": "x"}' $$,
  '42501', null, 'riders cannot change national holidays'
);
select results_eq(
  $$ select service_date from public.service_days('2026-11-16', '2026-11-29', 'd0000000-0000-4000-8000-000000000001') $$,
  $$ values ('2026-11-16'::date), ('2026-11-17'::date), ('2026-11-18'::date), ('2026-11-19'::date), ('2026-11-20'::date),
            ('2026-11-24'::date), ('2026-11-25'::date), ('2026-11-26'::date), ('2026-11-27'::date) $$,
  'member: weekdays without the holiday on 2026-11-23'
);
select results_eq(
  $$ select service_date, national_holiday ->> 'en' from public.service_days('2027-03-20', '2027-03-23') $$,
  $$ values ('2027-03-22'::date, 'Substitute or bridge holiday'), ('2027-03-23'::date, null) $$,
  'an added exception on a holiday is a service day, marked with the holiday'
);
select is_empty(
  $$ select 1 from public.service_days('2026-12-24', '2027-01-07') $$,
  'winter break (removed exception): no service days'
);
select throws_ok(
  $$ select * from public.service_days('2026-01-01', '2027-03-01') $$,
  '22023', null, 'at most 400 days per call'
);

reset role;
select ok(
  not has_table_privilege('authenticated', 'public.national_holiday', 'insert')
  and not has_table_privilege('anon', 'public.national_holiday', 'insert'),
  'API roles cannot insert national holidays'
);

select * from finish();
rollback;
