import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalPlane, Polyline, bearingDifference, distance } from '../../src/geo/plane.ts';

const near = (a: number, b: number, tol: number, msg?: string): void => {
  assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} ≉ ${b} (±${tol})`);
};

describe('LocalPlane', () => {
  const plane = new LocalPlane({ lon: 135.19, lat: 34.69 });

  it('round-trips coordinates', () => {
    const p = { lon: 135.1953, lat: 34.7067 };
    const back = plane.toLonLat(plane.toXY(p));
    near(back.lon, p.lon, 1e-9);
    near(back.lat, p.lat, 1e-9);
  });

  it('matches geodesic distances in Kobe to well under 0.5 %', () => {
    // Shin-Kobe Station → Kitano-zaka (seed stops); PostGIS ST_Distance on
    // geography gives 871.3 m.
    const a = plane.toXY({ lon: 135.1953, lat: 34.7067 });
    const b = plane.toXY({ lon: 135.1915, lat: 34.6995 });
    near(distance(a, b), 871.3, 871.3 * 0.005);
  });

  it('centres on the bounding box', () => {
    const p = LocalPlane.around([{ lon: 135, lat: 34 }, { lon: 136, lat: 35 }]);
    assert.deepEqual(p.origin, { lon: 135.5, lat: 34.5 });
  });
});

describe('bearings', () => {
  it('smallest angle between two bearings', () => {
    assert.equal(bearingDifference(10, 350), 20);
    assert.equal(bearingDifference(90, 270), 180);
    assert.equal(bearingDifference(0, 0), 0);
  });
});

describe('Polyline', () => {
  const line = new Polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);

  it('has cumulative distances and pointAt', () => {
    assert.deepEqual(line.cum, [0, 100, 200]);
    assert.equal(line.length, 200);
    assert.deepEqual(line.pointAt(150), { x: 100, y: 50 });
    assert.deepEqual(line.pointAt(-5), { x: 0, y: 0 });
    assert.deepEqual(line.pointAt(999), { x: 100, y: 100 });
  });

  it('scales cumulative distances to a reference length', () => {
    const scaled = new Polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 101);
    assert.equal(scaled.length, 101);
    near(scaled.nearest({ x: 50, y: 10 })?.m ?? -1, 50.5, 1e-9);
    near(scaled.nearest({ x: 50, y: 10 })?.distance ?? -1, 10, 1e-9);
  });

  it('projects onto the nearest point within a range', () => {
    const p = { x: 60, y: 10 };
    assert.deepEqual(line.nearest(p), { m: 60, distance: 10, bearing: 90 });
    assert.equal(line.nearest({ x: 110, y: 150 })?.bearing, 0, 'second segment runs north');
    const limited = line.nearest(p, 120, 200);
    assert.ok(limited);
    assert.equal(limited.m, 120);
    near(limited.distance, Math.hypot(40, 10), 1e-9);
    assert.equal(line.nearest(p, 300, 400), null);
  });

  it('finds one candidate per pass of an out-and-back street', () => {
    const outAndBack = new Polyline([{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 0, y: 40 }]);
    const c = outAndBack.candidates({ x: 400, y: 25 }, 0, outAndBack.length, 50);
    assert.equal(c.length, 2);
    near(c[0]?.m ?? -1, 400, 1e-9);
    near(c[0]?.distance ?? -1, 25, 1e-9);
    near(c[1]?.m ?? -1, 1440, 1e-9);
    near(c[1]?.distance ?? -1, 15, 1e-9);
    // Restricting the window leaves only the first pass.
    assert.equal(outAndBack.candidates({ x: 400, y: 25 }, 0, 1000, 50).length, 1);
  });

  it('tells apart the two sides of a tight turn', () => {
    // Out along y = 0, a 40 m connector, back along y = 40. A fix 25 m north
    // of the out street, 20 m before the turn, is near both sides.
    const turn = new Polyline([{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 0, y: 40 }]);
    const c = turn.candidates({ x: 880, y: 25 }, 0, turn.length, 100);
    assert.equal(c.length, 2, JSON.stringify(c));
    near(c[0]?.m ?? -1, 880, 1e-9);
    assert.ok((c[1]?.m ?? 0) > 920);
  });

  it('does not report vertices of a straight, finely split road as extra candidates', () => {
    const pts = Array.from({ length: 51 }, (_, i) => ({ x: i * 20, y: 0 }));
    const road = new Polyline(pts);
    const c = road.candidates({ x: 503, y: 5 }, 0, road.length, 100);
    assert.equal(c.length, 1);
    near(c[0]?.m ?? -1, 503, 1e-9);
  });

  it('prefers the earlier point on equal distances (conservative)', () => {
    // A position exactly between the outbound street and the turn.
    const hairpin = new Polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }]);
    const c = hairpin.candidates({ x: 80, y: 20 }, 0, hairpin.length, 50, 50);
    assert.ok((c[0]?.m ?? Infinity) <= 100);
  });
});
