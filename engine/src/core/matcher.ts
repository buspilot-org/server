/**
 * Route matcher (engine.md, "Route matcher"; arrival-alerts.md, "Ambiguous
 * positions"): snaps a position onto the trip's shape inside a window around
 * the current progress, keeps progress monotonic, confirms large jumps and
 * tracks the off-route state.
 */
import type { Thresholds } from '../config.ts';
import type { Polyline, Projection, XY } from '../geo/plane.ts';
import { secondsBetween } from './time.ts';
import type { PendingJump, TripProgress } from './types.ts';

export type MatchState = Pick<TripProgress, 'progressM' | 'progressAt' | 'awaySince' | 'offRouteSince' | 'pendingJump'>;

export interface MatchResult extends MatchState {
  /** Accepted position along the route for this fix; null if not accepted (away, held or unconfirmed). */
  m: number | null;
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

function consistent(pending: PendingJump, m: number, at: Date, t: Thresholds): boolean {
  const dt = Math.max(0, secondsBetween(pending.at, at));
  return m >= pending.m - t.windowBehindM && m <= pending.m + dt * t.windowMaxSpeedMps + t.onRouteM;
}

export function matchPosition(
  shape: Polyline,
  prev: MatchState,
  xy: XY,
  at: Date,
  expectedM: number | null,
  t: Thresholds,
): MatchResult {
  const dt = prev.progressAt ? Math.max(0, secondsBetween(prev.progressAt, at)) : 0;
  const from = prev.progressM - t.windowBehindM;
  const to = prev.progressM + Math.max(t.windowAheadM, dt * t.windowMaxSpeedMps);
  const next: MatchResult = { ...prev, m: null };

  const candidates = shape.candidates(xy, from, to, t.onRouteM);
  if (candidates.length === 0) {
    const nearest = shape.nearest(xy, from, to);
    const d = nearest?.distance ?? Infinity;
    if (d > t.offRouteM) {
      next.awaySince = prev.awaySince ?? at;
      if (next.offRouteSince === null && secondsBetween(next.awaySince, at) >= t.offRouteAfterS) {
        next.offRouteSince = next.awaySince;
      }
      next.pendingJump = null;
    }
    // Between onRouteM and offRouteM: neither on nor away; hold everything.
    return next;
  }

  next.awaySince = null;
  const near = candidates.filter((c) => c.m - prev.progressM <= t.jumpM);
  const isJump = near.length === 0;
  const chosen = pickCandidate(isJump ? candidates : near, prev.progressM, expectedM, t.tieMarginM);
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
  next.pendingJump = pending && consistent(pending, chosen.m, at, t)
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
