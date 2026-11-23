/**
 * Route matcher (engine.md, "Route matcher"; arrival-alerts.md, "Ambiguous
 * positions"): snaps a position onto the trip's shape inside a window around
 * the current progress, keeps progress monotonic, confirms large jumps and
 * tracks the off-route state.
 *
 * Where the route passes the same place twice (a loop, both directions of a
 * street, the two sides of a turn), a wrong match on the later pass would
 * fire later stops too early (the German School problem). Rules:
 * - passes are told apart geometrically (Polyline.candidates);
 * - the GPS course must match the direction of the route when moving;
 * - the match nearest ahead of the progress wins (near-ties: the schedule);
 *   a match continuing a pending confirmation wins instead if it is at
 *   least as close to the fix;
 * - a fix is accepted at once only if it is continuous: no further ahead
 *   than onRouteM plus what the bus can drive at jumpSpeedKmh since the
 *   previous fix, and not ambiguous (no earlier pass of the route within
 *   offRouteM, looking back to ambiguityBehindM behind the progress);
 * - otherwise it needs jumpConfirmFixes fixes that continue each other, all
 *   but one moving along the new section (by course, or by the movement
 *   since the previous fix), together at least jumpConfirmMinAdvanceM
 *   forward. A standing bus confirms nothing, however long it stands. The
 *   held fixes are then replayed into the stop state machine, so a stop
 *   dwell during the hold still counts as arrived.
 */
import type { Thresholds } from '../config.ts';
import type { Polyline, Projection, XY } from '../geo/plane.ts';
import { bearingDifference, distance } from '../geo/plane.ts';
import { secondsBetween } from './time.ts';
import type { HeldFix, TripProgress } from './types.ts';

export type MatchState = Pick<TripProgress, 'progressM' | 'progressAt' | 'lastFixAt' | 'lastFixXY' | 'awaySince' | 'offRouteSince' | 'pendingJump'>;

export interface MatchResult extends MatchState {
  /** Accepted position along the route for this fix; null if not accepted (away, held or unconfirmed). */
  m: number | null;
  /** Earlier held fixes confirmed together with this one, in order. */
  confirmedHeld: HeldFix[];
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

/** Below this, the movement between two fixes says nothing about direction (m). */
const MIN_CHORD_M = 5;
/** At most this many held fixes are kept for replay. */
const MAX_HELD = 30;

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
  const next: MatchResult = { ...prev, lastFixAt: at, lastFixXY: xy, m: null, confirmedHeld: [] };

  const fits = (bearing: number, direction: number): boolean => bearingDifference(bearing, direction) <= t.headingToleranceDeg;
  const fitsDirection = (c: Projection, direction: number): boolean =>
    fits(c.bearing, direction) || (c.otherBearing !== undefined && fits(c.otherBearing, direction));
  const course = fix.speedKmh >= t.headingCheckMinSpeedKmh ? fix.course : null;
  const headingOk = (c: Projection): boolean => course === null || fitsDirection(c, course);
  // Direction of movement since the previous fix, when it says something.
  const chord = prev.lastFixXY !== null && distance(prev.lastFixXY, xy) >= MIN_CHORD_M
    ? ((Math.atan2(xy.x - prev.lastFixXY.x, xy.y - prev.lastFixXY.y) * 180) / Math.PI + 360) % 360
    : null;

  // Passes from ambiguityBehindM behind the progress to the end of the
  // window. A point clamped to the start of that range is not a pass (its
  // nearest point lies further behind, where the bus cannot be).
  const searchFrom = Math.max(0, prev.progressM - t.ambiguityBehindM);
  const all = shape.candidates(xy, searchFrom, to, t.offRouteM).filter((c) => searchFrom <= 0 || c.m > searchFrom + 0.5);
  const wide = all.filter((c) => c.m >= from - 0.5);
  const onRoute = wide.filter((c) => c.distance <= t.onRouteM && headingOk(c));

  // A match behind the window: the bus is at (or GPS puts it a little
  // behind) its progress on the current pass, e.g. after one fix too far
  // ahead, or reversing. On route, but it never advances progress; it beats
  // a later pass that is not closer. No heading check (reversing).
  const behindMatch = all
    .filter((c) => c.m < from - 0.5 && c.distance <= t.onRouteM)
    .sort((a, b) => a.distance - b.distance)[0];
  const nearestAhead = [...onRoute].sort((a, b) => a.distance - b.distance)[0];
  if (behindMatch !== undefined && (nearestAhead === undefined || behindMatch.distance <= nearestAhead.distance)) {
    next.awaySince = null;
    next.m = behindMatch.m;
    next.pendingJump = null;
    return next;
  }

  if (onRoute.length === 0) {
    if (all.length === 0) {
      next.awaySince = prev.awaySince ?? at;
      if (next.offRouteSince === null && secondsBetween(next.awaySince, at) >= t.offRouteAfterS) {
        next.offRouteSince = next.awaySince;
      }
      const pending = prev.pendingJump;
      if (pending !== null && shape.length - pending.m <= t.arrivedRadiusM) {
        // Held at the end of the route (a final stop right after a turn) and
        // now leaving it: there is no later pass to confuse it with.
        next.progressM = Math.max(prev.progressM, pending.m);
        next.progressAt = pending.at;
        next.confirmedHeld = pending.held;
      }
      next.pendingJump = null;
    }
    // Within offRouteM but not on route (or driving against the route): hold.
    return next;
  }
  next.awaySince = null;

  const pending = prev.pendingJump;
  const continuesPending = (c: Projection): boolean => pending !== null
    && c.m >= pending.m - t.windowBehindM
    && c.m <= pending.m + since(pending.at) * t.windowMaxSpeedMps + t.onRouteM;
  const ahead = pickCandidate(onRoute, prev.progressM, expectedM, t.tieMarginM);
  const continuing = onRoute.filter(continuesPending).sort((a, b) => a.distance - b.distance)[0];
  const chosen = continuing !== undefined && (ahead === null || continuing.distance <= ahead.distance) ? continuing : ahead;
  if (chosen === null) return next;

  const isJump = chosen.m - prev.progressM > t.onRouteM + (dtFix * t.jumpSpeedKmh) / 3.6;
  const ambiguous = all.some((c) => c.m < chosen.m - t.onRouteM);
  const offRoute = prev.offRouteSince !== null;

  if (!isJump && !ambiguous && !offRoute) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    // The bus has moved on from an ambiguous place along the pass it was
    // held on: those held fixes were right after all.
    if (pending !== null && chosen === continuing) next.confirmedHeld = pending.held;
    next.pendingJump = null;
    return next;
  }

  // Confirm first. Rejoining after off route needs fixes on the route
  // (standing is fine there, e.g. at the next stop; landing far ahead of the
  // held progress is expected after a detour); a jump or an ambiguous
  // position needs fixes moving forward along the new section.
  const mustAdvance = ambiguous || (isJump && !offRoute);
  const needed = Math.max(offRoute ? t.backOnRouteFixes : 0, mustAdvance ? t.jumpConfirmFixes : 0);
  const direction = course ?? chord;
  const moving = fix.speedKmh >= t.arrivedMaxSpeedKmh && direction !== null && fitsDirection(chosen, direction) ? 1 : 0;
  const heldFix: HeldFix = { m: chosen.m, speedKmh: fix.speedKmh, at };
  next.pendingJump = pending !== null && chosen === continuing
    ? {
        firstM: pending.firstM,
        m: Math.max(pending.m, chosen.m),
        count: pending.count + 1,
        moving: pending.moving + moving,
        at,
        held: [...pending.held, heldFix].slice(-MAX_HELD),
      }
    : { firstM: chosen.m, m: chosen.m, count: 1, moving, at, held: [heldFix] };
  const p = next.pendingJump;
  // Near the end of the route there may be less line left than the advance.
  const advanceNeeded = Math.min(t.jumpConfirmMinAdvanceM, Math.max(0, shape.length - p.firstM - 1));
  const confirmed = p.count >= needed
    && (!mustAdvance || (chosen.m - p.firstM >= advanceNeeded && p.moving >= needed - 1));
  if (confirmed) {
    next.m = chosen.m;
    next.progressM = Math.max(prev.progressM, chosen.m);
    next.progressAt = at;
    next.confirmedHeld = p.held.slice(0, -1);
    next.pendingJump = null;
    next.offRouteSince = null;
  }
  return next;
}
