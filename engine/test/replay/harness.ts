/**
 * Replay harness: synthetic routes and tracks in metres, an in-memory store
 * with the same write semantics as PgStore, and a fake clock. Positions are
 * fed through Engine.handlePosition exactly as the HTTP endpoint does.
 */
import { AlertDispatcher, defaultAlertConfig, type AlertConfig } from '../../src/alerts/dispatcher.ts';
import type { AlertStore, DeliveryClaim, PushMessage, PushSender, SendResult, Subscription } from '../../src/alerts/types.ts';
import { defaultThresholds, type Thresholds } from '../../src/config.ts';
import { Engine, type Clock, type PositionOutcome } from '../../src/core/engine.ts';
import { serviceTime } from '../../src/core/time.ts';
import type { StopState, TripStatus, Writes } from '../../src/core/types.ts';
import { stopStateRank } from '../../src/core/types.ts';
import { LocalPlane, Polyline, distance, type XY } from '../../src/geo/plane.ts';
import { silentLogger } from '../../src/log.ts';
import type { InstanceRow, PersistResult, SnapshotRows, Store } from '../../src/store/store.ts';

export const TZ = 'Asia/Tokyo';
export const OPERATOR = 'op-1';
export const VEHICLE = 'veh-1';
export const DEVICE = '23273424';
export const VEHICLE_2 = 'veh-2';
export const DEVICE_2 = 'device-2';
export const ROUTE = 'route-1';
export const PATTERN = 'pattern-1';
/** Origin of the test plane: Kobe. */
export const ORIGIN = { lon: 135.19, lat: 34.69 };

export class FakeClock implements Clock {
  #now: Date;
  constructor(start: Date) {
    this.#now = start;
  }
  now(): Date {
    return this.#now;
  }
  set(t: Date): void {
    this.#now = t;
  }
}

export interface StopTransition {
  tripInstanceId: string;
  sequence: number;
  state: StopState;
  at: Date;
}

export interface DeliveryRow extends DeliveryClaim {
  id: string;
  sentAt: Date | null;
  result: string;
}

/** In-memory Store with the same idempotent, forward-only semantics as PgStore. */
export class MemoryStore implements Store, AlertStore {
  rows: SnapshotRows;
  subscriptions: Subscription[] = [];
  deliveries: DeliveryRow[] = [];
  clearedTokens: string[] = [];
  failClaims = 0;
  vehicleState = new Map<string, NonNullable<Writes['vehicleState']>>();
  transitions: StopTransition[] = [];
  etaWrites = 0;
  persistCalls = 0;
  failNext = 0;

  constructor(rows: SnapshotRows) {
    this.rows = rows;
  }

  loadSnapshot(): Promise<SnapshotRows> {
    const copy = structuredClone(this.rows);
    for (const v of copy.vehicles) v.lastFixAt = this.vehicleState.get(v.id)?.recordedAt ?? null;
    return Promise.resolve(copy);
  }

  persist(w: Writes): Promise<PersistResult> {
    this.persistCalls++;
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('simulated database failure'));
    }
    const v = w.vehicleId;
    // Same order and guards as PgStore: claim, vehicle state, stop events, ETAs, trip.
    if (w.trip && w.trip.status !== 'planned') {
      const row = this.instance(w.trip.id);
      if (row.vehicleId === null && row.status === 'planned') row.vehicleId = v;
    }
    const runs = (id: string): boolean => {
      const row = this.instance(id);
      return row.vehicleId === v && (row.status === 'planned' || row.status === 'active');
    };
    if (w.vehicleState) {
      const vs = w.vehicleState;
      const prev = this.vehicleState.get(vs.vehicleId);
      const tripInstanceId = vs.tripInstanceId !== null && runs(vs.tripInstanceId) ? vs.tripInstanceId : null;
      if (!prev || prev.recordedAt < vs.recordedAt) this.vehicleState.set(vs.vehicleId, { ...vs, tripInstanceId });
    }
    for (const e of w.stopEvents) {
      if (!runs(e.tripInstanceId)) continue;
      const row = this.instance(e.tripInstanceId);
      const ev = row.stopEvents.find((x) => x.sequence === e.sequence);
      if (!ev) throw new Error(`missing stop event ${e.sequence}`);
      if (stopStateRank[ev.state] >= stopStateRank[e.state] || ev.state === 'departed' || ev.state === 'passed') continue;
      if (e.state === 'passed' && ev.arrivedAt !== null) continue;
      if (e.state === 'departed' && (ev.arrivedAt ?? e.arrivedAt) === null) continue;
      ev.state = e.state;
      ev.arrivedAt ??= e.arrivedAt;
      ev.departedAt ??= e.departedAt;
      ev.passedAt ??= e.passedAt;
      const at = e.state === 'arrived' ? e.arrivedAt : e.state === 'departed' ? e.departedAt : e.passedAt;
      this.transitions.push({ tripInstanceId: e.tripInstanceId, sequence: e.sequence, state: e.state, at: at ?? new Date(0) });
    }
    for (const e of w.etas) {
      if (!runs(e.tripInstanceId)) continue;
      const ev = this.instance(e.tripInstanceId).stopEvents.find((x) => x.sequence === e.sequence);
      if (ev && (ev.state === 'upcoming' || ev.state === 'approaching')) {
        ev.eta = e.eta;
        this.etaWrites++;
      }
    }
    let tripApplied = true;
    if (w.trip) {
      const tr = w.trip;
      const row = this.instance(tr.id);
      tripApplied = row.status !== 'cancelled' && row.vehicleId === v;
      if (tripApplied) {
        const oldStatus = row.status;
        const rank: Record<TripStatus, number> = { planned: 0, active: 1, completed: 2, cancelled: 3 };
        if (rank[tr.status] > rank[row.status] && tr.status !== 'cancelled') row.status = tr.status;
        if (oldStatus === 'planned') row.startedBy = tr.startedBy;
        row.progressM = Math.max(row.progressM, tr.progressM);
        if (tr.progressAt && (!row.progressAt || tr.progressAt > row.progressAt)) row.progressAt = tr.progressAt;
        if (tr.lastConfirmedStopSequence !== null) {
          row.lastConfirmedStopSequence = Math.max(row.lastConfirmedStopSequence ?? -1, tr.lastConfirmedStopSequence);
        }
        if (oldStatus !== 'completed') row.offRouteSince = tr.offRouteSince;
        row.startedAt ??= tr.startedAt;
        row.endedAt ??= tr.endedAt;
      }
    }
    return Promise.resolve({ tripApplied });
  }

  loadSubscriptions(): Promise<Subscription[]> {
    return Promise.resolve(structuredClone(this.subscriptions));
  }

  claimDelivery(c: DeliveryClaim): Promise<string | null> {
    if (this.failClaims > 0) {
      this.failClaims--;
      return Promise.reject(new Error('simulated database failure'));
    }
    const exists = this.deliveries.some((d) => d.subscriptionId === c.subscriptionId && d.tripInstanceId === c.tripInstanceId
      && d.stopSequence === c.stopSequence && d.kind === c.kind);
    if (exists) return Promise.resolve(null);
    const id = `delivery-${this.deliveries.length + 1}`;
    this.deliveries.push({ ...c, id, sentAt: null, result: 'pending' });
    return Promise.resolve(id);
  }

  finishDelivery(id: string, sentAt: Date | null, result: string): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (d) {
      d.sentAt = sentAt;
      d.result = result;
    }
    return Promise.resolve();
  }

  clearPushToken(deviceId: string, token: string): Promise<void> {
    for (const s of this.subscriptions) {
      if (s.deviceId === deviceId && s.pushToken === token) s.pushToken = '';
    }
    this.subscriptions = this.subscriptions.filter((s) => s.pushToken !== '');
    this.clearedTokens.push(deviceId);
    return Promise.resolve();
  }

  createTripInstances(): Promise<number> {
    return Promise.resolve(0);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  instance(id: string): InstanceRow {
    const row = this.rows.instances.find((i) => i.id === id);
    if (!row) throw new Error(`no trip instance ${id}`);
    return row;
  }

  stopState(tripInstanceId: string, sequence: number): StopState | undefined {
    return this.instance(tripInstanceId).stopEvents.find((e) => e.sequence === sequence)?.state;
  }
}

export interface StopDef {
  sequence: number;
  /** Stop location in metres. */
  at: XY;
  arrivalOffsetS: number;
  departureOffsetS: number;
  /** Leave out to let the cache project the stop onto the shape. */
  distM?: number;
}

export interface TripDef {
  id: string;
  serviceDate: string;
  /** "HH:MM" local time. */
  start: string;
  vehicleId?: string | null;
}

export interface RouteDef {
  shape: XY[];
  stops: StopDef[];
  trips: TripDef[];
}

export function hhmm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60;
}

/** Records sent messages; `script` answers the next sends (default: ok). */
export class FakeSender implements PushSender {
  readonly sent: (PushMessage & { at: Date })[] = [];
  readonly attempts: PushMessage[] = [];
  script: SendResult[] = [];
  readonly #clock: Clock;
  constructor(clock: Clock) {
    this.#clock = clock;
  }
  send(msg: PushMessage): Promise<SendResult> {
    this.attempts.push(msg);
    const res = this.script.shift() ?? { ok: true };
    if (res.ok) this.sent.push({ ...msg, at: this.#clock.now() });
    return Promise.resolve(res);
  }
  /** `kind@stop_sequence` of the sent messages, in order. */
  kinds(): string[] {
    return this.sent.map((m) => `${m.payload.data.kind ?? ''}@${m.payload.data.stop_sequence ?? ''}`);
  }
}

/** A subscription for the test route, with defaults. */
export function subscription(id: string, stopSequence: number, opts: Partial<Subscription> = {}): Subscription {
  return {
    id, operatorId: OPERATOR, deviceId: `device-of-${id}`, patternId: PATTERN, stopSequence,
    trigger: 'minutes', triggerValue: 5, notifyPassed: false, mutedUntil: null, createdAt: new Date(0),
    pushToken: `fid-${id}`, language: 'en', timezone: TZ, routeId: ROUTE, routeName: { ja: '朝便A', en: 'Morning route A' },
    routeShortName: null, stopId: `stop-${stopSequence}`, stopName: { ja: `停留所${stopSequence}`, en: `Stop ${stopSequence}` },
    ...opts,
  };
}

export class Scenario {
  readonly plane = new LocalPlane(ORIGIN);
  /** Course of the generated fixes: the direction of travel (set to null to send none). */
  sendCourse = true;
  readonly shape: Polyline;
  readonly store: MemoryStore;
  readonly clock: FakeClock;
  readonly def: RouteDef;
  readonly thresholds: Thresholds;
  readonly alertConfig: AlertConfig;
  readonly sender: FakeSender;
  /** Waits between send retries the dispatcher asked for (ms). */
  readonly sleeps: number[] = [];
  alerts: AlertDispatcher;
  engine: Engine;
  #positionId = 1000;

  private constructor(def: RouteDef, thresholds: Thresholds, alertConfig: Partial<AlertConfig>) {
    this.def = def;
    this.thresholds = thresholds;
    this.alertConfig = { ...defaultAlertConfig, staleAfterS: thresholds.staleAfterS, ...alertConfig };
    this.shape = new Polyline(def.shape);
    const ll = (p: XY): [number, number] => {
      const q = this.plane.toLonLat(p);
      return [q.lon, q.lat];
    };
    this.store = new MemoryStore({
      operators: [{ id: OPERATOR, timezone: TZ }],
      vehicles: [
        { id: VEHICLE, operatorId: OPERATOR, deviceId: DEVICE, lastFixAt: null },
        { id: VEHICLE_2, operatorId: OPERATOR, deviceId: DEVICE_2, lastFixAt: null },
      ],
      shapes: [{ id: 'shape-1', operatorId: OPERATOR, coordinates: def.shape.map(ll), lengthM: this.shape.length }],
      patterns: [{ id: PATTERN, operatorId: OPERATOR, routeId: ROUTE, shapeId: 'shape-1' }],
      patternStops: def.stops.map((s) => {
        const [lon, lat] = ll(s.at);
        return {
          patternId: PATTERN, sequence: s.sequence, lon, lat, distAlongShape: s.distM ?? null,
          arrivalOffsetS: s.arrivalOffsetS, departureOffsetS: s.departureOffsetS,
        };
      }),
      instances: def.trips.map((t) => ({
        id: t.id, operatorId: OPERATOR, serviceDate: t.serviceDate, tripId: `trip-${t.id}`, patternId: PATTERN,
        startTimeS: hhmm(t.start), vehicleId: null, defaultVehicleId: t.vehicleId === undefined ? VEHICLE : t.vehicleId,
        status: 'planned', startedBy: 'schedule', progressM: 0, progressAt: null, lastConfirmedStopSequence: null,
        offRouteSince: null, startedAt: null, endedAt: null,
        stopEvents: def.stops.map((s) => ({ sequence: s.sequence, state: 'upcoming', arrivedAt: null, departedAt: null, passedAt: null, eta: null })),
      })),
    });
    const first = def.trips[0];
    this.clock = new FakeClock(first ? serviceTime(first.serviceDate, 0, TZ) : new Date(0));
    this.sender = new FakeSender(this.clock);
    this.alerts = this.#newDispatcher();
    this.engine = this.#newEngine();
  }

  static async create(
    def: RouteDef,
    thresholds: Partial<Thresholds> = {},
    opts: { subscriptions?: Subscription[]; alerts?: Partial<AlertConfig> } = {},
  ): Promise<Scenario> {
    const s = new Scenario(def, { ...defaultThresholds, ...thresholds }, opts.alerts ?? {});
    s.store.subscriptions = opts.subscriptions ?? [];
    await s.alerts.reloadSubscriptions();
    await s.engine.reload();
    await s.alerts.idle();
    return s;
  }

  #newDispatcher(): AlertDispatcher {
    return new AlertDispatcher({
      store: this.store, sender: this.sender, clock: this.clock, log: silentLogger, config: this.alertConfig,
      sleep: (ms) => {
        this.sleeps.push(ms);
        return Promise.resolve();
      },
    });
  }

  #newEngine(): Engine {
    return new Engine({ store: this.store, thresholds: this.thresholds, clock: this.clock, log: silentLogger, observer: this.alerts });
  }

  /** Simulates an engine restart: a new engine (and dispatcher) that only knows what is in the store. */
  async restart(): Promise<void> {
    this.alerts = this.#newDispatcher();
    this.engine = this.#newEngine();
    await this.alerts.reloadSubscriptions();
    await this.engine.reload();
    await this.alerts.idle();
  }

  /** Reloads the cache as the periodic job does (picks up database changes). */
  async reload(): Promise<void> {
    await this.engine.reload();
    await this.alerts.idle();
  }

  tripStart(tripId: string): Date {
    const t = this.def.trips.find((x) => x.id === tripId);
    if (!t) throw new Error(`no trip ${tripId}`);
    return serviceTime(t.serviceDate, hhmm(t.start), TZ);
  }

  /**
   * Feeds fixes in order; the clock is set to each fix time plus `latencyS`
   * (default 1 s; more simulates positions arriving late, i.e. stale).
   */
  async feed(fixes: readonly Fix[], opts: { tickEveryS?: number; latencyS?: number } = {}): Promise<PositionOutcome[]> {
    const out: PositionOutcome[] = [];
    let lastTick: Date | null = null;
    for (const f of fixes) {
      this.clock.set(new Date(f.t.getTime() + (opts.latencyS ?? 1) * 1000));
      const ll = this.plane.toLonLat(f.xy);
      out.push(await this.engine.handlePosition({
        deviceId: f.deviceId ?? DEVICE,
        positionId: f.positionId ?? this.#positionId++,
        fixTime: f.t,
        lon: ll.lon,
        lat: ll.lat,
        speedKmh: f.speedKmh,
        course: this.sendCourse ? (f.course ?? null) : null,
        accuracyM: 5,
        valid: true,
      }));
      await this.alerts.idle();
      if (opts.tickEveryS !== undefined && (!lastTick || f.t.getTime() - lastTick.getTime() >= opts.tickEveryS * 1000)) {
        await this.engine.tick();
        lastTick = f.t;
      }
    }
    return out;
  }

  /** Advances the clock and runs the periodic tick. */
  async tickAt(t: Date): Promise<void> {
    this.clock.set(t);
    await this.engine.tick();
  }

  state(tripId: string, sequence: number): StopState | undefined {
    return this.store.stopState(tripId, sequence);
  }

  states(tripId: string): Record<number, StopState> {
    return Object.fromEntries(this.store.instance(tripId).stopEvents.map((e) => [e.sequence, e.state]));
  }

  transitions(tripId: string): string[] {
    return this.store.transitions.filter((x) => x.tripInstanceId === tripId).map((x) => `${x.sequence}:${x.state}`);
  }
}

export interface Fix {
  t: Date;
  xy: XY;
  speedKmh: number;
  /** Direction of travel (degrees from north), as a GPS course. */
  course?: number | null;
  positionId?: number;
  deviceId?: string;
}

/**
 * Builds a synthetic track: driving along the shape, dwelling, or driving
 * straight to points off the shape. One fix every `intervalS` seconds.
 */
export class Track {
  readonly fixes: Fix[] = [];
  #t: Date;
  #xy: XY;
  #m: number | null;
  readonly #shape: Polyline;
  readonly #intervalS: number;

  constructor(shape: Polyline, start: Date, opts: { startM?: number; startXY?: XY; intervalS?: number } = {}) {
    this.#shape = shape;
    this.#t = start;
    this.#intervalS = opts.intervalS ?? 5;
    this.#m = opts.startXY ? null : (opts.startM ?? 0);
    this.#xy = opts.startXY ?? shape.pointAt(this.#m ?? 0);
  }

  get time(): Date {
    return this.#t;
  }

  /** One fix. The course is the direction of travel at that moment (given), or the chord from the previous fix. */
  #emit(xy: XY, speedKmh: number, direction?: number): void {
    this.#t = new Date(this.#t.getTime() + this.#intervalS * 1000);
    const dx = xy.x - this.#xy.x;
    const dy = xy.y - this.#xy.y;
    const chord = dx !== 0 || dy !== 0 ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : null;
    const course = speedKmh > 0 ? (direction ?? chord) : null;
    this.#xy = xy;
    this.fixes.push({ t: this.#t, xy, speedKmh, course });
  }

  /** Drive along the shape to `toM` at a constant speed. Optional `noise(i)` offsets each fix. */
  drive(toM: number, speedKmh: number, noise?: (i: number) => XY): this {
    let m = this.#m ?? this.#shape.nearest(this.#xy)?.m ?? 0;
    const step = (speedKmh / 3.6) * this.#intervalS;
    let i = 0;
    while (m < toM - 1e-6) {
      m = Math.min(toM, m + step);
      const p = this.#shape.pointAt(m);
      const n = noise?.(i++) ?? { x: 0, y: 0 };
      // Like a GPS course: the direction of the street at this point.
      const direction = this.#shape.nearest(p, m - 0.5, m)?.bearing;
      this.#emit({ x: p.x + n.x, y: p.y + n.y }, speedKmh, direction);
    }
    this.#m = m;
    return this;
  }

  /** Stand still for `seconds`. */
  dwell(seconds: number): this {
    const n = Math.max(1, Math.round(seconds / this.#intervalS));
    for (let i = 0; i < n; i++) this.#emit(this.#xy, 0);
    return this;
  }

  /** Drive in a straight line to a point (off the shape). */
  goTo(target: XY, speedKmh: number): this {
    const start = this.#xy;
    const d = distance(start, target);
    const steps = Math.max(1, Math.ceil(d / ((speedKmh / 3.6) * this.#intervalS)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      this.#emit({ x: start.x + (target.x - start.x) * f, y: start.y + (target.y - start.y) * f }, speedKmh);
    }
    this.#m = null;
    return this;
  }

  /** Jump back onto the shape at `m` (the next fix is there). */
  rejoin(m: number, speedKmh: number): this {
    this.#emit(this.#shape.pointAt(m), speedKmh);
    this.#m = m;
    return this;
  }

  /** No fixes for `seconds`. */
  gap(seconds: number): this {
    this.#t = new Date(this.#t.getTime() + seconds * 1000);
    return this;
  }

  /** Continue at an absolute time (e.g. waiting for a scheduled start). */
  waitUntil(t: Date): this {
    if (t > this.#t) this.#t = t;
    return this;
  }
}
