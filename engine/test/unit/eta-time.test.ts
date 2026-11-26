import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds as t } from '../../src/config.ts';
import { computeEtas, expectedProgressAt, scheduledOffsetAt } from '../../src/core/eta.ts';
import { localDate, serviceDayStart, serviceTime } from '../../src/core/time.ts';
import type { StopProgress, TripInstance } from '../../src/core/types.ts';
import { Polyline } from '../../src/geo/plane.ts';

describe('service time', () => {
  it('Tokyo: service day starts at local midnight', () => {
    assert.equal(serviceDayStart('2026-11-24', 'Asia/Tokyo').toISOString(), '2026-11-23T15:00:00.000Z');
    assert.equal(serviceTime('2026-11-24', 7.5 * 3600, 'Asia/Tokyo').toISOString(), '2026-11-23T22:30:00.000Z');
    assert.equal(serviceTime('2026-11-24', 25 * 3600, 'Asia/Tokyo').toISOString(), '2026-11-24T16:00:00.000Z');
  });

  it('DST: noon minus 12 h, as in GTFS', () => {
    // Berlin, 2026-03-29: clocks go from 02:00 to 03:00. Noon is 10:00 UTC, so the day starts at 22:00 UTC.
    assert.equal(serviceDayStart('2026-03-29', 'Europe/Berlin').toISOString(), '2026-03-28T22:00:00.000Z');
    assert.equal(serviceDayStart('2026-07-01', 'Europe/Berlin').toISOString(), '2026-06-30T22:00:00.000Z');
  });

  it('local date', () => {
    assert.equal(localDate(new Date('2026-11-23T15:30:00Z'), 'Asia/Tokyo'), '2026-11-24');
    assert.equal(localDate(new Date('2026-11-23T14:30:00Z'), 'Asia/Tokyo'), '2026-11-23');
  });
});

describe('ETA v1', () => {
  const stops = [
    { sequence: 1, distM: 0, arrivalOffsetS: 0, departureOffsetS: 60, point: { x: 0, y: 0 } },
    { sequence: 2, distM: 1000, arrivalOffsetS: 300, departureOffsetS: 330, point: { x: 1000, y: 0 } },
    { sequence: 3, distM: 2000, arrivalOffsetS: 600, departureOffsetS: 600, point: { x: 2000, y: 0 } },
  ];
  const startAt = new Date('2026-11-23T22:30:00Z');
  const inst: TripInstance = {
    id: 'i', operatorId: 'o', serviceDate: '2026-11-24', kind: 'scheduled', tripId: 't', routeId: 'r', itinerary: null, title: null,
    visibleUntil: null, timedStart: true, timedEnd: true, startAt, endAt: new Date(startAt.getTime() + 600_000),
    pattern: { id: 'p', operatorId: 'o', routeId: 'r', shape: new Polyline([{ x: 0, y: 0 }, { x: 2000, y: 0 }]), stops },
  };
  const progress = (s1: StopProgress['state']): StopProgress[] => [
    { sequence: 1, state: s1, arrivedAt: null, departedAt: null, passedAt: null, eta: null },
    { sequence: 2, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null },
    { sequence: 3, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null },
  ];
  const at = (s: number): Date => new Date(startAt.getTime() + s * 1000);

  it('interpolates the schedule between stops (and its inverse)', () => {
    assert.equal(scheduledOffsetAt(stops, 0), 60);
    assert.equal(scheduledOffsetAt(stops, 500), 180);
    assert.equal(scheduledOffsetAt(stops, 1000), 300, 'at a stop: its arrival');
    assert.equal(scheduledOffsetAt(stops, 1500), 465);
    assert.equal(scheduledOffsetAt(stops, 9999), 600);
    assert.equal(expectedProgressAt(inst, at(180)), 500);
    assert.equal(expectedProgressAt(inst, at(320)), 1000, 'dwelling');
    assert.equal(expectedProgressAt(inst, at(9999)), 2000);
  });

  it('shifts the scheduled arrival by the delay', () => {
    const etas = computeEtas(inst, progress('departed'), 500, at(300), t); // 2 minutes late
    assert.equal(etas.get(2)?.toISOString(), at(420).toISOString());
    assert.equal(etas.get(3)?.toISOString(), at(720).toISOString());
    assert.equal(etas.has(1), false);
  });

  it('never earlier than the remaining distance at the maximum speed', () => {
    // 3 minutes early at 500 m; at 10 m/s the bus needs at least 50 s to stop 2.
    const early = computeEtas(inst, progress('departed'), 500, at(0), { ...t, etaMaxSpeedKmh: 36 });
    assert.equal(early.get(2)?.toISOString(), at(120).toISOString(), '300 s − 180 s early, above the bound');
    // A schedule faster than the bus can drive: the bound wins (500 m at 1 m/s).
    const bound = computeEtas(inst, progress('departed'), 500, at(0), { ...t, etaMaxSpeedKmh: 3.6 });
    assert.equal(bound.get(2)?.toISOString(), at(500).toISOString());
  });

  it('waiting at a stop until its scheduled departure is no delay', () => {
    const s = progress('departed');
    const second = s[1];
    assert.ok(second);
    s[1] = { ...second, state: 'arrived' };
    // On time at stop 2 (arrival 300 s, departure 330 s), still standing at 320 s.
    assert.equal(computeEtas(inst, s, 1000, at(320), t).get(3)?.toISOString(), at(600).toISOString());
    // Still there at 400 s: 70 s late.
    assert.equal(computeEtas(inst, s, 1000, at(400), t).get(3)?.toISOString(), at(670).toISOString());
  });

  it('a bus waiting early at the first stop does not make ETAs early', () => {
    const etas = computeEtas(inst, progress('arrived'), 0, at(-300), t);
    assert.equal(etas.get(2)?.toISOString(), at(300).toISOString());
  });
});
