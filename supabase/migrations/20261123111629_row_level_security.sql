-- Row-level security.
--
-- Who is who
-- - Staff: Supabase Auth users with a row in staff_role for the operator.
--     owner  – everything of the operator, including staff roles and vehicle
--              credentials
--     editor – schedule, vehicles, audiences, invite codes, posts, boarding data
--     driver – reads schedule, vehicles and trips; starts trips (trip_instance)
--              and records routes
-- - Rider devices: anonymous Supabase Auth users (role `authenticated`,
--   is_anonymous = true). They see a route if it is public, or if they hold an
--   active membership in an audience that has the route (audience_route).
-- - Not signed in (role `anon`): public routes only.
-- - The engine uses the service role, which bypasses RLS. All writes of live
--   state (stop_event, vehicle_state, alert_delivery, vehicle_event,
--   boarding_event) come from the engine only.
--
-- Route access levels (private.route_access):
--   0 none, 1 arrival times only, 2 map, 3 staff.
--   public                → 2 for everyone
--   invited_map           → 2 for members of an audience with can_see_map,
--                           1 for other members
--   invited_eta (default) → 1 for members
--   inactive routes       → 0 for riders

-- -----------------------------------------------------------------------------
-- Helper functions (security definer: they read membership and staff tables
-- that the caller may not read itself, and avoid recursive policies)
-- -----------------------------------------------------------------------------

create function private.has_role(p_operator_id uuid, p_roles public.staff_role_kind[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_role sr
    where sr.operator_id = p_operator_id
      and sr.user_id = (select auth.uid())
      and sr.role = any (p_roles)
  )
$$;

create function private.is_staff(p_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role(p_operator_id, '{owner,editor,driver}')
$$;

create function private.can_edit(p_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role(p_operator_id, '{owner,editor}')
$$;

create function private.is_owner(p_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role(p_operator_id, '{owner}')
$$;

create function private.route_access(p_route_id uuid)
returns smallint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_operator_id uuid;
  v_active boolean;
  v_visibility public.route_visibility;
  v_can_see_map boolean;
begin
  select r.operator_id, r.active, coalesce(r.visibility, o.default_visibility)
    into v_operator_id, v_active, v_visibility
    from public.route r
    join public.operator o on o.id = r.operator_id
   where r.id = p_route_id;

  if not found then
    return 0;
  end if;
  if v_uid is not null and private.is_staff(v_operator_id) then
    return 3;
  end if;
  if not v_active then
    return 0;
  end if;
  if v_visibility = 'public' then
    return 2;
  end if;
  if v_uid is null then
    return 0;
  end if;

  select bool_or(ar.can_see_map)
    into v_can_see_map
    from public.audience_route ar
    join public.membership m on m.audience_id = ar.audience_id
   where ar.route_id = p_route_id
     and m.device_id = v_uid
     and m.revoked_at is null;

  if v_can_see_map is null then
    return 0;  -- no membership
  end if;
  if v_can_see_map and v_visibility = 'invited_map' then
    return 2;
  end if;
  return 1;
end;
$$;

comment on function private.route_access(uuid) is
  'Access level of the current user to a route: 0 none, 1 arrival times only, 2 map, 3 staff.';

create function private.pattern_access(p_pattern_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select private.route_access(p.route_id) from public.trip_pattern p where p.id = p_pattern_id),
    0
  )::smallint
$$;

-- Highest level over all routes that use the stop.
create function private.stop_access(p_stop_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_staff(s.operator_id) then 3
    else coalesce((
      select max(private.route_access(p.route_id))
      from public.pattern_stop ps
      join public.trip_pattern p on p.id = ps.pattern_id
      where ps.stop_id = s.id
    ), 0)
  end::smallint
  from public.stop s
  where s.id = p_stop_id
$$;

create function private.shape_access(p_shape_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_staff(sh.operator_id) then 3
    else coalesce((
      select max(private.route_access(p.route_id))
      from public.trip_pattern p
      where p.shape_id = sh.id
    ), 0)
  end::smallint
  from public.shape sh
  where sh.id = p_shape_id
$$;

create function private.calendar_access(p_calendar_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_staff(c.operator_id) then 3
    else coalesce((
      select max(private.pattern_access(t.pattern_id))
      from public.trip t
      where t.service_calendar_id = c.id
    ), 0)
  end::smallint
  from public.service_calendar c
  where c.id = p_calendar_id
$$;

-- An operator is visible to its staff, to members of any of its audiences and,
-- if it has an active public route, to everyone.
create function private.can_see_operator(p_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_staff(p_operator_id)
    or exists (
      select 1
      from public.route r
      join public.operator o on o.id = r.operator_id
      where r.operator_id = p_operator_id
        and r.active
        and coalesce(r.visibility, o.default_visibility) = 'public'
    )
    or exists (
      select 1
      from public.membership m
      where m.operator_id = p_operator_id
        and m.device_id = (select auth.uid())
        and m.revoked_at is null
    )
$$;

create function private.is_member(p_audience_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.membership m
    where m.audience_id = p_audience_id
      and m.device_id = (select auth.uid())
      and m.revoked_at is null
  )
$$;

-- Realtime broadcast topic "route:<uuid>" carries the live vehicle position of
-- that route: map level only.
create function private.route_topic_access(p_topic text)
returns smallint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic ~ '^route:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return private.route_access(substr(p_topic, 7)::uuid);
  end if;
  return 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

-- Supabase grants everything on public tables to anon and authenticated by
-- default. TRUNCATE is not subject to RLS, MAINTAIN (Postgres 17) allows
-- LOCK TABLE, and anon never writes.
revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;
revoke insert, update, delete on all tables in schema public from anon;

-- The same for tables added by later migrations.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke insert, update, delete on tables from anon;

-- Access helpers used in policies. Nothing else in `private` is executable by
-- the API roles.
revoke execute on all functions in schema private from public;
grant execute on function
  private.is_i18n_text(jsonb),
  private.has_role(uuid, public.staff_role_kind[]),
  private.is_staff(uuid),
  private.can_edit(uuid),
  private.is_owner(uuid),
  private.route_access(uuid),
  private.pattern_access(uuid),
  private.stop_access(uuid),
  private.shape_access(uuid),
  private.calendar_access(uuid),
  private.can_see_operator(uuid),
  private.is_member(uuid),
  private.route_topic_access(text)
to anon, authenticated;

-- Owners edit how their operator looks and behaves, not its slug or plan
-- (onboarding and billing use the service role).
revoke update on public.operator from authenticated;
grant update (name, timezone, languages, branding, default_visibility, boarding_check_enabled)
  on public.operator to authenticated;

-- traccar_device_id is unique across all operators and decides whose bus a
-- tracker's positions belong to, so only the service role (onboarding) sets
-- it. Otherwise an editor could claim another operator's tracker.
revoke insert, update on public.vehicle from authenticated;
grant insert (id, operator_id, name, capacity, active) on public.vehicle to authenticated;
grant update (name, capacity, active) on public.vehicle to authenticated;

-- Invite codes are created only by public.create_invite_code (random code,
-- hash). Editors may relabel, change limits or revoke, not set hashes or
-- reset the use counter.
revoke insert, update on public.invite_code from authenticated;
grant update (label, expires_at, max_uses, revoked_at) on public.invite_code to authenticated;

-- The exact stop location is hidden from riders who may see arrival times
-- only. Column privileges: everyone reads stop rows without `location`;
-- `public.stop_location` returns locations by access level.
revoke select on public.stop from anon, authenticated;
grant select (id, operator_id, gtfs_id, name, notes, created_at, updated_at) on public.stop to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS on every table in public
-- -----------------------------------------------------------------------------

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Operator and staff
-- -----------------------------------------------------------------------------

create policy "visible operators" on public.operator
  for select to anon, authenticated
  using (private.can_see_operator(id));

-- Operators are created by the service role (onboarding).
create policy "owners update their operator" on public.operator
  for update to authenticated
  using (private.is_owner(id))
  with check (private.is_owner(id));

create policy "own roles and roles of operators one edits" on public.staff_role
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_edit(operator_id));

create policy "owners manage staff" on public.staff_role
  for all to authenticated
  using (private.is_owner(operator_id))
  with check (private.is_owner(operator_id));

-- -----------------------------------------------------------------------------
-- Schedule
-- -----------------------------------------------------------------------------

create policy "routes by access level" on public.route
  for select to anon, authenticated
  using (private.route_access(id) >= 1);

create policy "stops on visible routes" on public.stop
  for select to anon, authenticated
  using (private.stop_access(id) >= 1);

-- The route line reveals where the bus goes: map level only.
create policy "shapes of map routes" on public.shape
  for select to anon, authenticated
  using (private.shape_access(id) >= 2);

create policy "patterns of visible routes" on public.trip_pattern
  for select to anon, authenticated
  using (private.route_access(route_id) >= 1);

create policy "pattern stops of visible routes" on public.pattern_stop
  for select to anon, authenticated
  using (private.pattern_access(pattern_id) >= 1);

create policy "trips of visible routes" on public.trip
  for select to anon, authenticated
  using (private.pattern_access(pattern_id) >= 1);

create policy "calendars of visible trips" on public.service_calendar
  for select to anon, authenticated
  using (private.calendar_access(id) >= 1);

create policy "exceptions of visible calendars" on public.calendar_exception
  for select to anon, authenticated
  using (private.calendar_access(calendar_id) >= 1);

do $$
declare
  t text;
begin
  foreach t in array array[
    'route', 'stop', 'shape', 'trip_pattern', 'pattern_stop', 'trip', 'service_calendar', 'calendar_exception'
  ] loop
    execute format(
      'create policy "editors write" on public.%I for all to authenticated '
      'using (private.can_edit(operator_id)) with check (private.can_edit(operator_id))',
      t
    );
  end loop;
end;
$$;

-- Stop locations by access level: map level for riders, all for staff.
-- Runs with the view owner's rights (security_invoker off) because riders have
-- no column privilege on stop.location; the WHERE clause is the access check.
create view public.stop_location
with (security_barrier = true)
as
select s.id, s.operator_id, s.location
from public.stop s
where private.stop_access(s.id) >= 2;

comment on view public.stop_location is
  'Stop locations the current user may see on a map (map-level routes, or staff).';

revoke all on public.stop_location from anon, authenticated;
grant select on public.stop_location to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Vehicles and route recordings
-- -----------------------------------------------------------------------------

create policy "staff read vehicles" on public.vehicle
  for select to authenticated
  using (private.is_staff(operator_id));

create policy "editors write vehicles" on public.vehicle
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "owners manage vehicle credentials" on public.vehicle_credential
  for all to authenticated
  using (private.is_owner(operator_id))
  with check (private.is_owner(operator_id));

-- Drivers record routes; editors turn them into patterns and delete them.
create policy "staff read route recordings" on public.route_recording
  for select to authenticated
  using (private.is_staff(operator_id));

create policy "staff record routes" on public.route_recording
  for insert to authenticated
  with check (private.is_staff(operator_id));

create policy "staff update route recordings" on public.route_recording
  for update to authenticated
  using (private.is_staff(operator_id))
  with check (private.is_staff(operator_id));

create policy "editors delete route recordings" on public.route_recording
  for delete to authenticated
  using (private.can_edit(operator_id));

-- -----------------------------------------------------------------------------
-- Live operation
-- -----------------------------------------------------------------------------

create policy "trip instances of visible routes" on public.trip_instance
  for select to anon, authenticated
  using (
    private.is_staff(operator_id)
    or (
      route_id is not null
      and private.route_access(route_id) >= 1
      and (visible_until is null or visible_until > now())
    )
  );

-- Drivers start trips ("Start morning route", "Start live trip").
create policy "staff start trips" on public.trip_instance
  for insert to authenticated
  with check (private.is_staff(operator_id));

create policy "staff update trips" on public.trip_instance
  for update to authenticated
  using (private.is_staff(operator_id))
  with check (private.is_staff(operator_id));

create policy "editors delete trips" on public.trip_instance
  for delete to authenticated
  using (private.can_edit(operator_id));

-- ETAs and stop states: whoever sees the trip instance (arrival-time level is
-- enough).
create policy "stop events of visible trips" on public.stop_event
  for select to anon, authenticated
  using (exists (select 1 from public.trip_instance ti where ti.id = stop_event.trip_instance_id));

-- The position is shown only at map level, only while the trip is active and
-- the vehicle is on route (privacy-and-access.md).
create policy "vehicle state" on public.vehicle_state
  for select to anon, authenticated
  using (
    private.is_staff(operator_id)
    or exists (
      select 1
      from public.trip_instance ti
      where ti.id = vehicle_state.trip_instance_id
        and ti.status = 'active'
        and ti.off_route_since is null
        and ti.route_id is not null
        and private.route_access(ti.route_id) >= 2
    )
  );

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------

create policy "members and editors read audiences" on public.audience
  for select to authenticated
  using (private.can_edit(operator_id) or private.is_member(id));

create policy "editors write audiences" on public.audience
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "members and editors read audience routes" on public.audience_route
  for select to authenticated
  using (private.can_edit(operator_id) or private.is_member(audience_id));

create policy "editors write audience routes" on public.audience_route
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

-- Riders redeem codes through public.redeem_invite_code only.
create policy "editors manage invite codes" on public.invite_code
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

-- A device sees and changes only itself. Staff do not see devices (push
-- tokens).
create policy "own device" on public.device
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Memberships are created by public.redeem_invite_code. Riders may read their
-- own and leave (delete) active ones; a revoked row stays, so the device
-- cannot rejoin by code. Editors may read, revoke and delete.
create policy "own memberships" on public.membership
  for select to authenticated
  using (device_id = (select auth.uid()));

create policy "leave own memberships" on public.membership
  for delete to authenticated
  using (device_id = (select auth.uid()) and revoked_at is null);

create policy "editors read memberships" on public.membership
  for select to authenticated
  using (private.can_edit(operator_id));

create policy "editors revoke memberships" on public.membership
  for update to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "editors delete memberships" on public.membership
  for delete to authenticated
  using (private.can_edit(operator_id));

-- -----------------------------------------------------------------------------
-- Alerts
-- -----------------------------------------------------------------------------

-- A device subscribes to stops of routes it can see (arrival-time level).
create policy "own subscriptions" on public.subscription
  for all to authenticated
  using (device_id = (select auth.uid()))
  with check (device_id = (select auth.uid()) and private.pattern_access(pattern_id) >= 1);

-- Staff do not read subscriptions: device + stop would hint at where a
-- family lives. Aggregate counts can come later through a view.

create policy "own alert deliveries" on public.alert_delivery
  for select to authenticated
  using (exists (
    select 1 from public.subscription s
    where s.id = alert_delivery.subscription_id
      and s.device_id = (select auth.uid())
  ));

create policy "editors read alert deliveries" on public.alert_delivery
  for select to authenticated
  using (private.can_edit(operator_id));

-- -----------------------------------------------------------------------------
-- Content
-- -----------------------------------------------------------------------------

create policy "published posts" on public.post
  for select to anon, authenticated
  using (
    published_at is not null
    and published_at <= now()
    and (expires_at is null or expires_at > now())
    and private.can_see_operator(operator_id)
    and (audience_id is null or private.is_member(audience_id))
    and (route_id is null or private.route_access(route_id) >= 1)
  );

create policy "staff read posts" on public.post
  for select to authenticated
  using (private.is_staff(operator_id));

create policy "editors write posts" on public.post
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "links of visible operators" on public.operator_link
  for select to anon, authenticated
  using (private.can_see_operator(operator_id));

create policy "editors write links" on public.operator_link
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

-- -----------------------------------------------------------------------------
-- Vehicle events and boarding check (personal data: owners and editors only)
-- -----------------------------------------------------------------------------

create policy "editors read vehicle events" on public.vehicle_event
  for select to authenticated
  using (private.can_edit(operator_id));

create policy "editors manage tags" on public.tag
  for all to authenticated
  using (private.can_edit(operator_id))
  with check (private.can_edit(operator_id));

create policy "editors read boarding events" on public.boarding_event
  for select to authenticated
  using (private.can_edit(operator_id));

-- -----------------------------------------------------------------------------
-- Realtime: private broadcast channel per route ("route:<route_id>")
-- -----------------------------------------------------------------------------

-- Only the engine (service role) sends; map-level viewers receive. The engine
-- broadcasts only while a trip is active and the vehicle is on route.
create policy "map viewers receive route broadcasts" on realtime.messages
  for select to anon, authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.route_topic_access((select realtime.topic())) >= 2
  );
