/**
 * Database reads of the live API (src/live/): the snapshot of names, slugs,
 * schedule, trip instances around today and the access tables, in parts so a
 * change notification reloads only what its table affects, and the change
 * notifications on channel `buspilot_live` (migration
 * 20261127100000_live_api.sql).
 *
 * LISTEN needs a direct or session-mode connection: through Supavisor's
 * transaction mode (port 6543) notifications never arrive.
 */
import type postgres from 'postgres';
import type { I18nText } from '../alerts/types.ts';
import type { StopState, TripStatus } from '../core/types.ts';
import type { LiveInstanceRow, LivePart, LiveSnapshotPart, StaffRole, Visibility } from '../live/types.ts';
import { LIVE_PARTS } from '../live/types.ts';

export const LIVE_CHANNEL = 'buspilot_live';

type Tx = postgres.TransactionSql;

async function loadSchedule(tx: Tx): Promise<Partial<LiveSnapshotPart>> {
  const [operators, routes, stops, patterns, patternStops, trips] = await Promise.all([
    tx<{ id: string; slug: string; name: I18nText; timezone: string; default_visibility: Visibility }[]>`
      select id, slug, name, timezone, default_visibility from public.operator`,
    tx<{
      id: string; operator_id: string; slug: string | null; name: I18nText; short_name: string | null;
      color: string | null; text_color: string | null; visibility: Visibility | null; active: boolean;
    }[]>`
      select id, operator_id, slug, name, short_name, color, text_color, visibility, active from public.route`,
    tx<{ id: string; operator_id: string; slug: string | null; name: I18nText; lon: number; lat: number }[]>`
      select id, operator_id, slug, name,
             extensions.st_x(location::extensions.geometry) as lon,
             extensions.st_y(location::extensions.geometry) as lat
        from public.stop`,
    tx<{ id: string; operator_id: string; route_id: string }[]>`
      select id, operator_id, route_id from public.trip_pattern`,
    tx<{ pattern_id: string; stop_sequence: number; stop_id: string; arrival_offset: number; departure_offset: number }[]>`
      select pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset from public.pattern_stop`,
    tx<{ id: string; pattern_id: string; start_time: number; headsign: I18nText | null; vehicle_id: string | null }[]>`
      select id, pattern_id, start_time, headsign, vehicle_id from public.trip`,
  ]);
  return {
    operators: operators.map((o) => ({ id: o.id, slug: o.slug, name: o.name, timezone: o.timezone, defaultVisibility: o.default_visibility })),
    routes: routes.map((r) => ({
      id: r.id, operatorId: r.operator_id, slug: r.slug, name: r.name, shortName: r.short_name,
      color: r.color, textColor: r.text_color, visibility: r.visibility, active: r.active,
    })),
    stops: stops.map((s) => ({ id: s.id, operatorId: s.operator_id, slug: s.slug, name: s.name, lon: s.lon, lat: s.lat })),
    patterns: patterns.map((p) => ({ id: p.id, operatorId: p.operator_id, routeId: p.route_id })),
    patternStops: patternStops.map((p) => ({
      patternId: p.pattern_id, sequence: p.stop_sequence, stopId: p.stop_id, arrivalOffsetS: p.arrival_offset, departureOffsetS: p.departure_offset,
    })),
    trips: trips.map((t) => ({ id: t.id, patternId: t.pattern_id, startTimeS: t.start_time, headsign: t.headsign, vehicleId: t.vehicle_id })),
  };
}

async function loadAccess(tx: Tx): Promise<Partial<LiveSnapshotPart>> {
  const [staff, drivers, memberships, audienceRoutes, tripAudiences] = await Promise.all([
    tx<{ operator_id: string; user_id: string; role: StaffRole }[]>`
      select operator_id, user_id, role from public.staff_role`,
    tx<{ operator_id: string; user_id: string; vehicle_id: string }[]>`
      select operator_id, user_id, vehicle_id from public.driver_vehicle`,
    tx<{ device_id: string; audience_id: string }[]>`
      select device_id, audience_id from public.membership where revoked_at is null`,
    tx<{ audience_id: string; route_id: string; can_see_map: boolean }[]>`
      select audience_id, route_id, can_see_map from public.audience_route`,
    tx<{ trip_instance_id: string; audience_id: string; can_see_map: boolean }[]>`
      select trip_instance_id, audience_id, can_see_map from public.trip_instance_audience`,
  ]);
  return {
    staffRoles: staff.map((s) => ({ operatorId: s.operator_id, userId: s.user_id, role: s.role })),
    driverVehicles: drivers.map((d) => ({ operatorId: d.operator_id, userId: d.user_id, vehicleId: d.vehicle_id })),
    memberships: memberships.map((m) => ({ deviceId: m.device_id, audienceId: m.audience_id })),
    audienceRoutes: audienceRoutes.map((a) => ({ audienceId: a.audience_id, routeId: a.route_id, canSeeMap: a.can_see_map })),
    tripAudiences: tripAudiences.map((a) => ({ tripInstanceId: a.trip_instance_id, audienceId: a.audience_id, canSeeMap: a.can_see_map })),
  };
}

async function loadTrips(tx: Tx): Promise<Partial<LiveSnapshotPart>> {
  // Trip instances around today, plus every one the access rules can look
  // at: active ones, planned ones from yesterday on and those ended within a
  // day (stop_access), and those with a subscription (follows_stop).
  const instances = await tx<{
    id: string; operator_id: string; kind: 'scheduled' | 'live'; trip_id: string | null; pattern_id: string | null;
    route_id: string | null; service_date: string; status: TripStatus; vehicle_id: string | null;
    visible_until: Date | null; title: I18nText | null; started_at: Date | null; ended_at: Date | null;
    off_route_since: Date | null;
  }[]>`
    select ti.id, ti.operator_id, ti.kind, ti.trip_id, ti.pattern_id, ti.route_id, ti.service_date::text as service_date,
           ti.status, ti.vehicle_id, ti.visible_until, ti.title, ti.started_at, ti.ended_at, ti.off_route_since
      from public.trip_instance ti
     where ti.service_date between current_date - 2 and current_date + 2
        or ti.status = 'active'
        or (ti.status = 'planned' and ti.service_date >= current_date - 1)
        or ti.ended_at > now() - interval '1 day'
        or exists (select 1 from public.subscription s where s.trip_instance_id = ti.id)`;
  const ids = instances.map((i) => i.id);
  const [events, planned] = await Promise.all([
    tx<{
      trip_instance_id: string; stop_sequence: number; state: StopState; eta: Date | null;
      arrived_at: Date | null; departed_at: Date | null; passed_at: Date | null;
    }[]>`
      select trip_instance_id, stop_sequence, state, eta, arrived_at, departed_at, passed_at
        from public.stop_event where trip_instance_id = any(${ids}::uuid[])`,
    tx<{ trip_instance_id: string; stop_sequence: number; stop_id: string; planned_arrival: Date | null; planned_departure: Date | null }[]>`
      select trip_instance_id, stop_sequence, stop_id, planned_arrival, planned_departure
        from public.trip_instance_stop where trip_instance_id = any(${ids}::uuid[])`,
  ]);
  const eventsBy = new Map<string, LiveInstanceRow['stopEvents']>();
  for (const e of events) {
    const list = eventsBy.get(e.trip_instance_id) ?? [];
    list.push({ sequence: e.stop_sequence, state: e.state, eta: e.eta, arrivedAt: e.arrived_at, departedAt: e.departed_at, passedAt: e.passed_at });
    eventsBy.set(e.trip_instance_id, list);
  }
  const plannedBy = new Map<string, LiveInstanceRow['plannedStops']>();
  for (const p of planned) {
    const list = plannedBy.get(p.trip_instance_id) ?? [];
    list.push({ sequence: p.stop_sequence, stopId: p.stop_id, plannedArrival: p.planned_arrival, plannedDeparture: p.planned_departure });
    plannedBy.set(p.trip_instance_id, list);
  }
  return {
    instances: instances.map((i) => ({
      id: i.id, operatorId: i.operator_id, kind: i.kind, tripId: i.trip_id, patternId: i.pattern_id, routeId: i.route_id,
      serviceDate: i.service_date, status: i.status, vehicleId: i.vehicle_id, visibleUntil: i.visible_until, title: i.title,
      startedAt: i.started_at, endedAt: i.ended_at, offRouteSince: i.off_route_since,
      stopEvents: eventsBy.get(i.id) ?? [],
      plannedStops: (plannedBy.get(i.id) ?? []).sort((a, b) => a.sequence - b.sequence),
    })),
  };
}

async function loadFollows(tx: Tx): Promise<Partial<LiveSnapshotPart>> {
  // Only devices with logged followed stops can see a stop location through
  // a subscription (private.follows_stop).
  const [subscriptions, followed] = await Promise.all([
    tx<{ device_id: string; stop_id: string; pattern_id: string | null; trip_instance_id: string | null }[]>`
      select s.device_id, ps.stop_id, s.pattern_id, null::uuid as trip_instance_id
        from public.subscription s
        join public.pattern_stop ps
          on ps.operator_id = s.operator_id and ps.pattern_id = s.pattern_id and ps.stop_sequence = s.stop_sequence
       where exists (select 1 from private.followed_stop_log l where l.device_id = s.device_id)
      union all
      select s.device_id, tis.stop_id, null::uuid, s.trip_instance_id
        from public.subscription s
        join public.trip_instance_stop tis
          on tis.operator_id = s.operator_id and tis.trip_instance_id = s.trip_instance_id and tis.stop_sequence = s.stop_sequence
       where exists (select 1 from private.followed_stop_log l where l.device_id = s.device_id)`,
    tx<{ device_id: string; operator_id: string; stop_id: string }[]>`
      select device_id, operator_id, stop_id
        from (select l.device_id, l.operator_id, l.stop_id,
                     row_number() over (partition by l.device_id, l.operator_id order by l.id) as rank
                from private.followed_stop_log l) x
       where rank <= 2`,
  ]);
  return {
    subscriptions: subscriptions.map((s) => ({ deviceId: s.device_id, stopId: s.stop_id, patternId: s.pattern_id, tripInstanceId: s.trip_instance_id })),
    followedStops: followed.map((f) => ({ deviceId: f.device_id, operatorId: f.operator_id, stopId: f.stop_id })),
  };
}

const LOADERS: Record<LivePart, (tx: Tx) => Promise<Partial<LiveSnapshotPart>>> = {
  schedule: loadSchedule,
  access: loadAccess,
  trips: loadTrips,
  follows: loadFollows,
};

/** Loads the given parts (default: all) in one repeatable-read transaction, so they are from the same moment. */
export async function loadLiveSnapshot(sql: postgres.Sql, parts: readonly LivePart[] = LIVE_PARTS): Promise<LiveSnapshotPart> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    // A hung load must not block every later reload.
    await tx`set local statement_timeout = '30s'`;
    const [clock] = await tx<{ now: Date }[]>`select now() as now`;
    const loaded = await Promise.all([...new Set(parts)].map((p) => LOADERS[p](tx)));
    return Object.assign({ loadedAt: clock?.now ?? new Date() }, ...loaded) as LiveSnapshotPart;
  });
}

/**
 * LISTEN on buspilot_live. `onChange` gets the table name (the payload);
 * `onConnect` runs on every (re)connect, as notifications may have been
 * missed meanwhile.
 */
export async function listenLiveChanges(sql: postgres.Sql, onChange: (table: string) => void, onConnect: () => void): Promise<() => Promise<void>> {
  const req = await sql.listen(LIVE_CHANNEL, (payload) => { onChange(payload); }, () => { onConnect(); });
  return () => req.unlisten();
}
