/**
 * Route matcher (engine.md, "Route matcher"; arrival-alerts.md, "Ambiguous
 * positions"): snaps a position onto the trip's shape inside a window around
 * the current progress, keeps progress monotonic, confirms large jumps and
 * tracks the off-route state.
 *
 * Where the route passes the same place twice (a loop, both directions of a
 * street), a wrong match on the later pass would fire later stops too early
 * (the German School problem). Three things guard against it:
 * - the GPS course must match the direction of the route when moving;
 * - a forward move that is more than the bus can plausibly have driven since
 *   the last accepted fix is a jump, accepted only after several fixes that
 *   keep moving forward on that section (a standing bus confirms nothing);
 * - no jump is counted while a nearer pass is still within offRouteM (the
 *   position is ambiguous then: hold).
 */
import type { Thresholds } from '../config.ts';
import type { Polyline, Projection, XY } from '../geo/plane.ts';
import { bearingDifference } from '../geo/plane.ts';
import { secondsBetween } from './time.ts';
import type { PendingJump, TripProgress } from './types.ts';

export type MatchState = Pick<TripProgress, 'progressM' | 'progressAt' | 'awaySince' | 'offRouteSince' | 'pendingJump'>;

export interface MatchResult extends MatchState {
  /** Accepted position along the route for this fix; null if not accepted (away, held or unconfirmed). */
  m: number | null;
}

export interface Fix {
  xy: XY;
  at: Date;
  speedKmh: number;
  /** GPS course (degrees), or null. */
  course: number | null;
}

/** Pick among candidates: nearest ahead of the progress; near-ties broken by the schedule. */
export function pickCandidate(
  candidates: readonly Projection[],
  progressM: number,
  expectedM: number | null,
  tieMarginM: number,
): Projection | null {
  const sorted = [...candidates].sort((a, b) => (a.m - progressM) - (b.m - progressM));
  const first = sorted[0];
  if (first === undefined) return null;
  if (expectedM === null) return first;
  const ties = sorted.filter((c) => c.m - first.m < tieMarginM);
  if (ties.length < 2) return first;
  return ties.reduce((best, c) => (Math.abs(c.m - expectedM) < Math.abs(best.m - expectedM) ? c : best));
}

/**
 * Whether a fix continues a pending confirmation. Jump confirmations must move
 * forward (a standing bus with biased GPS confirms nothing); rejoining the
 * route nearby after being off route may stand still (e.g. at the next stop).
 */
function consistent(pending: PendingJump, m: number, at: Date, isJump: boolean, t: Thresholds): boolean {
  const dt = Math.max(0, secondsBetween(pending.at, at));
  const minAdvance = isJump ? t.jumpConfirmMinAdvanceM : -t.windowBehindM;
  return m >= pending.m + minAdvance && m <= pending.m + dt * t.windowMaxSpeedMps + t.onRouteM;
}

export function matchPosition(
  shape: Polyline,
  prev: MatchState,
  fix: Fix,
  expectedM: number | null,
  t: Thresholds,
): MatchResult {
  const { xy, at } = fix;
  const dt = prev.progressAt ? Math.max(0, secondsBetween(prev.progressAt, at)) : 0;
  const from = prev.progressM - t.windowBehindM;
  const to = prev.progressM + Math.max(t.windowAheadM, dt * t.windowMaxSpeedMps);
  const next: MatchResult = { ...prev, m: null };

  const headingKnown = fix.course !== null && fix.speedKmh >= t.headingCheckMinSpeedKmh;
  const headingOk = (c: Projection): boolean =>
    !headingKnown || bearingDifference(c.bearing, fix.course ?? 0) <= t.headingToleranceDeg;

  const wide = shape.candidates(xy, from, to, t.offRouteM, t.onRouteM);
  const onRoute = wide.filter((c) => c.distance <= t.onRouteM && headingOk(c));
  if (onRoute.length === 0) {
    if (wide.length === 0) {
      next.awaySince = prev.awaySince ?? at;
      if (next.offRouteSince === null && secondsBetween(next.awaySince, at) >= t.offRouteAfterS) {
        next.offRouteSince = next.awaySince;
      }
      next.pendingJump = null;
    }
    // Within offRouteM but not on route (or driving against the route): hold.
    return next;
  }

  next.awaySince = null;
  const jumpLimit = Math.max(t.jumpM, (dt * t.jumpSpeedKmh) / 3.6);
  const near = onRoute.filter((c) => c.m - prev.progressM <= jumpLimit);
  const isJump = near.length === 0;
  if (isJump && wide.some((c) => c.m - prev.progressM <= jumpLimit)) {
    // A nearer pass is still close (50–100 m, or the course does not fit it):
    // too ambiguous to count towards a jump.
    return next;
  }
  const chosen = pickCandidate(isJump ? onRoute : near, prev.progressM, expectedM, t.tieMarginM);
  if (chosen === null) return next;

  const offRoute = prev.offRouteSince !== null;
  if (!isJump && !offRoute) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    next.pendingJump = null;
    return next;
  }

  // A jump, or back on the route after being off route: confirm first.
  const needed = offRoute ? Math.max(t.backOnRouteFixes, isJump ? t.jumpConfirmFixes : 0) : t.jumpConfirmFixes;
  const pending = prev.pendingJump;
  next.pendingJump = pending && consistent(pending, chosen.m, at, isJump, t)
    ? { m: chosen.m, count: pending.count + 1, at }
    : { m: chosen.m, count: 1, at };
  if (next.pendingJump.count >= needed) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    next.pendingJump = null;
    next.offRouteSince = null;
  }
  return next;
}
