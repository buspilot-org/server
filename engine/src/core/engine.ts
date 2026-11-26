/**
 * The engine: processes positions (engine.md, "Processing a position") and
 * periodic ticks, keeps the per-trip runtime state in memory and writes the
 * results through the store.
 *
 * Every change is computed on a copy of the runtime state, written in one
 * transaction, and only kept in memory once the write succeeded. If the write
 * fails, Traccar retries the position and it is processed again from the same
 * state. Positions of one vehicle are processed one at a time, in order. A
 * trip that any vehicle of the operator may run can be touched from two
 * vehicles' queues; a change is only kept if the trip's state is still the
 * one it was computed from.
 */
import type { TripObserver } from '../alerts/types.ts';
import type { Thresholds } from '../config.ts';
import { distance } from '../geo/plane.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { Store } from '../store/store.ts';
import type { StartStreak } from './assigner.ts';
import { activeTrip, chooseStart, evaluateStart, startCandidates, windowOpen } from './assigner.ts';
import type { Cache } from './cache.ts';
import { buildCache, progressFromRow } from './cache.ts';
import { computeEtas, expectedProgressAt } from './eta.ts';
import { matchPosition } from './matcher.ts';
import type { StopChange } from './stops.ts';
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
  /** Changes not kept because another vehicle changed the same trip meanwhile. */
  concurrentTripUpdates: number;
  lastPositionAt: string | null;
  lastReloadAt: string | null;
}

interface LastFix {
  at: Date;
  positionId: number | null;
}

/** A trip state change waiting for the write: kept only if the trip still has `base`. */
interface PendingUpdate {
  base: TripProgress;
  next: TripProgress;
}

export class Engine {
  readonly #store: Store;
  readonly #t: Thresholds;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #observers: TripObserver[];
  #cache: Cache | null = null;
  readonly #trips = new Map<string, TripRuntime>();
  readonly #lastFix = new Map<string, LastFix>();
  /** Start streaks per vehicle, by trip instance. */
  readonly #streaks = new Map<string, Map<string, StartStreak>>();
  readonly #queues = new Map<string, Promise<unknown>>();
  /** Trip starts the database refused (another vehicle runs the trip), per vehicle and trip, until the next reload. */
  readonly #refused = new Set<string>();
  /** The last vehicle_state written per vehicle (throttling). */
  readonly #stateWritten = new Map<string, { at: Date; tripInstanceId: string | null; offRoute: boolean }>();
  readonly metrics: EngineMetrics = {
    positionsProcessed: 0,
    positionsUnknownDevice: 0,
    positionsDuplicate: 0,
    positionsInvalid: 0,
    positionsFailed: 0,
    concurrentTripUpdates: 0,
    lastPositionAt: null,
    lastReloadAt: null,
  };

  constructor(opts: { store: Store; thresholds: Thresholds; clock?: Clock; log: Logger; observer?: TripObserver; observers?: TripObserver[] }) {
    this.#store = opts.store;
    this.#observers = [...(opts.observer ? [opts.observer] : []), ...(opts.observers ?? [])];
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
   * (Re)loads the cache from the database and merges it with the runtime
   * state:
   * - a trip not yet started in memory takes its database row as it is
   *   (a driver start, a vehicle assigned by staff);
   * - a trip cancelled or completed in the database is taken over;
   * - a trip running in memory keeps its memory state, which is at least as
   *   new as the database (every change is written before it is kept).
   * After a restart every trip starts from its database row.
   */
  async reload(): Promise<void> {
    const rows = await this.#store.loadSnapshot(this.#clock.now());
    const cache = buildCache(rows);
    // The newest fix already processed per vehicle, for deduplication after a
    // restart: vehicle_state is throttled, so an active trip's progress_at
    // (also a processed fix) can be newer.
    const processed = new Map<string, Date>();
    for (const v of rows.vehicles) if (v.lastFixAt) processed.set(v.id, v.lastFixAt);
    for (const r of rows.instances) {
      const prev = r.vehicleId === null ? undefined : processed.get(r.vehicleId);
      if (r.status === 'active' && r.vehicleId !== null && r.progressAt && (!prev || prev < r.progressAt)) processed.set(r.vehicleId, r.progressAt);
    }
    for (const [vehicleId, at] of processed) {
      const known = this.#lastFix.get(vehicleId);
      if (!known || known.at < at) this.#lastFix.set(vehicleId, { at, positionId: null });
    }
    const seen = new Set<string>();
    for (const { instance, row } of cache.instances.values()) {
      seen.add(instance.id);
      const scheduledVehicleId = row.vehicleId ?? row.defaultVehicleId;
      const existing = this.#trips.get(instance.id);
      if (!existing) {
        const progress = progressFromRow(row, instance.pattern);
        // After a restart: the last fix of the vehicle, not only the last accepted one.
        const vehicleFix = progress.vehicleId === null ? undefined : this.#lastFix.get(progress.vehicleId)?.at;
        if (progress.status === 'active' && vehicleFix && (!progress.lastFixAt || vehicleFix > progress.lastFixAt)) progress.lastFixAt = vehicleFix;
        this.#trips.set(instance.id, { instance, scheduledVehicleId, progress });
        continue;
      }
      existing.instance = instance;
      existing.scheduledVehicleId = scheduledVehicleId;
      const mem = existing.progress;
      if (mem.status === 'planned' || mem.status === 'cancelled') {
        // Take the row only if it changed, so a trip start being written
        // right now is not discarded by a stale copy.
        if (row.status !== mem.status || row.vehicleId !== mem.vehicleId) existing.progress = progressFromRow(row, instance.pattern);
      } else if (mem.status === 'active' && (row.status === 'cancelled' || row.status === 'completed')) {
        existing.progress = { ...existing.progress, status: row.status, endedAt: row.endedAt ?? existing.progress.endedAt };
        this.#log.info('trip ended in the database', { tripInstanceId: instance.id, status: row.status });
      } else if (
        mem.status === 'active' && row.vehicleId !== null && row.vehicleId !== mem.vehicleId
        && (row.status === 'active' || row.status === 'planned')
      ) {
        // (A planned row without a vehicle is only an older snapshot of a
        // start being written right now: memory is newer.)
        // The database disagrees about who runs the trip (a staff assignment
        // or driver start elsewhere, or a lost race): the database wins.
        existing.progress = progressFromRow(row, instance.pattern);
        this.#log.warn('trip taken over from the database', { tripInstanceId: instance.id, status: row.status });
      }
    }
    // Drop instances that left the snapshot (past service dates, inactive
    // routes), except trips still running in memory.
    for (const [id, tr] of this.#trips) {
      if (!seen.has(id) && tr.progress.status !== 'active') this.#trips.delete(id);
    }
    for (const streaks of this.#streaks.values()) {
      for (const id of streaks.keys()) if (this.#trips.get(id)?.progress.status !== 'planned') streaks.delete(id);
    }
    this.#refused.clear();
    this.#cache = cache;
    this.metrics.lastReloadAt = this.#clock.now().toISOString();
    this.#notify((o) => { o.tripsReloaded(this.#trips.values()); });
    if (cache.stopsWithoutDist > 0) {
      this.#log.warn('pattern stops without dist_along_shape are projected by the engine', { count: cache.stopsWithoutDist });
    }
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
        const base = tr.progress;
        if (base.status !== 'active' || windowOpen(tr.instance, now, this.#t)) return;
        const next = complete(base, now);
        const res = await this.#store.persist({ vehicleId, vehicleState: null, trip: tripWrite(tr, next), stopEvents: [], etas: [] });
        if (!res.tripApplied) {
          // Not this vehicle's trip any more: take the database's state.
          tr.progress = { ...base, status: 'completed', endedAt: now };
          return;
        }
        this.#commit(tr, { base, next });
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

  /** Observers (alerts, live API) must never fail position processing or a reload. */
  #notify(call: (o: TripObserver) => void): void {
    for (const o of this.#observers) {
      try {
        call(o);
      } catch (err) {
        this.#log.error('trip observer failed', { error: errorMessage(err) });
      }
    }
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

  #commit(tr: TripRuntime, u: PendingUpdate): void {
    if (tr.progress !== u.base) {
      this.metrics.concurrentTripUpdates++;
      this.#log.warn('trip changed concurrently; update not kept in memory', { tripInstanceId: tr.instance.id });
      return;
    }
    tr.progress = u.next;
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
    const updates = new Map<TripRuntime, PendingUpdate>();
    let streaks: Map<string, StartStreak> | null = null;
    const writes: Writes = { vehicleId: vehicle.id, vehicleState: null, trip: null, stopEvents: [], etas: [] };
    const logs: [string, Record<string, string | number>][] = [];
    let etas: ReadonlyMap<number, Date> = new Map();

    // 1. Trip assignment.
    let trip = activeTrip(this.#trips.values(), vehicle.id);
    let progress: TripProgress | null = null;
    let justStarted = false;
    if (trip && !windowOpen(trip.instance, at, t)) {
      const done = complete(trip.progress, at);
      writes.trip = tripWrite(trip, done);
      updates.set(trip, { base: trip.progress, next: done });
      logs.push(['trip completed', { tripInstanceId: trip.instance.id, reason: 'window_closed' }]);
      trip = undefined;
    }
    if (trip) {
      progress = { ...trip.progress };
    } else if (writes.trip === null) {
      const prevStreaks = this.#streaks.get(vehicle.id);
      streaks = new Map();
      const options: { trip: TripRuntime; startM: number; streak: StartStreak | null }[] = [];
      for (const cand of startCandidates(this.#trips.values(), vehicle, at, t)) {
        if (this.#refused.has(`${vehicle.id}:${cand.instance.id}`)) continue;
        const ev = evaluateStart(cand, prevStreaks?.get(cand.instance.id) ?? null, xy, at, p.speedKmh, t);
        if (ev.streak) streaks.set(cand.instance.id, ev.streak);
        if (ev.startM !== null) options.push({ trip: cand, startM: ev.startM, streak: ev.streak });
      }
      const chosen = chooseStart(options, at);
      if (chosen) {
        trip = chosen.trip;
        streaks.clear();
        progress = {
          ...trip.progress,
          status: 'active',
          vehicleId: vehicle.id,
          startedBy: 'schedule',
          startedAt: at,
          progressM: Math.max(trip.progress.progressM, chosen.startM),
          progressAt: at,
          lastFixAt: at,
          lastFixXY: xy,
          awaySince: null,
          offRouteSince: null,
          pendingJump: null,
        };
        // The bus stood at the first stop before pulling away: it was arrived there.
        const firstSeq = trip.instance.pattern.stops[0]?.sequence;
        const since = chosen.streak?.atFirstStopSince ?? null;
        if (since !== null) {
          progress.stops = progress.stops.map((s) => (s.sequence === firstSeq && s.state === 'upcoming' ? { ...s, state: 'arrived', arrivedAt: since } : s));
          const first = progress.stops.find((s) => s.sequence === firstSeq);
          if (first?.state === 'arrived') {
            writes.stopEvents.push(stopEventWrite(trip.instance.id, first));
            logs.push(['stop event', { tripInstanceId: trip.instance.id, stopSequence: first.sequence, state: 'arrived' }]);
          }
        }
        justStarted = true;
        logs.push(['trip started', { tripInstanceId: trip.instance.id, vehicleId: vehicle.id }]);
      }
    }

    // 2.–4. Match, stop states, ETAs.
    if (trip && progress) {
      const before = trip.progress;
      const pattern = trip.instance.pattern;
      let m: number | null;
      const changes: StopChange[] = [];
      if (justStarted) {
        m = progress.progressM;
      } else {
        const { m: matched, confirmedHeld, ...state } = matchPosition(
          pattern.shape, progress, { xy, at, speedKmh: p.speedKmh, course: p.course }, expectedProgressAt(trip.instance, at), t,
        );
        m = matched;
        const progressBefore = progress.progressM;
        progress = { ...progress, ...state, stops: progress.stops };
        // Fixes held for confirmation (e.g. a stop dwell) count now, in order.
        let heldProgress = progressBefore;
        const lastStop = pattern.stops[pattern.stops.length - 1];
        for (const h of confirmedHeld) {
          heldProgress = Math.max(heldProgress, h.m);
          if (lastStop && h.m >= lastStop.distM - t.arrivedRadiusM) progress.reachedFinalStop = true;
          const r = updateStops(pattern.stops, progress.stops, { m: h.m, progressM: heldProgress, speedKmh: h.speedKmh, at: h.at, leftFinalStop: false }, t);
          progress.stops = r.stops;
          changes.push(...r.changes);
        }
        if (before.offRouteSince === null && progress.offRouteSince !== null) {
          logs.push(['off route', { tripInstanceId: trip.instance.id }]);
        } else if (before.offRouteSince !== null && progress.offRouteSince === null) {
          logs.push(['back on route', { tripInstanceId: trip.instance.id }]);
        }
      }

      const finalStop = pattern.stops[pattern.stops.length - 1];
      if (finalStop && m !== null && m >= finalStop.distM - t.arrivedRadiusM) progress.reachedFinalStop = true;
      if (progress.reachedFinalStop && finalStop !== undefined) {
        progress.finalLeaveCount = distance(xy, finalStop.point) > t.finalLeaveM ? progress.finalLeaveCount + 1 : 0;
      }
      const leftFinalStop = progress.finalLeaveCount >= t.finalLeaveFixes;

      const current = updateStops(pattern.stops, progress.stops, {
        m, progressM: progress.progressM, speedKmh: p.speedKmh, at, leftFinalStop,
      }, t);
      const stops = current.stops;
      changes.push(...current.changes);
      progress.stops = stops;
      progress.lastConfirmedStopSequence = lastConfirmedStop(stops);
      // One write per change, in order (a replayed dwell can arrive and
      // depart a stop within one fix).
      for (const c of changes) {
        const s = stops.find((x) => x.sequence === c.sequence);
        if (!s) continue;
        writes.stopEvents.push(stopEventWrite(trip.instance.id, {
          ...s,
          state: c.to,
          departedAt: c.to === 'departed' ? s.departedAt : null,
          passedAt: c.to === 'passed' ? s.passedAt : null,
        }));
        logs.push(['stop event', { tripInstanceId: trip.instance.id, stopSequence: c.sequence, state: c.to }]);
      }

      if (allStopsFinal(stops)) {
        progress = complete(progress, at);
        logs.push(['trip completed', { tripInstanceId: trip.instance.id, reason: 'last_stop' }]);
      } else if (progress.offRouteSince === null) {
        etas = computeEtas(trip.instance, stops, progress.progressM, at, t);
        progress.stops = stops.map((s) => {
          const eta = etas.get(s.sequence);
          if (eta === undefined) return s;
          if (s.eta !== null && Math.abs(secondsBetween(s.eta, eta)) < t.etaWriteThresholdS) return s;
          writes.etas.push({ tripInstanceId: trip.instance.id, sequence: s.sequence, eta });
          return { ...s, eta };
        });
      }

      updates.set(trip, { base: before, next: progress });
      if (justStarted || tripChanged(before, progress)) writes.trip = tripWrite(trip, progress);
    }

    const activeId = trip && progress?.status === 'active' ? trip.instance.id : null;
    // vehicle_state is for the admin console: at most every
    // vehicleStateIntervalS, at once when the trip or the off-route state
    // changes, or when the vehicle comes back after being stale.
    const offRoute = activeId !== null && progress?.offRouteSince != null;
    const written = this.#stateWritten.get(vehicle.id);
    const stateDue = !written
      || secondsBetween(written.at, at) >= t.vehicleStateIntervalS
      || written.tripInstanceId !== activeId
      || written.offRoute !== offRoute
      || (last !== undefined && secondsBetween(last.at, at) > t.staleAfterS)
      // With stop changes it costs nothing extra, and recorded_at then
      // covers the fix after a restart.
      || writes.stopEvents.length > 0;
    if (stateDue) writes.vehicleState = {
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

    let tripApplied = true;
    if (!isEmpty(writes)) {
      try {
        tripApplied = (await this.#store.persist(writes)).tripApplied;
      } catch (err) {
        this.metrics.positionsFailed++;
        throw err;
      }
    }
    // The trip the database linked this fix to (vehicle_state.trip_instance_id).
    const linkedTrip = !tripApplied && writes.trip?.id === activeId ? null : activeId;
    // The trip compared next time is the one the engine assigned (not what the
    // database linked), so a refused trip write does not force a write per fix.
    if (writes.vehicleState) this.#stateWritten.set(vehicle.id, { at, tripInstanceId: activeId, offRoute });
    for (const [tr, u] of updates) {
      if (!tripApplied && writes.trip?.id === tr.instance.id) {
        // Another vehicle runs this trip (or it was cancelled): the database
        // did not take the change, so memory does not either. The next
        // reload brings the database's state.
        this.metrics.concurrentTripUpdates++;
        this.#log.warn('trip write not applied; change not kept', { tripInstanceId: tr.instance.id, vehicleId: vehicle.id });
        if (tr.progress.status === 'planned') this.#refused.add(`${vehicle.id}:${tr.instance.id}`);
        continue;
      }
      this.#commit(tr, u);
      // Alerts only from a state that was written and kept.
      if (tr === trip && tr.progress === u.next) {
        const progress = tr.progress;
        this.#notify((o) => { o.tripUpdated({ instance: tr.instance, progress, etas, fixAt: at }); });
      }
    }
    if (streaks !== null) this.#streaks.set(vehicle.id, streaks);
    else this.#streaks.delete(vehicle.id);
    this.#lastFix.set(vehicle.id, { at, positionId: p.positionId });
    const fix = {
      vehicleId: vehicle.id, operatorId: vehicle.operatorId, tripInstanceId: linkedTrip,
      lon: p.lon, lat: p.lat, speedKmh: p.speedKmh, heading: p.course, accuracyM: p.accuracyM, at,
    };
    this.#notify((o) => o.vehicleUpdated?.(fix));
    this.metrics.positionsProcessed++;
    this.metrics.lastPositionAt = at.toISOString();
    for (const [msg, fields] of logs) this.#log.info(msg, fields);
    return 'processed';
  }
}

function complete(progress: TripProgress, at: Date): TripProgress {
  return { ...progress, status: 'completed', endedAt: at, pendingJump: null };
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
