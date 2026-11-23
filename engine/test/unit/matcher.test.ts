import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds as t } from '../../src/config.ts';
import { matchPosition, pickCandidate, type MatchState } from '../../src/core/matcher.ts';
import { Polyline, type XY } from '../../src/geo/plane.ts';

// arrival-alerts.md example: the shared street. Out along y = 0 (east, 90°),
// back along y = 40 (west, 270°). x on the way back is at m = 3040 + (3000 − x).
const shape = new Polyline([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 40 }, { x: 0, y: 40 }]);
const start = new Date('2026-11-24T22:30:00Z');
const sec = (s: number): Date => new Date(start.getTime() + s * 1000);
const state = (progressM: number, extra: Partial<MatchState> = {}): MatchState => ({
  progressM, progressAt: start, awaySince: null, offRouteSince: null, pendingJump: null, ...extra,
});
const fix = (xy: XY, s: number, speedKmh = 30, course: number | null = null) => ({ xy, at: sec(s), speedKmh, course });

function run(s0: MatchState, fixes: ReturnType<typeof fix>[]): { s: MatchState; ms: (number | null)[] } {
  let s = s0;
  const ms: (number | null)[] = [];
  for (const f of fixes) {
    const r = matchPosition(shape, s, f, null, t);
    ms.push(r.m);
    s = r;
  }
  return { s, ms };
}

describe('route matcher', () => {
  it('only matches inside the window ahead of the progress', () => {
    // x = 800 on the way out; the return street (m = 5240) is outside the window.
    const r = matchPosition(shape, state(700), fix({ x: 800, y: 20 }, 10), null, t);
    assert.equal(r.m, 800);
    assert.equal(r.progressM, 800);
  });

  it('ignores matches behind the bus', () => {
    // x = 1950 is m = 1950 outbound (behind) and m = 4090 on the way back.
    const r = matchPosition(shape, state(4000), fix({ x: 1950, y: 15 }, 10), null, t);
    assert.ok(r.m !== null && Math.abs(r.m - 4090) < 1, String(r.m));
  });

  it('progress never goes back (GPS drift while standing)', () => {
    const r = matchPosition(shape, state(800), fix({ x: 780, y: 0 }, 10, 0), null, t);
    assert.equal(r.m, 780);
    assert.equal(r.progressM, 800);
  });

  it('a large jump needs three positions moving forward on the new section', () => {
    const { s, ms } = run(state(1500), [fix({ x: 2900, y: 0 }, 5), fix({ x: 2930, y: 0 }, 10), fix({ x: 2960, y: 0 }, 15)]);
    assert.deepEqual(ms, [null, null, 2960]);
    assert.equal(s.progressM, 2960);
  });

  it('a standing bus never confirms a jump', () => {
    const { s, ms } = run(state(1500), [0, 5, 10, 15, 20].map((i) => fix({ x: 2900, y: 0 }, 5 + i, 0)));
    assert.deepEqual(ms, [null, null, null, null, null]);
    assert.equal(s.progressM, 1500);
  });

  it('an inconsistent position restarts the jump confirmation', () => {
    const { s } = run(state(1500), [fix({ x: 2900, y: 0 }, 5), fix({ x: 2300, y: 0 }, 10)]);
    assert.equal(s.pendingJump?.count, 1);
  });

  it('a move the bus can have driven since the last fix is no jump (trackers reporting every minute)', () => {
    // 750 m in 60 s = 45 km/h: below jumpSpeedKmh, accepted at once.
    const r = matchPosition(shape, state(1000), fix({ x: 1750, y: 0 }, 60, 45), null, t);
    assert.equal(r.m, 1750);
  });

  it('German School: biased GPS near the return street does not move a slow bus onto it', () => {
    // The bus waits on the outbound street at x = 400 (m = 400); GPS puts it
    // 55 m from its street and 15 m from the return street (stop 3's side).
    const { s, ms } = run(state(400), [0, 5, 10, 15, 20, 25].map((i) => fix({ x: 400, y: 55 }, 5 + i, 0)));
    assert.deepEqual(ms, Array(6).fill(null));
    assert.equal(s.progressM, 400);
    // Same while creeping forward slowly.
    const slow = run(state(400), [0, 1, 2, 3, 4].map((i) => fix({ x: 400 + i * 4, y: 55 }, 5 + i * 5, 3)));
    assert.equal(slow.s.progressM, 400);
  });

  it('the GPS course must match the direction of the route', () => {
    // Driving west at x = 1200 with progress 1000: the outbound street (east)
    // is 0 m away but the wrong direction; the return street is the match.
    const westbound = matchPosition(shape, state(3900, { progressAt: sec(0) }), fix({ x: 1950, y: 20 }, 5, 30, 270), null, t);
    assert.ok(westbound.m !== null && Math.abs(westbound.m - 4090) < 1);
    const wrongWay = matchPosition(shape, state(1000), fix({ x: 1100, y: 0 }, 5, 30, 270), null, t);
    assert.equal(wrongWay.m, null, 'driving against the route: hold');
    const slowNoCheck = matchPosition(shape, state(1000), fix({ x: 1010, y: 0 }, 5, 3, 270), null, t);
    assert.equal(slowNoCheck.m, 1010, 'no heading check when (nearly) standing');
  });

  it('becomes off route after more than 60 s beyond 100 m, keeping progress', () => {
    const { s } = run(state(1000), [fix({ x: 1000, y: -300 }, 10), fix({ x: 1000, y: -300 }, 75)]);
    assert.deepEqual(s.offRouteSince, sec(10));
    assert.equal(s.progressM, 1000);
    const early = run(state(1000), [fix({ x: 1000, y: -300 }, 10)]);
    assert.equal(early.s.offRouteSince, null);
    assert.ok(early.s.awaySince);
  });

  it('back on route after three positions on the route', () => {
    let s: MatchState = state(1000, { offRouteSince: sec(0), awaySince: sec(0) });
    for (const [i, x] of [1100, 1120, 1140].entries()) {
      s = matchPosition(shape, s, fix({ x, y: 0 }, 100 + i * 5), null, t);
      assert.equal(s.offRouteSince === null, i === 2);
    }
    assert.equal(s.progressM, 1140);
  });

  it('between 50 m and 100 m from the route: hold, neither on nor away', () => {
    const r = matchPosition(shape, state(1000), fix({ x: 1000, y: -70 }, 10), null, t);
    assert.equal(r.m, null);
    assert.equal(r.awaySince, null);
  });

  it('the window grows with the time since the last accepted position', () => {
    const r = matchPosition(shape, state(0), fix({ x: 2400, y: 0 }, 180), null, t);
    assert.equal(r.m, 2400);
  });

  it('ties are broken by the schedule', () => {
    const cands = [{ m: 1000, distance: 10, bearing: 90 }, { m: 1060, distance: 5, bearing: 270 }];
    assert.equal(pickCandidate(cands, 950, null, 100)?.m, 1000);
    assert.equal(pickCandidate(cands, 950, 1070, 100)?.m, 1060);
    assert.equal(pickCandidate(cands, 950, 1070, 50)?.m, 1000, 'not a tie');
  });
});
