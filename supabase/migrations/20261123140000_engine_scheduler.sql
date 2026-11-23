-- Engine support: default vehicle per trip, and the scheduler job that
-- creates trip instances and their stop events from the service calendars.
--
-- Design: internal/concept/engine.md ("Trip assigner", "Scheduler jobs").

-- -----------------------------------------------------------------------------
-- trip.vehicle_id
-- -----------------------------------------------------------------------------

-- "Vehicle A runs the morning route on weekdays" (arrival-alerts.md): the
-- vehicle that normally runs a trip. Copied to each trip instance; the trip
-- assigner only starts an instance with its own vehicle. Null means any
-- vehicle of the operator may run it.
alter table public.trip add column vehicle_id uuid;
alter table public.trip
  add foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id)
  on delete set null (vehicle_id);
create index trip_vehicle_id_idx on public.trip (operator_id, vehicle_id) where vehicle_id is not null;

comment on column public.trip.vehicle_id is
  'Vehicle that normally runs this trip (copied to trip instances). Null = any vehicle of the operator.';

-- -----------------------------------------------------------------------------
-- Trip instances from calendars
-- -----------------------------------------------------------------------------

-- Creates scheduled trip instances (status planned) and one upcoming stop
-- event per pattern stop for every service date in [p_from, p_to] on which
-- the trip's calendar runs. Idempotent: existing instances and stop events
-- are left alone. Returns the number of trip instances created.
--
-- A calendar runs on a date when the date is within start_date..end_date,
-- its weekday bit is set (bit 0 = Monday … bit 6 = Sunday) and no `removed`
-- exception covers it, or when an `added` exception covers it.
--
-- Not yet: skip_national_holidays (needs a holiday table for Japan; until
-- then instances are created on holidays too, and simply never start
-- because no bus runs).
create function private.create_trip_instances(p_from date, p_to date, p_operator_id uuid default null)
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
    select t.operator_id, t.id as trip_id, t.vehicle_id, d.service_date
      from public.trip t
      join public.service_calendar c on c.id = t.service_calendar_id
      join public.trip_pattern p on p.id = t.pattern_id
      join public.route r on r.id = p.route_id
     cross join days d
     where r.active
       and (p_operator_id is null or t.operator_id = p_operator_id)
       and (
         (
           d.service_date between c.start_date and c.end_date
           and (c.weekdays & (1 << (extract(isodow from d.service_date)::integer - 1))) <> 0
           and not exists (
             select 1 from public.calendar_exception e
              where e.calendar_id = c.id and e.type = 'removed'
                and d.service_date between e.start_date and e.end_date
           )
         )
         or exists (
           select 1 from public.calendar_exception e
            where e.calendar_id = c.id and e.type = 'added'
              and d.service_date between e.start_date and e.end_date
         )
       )
  ),
  inserted as (
    insert into public.trip_instance (operator_id, service_date, kind, trip_id, vehicle_id)
    select operator_id, service_date, 'scheduled', trip_id, vehicle_id from runs
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

-- The scheduler job: today and tomorrow in each operator's time zone.
create function private.create_upcoming_trip_instances(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  local_today date;
  total integer := 0;
begin
  for o in select id, timezone from public.operator loop
    local_today := (p_now at time zone o.timezone)::date;
    total := total + private.create_trip_instances(local_today, local_today + 1, o.id);
  end loop;
  return total;
end;
$$;

revoke execute on function private.create_trip_instances(date, date, uuid) from public, anon, authenticated;
revoke execute on function private.create_upcoming_trip_instances(timestamptz) from public, anon, authenticated;
grant execute on function private.create_trip_instances(date, date, uuid) to service_role;
grant execute on function private.create_upcoming_trip_instances(timestamptz) to service_role;
