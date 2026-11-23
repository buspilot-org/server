/** Stop state machine, with the examples from arrival-alerts.md. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds as t } from '../../src/config.ts';
import { allStopsFinal, lastConfirmedStop, updateStops, type StopInput } from '../../src/core/stops.ts';
import type { PatternStop, StopProgress } from '../../src/core/types.ts';

// Example route A: stops at 0, 800, 1,600, 2,400, 3,100, 4,000 m.
const stops: PatternStop[] = [0, 800, 1600, 2400, 3100, 4000].map((distM, i) => ({
  sequence: i + 1, distM, arrivalOffsetS: i * 180, departureOffsetS: i * 180, point: { x: distM, y: 0 },
}));
const fresh = (): StopProgress[] => stops.map((s) => ({ sequence: s.sequence, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null }));
const at = new Date('2026-11-24T22:39:00Z');
const input = (progressM: number, speedKmh: number, m: number | null = progressM): StopInput => ({ m, progressM, speedKmh, at, leftFinalStop: false });

function run(seq: [number, number][], start = fresh()): StopProgress[] {
  let cur = start;
  for (const [p, v] of seq) cur = updateStops(stops, cur, input(p, v), t).stops;
  return cur;
}
const stateOf = (s: StopProgress[], seq: number): string | undefined => s.find((x) => x.sequence === seq)?.state;

describe('stop state machine', () => {
  it('a normal stop: arrived 15 m before, slow; departed beyond +20 m', () => {
    let s = run([[300, 30], [1300, 30], [1800, 30]]);
    assert.equal(stateOf(s, 4), 'upcoming');
    s = run([[2385, 3]], s);
    assert.equal(stateOf(s, 4), 'arrived');
    s = run([[2460, 20]], s);
    assert.equal(stateOf(s, 4), 'departed');
  });

  it('passed without stopping: too fast for arrived, passed beyond +50 m', () => {
    let s = run([[1580, 35]]);
    assert.equal(stateOf(s, 3), 'upcoming', '20 m away but too fast');
    s = run([[1620, 35]], s);
    assert.equal(stateOf(s, 3), 'upcoming', 'inside the 50 m margin');
    s = run([[1660, 35]], s);
    assert.equal(stateOf(s, 3), 'passed');
    assert.equal(s.find((x) => x.sequence === 3)?.arrivedAt, null);
  });

  it('a gap: one update passes several stops', () => {
    const s = run([[700, 30], [3200, 30]]);
    // arrival-alerts.md: no positions between 1,400 and 3,200 m → stops 3, 4 and 5 are passed in the same update.
    assert.deepEqual([2, 3, 4, 5, 6].map((q) => stateOf(s, q)), ['passed', 'passed', 'passed', 'passed', 'upcoming']);
  });

  it('arrived is measured along the route, not on the map', () => {
    // Standing at stop 2 (800 m): stop 5 may be 40 m away on the map, but it is 2,300 m along the route.
    const s = run([[800, 0]]);
    assert.equal(stateOf(s, 2), 'arrived');
    assert.equal(stateOf(s, 5), 'upcoming');
  });

  it('needs an accepted position for arrived', () => {
    const r = updateStops(stops, fresh(), input(800, 0, null), t);
    assert.equal(stateOf(r.stops, 2), 'upcoming');
  });

  it('final states do not change; an arrived stop is departed, never passed', () => {
    let s = run([[800, 0], [900, 30]]);
    assert.equal(stateOf(s, 2), 'departed');
    s = run([[5000, 30]], s);
    assert.equal(stateOf(s, 2), 'departed');
    const r = updateStops(stops, s, input(5000, 30), t);
    assert.deepEqual(r.changes, []);
  });

  it('the final stop: departed once the bus has left it', () => {
    let s = run([[3990, 0]]);
    assert.equal(stateOf(s, 6), 'arrived');
    s = updateStops(stops, s, { ...input(4000, 10, null), leftFinalStop: true }, t).stops;
    assert.equal(stateOf(s, 6), 'departed');
    assert.ok(allStopsFinal(s));
  });

  it('reports changes and the last confirmed stop', () => {
    const r = updateStops(stops, fresh(), input(1660, 35), t);
    assert.deepEqual(r.changes.map((c) => `${c.sequence}:${c.to}`), ['1:passed', '2:passed', '3:passed']);
    assert.equal(lastConfirmedStop(r.stops), 3);
    assert.equal(lastConfirmedStop(fresh()), null);
  });
});
