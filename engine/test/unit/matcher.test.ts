import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds as t } from '../../src/config.ts';
import { matchPosition, pickCandidate, type MatchState } from '../../src/core/matcher.ts';
import { Polyline } from '../../src/geo/plane.ts';

// arrival-alerts.md example: the shared street. Out along y = 0, back along y = 40.
const shape = new Polyline([{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 40 }, { x: 0, y: 40 }]);
const start = new Date('2026-11-24T22:30:00Z');
const sec = (s: number): Date => new Date(start.getTime() + s * 1000);
const state = (progressM: number, extra: Partial<MatchState> = {}): MatchState => ({
  progressM, progressAt: start, awaySince: null, offRouteSince: null, pendingJump: null, ...extra,
});

describe('route matcher', () => {
  it('only matches inside the window ahead of the progress', () => {
    // A position on the outbound street at x = 800 also matches the return
    // street at m = 3040 + 2200 = 5240, which is outside the window.
    const r = matchPosition(shape, state(700), { x: 800, y: 20 }, sec(10), null, t);
    assert.equal(r.m, 800);
    assert.equal(r.progressM, 800);
  });

  it('ignores matches behind the bus', () => {
    // Progress on the return street; the outbound street is behind.
    // x = 1950 is m = 1950 outbound (behind) and m = 3040 + 1050 = 4090 on the way back.
    const r = matchPosition(shape, state(4000), { x: 1950, y: 15 }, sec(10), null, t);
    assert.ok(r.m !== null && Math.abs(r.m - 4090) < 1, String(r.m));
  });

  it('progress never goes back (GPS drift while standing)', () => {
    const r = matchPosition(shape, state(800), { x: 780, y: 0 }, sec(10), null, t);
    assert.equal(r.m, 780);
    assert.equal(r.progressM, 800);
  });

  it('a large jump needs three consistent positions', () => {
    let s: MatchState = state(1500);
    const at = [2900, 2930, 2960];
    const res = at.map((x, i) => {
      const r = matchPosition(shape, s, { x, y: 0 }, sec(60 + i * 5), null, t);
      s = r;
      return r;
    });
    assert.equal(res[0]?.m, null);
    assert.equal(res[1]?.m, null);
    assert.equal(res[2]?.m, 2960);
    assert.equal(s.progressM, 2960);
  });

  it('an inconsistent position restarts the jump confirmation', () => {
    let s: MatchState = state(1500);
    s = matchPosition(shape, s, { x: 2900, y: 0 }, sec(5), null, t);
    s = matchPosition(shape, s, { x: 2300, y: 0 }, sec(10), null, t);
    assert.equal(s.pendingJump?.count, 1);
  });

  it('becomes off route after more than 60 s beyond 100 m, keeping progress', () => {
    let s: MatchState = state(1000);
    s = matchPosition(shape, s, { x: 1000, y: -300 }, sec(10), null, t);
    assert.equal(s.offRouteSince, null);
    assert.ok(s.awaySince);
    s = matchPosition(shape, s, { x: 1000, y: -300 }, sec(75), null, t);
    assert.deepEqual(s.offRouteSince, sec(10));
    assert.equal(s.progressM, 1000);
  });

  it('back on route after three positions on the route', () => {
    let s: MatchState = state(1000, { offRouteSince: sec(0), awaySince: sec(0) });
    for (const [i, x] of [1100, 1120, 1140].entries()) {
      s = matchPosition(shape, s, { x, y: 0 }, sec(100 + i * 5), null, t);
      assert.equal(s.offRouteSince === null, i === 2);
    }
    assert.equal(s.progressM, 1140);
  });

  it('between 50 m and 100 m from the route: hold, neither on nor away', () => {
    const r = matchPosition(shape, state(1000), { x: 1000, y: -70 }, sec(10), null, t);
    assert.equal(r.m, null);
    assert.equal(r.awaySince, null);
  });

  it('the window grows with the time since the last accepted position', () => {
    const r = matchPosition(shape, state(0), { x: 2400, y: 0 }, sec(120), null, { ...t, jumpM: 5000 });
    assert.equal(r.m, 2400);
  });

  it('ties are broken by the schedule', () => {
    const cands = [{ m: 1000, distance: 10 }, { m: 1060, distance: 5 }];
    assert.equal(pickCandidate(cands, 950, null, 100)?.m, 1000);
    assert.equal(pickCandidate(cands, 950, 1070, 100)?.m, 1060);
    assert.equal(pickCandidate(cands, 950, 1070, 50)?.m, 1000, 'not a tie');
  });
});
