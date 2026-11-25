/** Test routes shared by the replay scenarios. */
import type { XY } from '../../src/geo/plane.ts';
import { Track, type RouteDef, type Scenario, type TripDef } from './harness.ts';

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
export function germanSchool(trips: TripDef[]): RouteDef {
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
export const STOP_M = { 1: 0, 2: 920, 3: 1440, 4: 2020, 5: 3000 } as const;

/**
 * A loop that serves one stop twice (like the seed's Kitano-zaka): stops 2
 * and 5 are the same place; the shape's vertices are the stops.
 */
export function loopRoute(trips: TripDef[]): RouteDef {
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

export const FULL_RUN = ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed', '4:arrived', '4:departed', '5:arrived', '5:departed'];

/** A normal run of the German School route, starting at the depot before the window opens. */
export function normalRun(s: Scenario, tripId: string, opts: { noisyOutbound?: boolean } = {}): Track {
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


/**
 * The example route of arrival-alerts.md ("Examples"), straightened: stops
 * at 0, 800, 1,600, 2,400, 3,100 and 4,000 m, scheduled 07:30, 07:33, 07:36,
 * 07:39, 07:42 and 07:46 (relative to the trip start).
 */
export const EXAMPLE_M = { 1: 0, 2: 800, 3: 1600, 4: 2400, 5: 3100, 6: 4000 } as const;

export function exampleRoute(trips: TripDef[]): RouteDef {
  const offsets = [0, 180, 360, 540, 720, 960];
  return {
    shape: [{ x: 0, y: 0 }, { x: 4000, y: 0 }],
    stops: Object.values(EXAMPLE_M).map((m, i) => ({
      sequence: i + 1, at: { x: m, y: 0 }, distM: m, arrivalOffsetS: offsets[i] ?? 0, departureOffsetS: offsets[i] ?? 0,
    })),
    trips,
  };
}

/**
 * An on-time run of the example route: standing at the depot until the
 * start, then 30 km/h with a 30 s stop at each stop (slightly early).
 */
export function exampleRun(s: Scenario, tripId: string, opts: { lateS?: number } = {}): Track {
  const start = s.tripStart(tripId);
  const t = new Track(s.shape, new Date(start.getTime() - 60_000));
  t.dwell(60 + (opts.lateS ?? 0) + 5);
  for (const m of [EXAMPLE_M[2], EXAMPLE_M[3], EXAMPLE_M[4], EXAMPLE_M[5], EXAMPLE_M[6]]) t.drive(m - 2, 30).dwell(30);
  t.goTo({ x: 4000, y: 300 }, 15);
  return t;
}
