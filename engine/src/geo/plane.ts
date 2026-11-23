/**
 * Local tangent plane and polylines in metres.
 *
 * Shapes are projected once into a plane around an origin per operator
 * (equirectangular, accurate to well under 0.1 % within the ~20 km an
 * operator's routes span), so matching a position is plain 2D math.
 * PostGIS (`ST_LineLocatePoint`, `ST_Length` on geography) stays the
 * reference: the cumulative distances are scaled so that the total equals the
 * geodesic length PostGIS reports, which keeps them consistent with
 * `pattern_stop.dist_along_shape`.
 */

export interface LonLat {
  lon: number;
  lat: number;
}

export interface XY {
  x: number;
  y: number;
}

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export class LocalPlane {
  readonly origin: LonLat;
  readonly #kx: number;
  readonly #ky: number;

  constructor(origin: LonLat) {
    this.origin = origin;
    this.#ky = EARTH_RADIUS_M * DEG;
    this.#kx = EARTH_RADIUS_M * DEG * Math.cos(origin.lat * DEG);
  }

  toXY(p: LonLat): XY {
    return { x: (p.lon - this.origin.lon) * this.#kx, y: (p.lat - this.origin.lat) * this.#ky };
  }

  toLonLat(p: XY): LonLat {
    return { lon: this.origin.lon + p.x / this.#kx, lat: this.origin.lat + p.y / this.#ky };
  }

  /** A plane centred on the bounding box of the given points. */
  static around(points: readonly LonLat[]): LocalPlane {
    if (points.length === 0) return new LocalPlane({ lon: 0, lat: 0 });
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const p of points) {
      minLon = Math.min(minLon, p.lon);
      maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
    }
    return new LocalPlane({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 });
  }
}

export function distance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * A point on the line: `m` is the distance along the line, `distance` the
 * distance from the query point, `bearing` the direction of travel of the
 * line there (degrees clockwise from north, like a GPS course).
 */
export interface Projection {
  m: number;
  distance: number;
  bearing: number;
  /** At a vertex: the bearing of the other segment meeting there. */
  otherBearing?: number;
}

/** Smallest angle between two bearings (0–180°). */
export function bearingDifference(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

export class Polyline {
  readonly points: readonly XY[];
  /** Cumulative distance along the line at each vertex (scaled, see the module comment). */
  readonly cum: readonly number[];
  readonly length: number;

  /**
   * @param points vertices in the local plane
   * @param lengthM reference length (e.g. PostGIS geodesic length); the
   *   cumulative distances are scaled to it. Defaults to the planar length.
   */
  constructor(points: readonly XY[], lengthM?: number) {
    if (points.length < 2) throw new Error('a polyline needs at least two points');
    const planar: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      planar.push((planar[i - 1] ?? 0) + distance(at(points, i - 1), at(points, i)));
    }
    const planarLength = planar[planar.length - 1] ?? 0;
    const scale = lengthM !== undefined && planarLength > 0 ? lengthM / planarLength : 1;
    this.points = points;
    this.cum = planar.map((d) => d * scale);
    this.length = planarLength * scale;
  }

  /** The point at distance `m` along the line (clamped to the line). */
  pointAt(m: number): XY {
    const clamped = Math.min(Math.max(m, 0), this.length);
    for (let i = 0; i < this.points.length - 1; i++) {
      const m0 = at(this.cum, i);
      const m1 = at(this.cum, i + 1);
      if (clamped <= m1 || i === this.points.length - 2) {
        const t = m1 > m0 ? (clamped - m0) / (m1 - m0) : 0;
        const a = at(this.points, i);
        const b = at(this.points, i + 1);
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
    }
    return at(this.points, this.points.length - 1);
  }

  /**
   * The closest point of the part of the line between `fromM` and `toM`,
   * or null if the range does not overlap the line.
   */
  nearest(p: XY, fromM = 0, toM = this.length): Projection | null {
    let best: Projection | null = null;
    this.#eachSegment(p, fromM, toM, (proj) => {
      if (best === null || proj.distance < best.distance) best = proj;
    });
    return best;
  }

  /**
   * Candidate matches of `p` within `[fromM, toM]`, one per pass of the line
   * within `maxDistance`: where the line passes the point twice (a loop, the
   * same road in both directions, the two sides of a turn), each pass is a
   * separate candidate, represented by its closest point. Sorted by `m`.
   *
   * Two points of the line belong to the same pass if the line between them
   * is not longer than going through `p` (their distances to `p` added) plus
   * `sameSectionSlackM`: a line that leaves the point and comes back is a
   * new pass. Projections clamped to the ends of the range count too, so a
   * caller can tell them apart by `m === fromM`.
   */
  candidates(p: XY, fromM: number, toM: number, maxDistance: number, sameSectionSlackM = 10): Projection[] {
    const projections: Projection[] = [];
    this.#eachSegment(p, fromM, toM, (proj) => {
      if (proj.distance <= maxDistance) projections.push(proj);
    });
    projections.sort((a, b) => a.distance - b.distance || a.m - b.m);
    const passes: Projection[] = [];
    for (const c of projections) {
      const samePass = passes.some((q) => Math.abs(c.m - q.m) <= c.distance + q.distance + sameSectionSlackM);
      if (!samePass) passes.push(c);
    }
    return passes.sort((a, b) => a.m - b.m);
  }

  #eachSegment(
    p: XY,
    fromM: number,
    toM: number,
    visit: (proj: Projection) => void,
  ): void {
    const from = Math.max(fromM, 0);
    const to = Math.min(toM, this.length);
    if (to < from) return;
    for (let i = 0; i < this.points.length - 1; i++) {
      const m0 = at(this.cum, i);
      const m1 = at(this.cum, i + 1);
      if (m1 < from || m0 > to) continue;
      const a = at(this.points, i);
      const b = at(this.points, i + 1);
      const segM = m1 - m0;
      if (segM <= 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      const tMin = Math.max(0, (from - m0) / segM);
      const tMax = Math.min(1, (to - m0) / segM);
      t = Math.min(Math.max(t, tMin), tMax);
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = distance(p, q);
      const bearing = segmentBearing(a, b);
      const proj: Projection = { m: m0 + segM * t, distance: d, bearing };
      if (t === 0 && i > 0) proj.otherBearing = segmentBearing(at(this.points, i - 1), a);
      if (t === 1 && i < this.points.length - 2) proj.otherBearing = segmentBearing(b, at(this.points, i + 2));
      visit(proj);
    }
  }
}

function segmentBearing(a: XY, b: XY): number {
  return ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
}

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}
