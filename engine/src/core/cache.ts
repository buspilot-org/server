/**
 * Builds the in-memory cache (engine.md, "Inputs": schedule and devices are
 * read from Supabase into memory) from database rows: shapes projected to
 * metres, pattern stops with their distance along the shape, trip instances
 * with their scheduled times, live trips with their planned stops.
 */
import type { LonLat, XY } from '../geo/plane.ts';
import { LocalPlane, Polyline, distance } from '../geo/plane.ts';
import type { InstanceRow, SnapshotRows } from '../store/store.ts';
import { serviceDayStart, serviceTime } from './time.ts';
import type { Itinerary, ItineraryStop, Operator, Pattern, PatternStop, TripInstance, TripProgress, Vehicle } from './types.ts';

/** A stop without dist_along_shape is matched to a pass of the shape within this distance (m)… */
const STOP_MATCH_M = 100;
/** …among the passes at most this much farther than the closest (both sides of a street) (m)… */
const STOP_TIE_M = 15;

/**
 * …the one closest to where the schedule puts the stop: the remaining shape
 * shared out in proportion to the remaining scheduled time.
 */
function projectStop(shape: Polyline, point: XY, fromM: number, timeShare: number): number | null {
  const passes = shape.candidates(point, fromM, shape.length, STOP_MATCH_M);
  if (passes.length === 0) return shape.nearest(point, fromM, shape.length)?.m ?? null;
  const best = Math.min(...passes.map((c) => c.distance));
  const expected = fromM + timeShare * (shape.length - fromM);
  let chosen: number | null = null;
  for (const c of passes) {
    if (c.distance > best + STOP_TIE_M) continue;
    if (chosen === null || Math.abs(c.m - expected) < Math.abs(chosen - expected)) chosen = c.m;
  }
  return chosen;
}

export interface Cache {
  operators: Map<string, Operator>;
  vehiclesByDevice: Map<string, Vehicle>;
  patterns: Map<string, Pattern>;
  instances: Map<string, { instance: TripInstance; row: InstanceRow }>;
  /** Patterns that could not be built (no shape, too few stops); their trips (scheduled or live) are ignored. */
  skippedPatterns: string[];
  /** Pattern stops without dist_along_shape (projected by the engine). */
  stopsWithoutDist: number;
}

export function buildCache(rows: SnapshotRows): Cache {
  // One plane per operator, around all its shapes and planned stops.
  const pointsByOperator = new Map<string, LonLat[]>();
  const addPoint = (operatorId: string, p: LonLat): void => {
    const list = pointsByOperator.get(operatorId) ?? [];
    list.push(p);
    pointsByOperator.set(operatorId, list);
  };
  for (const s of rows.shapes) {
    for (const [lon, lat] of s.coordinates) addPoint(s.operatorId, { lon, lat });
  }
  for (const i of rows.instances) {
    for (const p of i.plannedStops) addPoint(i.operatorId, { lon: p.lon, lat: p.lat });
  }
  const operators = new Map<string, Operator>();
  for (const o of rows.operators) {
    operators.set(o.id, { id: o.id, timezone: o.timezone, plane: LocalPlane.around(pointsByOperator.get(o.id) ?? []) });
  }

  const vehiclesByDevice = new Map<string, Vehicle>();
  for (const v of rows.vehicles) {
    vehiclesByDevice.set(v.deviceId, { id: v.id, operatorId: v.operatorId, deviceId: v.deviceId });
  }

  const shapes = new Map(rows.shapes.map((s) => [s.id, s]));
  const stopsByPattern = new Map<string, typeof rows.patternStops>();
  for (const ps of rows.patternStops) {
    const list = stopsByPattern.get(ps.patternId) ?? [];
    list.push(ps);
    stopsByPattern.set(ps.patternId, list);
  }

  const patterns = new Map<string, Pattern>();
  const skippedPatterns: string[] = [];
  let missingDist = 0;
  for (const p of rows.patterns) {
    const op = operators.get(p.operatorId);
    const shapeRow = p.shapeId === null ? undefined : shapes.get(p.shapeId);
    const stopRows = (stopsByPattern.get(p.id) ?? []).sort((a, b) => a.sequence - b.sequence);
    if (!op || !shapeRow || shapeRow.coordinates.length < 2 || stopRows.length < 2) {
      skippedPatterns.push(p.id);
      continue;
    }
    const shape = new Polyline(
      shapeRow.coordinates.map(([lon, lat]) => op.plane.toXY({ lon, lat })),
      shapeRow.lengthM,
    );
    // Stops without dist_along_shape are projected onto the shape after the
    // previous stop (so a loop's second visit lands on the second pass). Where
    // two passes are about equally close (both directions of a street), the
    // schedule decides; a stop clearly on one side keeps its own pass.
    // Import or route setup should store dist_along_shape; this is a fallback.
    let prevDist = 0;
    let prevOffset = 0;
    const lastOffset = stopRows[stopRows.length - 1]?.arrivalOffsetS ?? 0;
    const stops: PatternStop[] = stopRows.map((r) => {
      const point = op.plane.toXY({ lon: r.lon, lat: r.lat });
      const timeShare = lastOffset > prevOffset ? (r.arrivalOffsetS - prevOffset) / (lastOffset - prevOffset) : 0;
      if (r.distAlongShape === null) missingDist++;
      let distM = r.distAlongShape ?? projectStop(shape, point, prevDist, timeShare) ?? prevDist;
      prevOffset = r.arrivalOffsetS;
      distM = Math.min(Math.max(distM, prevDist), shape.length);
      prevDist = distM;
      return { sequence: r.sequence, distM, arrivalOffsetS: r.arrivalOffsetS, departureOffsetS: r.departureOffsetS, point };
    });
    patterns.set(p.id, { id: p.id, operatorId: p.operatorId, routeId: p.routeId, shape, stops });
  }

  const instances = new Map<string, { instance: TripInstance; row: InstanceRow }>();
  for (const r of rows.instances) {
    const op = operators.get(r.operatorId);
    if (!op) continue;
    const instance = r.kind === 'scheduled' ? scheduledInstance(r, op, patterns) : liveInstance(r, op, patterns);
    if (instance) instances.set(r.id, { row: r, instance });
  }

  return { operators, vehiclesByDevice, patterns, instances, skippedPatterns, stopsWithoutDist: missingDist };
}

function scheduledInstance(r: InstanceRow, op: Operator, patterns: ReadonlyMap<string, Pattern>): TripInstance | null {
  const pattern = r.patternId === null ? undefined : patterns.get(r.patternId);
  if (!pattern || r.startTimeS === null) return null;
  const startAt = serviceTime(r.serviceDate, r.startTimeS, op.timezone);
  const lastOffset = pattern.stops[pattern.stops.length - 1]?.arrivalOffsetS ?? 0;
  return {
    id: r.id, operatorId: r.operatorId, serviceDate: r.serviceDate, kind: 'scheduled', tripId: r.tripId,
    routeId: pattern.routeId, pattern, itinerary: null, title: null, visibleUntil: null,
    startAt, endAt: new Date(startAt.getTime() + lastOffset * 1000), timed: true,
  };
}

/**
 * A live trip: on a pattern (followed like a scheduled trip), with planned
 * stops (an itinerary), or neither (position only). Its window (assigner.ts,
 * tripWindow): from the first to the last planned time if it has any, else
 * from when it was saved (not before its service day) to the end of its
 * service day.
 */
function liveInstance(r: InstanceRow, op: Operator, patterns: ReadonlyMap<string, Pattern>): TripInstance | null {
  let pattern: Pattern | null = null;
  if (r.patternId !== null) {
    pattern = patterns.get(r.patternId) ?? null;
    if (pattern === null) return null;
  }
  const itinerary = pattern === null && r.plannedStops.length > 0 ? buildItinerary(r, op) : null;
  const times = r.plannedStops.flatMap((p) => [p.plannedArrival, p.plannedDeparture]).filter((d): d is Date => d !== null);
  const dayStart = serviceDayStart(r.serviceDate, op.timezone);
  const timed = itinerary !== null && times.length > 0;
  const startAt = timed
    ? new Date(Math.min(...times.map((d) => d.getTime())))
    : new Date(Math.max(dayStart.getTime(), r.createdAt.getTime()));
  const endAt = timed
    ? new Date(Math.max(...times.map((d) => d.getTime())))
    : serviceTime(r.serviceDate, 24 * 3600, op.timezone);
  return {
    id: r.id, operatorId: r.operatorId, serviceDate: r.serviceDate, kind: 'live', tripId: null,
    routeId: pattern?.routeId ?? r.routeId, pattern, itinerary, title: r.title, visibleUntil: r.visibleUntil,
    startAt, endAt, timed,
  };
}

function buildItinerary(r: InstanceRow, op: Operator): Itinerary {
  let distM = 0;
  let prev: XY | null = null;
  const stops: ItineraryStop[] = [...r.plannedStops].sort((a, b) => a.sequence - b.sequence).map((p) => {
    const point = op.plane.toXY({ lon: p.lon, lat: p.lat });
    if (prev !== null) distM += distance(prev, point);
    prev = point;
    return { sequence: p.sequence, point, plannedArrival: p.plannedArrival, plannedDeparture: p.plannedDeparture, distM };
  });
  return { stops };
}

/** The stop sequences of a trip instance in order (pattern or planned stops; none for a position-only live trip). */
export function stopSequences(inst: TripInstance): number[] {
  if (inst.pattern) return inst.pattern.stops.map((s) => s.sequence);
  return inst.itinerary?.stops.map((s) => s.sequence) ?? [];
}

/** Trip progress as stored in the database (after a restart or for a new instance). */
export function progressFromRow(row: InstanceRow, instance: TripInstance): TripProgress {
  const bySeq = new Map(row.stopEvents.map((e) => [e.sequence, e]));
  const sequences = stopSequences(instance);
  const lastSeq = sequences[sequences.length - 1];
  const lastEvent = lastSeq === undefined ? undefined : bySeq.get(lastSeq);
  return {
    status: row.status,
    vehicleId: row.vehicleId,
    startedBy: row.startedBy,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    progressM: row.progressM,
    progressAt: row.progressAt,
    lastFixAt: row.progressAt,
    lastFixXY: null,
    lastConfirmedStopSequence: row.lastConfirmedStopSequence,
    awaySince: row.offRouteSince,
    offRouteSince: row.offRouteSince,
    pendingJump: null,
    reachedFinalStop: instance.pattern !== null && lastEvent?.state === 'arrived',
    finalLeaveCount: 0,
    // Stop events are created with the trip instance (scheduled trips,
    // planned stops); fall back to `upcoming` for any that are missing (a
    // live trip on a pattern: the engine creates them when it starts).
    stops: sequences.map((sequence) => {
      const e = bySeq.get(sequence);
      return {
        sequence,
        state: e?.state ?? 'upcoming',
        arrivedAt: e?.arrivedAt ?? null,
        departedAt: e?.departedAt ?? null,
        passedAt: e?.passedAt ?? null,
        eta: e?.eta ?? null,
      };
    }),
    itinerary: instance.itinerary === null ? null : { touchedSeq: null, dwell: null },
  };
}

/**
 * After a reload of a running trip whose stops changed (staff edited a live
 * trip's planned stops): keeps the memory state of stops still planned,
 * takes the database's state for new ones and drops removed ones.
 */
export function alignStops(progress: TripProgress, row: InstanceRow, instance: TripInstance): TripProgress {
  const sequences = stopSequences(instance);
  const same = sequences.length === progress.stops.length && sequences.every((q, i) => progress.stops[i]?.sequence === q);
  if (same && (instance.itinerary === null) === (progress.itinerary === null)) return progress;
  const fromRow = progressFromRow(row, instance);
  const mem = new Map(progress.stops.map((s) => [s.sequence, s]));
  const stops = fromRow.stops.map((s) => mem.get(s.sequence) ?? s);
  const keep = (q: number | null | undefined): boolean => q !== null && q !== undefined && sequences.includes(q);
  const itinerary = instance.itinerary === null ? null : {
    touchedSeq: keep(progress.itinerary?.touchedSeq) ? progress.itinerary?.touchedSeq ?? null : null,
    dwell: keep(progress.itinerary?.dwell?.sequence) ? progress.itinerary?.dwell ?? null : null,
  };
  return { ...progress, stops, itinerary };
}
