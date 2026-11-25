/**
 * Replay scenarios for the alert dispatcher (arrival-alerts.md, "Examples"
 * and "Decisions (2026-11-26)"), with synthetic tracks, a fake clock, the
 * in-memory store and a fake push sender.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Scenario, Track, subscription, type Fix } from './harness.ts';
import { EXAMPLE_M, STOP_M, exampleRoute, exampleRun, germanSchool, loopRoute, normalRun } from './routes.ts';

const DATE = '2026-11-24';
const T1 = [{ id: 'T1', serviceDate: DATE, start: '07:30' }];

/** Index of the first fix at or after `t`. */
function at(fixes: readonly Fix[], t: Date): number {
  const i = fixes.findIndex((f) => f.t >= t);
  return i < 0 ? fixes.length : i;
}

function minutes(start: Date, min: number, s = 0): Date {
  return new Date(start.getTime() + (min * 60 + s) * 1000);
}

/** Seconds between the send and the ETA in the message. */
function leadS(m: { at: Date; payload: { data: Record<string, string> } }): number {
  return (new Date(m.payload.data.eta ?? '').getTime() - m.at.getTime()) / 1000;
}

describe('alerts: "N minutes before"', () => {
  it('fires once when the ETA is 5 minutes away or less; nothing at arrival; one per subscriber', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4), subscription('B', 4)] });
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.sender.kinds(), ['approaching@4', 'approaching@4']);
    assert.deepEqual(s.sender.sent.map((m) => m.payload.data.subscription_id).sort(), ['A', 'B']);
    for (const m of s.sender.sent) {
      assert.ok(leadS(m) <= 300, `within 5 minutes (${leadS(m)} s)`);
      assert.ok(leadS(m) > 280, `not much earlier than needed (${leadS(m)} s)`);
    }
    assert.equal(s.state('T1', 4), 'departed');
    assert.deepEqual(s.store.deliveries.map((d) => `${d.subscriptionId}:${d.kind}:${d.result}`).sort(), ['A:approaching:sent', 'B:approaching:sent']);
    assert.ok(s.store.deliveries.every((d) => d.sentAt !== null));
  });

  it('the message has IDs and the ETA, a localised text, and no position', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [subscription('A', 4, { language: 'ja' }), subscription('B', 4, { language: 'de-AT' }), subscription('C', 4, { language: 'fr' })],
    });
    await s.feed(exampleRun(s, 'T1').fixes);
    const [ja, de, fr] = ['A', 'B', 'C'].map((id) => s.sender.sent.find((m) => m.payload.data.subscription_id === id));
    assert.ok(ja && de && fr);
    assert.equal(ja.target, 'fid-A');
    const d = ja.payload.data;
    assert.equal(d.kind, 'approaching');
    assert.equal(d.trip_instance_id, 'T1');
    assert.equal(d.stop_sequence, '4');
    assert.equal(d.stop_id, 'stop-4');
    assert.equal(d.route_id, 'route-1');
    assert.equal(d.service_date, DATE);
    assert.ok(d.alert_id);
    assert.ok(Object.values(d).every((v) => typeof v === 'string'));
    for (const key of Object.keys(d)) assert.doesNotMatch(key, /lat|lon|location|position|speed|heading/);
    assert.match(ja.payload.notification.body, /^バスはあと約[45]分で停留所4に到着します。$/);
    assert.equal(ja.payload.notification.title, '朝便A');
    assert.match(de.payload.notification.body, /^Der Bus erreicht Stop 4 in etwa [45] Min\.$/);
    assert.match(fr.payload.notification.body, /^The bus arrives at Stop 4 in about [45] min\.$/);
    assert.equal(ja.payload.android.notification.channel_id, 'arrival_alerts');
    assert.equal(ja.payload.android.notification.tag, 'T1:4');
  });

  it('a muted subscription gets nothing while muted, and the alert once unmuted if still due', async () => {
    const s = await Scenario.create(exampleRoute(T1));
    const start = s.tripStart('T1');
    s.store.subscriptions = [
      subscription('A', 4, { mutedUntil: minutes(start, 5, 30) }),
      subscription('B', 4, { mutedUntil: minutes(start, 60) }),
    ];
    await s.alerts.reloadSubscriptions();
    const fixes = exampleRun(s, 'T1').fixes;
    const unmute = at(fixes, minutes(start, 5, 30));
    await s.feed(fixes.slice(0, unmute));
    assert.deepEqual(s.sender.kinds(), [], 'due since about 07:34, but muted');
    await s.feed(fixes.slice(unmute));
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`), ['A:approaching']);
  });
});

describe('alerts: "N stops before"', () => {
  it('"2 stops before" stop 5 fires when stop 3 is departed, not at stop 2', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 5, { trigger: 'stops', triggerValue: 2 })] });
    const fixes = exampleRun(s, 'T1').fixes;
    for (const f of fixes) {
      await s.feed([f]);
      const sent = s.sender.sent.length;
      const departed3 = s.state('T1', 3) === 'departed';
      assert.equal(sent, departed3 ? 1 : 0, `at ${f.t.toISOString()}: sent only once stop 3 is departed`);
    }
    assert.deepEqual(s.sender.kinds(), ['approaching@5']);
  });

  it('the trigger stop passed without stopping fires at that moment', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 5, { trigger: 'stops', triggerValue: 2 })] });
    const t = new Track(s.shape, minutes(s.tripStart('T1'), -1));
    t.dwell(65).drive(EXAMPLE_M[2] - 2, 30).dwell(30).drive(EXAMPLE_M[4] - 2, 35); // through stop 3
    for (const f of t.fixes) {
      await s.feed([f]);
      assert.equal(s.sender.sent.length, s.state('T1', 3) === 'passed' ? 1 : 0);
    }
    assert.deepEqual(s.sender.kinds(), ['approaching@5']);
  });

  it('near the start: "2 stops before" stop 2 fires when the first stop is departed (assumption)', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 2, { trigger: 'stops', triggerValue: 2 })] });
    const fixes = exampleRun(s, 'T1').fixes;
    for (const f of fixes) {
      await s.feed([f]);
      if (s.state('T1', 1) === 'departed') break;
      assert.equal(s.sender.sent.length, 0);
    }
    assert.deepEqual(s.sender.kinds(), ['approaching@2']);
  });
});

describe('alerts: passed without stopping and missed alerts', () => {
  it('notify_passed: "Passed" once when the stop is passed; nothing without it', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [subscription('A', 3, { trigger: 'minutes', triggerValue: 1, notifyPassed: true }), subscription('B', 3, { triggerValue: 1 })],
    });
    const t = new Track(s.shape, minutes(s.tripStart('T1'), -1));
    t.dwell(65).drive(EXAMPLE_M[2] - 2, 30).dwell(30).drive(EXAMPLE_M[4] - 2, 50).dwell(30);
    await s.feed(t.fixes);
    assert.equal(s.state('T1', 3), 'passed');
    // Example "passed without stopping": the approaching alert went out before; "Passed" only with notify_passed.
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`), ['A:approaching', 'B:approaching', 'A:passed']);
    assert.match(s.sender.sent[2]?.payload.notification.body ?? '', /passed Stop 3 without stopping/);
  });

  it('a gap in the data: stop 4 passed meanwhile gets no approaching alert; stop 5 gets it at once (example "Gaps in the data")', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [subscription('A', 4), subscription('B', 5), subscription('C', 4, { notifyPassed: true })],
    });
    const start = s.tripStart('T1');
    const t = new Track(s.shape, minutes(start, -1));
    t.dwell(65).drive(EXAMPLE_M[2] - 2, 30).dwell(30).drive(1000, 30);
    await s.feed(t.fixes);
    assert.deepEqual(s.sender.kinds(), [], 'nothing due before the gap');
    // No positions until 07:40; then the bus is at 2,500 m.
    const after = new Track(s.shape, minutes(start, 10), { startM: 2495 });
    after.drive(2600, 30);
    await s.feed(after.fixes);
    assert.equal(s.state('T1', 4), 'passed');
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`).sort(), ['B:approaching', 'C:passed']);
  });

  it('"2 stops before" with stops 3, 4 and 5 passed in one update: passed is checked first, no approaching alert', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [
        subscription('A', 5, { trigger: 'stops', triggerValue: 2, notifyPassed: true }),
        subscription('B', 5, { trigger: 'stops', triggerValue: 2 }),
      ],
    });
    const start = s.tripStart('T1');
    const t = new Track(s.shape, minutes(start, -1));
    t.dwell(65).drive(EXAMPLE_M[2] - 2, 30).dwell(30).drive(1400, 30);
    const after = new Track(s.shape, minutes(start, 10), { startM: 3195 });
    after.drive(3300, 30);
    await s.feed([...t.fixes, ...after.fixes]);
    assert.equal(s.state('T1', 3), 'passed');
    assert.equal(s.state('T1', 5), 'passed');
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`), ['A:passed']);
  });

  it('missed approaching: "the bus is at your stop" once, never after it departed', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4, { triggerValue: 2 }), subscription('B', 3, { triggerValue: 2 })] });
    const start = s.tripStart('T1');
    const t = new Track(s.shape, minutes(start, -1));
    t.dwell(65).drive(EXAMPLE_M[2] - 2, 30).dwell(30).drive(1000, 30);
    // Gap until the bus stands at stop 4 (stop 3 passed meanwhile).
    const after = new Track(s.shape, minutes(start, 9), { startM: EXAMPLE_M[4] - 3 });
    after.dwell(30).drive(EXAMPLE_M[5] - 2, 30);
    await s.feed([...t.fixes, ...after.fixes]);
    assert.deepEqual(s.sender.kinds(), ['arrived@4']);
    const msg = s.sender.sent[0];
    assert.equal(msg?.payload.notification.body, 'The bus is at Stop 4.');
    assert.deepEqual(s.store.deliveries.map((d) => `${d.subscriptionId}:${d.kind}`), ['A:approaching'], 'stored as kind approaching');
  });

  it('an approaching alert already sent: no "at your stop" alert at arrival', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 2, { trigger: 'stops', triggerValue: 1 })] });
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.sender.kinds(), ['approaching@2']);
  });
});

describe('alerts: stale positions and off route', () => {
  it('held while positions arrive stale; sent once fresh positions return', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4)] });
    const start = s.tripStart('T1');
    const fixes = exampleRun(s, 'T1').fixes;
    const stale = at(fixes, minutes(start, 5));
    // From 07:30 to 07:35 positions are processed 3 minutes late (stale).
    await s.feed(fixes.slice(0, at(fixes, start)));
    await s.feed(fixes.slice(at(fixes, start), stale), { latencyS: 180 });
    assert.deepEqual(s.sender.kinds(), [], 'due since about 07:34, but stale');
    await s.feed(fixes.slice(stale, stale + 1));
    assert.deepEqual(s.sender.kinds(), ['approaching@4'], 'the first fresh position sends it');
  });

  it('German School: held while off route, sent when back on the route and still due', async () => {
    const s = await Scenario.create(germanSchool(T1), {}, { subscriptions: [subscription('A', 4, { triggerValue: 1 })] });
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(STOP_M[3] - 2, 30).dwell(30).drive(1600, 30);
    await s.feed(t.fixes);
    assert.deepEqual(s.sender.kinds(), [], 'not due yet before the detour');
    const detour = new Track(s.shape, t.time, { startXY: s.shape.pointAt(1600) });
    detour.goTo({ x: 240, y: 260 }, 10).dwell(120);
    const back = new Track(s.shape, detour.time, { startXY: { x: 240, y: 260 } });
    back.goTo({ x: 30, y: 150 }, 20);
    await s.feed([...detour.fixes, ...back.fixes]);
    assert.ok(s.store.instance('T1').offRouteSince, 'off route');
    assert.deepEqual(s.sender.kinds(), [], 'held while off route');
    const rest = new Track(s.shape, back.time, { startM: 1950 });
    rest.drive(STOP_M[4] - 2, 10).dwell(30);
    for (const f of rest.fixes) {
      await s.feed([f]);
      if (s.store.instance('T1').offRouteSince !== null) assert.deepEqual(s.sender.kinds(), []);
    }
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
  });

  it('back on the route beyond the stop: its held alert is dropped, "Passed" if wanted', async () => {
    const s = await Scenario.create(germanSchool(T1), {}, {
      subscriptions: [subscription('A', 4, { triggerValue: 1, notifyPassed: true }), subscription('B', 4, { triggerValue: 1 })],
    });
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(STOP_M[3] - 2, 30).dwell(30).drive(1600, 30);
    const detour = new Track(s.shape, t.time, { startXY: s.shape.pointAt(1600) });
    detour.goTo({ x: 240, y: 260 }, 10).dwell(90).goTo({ x: 240, y: 340 }, 10);
    const rest = new Track(s.shape, detour.time, { startXY: { x: 240, y: 340 } });
    rest.goTo(s.shape.pointAt(2140), 20);
    const more = new Track(s.shape, rest.time, { startM: 2140 });
    more.drive(2400, 30);
    await s.feed([...t.fixes, ...detour.fixes, ...rest.fixes, ...more.fixes]);
    assert.equal(s.state('T1', 4), 'passed');
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`), ['A:passed']);
  });
});

describe('alerts: loops', () => {
  it('German School: passing 40 m from stop 3 before stop 2 alerts nobody for stop 3', async () => {
    const s = await Scenario.create(germanSchool(T1), {}, {
      subscriptions: [subscription('A', 3, { trigger: 'stops', triggerValue: 1 }), subscription('B', 3, { triggerValue: 1 })],
    });
    const fixes = normalRun(s, 'T1', { noisyOutbound: true }).fixes;
    const outbound = fixes.findIndex((f) => f.xy.x >= 400 && f.xy.y > 0 && f.xy.y < 30);
    await s.feed(fixes.slice(0, outbound + 1));
    assert.deepEqual(s.sender.kinds(), []);
    for (const f of fixes.slice(outbound + 1)) {
      await s.feed([f]);
      const a = s.sender.sent.filter((m) => m.payload.data.subscription_id === 'A').length;
      assert.equal(a, s.state('T1', 2) === 'departed' ? 1 : 0, '"1 stop before" fires when stop 2 is departed');
    }
    const b = s.sender.sent.filter((m) => m.payload.data.subscription_id === 'B');
    assert.equal(b.length, 1);
    assert.ok(b[0] && leadS(b[0]) <= 60);
  });

  it('a stop served twice: only the chosen visit alerts', async () => {
    const def = loopRoute(T1);
    const s = await Scenario.create(def, {}, {
      subscriptions: [subscription('first', 2, { trigger: 'stops', triggerValue: 1 }), subscription('second', 5, { trigger: 'stops', triggerValue: 1 })],
    });
    const dist = def.stops.map((x) => x.distM ?? 0);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 5 * 60_000));
    t.dwell(6 * 60);
    for (const i of [1, 2, 3, 4, 5]) t.drive((dist[i] ?? 0) - 3, 30).dwell(30);
    t.goTo({ x: -700, y: -300 }, 20);
    for (const f of t.fixes) {
      await s.feed([f]);
      const second = s.sender.sent.filter((m) => m.payload.data.subscription_id === 'second').length;
      assert.equal(second, s.state('T1', 4) === 'departed' ? 1 : 0, 'the second visit fires only after stop 4');
    }
    assert.deepEqual(s.sender.kinds(), ['approaching@2', 'approaching@5']);
  });
});

describe('alerts: exactly once', () => {
  it('an engine restart and retried positions do not send again', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4)] });
    const fixes = exampleRun(s, 'T1').fixes;
    let i = 0;
    for (; i < fixes.length && s.sender.sent.length === 0; i++) await s.feed([fixes[i] as Fix]);
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
    await s.restart();
    // Traccar retries the last positions, then the trip goes on.
    await s.feed(fixes.slice(i - 3, i).map((f) => ({ ...f, positionId: 1 })));
    await s.feed(fixes.slice(i));
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
    assert.equal(s.store.deliveries.length, 1);
  });

  it('a claim that fails (database down) is tried again with the next position', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4)] });
    s.store.failClaims = 1;
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
    assert.equal(s.store.deliveries.length, 1);
  });

  it('the same trip on the next day alerts again', async () => {
    const s = await Scenario.create(exampleRoute([...T1, { id: 'T2', serviceDate: '2026-11-25', start: '07:30' }]), {}, {
      subscriptions: [subscription('A', 4)],
    });
    await s.feed(exampleRun(s, 'T1').fixes);
    await s.feed(exampleRun(s, 'T2').fixes);
    assert.deepEqual(s.sender.sent.map((m) => `${m.payload.data.trip_instance_id ?? ''}:${m.payload.data.kind ?? ''}`), ['T1:approaching', 'T2:approaching']);
  });
});

describe('alerts: delayed and cancelled', () => {
  it('delayed: once per trip when the delay at the stop reaches the threshold; approaching later as usual', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4), subscription('B', 2)] });
    await s.feed(exampleRun(s, 'T1', { lateS: 12 * 60 }).fixes);
    const of = (id: string): string[] => s.sender.sent.filter((m) => m.payload.data.subscription_id === id).map((m) => m.payload.data.kind ?? '');
    assert.deepEqual(of('A'), ['delayed', 'approaching']);
    assert.deepEqual(of('B'), ['approaching'], 'approaching already due: no delay alert');
    const delayed = s.sender.sent.find((m) => m.payload.data.kind === 'delayed');
    assert.match(delayed?.payload.notification.body ?? '', /^The bus is running about 1[23] min late\. Expected at Stop 4 around 07:5\d\.$/);
    assert.equal(delayed?.payload.android.notification.channel_id, 'trip_changes');
  });

  it('cancelled by staff: one alert per subscriber after the next reload, not for stops already served', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [subscription('A', 2), subscription('B', 5), subscription('C', 5, { language: 'ja' })],
    });
    const start = s.tripStart('T1');
    const fixes = exampleRun(s, 'T1').fixes;
    await s.feed(fixes.slice(0, at(fixes, minutes(start, 4))));
    assert.equal(s.state('T1', 2), 'departed');
    const before = s.sender.sent.length;
    s.store.instance('T1').status = 'cancelled';
    await s.reload();
    await s.reload();
    const cancelled = s.sender.sent.slice(before);
    assert.deepEqual(cancelled.map((m) => `${m.payload.data.subscription_id ?? ''}:${m.payload.data.kind ?? ''}`).sort(), ['B:cancelled', 'C:cancelled']);
    assert.equal(cancelled.find((m) => m.payload.data.subscription_id === 'B')?.payload.notification.body, 'The 07:30 trip on 24/11 is cancelled.');
    assert.equal(cancelled.find((m) => m.payload.data.subscription_id === 'C')?.payload.notification.body, '11月24日 07:30発の便は運休です。');
    await s.feed(fixes.slice(at(fixes, minutes(start, 4))));
    assert.equal(s.sender.sent.length, before + 2, 'nothing more for a cancelled trip');
  });

  it('cancelled mid-run, running late: stops not yet served get it even if their scheduled time has passed', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 5, { triggerValue: 1 })], alerts: { delayThresholdS: 0 } });
    const start = s.tripStart('T1');
    const fixes = exampleRun(s, 'T1', { lateS: 15 * 60 }).fixes;
    await s.feed(fixes.slice(0, at(fixes, minutes(start, 18))));
    assert.ok(s.clock.now() > minutes(start, 12), 'stop 5 was scheduled at 07:42');
    assert.equal(s.state('T1', 5), 'upcoming');
    s.store.instance('T1').status = 'cancelled';
    await s.reload();
    assert.deepEqual(s.sender.kinds(), ['cancelled@5']);
  });

  it('cancelled: only for trips starting within 24 hours', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T3', serviceDate: '2026-11-26', start: '07:30' }]), {}, {
      subscriptions: [subscription('A', 2)],
    });
    s.clock.set(new Date('2026-11-24T06:00:00+09:00'));
    s.store.instance('T3').status = 'cancelled';
    await s.reload();
    assert.deepEqual(s.sender.kinds(), []);
    s.clock.set(new Date('2026-11-25T08:00:00+09:00'));
    await s.reload();
    assert.deepEqual(s.sender.kinds(), ['cancelled@2']);
  });
});

describe('alerts: sending', () => {
  const unavailable = { ok: false as const, code: 'UNAVAILABLE', retryable: true, invalidTarget: false };

  it('retries with backoff, then stores the result', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4)] });
    s.sender.script = [unavailable, { ...unavailable, retryAfterS: 20 }];
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
    assert.equal(s.sender.attempts.length, 3);
    assert.deepEqual(s.sleeps, [2000, 20_000]);
    assert.equal(s.store.deliveries[0]?.result, 'sent');
  });

  it('gives up after the last retry and marks the alert failed', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, { subscriptions: [subscription('A', 4)] });
    s.sender.script = [unavailable, unavailable, unavailable, unavailable, unavailable];
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.equal(s.sender.attempts.length, 4);
    assert.equal(s.sender.sent.length, 0);
    assert.deepEqual(s.store.deliveries.map((d) => [d.result, d.sentAt]), [['failed: UNAVAILABLE', null]]);
  });

  it('an invalid push target clears the device\'s token and is not used again', async () => {
    const s = await Scenario.create(exampleRoute(T1), {}, {
      subscriptions: [subscription('A', 4, { deviceId: 'dev-x', pushToken: 'fid-x' }), subscription('B', 5, { deviceId: 'dev-x', pushToken: 'fid-x' })],
    });
    s.sender.script = [{ ok: false, code: 'UNREGISTERED', retryable: false, invalidTarget: true }];
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.equal(s.sender.attempts.length, 1);
    assert.deepEqual(s.store.clearedTokens, ['dev-x']);
    assert.deepEqual(s.store.deliveries.map((d) => d.result), ['invalid_token', 'invalid_token']);
  });
});

describe('alerts: never in the way of position processing', () => {
  it('an observer that throws does not fail positions or reloads', async () => {
    const s = await Scenario.create(exampleRoute(T1));
    const { Engine } = await import('../../src/core/engine.ts');
    const { silentLogger } = await import('../../src/log.ts');
    const boom = () => { throw new Error('boom'); };
    s.engine = new Engine({ store: s.store, thresholds: s.thresholds, clock: s.clock, log: silentLogger, observer: { tripUpdated: boom, tripsReloaded: boom } });
    await s.engine.reload();
    const outcomes = await s.feed(exampleRun(s, 'T1').fixes);
    assert.ok(outcomes.every((o) => o === 'processed'));
    assert.equal(s.store.instance('T1').status, 'completed');
  });
});
