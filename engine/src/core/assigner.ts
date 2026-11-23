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
import type { TripInstance, TripProgress, TripRuntime, Vehicle } from './types.ts';

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
 * Planned trips this vehicle may start now: scheduled for this vehicle (or
 * for no vehicle in particular, within the same operator) with an open window.
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

export interface StartEvaluation {
  /** New progress of the candidate (start streak updated). */
  progress: TripProgress;
  /** Where the bus is along the route if the trip may start now. */
  startM: number | null;
}

/**
 * Automatic start: the bus is at the first stop, or on the first part of the
 * route and moving in route direction for autoStartConfirmFixes fixes.
 */
export function evaluateStart(tr: TripRuntime, xy: XY, t: Thresholds): StartEvaluation {
  const pattern = tr.instance.pattern;
  const progress: TripProgress = { ...tr.progress };
  const proj = pattern.shape.nearest(xy, 0, t.autoStartMaxProgressM);
  if (proj === null || proj.distance > t.onRouteM) {
    progress.startCandidate = null;
    return { progress, startM: null };
  }
  const first = pattern.stops[0];
  if (first && distance(xy, first.point) <= t.autoStartFirstStopM) {
    progress.startCandidate = null;
    return { progress, startM: proj.m };
  }
  const prev = tr.progress.startCandidate;
  progress.startCandidate = prev && proj.m > prev.m ? { m: proj.m, count: prev.count + 1 } : { m: proj.m, count: 1 };
  if (progress.startCandidate.count >= t.autoStartConfirmFixes) {
    progress.startCandidate = null;
    return { progress, startM: proj.m };
  }
  return { progress, startM: null };
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
