import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DueConfig, DueInput } from '../../src/alerts/due.ts';
import { dueAlert } from '../../src/alerts/due.ts';
import type { Pattern, StopProgress, StopState } from '../../src/core/types.ts';
import { Polyline } from '../../src/geo/plane.ts';
import { subscription } from '../replay/harness.ts';

const NOW = new Date('2026-11-24T07:35:00+09:00');
const cfg: DueConfig = { staleAfterS: 120, passedMaxAgeS: 600, delayThresholdS: 600 };
const pattern: Pattern = {
  id: 'pattern-1', operatorId: 'op-1', routeId: 'route-1', shape: new Polyline([{ x: 0, y: 0 }, { x: 4000, y: 0 }]),
  // Sequences need not be contiguous: "N stops before" counts positions in the pattern.
  stops: [10, 20, 30, 40, 50].map((sequence, i) => ({ sequence, distM: i * 800, arrivalOffsetS: i * 180, departureOffsetS: i * 180, point: { x: i * 800, y: 0 } })),
};

function stops(states: Partial<Record<number, StopState>>, extra: Partial<StopProgress> = {}): StopProgress[] {
  return pattern.stops.map((p) => ({
    sequence: p.sequence, state: states[p.sequence] ?? 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null, ...extra,
  }));
}

function input(over: Partial<DueInput> = {}): DueInput {
  return {
    sub: subscription('A', 40),
    pattern,
    tripStatus: 'active',
    stops: stops({}),
    etas: new Map([[40, new Date(NOW.getTime() + 300_000)]]),
    scheduledArrival: new Date(NOW.getTime() + 300_000),
    offRoute: false,
    fixAt: new Date(NOW.getTime() - 1000),
    now: NOW,
    approachingClaimed: false,
    ...over,
  };
}

const variant = (over: Partial<DueInput> = {}, c: DueConfig = cfg): string | null => dueAlert(input(over), c)?.variant ?? null;

describe('due logic: minutes before', () => {
  it('"within 5 minutes" includes the limit', () => {
    assert.equal(variant(), 'approaching');
    assert.equal(variant({ etas: new Map([[40, new Date(NOW.getTime() + 300_001)]]) }), null);
  });

  it('no ETA (e.g. off route, or not computed): not due', () => {
    assert.equal(variant({ etas: new Map() }), null);
  });

  it('held while stale or off route', () => {
    assert.equal(variant({ fixAt: new Date(NOW.getTime() - 121_000) }), null);
    assert.equal(variant({ fixAt: new Date(NOW.getTime() - 120_000) }), 'approaching');
    assert.equal(variant({ offRoute: true }), null);
  });

  it('muted until a later time: nothing; mute expired: due', () => {
    assert.equal(variant({ sub: subscription('A', 40, { mutedUntil: new Date(NOW.getTime() + 1) }) }), null);
    assert.equal(variant({ sub: subscription('A', 40, { mutedUntil: NOW }) }), 'approaching');
  });

  it('only for an active trip', () => {
    assert.equal(variant({ tripStatus: 'planned' }), null);
    assert.equal(variant({ tripStatus: 'completed' }), null);
  });
});

describe('due logic: stops before', () => {
  const sub = (n: number, seq = 40) => subscription('A', seq, { trigger: 'stops', triggerValue: n });

  it('fires when the stop N places earlier is departed or passed', () => {
    assert.equal(variant({ sub: sub(2), stops: stops({ 10: 'departed', 20: 'arrived' }) }), null);
    assert.equal(variant({ sub: sub(2), stops: stops({ 10: 'departed', 20: 'departed' }) }), 'approaching');
    assert.equal(variant({ sub: sub(2), stops: stops({ 10: 'departed', 20: 'passed' }) }), 'approaching');
  });

  it('fewer stops before than N: the first stop is the trigger; the first stop itself has none', () => {
    assert.equal(variant({ sub: sub(5), stops: stops({}) }), null);
    assert.equal(variant({ sub: sub(5), stops: stops({ 10: 'departed' }) }), 'approaching');
    assert.equal(variant({ sub: sub(1, 10), stops: stops({}) }), null);
  });

  it('does not need an ETA', () => {
    assert.equal(variant({ sub: sub(1), etas: new Map(), stops: stops({ 30: 'departed' }) }), 'approaching');
  });
});

describe('due logic: states of the subscribed stop', () => {
  it('passed is checked first: a passed stop never gets an approaching alert', () => {
    const passedAt = new Date(NOW.getTime() - 5000);
    assert.equal(variant({ stops: stops({ 40: 'passed' }, { passedAt }) }), null);
    assert.equal(variant({ sub: subscription('A', 40, { notifyPassed: true }), stops: stops({ 40: 'passed' }, { passedAt }) }), 'passed');
  });

  it('passed: not after passedMaxAgeS, not for a subscription made after the bus passed', () => {
    const sub = subscription('A', 40, { notifyPassed: true, createdAt: new Date(NOW.getTime() - 60_000) });
    assert.equal(variant({ sub, stops: stops({ 40: 'passed' }, { passedAt: new Date(NOW.getTime() - 601_000) }) }), null);
    assert.equal(variant({ sub, stops: stops({ 40: 'passed' }, { passedAt: new Date(NOW.getTime() - 61_000) }) }), null);
    assert.equal(variant({ sub, stops: stops({ 40: 'passed' }, { passedAt: new Date(NOW.getTime() - 59_000) }) }), 'passed');
  });

  it('arrived: "the bus is at your stop"; departed: nothing', () => {
    assert.equal(variant({ stops: stops({ 40: 'arrived' }) }), 'arrived');
    assert.equal(variant({ stops: stops({ 40: 'departed' }) }), null);
    assert.equal(variant({ sub: subscription('A', 40, { notifyPassed: true }), stops: stops({ 40: 'departed' }) }), null);
  });

  it('only the subscribed stop_sequence counts', () => {
    assert.equal(variant({ sub: subscription('A', 30), stops: stops({ 40: 'arrived' }), etas: new Map() }), null);
  });
});

describe('due logic: delayed', () => {
  const late = { etas: new Map([[40, new Date(NOW.getTime() + 20 * 60_000)]]), scheduledArrival: new Date(NOW.getTime() + 10 * 60_000) };

  it('the ETA at the stop is at least the threshold later than scheduled', () => {
    assert.equal(variant(late), 'delayed');
    assert.equal(dueAlert(input(late), cfg)?.delayS, 600);
    assert.equal(variant({ ...late, scheduledArrival: new Date(NOW.getTime() + 10 * 60_000 + 1) }), null);
  });

  it('not once an approaching alert is claimed or due, and not when switched off', () => {
    assert.equal(variant({ ...late, approachingClaimed: true }), null);
    assert.equal(variant({ ...late, sub: subscription('A', 40, { triggerValue: 20 }) }), 'approaching');
    assert.equal(variant(late, { ...cfg, delayThresholdS: 0 }), null);
  });
});
