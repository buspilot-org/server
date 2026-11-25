-- Japanese national holidays, and calendars that skip them.
--
-- Design: internal/concept/data-model.md ("Decisions after the first
-- schema": national holidays come from a table filled yearly from the Cabinet
-- Office's official CSV).
--
-- Holidays are reference data for the hosted project too, so they are filled
-- by migrations (20261126100100_national_holidays_2026_2027.sql), generated
-- with supabase/scripts/national-holidays.mjs. Add next year's in a new
-- migration each February, when the Cabinet Office publishes them.

create table public.national_holiday (
  date date primary key,
  -- {"ja": "元日", "en": "New Year's Day", "de": "Neujahr"}
  name jsonb not null check (private.is_i18n_text(name) and name ? 'ja'),
  created_at timestamptz not null default now()
);

comment on table public.national_holiday is
  'Japanese national holidays (国民の祝日・休日) from the Cabinet Office CSV. Readable by everyone; written by migrations only.';

alter table public.national_holiday enable row level security;

-- Public knowledge: everyone reads, nobody but migrations / the service role
-- writes.
revoke insert, update, delete on public.national_holiday from anon, authenticated;

create policy "everyone reads national holidays" on public.national_holiday
  for select to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- Does a calendar run on a date?
-- -----------------------------------------------------------------------------

-- A calendar runs on a date when
-- - an `added` exception covers it, or
-- - the date is within start_date..end_date, its weekday bit is set
--   (bit 0 = Monday … bit 6 = Sunday), no `removed` exception covers it and,
--   with skip_national_holidays, it is not a national holiday.
-- An `added` exception wins over a holiday ("we run on Marine Day this year").
-- Reads the calendar's exceptions with the caller's rights (security
-- invoker), so it can back RPCs that respect RLS.
create function private.calendar_runs_on(
  p_calendar_id uuid,
  p_weekdays smallint,
  p_start_date date,
  p_end_date date,
  p_skip_national_holidays boolean,
  p_date date
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
      select 1 from public.calendar_exception e
       where e.calendar_id = p_calendar_id and e.type = 'added'
         and p_date between e.start_date and e.end_date
    )
    or (
      p_date between p_start_date and p_end_date
      and (p_weekdays & (1 << (extract(isodow from p_date)::integer - 1))) <> 0
      and not exists (
        select 1 from public.calendar_exception e
         where e.calendar_id = p_calendar_id and e.type = 'removed'
           and p_date between e.start_date and e.end_date
      )
      and not (
        p_skip_national_holidays
        and exists (select 1 from public.national_holiday h where h.date = p_date)
      )
    )
$$;

comment on function private.calendar_runs_on(uuid, smallint, date, date, boolean, date) is
  'True if a service calendar runs on a date (weekdays, validity, exceptions, national holidays).';

-- -----------------------------------------------------------------------------
-- Scheduler: skip national holidays
-- -----------------------------------------------------------------------------

-- Same as before (20261123140000_engine_scheduler.sql), with the calendar
-- check moved into private.calendar_runs_on, which now applies
-- skip_national_holidays.
create or replace function private.create_trip_instances(p_from date, p_to date, p_operator_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  created integer;
begin
  with days as (
    select d::date as service_date
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d
  ),
  runs as (
    select t.operator_id, t.id as trip_id, d.service_date
      from public.trip t
      join public.service_calendar c on c.id = t.service_calendar_id
      join public.trip_pattern p on p.id = t.pattern_id
      join public.route r on r.id = p.route_id
     cross join days d
     where r.active
       and (p_operator_id is null or t.operator_id = p_operator_id)
       and private.calendar_runs_on(c.id, c.weekdays, c.start_date, c.end_date, c.skip_national_holidays, d.service_date)
  ),
  inserted as (
    insert into public.trip_instance (operator_id, service_date, kind, trip_id)
    select operator_id, service_date, 'scheduled', trip_id from runs
    on conflict (service_date, trip_id) do nothing
    returning id, operator_id, trip_id
  ),
  stop_events as (
    insert into public.stop_event (operator_id, trip_instance_id, stop_sequence)
    select i.operator_id, i.id, ps.stop_sequence
      from inserted i
      join public.trip t on t.id = i.trip_id
      join public.pattern_stop ps on ps.pattern_id = t.pattern_id
    on conflict do nothing
  )
  select count(*) into created from inserted;
  return created;
end;
$$;

comment on function private.create_trip_instances(date, date, uuid) is
  'Creates planned scheduled trip instances and their stop events for the dates a trip''s calendar runs on (incl. national holidays). Idempotent.';

-- -----------------------------------------------------------------------------
-- Service days for the apps (rider app calendar, admin preview)
-- -----------------------------------------------------------------------------

-- The dates in [p_from, p_to] on which each calendar the caller can see runs,
-- national holidays applied. At most 400 days per call. RLS decides which
-- calendars (and exceptions) are visible, so riders get the calendars of
-- the routes they see, staff those of their operator. national_holiday is
-- the holiday's name when a returned date is one.
--
--   select * from service_days('2026-12-01', '2026-12-31');
--   select * from service_days('2026-12-01', '2026-12-31', '<operator id>');
create function public.service_days(p_from date, p_to date, p_operator_id uuid default null)
returns table (calendar_id uuid, operator_id uuid, service_date date, national_holiday jsonb)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'p_from..p_to must be a range of at most 400 days' using errcode = 'invalid_parameter_value';
  end if;

  return query
  select c.id, c.operator_id, d::date, h.name
    from public.service_calendar c
   cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d
    left join public.national_holiday h on h.date = d::date
   where (p_operator_id is null or c.operator_id = p_operator_id)
     and private.calendar_runs_on(c.id, c.weekdays, c.start_date, c.end_date, c.skip_national_holidays, d::date)
   order by c.id, d;
end;
$$;

comment on function public.service_days(date, date, uuid) is
  'Dates on which each visible service calendar runs in [p_from, p_to] (max. 400 days), national holidays applied; national_holiday is the holiday''s name when the date is one (calendar without skip_national_holidays, or an added exception).';

revoke execute on function public.service_days(date, date, uuid) from public;
grant execute on function public.service_days(date, date, uuid) to anon, authenticated, service_role;

revoke execute on all functions in schema private from public;
grant execute on function private.calendar_runs_on(uuid, smallint, date, date, boolean, date) to anon, authenticated, service_role;
