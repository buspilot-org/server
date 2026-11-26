/**
 * Which alerts are due for one subscription (pure; arrival-alerts.md, "Rule",
 * "Fire each alert exactly once" and "Decisions (2026-11-26)").
 *
 * Evaluated on the trip's state after each processed position, so the rules
 * hold by construction:
 * - *Passed is checked before triggers*: states are final before triggers
 *   are looked at, and a departed or passed stop never gets an approaching
 *   alert.
 * - *Hold while stale or off route*: nothing is due; the next fresh
 *   position on the route evaluates again ("held alerts are sent if still
 *   due").
 * - *Missed approaching*: a stop that is `arrived` gets "the bus is at your
 *   stop" (kind `approaching`, so it is sent only if no approaching alert
 *   went out).
 * - Only the subscribed `stop_sequence` counts: on a loop that serves a
 *   stop twice, the other visit never alerts.
 *
 * Whether an alert was already sent is not decided here: the dispatcher
 * claims each one in `alert_delivery` (exactly once).
 */
import type { StopProgress, TripStatus } from '../core/types.ts';
import { isFinalStopState } from '../core/types.ts';
import type { AlertVariant, Subscription } from './types.ts';

export interface DueConfig {
  /** No position for longer than this → stale, alerts held (s). */
  staleAfterS: number;
  /** A `passed` alert is only sent this long after the bus passed (restarts, late subscriptions) (s). */
  passedMaxAgeS: number;
  /** `delayed` once the ETA at the subscribed stop is this much later than scheduled (s); 0 = off. */
  delayThresholdS: number;
}

export interface DueInput {
  sub: Subscription;
  /** The trip's stop sequences in order (pattern or planned stops). */
  sequences: readonly number[];
  tripStatus: TripStatus;
  stops: readonly StopProgress[];
  etas: ReadonlyMap<number, Date>;
  /** Scheduled (or planned) arrival at the subscribed stop; null: none, so no `delayed`. */
  scheduledArrival: Date | null;
  offRoute: boolean;
  fixAt: Date;
  now: Date;
  /** An approaching (or arrived) alert for this subscription, trip and stop is claimed already. */
  approachingClaimed: boolean;
}

export interface DueAlert {
  variant: AlertVariant;
  /** ETA at the subscribed stop, if known. */
  eta: Date | null;
  /** Delay at the subscribed stop (s), for `delayed`. */
  delayS: number | null;
}

export function isMuted(sub: Subscription, now: Date): boolean {
  return sub.mutedUntil !== null && sub.mutedUntil > now;
}

/** At most one alert per call; the next position evaluates again. */
export function dueAlert(input: DueInput, cfg: DueConfig): DueAlert | null {
  const { sub, now } = input;
  if (isMuted(sub, now)) return null;
  if (input.offRoute || (now.getTime() - input.fixAt.getTime()) / 1000 > cfg.staleAfterS) return null;
  const stop = input.stops.find((s) => s.sequence === sub.stopSequence);
  if (stop === undefined) return null;

  if (stop.state === 'passed') {
    const at = stop.passedAt;
    if (!sub.notifyPassed || at === null || at < sub.createdAt) return null;
    if ((now.getTime() - at.getTime()) / 1000 > cfg.passedMaxAgeS) return null;
    return { variant: 'passed', eta: null, delayS: null };
  }
  if (stop.state === 'departed') return null;
  if (input.tripStatus !== 'active') return null;
  if (stop.state === 'arrived') return { variant: 'arrived', eta: null, delayS: null };

  const eta = input.etas.get(sub.stopSequence) ?? null;
  if (triggerReached(input, eta)) return { variant: 'approaching', eta, delayS: null };

  if (cfg.delayThresholdS > 0 && eta !== null && input.scheduledArrival !== null && !input.approachingClaimed) {
    const delayS = (eta.getTime() - input.scheduledArrival.getTime()) / 1000;
    if (delayS >= cfg.delayThresholdS) return { variant: 'delayed', eta, delayS };
  }
  return null;
}

/**
 * "N minutes before": the ETA is N minutes away or less (inclusive).
 * "N stops before": the stop N places earlier in the trip is departed or
 * passed. Near the start of the trip (fewer than N stops before), the first
 * stop is the trigger (assumption; open point in arrival-alerts.md). The
 * first stop itself has no stop before it: it only gets "the bus is at your
 * stop".
 */
export function triggerReached(input: Pick<DueInput, 'sub' | 'sequences' | 'stops' | 'now'>, eta: Date | null): boolean {
  const { sub } = input;
  if (sub.trigger === 'minutes') {
    return eta !== null && eta.getTime() - input.now.getTime() <= sub.triggerValue * 60_000;
  }
  const idx = input.sequences.indexOf(sub.stopSequence);
  if (idx <= 0) return false;
  const trigger = input.sequences[Math.max(0, idx - sub.triggerValue)];
  const state = input.stops.find((s) => s.sequence === trigger)?.state;
  return state !== undefined && isFinalStopState(state);
}
