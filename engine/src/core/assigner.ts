/**
 * Trip assigner (engine.md, "Trip assigner"): which trip instance a vehicle
 * is running. No candidate → no trip, which is what keeps excursions and
 * extra trips from producing stop events.
 *
 * Live trips (engine/README.md, "Live trips") and precedence on one vehicle:
 * 1. A running (active) trip keeps its vehicle until it ends (last stop,
 *    window closed, cancelled or completed by staff), whatever its kind:
 *    nothing pre-empts it.
 * 2. A vehicle without a running trip starts a due live trip of its own
 *    before any scheduled trip: staff planned it for this vehicle on purpose
 *    (an away game after the morning run).
 * 3. So while a live trip runs, no scheduled trip starts on its vehicle; a
 *    scheduled trip that was not started in its window stays planned.
 * Live trips are only followed with a vehicle (`trip_instance.vehicle_id`);
 * one saved for "any vehicle" waits until staff choose one.
 */
import type { Thresholds } from '../config.ts';
import type { XY } from '../geo/plane.ts';
import { distance } from '../geo/plane.ts';
import { expectedProgressAt } from './eta.ts';
import { addSeconds } from './time.ts';
import type { TripInstance, TripRuntime, Vehicle } from './types.ts';

/**
 * When a trip may run: it starts only inside the window, and a running trip
 * is completed once the window has closed.
 * - Scheduled: tripWindowBeforeS before the scheduled start to
 *   tripWindowAfterS after the scheduled end.
 * - Live: from tripWindowBeforeS before the first planned stop's time, or
 *   without one from when it was saved (startAt); to tripWindowAfterS after
 *   the last planned stop's time, or without one after the end of its
 *   service day; a live trip on a pattern, once started, until its start
 *   plus the pattern's running time plus tripWindowAfterS.
 * - Live: never after visible_until (riders no longer see the trip).
 */
export function tripWindow(tr: TripRuntime, t: Thresholds): { from: Date; to: Date } {
  const i = tr.instance;
  if (i.kind === 'scheduled') return { from: addSeconds(i.startAt, -t.tripWindowBeforeS), to: addSeconds(i.endAt, t.tripWindowAfterS) };
  const from = i.timedStart ? addSeconds(i.startAt, -t.tripWindowBeforeS) : i.startAt;
  let to = addSeconds(i.endAt, t.tripWindowAfterS);
  const started = tr.progress.startedAt;
  if (!i.timedEnd && i.pattern !== null && started !== null) {
    to = addSeconds(started, (i.pattern.stops[i.pattern.stops.length - 1]?.arrivalOffsetS ?? 0) + t.tripWindowAfterS);
  }
  if (i.visibleUntil !== null && i.visibleUntil < to) to = i.visibleUntil;
  return { from, to };
}

export function windowOpen(tr: TripRuntime, at: Date, t: Thresholds): boolean {
  const w = tripWindow(tr, t);
  return at >= w.from && at <= w.to;
}

/**
 * The time a trip's schedule counts from. Scheduled trips: the scheduled
 * start. A live trip on a pattern has no start time: the pattern's offsets
 * count from when it started (before that, from when it may start).
 */
export function scheduleStart(tr: TripRuntime): Date {
  return tr.instance.kind === 'live' ? tr.progress.startedAt ?? tr.instance.startAt : tr.instance.startAt;
}

/** The instance with startAt moved to scheduleStart, for the pattern-based ETA and tie breaks. */
export function scheduledInstance(tr: TripRuntime): TripInstance {
  const startAt = scheduleStart(tr);
  return startAt === tr.instance.startAt ? tr.instance : { ...tr.instance, startAt };
}

/**
 * The vehicle's active trip, if any. Should there be several (only through
 * changes made in the database), a live trip wins, then the one started first.
 */
export function activeTrip(trips: Iterable<TripRuntime>, vehicleId: string): TripRuntime | undefined {
  let found: TripRuntime | undefined;
  const rank = (tr: TripRuntime): number => (tr.instance.kind === 'live' ? 0 : 1);
  for (const tr of trips) {
    if (tr.progress.status !== 'active' || tr.progress.vehicleId !== vehicleId) continue;
    if (
      !found || rank(tr) < rank(found)
      || (rank(tr) === rank(found) && (tr.progress.startedAt ?? tr.instance.startAt) < (found.progress.startedAt ?? found.instance.startAt))
    ) found = tr;
  }
  return found;
}

/**
 * Planned scheduled trips this vehicle may start now: for this vehicle (the
 * instance's vehicle if staff set one, else the trip's default vehicle, else
 * any vehicle of the operator) with an open window.
 */
export function startCandidates(trips: Iterable<TripRuntime>, vehicle: Vehicle, at: Date, t: Thresholds): TripRuntime[] {
  const out: TripRuntime[] = [];
  for (const tr of trips) {
    if (tr.instance.kind !== 'scheduled' || tr.progress.status !== 'planned' || tr.instance.operatorId !== vehicle.operatorId) continue;
    const v = tr.progress.vehicleId ?? tr.scheduledVehicleId;
    if (v !== null && v !== vehicle.id) continue;
    if (windowOpen(tr, at, t)) out.push(tr);
  }
  return out;
}

/** Planned live trips of this vehicle with an open window, earliest first. They go before scheduled trips (rule 2 above). */
export function liveStartCandidates(trips: Iterable<TripRuntime>, vehicle: Vehicle, at: Date, t: Thresholds): TripRuntime[] {
  const out: TripRuntime[] = [];
  for (const tr of trips) {
    if (tr.instance.kind !== 'live' || tr.progress.status !== 'planned' || tr.progress.vehicleId !== vehicle.id) continue;
    if (tr.instance.operatorId === vehicle.operatorId && windowOpen(tr, at, t)) out.push(tr);
  }
  return out.sort((a, b) => a.instance.startAt.getTime() - b.instance.startAt.getTime());
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
  if (pattern === null) return { streak: null, startM: null };
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
    const score = Math.abs(expectedProgressAt(scheduledInstance(o.trip), at) - o.startM);
    if (score < bestScore || (score === bestScore && best && o.trip.instance.startAt < best.trip.instance.startAt)) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}
