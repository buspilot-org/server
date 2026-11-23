/**
 * Stop state machine (arrival-alerts.md, "Stop order and stop events").
 *
 * A stop's state depends only on the bus's progress compared with the stop's
 * position along the shape, so stops change state in route order by
 * construction; being geographically close to a later stop (a loop, the same
 * street in both directions) does not matter. States only move forward;
 * `departed` and `passed` are final.
 *
 * `approaching` is not set here: it depends on each subscriber's trigger
 * (minutes or stops before) and belongs to the alert dispatcher (open point in
 * arrival-alerts.md).
 */
import type { Thresholds } from '../config.ts';
import type { PatternStop, StopProgress, StopState } from './types.ts';
import { isFinalStopState, stopStateRank } from './types.ts';

export interface StopInput {
  /** Accepted position along the route for this fix, or null. */
  m: number | null;
  /** Progress (monotonic). */
  progressM: number;
  speedKmh: number;
  at: Date;
  /** The bus reached the final stop and has now moved away from it. */
  leftFinalStop: boolean;
}

export interface StopChange {
  sequence: number;
  from: StopState;
  to: StopState;
}

/** Returns the new stop states (a new array) and the changes. */
export function updateStops(
  patternStops: readonly PatternStop[],
  current: readonly StopProgress[],
  input: StopInput,
  t: Thresholds,
): { stops: StopProgress[]; changes: StopChange[] } {
  const changes: StopChange[] = [];
  const last = patternStops[patternStops.length - 1];
  // Only the stop nearest the bus can be arrived at (stops closer together
  // than twice arrivedRadiusM would otherwise both arrive).
  let arriving: PatternStop | null = null;
  if (input.m !== null && input.speedKmh < t.arrivedMaxSpeedKmh) {
    const m = input.m;
    for (const ps of patternStops) {
      const sp = current.find((s) => s.sequence === ps.sequence);
      if (!sp || isFinalStopState(sp.state) || Math.abs(m - ps.distM) > t.arrivedRadiusM) continue;
      if (arriving === null || Math.abs(m - ps.distM) < Math.abs(m - arriving.distM)) arriving = ps;
    }
  }
  const stops = current.map((sp) => {
    const ps = patternStops.find((p) => p.sequence === sp.sequence);
    if (ps === undefined || isFinalStopState(sp.state)) return sp;
    const isLast = ps === last;
    const beyond = (margin: number): boolean => input.progressM > ps.distM + margin || (isLast && input.leftFinalStop);
    let next: StopProgress = sp;
    if (sp.state !== 'arrived') {
      if (beyond(t.passedMarginM)) {
        next = { ...sp, state: 'passed', passedAt: input.at };
      } else if (ps === arriving) {
        next = { ...sp, state: 'arrived', arrivedAt: input.at };
      }
    } else if ((input.m ?? input.progressM) > ps.distM + t.departedMarginM || (isLast && input.leftFinalStop)) {
      // Departed: where the bus is now, not the progress (one fix too far
      // ahead must not depart a bus still standing at the stop).
      next = { ...sp, state: 'departed', departedAt: input.at };
    }
    return next;
  });

  // Arriving at a stop closes every earlier stop, so events stay in route
  // order even for stops closer together than passedMarginM.
  let lastArrived = -1;
  stops.forEach((s, i) => {
    if (s.state === 'arrived' && s !== current[i]) lastArrived = i;
  });
  for (let i = 0; i < lastArrived; i++) {
    const s = stops[i];
    if (s === undefined || isFinalStopState(s.state)) continue;
    stops[i] = s.state === 'arrived' ? { ...s, state: 'departed', departedAt: input.at } : { ...s, state: 'passed', passedAt: input.at };
  }

  stops.forEach((s, i) => {
    const before = current[i];
    if (before === undefined || s === before) return;
    if (stopStateRank[s.state] <= stopStateRank[before.state]) throw new Error('stop state can only move forward');
    changes.push({ sequence: s.sequence, from: before.state, to: s.state });
  });
  return { stops, changes };
}

/** Highest stop sequence that was arrived at, departed or passed. */
export function lastConfirmedStop(stops: readonly StopProgress[]): number | null {
  let best: number | null = null;
  for (const s of stops) {
    if (s.state === 'arrived' || isFinalStopState(s.state)) best = best === null ? s.sequence : Math.max(best, s.sequence);
  }
  return best;
}

export function allStopsFinal(stops: readonly StopProgress[]): boolean {
  return stops.length > 0 && stops.every((s) => isFinalStopState(s.state));
}
