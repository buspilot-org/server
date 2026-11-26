/**
 * Live trips without a pattern: following planned stops (a tour itinerary,
 * `trip_instance_stop`) when there is no shape to match against.
 * Rules (engine/README.md, "Live trips"):
 *
 * - **Order, not circles.** Plain geofence circles caused the trial app's
 *   false and double alerts: the bus entered the circle of a later stop
 *   first (loops, the same hotel at the start and the end). Here only the
 *   *next open stop* (the first one not yet departed or passed) can be
 *   arrived at by being near it. Being near any other stop does nothing,
 *   except for the explicit skip rule below.
 * - **Near:** within itineraryArrivedRadiusM of the stop. **Arrived:** near
 *   and slower than arrivedMaxSpeedKmh.
 * - **Touched in order:** coming near the next open stop, then near the one
 *   after it, and so on, "touches" those stops in plan order (also without
 *   stopping). Arriving at a touched stop closes all open stops before it:
 *   departed if the bus had arrived there, else passed (it drove past
 *   without stopping).
 * - **Skip:** a stop up to itinerarySkipStops after the next open stop that
 *   was not touched in order (the bus did not come near the stops before
 *   it) is arrived at only after the bus has stood near it for
 *   itinerarySkipDwellS, and not earlier than itinerarySkipEarlyS before its
 *   planned time (if it has one). A red light next to a later stop, or the
 *   hotel the tour comes back to in the evening, does not skip the plan.
 * - **Departed:** only by leaving: farther than itineraryLeaveM from the
 *   stop for itineraryLeaveFixes fixes in a row (or arriving at a later
 *   stop). Never by time: a long planned stay (10:30–12:00) stays `arrived`
 *   however long the bus stands there, and later stops are not passed.
 * - **Progress** (`progress_m`): straight-line distance along the planned
 *   stops: up to the last stop reached, plus the position projected onto
 *   the leg to the next open stop. Only grows.
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
  /** Consecutive fixes away from the stop the bus is at. */
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

/** Applies one fix. `prev.stops` must be in the itinerary's order (as progressFromRow builds them). */
export function updateItinerary(itin: Itinerary, prev: ItineraryState, fix: ItineraryFix, t: Thresholds): ItineraryResult {
  const plan = itin.stops;
  const n = plan.length;
  const stops = [...prev.stops];
  let leaveCount = prev.leaveCount;
  let { touchedSeq, dwell } = prev.itinerary;
  const dist = (i: number): number => {
    const p = plan[i];
    return p === undefined ? Infinity : distance(fix.xy, p.point);
  };
  const near = (i: number): boolean => dist(i) <= t.itineraryArrivedRadiusM;
  const slow = fix.speedKmh < t.arrivedMaxSpeedKmh;
  const stateOf = (i: number): StopProgress['state'] | undefined => stops[i]?.state;
  const firstOpen = (from: number): number => {
    let i = from;
    while (i < n && isFinalStopState(stateOf(i) ?? 'passed')) i++;
    return i;
  };
  const set = (i: number, next: Partial<StopProgress>): void => {
    const s = stops[i];
    if (s !== undefined) stops[i] = { ...s, ...next };
  };
  /** Arrives at stop j: closes every open stop before it. */
  const arrive = (j: number, at: Date): void => {
    for (let i = 0; i < j; i++) {
      const s = stops[i];
      if (s === undefined || isFinalStopState(s.state)) continue;
      set(i, s.state === 'arrived' ? { state: 'departed', departedAt: fix.at } : { state: 'passed', passedAt: fix.at });
    }
    set(j, { state: 'arrived', arrivedAt: at });
    leaveCount = 0;
    dwell = null;
  };

  // 1. Leaving the stop the bus is at.
  let cur = firstOpen(0);
  if (cur < n && stateOf(cur) === 'arrived') {
    leaveCount = dist(cur) > t.itineraryLeaveM ? leaveCount + 1 : 0;
    if (leaveCount >= t.itineraryLeaveFixes) {
      set(cur, { state: 'departed', departedAt: fix.at });
      leaveCount = 0;
      cur = firstOpen(cur + 1);
    }
  } else {
    leaveCount = 0;
  }

  // 2. The next open stop not arrived at, and the stops touched in order from there.
  const dwelling = cur < n && stateOf(cur) === 'arrived' ? cur : -1;
  const nxt = dwelling >= 0 ? firstOpen(cur + 1) : cur;
  const seqIndex = (q: number | null): number => (q === null ? -1 : plan.findIndex((p) => p.sequence === q));
  let touched = Math.max(seqIndex(touchedSeq), nxt - 1);
  const last = Math.min(n - 1, nxt + t.itinerarySkipStops);
  while (touched + 1 <= last && near(touched + 1)) touched++;
  touchedSeq = touched >= nxt ? plan[touched]?.sequence ?? null : null;

  // 3. Arrival: the first stop in plan order that the bus is slow near.
  let target = -1;
  if (slow) {
    for (let j = nxt; j <= last; j++) {
      // At the stop it is at, the bus arrives at a later stop only once it is closer to that one.
      if (near(j) && (dwelling < 0 || !near(dwelling) || dist(j) < dist(dwelling))) {
        target = j;
        break;
      }
    }
  }
  const targetSeq = plan[target]?.sequence;
  if (target >= 0 && targetSeq !== undefined) {
    if (target <= touched) {
      arrive(target, fix.at);
    } else if (skipAllowed(plan[target], fix.at, t)) {
      // A skip: confirmed by standing there.
      if (dwell?.sequence !== targetSeq) dwell = { sequence: targetSeq, since: fix.at };
      if (secondsBetween(dwell.since, fix.at) >= t.itinerarySkipDwellS) arrive(target, dwell.since);
    } else {
      dwell = null;
    }
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
  return { stops, itinerary: { touchedSeq, dwell }, leaveCount, progressM, changes };
}

function skipAllowed(stop: ItineraryStop | undefined, at: Date, t: Thresholds): boolean {
  const planned = stop?.plannedArrival ?? stop?.plannedDeparture ?? null;
  return planned === null || at >= addSeconds(planned, -t.itinerarySkipEarlyS);
}

/** Straight-line distance along the planned stops to where the bus is. */
function progressAlong(plan: readonly ItineraryStop[], stops: readonly StopProgress[], xy: XY): number {
  let reached = -1;
  stops.forEach((s, i) => {
    if (s.state !== 'upcoming' && s.state !== 'approaching') reached = i;
  });
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
 * - the bus leaves a stop at its planned departure, or at once if the stop
 *   has none.
 */
export function itineraryEtas(itin: Itinerary, stops: readonly StopProgress[], xy: XY, now: Date, t: Thresholds): Map<number, Date> {
  const plan = itin.stops;
  const out = new Map<number, Date>();
  let reached = -1;
  stops.forEach((s, i) => {
    if (s.state !== 'upcoming' && s.state !== 'approaching') reached = i;
  });
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
    const eta = addSeconds(time, travelS);
    out.set(stop.sequence, eta);
    time = stop.plannedDeparture !== null && stop.plannedDeparture > eta ? stop.plannedDeparture : eta;
    pos = stop.point;
    prev = stop;
  }
  return out;
}
