/**
 * Live trips without a pattern: order-aware matching along planned stops
 * (src/core/itinerary.ts). No geofence circles: only the next open stop
 * (or a skip confirmed by standing there) can be arrived at.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds } from '../../src/config.ts';
import type { ItineraryResult, ItineraryState } from '../../src/core/itinerary.ts';
import { itineraryEtas, updateItinerary } from '../../src/core/itinerary.ts';
import type { Itinerary, ItineraryStop, StopProgress } from '../../src/core/types.ts';
import { distance, type XY } from '../../src/geo/plane.ts';

const t = defaultThresholds;
const T0 = new Date('2026-11-28T00:00:00Z'); // 09:00 JST

function at(min: number, s = 0): Date {
  return new Date(T0.getTime() + (min * 60 + s) * 1000);
}

function itinerary(stops: { sequence: number; at: XY; arr?: Date | null; dep?: Date | null }[]): Itinerary {
  let d = 0;
  let prev: XY | null = null;
  const out: ItineraryStop[] = stops.map((s) => {
    if (prev) d += distance(prev, s.at);
    prev = s.at;
    return { sequence: s.sequence, point: s.at, plannedArrival: s.arr ?? null, plannedDeparture: s.dep ?? null, distM: d };
  });
  return { stops: out };
}

/** Feeds fixes through updateItinerary and records the stop transitions. */
class Run {
  state: ItineraryState;
  readonly log: string[] = [];
  last: ItineraryResult | null = null;
  time: Date;
  pos: XY;
  readonly itin: Itinerary;

  constructor(itin: Itinerary, start: Date, pos: XY) {
    this.itin = itin;
    this.time = start;
    this.pos = pos;
    this.state = {
      stops: itin.stops.map((s): StopProgress => ({ sequence: s.sequence, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null })),
      itinerary: { touchedSeq: null, dwell: null },
      leaveCount: 0,
      progressM: 0,
    };
  }

  fix(xy: XY, speedKmh: number, stepS = 10): this {
    this.time = new Date(this.time.getTime() + stepS * 1000);
    this.pos = xy;
    const r = updateItinerary(this.itin, this.state, { xy, at: this.time, speedKmh }, t);
    assert.ok(r.progressM >= this.state.progressM, 'progress only grows');
    for (const c of r.changes) this.log.push(`${c.sequence}:${c.to}`);
    this.state = { stops: r.stops, itinerary: r.itinerary, leaveCount: r.leaveCount, progressM: r.progressM };
    this.last = r;
    return this;
  }

  /** Straight line to `to` at `kmh`, one fix every 10 s. */
  drive(to: XY, kmh: number): this {
    const from = this.pos;
    const steps = Math.max(1, Math.ceil(distance(from, to) / ((kmh / 3.6) * 10)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      this.fix({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }, kmh);
    }
    return this;
  }

  /** Standing for `seconds`, GPS jitter up to `jitterM` around the current position. */
  stand(seconds: number, jitterM = 0, stepS = 10): this {
    const centre = this.pos;
    const n = Math.max(1, Math.round(seconds / stepS));
    for (let i = 0; i < n; i++) {
      const a = i * 2.3;
      this.fix({ x: centre.x + Math.cos(a) * jitterM, y: centre.y + Math.sin(a) * jitterM }, 0, stepS);
    }
    this.pos = centre;
    return this;
  }

  waitUntil(d: Date): this {
    if (d > this.time) this.time = d;
    return this;
  }

  stateOf(seq: number): string | undefined {
    return this.state.stops.find((s) => s.sequence === seq)?.state;
  }
}

// A day tour that starts and ends at the hotel (a loop: stop 1 and stop 4 are the same place).
const HOTEL = { x: 0, y: 0 };
const TEMPLE = { x: 3000, y: 0 };
const LUNCH = { x: 3000, y: 2000 };
const tour = itinerary([
  { sequence: 1, at: HOTEL, dep: at(0) },
  { sequence: 2, at: TEMPLE, arr: at(30), dep: at(180) }, // 09:30–12:00
  { sequence: 3, at: LUNCH, arr: at(195), dep: at(240) },
  { sequence: 4, at: HOTEL, arr: at(270) },
]);

describe('itinerary: order-aware stops without a shape', () => {
  it('a loop tour: the hotel at the end is not arrived at while the bus stands there in the morning', () => {
    const r = new Run(tour, at(-10), HOTEL).stand(600);
    assert.deepEqual(r.log, ['1:arrived']);
    assert.equal(r.stateOf(4), 'upcoming');
    r.drive(TEMPLE, 40).stand(60).drive(LUNCH, 40).stand(60).drive(HOTEL, 40).stand(60);
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived', '3:departed', '4:arrived']);
    assert.equal(Math.round(r.state.progressM), 3000 + 2000 + Math.round(Math.hypot(3000, 2000)));
  });

  it('a long planned stay (09:30–12:00) stays arrived; the next stops are neither passed nor departed early', () => {
    const r = new Run(tour, at(-1), HOTEL).stand(30).drive(TEMPLE, 40);
    r.stand(150 * 60, 40, 30); // 2.5 h with 40 m GPS jitter, one fix every 30 s.
    assert.equal(r.stateOf(2), 'arrived');
    assert.equal(r.stateOf(3), 'upcoming');
    assert.equal(r.stateOf(4), 'upcoming');
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:arrived']);
    // Later stops wait for the planned departure: lunch at 12:15 as planned (15 min after 12:00).
    const etas = itineraryEtas(tour, r.state.stops, r.pos, at(60), t);
    assert.equal(etas.get(3)?.toISOString(), at(195).toISOString());
    assert.equal(etas.get(4)?.toISOString(), at(270).toISOString());
    // Leaving: departed after itineraryLeaveFixes fixes farther than itineraryLeaveM.
    r.drive(LUNCH, 40);
    assert.equal(r.stateOf(2), 'departed');
  });

  it('a later stop whose circle the bus enters first does not fire (not even by stopping at a red light there)', () => {
    // From A to B the road passes C (stop 3, after B in the plan).
    const A = { x: 0, y: 0 };
    const B = { x: 2000, y: 0 };
    const C = { x: 1000, y: 40 };
    const plan = itinerary([{ sequence: 1, at: A }, { sequence: 2, at: B }, { sequence: 3, at: C }]);
    const r = new Run(plan, T0, A).stand(30).drive({ x: 1000, y: 0 }, 30);
    r.stand(90); // Red light next to C, 90 s.
    assert.equal(r.stateOf(3), 'upcoming');
    assert.equal(r.stateOf(2), 'upcoming');
    r.drive(B, 30).stand(60);
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:arrived']);
    r.drive(C, 30).stand(60);
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:arrived', '2:departed', '3:arrived']);
  });

  it('a revisit is not arrived at early, even after standing there long, before its planned time', () => {
    // Out and back past the hotel: the bus waits at the hotel again (11:00) on the way to lunch; the hotel is stop 4 at 13:30.
    const plan = itinerary([
      { sequence: 1, at: HOTEL, dep: at(0) },
      { sequence: 2, at: TEMPLE, arr: at(30), dep: at(90) },
      { sequence: 3, at: { x: -3000, y: 0 }, arr: at(150), dep: at(240) },
      { sequence: 4, at: HOTEL, arr: at(270) },
    ]);
    const r = new Run(plan, at(-1), HOTEL).stand(30).drive(TEMPLE, 40).stand(60).drive(HOTEL, 40);
    r.stand(600); // 10 min at the hotel at about 10:00: longer than itinerarySkipDwellS.
    assert.equal(r.stateOf(4), 'upcoming');
    assert.equal(r.stateOf(3), 'upcoming');
  });

  it('driving past the next stop without stopping: passed once the bus arrives at the stop after it', () => {
    const A = { x: 0, y: 0 };
    const B = { x: 1000, y: 0 };
    const C = { x: 2000, y: 0 };
    const plan = itinerary([{ sequence: 1, at: A }, { sequence: 2, at: B }, { sequence: 3, at: C }]);
    const r = new Run(plan, T0, A).stand(30).drive(C, 30);
    assert.equal(r.stateOf(2), 'upcoming', 'not passed by time or distance alone');
    r.stand(20);
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:passed', '3:arrived']);
  });

  it('skipping a stop the bus never came near: only after standing at the later one itinerarySkipDwellS', () => {
    const A = { x: 0, y: 0 };
    const B = { x: 1000, y: 1500 }; // Off the way.
    const C = { x: 2000, y: 0 };
    const plan = itinerary([{ sequence: 1, at: A }, { sequence: 2, at: B }, { sequence: 3, at: C }]);
    const r = new Run(plan, T0, A).stand(30).drive(C, 30);
    r.stand(170);
    assert.equal(r.stateOf(3), 'upcoming');
    const standingSince = new Date(r.time.getTime() - 160_000);
    r.stand(20);
    assert.deepEqual(r.log, ['1:arrived', '1:departed', '2:passed', '3:arrived']);
    const c = r.state.stops.find((s) => s.sequence === 3);
    assert.equal(c?.arrivedAt?.toISOString(), standingSince.toISOString(), 'arrived since the bus stood there');
  });

  it('a stop more than itinerarySkipStops after the next open stop is never skipped to', () => {
    const p = (x: number): XY => ({ x, y: 1000 * (x % 2000 === 0 ? 1 : 0) });
    const plan = itinerary([
      { sequence: 1, at: { x: 0, y: 0 } }, { sequence: 2, at: p(1000) }, { sequence: 3, at: p(2000) },
      { sequence: 4, at: p(3000) }, { sequence: 5, at: { x: 5000, y: 0 } },
    ]);
    const r = new Run(plan, T0, { x: 0, y: 0 }).stand(30).drive({ x: 5000, y: 0 }, 50).stand(600);
    assert.equal(r.stateOf(5), 'upcoming');
  });

  it('progress: straight-line distance along the planned stops, projected onto the current leg', () => {
    const plan = itinerary([{ sequence: 1, at: { x: 0, y: 0 } }, { sequence: 2, at: { x: 1000, y: 0 } }, { sequence: 3, at: { x: 1000, y: 1000 } }]);
    const r = new Run(plan, T0, { x: 0, y: 0 }).stand(20);
    r.fix({ x: 0, y: 100 }, 30);
    assert.equal(r.state.progressM, 0, 'at the first stop until the bus has left it');
    r.drive({ x: 300, y: 200 }, 30).fix({ x: 400, y: 200 }, 30); // Off the straight line: projected.
    assert.equal(r.stateOf(1), 'departed');
    assert.equal(Math.round(r.state.progressM), 400);
    r.fix({ x: 300, y: 0 }, 30); // Backwards: progress keeps its value.
    assert.equal(Math.round(r.state.progressM), 400);
    r.drive({ x: 1000, y: 0 }, 30).stand(20);
    assert.equal(Math.round(r.state.progressM), 1000);
  });

  it('ETAs without planned times: straight-line distance × detour factor at itinerarySpeedKmh', () => {
    const plan = itinerary([{ sequence: 1, at: { x: 0, y: 0 } }, { sequence: 2, at: { x: 3000, y: 0 } }, { sequence: 3, at: { x: 3000, y: 3000 } }]);
    const r = new Run(plan, T0, { x: 0, y: 0 }).stand(20).drive({ x: 1000, y: 0 }, 30);
    const etas = itineraryEtas(plan, r.state.stops, r.pos, r.time, t);
    const s2 = ((etas.get(2)?.getTime() ?? 0) - r.time.getTime()) / 1000;
    const s3 = ((etas.get(3)?.getTime() ?? 0) - r.time.getTime()) / 1000;
    assert.equal(Math.round(s2), Math.round((2000 * 1.3) / (30 / 3.6)));
    assert.equal(Math.round(s3 - s2), Math.round((3000 * 1.3) / (30 / 3.6)));
    assert.equal(etas.has(1), false);
  });

  it('ETAs with planned times: the planned leg time, in proportion to the distance left', () => {
    const r = new Run(tour, at(-1), HOTEL).stand(30);
    // Halfway to the temple: the planned leg is 30 min, half of it is left.
    r.drive({ x: 1500, y: 0 }, 40);
    const etas = itineraryEtas(tour, r.state.stops, r.pos, r.time, t);
    assert.equal(etas.get(2)?.toISOString(), new Date(r.time.getTime() + 15 * 60_000).toISOString());
    // The bus then waits for the planned departure at 12:00.
    assert.equal(etas.get(3)?.toISOString(), at(195).toISOString());
  });
});
