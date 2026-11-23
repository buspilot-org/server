/**
 * Builds the in-memory cache (engine.md, "Inputs": schedule and devices are
 * read from Supabase into memory) from database rows: shapes projected to
 * metres, pattern stops with their distance along the shape, trip instances
 * with their scheduled times.
 */
import type { LonLat, XY } from '../geo/plane.ts';
import { LocalPlane, Polyline } from '../geo/plane.ts';
import type { InstanceRow, SnapshotRows } from '../store/store.ts';
import { serviceTime } from './time.ts';
import type { Operator, Pattern, PatternStop, TripInstance, TripProgress, Vehicle } from './types.ts';

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
  /** Patterns that could not be built (no shape, too few stops); their trips are ignored. */
  skippedPatterns: string[];
  /** Pattern stops without dist_along_shape (projected by the engine). */
  stopsWithoutDist: number;
}

export function buildCache(rows: SnapshotRows): Cache {
  // One plane per operator, around all its shapes.
  const pointsByOperator = new Map<string, LonLat[]>();
  for (const s of rows.shapes) {
    const list = pointsByOperator.get(s.operatorId) ?? [];
    for (const [lon, lat] of s.coordinates) list.push({ lon, lat });
    pointsByOperator.set(s.operatorId, list);
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
    const pattern = patterns.get(r.patternId);
    const op = operators.get(r.operatorId);
    if (!pattern || !op) continue;
    const startAt = serviceTime(r.serviceDate, r.startTimeS, op.timezone);
    const lastOffset = pattern.stops[pattern.stops.length - 1]?.arrivalOffsetS ?? 0;
    instances.set(r.id, {
      row: r,
      instance: {
        id: r.id,
        operatorId: r.operatorId,
        serviceDate: r.serviceDate,
        tripId: r.tripId,
        pattern,
        startAt,
        endAt: new Date(startAt.getTime() + lastOffset * 1000),
      },
    });
  }

  return { operators, vehiclesByDevice, patterns, instances, skippedPatterns, stopsWithoutDist: missingDist };
}

/** Trip progress as stored in the database (after a restart or for a new instance). */
export function progressFromRow(row: InstanceRow, pattern: Pattern): TripProgress {
  const bySeq = new Map(row.stopEvents.map((e) => [e.sequence, e]));
  const lastStop = pattern.stops[pattern.stops.length - 1];
  const lastEvent = lastStop ? bySeq.get(lastStop.sequence) : undefined;
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
    reachedFinalStop: lastEvent?.state === 'arrived',
    finalLeaveCount: 0,
    // Stop events are created with the trip instance; fall back to
    // `upcoming` for any that are missing.
    stops: pattern.stops.map((ps) => {
      const e = bySeq.get(ps.sequence);
      return {
        sequence: ps.sequence,
        state: e?.state ?? 'upcoming',
        arrivedAt: e?.arrivedAt ?? null,
        departedAt: e?.departedAt ?? null,
        passedAt: e?.passedAt ?? null,
        eta: e?.eta ?? null,
      };
    }),
  };
}
