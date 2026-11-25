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

-- True if the current user follows the stop (has a subscription to it, on a
-- pattern or a live trip) and still sees that route or trip. Arrival-time-
-- only audiences then get this one stop's location for a mini map, nothing
-- else (decided 2026-11-23).
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
$$;

-- Map-level stops, the stops one follows, and everything for the service
-- role. A view's function calls are checked against the caller, so the
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
  'Stop locations the current user may see: map-level routes and trips, stops the user follows (mini map), staff; all for the service role.';

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
-- the routes it follows (has a subscription on). Runs with the caller's
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
   order by r.operator_id, r.sort_order, r.id
$$;

comment on function public.my_routes() is
  'Visible routes of the operators the device is a member of, plus routes it follows. Embeddable (returns route rows).';

revoke execute on function public.my_routes() from public, anon;
grant execute on function public.my_routes() to authenticated;

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
