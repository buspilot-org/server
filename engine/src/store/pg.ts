/**
 * Postgres store (postgres.js, direct connection with a role that bypasses
 * RLS, as the service role does).
 *
 * All writes are idempotent, so a retried position or a replay after a
 * restart cannot move anything backwards:
 * - progress_m only grows (`greatest`), trip status only moves
 *   planned → active → completed;
 * - only the vehicle that runs a trip writes to it: a cancelled or completed
 *   trip, or one another vehicle runs, gets no progress, stop events or
 *   ETAs, and vehicle_state does not link to it;
 * - stop events only move forward (`state < new state`), final states stay;
 * - vehicle_state only takes newer fixes.
 */
import postgres from 'postgres';
import type { AlertStore, DeliveryClaim, I18nText, Subscription } from '../alerts/types.ts';
import type { StopState, TripStatus, Writes } from '../core/types.ts';
import type { LivePart, LiveSnapshotPart, LiveStore } from '../live/types.ts';
import { listenLiveChanges, loadLiveSnapshot } from './live.ts';
import type { InstanceRow, PersistResult, PlannedStopRow, SnapshotRows, Store } from './store.ts';

type Sql = postgres.Sql;

export class PgStore implements Store, AlertStore, LiveStore {
  readonly sql: Sql;

  constructor(databaseUrl: string, options: { max?: number } = {}) {
    this.sql = postgres(databaseUrl, {
      max: options.max ?? 5,
      onnotice: () => undefined,
      // UTC like Supabase's default: the live API's access rules use
      // current_date in UTC (private.stop_access), as the snapshot query does.
      connection: { application_name: 'buspilot-engine', TimeZone: 'UTC' },
    });
  }

  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  loadLiveSnapshot(parts?: readonly LivePart[]): Promise<LiveSnapshotPart> {
    return loadLiveSnapshot(this.sql, parts);
  }

  listenLiveChanges(onChange: (table: string) => void, onConnect: () => void): Promise<() => Promise<void>> {
    return listenLiveChanges(this.sql, onChange, onConnect);
  }

  async loadSnapshot(now: Date): Promise<SnapshotRows> {
    const sql = this.sql;
    const [operators, vehicles, shapes, patterns, patternStops, instances, live] = await Promise.all([
      sql<{ id: string; timezone: string }[]>`select id, timezone from public.operator`,
      sql<{ id: string; operator_id: string; traccar_device_id: string; recorded_at: Date | null }[]>`
        select v.id, v.operator_id, v.traccar_device_id, vs.recorded_at
          from public.vehicle v
          left join public.vehicle_state vs on vs.vehicle_id = v.id
         where v.active and v.traccar_device_id is not null`,
      sql<{ id: string; operator_id: string; coordinates: [number, number][]; length_m: number }[]>`
        select id, operator_id,
               (extensions.st_asgeojson(geom::extensions.geometry)::json -> 'coordinates') as coordinates,
               extensions.st_length(geom) as length_m
          from public.shape`,
      sql<{ id: string; operator_id: string; route_id: string; shape_id: string | null }[]>`
        select id, operator_id, route_id, shape_id from public.trip_pattern`,
      sql<{
        pattern_id: string; stop_sequence: number; lon: number; lat: number;
        dist_along_shape: number | null; arrival_offset: number; departure_offset: number;
      }[]>`
        select ps.pattern_id, ps.stop_sequence,
               extensions.st_x(s.location::extensions.geometry) as lon,
               extensions.st_y(s.location::extensions.geometry) as lat,
               ps.dist_along_shape, ps.arrival_offset, ps.departure_offset
          from public.pattern_stop ps
          join public.stop s on s.id = ps.stop_id`,
      sql<{
        id: string; operator_id: string; service_date: string; trip_id: string; pattern_id: string; route_id: string;
        start_time: number; vehicle_id: string | null; default_vehicle_id: string | null; status: TripStatus; started_by: 'schedule' | 'driver';
        progress_m: number; progress_at: Date | null; last_confirmed_stop_sequence: number | null;
        off_route_since: Date | null; started_at: Date | null; ended_at: Date | null; created_at: Date;
      }[]>`
        select ti.id, ti.operator_id, ti.service_date::text as service_date, ti.trip_id, t.pattern_id, ti.route_id,
               t.start_time, ti.vehicle_id, t.vehicle_id as default_vehicle_id, ti.status, ti.started_by,
               ti.progress_m, ti.progress_at, ti.last_confirmed_stop_sequence, ti.off_route_since,
               ti.started_at, ti.ended_at, ti.created_at
          from public.trip_instance ti
          join public.trip t on t.id = ti.trip_id
          join public.route r on r.id = ti.route_id
         where ti.kind = 'scheduled'
           and r.active
           and ti.service_date between (${now}::timestamptz - interval '2 days')::date
                                   and (${now}::timestamptz + interval '2 days')::date`,
      // Live trips: on a pattern of an active route, or without a pattern (any route, or none).
      sql<{
        id: string; operator_id: string; service_date: string; pattern_id: string | null; route_id: string | null;
        vehicle_id: string | null; status: TripStatus; started_by: 'schedule' | 'driver';
        progress_m: number; progress_at: Date | null; last_confirmed_stop_sequence: number | null;
        off_route_since: Date | null; started_at: Date | null; ended_at: Date | null; created_at: Date;
        title: I18nText | null; visible_until: Date | null;
      }[]>`
        select ti.id, ti.operator_id, ti.service_date::text as service_date, ti.pattern_id, ti.route_id,
               ti.vehicle_id, ti.status, ti.started_by,
               ti.progress_m, ti.progress_at, ti.last_confirmed_stop_sequence, ti.off_route_since,
               ti.started_at, ti.ended_at, ti.created_at, ti.title, ti.visible_until
          from public.trip_instance ti
          left join public.route r on r.id = ti.route_id
         where ti.kind = 'live'
           and (ti.pattern_id is null or r.active)
           and ti.service_date between (${now}::timestamptz - interval '2 days')::date
                                   and (${now}::timestamptz + interval '2 days')::date`,
    ]);

    const ids = [...instances.map((i) => i.id), ...live.map((i) => i.id)];
    const [events, planned] = ids.length === 0 ? [[], []] : await Promise.all([
      sql<{
        trip_instance_id: string; stop_sequence: number; state: StopState; eta: Date | null;
        arrived_at: Date | null; departed_at: Date | null; passed_at: Date | null;
      }[]>`
        select trip_instance_id, stop_sequence, state, eta, arrived_at, departed_at, passed_at
          from public.stop_event
         where trip_instance_id = any(${ids}::uuid[])`,
      sql<{
        trip_instance_id: string; stop_sequence: number; lon: number; lat: number;
        planned_arrival: Date | null; planned_departure: Date | null;
      }[]>`
        select tis.trip_instance_id, tis.stop_sequence,
               extensions.st_x(s.location::extensions.geometry) as lon,
               extensions.st_y(s.location::extensions.geometry) as lat,
               tis.planned_arrival, tis.planned_departure
          from public.trip_instance_stop tis
          join public.stop s on s.id = tis.stop_id
         where tis.trip_instance_id = any(${ids}::uuid[])`,
    ]);
    const eventsByInstance = new Map<string, InstanceRow['stopEvents']>();
    for (const e of events) {
      const list = eventsByInstance.get(e.trip_instance_id) ?? [];
      list.push({ sequence: e.stop_sequence, state: e.state, eta: e.eta, arrivedAt: e.arrived_at, departedAt: e.departed_at, passedAt: e.passed_at });
      eventsByInstance.set(e.trip_instance_id, list);
    }
    const plannedByInstance = new Map<string, PlannedStopRow[]>();
    for (const p of planned) {
      const list = plannedByInstance.get(p.trip_instance_id) ?? [];
      list.push({ sequence: p.stop_sequence, lon: p.lon, lat: p.lat, plannedArrival: p.planned_arrival, plannedDeparture: p.planned_departure });
      plannedByInstance.set(p.trip_instance_id, list);
    }

    return {
      operators: operators.map((o) => ({ id: o.id, timezone: o.timezone })),
      vehicles: vehicles.map((v) => ({ id: v.id, operatorId: v.operator_id, deviceId: v.traccar_device_id, lastFixAt: v.recorded_at })),
      shapes: shapes.map((s) => ({ id: s.id, operatorId: s.operator_id, coordinates: s.coordinates, lengthM: s.length_m })),
      patterns: patterns.map((p) => ({ id: p.id, operatorId: p.operator_id, routeId: p.route_id, shapeId: p.shape_id })),
      patternStops: patternStops.map((s) => ({
        patternId: s.pattern_id, sequence: s.stop_sequence, lon: s.lon, lat: s.lat,
        distAlongShape: s.dist_along_shape, arrivalOffsetS: s.arrival_offset, departureOffsetS: s.departure_offset,
      })),
      instances: [
        ...instances.map((i): InstanceRow => ({
          id: i.id, operatorId: i.operator_id, serviceDate: i.service_date, kind: 'scheduled', tripId: i.trip_id, patternId: i.pattern_id,
          routeId: i.route_id, startTimeS: i.start_time, vehicleId: i.vehicle_id, defaultVehicleId: i.default_vehicle_id, status: i.status,
          startedBy: i.started_by, progressM: i.progress_m, progressAt: i.progress_at, lastConfirmedStopSequence: i.last_confirmed_stop_sequence,
          offRouteSince: i.off_route_since, startedAt: i.started_at, endedAt: i.ended_at,
          stopEvents: eventsByInstance.get(i.id) ?? [],
          title: null, visibleUntil: null, createdAt: i.created_at, plannedStops: [],
        })),
        ...live.map((i): InstanceRow => ({
          id: i.id, operatorId: i.operator_id, serviceDate: i.service_date, kind: 'live', tripId: null, patternId: i.pattern_id,
          routeId: i.route_id, startTimeS: null, vehicleId: i.vehicle_id, defaultVehicleId: null, status: i.status,
          startedBy: i.started_by, progressM: i.progress_m, progressAt: i.progress_at, lastConfirmedStopSequence: i.last_confirmed_stop_sequence,
          offRouteSince: i.off_route_since, startedAt: i.started_at, endedAt: i.ended_at,
          stopEvents: eventsByInstance.get(i.id) ?? [],
          title: i.title, visibleUntil: i.visible_until, createdAt: i.created_at,
          plannedStops: (plannedByInstance.get(i.id) ?? []).sort((a, b) => a.sequence - b.sequence),
        })),
      ],
    };
  }

  async persist(w: Writes): Promise<PersistResult> {
    return this.sql.begin(async (sql) => {
      const v = w.vehicleId;
      // Claim the trip for this vehicle first. The row lock makes a second
      // vehicle starting the same "any vehicle" trip wait for this
      // transaction, and then see that the trip is taken.
      if (w.trip && w.trip.status !== 'planned') {
        await sql`
          update public.trip_instance set vehicle_id = ${v}
           where id = ${w.trip.id} and vehicle_id is null and status = 'planned'`;
      }
      // Only a trip this vehicle runs, not cancelled or completed (the trip
      // row itself is updated last, so this transaction may complete it).
      const runs = (tripInstanceId: string) => sql`
        exists (select 1 from public.trip_instance ti
                 where ti.id = ${tripInstanceId} and ti.vehicle_id = ${v} and ti.status in ('planned', 'active'))`;

      const queries: postgres.PendingQuery<postgres.Row[]>[] = [];
      const vs = w.vehicleState;
      if (vs) {
        const tripId = vs.tripInstanceId;
        queries.push(sql`
          insert into public.vehicle_state
            (vehicle_id, operator_id, trip_instance_id, location, speed_kmh, heading, accuracy_m, recorded_at)
          values (
            ${vs.vehicleId}, ${vs.operatorId},
            ${tripId === null ? null : sql`(select ${tripId}::uuid where ${runs(tripId)})`},
            extensions.st_setsrid(extensions.st_makepoint(${vs.lon}, ${vs.lat}), 4326)::extensions.geography,
            ${vs.speedKmh}, ${vs.heading}, ${vs.accuracyM}, ${vs.recordedAt}
          )
          on conflict (vehicle_id) do update set
            trip_instance_id = excluded.trip_instance_id,
            location = excluded.location,
            speed_kmh = excluded.speed_kmh,
            heading = excluded.heading,
            accuracy_m = excluded.accuracy_m,
            recorded_at = excluded.recorded_at
          where public.vehicle_state.recorded_at < excluded.recorded_at`);
      }
      for (const e of w.stopEvents) {
        queries.push(sql`
          insert into public.stop_event
            (operator_id, trip_instance_id, stop_sequence, state, arrived_at, departed_at, passed_at)
          select ti.operator_id, ti.id, ${e.sequence}, ${e.state}::public.stop_event_state,
                 ${e.arrivedAt}::timestamptz, ${e.departedAt}::timestamptz, ${e.passedAt}::timestamptz
            from public.trip_instance ti where ti.id = ${e.tripInstanceId} and ${runs(e.tripInstanceId)}
             -- A trip without a pattern has stop events only for its planned
             -- stops: none for a planned stop staff removed meanwhile.
             and (ti.pattern_id is not null
                  or exists (select 1 from public.trip_instance_stop tis
                              where tis.trip_instance_id = ti.id and tis.stop_sequence = ${e.sequence}))
          on conflict (trip_instance_id, stop_sequence) do update set
            state = excluded.state,
            arrived_at = coalesce(public.stop_event.arrived_at, excluded.arrived_at),
            departed_at = coalesce(public.stop_event.departed_at, excluded.departed_at),
            passed_at = coalesce(public.stop_event.passed_at, excluded.passed_at)
          where public.stop_event.state < excluded.state
            and public.stop_event.state not in ('departed', 'passed')
            and (excluded.state <> 'passed' or public.stop_event.arrived_at is null)
            and (excluded.state <> 'departed' or coalesce(public.stop_event.arrived_at, excluded.arrived_at) is not null)`);
      }
      const byTrip = new Map<string, { seqs: number[]; etas: string[] }>();
      for (const e of w.etas) {
        const entry = byTrip.get(e.tripInstanceId) ?? { seqs: [], etas: [] };
        entry.seqs.push(e.sequence);
        entry.etas.push(e.eta.toISOString());
        byTrip.set(e.tripInstanceId, entry);
      }
      for (const [tripInstanceId, { seqs, etas }] of byTrip) {
        queries.push(sql`
          update public.stop_event se set eta = v.eta
            from unnest(${seqs}::integer[], ${etas}::timestamptz[]) as v(stop_sequence, eta)
           where se.trip_instance_id = ${tripInstanceId}
             and se.stop_sequence = v.stop_sequence
             and se.state in ('upcoming', 'approaching')
             and ${runs(tripInstanceId)}`);
      }
      const tr = w.trip;
      let tripIndex = -1;
      if (tr) {
        tripIndex = queries.length;
        queries.push(sql`
          update public.trip_instance set
            status = case
              when status = 'planned' then ${tr.status}::public.trip_instance_status
              when status = 'active' and ${tr.status} = 'completed' then 'completed'::public.trip_instance_status
              else status
            end,
            started_by = case when status = 'planned' then ${tr.startedBy}::public.trip_started_by else started_by end,
            progress_m = greatest(progress_m, ${tr.progressM}),
            progress_at = greatest(progress_at, ${tr.progressAt}::timestamptz),
            last_confirmed_stop_sequence = greatest(last_confirmed_stop_sequence, ${tr.lastConfirmedStopSequence}::integer),
            off_route_since = case when status = 'completed' then off_route_since else ${tr.offRouteSince}::timestamptz end,
            started_at = coalesce(started_at, ${tr.startedAt}::timestamptz),
            ended_at = coalesce(ended_at, ${tr.endedAt}::timestamptz)
          where id = ${tr.id} and status <> 'cancelled' and vehicle_id = ${v}
          returning id`);
      }
      // Queries run in the order they were added (postgres.js sends a query
      // when it is first awaited, and Promise.all awaits in array order).
      const results = await Promise.all(queries);
      const tripRows = tripIndex >= 0 ? results[tripIndex] : undefined;
      return { tripApplied: tripIndex < 0 || (Array.isArray(tripRows) && tripRows.length > 0) };
    });
  }

  /**
   * Subscriptions the engine may alert: the device has a push target, and
   * - a stop of a pattern: the route is active, and the device may see it
   *   (public, or a membership whose audience includes the route), as
   *   `private.route_access` decides for riders;
   * - a planned stop of a live trip: the device may see the trip (its active
   *   route as above, or a membership in one of the trip's audiences), as
   *   `private.device_can_see_trip_instance` decides. visible_until is
   *   checked when an alert is due.
   * Muting is checked when an alert is due.
   */
  async loadSubscriptions(): Promise<Subscription[]> {
    type Row = {
      id: string; operator_id: string; device_id: string; pattern_id: string | null; trip_instance_id: string | null; stop_sequence: number;
      trigger: 'minutes' | 'stops'; trigger_value: number; notify_passed: boolean; muted_until: Date | null; created_at: Date;
      push_token: string; language: string | null; timezone: string; route_id: string | null; route_name: I18nText | null;
      route_short_name: string | null; stop_id: string; stop_name: I18nText;
    };
    const sql = this.sql;
    const [ofPatterns, ofTrips] = await Promise.all([
      sql<Row[]>`
        select s.id, s.operator_id, s.device_id, s.pattern_id, null::uuid as trip_instance_id, s.stop_sequence, s.trigger::text as trigger,
               s.trigger_value, s.notify_passed, s.muted_until, s.created_at,
               d.push_token, d.language, o.timezone, r.id as route_id, r.name as route_name,
               r.short_name as route_short_name, st.id as stop_id, st.name as stop_name
          from public.subscription s
          join public.device d on d.id = s.device_id
          join public.trip_pattern p on p.id = s.pattern_id
          join public.route r on r.id = p.route_id
          join public.operator o on o.id = r.operator_id
          join public.pattern_stop ps on ps.pattern_id = s.pattern_id and ps.stop_sequence = s.stop_sequence
          join public.stop st on st.id = ps.stop_id
         where d.push_token is not null and d.push_token <> ''
           and r.active
           and (coalesce(r.visibility, o.default_visibility) = 'public'
                or exists (select 1
                             from public.audience_route ar
                             join public.membership m on m.audience_id = ar.audience_id
                            where ar.route_id = r.id
                              and m.device_id = s.device_id
                              and m.revoked_at is null))`,
      sql<Row[]>`
        select s.id, s.operator_id, s.device_id, null::uuid as pattern_id, s.trip_instance_id, s.stop_sequence, s.trigger::text as trigger,
               s.trigger_value, s.notify_passed, s.muted_until, s.created_at,
               d.push_token, d.language, o.timezone, r.id as route_id, r.name as route_name,
               r.short_name as route_short_name, st.id as stop_id, st.name as stop_name
          from public.subscription s
          join public.device d on d.id = s.device_id
          join public.trip_instance ti on ti.id = s.trip_instance_id
          join public.operator o on o.id = ti.operator_id
          join public.trip_instance_stop tis on tis.trip_instance_id = s.trip_instance_id and tis.stop_sequence = s.stop_sequence
          join public.stop st on st.id = tis.stop_id
          left join public.route r on r.id = ti.route_id
         where d.push_token is not null and d.push_token <> ''
           and ti.kind = 'live'
           and ((r.active
                 and (coalesce(r.visibility, o.default_visibility) = 'public'
                      or exists (select 1
                                   from public.audience_route ar
                                   join public.membership m on m.audience_id = ar.audience_id
                                  where ar.route_id = r.id
                                    and m.device_id = s.device_id
                                    and m.revoked_at is null)))
                or exists (select 1
                             from public.trip_instance_audience tia
                             join public.membership m on m.audience_id = tia.audience_id
                            where tia.trip_instance_id = ti.id
                              and m.device_id = s.device_id
                              and m.revoked_at is null))`,
    ]);
    return [...ofPatterns, ...ofTrips].map((r) => ({
      id: r.id, operatorId: r.operator_id, deviceId: r.device_id, patternId: r.pattern_id, tripInstanceId: r.trip_instance_id,
      stopSequence: r.stop_sequence, trigger: r.trigger, triggerValue: r.trigger_value, notifyPassed: r.notify_passed,
      mutedUntil: r.muted_until, createdAt: r.created_at, pushToken: r.push_token, language: r.language, timezone: r.timezone,
      routeId: r.route_id, routeName: r.route_name, routeShortName: r.route_short_name, stopId: r.stop_id, stopName: r.stop_name,
    }));
  }

  async claimDelivery(c: DeliveryClaim): Promise<string | null> {
    try {
      const rows = await this.sql<{ id: string }[]>`
        insert into public.alert_delivery (operator_id, subscription_id, trip_instance_id, stop_sequence, kind, result)
        values (${c.operatorId}, ${c.subscriptionId}, ${c.tripInstanceId}, ${c.stopSequence}, ${c.kind}::public.alert_kind, 'pending')
        on conflict (subscription_id, trip_instance_id, stop_sequence, kind) do nothing
        returning id`;
      return rows[0]?.id ?? null;
    } catch (err) {
      // The subscription or trip instance was deleted meanwhile: nothing to send.
      if (err instanceof postgres.PostgresError && err.code === '23503') return null;
      throw err;
    }
  }

  async finishDelivery(id: string, sentAt: Date | null, result: string): Promise<void> {
    await this.sql`update public.alert_delivery set sent_at = ${sentAt}, result = ${result} where id = ${id}`;
  }

  async clearPushToken(deviceId: string, token: string): Promise<void> {
    await this.sql`update public.device set push_token = null where id = ${deviceId} and push_token = ${token}`;
  }

  async createTripInstances(now: Date): Promise<number> {
    const [row] = await this.sql<{ created: number }[]>`
      select private.create_upcoming_trip_instances(${now}::timestamptz) as created`;
    return row?.created ?? 0;
  }
}
