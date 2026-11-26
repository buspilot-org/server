-- Live trips: save a trip with its planned stops and audiences in one call
-- and one transaction, and purge subscriptions of finished live trips.
--
-- The admin console saved a live trip in several requests (trip, audiences,
-- planned stops), so a failure on the way left half a save, and it made the
-- trip's UUID itself because INSERT … RETURNING on trip_instance fails the
-- select policy (private.trip_instance_access(id) does not see the row being
-- inserted). public.save_live_trip does all of it at once and returns the
-- saved state.
--
-- Design: internal/concept/arrival-alerts.md ("Decisions (2026-11-26)").

-- -----------------------------------------------------------------------------
-- save_live_trip
-- -----------------------------------------------------------------------------

-- Creates (p_trip_id null) or updates a live trip, then makes its planned
-- stops and audiences match the lists given. All or nothing.
--
-- Rights: runs with the caller's rights (security invoker), so the policies
-- on trip_instance, trip_instance_stop and trip_instance_audience decide, as
-- for direct writes: owners and editors of the operator, and drivers for
-- trips of their vehicles or without a vehicle (private.staff_trip_access);
-- a driver cannot move a trip to a vehicle they do not drive. Riders, staff
-- of other operators and anonymous callers are refused (42501).
--
-- Arguments (PostgREST: POST /rest/v1/rpc/save_live_trip with these names):
--   p_trip_id        null = new trip; else the live trip to update
--   p_operator_id    required for a new trip; if given on update it must be
--                    the trip's operator
--   p_title          i18n text, required
--   p_vehicle_id     null = any vehicle of the operator
--   p_route_id       optional route (riders of the route see the trip too)
--   p_visible_until  riders see the trip until then (null = no limit)
--   p_service_date   new trip: defaults to today in the operator's time
--                    zone; update: null keeps the saved date
--   p_stops          null = leave the planned stops as they are; else a JSON
--                    array of {stop_id, stop_sequence, planned_arrival,
--                    planned_departure}, the full new plan
--   p_audiences      null = leave the audiences as they are (drivers cannot
--                    read audiences); else a JSON array of {audience_id,
--                    can_see_map}, the full new list
-- The trip is saved with kind 'live' and started_by 'driver'; its status is
-- not changed here.
--
-- Planned stops are matched by stop_sequence (as subscriptions and stop
-- events are): same sequence and same stop → the planned times are updated;
-- same sequence with another stop → the old one is removed and the new one
-- inserted (its followers lose their alerts and its stop event starts again
-- as upcoming); sequences not in the list are removed, new ones inserted.
-- So the client should keep the sequence of a stop it keeps and give new
-- stops unused sequences (e.g. gaps, or max + 1). Removing or replacing a
-- stop the bus has reached or passed is refused (trip_instance_stop_events,
-- trip_instance_stop_check), and so is the whole save.
--
-- Order of the writes, so that riders lose a trip only if the saved result
-- takes it away from them (subscriptions follow access: the statement
-- triggers drop_inaccessible_subscriptions re-check every live-trip
-- subscription after each change of audiences or route):
--   1. audiences added or changed;
--   2. planned stops (removed, inserted, times updated);
--   3. the trip itself (title, vehicle, visible_until, service date, then
--      the route if it changes);
--   4. audiences removed — only now is access re-checked without them.
--
-- Returns {"id", "trip" (the trip_instance row), "stops" (ordered by
-- stop_sequence), "audiences"} as saved.
create function public.save_live_trip(
  p_trip_id uuid default null,
  p_operator_id uuid default null,
  p_title jsonb default null,
  p_vehicle_id uuid default null,
  p_route_id uuid default null,
  p_visible_until timestamptz default null,
  p_service_date date default null,
  p_stops jsonb default null,
  p_audiences jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_trip public.trip_instance;
  v_id uuid;
  v_operator_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if p_title is null then
    raise exception 'a live trip needs a title' using errcode = 'not_null_violation';
  end if;

  -- Input lists: arrays of objects with the required keys, no duplicates.
  if p_stops is not null then
    if jsonb_typeof(p_stops) <> 'array' then
      raise exception 'p_stops must be a JSON array' using errcode = 'invalid_parameter_value';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_stops) as x(stop_id uuid, stop_sequence integer)
       where x.stop_id is null or x.stop_sequence is null
    ) then
      raise exception 'every planned stop needs stop_id and stop_sequence' using errcode = 'invalid_parameter_value';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_stops) as x(stop_sequence integer)
       group by x.stop_sequence having count(*) > 1
    ) then
      raise exception 'stop_sequence must be unique within the trip' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_audiences is not null then
    if jsonb_typeof(p_audiences) <> 'array' then
      raise exception 'p_audiences must be a JSON array' using errcode = 'invalid_parameter_value';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_audiences) as a(audience_id uuid)
       where a.audience_id is null
    ) then
      raise exception 'every audience needs audience_id' using errcode = 'invalid_parameter_value';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_audiences) as a(audience_id uuid)
       group by a.audience_id having count(*) > 1
    ) then
      raise exception 'each audience may be given once' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if p_trip_id is null then
    if p_operator_id is null then
      raise exception 'p_operator_id is required for a new trip' using errcode = 'not_null_violation';
    end if;
    v_operator_id := p_operator_id;
    -- Made here and inserted without RETURNING: the select policy would not
    -- see the new row within the same statement.
    v_id := gen_random_uuid();
    -- RLS ("staff start trips") checks the caller against operator and
    -- vehicle.
    insert into public.trip_instance (
      id, operator_id, service_date, kind, started_by, title, vehicle_id, route_id, visible_until
    ) values (
      v_id,
      v_operator_id,
      coalesce(
        p_service_date,
        (select (now() at time zone o.timezone)::date from public.operator o where o.id = v_operator_id),
        current_date
      ),
      'live',
      'driver',
      p_title,
      p_vehicle_id,
      p_route_id,
      p_visible_until
    );
  else
    -- Locks the trip against a concurrent save. Only rows the caller may
    -- update are found (RLS "staff update trips"); the explicit check also
    -- refuses staff who only see the trip as riders would.
    select ti.* into v_trip
      from public.trip_instance ti
     where ti.id = p_trip_id
       for update;
    if not found or not private.staff_trip_access(v_trip.operator_id, v_trip.vehicle_id, v_trip.trip_id) then
      raise exception 'live trip not found or not allowed' using errcode = 'insufficient_privilege';
    end if;
    if v_trip.kind <> 'live' then
      raise exception 'only live trips are saved with save_live_trip' using errcode = 'check_violation';
    end if;
    if p_operator_id is not null and p_operator_id <> v_trip.operator_id then
      raise exception 'the trip belongs to another operator' using errcode = 'invalid_parameter_value';
    end if;
    if v_trip.pattern_id is not null and v_trip.route_id is distinct from p_route_id then
      raise exception 'this live trip follows a pattern; its route comes from the pattern'
        using errcode = 'check_violation';
    end if;
    v_id := p_trip_id;
    v_operator_id := v_trip.operator_id;
  end if;

  -- 1. Audiences added or changed (before anything can take access away).
  if p_audiences is not null then
    insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id, can_see_map)
    select v_operator_id, v_id, a.audience_id, coalesce(a.can_see_map, false)
      from jsonb_to_recordset(p_audiences) as a(audience_id uuid, can_see_map boolean)
    on conflict (trip_instance_id, audience_id) do update
      set can_see_map = excluded.can_see_map
      where public.trip_instance_audience.can_see_map is distinct from excluded.can_see_map;
  end if;

  -- 2. Planned stops.
  if p_stops is not null then
    -- The stop FK is deferred (checked at commit); check here for a clear,
    -- immediate error.
    if exists (
      select 1 from jsonb_to_recordset(p_stops) as x(stop_id uuid)
       where not exists (
         select 1 from public.stop s where s.id = x.stop_id and s.operator_id = v_operator_id
       )
    ) then
      raise exception 'planned stop is not a stop of this operator' using errcode = 'foreign_key_violation';
    end if;

    -- Removed, or given another stop: delete (their followers go by cascade,
    -- their stop events with them; refused once the bus reached the stop).
    delete from public.trip_instance_stop tis
     where tis.trip_instance_id = v_id
       and not exists (
         select 1 from jsonb_to_recordset(p_stops) as x(stop_id uuid, stop_sequence integer)
          where x.stop_sequence = tis.stop_sequence and x.stop_id = tis.stop_id
       );

    insert into public.trip_instance_stop (
      operator_id, trip_instance_id, stop_sequence, stop_id, planned_arrival, planned_departure
    )
    select v_operator_id, v_id, x.stop_sequence, x.stop_id, x.planned_arrival, x.planned_departure
      from jsonb_to_recordset(p_stops)
        as x(stop_id uuid, stop_sequence integer, planned_arrival timestamptz, planned_departure timestamptz)
     where not exists (
       select 1 from public.trip_instance_stop tis
        where tis.trip_instance_id = v_id and tis.stop_sequence = x.stop_sequence
     );

    update public.trip_instance_stop tis
       set planned_arrival = x.planned_arrival,
           planned_departure = x.planned_departure
      from jsonb_to_recordset(p_stops)
        as x(stop_id uuid, stop_sequence integer, planned_arrival timestamptz, planned_departure timestamptz)
     where tis.trip_instance_id = v_id
       and tis.stop_sequence = x.stop_sequence
       and (tis.planned_arrival is distinct from x.planned_arrival
            or tis.planned_departure is distinct from x.planned_departure);
  end if;

  -- 3. The trip. The route on its own statement and only when it changes:
  -- that update re-checks every live-trip follower (statement trigger).
  if p_trip_id is not null then
    update public.trip_instance ti
       set title = p_title,
           vehicle_id = p_vehicle_id,
           visible_until = p_visible_until,
           service_date = coalesce(p_service_date, ti.service_date)
     where ti.id = v_id
       and (ti.title, ti.vehicle_id, ti.visible_until, ti.service_date)
           is distinct from (p_title, p_vehicle_id, p_visible_until, coalesce(p_service_date, ti.service_date));
    if v_trip.route_id is distinct from p_route_id then
      update public.trip_instance ti set route_id = p_route_id where ti.id = v_id;
    end if;
  end if;

  -- 4. Audiences removed: riders who lose the trip with them lose their
  -- subscriptions to it (statement trigger), the others keep them.
  if p_audiences is not null then
    delete from public.trip_instance_audience tia
     where tia.trip_instance_id = v_id
       and tia.audience_id not in (
         select a.audience_id from jsonb_to_recordset(p_audiences) as a(audience_id uuid)
       );
  end if;

  return jsonb_build_object(
    'id', v_id,
    'trip', (select to_jsonb(ti) from public.trip_instance ti where ti.id = v_id),
    'stops', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'stop_sequence', tis.stop_sequence,
                 'stop_id', tis.stop_id,
                 'planned_arrival', tis.planned_arrival,
                 'planned_departure', tis.planned_departure
               ) order by tis.stop_sequence)
        from public.trip_instance_stop tis
       where tis.trip_instance_id = v_id
    ), '[]'::jsonb),
    'audiences', coalesce((
      select jsonb_agg(
               jsonb_build_object('audience_id', tia.audience_id, 'can_see_map', tia.can_see_map)
               order by tia.audience_id)
        from public.trip_instance_audience tia
       where tia.trip_instance_id = v_id
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.save_live_trip(uuid, uuid, jsonb, uuid, uuid, timestamptz, date, jsonb, jsonb) is
  'Creates or updates a live trip with its planned stops and audiences in one transaction (caller''s rights: editors, drivers of the vehicle). Returns the saved trip, stops and audiences.';

revoke execute on function public.save_live_trip(uuid, uuid, jsonb, uuid, uuid, timestamptz, date, jsonb, jsonb) from public, anon;
grant execute on function public.save_live_trip(uuid, uuid, jsonb, uuid, uuid, timestamptz, date, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Purge subscriptions of finished live trips
-- -----------------------------------------------------------------------------

-- A subscription to a stop of a live trip (trip_instance_id set) is useless
-- once the trip is over. Rule, checked daily by the retention job:
--   - completed or cancelled for more than an hour (ended_at, else the last
--     update): the engine has sent the last alerts (passed, cancelled);
--   - or past visible_until: riders no longer see the trip;
--   - or never ended and its service date more than 7 days back (a trip
--     staff forgot to end or cancel).
-- Deleting fires release_followed_stops, so the followed-stop log frees
-- those stops 30 days later as for any unfollow. Alert log rows of these
-- subscriptions go by cascade. Returns the number of subscriptions deleted.
create function private.purge_finished_live_trip_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.subscription s
   using public.trip_instance ti
   where ti.id = s.trip_instance_id
     and ti.kind = 'live'
     and (
       (ti.status in ('completed', 'cancelled') and coalesce(ti.ended_at, ti.updated_at) < now() - interval '1 hour')
       or ti.visible_until <= now()
       or (ti.status in ('planned', 'active') and ti.service_date < current_date - 7)
     );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function private.purge_finished_live_trip_subscriptions() from public, anon, authenticated;
grant execute on function private.purge_finished_live_trip_subscriptions() to service_role;

-- Retention job (20261123111634_retention.sql, 20261126100400_rider_app.sql)
-- plus the live-trip subscriptions above. Same daily cron job.
create or replace function private.purge_expired_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Before the followed-stop log purge: stops released now are freed in 30
  -- days, not today.
  perform private.purge_finished_live_trip_subscriptions();

  delete from public.alert_delivery where created_at < now() - interval '30 days';
  delete from public.vehicle_event where received_at < now() - interval '30 days';
  delete from public.boarding_event where occurred_at < now() - interval '30 days';
  delete from private.invite_redemption_failure where attempted_at < now() - interval '1 day';
  -- Followed-stop log: freed 30 days after the device stopped following.
  delete from private.followed_stop_log where released_at < now() - interval '30 days';

  -- Inactive rider devices: delete the anonymous auth user; device,
  -- memberships, subscriptions and alert log follow by cascade.
  delete from auth.users u
   using public.device d
   where d.id = u.id
     and u.is_anonymous
     and d.last_seen_at < now() - interval '90 days';
  delete from public.device d where d.last_seen_at < now() - interval '90 days';

  -- Anonymous users that never registered a device (public routes only):
  -- delete 90 days after their last session activity (token refresh) or
  -- sign-in. Their sessions go with them.
  delete from auth.users u
   where u.is_anonymous
     and not exists (select 1 from public.device d where d.id = u.id)
     and greatest(
           u.created_at,
           u.last_sign_in_at,
           (select max(greatest(s.updated_at, s.refreshed_at at time zone 'UTC'))
              from auth.sessions s where s.user_id = u.id)
         ) < now() - interval '90 days';
end;
$$;

revoke execute on function private.purge_expired_data() from public, anon, authenticated;
