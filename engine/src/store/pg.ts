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
import type { StopState, TripStatus, Writes } from '../core/types.ts';
import type { InstanceRow, SnapshotRows, Store } from './store.ts';

type Sql = postgres.Sql;

export class PgStore implements Store {
  readonly sql: Sql;

  constructor(databaseUrl: string, options: { max?: number } = {}) {
    this.sql = postgres(databaseUrl, {
      max: options.max ?? 5,
      onnotice: () => undefined,
      connection: { application_name: 'buspilot-engine' },
    });
  }

  async ping(): Promise<void> {
    await this.sql`select 1`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async loadSnapshot(now: Date): Promise<SnapshotRows> {
    const sql = this.sql;
    const [operators, vehicles, shapes, patterns, patternStops, instances] = await Promise.all([
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
        id: string; operator_id: string; service_date: string; trip_id: string; pattern_id: string;
        start_time: number; vehicle_id: string | null; default_vehicle_id: string | null; status: TripStatus; started_by: 'schedule' | 'driver';
        progress_m: number; progress_at: Date | null; last_confirmed_stop_sequence: number | null;
        off_route_since: Date | null; started_at: Date | null; ended_at: Date | null;
      }[]>`
        select ti.id, ti.operator_id, ti.service_date::text as service_date, ti.trip_id, t.pattern_id,
               t.start_time, ti.vehicle_id, t.vehicle_id as default_vehicle_id, ti.status, ti.started_by,
               ti.progress_m, ti.progress_at, ti.last_confirmed_stop_sequence, ti.off_route_since,
               ti.started_at, ti.ended_at
          from public.trip_instance ti
          join public.trip t on t.id = ti.trip_id
          join public.route r on r.id = ti.route_id
         where ti.kind = 'scheduled'
           and r.active
           and ti.service_date between (${now}::timestamptz - interval '2 days')::date
                                   and (${now}::timestamptz + interval '2 days')::date`,
    ]);

    const ids = instances.map((i) => i.id);
    const events = ids.length === 0 ? [] : await sql<{
      trip_instance_id: string; stop_sequence: number; state: StopState; eta: Date | null;
      arrived_at: Date | null; departed_at: Date | null; passed_at: Date | null;
    }[]>`
      select trip_instance_id, stop_sequence, state, eta, arrived_at, departed_at, passed_at
        from public.stop_event
       where trip_instance_id = any(${ids}::uuid[])`;
    const eventsByInstance = new Map<string, InstanceRow['stopEvents']>();
    for (const e of events) {
      const list = eventsByInstance.get(e.trip_instance_id) ?? [];
      list.push({ sequence: e.stop_sequence, state: e.state, eta: e.eta, arrivedAt: e.arrived_at, departedAt: e.departed_at, passedAt: e.passed_at });
      eventsByInstance.set(e.trip_instance_id, list);
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
      instances: instances.map((i) => ({
        id: i.id, operatorId: i.operator_id, serviceDate: i.service_date, tripId: i.trip_id, patternId: i.pattern_id,
        startTimeS: i.start_time, vehicleId: i.vehicle_id, defaultVehicleId: i.default_vehicle_id, status: i.status, startedBy: i.started_by,
        progressM: i.progress_m, progressAt: i.progress_at, lastConfirmedStopSequence: i.last_confirmed_stop_sequence,
        offRouteSince: i.off_route_since, startedAt: i.started_at, endedAt: i.ended_at,
        stopEvents: eventsByInstance.get(i.id) ?? [],
      })),
    };
  }

  async persist(w: Writes): Promise<void> {
    await this.sql.begin(async (sql) => {
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

      const queries: Promise<unknown>[] = [];
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
      if (tr) {
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
          where id = ${tr.id} and status <> 'cancelled' and vehicle_id = ${v}`);
      }
      await Promise.all(queries);
    });
  }

  async createTripInstances(now: Date): Promise<number> {
    const [row] = await this.sql<{ created: number }[]>`
      select private.create_upcoming_trip_instances(${now}::timestamptz) as created`;
    return row?.created ?? 0;
  }
}
