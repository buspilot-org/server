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
  const stops = current.map((sp) => {
    const ps = patternStops.find((p) => p.sequence === sp.sequence);
    if (ps === undefined || isFinalStopState(sp.state)) return sp;
    const isLast = ps === last;
    const beyond = (margin: number): boolean => input.progressM > ps.distM + margin || (isLast && input.leftFinalStop);
    let next: StopProgress = sp;
    if (sp.state !== 'arrived') {
      if (beyond(t.passedMarginM)) {
        next = { ...sp, state: 'passed', passedAt: input.at };
      } else if (
        input.m !== null &&
        Math.abs(input.m - ps.distM) <= t.arrivedRadiusM &&
        input.speedKmh < t.arrivedMaxSpeedKmh
      ) {
        next = { ...sp, state: 'arrived', arrivedAt: input.at };
      }
    } else if (beyond(t.departedMarginM)) {
      next = { ...sp, state: 'departed', departedAt: input.at };
    }
    if (next !== sp) {
      if (stopStateRank[next.state] <= stopStateRank[sp.state]) throw new Error('stop state can only move forward');
      changes.push({ sequence: sp.sequence, from: sp.state, to: next.state });
    }
    return next;
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
