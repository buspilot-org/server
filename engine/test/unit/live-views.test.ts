/** Serialisation of the live API (src/live/views.ts) on a hand-made directory. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Directory } from '../../src/live/directory.ts';
import type { LiveInstanceRow, LiveSnapshot, VehicleFix } from '../../src/live/types.ts';
import { MAX_STOP_VISITS, routeView, stopView, tripOnlyView, type ViewContext } from '../../src/live/views.ts';

const OP = 'op';
const NOW = new Date('2026-11-27T00:00:00Z'); // 09:00 JST
const MEMBER = 'member';
const MAPPER = 'mapper';

function instance(id: string, over: Partial<LiveInstanceRow> = {}): LiveInstanceRow {
  return {
    id, operatorId: OP, kind: 'scheduled', tripId: 't', patternId: 'p', routeId: 'r', serviceDate: '2026-11-27', status: 'active',
    vehicleId: 'bus', visibleUntil: null, title: null, startedAt: NOW, endedAt: null, offRouteSince: null,
    stopEvents: [
      { sequence: 1, state: 'departed', arrivedAt: NOW, departedAt: NOW, passedAt: null, eta: null },
      { sequence: 2, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: new Date(NOW.getTime() + 15 * 60_000) },
      { sequence: 3, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: new Date(NOW.getTime() + 25 * 60_000) },
    ],
    plannedStops: [],
    ...over,
  };
}

function snapshot(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    loadedAt: NOW,
    operators: [{ id: OP, slug: 'op', name: { en: 'Op' }, timezone: 'Asia/Tokyo', defaultVisibility: 'invited_eta' }],
    routes: [{ id: 'r', operatorId: OP, slug: 'r', name: { en: 'R' }, shortName: null, color: null, textColor: null, visibility: 'invited_map', active: true }],
    stops: ['s1', 's2', 's3'].map((id, i) => ({ id, operatorId: OP, slug: id, name: { en: id }, lon: 135 + i / 100, lat: 34.7 })),
    patterns: [{ id: 'p', operatorId: OP, routeId: 'r' }],
    patternStops: [1, 2, 3].map((n) => ({ patternId: 'p', sequence: n, stopId: `s${n}`, arrivalOffsetS: (n - 1) * 600, departureOffsetS: (n - 1) * 600 })),
    // 09:00 JST start.
    trips: [{ id: 't', patternId: 'p', startTimeS: 9 * 3600, headsign: { en: 'School' }, vehicleId: null }],
    instances: [instance('ti')],
    staffRoles: [],
    driverVehicles: [],
    memberships: [{ deviceId: MEMBER, audienceId: 'eta' }, { deviceId: MAPPER, audienceId: 'map' }],
    audienceRoutes: [{ audienceId: 'eta', routeId: 'r', canSeeMap: false }, { audienceId: 'map', routeId: 'r', canSeeMap: true }],
    tripAudiences: [],
    subscriptions: [{ deviceId: MEMBER, stopId: 's3', patternId: 'p', tripInstanceId: null }],
    followedStops: [{ deviceId: MEMBER, operatorId: OP, stopId: 's3' }],
    ...over,
  };
}

function ctx(s: LiveSnapshot, fix: VehicleFix | undefined): ViewContext {
  return { dir: new Directory(s), runtime: () => undefined, fix: () => fix, now: NOW, staleAfterS: 120 };
}

const fixFor = (tripInstanceId: string | null): VehicleFix => ({
  vehicleId: 'bus', operatorId: OP, tripInstanceId, lon: 135.0123456789, lat: 34.70001, speedKmh: 23.456, heading: 90.4, accuracyM: 7.6, at: NOW,
});

describe('live views', () => {
  it('scheduled times from the trip start and offsets; delay from the next stop', () => {
    const v = routeView(ctx(snapshot(), undefined), { uid: MEMBER }, 'r');
    const trip = v?.trips[0];
    assert.ok(trip);
    assert.equal(trip.scheduledStart, '2026-11-27T00:00:00.000Z');
    assert.equal(trip.scheduledEnd, '2026-11-27T00:20:00.000Z');
    assert.deepEqual(trip.stops.map((x) => x.scheduledArrival), ['2026-11-27T00:00:00.000Z', '2026-11-27T00:10:00.000Z', '2026-11-27T00:20:00.000Z']);
    assert.equal(trip.delayS, 300);
    assert.equal(trip.headsign?.en, 'School');
  });

  it('arrival-time member: only the followed stop has a location', () => {
    const trip = routeView(ctx(snapshot(), undefined), { uid: MEMBER }, 'r')?.trips[0];
    assert.deepEqual(trip?.stops.map((x) => x.stop?.location !== null), [false, false, true]);
  });

  it('the position only comes from a fix the engine linked to this trip (and is rounded)', () => {
    // Not followed by the engine (no runtime): never a position.
    assert.equal(routeView(ctx(snapshot(), fixFor('ti')), { uid: MAPPER }, 'r')?.trips[0]?.vehicle, null);
    const withRuntime = (fix: VehicleFix): ViewContext => {
      const c = ctx(snapshot(), fix);
      const progress = { status: 'active', vehicleId: 'bus', startedAt: NOW, endedAt: null, offRouteSince: null, lastFixAt: NOW, stops: snapshot().instances[0]?.stopEvents ?? [] };
      return { ...c, runtime: (id) => (id === 'ti' ? { progress } as never : undefined) };
    };
    assert.equal(routeView(withRuntime(fixFor('other-trip')), { uid: MAPPER }, 'r')?.trips[0]?.vehicle, null);
    assert.deepEqual(routeView(withRuntime(fixFor('ti')), { uid: MAPPER }, 'r')?.trips[0]?.vehicle, {
      lon: 135.012346, lat: 34.70001, heading: 90, speedKmh: 23.5, accuracyM: 8, recordedAt: NOW.toISOString(),
    });
    assert.equal(routeView(withRuntime(fixFor('ti')), { uid: MEMBER }, 'r')?.trips[0]?.vehicle, null, 'arrival-time level');
  });

  it('only today\'s trips (operator time zone) and active ones', () => {
    const s = snapshot({
      instances: [
        instance('yesterday', { serviceDate: '2026-11-26', status: 'completed' }),
        instance('yesterday-late', { serviceDate: '2026-11-26', status: 'active' }),
        instance('tomorrow', { serviceDate: '2026-11-28', status: 'planned' }),
        instance('today', { status: 'planned' }),
      ],
    });
    assert.deepEqual(routeView(ctx(s, undefined), { uid: MEMBER }, 'r')?.trips.map((t) => t.id).sort(), ['today', 'yesterday-late']);
  });

  it('a stop lists the visits around now, at most MAX_STOP_VISITS', () => {
    const many = Array.from({ length: 80 }, (_, i) => instance(`ti-${String(i).padStart(2, '0')}`, {
      status: 'planned',
      stopEvents: [],
      tripId: `t${i}`,
    }));
    const trips = many.map((m, i) => ({ id: m.tripId ?? '', patternId: 'p', startTimeS: 6 * 3600 + i * 600, headsign: null, vehicleId: null }));
    const v = stopView(ctx(snapshot({ instances: many, trips }), undefined), { uid: MEMBER }, 's1');
    assert.ok(v);
    assert.equal(v.arrivals.length, MAX_STOP_VISITS);
    // 06:00 + i·10 min; now is 09:00, so trip 18 is the next one; five before it are kept.
    assert.equal(v.arrivals[0]?.tripInstanceId, 'ti-13');
    assert.equal(v.stop.location, null);
  });

  it('a live trip on a pattern for its own audience: stop times, but no stops RLS hides', () => {
    const s = snapshot({
      instances: [instance('live', { kind: 'live', tripId: null, title: { en: 'Tour' } })],
      memberships: [{ deviceId: 'tourist', audienceId: 'tour' }],
      tripAudiences: [{ tripInstanceId: 'live', audienceId: 'tour', canSeeMap: false }],
    });
    const v = tripOnlyView(ctx(s, undefined), { uid: 'tourist' }, 'live');
    assert.ok(v);
    assert.equal(v.route, null);
    assert.deepEqual(v.trip.stops.map((x) => [x.sequence, x.stop, x.state]), [[1, null, 'departed'], [2, null, 'upcoming'], [3, null, 'upcoming']]);
    assert.doesNotMatch(JSON.stringify(v), /"s[123]"/);
  });

  it('no trips from before today on the trip endpoint (no history)', () => {
    const s = snapshot({ instances: [instance('old', { serviceDate: '2026-11-25', status: 'completed' })] });
    assert.equal(tripOnlyView(ctx(s, undefined), { uid: MEMBER }, 'old'), null);
    const future = snapshot({ instances: [instance('next', { serviceDate: '2026-11-29', status: 'planned' })] });
    assert.equal(tripOnlyView(ctx(future, undefined), { uid: MEMBER }, 'next')?.trip.id, 'next', 'a planned future trip is shown');
  });

  it('a trip cancelled in the database is cancelled, even while the engine still runs it', () => {
    const s = snapshot({ instances: [instance('ti', { status: 'cancelled' })] });
    const c = ctx(s, fixFor('ti'));
    const progress = { status: 'active', vehicleId: 'bus', startedAt: NOW, endedAt: null, offRouteSince: null, lastFixAt: NOW, stops: s.instances[0]?.stopEvents ?? [] };
    const trip = routeView({ ...c, runtime: () => ({ progress }) as never }, { uid: MAPPER }, 'r')?.trips[0];
    assert.ok(trip);
    assert.equal(trip.status, 'cancelled');
    assert.equal(trip.vehicle, null);
    assert.ok(trip.stops.every((x) => x.eta === null));
  });

  it('a trip reassigned to another vehicle by staff shows no position of the old one', () => {
    const s = snapshot({ instances: [instance('ti', { vehicleId: 'bus-2' })] });
    const c = ctx(s, fixFor('ti'));
    const progress = { status: 'active', vehicleId: 'bus', startedAt: NOW, endedAt: null, offRouteSince: null, lastFixAt: NOW, stops: s.instances[0]?.stopEvents ?? [] };
    assert.equal(routeView({ ...c, runtime: () => ({ progress }) as never }, { uid: MAPPER }, 'r')?.trips[0]?.vehicle, null);
  });

  it('unknown or invisible: null (404)', () => {
    const c = ctx(snapshot(), undefined);
    assert.equal(routeView(c, { uid: 'stranger' }, 'r'), null);
    assert.equal(routeView(c, { uid: null }, 'r'), null);
    assert.equal(stopView(c, { uid: 'stranger' }, 's1'), null);
    assert.equal(routeView(c, { uid: MEMBER }, 'nope'), null);
  });
});
