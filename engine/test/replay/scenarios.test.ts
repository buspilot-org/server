/**
 * Replay scenarios from engine.md ("Testing") and arrival-alerts.md
 * ("Examples"), with synthetic tracks and a fake clock.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { XY } from '../../src/geo/plane.ts';
import { Scenario, Track, VEHICLE, type RouteDef, type TripDef } from './harness.ts';

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

  it('after a data gap, a jump is accepted once three consistent positions confirm it', async () => {
    const s = await Scenario.create(germanSchool([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const t = new Track(s.shape, new Date(s.tripStart('T1').getTime() - 60_000));
    t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(1000, 30);
    t.gap(120);
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
    await s.feed([{ t: new Date(t.time.getTime() + 5000), xy: { x: 300, y: 340 }, speedKmh: 30 }]);
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
