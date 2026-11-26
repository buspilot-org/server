import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCache } from '../../src/core/cache.ts';
import { LocalPlane, Polyline, type XY } from '../../src/geo/plane.ts';
import type { SnapshotRows } from '../../src/store/store.ts';

const plane = new LocalPlane({ lon: 135.19, lat: 34.69 });

function rows(shape: XY[], stops: { at: XY; offset: number }[]): SnapshotRows {
  const ll = (p: XY): [number, number] => {
    const q = plane.toLonLat(p);
    return [q.lon, q.lat];
  };
  return {
    operators: [{ id: 'o', timezone: 'Asia/Tokyo' }],
    vehicles: [],
    shapes: [{ id: 's', operatorId: 'o', coordinates: shape.map(ll), lengthM: new Polyline(shape).length }],
    patterns: [{ id: 'p', operatorId: 'o', routeId: 'r', shapeId: 's' }],
    patternStops: stops.map((s, i) => {
      const [lon, lat] = ll(s.at);
      return { patternId: 'p', sequence: i + 1, lon, lat, distAlongShape: null, arrivalOffsetS: s.offset, departureOffsetS: s.offset };
    }),
    instances: [],
  };
}

const dists = (r: SnapshotRows): number[] => buildCache(r).patterns.get('p')?.stops.map((s) => Math.round(s.distM)) ?? [];

describe('stop projection without dist_along_shape', () => {
  // A 12 m wide two-way street: out along y = 0, back along y = 12.
  const street = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 12 }, { x: 0, y: 12 }];

  it('a stop on the return side, scheduled on the way back, lands on the return pass', () => {
    const r = rows(street, [{ at: { x: 0, y: 0 }, offset: 0 }, { at: { x: 400, y: 14 }, offset: 450 }, { at: { x: 0, y: 12 }, offset: 600 }]);
    const d = dists(r);
    assert.ok(Math.abs((d[1] ?? 0) - 1612) < 3, String(d));
  });

  it('a stop scheduled on the way out lands on the outbound pass', () => {
    const r = rows(street, [{ at: { x: 0, y: 0 }, offset: 0 }, { at: { x: 400, y: 7 }, offset: 120 }, { at: { x: 0, y: 12 }, offset: 600 }]);
    assert.ok(Math.abs((dists(r)[1] ?? 0) - 400) < 3, String(dists(r)));
  });

  it('a loop serving a stop twice: each visit on its own pass', () => {
    const loop = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 500 }, { x: 0, y: 500 }, { x: 0, y: 0 }, { x: -300, y: 0 }];
    const r = rows(loop, [
      { at: { x: 0, y: 0 }, offset: 0 }, { at: { x: 500, y: 250 }, offset: 200 }, { at: { x: 0, y: 0 }, offset: 600 }, { at: { x: -300, y: 0 }, offset: 700 },
    ]);
    assert.deepEqual(dists(r), [0, 750, 2000, 2300]);
    assert.equal(buildCache(r).stopsWithoutDist, 4);
  });
});

describe('live trips in the cache', () => {
  const live = (id: string, planned: { lon: number; lat: number; arr: Date | null; dep: Date | null }[]): SnapshotRows['instances'][number] => ({
    id, operatorId: 'o', serviceDate: '2026-11-24', kind: 'live', tripId: null, patternId: null, routeId: null, startTimeS: null,
    vehicleId: 'v', defaultVehicleId: null, status: 'planned', startedBy: 'driver', progressM: 0, progressAt: null,
    lastConfirmedStopSequence: null, offRouteSince: null, startedAt: null, endedAt: null, stopEvents: [], title: { en: 'Tour' },
    visibleUntil: null, createdAt: new Date('2026-11-23T20:00:00Z'),
    plannedStops: planned.map((p, i) => ({ sequence: i + 1, lon: p.lon, lat: p.lat, plannedArrival: p.arr, plannedDeparture: p.dep })),
  });

  it('planned stops far away do not move the plane of an operator with shapes (its scheduled trips match as before)', () => {
    const r = rows([{ x: 0, y: 0 }, { x: 1000, y: 0 }], [{ at: { x: 0, y: 0 }, offset: 0 }, { at: { x: 1000, y: 0 }, offset: 120 }]);
    const before = buildCache(r).operators.get('o')?.plane.toXY({ lon: 135.2, lat: 34.7 });
    r.instances.push(live('L', [{ lon: 139.7, lat: 35.7, arr: null, dep: null }, { lon: 139.8, lat: 35.7, arr: null, dep: null }]));
    const after = buildCache(r).operators.get('o')?.plane.toXY({ lon: 135.2, lat: 34.7 });
    assert.deepEqual(after, before);
  });

  it('window anchors: the first stop\'s time opens it, the last stop\'s closes it; otherwise the day', () => {
    const r = rows([{ x: 0, y: 0 }, { x: 1000, y: 0 }], [{ at: { x: 0, y: 0 }, offset: 0 }, { at: { x: 1000, y: 0 }, offset: 120 }]);
    const nine = new Date('2026-11-24T00:00:00Z');
    const two = new Date('2026-11-24T05:00:00Z');
    r.instances.push(
      live('first-only', [{ lon: 135.19, lat: 34.69, arr: null, dep: nine }, { lon: 135.2, lat: 34.69, arr: null, dep: null }]),
      live('last-only', [{ lon: 135.19, lat: 34.69, arr: null, dep: null }, { lon: 135.2, lat: 34.69, arr: two, dep: null }]),
      live('middle-only', [{ lon: 135.19, lat: 34.69, arr: null, dep: null }, { lon: 135.2, lat: 34.69, arr: nine, dep: null }, { lon: 135.21, lat: 34.69, arr: null, dep: null }]),
    );
    const c = buildCache(r).instances;
    const a = c.get('first-only')?.instance;
    assert.equal(a?.timedStart, true);
    assert.equal(a.timedEnd, false);
    assert.equal(a.startAt.toISOString(), nine.toISOString());
    assert.equal(a.endAt.toISOString(), '2026-11-24T15:00:00.000Z', 'end of the service day (Tokyo)');
    const b = c.get('last-only')?.instance;
    assert.equal(b?.timedStart, false);
    assert.equal(b.startAt.toISOString(), '2026-11-23T20:00:00.000Z', 'when it was saved');
    assert.equal(b.endAt.toISOString(), two.toISOString());
    const m = c.get('middle-only')?.instance;
    assert.equal(m?.timedStart, false);
    assert.equal(m.timedEnd, false);
  });
});
