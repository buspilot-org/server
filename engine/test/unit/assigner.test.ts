/**
 * Trip windows and precedence of live trips (src/core/assigner.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultThresholds } from '../../src/config.ts';
import { activeTrip, liveStartCandidates, scheduleStart, startCandidates, tripWindow } from '../../src/core/assigner.ts';
import { progressFromRow } from '../../src/core/cache.ts';
import type { TripInstance, TripProgress, TripRuntime, Vehicle } from '../../src/core/types.ts';
import { Polyline } from '../../src/geo/plane.ts';

const t = defaultThresholds;
const START = new Date('2026-11-24T00:00:00Z');
const min = (m: number): Date => new Date(START.getTime() + m * 60_000);
const vehicle: Vehicle = { id: 'v1', operatorId: 'op', deviceId: 'd1' };
const pattern = {
  id: 'p', operatorId: 'op', routeId: 'r', shape: new Polyline([{ x: 0, y: 0 }, { x: 1000, y: 0 }]),
  stops: [
    { sequence: 1, distM: 0, arrivalOffsetS: 0, departureOffsetS: 0, point: { x: 0, y: 0 } },
    { sequence: 2, distM: 1000, arrivalOffsetS: 600, departureOffsetS: 600, point: { x: 1000, y: 0 } },
  ],
};

function trip(id: string, over: Partial<TripInstance>, progress: Partial<TripProgress> = {}): TripRuntime {
  const instance: TripInstance = {
    id, operatorId: 'op', serviceDate: '2026-11-24', kind: 'scheduled', tripId: `trip-${id}`, routeId: 'r', pattern, itinerary: null,
    title: null, visibleUntil: null, startAt: min(0), endAt: min(10), timedStart: true, timedEnd: true, ...over,
  };
  const base = progressFromRow({
    id, operatorId: 'op', serviceDate: '2026-11-24', kind: instance.kind, tripId: instance.tripId, patternId: 'p', routeId: 'r',
    startTimeS: null, vehicleId: null, defaultVehicleId: null, status: 'planned', startedBy: 'schedule', progressM: 0, progressAt: null,
    lastConfirmedStopSequence: null, offRouteSince: null, startedAt: null, endedAt: null, stopEvents: [], title: null, visibleUntil: null,
    createdAt: START, plannedStops: [],
  }, instance);
  return { instance, scheduledVehicleId: null, progress: { ...base, ...progress } };
}

describe('trip windows', () => {
  it('scheduled: tripWindowBeforeS before the start to tripWindowAfterS after the end', () => {
    const w = tripWindow(trip('S', {}), t);
    assert.deepEqual([w.from, w.to], [min(-15), min(40)]);
  });

  it('live with planned times: around the first and last planned time; never after visible_until', () => {
    const tr = trip('L', { kind: 'live', tripId: null, pattern: null, startAt: min(60), endAt: min(180) });
    assert.deepEqual(Object.values(tripWindow(tr, t)), [min(45), min(210)]);
    tr.instance.visibleUntil = min(120);
    assert.deepEqual(Object.values(tripWindow(tr, t)), [min(45), min(120)]);
  });

  it('live without planned times: from when it was saved to the end of the day; on a pattern, once started, its running time', () => {
    const tr = trip('L', { kind: 'live', tripId: null, startAt: min(5), endAt: min(24 * 60), timedStart: false, timedEnd: false });
    assert.deepEqual(Object.values(tripWindow(tr, t)), [min(5), min(24 * 60 + 30)]);
    tr.progress = { ...tr.progress, status: 'active', startedAt: min(100) };
    assert.deepEqual(Object.values(tripWindow(tr, t)), [min(5), min(100 + 10 + 30)]);
    assert.equal(scheduleStart(tr).getTime(), min(100).getTime(), 'pattern offsets count from the actual start');
  });
});

describe('precedence', () => {
  it('a live trip of the vehicle is a live start candidate, never a scheduled one; without a vehicle it is neither', () => {
    const live = trip('L', { kind: 'live', tripId: null, timedStart: false, timedEnd: false, startAt: min(0) }, { vehicleId: 'v1' });
    const anyVehicle = trip('L2', { kind: 'live', tripId: null, timedStart: false, timedEnd: false, startAt: min(0) });
    const sched = trip('S', {});
    const all = [live, anyVehicle, sched];
    assert.deepEqual(liveStartCandidates(all, vehicle, min(1), t).map((x) => x.instance.id), ['L']);
    assert.deepEqual(startCandidates(all, vehicle, min(1), t).map((x) => x.instance.id), ['S']);
  });

  it('a live trip without a first planned time yields while a scheduled trip of the vehicle is due; a timed one does not', () => {
    const untimed = trip('L', { kind: 'live', tripId: null, timedStart: false, timedEnd: false, startAt: min(-60), endAt: min(24 * 60) }, { vehicleId: 'v1' });
    const timed = trip('LT', { kind: 'live', tripId: null, pattern: null, startAt: min(5), endAt: min(60) }, { vehicleId: 'v1' });
    const ofVehicle = trip('S', {});
    ofVehicle.scheduledVehicleId = 'v1';
    const ids = (trips: TripRuntime[], at: Date): string[] => liveStartCandidates(trips, vehicle, at, t).map((x) => x.instance.id);
    assert.deepEqual(ids([untimed, timed, ofVehicle], min(1)), ['LT'], 'S due (window −15…+40 min)');
    assert.deepEqual(ids([untimed, ofVehicle], min(-20)), ['L'], 'before S is due');
    assert.deepEqual(ids([untimed, ofVehicle], min(41)), ['L'], 'after S\'s window');
    ofVehicle.progress = { ...ofVehicle.progress, status: 'completed' };
    assert.deepEqual(ids([untimed, ofVehicle], min(1)), ['L'], 'S ended');
    const anyVehicle = trip('S2', {});
    assert.deepEqual(ids([untimed, anyVehicle], min(1)), ['L'], 'a trip any vehicle may run does not count');
    const otherVehicle = trip('S3', {});
    otherVehicle.scheduledVehicleId = 'v2';
    assert.deepEqual(ids([untimed, otherVehicle], min(1)), ['L']);
  });

  it('several active trips on one vehicle (only through database changes): the live trip wins', () => {
    const sched = trip('S', {}, { status: 'active', vehicleId: 'v1', startedAt: min(0) });
    const live = trip('L', { kind: 'live', tripId: null, timedStart: false, timedEnd: false }, { status: 'active', vehicleId: 'v1', startedAt: min(5) });
    assert.equal(activeTrip([sched, live], 'v1')?.instance.id, 'L');
    assert.equal(activeTrip([sched], 'v1')?.instance.id, 'S');
  });
});
