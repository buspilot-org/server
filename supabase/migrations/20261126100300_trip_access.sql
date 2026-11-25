-- Who sees which trip instance: drivers see their vehicles' trips, live
-- trips get planned stops and audiences chosen per trip, and riders can
-- follow a stop of a live trip.
--
-- Design: internal/concept/admin-console.md ("driver – sees today's trips for
-- their vehicle"), data-model.md ("Decisions after the first schema": live
-- trips are visible to audiences chosen by staff), arrival-alerts.md
-- ("Decisions (2026-11-26)": alerts for live trips, per trip; planned stops
-- on live trips), product.md ("Tour package").

-- -----------------------------------------------------------------------------
-- Driver ↔ vehicle
-- -----------------------------------------------------------------------------

-- The vehicles a driver drives. A driver sees (and may start and update) the
-- trip instances run by one of these vehicles, and those that any vehicle of
-- the operator may run (no vehicle on the instance nor a default vehicle on
-- the trip). Owners and editors see everything, as before. A driver without
-- a row here sees only the "any vehicle" trips.
create table public.driver_vehicle (
  operator_id uuid not null,
  user_id uuid not null,
  vehicle_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (operator_id, user_id, vehicle_id),
  foreign key (operator_id, user_id) references public.staff_role (operator_id, user_id) on delete cascade,
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete cascade
);

create index driver_vehicle_vehicle_id_idx on public.driver_vehicle (operator_id, vehicle_id);

comment on table public.driver_vehicle is
  'Vehicles a driver drives; drivers see only these vehicles'' trips (and trips any vehicle may run).';

create function private.drives_vehicle(p_operator_id uuid, p_vehicle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.driver_vehicle dv
     where dv.operator_id = p_operator_id
       and dv.user_id = (select auth.uid())
       and dv.vehicle_id = p_vehicle_id
  )
$$;

-- Staff access to a trip instance, from its columns (so it also works on the
-- new row in WITH CHECK): editors and owners always; drivers if the vehicle
-- that runs it (instance vehicle, else the trip's default vehicle) is theirs,
-- or if no vehicle is set.
create function private.staff_trip_access(p_operator_id uuid, p_vehicle_id uuid, p_trip_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vehicle_id uuid := p_vehicle_id;
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  if private.can_edit(p_operator_id) then
    return true;
  end if;
  if not private.has_role(p_operator_id, '{driver}') then
    return false;
  end if;
  if v_vehicle_id is null and p_trip_id is not null then
    select t.vehicle_id into v_vehicle_id from public.trip t where t.id = p_trip_id;
  end if;
  return v_vehicle_id is null or private.drives_vehicle(p_operator_id, v_vehicle_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Live trips: planned stops and audiences
-- -----------------------------------------------------------------------------

-- Planned stops of a live trip without a pattern (a tour: "Kiyomizu-dera,
-- 10:30–12:00"). Live trips on a pattern use the pattern's stops instead.
-- Each planned stop gets an `upcoming` stop event (same stop_sequence), which
-- the engine moves forward as for scheduled trips; removing a planned stop
-- removes its stop event (only while the bus has not reached it). Reorder by
-- deleting and inserting.
create table public.trip_instance_stop (
  operator_id uuid not null,
  trip_instance_id uuid not null,
  stop_sequence integer not null check (stop_sequence >= 0),
  stop_id uuid not null,
  planned_arrival timestamptz,
  planned_departure timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (trip_instance_id, stop_sequence),
  unique (operator_id, trip_instance_id, stop_sequence),
  check (planned_arrival is null or planned_departure is null or planned_departure >= planned_arrival),
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete cascade,
  foreign key (operator_id, stop_id) references public.stop (operator_id, id) deferrable initially deferred
);

create index trip_instance_stop_stop_id_idx on public.trip_instance_stop (operator_id, stop_id);

comment on table public.trip_instance_stop is
  'Planned stops (stop, order, planned arrival/departure) of a live trip without a pattern, e.g. a tour itinerary.';

-- Audiences that see a live trip, chosen by staff when the trip starts. The
-- route's audiences (if the trip has a route) see it too.
create table public.trip_instance_audience (
  operator_id uuid not null,
  trip_instance_id uuid not null,
  audience_id uuid not null,
  -- Map (vehicle position, stop locations), or arrival times only.
  can_see_map boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (trip_instance_id, audience_id),
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete cascade,
  foreign key (operator_id, audience_id) references public.audience (operator_id, id) on delete cascade
);

create index trip_instance_audience_audience_id_idx on public.trip_instance_audience (audience_id);

comment on table public.trip_instance_audience is
  'Audiences that see a live trip (chosen per trip), with map or arrival times only.';

-- Security definer: reads the trip instance whatever the caller may see, so
-- the caller gets RLS's answer (42501), not a misleading check error.
create function private.trip_instance_stop_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind public.trip_instance_kind;
  v_pattern_id uuid;
begin
  if tg_op = 'UPDATE' and (
       new.trip_instance_id <> old.trip_instance_id
       or new.operator_id <> old.operator_id
       or new.stop_sequence <> old.stop_sequence
     ) then
    raise exception 'planned stops cannot move to another trip or position; delete and insert instead'
      using errcode = 'check_violation';
  end if;
  select ti.kind, ti.pattern_id into v_kind, v_pattern_id
    from public.trip_instance ti where ti.id = new.trip_instance_id;
  if v_kind is distinct from 'live' or v_pattern_id is not null then
    raise exception 'planned stops are for live trips without a pattern' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trip_instance_stop_check
  before insert or update on public.trip_instance_stop
  for each row execute function private.trip_instance_stop_check();

create trigger set_updated_at
  before update on public.trip_instance_stop
  for each row execute function private.set_updated_at();

-- Stop events follow planned stops. Security definer: drivers and editors
-- may not write stop_event themselves (engine only).
create function private.trip_instance_stop_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.stop_event (operator_id, trip_instance_id, stop_sequence)
    values (new.operator_id, new.trip_instance_id, new.stop_sequence)
    on conflict do nothing;
    return new;
  end if;
  -- The whole trip is being deleted (cascade): its stop events go anyway.
  if not exists (select 1 from public.trip_instance ti where ti.id = old.trip_instance_id) then
    return old;
  end if;
  if exists (
    select 1 from public.stop_event se
     where se.trip_instance_id = old.trip_instance_id
       and se.stop_sequence = old.stop_sequence
       and se.state not in ('upcoming', 'approaching')
  ) then
    raise exception 'the bus has already reached or passed this stop; it cannot be removed from the plan'
      using errcode = 'check_violation';
  end if;
  delete from public.stop_event se
   where se.trip_instance_id = old.trip_instance_id
     and se.stop_sequence = old.stop_sequence;
  return old;
end;
$$;

create trigger trip_instance_stop_events
  after insert or delete on public.trip_instance_stop
  for each row execute function private.trip_instance_stop_events();

create function private.trip_instance_audience_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.trip_instance ti where ti.id = new.trip_instance_id and ti.kind = 'live'
  ) then
    raise exception 'audiences are chosen per trip for live trips only (scheduled trips follow their route)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trip_instance_audience_check
  before insert or update on public.trip_instance_audience
  for each row execute function private.trip_instance_audience_check();

-- A live trip with planned stops or per-trip audiences stays a live trip
-- without a pattern.
create function private.trip_instance_keep_live()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.kind <> 'live' or new.pattern_id is not null)
     and exists (select 1 from public.trip_instance_stop tis where tis.trip_instance_id = new.id) then
    raise exception 'this live trip has planned stops; it cannot get a pattern or become scheduled'
      using errcode = 'check_violation';
  end if;
  if new.kind <> 'live'
     and exists (select 1 from public.trip_instance_audience tia where tia.trip_instance_id = new.id) then
    raise exception 'this live trip has its own audiences; it cannot become scheduled'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Runs after trip_instance_before_write (alphabetical order), so it sees the
-- pattern copied from the trip.
create trigger trip_instance_keep_live
  before update of kind, pattern_id, trip_id on public.trip_instance
  for each row execute function private.trip_instance_keep_live();

-- -----------------------------------------------------------------------------
-- Access level to a trip instance
-- -----------------------------------------------------------------------------

-- 0 none, 1 arrival times only, 2 map, 3 staff (with private.staff_trip_access).
-- Riders: the route's level (if the trip has a route), for live trips at
-- least the level of the trip's audiences they are members of (arrival times
-- only if the route is invited_eta); nothing after visible_until.
create function private.trip_instance_access(p_trip_instance_id uuid)
returns smallint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ti record;
  v_level smallint := 0;
  v_can_see_map boolean;
  v_eta_only boolean;
begin
  select ti.operator_id, ti.kind, ti.trip_id, ti.route_id, ti.vehicle_id, ti.visible_until
    into v_ti
    from public.trip_instance ti
   where ti.id = p_trip_instance_id;
  if not found then
    return 0;
  end if;

  if v_uid is not null and private.is_staff(v_ti.operator_id) then
    return case when private.staff_trip_access(v_ti.operator_id, v_ti.vehicle_id, v_ti.trip_id) then 3 else 0 end;
  end if;

  if v_ti.visible_until is not null and v_ti.visible_until <= now() then
    return 0;
  end if;

  if v_ti.route_id is not null then
    v_level := private.route_access(v_ti.route_id);
  end if;

  if v_ti.kind = 'live' and v_uid is not null then
    -- A route with visibility invited_eta never shows the map to riders,
    -- whatever the trip's audiences say (as for audience_route).
    select coalesce(r.visibility, o.default_visibility) = 'invited_eta'
      into v_eta_only
      from public.route r
      join public.operator o on o.id = r.operator_id
     where r.id = v_ti.route_id;
    select bool_or(tia.can_see_map)
      into v_can_see_map
      from public.trip_instance_audience tia
      join public.membership m on m.audience_id = tia.audience_id
     where tia.trip_instance_id = p_trip_instance_id
       and m.device_id = v_uid
       and m.revoked_at is null;
    if v_can_see_map is not null then
      v_level := greatest(v_level, case when v_can_see_map and not coalesce(v_eta_only, false) then 2 else 1 end);
    end if;
  end if;

  return v_level;
end;
$$;

comment on function private.trip_instance_access(uuid) is
  'Access level of the current user to a trip instance: 0 none, 1 arrival times only, 2 map, 3 staff.';

-- Stops: also the planned stops of current live trips one can see.
create or replace function private.stop_access(p_stop_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_staff(s.operator_id) then 3
    else greatest(
      coalesce((
        select max(private.route_access(p.route_id))
        from public.pattern_stop ps
        join public.trip_pattern p on p.id = ps.pattern_id
        where ps.stop_id = s.id
      ), 0),
      -- Only live trips riders can still see that are planned, running or
      -- ended within a day, so old tours do not slow down every stop read.
      coalesce((
        select max(private.trip_instance_access(tis.trip_instance_id))
        from public.trip_instance_stop tis
        join public.trip_instance ti on ti.id = tis.trip_instance_id
        where tis.operator_id = s.operator_id and tis.stop_id = s.id
          and (ti.visible_until is null or ti.visible_until > now())
          and (ti.status in ('planned', 'active') or ti.ended_at > now() - interval '1 day')
      ), 0)
    )
  end::smallint
  from public.stop s
  where s.id = p_stop_id
$$;

-- -----------------------------------------------------------------------------
-- Policies
-- -----------------------------------------------------------------------------

alter table public.driver_vehicle enable row level security;
alter table public.trip_instance_stop enable row level security;
alter table public.trip_instance_audience enable row level security;

create policy "editors manage driver vehicles" on public.driver_vehicle
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "drivers read own vehicles" on public.driver_vehicle
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy "trip instances of visible routes" on public.trip_instance;
drop policy "staff start trips" on public.trip_instance;
drop policy "staff update trips" on public.trip_instance;

create policy "visible trip instances" on public.trip_instance
  for select to anon, authenticated
  using (private.trip_instance_access(id) >= 1);

-- Drivers start trips for their vehicles (or without a vehicle).
create policy "staff start trips" on public.trip_instance
  for insert to authenticated
  with check (private.staff_trip_access(operator_id, vehicle_id, trip_id));

create policy "staff update trips" on public.trip_instance
  for update to authenticated
  using (private.staff_trip_access(operator_id, vehicle_id, trip_id))
  with check (private.staff_trip_access(operator_id, vehicle_id, trip_id));

-- Position: editors, drivers of the vehicle, and map-level viewers of the
-- trip while it is active and on route.
drop policy "vehicle state" on public.vehicle_state;
create policy "vehicle state" on public.vehicle_state
  for select to anon, authenticated
  using (
    private.can_edit(operator_id)
    or private.drives_vehicle(operator_id, vehicle_id)
    or exists (
      select 1
      from public.trip_instance ti
      where ti.id = vehicle_state.trip_instance_id
        and ti.status = 'active'
        and ti.off_route_since is null
        and private.trip_instance_access(ti.id) >= 2
    )
  );

create policy "planned stops of visible trips" on public.trip_instance_stop
  for select to anon, authenticated
  using (private.trip_instance_access(trip_instance_id) >= 1);

create policy "staff plan stops of their trips" on public.trip_instance_stop
  for all to authenticated
  using (private.trip_instance_access(trip_instance_id) = 3)
  with check (private.trip_instance_access(trip_instance_id) = 3);

-- Staff only: riders need not know which audiences a trip has.
create policy "staff choose audiences of their trips" on public.trip_instance_audience
  for all to authenticated
  using (private.trip_instance_access(trip_instance_id) = 3)
  with check (private.trip_instance_access(trip_instance_id) = 3);

-- -----------------------------------------------------------------------------
-- Subscriptions to a stop of a live trip
-- -----------------------------------------------------------------------------

-- A subscription targets either a pattern stop (every trip of the pattern)
-- or a planned stop of one live trip instance.
alter table public.subscription alter column pattern_id drop not null;
alter table public.subscription add column trip_instance_id uuid;
alter table public.subscription
  add constraint subscription_target_check check ((pattern_id is null) <> (trip_instance_id is null));
alter table public.subscription
  add constraint subscription_trip_instance_stop_fkey
  foreign key (operator_id, trip_instance_id, stop_sequence)
  references public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence)
  on delete cascade on update cascade;
alter table public.subscription
  add constraint subscription_device_trip_instance_stop_key unique (device_id, trip_instance_id, stop_sequence);
create index subscription_trip_instance_stop_idx on public.subscription (operator_id, trip_instance_id, stop_sequence)
  where trip_instance_id is not null;

comment on column public.subscription.pattern_id is
  'Pattern stop (pattern_id, stop_sequence): every trip of the pattern. Null for a subscription to a live trip.';
comment on column public.subscription.trip_instance_id is
  'Live trip: planned stop (trip_instance_id, stop_sequence) of this one trip instance. Null for a pattern subscription.';

drop policy "own subscriptions" on public.subscription;
create policy "own subscriptions" on public.subscription
  for all to authenticated
  using (device_id = (select auth.uid()))
  with check (
    device_id = (select auth.uid())
    and (
      (pattern_id is not null and private.pattern_access(pattern_id) >= 1)
      or (trip_instance_id is not null and private.trip_instance_access(trip_instance_id) >= 1)
    )
  );

-- Arrival-time access of a device (not the current user) to a trip instance.
create function private.device_can_see_trip_instance(p_device_id uuid, p_trip_instance_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.trip_instance ti
     where ti.id = p_trip_instance_id
       and (
         (ti.route_id is not null and private.device_can_see_route(p_device_id, ti.route_id))
         or exists (
           select 1
             from public.trip_instance_audience tia
             join public.membership m on m.audience_id = tia.audience_id
            where tia.trip_instance_id = ti.id
              and m.device_id = p_device_id
              and m.revoked_at is null
         )
       )
  )
$$;

-- Subscriptions follow access (20261123111632_invite_codes.sql), now for
-- live trips too.
create or replace function private.drop_inaccessible_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.subscription s
   using public.trip_pattern p
   where p.id = s.pattern_id
     and not private.device_can_see_route(s.device_id, p.route_id);
  delete from public.subscription s
   where s.trip_instance_id is not null
     and not private.device_can_see_trip_instance(s.device_id, s.trip_instance_id);
  return null;
end;
$$;

create trigger drop_inaccessible_subscriptions
  after update or delete on public.trip_instance_audience
  for each statement execute function private.drop_inaccessible_subscriptions();

-- route_id also changes through trip_instance_before_write when pattern_id
-- or trip_id is set; column triggers only see the SET list. The engine sets
-- none of these, so this does not run on every position.
create trigger drop_inaccessible_subscriptions
  after update of route_id, pattern_id, trip_id on public.trip_instance
  for each statement execute function private.drop_inaccessible_subscriptions();

-- Realtime "route:<id>": route_access is 3 for every staff member, so
-- drivers would receive every bus of the operator. Editors and owners still
-- do; drivers only for routes on which a trip they may see is active.
create or replace function private.route_topic_access(p_topic text)
returns smallint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_route_id uuid;
  v_operator_id uuid;
  v_level smallint;
begin
  if p_topic !~ '^route:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 0;
  end if;
  v_route_id := substr(p_topic, 7)::uuid;
  v_level := private.route_access(v_route_id);
  if v_level = 3 then
    select r.operator_id into v_operator_id from public.route r where r.id = v_route_id;
    if not private.can_edit(v_operator_id)
       and not exists (
         select 1 from public.trip_instance ti
          where ti.route_id = v_route_id
            and ti.status = 'active'
            and private.staff_trip_access(ti.operator_id, ti.vehicle_id, ti.trip_id)
       ) then
      return 0;
    end if;
  end if;
  return v_level;
end;
$$;

revoke execute on all functions in schema private from public;
grant execute on function
  private.drives_vehicle(uuid, uuid),
  private.staff_trip_access(uuid, uuid, uuid),
  private.trip_instance_access(uuid)
to anon, authenticated;
