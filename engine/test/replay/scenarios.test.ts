/**
 * Replay scenarios from engine.md ("Testing") and arrival-alerts.md
 * ("Examples"), with synthetic tracks and a fake clock.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { XY } from '../../src/geo/plane.ts';
import { DEVICE, DEVICE_2, Scenario, Track, VEHICLE, VEHICLE_2, type Fix, type RouteDef, type TripDef } from './harness.ts';

const DATE = '2026-11-24';

/**
 * The German School problem, condensed: the route goes out along a street,
 * turns, and comes back on the parallel street 40 m away. Stop 3 is on the
 * way back, but the bus passes 40 m from it on the way out, before stop 2.
 * A 500 m circle fires for stop 3 first; progress along the route must not.
 *
 *   (0,400) ─────────── 5 (800,400)
 *     │
 *     4 (0,220)
 *     │
 *   (0,40) ◄──── 3 (400,40) ◄──── (900,40)
 *                                   2 (900,20)
 *   1 (0,0) ─────────────────────► (900,0)
 */
function germanSchool(trips: TripDef[]): RouteDef {
  return {
    shape: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 400 }, { x: 800, y: 400 }],
    stops: [
      { sequence: 1, at: { x: 0, y: 0 }, arrivalOffsetS: 0, departureOffsetS: 60 },
      { sequence: 2, at: { x: 900, y: 20 }, arrivalOffsetS: 300, departureOffsetS: 330 },
      { sequence: 3, at: { x: 400, y: 40 }, arrivalOffsetS: 480, departureOffsetS: 510 },
      { sequence: 4, at: { x: 0, y: 220 }, arrivalOffsetS: 660, departureOffsetS: 690 },
      { sequence: 5, at: { x: 800, y: 400 }, arrivalOffsetS: 900, departureOffsetS: 900 },
    ],
    trips,
  };
}
// Stop positions along the shape (m): 0, 920, 1440, 2020, 3000.
const STOP_M = { 1: 0, 2: 920, 3: 1440, 4: 2020, 5: 3000 } as const;

/**
 * A loop that serves one stop twice (like the seed's Kitano-zaka): stops 2
 * and 5 are the same place; the shape's vertices are the stops.
 */
function loopRoute(trips: TripDef[]): RouteDef {
  const pts: XY[] = [
    { x: 0, y: 0 }, { x: -300, y: -700 }, { x: 100, y: -1200 }, { x: -700, y: -1700 }, { x: -300, y: -700 }, { x: -600, y: -400 },
  ];
  let m = 0;
  const dist = pts.map((p, i) => {
    const prev = pts[i - 1];
    if (prev) m += Math.hypot(p.x - prev.x, p.y - prev.y);
    return m;
  });
  const offsets = [[0, 60], [300, 330], [540, 600], [900, 930], [1260, 1290], [1500, 1500]] as const;
  return {
    shape: pts,
    stops: pts.map((p, i) => ({
      sequence: i + 1, at: p, distM: dist[i] ?? 0, arrivalOffsetS: offsets[i]?.[0] ?? 0, departureOffsetS: offsets[i]?.[1] ?? 0,
    })),
    trips,
  };
}

const FULL_RUN = ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed', '4:arrived', '4:departed', '5:arrived', '5:departed'];

/** A normal run of the German School route, starting at the depot before the window opens. */
function normalRun(s: Scenario, tripId: string, opts: { noisyOutbound?: boolean } = {}): Track {
  const start = s.tripStart(tripId);
  const t = new Track(s.shape, new Date(start.getTime() - 12 * 60_000));
  t.dwell(12 * 60 + 60);
  // Outbound: GPS pulled 25 m towards the return street, so the position is
  // closer to the return street (15 m) than to the street the bus is on.
  t.drive(850, 30, opts.noisyOutbound ? () => ({ x: 0, y: 25 }) : undefined);
  t.drive(STOP_M[2] - 5, 30).dwell(30);
  t.drive(STOP_M[3] - 2, 30).dwell(30);
  t.drive(STOP_M[4] - 2, 30).dwell(30);
  t.drive(STOP_M[5] - 2, 30).dwell(60);
  t.goTo({ x: 800, y: 480 }, 15);
  return t;
}

describe('replay: German School loop', () => {
  it('passing 40 m from stop 3 before stop 2 does not touch stop 3', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const track = normalRun(s, 'T1', { noisyOutbound: true });

    // Feed up to the moment the bus is at x = 400 on the way out (40 m from stop 3).
    const outboundAtStop3 = track.fixes.findIndex((f) => f.xy.x >= 400 && f.xy.y > 0 && f.xy.y < 30);
    assert.ok(outboundAtStop3 > 0);
    await s.feed(track.fixes.slice(0, outboundAtStop3 + 1));
    assert.equal(s.state('T1', 3), 'upcoming');
    assert.equal(s.state('T1', 2), 'upcoming');
    assert.ok(s.store.instance('T1').progressM < 450, 'progress follows the outbound street');

    await s.feed(track.fixes.slice(outboundAtStop3 + 1));
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
    assert.equal(s.store.instance('T1').status, 'completed');
    const times = s.store.transitions.map((x) => x.at.getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'events happen in route order');
  });

  it('a loop serving a stop twice: the first visit only serves the first stop_sequence', async () => {
    const def = loopRoute([{ id: 'L1', serviceDate: DATE, start: '07:30' }]);
    const s = await Scenario.create(def);
    const dist = def.stops.map((x) => x.distM ?? 0);
    const t = new Track(s.shape, new Date(s.tripStart('L1').getTime() - 5 * 60_000));
    t.dwell(6 * 60);
    t.drive((dist[1] ?? 0) - 3, 30).dwell(30);
    await s.feed(t.fixes);
    assert.equal(s.state('L1', 2), 'arrived');
    assert.equal(s.state('L1', 5), 'upcoming', 'same place, later in the trip');

    const t2 = new Track(s.shape, t.time, { startM: (dist[1] ?? 0) - 3 });
    for (const i of [2, 3, 4, 5]) t2.drive((dist[i] ?? 0) - 3, 30).dwell(30);
    t2.goTo({ x: -700, y: -300 }, 20);
    await s.feed(t2.fixes);
    assert.deepEqual(s.transitions('L1'), [
      '1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed',
      '4:arrived', '4:departed', '5:arrived', '5:departed', '6:arrived', '6:departed',
    ]);
  });
});

describe('replay: skipped stop', () => {
  it('a stop driven past without stopping is passed, the others are served', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120);
    t.drive(STOP_M[2] - 5, 30).dwell(30);
    t.drive(STOP_M[4] - 2, 35).dwell(30); // through stop 3 at 35 km/h
    t.drive(STOP_M[5] - 2, 30).dwell(30);
    t.goTo({ x: 800, y: 480 }, 15);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('T1'), [
      '1:arrived', '1:departed', '2:arrived', '2:departed', '3:passed', '4:arrived', '4:departed', '5:arrived', '5:departed',
    ]);
    const ev3 = s.store.instance('T1').stopEvents.find((e) => e.sequence === 3);
    assert.ok(ev3);
    assert.equal(ev3.arrivedAt, null);
    assert.ok(ev3.passedAt);
  });
});

describe('replay: excursion outside any trip', () => {
  it('driving the route outside the trip window creates no stop events', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() + 3 * 3600_000)); // 10:30
    t.dwell(60).drive(STOP_M[2] - 5, 30).dwell(30).drive(STOP_M[4] - 2, 30).dwell(30);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('T1'), []);
    assert.equal(s.store.instance('T1').status, 'planned');
    const vs = s.store.vehicleState.get(VEHICLE);
    assert.ok(vs, 'vehicle state is still updated for operators');
    assert.equal(vs.tripInstanceId, null);
  });

  it('driving the first street against the route direction inside the window does not start the trip', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 10 * 60_000), { startXY: { x: 950, y: 0 } });
    t.goTo({ x: 100, y: 0 }, 30);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.deepEqual(s.transitions('T1'), []);
  });
});

describe('replay: GPS jump', () => {
  it('a single position far ahead is ignored', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(1000, 30);
    await s.feed(t.fixes);
    const before = s.store.instance('T1').progressM;

    // One fix at stop 4's place (1,020 m ahead), then back to normal.
    const jumpAt = new Date(t.time.getTime() + 5000);
    await s.feed([{ t: jumpAt, xy: s.shape.pointAt(STOP_M[4]), speedKmh: 0 }]);
    assert.equal(s.store.instance('T1').progressM, before);
    assert.equal(s.state('T1', 3), 'upcoming');
    assert.equal(s.state('T1', 4), 'upcoming');

    const t2 = new Track(s.shape, jumpAt, { startM: 1000 });
    t2.drive(STOP_M[3] - 2, 30).dwell(30);
    await s.feed(t2.fixes);
    assert.equal(s.state('T1', 3), 'arrived');
    assert.equal(s.state('T1', 4), 'upcoming');
  });

  it('after a short gap, a jump is accepted once three positions moving forward confirm it', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(1000, 30);
    t.gap(30); // ~930 m in 35 s would be 95 km/h: a jump
    await s.feed(t.fixes);

    const t2 = new Track(s.shape, t.time, { startM: 1900 });
    t2.drive(1985, 20); // 1,928 / 1,956 / 1,983 / 1,985: the first two are not enough
    const fixes = t2.fixes;
    await s.feed(fixes.slice(0, 2));
    assert.equal(s.state('T1', 3), 'upcoming', 'not confirmed yet');
    await s.feed(fixes.slice(2));
    assert.equal(s.state('T1', 3), 'passed', 'confirmed: stop 3 is behind the bus and was never arrived at');
    assert.ok(s.store.instance('T1').progressM > 1950);
    assert.equal(fixes.length, 4);
    assert.equal(s.state('T1', 4), 'upcoming');
  });
});

describe('replay: detour and off route', () => {
  async function runToStop3(s: Scenario): Promise<Track> {
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(STOP_M[3] - 2, 30).dwell(30).drive(1600, 30);
    await s.feed(t.fixes);
    return t;
  }

  it('off route while away, alerts held (no ETA writes), back on route before the next stop', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = await runToStop3(s);
    const progressBefore = s.store.instance('T1').progressM;

    const detour = new Track(s.shape, t.time, { startXY: s.shape.pointAt(1600) });
    detour.goTo({ x: 240, y: 260 }, 10).dwell(90); // 220 m from the route for more than 60 s
    await s.feed(detour.fixes);
    const row = s.store.instance('T1');
    assert.ok(row.offRouteSince, 'off route');
    assert.equal(row.progressM, progressBefore, 'progress kept');

    const etaWritesBefore = s.store.etaWrites;
    const back = new Track(s.shape, detour.time, { startXY: { x: 240, y: 260 } });
    back.goTo({ x: 30, y: 150 }, 20); // only the last fix is within 50 m of the route
    await s.feed(back.fixes);
    assert.equal(s.store.etaWrites, etaWritesBefore, 'no ETAs while off route');
    assert.ok(row.offRouteSince, 'still off route: back on the route line for fewer than 3 positions');

    const rest = new Track(s.shape, back.time, { startM: 1990 });
    rest.drive(STOP_M[4] - 2, 20).dwell(30);
    await s.feed(rest.fixes);
    assert.equal(row.offRouteSince, null, 'back on route');
    assert.equal(s.state('T1', 4), 'arrived');
    assert.ok(s.store.etaWrites > etaWritesBefore, 'ETAs resume');
  });

  it('back on the route beyond the next stop: that stop is passed', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = await runToStop3(s);
    const detour = new Track(s.shape, t.time, { startXY: s.shape.pointAt(1600) });
    detour.goTo({ x: 240, y: 260 }, 10).dwell(90).goTo({ x: 240, y: 340 }, 10);
    const rest = new Track(s.shape, detour.time, { startXY: { x: 240, y: 340 } });
    rest.goTo(s.shape.pointAt(2140), 20);
    const more = new Track(s.shape, rest.time, { startM: 2140 });
    more.drive(2400, 30);
    await s.feed([...detour.fixes, ...rest.fixes, ...more.fixes]);
    assert.equal(s.state('T1', 4), 'passed');
    assert.equal(s.store.instance('T1').offRouteSince, null);
  });

  it('a single position far from the route changes nothing', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = await runToStop3(s);
    const before = structuredClone(s.store.instance('T1'));
    // More than 100 m from every part of the route inside the window.
    await s.feed([{ t: new Date(t.time.getTime() + 5000), xy: { x: 500, y: 250 }, speedKmh: 30 }]);
    const after = s.store.instance('T1');
    assert.equal(after.offRouteSince, null);
    assert.equal(after.progressM, before.progressM);
  });
});

describe('replay: two trips of the same pattern back to back', () => {
  it('each trip gets its own stop events; the drive back does not start or touch a trip', async () => {
    const s = await Scenario.create(germanSchool([
      { id: 'T1', serviceDate: DATE, start: '07:30' },
      { id: 'T2', serviceDate: DATE, start: '08:10' },
    ]));
    const t1 = normalRun(s, 'T1');
    await s.feed(t1.fixes);
    assert.equal(s.store.instance('T1').status, 'completed');
    assert.equal(s.store.instance('T2').status, 'planned');

    // Back to the depot, off the route, then wait for the 08:10 trip.
    const back = new Track(s.shape, t1.time, { startXY: { x: 800, y: 480 } });
    back.goTo({ x: -300, y: 480 }, 40).goTo({ x: -300, y: 0 }, 40).goTo({ x: 0, y: 0 }, 20);
    back.dwell(60);
    await s.feed(back.fixes);

    const t2 = normalRun(s, 'T2');
    const fixes = t2.fixes.filter((f) => f.t > back.time);
    await s.feed(fixes);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
    assert.deepEqual(s.transitions('T2'), FULL_RUN);
    assert.equal(s.store.instance('T2').status, 'completed');
    const t1Departed = s.store.instance('T1').stopEvents.find((e) => e.sequence === 5)?.departedAt;
    const t2Arrived = s.store.instance('T2').stopEvents.find((e) => e.sequence === 1)?.arrivedAt;
    assert.ok(t1Departed && t2Arrived && t2Arrived > t1Departed);
  });

  it('when both windows are open, the trip whose schedule fits is started', async () => {
    const s = await Scenario.create(germanSchool([
      { id: 'T1', serviceDate: DATE, start: '07:30' },
      { id: 'T2', serviceDate: DATE, start: '07:50' },
    ]));
    // The bus shows up at the depot at 07:48: T1 (window until 08:15) should
    // be at the school by now, T2 starts in two minutes.
    const t = new Track(s.shape, new Date(s.tripStart('T2').getTime() - 2 * 60_000));
    t.dwell(120).drive(300, 30);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.equal(s.store.instance('T2').status, 'active');
  });
});

describe('replay: engine restart mid-trip', () => {
  it('continues from the database: same events as an uninterrupted run, retried positions ignored', async () => {
    const def = loopRoute([{ id: 'L1', serviceDate: DATE, start: '07:30' }]);
    const dist = def.stops.map((x) => x.distM ?? 0);
    const build = (s: Scenario): Track => {
      const t = new Track(s.shape, new Date(s.tripStart('L1').getTime() - 60_000));
      t.dwell(120);
      for (const i of [1, 2, 3, 4, 5]) t.drive((dist[i] ?? 0) - 3, 30).dwell(30);
      t.goTo({ x: -700, y: -300 }, 20);
      return t;
    };

    const reference = await Scenario.create(def);
    await reference.feed(build(reference).fixes);

    const s = await Scenario.create(def);
    const fixes = build(s).fixes;
    const half = fixes.findIndex((f) => f.t > new Date(s.tripStart('L1').getTime() + 400_000));
    await s.feed(fixes.slice(0, half));
    assert.equal(s.store.instance('L1').status, 'active');

    await s.restart();
    // Traccar retries the last few positions after the restart.
    const retried = await s.feed(fixes.slice(half - 3, half));
    assert.deepEqual(retried, ['duplicate', 'duplicate', 'duplicate']);
    await s.feed(fixes.slice(half));

    assert.deepEqual(s.transitions('L1'), reference.transitions('L1'));
    assert.equal(s.store.instance('L1').status, 'completed');
  });

  it('a failed write is not kept in memory; the retried position is processed again', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30);
    const fixes = t.fixes;
    const arriveIdx = fixes.findIndex((f) => f.speedKmh === 0 && f.xy.x > 800);
    await s.feed(fixes.slice(0, arriveIdx));
    s.store.failNext = 1;
    await assert.rejects(s.feed(fixes.slice(arriveIdx, arriveIdx + 1)));
    assert.equal(s.state('T1', 2), 'upcoming');
    await s.feed(fixes.slice(arriveIdx, arriveIdx + 1));
    assert.equal(s.state('T1', 2), 'arrived');
    assert.deepEqual(s.transitions('T1').filter((x) => x === '2:arrived'), ['2:arrived']);
  });
});

describe('replay: trip end and ETAs', () => {
  it('the tick completes a trip whose window closed while the bus stopped sending', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('T1').status, 'active');
    assert.deepEqual(s.engine.staleTrips(), []);
    await s.tickAt(new Date(s.tripStart('T1').getTime() + 20 * 60_000));
    assert.deepEqual(s.engine.staleTrips(), ['T1']);
    assert.equal(s.store.instance('T1').status, 'active');
    await s.tickAt(new Date(s.tripStart('T1').getTime() + 46 * 60_000));
    assert.equal(s.store.instance('T1').status, 'completed');
  });

  it('an on-time bus gets the scheduled arrival times as ETAs', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const start = s.tripStart('T1');
    const t = new Track(s.shape, new Date(start.getTime() - 60_000));
    t.dwell(120); // until 07:31 = scheduled departure from stop 1
    // 920 m in 240 s (scheduled): about 13.8 km/h, arriving at 07:35.
    t.drive(460, 13.8);
    await s.feed(t.fixes);
    const eta = s.store.instance('T1').stopEvents.find((e) => e.sequence === 4)?.eta;
    assert.ok(eta);
    const scheduled = new Date(start.getTime() + 660_000);
    assert.ok(Math.abs(eta.getTime() - scheduled.getTime()) < 45_000, `ETA ${eta.toISOString()} ≈ ${scheduled.toISOString()}`);
  });

  it('a late bus shifts the ETAs by its delay', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const start = s.tripStart('T1');
    const t = new Track(s.shape, new Date(start.getTime() + 60_000));
    t.dwell(300); // leaves 5 minutes late
    t.drive(460, 13.8);
    await s.feed(t.fixes);
    const eta = s.store.instance('T1').stopEvents.find((e) => e.sequence === 4)?.eta;
    assert.ok(eta);
    const expected = new Date(start.getTime() + 660_000 + 300_000);
    assert.ok(Math.abs(eta.getTime() - expected.getTime()) < 45_000, `ETA ${eta.toISOString()} ≈ ${expected.toISOString()}`);
  });

  it('positions of an unknown device are dropped and leave no trace', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const out = await s.feed([{ t: s.tripStart('T1'), xy: { x: 0, y: 0 }, speedKmh: 0, deviceId: 'someone-else' }]);
    assert.deepEqual(out, ['unknown_device']);
    assert.equal(s.store.persistCalls, 0);
    assert.equal(s.engine.metrics.positionsUnknownDevice, 1);
  });
});

describe('replay: review findings', () => {
  it('German School: a bus waiting on the outbound street with GPS pulled onto the return street', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(400, 30);
    await s.feed(t.fixes);
    // 3 minutes standing at x = 400; GPS 55 m from the outbound street, 15 m from the return street (stop 3).
    const waiting: Fix[] = Array.from({ length: 36 }, (_, i) => ({
      t: new Date(t.time.getTime() + (i + 1) * 5000), xy: { x: 400, y: 55 }, speedKmh: 0,
    }));
    await s.feed(waiting);
    assert.equal(s.state('T1', 3), 'upcoming');
    assert.equal(s.state('T1', 2), 'upcoming');
    assert.ok(s.store.instance('T1').progressM < 450);

    const rest = new Track(s.shape, waiting[waiting.length - 1]?.t ?? t.time, { startM: 400 });
    rest.drive(STOP_M[2] - 5, 30).dwell(30).drive(STOP_M[3] - 2, 30).dwell(30).drive(STOP_M[4] - 2, 30).dwell(30)
      .drive(STOP_M[5] - 2, 30).dwell(60).goTo({ x: 800, y: 480 }, 15);
    await s.feed(rest.fixes);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
  });

  it('German School: after a gap, a single fix pulled onto the return street changes nothing', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(400, 30);
    await s.feed(t.fixes);
    await s.feed([{ t: new Date(t.time.getTime() + 90_000), xy: { x: 400, y: 55 }, speedKmh: 0 }]);
    assert.equal(s.state('T1', 2), 'upcoming');
    assert.equal(s.state('T1', 3), 'upcoming');
    assert.ok(s.store.instance('T1').progressM < 450);
  });

  it('a tracker reporting every 60 s: stops are still arrived at, not passed', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS: 60 });
    t.dwell(180);
    for (const m of [STOP_M[2], STOP_M[3], STOP_M[4], STOP_M[5]]) t.drive(m - 5, 40).dwell(120);
    t.goTo({ x: 800, y: 480 }, 10).dwell(120);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
  });

  it('a trip any vehicle may run: a second vehicle reporting at the same time does not undo the start', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30', vehicleId: null }]));
    const bus1 = normalRun(s, 'T1').fixes;
    // Bus 2 stands at the depot the whole time.
    const send = async (f: Fix, device: string): Promise<unknown> => {
      const ll = s.plane.toLonLat(f.xy);
      return s.engine.handlePosition({
        deviceId: device, positionId: null, fixTime: f.t, lon: ll.lon, lat: ll.lat,
        speedKmh: f.speedKmh, course: f.course ?? null, accuracyM: 5, valid: true,
      });
    };
    for (const f of bus1) {
      s.clock.set(new Date(f.t.getTime() + 1000));
      await Promise.all([send(f, DEVICE), send({ t: f.t, xy: { x: 0, y: 0 }, speedKmh: 0 }, DEVICE_2)]);
      const mem = s.engine.trips.get('T1')?.progress.status;
      assert.equal(mem, s.store.instance('T1').status, 'memory and database agree');
    }
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
    assert.equal(s.store.instance('T1').vehicleId, VEHICLE);
    assert.equal(s.store.vehicleState.get(VEHICLE_2)?.tripInstanceId, null);
  });

  it('a trip any vehicle may run: two buses start it at the same moment, only one runs it', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30', vehicleId: null }]));
    const fixes = normalRun(s, 'T1').fixes;
    const send = (f: Fix, device: string): Promise<unknown> => {
      const ll = s.plane.toLonLat(f.xy);
      return s.engine.handlePosition({
        deviceId: device, positionId: null, fixTime: f.t, lon: ll.lon, lat: ll.lat,
        speedKmh: f.speedKmh, course: f.course ?? null, accuracyM: 5, valid: true,
      });
    };
    // Both buses drive the same track (convoy): both qualify on the same fix.
    for (const f of fixes) {
      s.clock.set(new Date(f.t.getTime() + 1000));
      await Promise.all([send(f, DEVICE), send(f, DEVICE_2)]);
      assert.equal(s.engine.trips.get('T1')?.progress.status, s.store.instance('T1').status, 'memory and database agree');
    }
    assert.ok(s.engine.metrics.concurrentTripUpdates >= 1, 'the race happened');
    assert.deepEqual(s.transitions('T1'), FULL_RUN, 'each event once');
    const runner = s.store.instance('T1').vehicleId;
    const other = runner === VEHICLE ? VEHICLE_2 : VEHICLE;
    assert.equal(s.engine.trips.get('T1')?.progress.vehicleId, runner);
    assert.equal(s.store.vehicleState.get(other)?.tripInstanceId, null);
  });

  it('a trip cancelled in the database stops getting stop events after the next reload', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const fixes = normalRun(s, 'T1').fixes;
    const mid = fixes.findIndex((f) => f.xy.x > 600 && f.xy.y > 30); // on the way back
    await s.feed(fixes.slice(0, mid));
    assert.equal(s.store.instance('T1').status, 'active');
    const before = s.transitions('T1');

    s.store.instance('T1').status = 'cancelled';
    await s.engine.reload();
    await s.feed(fixes.slice(mid));
    assert.deepEqual(s.transitions('T1'), before);
    assert.equal(s.engine.trips.get('T1')?.progress.status, 'cancelled');
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, null);
  });

  it('a vehicle assigned by staff for the day takes over after a reload', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.store.instance('T1').vehicleId = VEHICLE_2; // Bus 1 is broken today
    await s.engine.reload();
    const fixes = normalRun(s, 'T1').fixes;
    const driven = fixes.findIndex((f) => f.xy.x >= 300 && f.xy.y < 30); // 300 m along the first street
    await s.feed(fixes.slice(0, driven)); // Bus 1 drives the route anyway
    assert.equal(s.store.instance('T1').status, 'planned');
    await s.feed(fixes.slice(driven).map((f) => ({ ...f, deviceId: DEVICE_2 })));
    assert.equal(s.store.instance('T1').vehicleId, VEHICLE_2);
    assert.notEqual(s.store.instance('T1').status, 'planned');
  });

  it('a bus parked at the first stop does not start the trip (e.g. on a holiday)', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 20 * 60_000));
    t.dwell(60 * 60);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.deepEqual(s.transitions('T1'), []);
    assert.equal(s.store.etaWrites, 0);
  });

  it('pulling away from the first stop starts the trip; the stop counts as arrived since the window opened', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const start = s.tripStart('T1');
    const t = new Track(s.shape, new Date(start.getTime() - 20 * 60_000));
    t.dwell(21 * 60).drive(300, 30);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('T1').status, 'active');
    const first = s.store.instance('T1').stopEvents.find((e) => e.sequence === 1);
    assert.equal(first?.state, 'departed');
    assert.ok(first.arrivedAt && first.arrivedAt >= new Date(start.getTime() - 15 * 60_000));
  });

  it('a loop without dist_along_shape: stops are projected onto the right pass', async () => {
    const def = loopRoute([{ id: 'L1', serviceDate: DATE, start: '07:30' }]);
    const dist = def.stops.map((x) => x.distM ?? 0);
    const noDist: RouteDef = { ...def, stops: def.stops.map((x) => ({ sequence: x.sequence, at: x.at, arrivalOffsetS: x.arrivalOffsetS, departureOffsetS: x.departureOffsetS })) };
    const s = await Scenario.create(noDist);
    const t = new Track(s.shape, new Date(s.tripStart('L1').getTime() - 60_000));
    t.dwell(120);
    for (const i of [1, 2, 3, 4, 5]) t.drive((dist[i] ?? 0) - 3, 30).dwell(30);
    t.goTo({ x: -700, y: -300 }, 20).dwell(30);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('L1'), [
      '1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed',
      '4:arrived', '4:departed', '5:arrived', '5:departed', '6:arrived', '6:departed',
    ]);
  });
});

describe('replay: third review findings', () => {
  async function outboundTo(m: number): Promise<{ s: Scenario; t: Track }> {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(m, 30);
    await s.feed(t.fixes);
    return { s, t };
  }

  for (const [label, afterS, speedKmh, course] of [
    ['standing, 5 s later', 5, 0, null],
    ['driving west, 5 s later', 5, 20, 270],
    ['after a 30 s gap', 30, 0, null],
  ] as const) {
    it(`one bad fix on the return street, 125 m behind the progress (${label}), changes nothing`, async () => {
      const { s, t } = await outboundTo(800);
      const before = s.store.instance('T1').progressM;
      await s.feed([{ t: new Date(t.time.getTime() + afterS * 1000), xy: { x: 675, y: 40 }, speedKmh, course }]);
      assert.equal(s.store.instance('T1').progressM, before);
      assert.equal(s.state('T1', 2), 'upcoming');
    });
  }

  it('a standing bus with jittering GPS on the return street confirms nothing', async () => {
    const { s, t } = await outboundTo(400);
    const xs = [400, 395, 405, 398, 402, 380, 420, 390, 430, 385, 425, 400];
    await s.feed(xs.map((x, i) => ({ t: new Date(t.time.getTime() + (i + 1) * 5000), xy: { x, y: 60 }, speedKmh: 0 })));
    assert.ok(s.store.instance('T1').progressM < 450);
    assert.equal(s.state('T1', 3), 'upcoming');
  });

  it('a 60-s tracker with a stop on the return street close to the way out', async () => {
    const def = germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]);
    def.stops = def.stops.map((x) => (x.sequence === 3 ? { ...x, at: { x: 700, y: 40 } } : x)); // m = 1140
    const s = await Scenario.create(def);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS: 60 });
    t.dwell(180);
    for (const m of [STOP_M[2], 1140, STOP_M[4], STOP_M[5]]) t.drive(m - 5, 30).dwell(120);
    t.goTo({ x: 800, y: 480 }, 10).dwell(120);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
  });
});

describe('replay: database wins over memory', () => {
  it('staff assign bus 2 just before bus 1 starts an any-vehicle trip: bus 1 is not kept, bus 2 runs it', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30', vehicleId: null }]));
    s.store.instance('T1').vehicleId = VEHICLE_2; // in the database, not yet reloaded
    const fixes = normalRun(s, 'T1').fixes;
    const driven = fixes.findIndex((f) => f.xy.x >= 300 && f.xy.y < 30); // 300 m along the first street
    await s.feed(fixes.slice(0, driven)); // bus 1 drives the start of the route
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.notEqual(s.engine.trips.get('T1')?.progress.status, 'active', 'the refused start is not kept');
    assert.deepEqual(s.transitions('T1'), []);
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, null);

    await s.engine.reload();
    await s.feed(fixes.map((f) => ({ ...f, deviceId: DEVICE_2 })));
    assert.equal(s.store.instance('T1').vehicleId, VEHICLE_2);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
  });

  it('an active trip whose vehicle changed in the database is taken from the database on reload', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const fixes = normalRun(s, 'T1').fixes;
    const driven = fixes.findIndex((f) => f.xy.x >= 300 && f.xy.y < 30); // 300 m along the first street
    await s.feed(fixes.slice(0, driven));
    assert.equal(s.engine.trips.get('T1')?.progress.vehicleId, VEHICLE);
    s.store.instance('T1').vehicleId = VEHICLE_2; // e.g. a driver start on bus 2 in the app
    await s.engine.reload();
    assert.equal(s.engine.trips.get('T1')?.progress.vehicleId, VEHICLE_2);
    const before = s.transitions('T1').length;
    await s.feed(fixes.slice(driven)); // bus 1 keeps driving: no more events from it
    assert.equal(s.transitions('T1').length, before);
  });
});

describe('replay: fourth review findings', () => {
  function withStops(moves: Record<number, XY>): RouteDef {
    const def = germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]);
    def.stops = def.stops.map((x) => (moves[x.sequence] ? { ...x, at: moves[x.sequence] ?? x.at } : x));
    return def;
  }
  async function outbound(def: RouteDef, toM: number): Promise<{ s: Scenario; t: Track }> {
    const s = await Scenario.create(def);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(toM, 30).dwell(5);
    await s.feed(t.fixes);
    return { s, t };
  }
  const at = (t: Track, i: number): Date => new Date(t.time.getTime() + i * 5000);

  it('standing just before the turn with GPS pulled north does not move onto the return street', async () => {
    const { s, t } = await outbound(withStops({ 3: { x: 870, y: 40 } }), 880);
    await s.feed(Array.from({ length: 24 }, (_, i) => ({ t: at(t, i + 1), xy: { x: 880, y: 25 }, speedKmh: 0 })));
    assert.ok(s.store.instance('T1').progressM < 935, String(s.store.instance('T1').progressM));
    assert.notEqual(s.state('T1', 2), 'passed');
    assert.equal(s.state('T1', 3), 'upcoming');
  });

  it('one outlier on the return street, then slow traffic eastwards: no move onto it', async () => {
    const { s, t } = await outbound(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]), 400);
    await s.feed([
      { t: at(t, 1), xy: { x: 445, y: 55 }, speedKmh: 7, course: 90 },
      { t: at(t, 2), xy: { x: 410, y: 10 }, speedKmh: 7, course: 90 },
      { t: at(t, 3), xy: { x: 420, y: 10 }, speedKmh: 7, course: 90 },
      { t: at(t, 4), xy: { x: 430, y: 10 }, speedKmh: 7, course: 90 },
    ]);
    assert.ok(s.store.instance('T1').progressM < 500);
    assert.equal(s.state('T1', 2), 'upcoming');
  });

  it('one outlier, then a standing bus with speed jitter and no course: no move onto the return street', async () => {
    const { s, t } = await outbound(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]), 400);
    await s.feed([
      { t: at(t, 1), xy: { x: 440, y: 55 }, speedKmh: 6 },
      { t: at(t, 2), xy: { x: 405, y: 15 }, speedKmh: 6 },
      { t: at(t, 3), xy: { x: 402, y: 10 }, speedKmh: 0 },
      { t: at(t, 4), xy: { x: 404, y: 12 }, speedKmh: 6 },
    ]);
    assert.ok(s.store.instance('T1').progressM < 500);
    assert.equal(s.state('T1', 3), 'upcoming');
  });

  it('a stop right after the turn: a dwell while the position is held still counts as arrived (5-s tracker)', async () => {
    // Stop 2 at x = 700 on the way out (m = 700), stop 3 just after the turn (m = 990).
    const { s, t } = await outbound(withStops({ 2: { x: 700, y: 0 }, 3: { x: 850, y: 40 } }), 900);
    const tr = new Track(s.shape, t.time, { startM: 900 });
    tr.drive(988, 15).dwell(40).drive(1300, 25);
    await s.feed(tr.fixes);
    assert.equal(s.state('T1', 3), 'departed');
    const ev = s.store.instance('T1').stopEvents.find((e) => e.sequence === 3);
    assert.ok(ev?.arrivedAt);
  });

  it('a stop right after the turn with a 60-s tracker', async () => {
    const def = withStops({ 3: { x: 830, y: 40 } }); // m = 1010
    const s = await Scenario.create(def);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS: 60 });
    t.dwell(180);
    for (const m of [STOP_M[2], 1010, STOP_M[4], STOP_M[5]]) t.drive(m - 5, 30).dwell(120);
    t.goTo({ x: 800, y: 480 }, 10).dwell(120);
    await s.feed(t.fixes);
    assert.deepEqual(s.transitions('T1'), FULL_RUN);
  });

  it('a reload with a snapshot taken just before a start does not undo the start', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30', vehicleId: null }]));
    const fixes = normalRun(s, 'T1').fixes;
    const driven = fixes.findIndex((f) => f.xy.x >= 300 && f.xy.y < 30);
    const startIdx = fixes.findIndex((f) => f.speedKmh > 0);
    await s.feed(fixes.slice(0, startIdx));
    const stale = await s.store.loadSnapshot();
    await s.feed(fixes.slice(startIdx, driven));
    assert.equal(s.store.instance('T1').status, 'active');
    const real = s.store.loadSnapshot.bind(s.store);
    s.store.loadSnapshot = () => Promise.resolve(stale);
    await s.engine.reload();
    s.store.loadSnapshot = real;
    assert.equal(s.engine.trips.get('T1')?.progress.status, 'active');
  });
});

describe('replay: fifth review findings', () => {
  const one = (): RouteDef => germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]);
  const after = (t: Track, i: number): Date => new Date(t.time.getTime() + i * 5000);

  it('GPS drifting 50 m back along the street (or reversing) does not move onto the return street', async () => {
    const s = await Scenario.create(one());
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(400, 30).dwell(5);
    await s.feed(t.fixes);
    await s.feed([
      { t: after(t, 1), xy: { x: 368, y: 0 }, speedKmh: 0 },
      { t: after(t, 2), xy: { x: 358, y: 0 }, speedKmh: 7 },
      { t: after(t, 3), xy: { x: 346, y: 0 }, speedKmh: 7 },
      { t: after(t, 4), xy: { x: 340, y: 15 }, speedKmh: 7 },
    ]);
    assert.ok(s.store.instance('T1').progressM < 450);
    assert.deepEqual(s.transitions('T1').filter((x) => !x.startsWith('1:')), []);
  });

  it('one fix 30 m too far ahead, then a dwell just short of the stop: arrived', async () => {
    const def = one();
    def.stops = def.stops.map((x) => (x.sequence === 2 ? { ...x, at: { x: 600, y: 0 } } : x));
    const s = await Scenario.create(def);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(560, 30);
    await s.feed(t.fixes);
    await s.feed([{ t: after(t, 1), xy: { x: 632, y: 0 }, speedKmh: 8 }]);
    await s.feed(Array.from({ length: 30 }, (_, i) => ({ t: after(t, i + 2), xy: { x: 595, y: 0 }, speedKmh: 0 })));
    assert.equal(s.state('T1', 2), 'arrived');
    assert.equal(s.store.instance('T1').offRouteSince, null, 'not off route while standing at the stop');
  });

  for (const intervalS of [5, 60]) {
    it(`a final stop 80 m after a U-turn (${intervalS}-s tracker): arrived, departed, trip completed`, async () => {
      const def: RouteDef = {
        shape: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 860, y: 40 }],
        stops: [
          { sequence: 1, at: { x: 0, y: 0 }, arrivalOffsetS: 0, departureOffsetS: 60 },
          { sequence: 2, at: { x: 500, y: 0 }, arrivalOffsetS: 180, departureOffsetS: 200 },
          { sequence: 3, at: { x: 860, y: 40 }, arrivalOffsetS: 400, departureOffsetS: 400 },
        ],
        trips: [{ id: 'T1', serviceDate: DATE, start: '07:30' }],
      };
      const s = await Scenario.create(def);
      const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS });
      t.dwell(180).drive(495, 30).dwell(intervalS === 5 ? 30 : 120).drive(s.shape.length - 2, 20).dwell(120);
      t.goTo({ x: 860, y: 200 }, 20).dwell(intervalS * 2);
      await s.feed(t.fixes);
      assert.deepEqual(s.transitions('T1'), ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed']);
      assert.equal(s.store.instance('T1').status, 'completed');
    });
  }
});

describe('replay: sixth review findings', () => {
  const hairpin = (): RouteDef => ({
    // Out along y = 0, a 20 m wide U-turn, back along y = 20, then north.
    shape: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 400 }],
    stops: [
      { sequence: 1, at: { x: 0, y: 0 }, arrivalOffsetS: 0, departureOffsetS: 60 },
      { sequence: 2, at: { x: 500, y: 0 }, arrivalOffsetS: 180, departureOffsetS: 200 },
      { sequence: 3, at: { x: 920, y: 20 }, arrivalOffsetS: 360, departureOffsetS: 390 }, // 80 m after the turn
      { sequence: 4, at: { x: 0, y: 390 }, arrivalOffsetS: 720, departureOffsetS: 720 },
    ],
    trips: [{ id: 'T1', serviceDate: DATE, start: '07:30' }],
  });

  for (const intervalS of [5, 15, 60]) {
    for (const bias of [10, 15]) {
      it(`a stop 80 m after a 20 m hairpin, GPS ${bias} m towards the way out (${intervalS}-s tracker): arrived`, async () => {
        const s = await Scenario.create(hairpin());
        const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS });
        const pulled = (): XY => ({ x: 0, y: -bias });
        t.dwell(180).drive(495, 30).dwell(60).drive(1020, 25);
        t.drive(1095, 20, pulled).dwell(60).drive(1600, 25, pulled).drive(2010, 25);
        await s.feed(t.fixes);
        assert.equal(s.state('T1', 3), 'departed', s.transitions('T1').join(' '));
        assert.ok(s.store.instance('T1').stopEvents.find((e) => e.sequence === 3)?.arrivedAt);
      });
    }
  }

  it('one outlier at the end of the route, then a side street: the final stop is not reached', async () => {
    const def: RouteDef = {
      shape: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 860, y: 40 }],
      stops: [
        { sequence: 1, at: { x: 0, y: 0 }, arrivalOffsetS: 0, departureOffsetS: 60 },
        { sequence: 2, at: { x: 500, y: 0 }, arrivalOffsetS: 180, departureOffsetS: 200 },
        { sequence: 3, at: { x: 860, y: 40 }, arrivalOffsetS: 400, departureOffsetS: 400 },
      ],
      trips: [{ id: 'T1', serviceDate: DATE, start: '07:30' }],
    };
    const s = await Scenario.create(def);
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 120_000), { intervalS: 15 });
    t.dwell(180).drive(495, 30).dwell(60).drive(850, 25);
    await s.feed(t.fixes);
    const side = new Track(s.shape, t.time, { startXY: { x: 862, y: 62 }, intervalS: 15 });
    side.goTo({ x: 862, y: 61 }, 2).goTo({ x: 850, y: -150 }, 20).dwell(60);
    await s.feed(side.fixes);
    assert.equal(s.state('T1', 3), 'upcoming');
    assert.equal(s.store.instance('T1').status, 'active');
  });
});
