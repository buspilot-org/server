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
