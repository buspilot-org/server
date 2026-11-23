/**
 * Trip assigner (engine.md, "Trip assigner"): which trip instance a vehicle
 * is running. No candidate → no trip, which is what keeps excursions and
 * extra trips from producing stop events.
 */
import type { Thresholds } from '../config.ts';
import type { XY } from '../geo/plane.ts';
import { distance } from '../geo/plane.ts';
import { expectedProgressAt } from './eta.ts';
import { addSeconds } from './time.ts';
import type { TripInstance, TripRuntime, Vehicle } from './types.ts';

export function windowOpen(inst: TripInstance, at: Date, t: Thresholds): boolean {
  return at >= addSeconds(inst.startAt, -t.tripWindowBeforeS) && at <= addSeconds(inst.endAt, t.tripWindowAfterS);
}

/** The vehicle's active trip, if any (the one started first if there are several). */
export function activeTrip(trips: Iterable<TripRuntime>, vehicleId: string): TripRuntime | undefined {
  let found: TripRuntime | undefined;
  for (const tr of trips) {
    if (tr.progress.status !== 'active' || tr.progress.vehicleId !== vehicleId) continue;
    if (!found || (tr.progress.startedAt ?? tr.instance.startAt) < (found.progress.startedAt ?? found.instance.startAt)) found = tr;
  }
  return found;
}

/**
 * Planned trips this vehicle may start now: for this vehicle (the instance's
 * vehicle if staff set one, else the trip's default vehicle, else any vehicle
 * of the operator) with an open window.
 */
export function startCandidates(trips: Iterable<TripRuntime>, vehicle: Vehicle, at: Date, t: Thresholds): TripRuntime[] {
  const out: TripRuntime[] = [];
  for (const tr of trips) {
    if (tr.progress.status !== 'planned' || tr.instance.operatorId !== vehicle.operatorId) continue;
    const v = tr.progress.vehicleId ?? tr.scheduledVehicleId;
    if (v !== null && v !== vehicle.id) continue;
    if (windowOpen(tr.instance, at, t)) out.push(tr);
  }
  return out;
}

/** A vehicle's streak of fixes towards starting one trip (kept per vehicle and trip, outside the trip's state). */
export interface StartStreak {
  /** Progress at the start of the streak. */
  startM: number;
  /** Highest progress in the streak. */
  lastM: number;
  count: number;
  /** Since when the bus has been standing at the first stop, if it was. */
  atFirstStopSince: Date | null;
}

export interface StartEvaluation {
  streak: StartStreak | null;
  /** Where the bus is along the route if the trip starts now. */
  startM: number | null;
}

/** GPS jitter tolerated before a streak counts as moving backwards (m). */
const STREAK_JITTER_M = 10;

/**
 * Automatic start: the bus is on the first part of the route and moves in
 * route direction (autoStartConfirmFixes fixes, at least autoStartMinAdvanceM,
 * currently moving). A bus parked at the first stop does not start a trip;
 * once it pulls away, the trip starts and the first stop counts as arrived
 * since the bus stood there.
 */
export function evaluateStart(
  tr: TripRuntime,
  prev: StartStreak | null,
  xy: XY,
  at: Date,
  speedKmh: number,
  t: Thresholds,
): StartEvaluation {
  const pattern = tr.instance.pattern;
  const proj = pattern.shape.nearest(xy, 0, t.autoStartMaxProgressM);
  if (proj === null || proj.distance > t.onRouteM) return { streak: null, startM: null };
  const first = pattern.stops[0];
  const atFirstStop = first !== undefined && distance(xy, first.point) <= t.autoStartFirstStopM && speedKmh < t.arrivedMaxSpeedKmh;
  const streak: StartStreak = prev && proj.m >= prev.lastM - STREAK_JITTER_M
    ? {
        startM: prev.startM,
        lastM: Math.max(prev.lastM, proj.m),
        count: prev.count + 1,
        atFirstStopSince: prev.atFirstStopSince ?? (atFirstStop ? at : null),
      }
    : { startM: proj.m, lastM: proj.m, count: 1, atFirstStopSince: atFirstStop ? at : null };
  const moving = speedKmh >= t.arrivedMaxSpeedKmh;
  if (moving && streak.count >= t.autoStartConfirmFixes && proj.m - streak.startM >= t.autoStartMinAdvanceM) {
    return { streak, startM: proj.m };
  }
  return { streak, startM: null };
}

/** Several trips could start (e.g. two trips of the same pattern): the one whose schedule fits the position best. */
export function chooseStart<T extends { trip: TripRuntime; startM: number }>(options: readonly T[], at: Date): T | undefined {
  let best: T | undefined;
  let bestScore = Infinity;
  for (const o of options) {
    const score = Math.abs(expectedProgressAt(o.trip.instance, at) - o.startM);
    if (score < bestScore || (score === bestScore && best && o.trip.instance.startAt < best.trip.instance.startAt)) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}
