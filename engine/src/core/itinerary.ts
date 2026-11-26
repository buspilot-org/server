/**
 * Live trips without a pattern: following planned stops (a tour itinerary,
 * `trip_instance_stop`) when there is no shape to match against.
 * Rules (engine/README.md, "Live trips"):
 *
 * - **Order, not circles.** Plain geofence circles caused the trial app's
 *   false and double alerts: the bus entered the circle of a later stop
 *   first (loops, the same hotel at the start and the end). Here only the
 *   *next stop* (the first one after the last stop reached) can be arrived
 *   at or passed by being near it. Being near any other stop does nothing,
 *   except for the explicit skip rule below.
 * - **Near:** within itineraryArrivedRadiusM of the stop. **Arrived:** near
 *   and slower than arrivedMaxSpeedKmh.
 * - **Passed:** the bus came near the next stop without stopping and then
 *   left it (farther than itineraryLeaveM for itineraryLeaveFixes fixes),
 *   or came nearer to the stop after it; `passed_at` is the last time it
 *   was near.
 * - **Skip:** a later stop the bus did not reach in order (a GPS gap, a stop
 *   the bus never came near) is arrived at only after the bus has stood
 *   near it for itinerarySkipDwellS: with a planned time, not earlier than
 *   itinerarySkipEarlyS before it (any later stop); without one, at most
 *   itinerarySkipStops places after the next stop. The stops between are
 *   passed.
 * - **Departed:** only by leaving: farther than itineraryLeaveM from the
 *   stop for itineraryLeaveFixes fixes in a row, or arriving at a later stop.
 *   Never by time: a long planned stay (10:30–12:00) stays `arrived` however
 *   long the bus stands there, and later stops are not passed. A next stop
 *   at the same place (a planned pick-up where the group was dropped off) is
 *   arrived at once its planned time has come.
 * - Arriving at, departing or passing a stop closes every open stop before
 *   it (a stop staff inserted before the one the bus is at).
 * - **Progress** (`progress_m`): straight-line distance along the planned
 *   stops: up to the last stop reached, plus the position projected onto
 *   the leg to the next stop. Only grows.
 * - There is no route to leave: such a trip is never off route.
 */
import type { Thresholds } from '../config.ts';
import type { XY } from '../geo/plane.ts';
import { distance } from '../geo/plane.ts';
import type { StopChange } from './stops.ts';
import { addSeconds, secondsBetween } from './time.ts';
import type { Itinerary, ItineraryProgress, ItineraryStop, StopProgress } from './types.ts';
import { isFinalStopState, stopStateRank } from './types.ts';

export interface ItineraryFix {
  xy: XY;
  at: Date;
  speedKmh: number;
}

export interface ItineraryState {
  stops: readonly StopProgress[];
  itinerary: ItineraryProgress;
  /** Consecutive fixes away from the stop the bus is at (or came near). */
  leaveCount: number;
  progressM: number;
}

export interface ItineraryResult {
  stops: StopProgress[];
  itinerary: ItineraryProgress;
  leaveCount: number;
  progressM: number;
  changes: StopChange[];
}

const isOpen = (s: StopProgress | undefined): boolean => s !== undefined && (s.state === 'upcoming' || s.state === 'approaching');

/** Index of the last stop arrived at, departed or passed; -1 if none. */
function lastReached(stops: readonly StopProgress[]): number {
  let r = -1;
  stops.forEach((s, i) => {
    if (!isOpen(s)) r = i;
  });
  return r;
}

/** Applies one fix. `prev.stops` must be in the itinerary's order (as progressFromRow builds them). */
export function updateItinerary(itin: Itinerary, prev: ItineraryState, fix: ItineraryFix, t: Thresholds): ItineraryResult {
  const plan = itin.stops;
  const n = plan.length;
  const stops = [...prev.stops];
  let leaveCount = prev.leaveCount;
  let { touchedSeq, touchedAt, dwell } = prev.itinerary;
  const dist = (i: number): number => {
    const p = plan[i];
    return p === undefined ? Infinity : distance(fix.xy, p.point);
  };
  const near = (i: number): boolean => dist(i) <= t.itineraryArrivedRadiusM;
  const slow = fix.speedKmh < t.arrivedMaxSpeedKmh;
  const set = (i: number, next: Partial<StopProgress>): void => {
    const s = stops[i];
    if (s !== undefined) stops[i] = { ...s, ...next };
  };
  /** Closes every open stop before j: departed if the bus is there, else passed. */
  const closeBefore = (j: number, at: Date): void => {
    for (let i = 0; i < j; i++) {
      const s = stops[i];
      if (s === undefined || isFinalStopState(s.state)) continue;
      set(i, s.state === 'arrived' ? { state: 'departed', departedAt: at } : { state: 'passed', passedAt: at });
    }
  };
  const reset = (): void => {
    leaveCount = 0;
    touchedSeq = null;
    touchedAt = null;
    dwell = null;
  };
  const arrive = (j: number, at: Date): void => {
    closeBefore(j, at);
    set(j, { state: 'arrived', arrivedAt: at });
    reset();
  };

  let base = lastReached(stops);
  let atStop = stops[base]?.state === 'arrived' ? base : -1;
  let nxt = base + 1;
  if (touchedSeq !== plan[nxt]?.sequence) {
    touchedSeq = null;
    touchedAt = null;
  }

  // 1. Leaving the stop the bus is at, or the next stop it came near without stopping.
  const anchor = atStop >= 0 ? atStop : touchedAt !== null ? nxt : -1;
  if (anchor >= 0) {
    leaveCount = dist(anchor) > t.itineraryLeaveM ? leaveCount + 1 : 0;
    if (leaveCount >= t.itineraryLeaveFixes) {
      if (anchor === atStop) {
        closeBefore(atStop, fix.at);
        set(atStop, { state: 'departed', departedAt: fix.at });
      } else {
        const passedAt = touchedAt ?? fix.at;
        closeBefore(nxt, passedAt);
        set(nxt, { state: 'passed', passedAt });
      }
      reset();
      base = lastReached(stops);
      atStop = -1;
      nxt = base + 1;
    }
  } else {
    leaveCount = 0;
  }

  // 2. Driving past the next stop: nearer to the one after it than to it → passed.
  while (touchedAt !== null && atStop < 0 && nxt + 1 < n && near(nxt + 1) && dist(nxt + 1) < dist(nxt)) {
    closeBefore(nxt, touchedAt);
    set(nxt, { state: 'passed', passedAt: touchedAt });
    reset();
    nxt++;
  }
  if (nxt < n && near(nxt)) {
    touchedSeq = plan[nxt]?.sequence ?? null;
    touchedAt = fix.at;
  }

  // 3. Arrival: the first stop in plan order the bus may arrive at and is slow near.
  let target = -1;
  let skip = false;
  if (slow) {
    for (let j = nxt; j < n; j++) {
      if (!near(j)) continue;
      if (j === nxt) {
        // At the stop it is at, the bus arrives at the next one only once it is
        // closer to it; at the same place, once its planned time has come.
        const here = plan[atStop];
        const there = plan[j];
        const samePlace = here !== undefined && there !== undefined && distance(here.point, there.point) <= t.itineraryArrivedRadiusM;
        if (atStop < 0 || !near(atStop) || (samePlace ? due(there, here, fix.at) : dist(j) < dist(atStop))) {
          target = j;
          break;
        }
        continue;
      }
      if (skipAllowed(plan[j], j - nxt, fix.at, t)) {
        target = j;
        skip = true;
        break;
      }
    }
  }
  const targetSeq = plan[target]?.sequence;
  if (target >= 0 && targetSeq !== undefined && !skip) {
    arrive(target, fix.at);
  } else if (target >= 0 && targetSeq !== undefined) {
    // A skip: confirmed by standing there.
    if (dwell?.sequence !== targetSeq) dwell = { sequence: targetSeq, since: fix.at };
    if (secondsBetween(dwell.since, fix.at) >= t.itinerarySkipDwellS) arrive(target, dwell.since);
  } else {
    dwell = null;
  }

  // 4. Progress along the planned stops.
  const progressM = Math.max(prev.progressM, progressAlong(plan, stops, fix.xy));

  const changes: StopChange[] = [];
  stops.forEach((s, i) => {
    const before = prev.stops[i];
    if (before === undefined || s === before) return;
    if (stopStateRank[s.state] <= stopStateRank[before.state]) throw new Error('stop state can only move forward');
    changes.push({ sequence: s.sequence, from: before.state, to: s.state });
  });
  return { stops, itinerary: { touchedSeq, touchedAt, dwell }, leaveCount, progressM, changes };
}

/** The next stop's planned time (or the current stop's planned departure) has come. */
function due(next: ItineraryStop | undefined, current: ItineraryStop | undefined, at: Date): boolean {
  const time = next?.plannedArrival ?? next?.plannedDeparture ?? current?.plannedDeparture ?? null;
  return time !== null && at >= time;
}

/** A later stop `ahead` places after the next one may be skipped to (confirmed by standing there). */
function skipAllowed(stop: ItineraryStop | undefined, ahead: number, at: Date, t: Thresholds): boolean {
  const planned = stop?.plannedArrival ?? stop?.plannedDeparture ?? null;
  if (planned === null) return ahead <= t.itinerarySkipStops;
  return at >= addSeconds(planned, -t.itinerarySkipEarlyS);
}

/** Straight-line distance along the planned stops to where the bus is. */
function progressAlong(plan: readonly ItineraryStop[], stops: readonly StopProgress[], xy: XY): number {
  const reached = lastReached(stops);
  const from = plan[reached];
  const to = plan[reached + 1];
  if (stops[reached]?.state === 'arrived' || to === undefined) return from?.distM ?? 0;
  if (from === undefined) return 0;
  const leg = to.distM - from.distM;
  if (leg <= 0) return from.distM;
  const dx = to.point.x - from.point.x;
  const dy = to.point.y - from.point.y;
  const f = ((xy.x - from.point.x) * dx + (xy.y - from.point.y) * dy) / (leg * leg);
  return from.distM + Math.min(1, Math.max(0, f)) * leg;
}

/**
 * ETAs for the open stops not yet arrived at, in plan order:
 * - starting now from the bus, or, while it stands at a stop, from that stop
 *   at its planned departure (not before now): a long planned stay is not
 *   a delay, and the later stops wait for it;
 * - travel to each stop: the planned time between the two stops (planned
 *   arrival minus the previous stop's planned departure), for the first
 *   leg in proportion to the straight-line distance still to go; without
 *   planned times, the straight-line distance × itineraryDetourFactor at
 *   itinerarySpeedKmh;
 * - never sooner than the straight-line distance at etaMaxSpeedKmh;
 * - before the first stop is reached, never before the planned arrival;
 * - the bus leaves a stop at its planned departure, or at once if the stop
 *   has none.
 */
export function itineraryEtas(itin: Itinerary, stops: readonly StopProgress[], xy: XY, now: Date, t: Thresholds): Map<number, Date> {
  const plan = itin.stops;
  const out = new Map<number, Date>();
  const reached = lastReached(stops);
  const at = plan[reached];
  const dwelling = at !== undefined && stops[reached]?.state === 'arrived';
  let time = dwelling && at.plannedDeparture !== null && at.plannedDeparture > now ? at.plannedDeparture : now;
  let pos: XY = dwelling ? at.point : xy;
  let prev: ItineraryStop | undefined = at;
  for (let k = reached + 1; k < plan.length; k++) {
    const stop = plan[k];
    const s = stops[k];
    if (stop === undefined || s === undefined || (s.state !== 'upcoming' && s.state !== 'approaching')) continue;
    const d = distance(pos, stop.point);
    const leaveAt = prev?.plannedDeparture ?? prev?.plannedArrival ?? null;
    const span = leaveAt !== null && stop.plannedArrival !== null ? secondsBetween(leaveAt, stop.plannedArrival) : null;
    let travelS: number;
    if (span !== null && span > 0 && prev !== undefined) {
      const leg = distance(prev.point, stop.point);
      travelS = leg > 1 ? span * Math.min(1, d / leg) : span;
    } else {
      travelS = (d * t.itineraryDetourFactor) / (t.itinerarySpeedKmh / 3.6);
    }
    travelS = Math.max(travelS, d / (t.etaMaxSpeedKmh / 3.6));
    let eta = addSeconds(time, travelS);
    // Before the first stop is reached (the window opens before it), the
    // plan holds: an early bus does not make the ETAs early.
    if (reached < 0 && stop.plannedArrival !== null && stop.plannedArrival > eta) eta = stop.plannedArrival;
    out.set(stop.sequence, eta);
    time = stop.plannedDeparture !== null && stop.plannedDeparture > eta ? stop.plannedDeparture : eta;
    pos = stop.point;
    prev = stop;
  }
  return out;
}
