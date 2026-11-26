-- Engine live API: slugs for public route and stop pages, and change
-- notifications for the engine's access cache.
--
-- Design: internal/concept/engine.md ("Live API"), public-web.md
-- (buspilot.org/r/<operator>/<route>, buspilot.org/s/<operator>/<stop>).

-- -----------------------------------------------------------------------------
-- Slugs
-- -----------------------------------------------------------------------------

-- Short, stable names for public URLs and QR codes, unique per operator
-- (operator.slug is global). Optional: a route or stop without a slug has no
-- public page. Same format as operator.slug. Printed QR codes point at them,
-- so staff should not change a slug once it is published.
alter table public.route
  add column slug text check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 63),
  add constraint route_operator_slug_key unique (operator_id, slug);

alter table public.stop
  add column slug text check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 63),
  add constraint stop_operator_slug_key unique (operator_id, slug);

comment on column public.route.slug is
  'URL name of the route, unique per operator: buspilot.org/r/<operator.slug>/<route.slug> (public routes only).';
comment on column public.stop.slug is
  'URL name of the stop, unique per operator: buspilot.org/s/<operator.slug>/<stop.slug> (stops of public routes only).';

-- stop is readable column by column (location is hidden, 20261123111629);
-- the slug is not sensitive.
grant select (slug) on public.stop to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Change notifications for the engine
-- -----------------------------------------------------------------------------

-- The engine keeps routes, stops, memberships, audiences and live trips in
-- memory to answer the live API without database reads, and listens on
-- channel `buspilot_live` to reload them soon after a change (a revoked
-- membership must not keep showing the bus). Payload: the table name, so
-- the engine reloads only what that table affects. Postgres sends one
-- notification per channel and payload per transaction, however many rows
-- change. The engine also reloads everything every minute, in case a
-- notification is lost (e.g. while it reconnects).
--
-- `subscription` does not notify: it changes often (riders following stops)
-- and only decides the mini-map location of followed stops, which the
-- minute reload picks up. LISTEN needs a direct or session-mode connection
-- (not Supavisor's transaction mode).
create function private.notify_live_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_notify('buspilot_live', tg_table_name);
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'operator', 'route', 'stop', 'trip_pattern', 'pattern_stop', 'trip',
    'audience_route', 'membership', 'staff_role', 'driver_vehicle',
    'trip_instance_stop', 'trip_instance_audience'
  ] loop
    execute format(
      'create trigger notify_live_change after insert or update or delete or truncate on public.%I '
      'for each statement execute function private.notify_live_change()',
      t
    );
  end loop;
end;
$$;

-- trip_instance is updated by the engine on every position (progress_m,
-- progress_at, off_route_since, last confirmed stop). Those are not listed:
-- the live API takes them from the engine's memory. Listed are the columns
-- the access rules and the trip list read: status (also starts and ends,
-- with started_at and ended_at), vehicle, trip, pattern, route, service
-- date, visibility, title and kind.
create trigger notify_live_change_insert_delete
  after insert or delete or truncate on public.trip_instance
  for each statement execute function private.notify_live_change();

create trigger notify_live_change_update
  after update on public.trip_instance
  for each row
  when (
    old.status is distinct from new.status
    or old.visible_until is distinct from new.visible_until
    or old.vehicle_id is distinct from new.vehicle_id
    or old.trip_id is distinct from new.trip_id
    or old.started_at is distinct from new.started_at
    or old.service_date is distinct from new.service_date
    or old.ended_at is distinct from new.ended_at
    or old.route_id is distinct from new.route_id
    or old.pattern_id is distinct from new.pattern_id
    or old.title is distinct from new.title
    or old.kind is distinct from new.kind
  )
  execute function private.notify_live_change();

revoke execute on all functions in schema private from public;
