/**
 * Live trips end to end (engine + alert dispatcher, in-memory store):
 * a live trip on a pattern, one with planned stops (an itinerary), one with
 * neither; precedence against a scheduled trip on the same vehicle; alerts
 * for live-trip subscriptions, cancellation and visible_until.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serviceTime } from '../../src/core/time.ts';
import type { XY } from '../../src/geo/plane.ts';
import { ROUTE, Scenario, TZ, Track, VEHICLE, VEHICLE_2, subscription } from './harness.ts';
import { EXAMPLE_M, exampleRoute, exampleRun } from './routes.ts';

const DATE = '2026-11-24';
const local = (hhmm: string, s = 0): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  return serviceTime(DATE, (h ?? 0) * 3600 + (m ?? 0) * 60 + s, TZ);
};

/** The example route's six stops driven from `start` (as exampleRun, without a schedule). */
function runPattern(s: Scenario, start: Date): Track {
  const t = new Track(s.shape, new Date(start.getTime() - 60_000));
  t.dwell(65);
  for (const m of [EXAMPLE_M[2], EXAMPLE_M[3], EXAMPLE_M[4], EXAMPLE_M[5], EXAMPLE_M[6]]) t.drive(m - 2, 30).dwell(30);
  t.goTo({ x: 4000, y: 300 }, 15);
  return t;
}

const ALL_SIX = ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed', '4:arrived', '4:departed', '5:arrived', '5:departed', '6:arrived', '6:departed'];

// A tour without a route: hotel (1) → temple (2, 09:10–09:20) → museum (3, 09:30).
const HOTEL: XY = { x: 0, y: 2000 };
const TEMPLE: XY = { x: 2000, y: 2000 };
const MUSEUM: XY = { x: 2000, y: 3500 };
const tourStops = [
  { sequence: 1, at: HOTEL, plannedDeparture: local('09:00') },
  { sequence: 2, at: TEMPLE, plannedArrival: local('09:10'), plannedDeparture: local('09:20') },
  { sequence: 3, at: MUSEUM, plannedArrival: local('09:30') },
];
const liveSub = (id: string, seq: number, over = {}) =>
  subscription(id, seq, { patternId: null, tripInstanceId: 'L2', routeId: null, routeName: null, ...over });

function tourRun(s: Scenario): Track {
  const t = new Track(s.shape, local('08:58'), { startXY: HOTEL, intervalS: 10 });
  // Leaves at 09:00, at the temple from about 09:04 to 09:20.
  t.dwell(120).goTo(TEMPLE, 30).dwell(16 * 60).goTo(MUSEUM, 30).dwell(60);
  return t;
}

describe('live trip on a pattern', () => {
  it('is followed like a scheduled trip: auto start on the route, stop events created by the engine, completed at the end', async () => {
    const s = await Scenario.create(exampleRoute([]));
    s.addLiveTrip({ id: 'L1', serviceDate: DATE, onPattern: true });
    await s.reload();
    assert.equal(s.store.instance('L1').stopEvents.length, 0);
    await s.feed(runPattern(s, local('10:00')).fixes);
    const row = s.store.instance('L1');
    assert.equal(row.status, 'completed');
    assert.equal(row.vehicleId, VEHICLE);
    assert.equal(row.startedBy, 'driver');
    assert.deepEqual(s.transitions('L1'), ALL_SIX);
    assert.equal(row.stopEvents.length, 6);
  });

  it('ETAs count from the actual start (no start time of its own)', async () => {
    const s = await Scenario.create(exampleRoute([]));
    s.addLiveTrip({ id: 'L1', serviceDate: DATE, onPattern: true });
    await s.reload();
    const fixes = runPattern(s, local('15:00')).fixes;
    await s.feed(fixes.slice(0, 20));
    const tr = s.engine.trips.get('L1');
    assert.equal(tr?.progress.status, 'active');
    const startedAt = tr.progress.startedAt;
    assert.ok(startedAt);
    // Stop 6 is 960 s from the start in the pattern; the bus is roughly on time.
    const eta6 = tr.progress.stops.find((x) => x.sequence === 6)?.eta;
    assert.ok(eta6);
    const offset = (eta6.getTime() - startedAt.getTime()) / 1000;
    assert.ok(offset > 800 && offset < 1100, `ETA ${offset} s after the start`);
  });

  it('alerts the pattern subscribers with the live trip title and the trip instance in the data', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, { subscriptions: [subscription('A', 4, { language: 'ja' })] });
    s.addLiveTrip({ id: 'L1', serviceDate: DATE, onPattern: true, title: { ja: 'アウェー戦', en: 'Away game' } });
    await s.reload();
    await s.feed(runPattern(s, local('10:00')).fixes);
    assert.deepEqual(s.sender.kinds(), ['approaching@4']);
    const m = s.sender.sent[0];
    assert.equal(m?.payload.notification.title, 'アウェー戦');
    assert.equal(m.payload.data.trip_instance_id, 'L1');
    assert.equal(m.payload.data.trip_kind, 'live');
    assert.equal(m.payload.data.route_id, ROUTE);
  });
});

describe('precedence on one vehicle', () => {
  it('both due at once: a live trip with a first planned time starts, the scheduled trip stays planned', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({
      id: 'L2', serviceDate: DATE, stops: [
        { sequence: 1, at: { x: 0, y: 0 }, plannedDeparture: local('07:35') },
        { sequence: 2, at: { x: 2400, y: 0 }, plannedArrival: local('07:45') },
        { sequence: 3, at: { x: 4000, y: 0 }, plannedArrival: local('07:50') },
      ],
    });
    await s.reload();
    const run = exampleRun(s, 'T1');
    await s.feed(run.fixes);
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.deepEqual(s.transitions('T1'), []);
    assert.equal(s.store.instance('L2').startedAt?.getTime(), run.fixes[0]?.t.getTime());
    assert.deepEqual(s.transitions('L2').slice(0, 4), ['1:arrived', '1:departed', '2:arrived', '2:departed']);
  });

  it('a live trip without a first planned time, saved ahead, yields: the due scheduled trip runs; the live trip starts after it', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L1', serviceDate: DATE, onPattern: true, createdAt: local('06:00') });
    await s.reload();
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.equal(s.store.instance('T1').status, 'completed');
    assert.deepEqual(s.transitions('T1'), ALL_SIX);
    assert.equal(s.store.instance('L1').status, 'planned');
    // Later that day the bus drives the route again: now the live trip starts.
    await s.feed(runPattern(s, local('10:00')).fixes);
    assert.equal(s.store.instance('L1').status, 'completed');
    assert.deepEqual(s.transitions('L1'), ALL_SIX);
  });

  it('an untimed live trip waits while a scheduled trip of the vehicle is due, even one that never starts, and starts once its window has closed', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L3', serviceDate: DATE, createdAt: local('07:00') }); // Position only.
    await s.reload();
    // Parked at the depot all morning: T1 (window 07:15–08:16) never starts.
    await s.feed(new Track(s.shape, local('07:16'), { intervalS: 60 }).dwell(80 * 60).fixes);
    assert.equal(s.store.instance('T1').status, 'planned');
    const l3 = s.store.instance('L3');
    assert.equal(l3.status, 'active');
    assert.ok(l3.startedAt && l3.startedAt > local('08:16') && l3.startedAt <= local('08:18'), `started ${l3.startedAt?.toISOString() ?? ''}`);
  });

  it('a trip any vehicle may run does not hold back an untimed live trip', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30', vehicleId: null }]));
    s.addLiveTrip({ id: 'L3', serviceDate: DATE, createdAt: local('07:00') });
    await s.reload();
    await s.feed(new Track(s.shape, local('07:20'), { intervalS: 60 }).dwell(120).fixes);
    assert.equal(s.store.instance('L3').status, 'active');
  });

  it('a running scheduled trip is not pre-empted; the live trip starts once it has ended', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    const run = exampleRun(s, 'T1');
    await s.feed(run.fixes.slice(0, 30));
    assert.equal(s.store.instance('T1').status, 'active');
    // Staff save a trip (planned stops, no times) for the same vehicle while the morning run is under way.
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops.map(({ sequence, at }) => ({ sequence, at })), createdAt: local('07:35') });
    await s.reload();
    await s.feed(run.fixes.slice(30));
    assert.equal(s.store.instance('T1').status, 'completed');
    assert.deepEqual(s.transitions('T1'), ALL_SIX);
    // The live trip started with the first fix after the scheduled trip ended, not before.
    const l2 = s.store.instance('L2');
    assert.equal(l2.status, 'active');
    const t1End = s.store.instance('T1').endedAt;
    assert.ok(t1End && l2.startedAt && l2.startedAt > t1End);
  });

  it('a live trip that has reached a stop keeps its vehicle: no scheduled trip starts on it', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    // No planned times; its first stop is the depot.
    s.addLiveTrip({ id: 'L3', serviceDate: DATE, stops: [{ sequence: 1, at: { x: 0, y: 0 } }, { sequence: 2, at: { x: 0, y: 5000 } }] });
    await s.reload();
    // Started at 06:30, when no scheduled trip of the vehicle was due, and arrived at the depot stop.
    await s.feed(new Track(s.shape, local('06:30'), { intervalS: 60 }).dwell(60).fixes);
    assert.equal(s.state('L3', 1), 'arrived');
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.equal(s.store.instance('L3').status, 'active');
    assert.equal(s.store.instance('T1').status, 'planned');
    assert.deepEqual(s.store.releases, []);
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, 'L3');
  });

  it('06:00 saved, 06:30 depot fix, 07:30 school run: the school run takes over, the live trip starts again afterwards, no alert twice', async () => {
    const STADIUM: XY = { x: 0, y: 10_000 };
    // A rider follows the stadium (60 minutes before: the ETA from the depot is within that at once).
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]), {}, {
      subscriptions: [liveSub('A', 1, { tripInstanceId: 'L6', triggerValue: 60 })],
    });
    const seen: string[] = [];
    s.observers.push({
      tripUpdated: (u) => { if (u.instance.id === 'L6' && seen.at(-1) !== u.progress.status) seen.push(u.progress.status); },
      tripsReloaded: () => undefined,
    });
    await s.restart();
    s.addLiveTrip({ id: 'L6', serviceDate: DATE, createdAt: local('06:00'), stops: [{ sequence: 1, at: STADIUM }, { sequence: 2, at: { x: 0, y: 12_000 } }] });
    await s.reload();

    // 06:30: the bus is switched on at the depot. No scheduled trip is due: the live trip starts.
    await s.feed(new Track(s.shape, local('06:30'), { intervalS: 60 }).dwell(120).fixes);
    assert.equal(s.store.instance('L6').status, 'active');
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, 'L6');
    assert.deepEqual(s.sender.kinds(), ['approaching@1']);

    // 07:15 the school run is due: it takes over at the next position.
    const run = exampleRun(s, 'T1');
    await s.feed(run.fixes.slice(0, 1));
    const l6 = s.store.instance('L6');
    assert.equal(l6.status, 'planned');
    assert.equal(l6.vehicleId, VEHICLE);
    assert.equal(l6.progressM, 0);
    assert.equal(l6.startedAt, null);
    assert.ok(l6.stopEvents.every((e) => e.state === 'upcoming' && e.eta === null));
    assert.deepEqual(s.store.releases, ['L6']);
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, null, 'vehicle_state no longer linked to the live trip');

    await s.feed(run.fixes.slice(1));
    assert.equal(s.store.instance('T1').status, 'completed');
    assert.deepEqual(s.transitions('T1'), ALL_SIX);
    // Once the school run has ended, the live trip starts again and is followed to the stadium.
    const restarted = s.store.instance('L6');
    assert.equal(restarted.status, 'active');
    const t1End = s.store.instance('T1').endedAt;
    assert.ok(t1End && restarted.startedAt && restarted.startedAt > t1End);
    await s.feed(new Track(s.shape, run.time, { startXY: { x: 4000, y: 300 }, intervalS: 10 }).goTo(STADIUM, 40).dwell(60).fixes);
    assert.equal(s.state('L6', 1), 'arrived');
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, 'L6');

    // Alerts: the approaching alert of the early start is not sent again, and
    // "at your stop" shares its key (exactly once per subscription, trip, stop, kind).
    assert.deepEqual(s.sender.kinds(), ['approaching@1']);
    assert.deepEqual(s.store.deliveries.map((d) => `${d.tripInstanceId}:${d.stopSequence}:${d.kind}`), ['L6:1:approaching']);
    assert.deepEqual(seen, ['active', 'planned', 'active']);
  });

  it('a reload whose snapshot was read before the release does not undo it', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L7', serviceDate: DATE, createdAt: local('06:00') });
    await s.reload();
    await s.feed(new Track(s.shape, local('06:30'), { intervalS: 60 }).dwell(60).fixes);
    const stale = structuredClone(s.store.rows);
    const run = exampleRun(s, 'T1');
    await s.feed(run.fixes.slice(0, 1));
    assert.deepEqual(s.store.releases, ['L7']);
    const load = s.store.loadSnapshot.bind(s.store);
    s.store.loadSnapshot = () => Promise.resolve(structuredClone(stale));
    await s.reload();
    s.store.loadSnapshot = load;
    assert.equal(s.engine.trips.get('L7')?.progress.status, 'planned');
    await s.feed(run.fixes.slice(1));
    assert.deepEqual(s.transitions('T1'), ALL_SIX);
    assert.equal(s.store.instance('L7').status, 'active', 'started again after the school run');
  });

  it('a release the database refuses (staff cancelled the live trip meanwhile) writes no scheduled start with it', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L7', serviceDate: DATE, createdAt: local('06:00') });
    await s.reload();
    await s.feed(new Track(s.shape, local('06:30'), { intervalS: 60 }).dwell(60).fixes);
    s.store.instance('L7').status = 'cancelled'; // Not reloaded yet.
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.store.releases, []);
    assert.equal(s.engine.trips.get('L7')?.progress.status, 'cancelled', 'taken from the database at once');
    assert.deepEqual(s.transitions('T1'), ALL_SIX, 'the school run is followed');
  });

  it('a position-only live trip started early is taken over too; a timed one never', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L7', serviceDate: DATE, createdAt: local('06:00') });
    await s.reload();
    await s.feed(new Track(s.shape, local('06:30'), { intervalS: 60 }).dwell(60).fixes);
    assert.equal(s.store.instance('L7').status, 'active');
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.deepEqual(s.transitions('T1'), ALL_SIX);
    assert.deepEqual(s.store.releases, ['L7']);
    assert.equal(s.store.instance('L7').status, 'active', 'started again after the school run');

    const s2 = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s2.addLiveTrip({ id: 'L8', serviceDate: DATE, stops: [{ sequence: 1, at: { x: 0, y: 10_000 }, plannedDeparture: local('06:40') }, { sequence: 2, at: { x: 0, y: 12_000 } }] });
    await s2.reload();
    await s2.feed(new Track(s2.shape, local('06:30'), { intervalS: 60 }).dwell(60).fixes);
    await s2.feed(exampleRun(s2, 'T1').fixes);
    assert.deepEqual(s2.store.releases, []);
    assert.equal(s2.store.instance('L8').status, 'active');
    assert.equal(s2.store.instance('T1').status, 'planned');
  });

  it('a live trip of another vehicle, or without a vehicle, is not started by this one', async () => {
    const s = await Scenario.create(exampleRoute([{ id: 'T1', serviceDate: DATE, start: '07:30' }]));
    s.addLiveTrip({ id: 'L4', serviceDate: DATE, onPattern: true, vehicleId: VEHICLE_2 });
    s.addLiveTrip({ id: 'L5', serviceDate: DATE, onPattern: true, vehicleId: null });
    await s.reload();
    await s.feed(exampleRun(s, 'T1').fixes);
    assert.equal(s.store.instance('T1').status, 'completed');
    assert.equal(s.store.instance('L4').status, 'planned');
    assert.equal(s.store.instance('L5').status, 'planned');
  });

  it('a timed live trip does not start before its window (first planned time − tripWindowBeforeS)', async () => {
    const s = await Scenario.create(exampleRoute([]));
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops });
    await s.reload();
    const t = new Track(s.shape, local('08:30'), { startXY: HOTEL, intervalS: 30 }).dwell(10 * 60);
    await s.feed(t.fixes);
    assert.equal(s.store.instance('L2').status, 'planned');
    await s.feed(new Track(s.shape, local('08:45'), { startXY: HOTEL, intervalS: 30 }).dwell(60).fixes);
    assert.equal(s.store.instance('L2').status, 'active');
    assert.equal(s.state('L2', 1), 'arrived');
  });
});

describe('live trip with planned stops (itinerary)', () => {
  it('stop events in order, progress, completion; alerts for subscribers of its planned stops', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, {
      subscriptions: [liveSub('A', 2), liveSub('B', 3, { trigger: 'stops', triggerValue: 1, language: 'de' })],
    });
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops, title: { ja: '京都ツアー', en: 'Kyoto tour', de: 'Kyoto-Tour' } });
    await s.reload();
    await s.feed(tourRun(s).fixes);
    assert.deepEqual(s.transitions('L2'), ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived']);
    assert.equal(s.store.instance('L2').status, 'active', 'the last stop stays arrived until the bus leaves it');
    assert.equal(Math.round(s.store.instance('L2').progressM), 3500);
    assert.deepEqual(s.sender.kinds(), ['approaching@2', 'approaching@3']);
    const [a, b] = s.sender.sent;
    assert.equal(a?.payload.notification.title, 'Kyoto tour');
    assert.equal(a.payload.data.trip_instance_id, 'L2');
    assert.equal(a.payload.data.pattern_id, '');
    assert.equal(a.payload.data.route_id, '');
    assert.equal(a.payload.data.trip_kind, 'live');
    assert.equal(b?.payload.notification.title, 'Kyoto-Tour');
    assert.equal(s.store.deliveries.length, 2);
    // Exactly once: the same positions again after a restart send nothing more.
    await s.restart();
    await s.feed(tourRun(s).fixes);
    assert.equal(s.sender.sent.length, 2);
  });

  it('delayed is measured against the planned arrival, then approaching', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, { subscriptions: [liveSub('A', 2, { trigger: 'minutes', triggerValue: 1 })] });
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops });
    await s.reload();
    // 14 min late leaving the hotel: delayed first (ETA ≥ 10 min after the planned 09:10), then approaching.
    const t = new Track(s.shape, local('09:14'), { startXY: HOTEL, intervalS: 10 });
    t.dwell(60).goTo(TEMPLE, 30).dwell(60);
    await s.feed(t.fixes);
    assert.deepEqual(s.sender.kinds(), ['delayed@2', 'approaching@2']);
  });

  it('a planned stop added while the trip runs is followed; reached stops keep their state', async () => {
    const s = await Scenario.create(exampleRoute([]));
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops });
    await s.reload();
    const run = tourRun(s);
    const half = run.fixes.findIndex((f) => f.t >= local('09:15'));
    await s.feed(run.fixes.slice(0, half));
    assert.equal(s.state('L2', 2), 'arrived');
    const row = s.store.instance('L2');
    const ll = s.plane.toLonLat({ x: 0, y: 3500 });
    row.plannedStops.push({ sequence: 4, lon: ll.lon, lat: ll.lat, plannedArrival: local('09:45'), plannedDeparture: null });
    row.stopEvents.push({ sequence: 4, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null });
    await s.reload();
    await s.feed(run.fixes.slice(half));
    await s.feed(new Track(s.shape, run.time, { startXY: MUSEUM, intervalS: 10 }).goTo({ x: 0, y: 3500 }, 30).dwell(60).fixes);
    assert.deepEqual(s.transitions('L2'), ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed', '4:arrived']);
  });

  it('cancelled by staff: a cancellation alert for every stop not yet served, with the live text', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, { subscriptions: [liveSub('A', 2), liveSub('B', 3, { language: 'ja' })] });
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops });
    await s.reload();
    s.clock.set(local('08:00'));
    s.store.instance('L2').status = 'cancelled';
    await s.reload();
    assert.deepEqual(s.sender.kinds().sort(), ['cancelled@2', 'cancelled@3']);
    const en = s.sender.sent.find((m) => m.payload.data.subscription_id === 'A');
    const ja = s.sender.sent.find((m) => m.payload.data.subscription_id === 'B');
    assert.equal(en?.payload.notification.body, 'This trip is cancelled.');
    assert.equal(en.payload.notification.title, 'Away game');
    assert.equal(ja?.payload.notification.body, 'この運行は中止になりました。');
    // Once: another reload sends nothing.
    await s.reload();
    assert.equal(s.sender.sent.length, 2);
  });

  it('visible_until: the engine stops following the trip then, and no alerts go out after it', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, { subscriptions: [liveSub('A', 3)] });
    s.addLiveTrip({ id: 'L2', serviceDate: DATE, stops: tourStops, visibleUntil: local('09:15') });
    await s.reload();
    await s.feed(tourRun(s).fixes, { tickEveryS: 60 });
    const row = s.store.instance('L2');
    assert.equal(row.status, 'completed');
    assert.ok(row.endedAt && row.endedAt <= new Date(local('09:15').getTime() + 30_000));
    assert.equal(s.state('L2', 3), 'upcoming');
    assert.deepEqual(s.sender.kinds(), []);
  });
});

describe('live trip without route or planned stops', () => {
  it('position only: linked in vehicle_state, no stop events, no alerts; completed when its day is over', async () => {
    const s = await Scenario.create(exampleRoute([]), {}, { subscriptions: [subscription('A', 2)] });
    s.addLiveTrip({ id: 'L3', serviceDate: DATE });
    await s.reload();
    await s.feed(runPattern(s, local('10:00')).fixes);
    assert.equal(s.store.instance('L3').status, 'active');
    assert.equal(s.store.vehicleState.get(VEHICLE)?.tripInstanceId, 'L3');
    assert.deepEqual(s.transitions('L3'), []);
    assert.deepEqual(s.sender.kinds(), []);
    await s.tickAt(local('24:31'));
    assert.equal(s.store.instance('L3').status, 'completed');
  });
});
