-- Rider app needs (buspilot-org/rider-app#1, "Follow-ups", server part):
-- delete my data, the own stop on a mini map for arrival-time-only
-- audiences, posts for members only, a narrower route list, and stop
-- locations for the service role.
--
-- Design: internal/concept/data-model.md ("Decisions after the first
-- schema"), rider-app.md, privacy-and-access.md.

-- -----------------------------------------------------------------------------
-- Delete my data
-- -----------------------------------------------------------------------------

-- Deletes the caller's anonymous auth user. The device row, memberships,
-- subscriptions, alert log and push token go with it (cascade), as do its
-- sessions; the app signs out afterwards. Refuses staff accounts (email
-- users): those are deleted by the operator or the Buspilot team.
create function public.delete_my_device()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
    raise exception 'only anonymous rider devices can delete themselves' using errcode = 'insufficient_privilege';
  end if;

  delete from public.device where id = v_uid;
  delete from auth.users where id = v_uid;
end;
$$;

comment on function public.delete_my_device() is
  'Deletes the calling anonymous rider device: auth user, device, memberships, subscriptions, alert log.';

revoke execute on function public.delete_my_device() from public, anon;
grant execute on function public.delete_my_device() to authenticated;

-- -----------------------------------------------------------------------------
-- Stop locations: own followed stop, service role
-- -----------------------------------------------------------------------------

-- Which stops a device followed whose location it could not see otherwise,
-- per operator. Without a limit a member could follow every stop of an
-- arrival-times-only route in turn and so map all stops (often next to
-- children's homes). The mini map shows only the first two such stops
-- (morning and afternoon stop, or two children); following others works for
-- alerts but shows no location. A stop keeps its place while the device
-- follows it; after unfollowing, the place is freed 30 days later (purge
-- job). So a device reveals at most two new stops per operator and 30 days;
-- more needs more devices, i.e. more invite code redemptions. Stops the
-- device sees on the map anyway (public or map-level routes) are not
-- logged. Not exposed; deleted with the device.
create table private.followed_stop_log (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.device (id) on delete cascade,
  operator_id uuid not null,
  stop_id uuid not null,
  created_at timestamptz not null default now(),
  -- When the device stopped following the stop; the row (and so the place)
  -- is purged 30 days later. Following it again clears this.
  released_at timestamptz,
  unique (device_id, operator_id, stop_id)
);

create index followed_stop_log_released_at_idx on private.followed_stop_log (released_at) where released_at is not null;

alter table private.followed_stop_log enable row level security;
revoke all on private.followed_stop_log from public, anon, authenticated;

-- The stops a device follows now (pattern and live-trip subscriptions).
create function private.device_followed_stops(p_device_id uuid)
returns table (operator_id uuid, stop_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select s.operator_id, ps.stop_id
    from public.subscription s
    join public.pattern_stop ps
      on ps.operator_id = s.operator_id and ps.pattern_id = s.pattern_id and ps.stop_sequence = s.stop_sequence
   where s.device_id = p_device_id
  union
  select s.operator_id, tis.stop_id
    from public.subscription s
    join public.trip_instance_stop tis
      on tis.operator_id = s.operator_id and tis.trip_instance_id = s.trip_instance_id and tis.stop_sequence = s.stop_sequence
   where s.device_id = p_device_id
$$;

-- Runs as the rider (auth.uid() from the request), so stop_access is the
-- rider's level.
create function private.log_followed_stop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stop_id uuid;
begin
  if new.pattern_id is not null then
    select ps.stop_id into v_stop_id
      from public.pattern_stop ps
     where ps.pattern_id = new.pattern_id and ps.stop_sequence = new.stop_sequence;
  else
    select tis.stop_id into v_stop_id
      from public.trip_instance_stop tis
     where tis.trip_instance_id = new.trip_instance_id and tis.stop_sequence = new.stop_sequence;
  end if;
  if v_stop_id is not null and private.stop_access(v_stop_id) < 2 then
    -- One row per stop: following a stop again keeps its original place.
    insert into private.followed_stop_log (device_id, operator_id, stop_id)
    values (new.device_id, new.operator_id, v_stop_id)
    on conflict (device_id, operator_id, stop_id) do update set released_at = null;
  end if;
  return null;
end;
$$;

create trigger log_followed_stop
  after insert or update of pattern_id, trip_instance_id, stop_sequence on public.subscription
  for each row execute function private.log_followed_stop();

-- Marks the stops the device no longer follows at the operator as released
-- (also when subscriptions go by cascade).
create function private.release_followed_stops()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.followed_stop_log l
     set released_at = now()
   where l.device_id = old.device_id
     and l.operator_id = old.operator_id
     and l.released_at is null
     and l.stop_id not in (
       select f.stop_id from private.device_followed_stops(old.device_id) f
        where f.operator_id = old.operator_id
     );
  return null;
end;
$$;

create trigger release_followed_stops
  after delete or update of pattern_id, trip_instance_id, stop_sequence on public.subscription
  for each row execute function private.release_followed_stops();

-- Existing subscriptions count as followed, in the order they were made,
-- except stops of routes the device sees on the map anyway (public, or
-- invited_map with a map-level membership).
insert into private.followed_stop_log (device_id, operator_id, stop_id, created_at)
select distinct on (s.device_id, s.operator_id, ps.stop_id) s.device_id, s.operator_id, ps.stop_id, s.created_at
  from public.subscription s
  join public.pattern_stop ps on ps.pattern_id = s.pattern_id and ps.stop_sequence = s.stop_sequence
  join public.trip_pattern p on p.id = s.pattern_id
  join public.route r on r.id = p.route_id
  join public.operator o on o.id = r.operator_id
 where coalesce(r.visibility, o.default_visibility) <> 'public'
   and not (
     coalesce(r.visibility, o.default_visibility) = 'invited_map'
     and exists (
       select 1 from public.audience_route ar
         join public.membership m on m.audience_id = ar.audience_id
        where ar.route_id = r.id and ar.can_see_map
          and m.device_id = s.device_id and m.revoked_at is null
     )
   )
 order by s.device_id, s.operator_id, ps.stop_id, s.created_at, s.id;

-- True if the current user follows the stop (has a subscription to it, on a
-- pattern or a live trip) and still sees that route or trip, and the stop is
-- one of the first two logged stops of the device at this operator
-- (private.followed_stop_log, see above). Arrival-time-only audiences
-- then get the location for a mini map, nothing else (decided 2026-11-23).
create function private.follows_stop(p_stop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      exists (
        select 1
          from public.subscription s
          join public.pattern_stop ps
            on ps.operator_id = s.operator_id
           and ps.pattern_id = s.pattern_id
           and ps.stop_sequence = s.stop_sequence
         where s.device_id = (select auth.uid())
           and ps.stop_id = p_stop_id
           and private.pattern_access(s.pattern_id) >= 1
      )
      or exists (
        select 1
          from public.subscription s
          join public.trip_instance_stop tis
            on tis.operator_id = s.operator_id
           and tis.trip_instance_id = s.trip_instance_id
           and tis.stop_sequence = s.stop_sequence
         where s.device_id = (select auth.uid())
           and tis.stop_id = p_stop_id
           and private.trip_instance_access(s.trip_instance_id) >= 1
      )
    )
    and p_stop_id in (
      select l.stop_id
        from private.followed_stop_log l
       where l.device_id = (select auth.uid())
         and l.operator_id = (select st.operator_id from public.stop st where st.id = p_stop_id)
       group by l.stop_id
       order by min(l.id)
       limit 2
    )
$$;

-- Map-level stops, the stops one follows (see above), and everything for
-- the service role. (postgres sessions, like the engine, read stop.location
-- directly.) A view's function calls are checked against the caller, so the
-- service role needs EXECUTE on the helpers (it had none: "permission denied
-- for function stop_access").
create or replace view public.stop_location
with (security_barrier = true)
as
select s.id, s.operator_id, s.location
from public.stop s
where current_user = 'service_role'
   or private.stop_access(s.id) >= 2
   or private.follows_stop(s.id);

comment on view public.stop_location is
  'Stop locations the current user may see: map-level routes and trips, up to two followed stops per operator (mini map), staff; all for the service role.';

-- -----------------------------------------------------------------------------
-- Posts
-- -----------------------------------------------------------------------------

-- A member of any of the operator's audiences.
create function private.is_operator_member(p_operator_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.membership m
     where m.operator_id = p_operator_id
       and m.device_id = (select auth.uid())
       and m.revoked_at is null
  )
$$;

-- Published posts for riders (decided 2026-11-23):
-- - audience post: members of that audience (and of the route, if set);
-- - route post without audience: whoever sees the route, so visitors of a
--   public route see that route's posts;
-- - general post (no audience, no route): members of the operator only.
-- Staff read everything of their operator (policy "staff read posts").
drop policy "published posts" on public.post;
create policy "published posts" on public.post
  for select to anon, authenticated
  using (
    published_at is not null
    and published_at <= now()
    and (expires_at is null or expires_at > now())
    and case
      when audience_id is not null then
        private.is_member(audience_id) and (route_id is null or private.route_access(route_id) >= 1)
      when route_id is not null then
        private.route_access(route_id) >= 1
      else
        private.is_operator_member(operator_id)
    end
  );

-- -----------------------------------------------------------------------------
-- The device's own routes
-- -----------------------------------------------------------------------------

-- RLS returns every public route of every operator, which the app would
-- download and filter. This returns only the routes the device is
-- interested in: all visible routes of operators it is a member of, plus
-- the routes it follows (has a subscription on, also via a live trip on the
-- route). Runs with the caller's
-- rights, so RLS still applies. Returns route rows, so PostgREST can embed
-- related tables:
--   POST /rest/v1/rpc/my_routes?select=*,trip_pattern(*,pattern_stop(*))
-- A public route not yet followed (opened from a link or QR code) is read by
-- id from `route` as before.
create function public.my_routes()
returns setof public.route
language sql
stable
security invoker
set search_path = ''
as $$
  select r.*
    from public.route r
   where exists (
           select 1
             from public.membership m
            where m.operator_id = r.operator_id
              and m.device_id = (select auth.uid())
              and m.revoked_at is null
         )
      or exists (
           select 1
             from public.subscription s
             join public.trip_pattern p on p.id = s.pattern_id
            where s.device_id = (select auth.uid())
              and p.route_id = r.id
         )
      or exists (
           select 1
             from public.subscription s
             join public.trip_instance ti on ti.id = s.trip_instance_id
            where s.device_id = (select auth.uid())
              and ti.route_id = r.id
         )
   order by r.operator_id, r.sort_order, r.id
$$;

comment on function public.my_routes() is
  'Visible routes of the operators the device is a member of, plus routes it follows. Embeddable (returns route rows).';

revoke execute on function public.my_routes() from public, anon;
grant execute on function public.my_routes() to authenticated;


-- Retention: the followed-stop log is kept while followed, then 30 days (20261123111634_retention.sql
-- plus this line).
create or replace function private.purge_expired_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
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

revoke execute on all functions in schema private from public;
grant execute on function
  private.follows_stop(uuid),
  private.is_operator_member(uuid)
to anon, authenticated;

-- The service role reads stop_location (engine, scripts): the view calls
-- these helpers with the caller's rights.
grant execute on function
  private.stop_access(uuid),
  private.follows_stop(uuid)
to service_role;
