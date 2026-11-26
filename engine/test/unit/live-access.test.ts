/**
 * The live API's access rules (src/live/access.ts) against the cases of the
 * RLS migrations. The DB parity test checks the same against Postgres.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccessIndex } from '../../src/live/access.ts';
import type { LiveInstanceRow, LiveSnapshot } from '../../src/live/types.ts';

const NOW = new Date('2026-11-27T01:00:00Z');
const OP = 'op';
const MEMBER = 'member';
const MAP_MEMBER = 'map-member';
const EDITOR = 'editor';
const DRIVER = 'driver';
const TOURIST = 'tourist';

function instance(over: Partial<LiveInstanceRow> & { id: string }): LiveInstanceRow {
  return {
    operatorId: OP, kind: 'scheduled', tripId: null, patternId: null, routeId: null, serviceDate: '2026-11-27', status: 'planned',
    vehicleId: null, visibleUntil: null, title: null, startedAt: null, endedAt: null, offRouteSince: null, stopEvents: [], plannedStops: [],
    ...over,
  };
}

function snapshot(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    loadedAt: NOW,
    operators: [{ id: OP, slug: 'op', name: { en: 'Op' }, timezone: 'Asia/Tokyo', defaultVisibility: 'invited_eta' }],
    routes: [
      { id: 'r-eta', operatorId: OP, slug: null, name: { en: 'eta' }, shortName: null, color: null, textColor: null, visibility: null, active: true },
      { id: 'r-map', operatorId: OP, slug: null, name: { en: 'map' }, shortName: null, color: null, textColor: null, visibility: 'invited_map', active: true },
      { id: 'r-pub', operatorId: OP, slug: null, name: { en: 'pub' }, shortName: null, color: null, textColor: null, visibility: 'public', active: true },
      { id: 'r-off', operatorId: OP, slug: null, name: { en: 'off' }, shortName: null, color: null, textColor: null, visibility: 'public', active: false },
    ],
    stops: ['s1', 's2', 's3', 's4', 's-tour'].map((id) => ({ id, operatorId: OP, slug: null, name: { en: id }, lon: 135, lat: 34 })),
    patterns: [
      { id: 'p-eta', operatorId: OP, routeId: 'r-eta' },
      { id: 'p-map', operatorId: OP, routeId: 'r-map' },
      { id: 'p-pub', operatorId: OP, routeId: 'r-pub' },
    ],
    patternStops: [
      { patternId: 'p-eta', sequence: 1, stopId: 's1', arrivalOffsetS: 0, departureOffsetS: 0 },
      { patternId: 'p-eta', sequence: 2, stopId: 's2', arrivalOffsetS: 60, departureOffsetS: 60 },
      { patternId: 'p-eta', sequence: 3, stopId: 's3', arrivalOffsetS: 120, departureOffsetS: 120 },
      { patternId: 'p-map', sequence: 1, stopId: 's2', arrivalOffsetS: 0, departureOffsetS: 0 },
      { patternId: 'p-pub', sequence: 1, stopId: 's4', arrivalOffsetS: 0, departureOffsetS: 0 },
    ],
    trips: [
      { id: 't-eta', patternId: 'p-eta', startTimeS: 0, headsign: null, vehicleId: 'bus-1' },
      { id: 't-any', patternId: 'p-eta', startTimeS: 0, headsign: null, vehicleId: null },
    ],
    instances: [
      instance({ id: 'ti-eta', tripId: 't-eta', patternId: 'p-eta', routeId: 'r-eta' }),
      instance({ id: 'ti-eta-bus2', tripId: 't-eta', patternId: 'p-eta', routeId: 'r-eta', vehicleId: 'bus-2', serviceDate: '2026-11-28' }),
      instance({ id: 'ti-any', tripId: 't-any', patternId: 'p-eta', routeId: 'r-eta' }),
      instance({ id: 'ti-pub', patternId: 'p-pub', routeId: 'r-pub' }),
      instance({ id: 'live-tour', kind: 'live', status: 'active', plannedStops: [{ sequence: 1, stopId: 's-tour', plannedArrival: null, plannedDeparture: null }] }),
      instance({ id: 'live-on-eta', kind: 'live', routeId: 'r-eta', status: 'active' }),
      instance({ id: 'live-over', kind: 'live', status: 'active', visibleUntil: new Date(NOW.getTime() - 1000) }),
      instance({
        id: 'live-old', kind: 'live', status: 'completed', serviceDate: '2026-11-20', endedAt: new Date('2026-11-20T09:00:00Z'),
        plannedStops: [{ sequence: 1, stopId: 's1', plannedArrival: null, plannedDeparture: null }],
      }),
    ],
    staffRoles: [{ operatorId: OP, userId: EDITOR, role: 'editor' }, { operatorId: OP, userId: DRIVER, role: 'driver' }],
    driverVehicles: [{ operatorId: OP, userId: DRIVER, vehicleId: 'bus-1' }],
    memberships: [
      { deviceId: MEMBER, audienceId: 'a-eta' },
      { deviceId: MAP_MEMBER, audienceId: 'a-map' },
      { deviceId: TOURIST, audienceId: 'a-tour' },
    ],
    audienceRoutes: [
      { audienceId: 'a-eta', routeId: 'r-eta', canSeeMap: true }, // map flag ignored: route is invited_eta
      { audienceId: 'a-eta', routeId: 'r-map', canSeeMap: false },
      { audienceId: 'a-map', routeId: 'r-map', canSeeMap: true },
    ],
    tripAudiences: [
      { tripInstanceId: 'live-tour', audienceId: 'a-tour', canSeeMap: true },
      { tripInstanceId: 'live-on-eta', audienceId: 'a-tour', canSeeMap: true },
      { tripInstanceId: 'live-over', audienceId: 'a-tour', canSeeMap: true },
    ],
    subscriptions: [
      { deviceId: MEMBER, stopId: 's1', patternId: 'p-eta', tripInstanceId: null },
      { deviceId: MEMBER, stopId: 's2', patternId: 'p-eta', tripInstanceId: null },
      { deviceId: MEMBER, stopId: 's3', patternId: 'p-eta', tripInstanceId: null },
    ],
    followedStops: [
      { deviceId: MEMBER, operatorId: OP, stopId: 's1' },
      { deviceId: MEMBER, operatorId: OP, stopId: 's2' },
    ],
    ...over,
  };
}

describe('live access: routes (private.route_access)', () => {
  const a = new AccessIndex(snapshot());
  const cases: [string, string | null, string, number][] = [
    ['visitor, public route', null, 'r-pub', 2],
    ['visitor, inactive public route', null, 'r-off', 0],
    ['visitor, invited route', null, 'r-eta', 0],
    ['member, invited_eta route (can_see_map ignored)', MEMBER, 'r-eta', 1],
    ['member without map, invited_map route', MEMBER, 'r-map', 1],
    ['member with map, invited_map route', MAP_MEMBER, 'r-map', 2],
    ['member of another route', MAP_MEMBER, 'r-eta', 0],
    ['member, public route', MEMBER, 'r-pub', 2],
    ['staff, inactive route', EDITOR, 'r-off', 3],
    ['driver, any route of the operator', DRIVER, 'r-eta', 3],
    ['unknown route', MEMBER, 'nope', 0],
  ];
  for (const [name, uid, route, level] of cases) {
    it(name, () => { assert.equal(a.routeAccess(uid, route), level); });
  }
});

describe('live access: trip instances (private.trip_instance_access)', () => {
  const a = new AccessIndex(snapshot());
  const cases: [string, string | null, string, number][] = [
    ['member, scheduled trip of the route', MEMBER, 'ti-eta', 1],
    ['visitor, trip of a public route', null, 'ti-pub', 2],
    ['editor, any trip', EDITOR, 'ti-eta-bus2', 3],
    ['driver, trip of the default vehicle they drive', DRIVER, 'ti-eta', 3],
    ['driver, trip run by another vehicle today', DRIVER, 'ti-eta-bus2', 0],
    ['driver, trip any vehicle may run', DRIVER, 'ti-any', 3],
    ['tourist, live trip of their audience (map)', TOURIST, 'live-tour', 2],
    ['tourist, live trip on an invited_eta route: arrival times only', TOURIST, 'live-on-eta', 1],
    ['member of the route, live trip on it', MEMBER, 'live-on-eta', 1],
    ['tourist, live trip after visible_until', TOURIST, 'live-over', 0],
    ['visitor, live trip without route', null, 'live-tour', 0],
    ['member, live trip of another audience', MEMBER, 'live-tour', 0],
  ];
  for (const [name, uid, ti, level] of cases) {
    it(name, () => { assert.equal(a.tripAccess(uid, ti, NOW), level); });
  }
});

describe('live access: stops and stop locations (stop_access, stop_location)', () => {
  const a = new AccessIndex(snapshot());

  it('a stop takes the highest level of the routes serving it', () => {
    assert.equal(a.stopAccess(MEMBER, 's2', NOW), 1);
    assert.equal(a.stopAccess(MAP_MEMBER, 's2', NOW), 2);
    assert.equal(a.stopAccess(null, 's4', NOW), 2);
    assert.equal(a.stopAccess(null, 's1', NOW), 0);
  });

  it('a planned stop of a current live trip counts at the trip level; old live trips do not', () => {
    assert.equal(a.stopAccess(TOURIST, 's-tour', NOW), 2);
    assert.equal(a.stopAccess(MEMBER, 's-tour', NOW), 0);
    // live-old ended a week ago: its planned stop s1 gives nothing.
    assert.equal(a.stopAccess(TOURIST, 's1', NOW), 0);
  });

  it('arrival-time members see the locations of the first two followed stops only', () => {
    assert.equal(a.stopLocationVisible(MEMBER, 's1', NOW), true);
    assert.equal(a.stopLocationVisible(MEMBER, 's2', NOW), true);
    assert.equal(a.stopLocationVisible(MEMBER, 's3', NOW), false, 'third followed stop');
    assert.equal(a.stopLocationVisible(MAP_MEMBER, 's2', NOW), true, 'map level');
    assert.equal(a.stopLocationVisible(MAP_MEMBER, 's1', NOW), false);
    assert.equal(a.stopLocationVisible(null, 's4', NOW), true, 'public');
  });

  it('a logged stop no longer followed (or no longer visible) shows no location', () => {
    const b = new AccessIndex(snapshot({ subscriptions: [] }));
    assert.equal(b.stopLocationVisible(MEMBER, 's1', NOW), false);
    const c = new AccessIndex(snapshot({ memberships: [] }));
    assert.equal(c.stopLocationVisible(MEMBER, 's1', NOW), false);
  });
});
