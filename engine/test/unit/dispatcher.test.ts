import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlertDispatcher, Limiter, defaultAlertConfig } from '../../src/alerts/dispatcher.ts';
import type { TripUpdate } from '../../src/alerts/types.ts';
import { buildCache, progressFromRow } from '../../src/core/cache.ts';
import type { StopState } from '../../src/core/types.ts';
import { silentLogger } from '../../src/log.ts';
import { FakeClock, FakeSender, Scenario, subscription } from '../replay/harness.ts';
import { exampleRoute } from '../replay/routes.ts';

const unavailable = { ok: false as const, code: 'UNAVAILABLE', retryable: true, invalidTarget: false };

/** A dispatcher whose retries wait until the test releases them. */
async function setup() {
  const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: '2026-11-24', start: '07:30' }]));
  const cache = buildCache(await s.store.loadSnapshot());
  const entry = cache.instances.get('T1');
  assert.ok(entry);
  const clock = new FakeClock(new Date('2026-11-24T07:35:00+09:00'));
  const sender = new FakeSender(clock);
  const releases: (() => void)[] = [];
  s.store.subscriptions = [subscription('A', 4)];
  const d = new AlertDispatcher({
    store: s.store, sender, clock, log: silentLogger, config: { ...defaultAlertConfig, staleAfterS: 120 },
    sleep: () => new Promise((resolve) => releases.push(resolve)),
  });
  await d.reloadSubscriptions();
  const update = (state: StopState, eta: Date | null): TripUpdate => {
    const progress = { ...progressFromRow(entry.row, entry.instance), status: 'active' as const };
    progress.stops = progress.stops.map((x) => (x.sequence === 4 ? { ...x, state } : x));
    return { instance: entry.instance, progress, etas: eta ? new Map([[4, eta]]) : new Map(), fixAt: clock.now() };
  };
  /** Lets the dispatcher reach its next wait. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { s, d, clock, sender, releases, update, settle };
}

describe('alert dispatcher: retries', () => {
  it('an approaching alert still failing when the bus arrives becomes "the bus is at your stop"', async () => {
    const { s, d, clock, sender, releases, update, settle } = await setup();
    sender.script = [unavailable];
    d.tripUpdated(update('upcoming', new Date(clock.now().getTime() + 240_000)));
    await settle();
    assert.equal(releases.length, 1, 'waiting to retry');
    d.tripUpdated(update('arrived', null));
    releases.shift()?.();
    await d.idle();
    assert.deepEqual(sender.kinds(), ['arrived@4']);
    assert.deepEqual(s.store.deliveries.map((x) => `${x.kind}:${x.result}`), ['approaching:sent']);
  });

  it('a retry after the bus left the stop is dropped (expired)', async () => {
    const { s, d, clock, sender, releases, update, settle } = await setup();
    sender.script = [unavailable];
    d.tripUpdated(update('upcoming', new Date(clock.now().getTime() + 240_000)));
    await settle();
    d.tripUpdated(update('departed', null));
    releases.shift()?.();
    await d.idle();
    assert.deepEqual(sender.kinds(), []);
    assert.deepEqual(s.store.deliveries.map((x) => x.result), ['expired']);
    assert.equal(d.metrics.alertsExpired, 1);
  });

  it('a retry after the subscription was muted is dropped', async () => {
    const { s, d, clock, sender, releases, update, settle } = await setup();
    sender.script = [unavailable];
    d.tripUpdated(update('upcoming', new Date(clock.now().getTime() + 240_000)));
    await settle();
    s.store.subscriptions = [subscription('A', 4, { mutedUntil: new Date(clock.now().getTime() + 3600_000) })];
    await d.reloadSubscriptions();
    releases.shift()?.();
    await d.idle();
    assert.deepEqual(sender.kinds(), []);
    assert.deepEqual(s.store.deliveries.map((x) => x.result), ['expired']);
  });

  it('a retry with a new push target (re-registered meanwhile) uses it', async () => {
    const { s, d, clock, sender, releases, update, settle } = await setup();
    sender.script = [unavailable];
    d.tripUpdated(update('upcoming', new Date(clock.now().getTime() + 240_000)));
    await settle();
    s.store.subscriptions = [subscription('A', 4, { pushToken: 'fid-new' })];
    await d.reloadSubscriptions();
    releases.shift()?.();
    await d.idle();
    assert.deepEqual(sender.sent.map((m) => m.target), ['fid-new']);
  });

  it('evaluating again while a claim is in flight does not claim twice', async () => {
    const { s, d, clock, sender, update } = await setup();
    const u = update('upcoming', new Date(clock.now().getTime() + 240_000));
    d.tripUpdated(u);
    d.tripUpdated(u);
    await d.idle();
    assert.equal(sender.attempts.length, 1);
    assert.equal(s.store.deliveries.length, 1);
  });
});

describe('send limiter', () => {
  it('never runs more than n tasks at once, in order', async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let max = 0;
    const order: number[] = [];
    const task = (i: number) => limiter.run(async () => {
      running++;
      max = Math.max(max, running);
      order.push(i);
      await new Promise((r) => setImmediate(r));
      running--;
    });
    const all = Array.from({ length: 10 }, (_, i) => task(i));
    // A task started while the others finish must still wait its turn.
    await new Promise((r) => setImmediate(r));
    all.push(task(10));
    await Promise.all(all);
    assert.equal(max, 2);
    assert.deepEqual(order, Array.from({ length: 11 }, (_, i) => i));
  });
});
