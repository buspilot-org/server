/**
 * The engine: processes positions (engine.md, "Processing a position") and
 * periodic ticks, keeps the per-trip runtime state in memory and writes the
 * results through the store.
 *
 * Every change is computed on a copy of the runtime state, written in one
 * transaction, and only kept in memory once the write succeeded. If the write
 * fails, Traccar retries the position and it is processed again from the same
 * state. Positions of one vehicle are processed one at a time, in order.
 */
import type { Thresholds } from '../config.ts';
import { distance } from '../geo/plane.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { Store } from '../store/store.ts';
import { activeTrip, chooseStart, evaluateStart, startCandidates, windowOpen } from './assigner.ts';
import type { Cache } from './cache.ts';
import { buildCache, progressFromRow } from './cache.ts';
import { computeEtas, expectedProgressAt } from './eta.ts';
import { matchPosition } from './matcher.ts';
import { allStopsFinal, lastConfirmedStop, updateStops } from './stops.ts';
import { secondsBetween } from './time.ts';
import type {
  PositionInput,
  StopEventWrite,
  TripProgress,
  TripRuntime,
  TripWrite,
  Vehicle,
  Writes,
} from './types.ts';
import { isEmpty } from './types.ts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type PositionOutcome = 'unknown_device' | 'duplicate' | 'invalid' | 'processed';

export interface EngineMetrics {
  positionsProcessed: number;
  positionsUnknownDevice: number;
  positionsDuplicate: number;
  positionsInvalid: number;
  positionsFailed: number;
  lastPositionAt: string | null;
  lastReloadAt: string | null;
}

interface LastFix {
  at: Date;
  positionId: number | null;
}

export class Engine {
  readonly #store: Store;
  readonly #t: Thresholds;
  readonly #clock: Clock;
  readonly #log: Logger;
  #cache: Cache | null = null;
  readonly #trips = new Map<string, TripRuntime>();
  readonly #lastFix = new Map<string, LastFix>();
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly metrics: EngineMetrics = {
    positionsProcessed: 0,
    positionsUnknownDevice: 0,
    positionsDuplicate: 0,
    positionsInvalid: 0,
    positionsFailed: 0,
    lastPositionAt: null,
    lastReloadAt: null,
  };

  constructor(opts: { store: Store; thresholds: Thresholds; clock?: Clock; log: Logger }) {
    this.#store = opts.store;
    this.#t = opts.thresholds;
    this.#clock = opts.clock ?? systemClock;
    this.#log = opts.log;
  }

  get loaded(): boolean {
    return this.#cache !== null;
  }

  /** Trip runtimes, for tests and health output. */
  get trips(): ReadonlyMap<string, TripRuntime> {
    return this.#trips;
  }

  /**
   * (Re)loads the cache from the database. Runtime state of trips already in
   * memory is kept (memory is at least as new as the database, since every
   * change is written before it is kept); only a cancellation made in the
   * database is taken over. New instances (and all of them after a restart)
   * start from their database rows.
   */
  async reload(): Promise<void> {
    const rows = await this.#store.loadSnapshot(this.#clock.now());
    const cache = buildCache(rows);
    for (const v of rows.vehicles) {
      const known = this.#lastFix.get(v.id);
      if (v.lastFixAt && (!known || known.at < v.lastFixAt)) this.#lastFix.set(v.id, { at: v.lastFixAt, positionId: null });
    }
    const seen = new Set<string>();
    for (const { instance, row } of cache.instances.values()) {
      seen.add(instance.id);
      const existing = this.#trips.get(instance.id);
      if (existing) {
        existing.instance = instance;
        existing.scheduledVehicleId = row.vehicleId;
        if (row.status === 'cancelled') existing.progress = { ...existing.progress, status: 'cancelled' };
      } else {
        this.#trips.set(instance.id, { instance, scheduledVehicleId: row.vehicleId, progress: progressFromRow(row, instance.pattern) });
      }
    }
    // Drop instances that left the snapshot (past service dates, completed
    // or cancelled elsewhere), except trips still running in memory.
    for (const [id, tr] of this.#trips) {
      if (!seen.has(id) && tr.progress.status !== 'active') this.#trips.delete(id);
    }
    this.#cache = cache;
    this.metrics.lastReloadAt = this.#clock.now().toISOString();
    if (cache.skippedPatterns.length > 0) {
      this.#log.warn('patterns without shape or stops are ignored', { count: cache.skippedPatterns.length });
    }
    this.#log.info('cache loaded', {
      vehicles: cache.vehiclesByDevice.size,
      patterns: cache.patterns.size,
      tripInstances: cache.instances.size,
    });
  }

  /** Looks up a Traccar device; unknown devices are not Buspilot vehicles. */
  vehicleForDevice(deviceId: string): Vehicle | undefined {
    return this.#cache?.vehiclesByDevice.get(deviceId);
  }

  /** Counts a dropped position of a device that is not a Buspilot vehicle. Nothing else is kept. */
  noteUnknownDevice(): void {
    this.metrics.positionsUnknownDevice++;
  }

  /**
   * Processes one position. Unknown devices are dropped at once; nothing
   * about them (not even the device ID) is logged or stored.
   * Rejects if the write fails, so the caller can answer with an error and
   * Traccar retries.
   */
  async handlePosition(p: PositionInput): Promise<PositionOutcome> {
    const vehicle = this.vehicleForDevice(p.deviceId);
    if (!vehicle) {
      this.noteUnknownDevice();
      return 'unknown_device';
    }
    return this.#enqueue(vehicle.id, () => this.#process(vehicle, p));
  }

  /**
   * Periodic job: completes active trips whose window has closed (engine.md,
   * "Close stale trip instances"), even if their vehicle stopped sending.
   */
  async tick(): Promise<void> {
    const now = this.#clock.now();
    const jobs: Promise<unknown>[] = [];
    for (const tr of this.#trips.values()) {
      const vehicleId = tr.progress.vehicleId;
      if (tr.progress.status !== 'active' || vehicleId === null || windowOpen(tr.instance, now, this.#t)) continue;
      jobs.push(this.#enqueue(vehicleId, async () => {
        if (tr.progress.status !== 'active' || windowOpen(tr.instance, now, this.#t)) return;
        const next = this.#complete(tr.progress, now);
        await this.#store.persist({ vehicleState: null, trip: tripWrite(tr, next), stopEvents: [], etas: [] });
        tr.progress = next;
        this.#log.info('trip completed', { tripInstanceId: tr.instance.id, reason: 'window_closed' });
      }));
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') this.#log.error('tick failed', { error: errorMessage(r.reason) });
    }
  }

  /** Active trips whose vehicle has sent no position for staleAfterS (engine.md: ETAs uncertain). */
  staleTrips(): string[] {
    const now = this.#clock.now();
    const out: string[] = [];
    for (const tr of this.#trips.values()) {
      if (tr.progress.status !== 'active' || tr.progress.vehicleId === null) continue;
      const last = this.#lastFix.get(tr.progress.vehicleId);
      if (!last || secondsBetween(last.at, now) > this.#t.staleAfterS) out.push(tr.instance.id);
    }
    return out;
  }

  #enqueue<T>(vehicleId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(vehicleId) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.catch(() => undefined);
    this.#queues.set(vehicleId, tail);
    void tail.then(() => {
      if (this.#queues.get(vehicleId) === tail) this.#queues.delete(vehicleId);
    });
    return run;
  }

  async #process(vehicle: Vehicle, p: PositionInput): Promise<PositionOutcome> {
    const t = this.#t;
    const last = this.#lastFix.get(vehicle.id);
    if (last && ((p.positionId !== null && p.positionId === last.positionId) || p.fixTime <= last.at)) {
      this.metrics.positionsDuplicate++;
      return 'duplicate';
    }
    if (!p.valid || secondsBetween(this.#clock.now(), p.fixTime) > t.maxFutureFixS) {
      this.metrics.positionsInvalid++;
      return 'invalid';
    }
    const cache = this.#cache;
    const operator = cache?.operators.get(vehicle.operatorId);
    if (!operator) throw new Error('operator of a known vehicle is missing from the cache');

    const at = p.fixTime;
    const xy = operator.plane.toXY(p);
    const updates = new Map<TripRuntime, TripProgress>();
    const writes: Writes = { vehicleState: null, trip: null, stopEvents: [], etas: [] };
    const logs: [string, Record<string, string | number>][] = [];

    // 1. Trip assignment.
    let trip = activeTrip(this.#trips.values(), vehicle.id);
    let progress: TripProgress | null = null;
    let justStarted = false;
    if (trip && !windowOpen(trip.instance, at, t)) {
      const done = this.#complete(trip.progress, at);
      writes.trip = tripWrite(trip, done);
      updates.set(trip, done);
      logs.push(['trip completed', { tripInstanceId: trip.instance.id, reason: 'window_closed' }]);
      trip = undefined;
    }
    if (trip) {
      progress = { ...trip.progress };
    } else if (writes.trip === null) {
      const options: { trip: TripRuntime; startM: number; progress: TripProgress }[] = [];
      for (const cand of startCandidates(this.#trips.values(), vehicle, at, t)) {
        const ev = evaluateStart(cand, xy, t);
        updates.set(cand, ev.progress);
        if (ev.startM !== null) options.push({ trip: cand, startM: ev.startM, progress: ev.progress });
      }
      const chosen = chooseStart(options, at);
      if (chosen) {
        trip = chosen.trip;
        progress = {
          ...chosen.progress,
          status: 'active',
          vehicleId: vehicle.id,
          startedBy: 'schedule',
          startedAt: at,
          progressM: Math.max(chosen.progress.progressM, chosen.startM),
          progressAt: at,
          awaySince: null,
          offRouteSince: null,
          pendingJump: null,
          startCandidate: null,
        };
        justStarted = true;
        logs.push(['trip started', { tripInstanceId: trip.instance.id, vehicleId: vehicle.id }]);
      }
    }

    // 2.–4. Match, stop states, ETAs.
    if (trip && progress) {
      const before = trip.progress;
      const pattern = trip.instance.pattern;
      let m: number | null;
      if (justStarted) {
        m = progress.progressM;
      } else {
        const res = matchPosition(pattern.shape, progress, xy, at, expectedProgressAt(trip.instance, at), t);
        m = res.m;
        progress = { ...progress, ...res };
        if (before.offRouteSince === null && progress.offRouteSince !== null) {
          logs.push(['off route', { tripInstanceId: trip.instance.id }]);
        } else if (before.offRouteSince !== null && progress.offRouteSince === null) {
          logs.push(['back on route', { tripInstanceId: trip.instance.id }]);
        }
      }

      const finalStop = pattern.stops[pattern.stops.length - 1];
      if (finalStop && m !== null && m >= finalStop.distM - t.arrivedRadiusM) progress.reachedFinalStop = true;
      const leftFinalStop = progress.reachedFinalStop && finalStop !== undefined && distance(xy, finalStop.point) > t.finalLeaveM;

      const { stops, changes } = updateStops(pattern.stops, progress.stops, {
        m, progressM: progress.progressM, speedKmh: p.speedKmh, at, leftFinalStop,
      }, t);
      progress.stops = stops;
      progress.lastConfirmedStopSequence = lastConfirmedStop(stops);
      for (const c of changes) {
        const s = stops.find((x) => x.sequence === c.sequence);
        if (!s) continue;
        writes.stopEvents.push(stopEventWrite(trip.instance.id, s));
        logs.push(['stop event', { tripInstanceId: trip.instance.id, stopSequence: c.sequence, state: c.to }]);
      }

      if (allStopsFinal(stops)) {
        progress = this.#complete(progress, at);
        logs.push(['trip completed', { tripInstanceId: trip.instance.id, reason: 'last_stop' }]);
      } else if (progress.offRouteSince === null) {
        const etas = computeEtas(trip.instance, stops, progress.progressM, at, t);
        progress.stops = stops.map((s) => {
          const eta = etas.get(s.sequence);
          if (eta === undefined) return s;
          if (s.eta !== null && Math.abs(secondsBetween(s.eta, eta)) < t.etaWriteThresholdS) return s;
          writes.etas.push({ tripInstanceId: trip.instance.id, sequence: s.sequence, eta });
          return { ...s, eta };
        });
      }

      updates.set(trip, progress);
      if (tripChanged(before, progress)) writes.trip = tripWrite(trip, progress);
    }

    const activeId = trip && progress?.status === 'active' ? trip.instance.id : null;
    writes.vehicleState = {
      vehicleId: vehicle.id,
      operatorId: vehicle.operatorId,
      tripInstanceId: activeId,
      lon: p.lon,
      lat: p.lat,
      speedKmh: p.speedKmh,
      heading: p.course,
      accuracyM: p.accuracyM,
      recordedAt: at,
    };

    if (!isEmpty(writes)) {
      try {
        await this.#store.persist(writes);
      } catch (err) {
        this.metrics.positionsFailed++;
        throw err;
      }
    }
    for (const [tr, next] of updates) tr.progress = next;
    this.#lastFix.set(vehicle.id, { at, positionId: p.positionId });
    this.metrics.positionsProcessed++;
    this.metrics.lastPositionAt = at.toISOString();
    for (const [msg, fields] of logs) this.#log.info(msg, fields);
    return 'processed';
  }

  #complete(progress: TripProgress, at: Date): TripProgress {
    return { ...progress, status: 'completed', endedAt: at, pendingJump: null, startCandidate: null };
  }
}

function tripChanged(a: TripProgress, b: TripProgress): boolean {
  return a.status !== b.status
    || a.vehicleId !== b.vehicleId
    || a.progressM !== b.progressM
    || a.lastConfirmedStopSequence !== b.lastConfirmedStopSequence
    || (a.offRouteSince?.getTime() ?? null) !== (b.offRouteSince?.getTime() ?? null);
}

function tripWrite(tr: TripRuntime, p: TripProgress): TripWrite {
  return {
    id: tr.instance.id,
    status: p.status,
    vehicleId: p.vehicleId,
    startedBy: p.startedBy,
    progressM: p.progressM,
    progressAt: p.progressAt,
    lastConfirmedStopSequence: p.lastConfirmedStopSequence,
    offRouteSince: p.offRouteSince,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
  };
}

function stopEventWrite(tripInstanceId: string, s: TripProgress['stops'][number]): StopEventWrite {
  return {
    tripInstanceId,
    sequence: s.sequence,
    state: s.state,
    arrivedAt: s.arrivedAt,
    departedAt: s.departedAt,
    passedAt: s.passedAt,
  };
}
