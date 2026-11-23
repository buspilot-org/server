/**
 * Route matcher (engine.md, "Route matcher"; arrival-alerts.md, "Ambiguous
 * positions"): snaps a position onto the trip's shape inside a window around
 * the current progress, keeps progress monotonic, confirms large jumps and
 * tracks the off-route state.
 *
 * Where the route passes the same place twice (a loop, both directions of a
 * street), a wrong match on the later pass would fire later stops too early
 * (the German School problem). Guards:
 * - the GPS course must match the direction of the route when moving;
 * - the match nearest ahead of the progress wins;
 * - a position that also lies within offRouteM of an earlier pass is
 *   ambiguous: moving onto the later pass needs jumpConfirmFixes fixes that
 *   together move forward along it (a standing bus confirms nothing), however
 *   long the bus has been standing;
 * - a forward move larger than jumpM and than the bus can have driven since
 *   the previous fix (at jumpSpeedKmh) is a jump and needs the same
 *   confirmation.
 */
import type { Thresholds } from '../config.ts';
import type { Polyline, Projection, XY } from '../geo/plane.ts';
import { bearingDifference } from '../geo/plane.ts';
import { secondsBetween } from './time.ts';
import type { TripProgress } from './types.ts';

export type MatchState = Pick<TripProgress, 'progressM' | 'progressAt' | 'lastFixAt' | 'awaySince' | 'offRouteSince' | 'pendingJump'>;

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

export function matchPosition(
  shape: Polyline,
  prev: MatchState,
  fix: Fix,
  expectedM: number | null,
  t: Thresholds,
): MatchResult {
  const { xy, at } = fix;
  const since = (d: Date | null): number => (d ? Math.max(0, secondsBetween(d, at)) : 0);
  const dtAccepted = since(prev.progressAt);
  const dtFix = since(prev.lastFixAt ?? prev.progressAt);
  const from = prev.progressM - t.windowBehindM;
  const to = prev.progressM + Math.max(t.windowAheadM, dtAccepted * t.windowMaxSpeedMps);
  const next: MatchResult = { ...prev, lastFixAt: at, m: null };

  const course = fix.speedKmh >= t.headingCheckMinSpeedKmh ? fix.course : null;
  const headingOk = (c: Projection): boolean =>
    course === null
    || bearingDifference(c.bearing, course) <= t.headingToleranceDeg
    || (c.otherBearing !== undefined && bearingDifference(c.otherBearing, course) <= t.headingToleranceDeg);

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
  const jumpLimit = Math.max(t.jumpM, (dtFix * t.jumpSpeedKmh) / 3.6);
  const near = onRoute.filter((c) => c.m - prev.progressM <= jumpLimit);
  const isJump = near.length === 0;
  const chosen = pickCandidate(isJump ? onRoute : near, prev.progressM, expectedM, t.tieMarginM);
  if (chosen === null) return next;
  // An earlier pass of the route is also close: the position is ambiguous.
  const ambiguous = wide.some((c) => c.m < chosen.m - t.onRouteM);
  const offRoute = prev.offRouteSince !== null;

  if (!isJump && !ambiguous && !offRoute) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    next.pendingJump = null;
    return next;
  }

  // Confirm first: a jump or an ambiguous position needs fixes moving
  // forward on the new section; rejoining after off route needs fixes on the
  // route (standing is fine there, e.g. at the next stop).
  const mustAdvance = isJump || ambiguous;
  const needed = Math.max(offRoute ? t.backOnRouteFixes : 0, mustAdvance ? t.jumpConfirmFixes : 0);
  const pending = prev.pendingJump;
  const continues = pending !== null
    && chosen.m >= pending.m - t.windowBehindM
    && chosen.m <= pending.m + since(pending.at) * t.windowMaxSpeedMps + t.onRouteM;
  next.pendingJump = continues
    ? { firstM: pending.firstM, m: Math.max(pending.m, chosen.m), count: pending.count + 1, at }
    : { firstM: chosen.m, m: chosen.m, count: 1, at };
  const advanced = chosen.m - next.pendingJump.firstM >= t.jumpConfirmMinAdvanceM;
  if (next.pendingJump.count >= needed && (!mustAdvance || advanced)) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    next.pendingJump = null;
    next.offRouteSince = null;
  }
  return next;
}
