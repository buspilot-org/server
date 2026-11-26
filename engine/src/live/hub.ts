/**
 * The live API's in-memory state (engine.md, "Live API"): the directory
 * (names, schedule, trips, access) loaded from the database, plus the
 * engine's trip state and the latest fix of each vehicle, which arrive as the
 * engine processes positions. Requests are answered from here, without
 * database reads.
 *
 * Reloads: a change notification (LISTEN buspilot_live, payload = table)
 * reloads only the part of the snapshot that table belongs to, debounced and
 * at most every `minReloadIntervalMs`; everything is reloaded every
 * `LIVE_RELOAD_SECONDS` as a safety net.
 *
 * Fails closed: if access data could not be loaded for `maxAgeS` (Supabase
 * outage, broken query), `fresh` turns false and member endpoints answer 503
 * rather than serve memberships that may have been revoked meanwhile.
 *
 * Listeners (SSE streams) are told which routes and trips changed.
 */
import type { TripObserver, TripUpdate } from '../alerts/types.ts';
import type { Clock } from '../core/engine.ts';
import type { TripRuntime } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import { Directory } from './directory.ts';
import type { LivePart, LiveSnapshot, LiveStore, VehicleFix } from './types.ts';
import { LIVE_PARTS, PART_OF_TABLE } from './types.ts';
import type { ViewContext } from './views.ts';

/** What changed: specific routes and trips, or everything (a reload). */
export type Change = { all: true } | { all: false; routeIds: readonly string[]; tripIds: readonly string[] };

export type ChangeListener = (c: Change) => void;

export interface HubOptions {
  store: LiveStore;
  clock: Clock;
  log: Logger;
  /** The engine's trips (Engine.trips). */
  trips: () => ReadonlyMap<string, TripRuntime>;
  staleAfterS: number;
  /** Wait this long after a change notification before reloading (coalesces bursts) (ms). */
  debounceMs?: number;
  /** At least this long between reloads caused by notifications (ms). */
  minReloadIntervalMs?: number;
  /** Access data older than this (s) is not used for members (503). */
  maxAgeS?: number;
}

export class LiveHub implements TripObserver {
  readonly #store: LiveStore;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #trips: () => ReadonlyMap<string, TripRuntime>;
  readonly #staleAfterS: number;
  readonly #debounceMs: number;
  readonly #minReloadIntervalMs: number;
  readonly #maxAgeS: number;
  #lastReloadStart = 0;
  #snapshot: LiveSnapshot | null = null;
  #dir: Directory | null = null;
  /** When the access part was last loaded (clock time). */
  #accessLoadedAt: Date | null = null;
  readonly #fixes = new Map<string, VehicleFix>();
  readonly #listeners = new Set<ChangeListener>();
  #reloading: Promise<void> | null = null;
  /** Parts asked for and not loaded yet. */
  readonly #queued = new Set<LivePart>();
  #timer: NodeJS.Timeout | null = null;
  #unlisten: (() => Promise<void>) | null = null;
  readonly metrics = { reloads: 0, reloadFailures: 0, notifications: 0, lastReloadAt: null as string | null };

  constructor(o: HubOptions) {
    this.#store = o.store;
    this.#clock = o.clock;
    this.#log = o.log;
    this.#trips = o.trips;
    this.#staleAfterS = o.staleAfterS;
    this.#debounceMs = o.debounceMs ?? 500;
    this.#minReloadIntervalMs = o.minReloadIntervalMs ?? 2000;
    this.#maxAgeS = o.maxAgeS ?? 300;
  }

  get loaded(): boolean {
    return this.#dir !== null;
  }

  /** Age of the access data (s), or null before the first load. */
  get ageS(): number | null {
    return this.#accessLoadedAt === null ? null : Math.max(0, (this.#clock.now().getTime() - this.#accessLoadedAt.getTime()) / 1000);
  }

  /** Loaded, and the access data is recent enough to answer members. */
  get fresh(): boolean {
    const age = this.ageS;
    return age !== null && age <= this.#maxAgeS;
  }

  /** A consistent view of the current state for one request. Null until the first load. */
  context(): ViewContext | null {
    const dir = this.#dir;
    if (!dir) return null;
    const trips = this.#trips();
    return {
      dir,
      runtime: (id) => trips.get(id),
      fix: (vehicleId) => this.#fixes.get(vehicleId),
      now: this.#clock.now(),
      staleAfterS: this.#staleAfterS,
    };
  }

  onChange(l: ChangeListener): () => void {
    this.#listeners.add(l);
    return () => { this.#listeners.delete(l); };
  }

  #emit(c: Change): void {
    for (const l of this.#listeners) {
      try {
        l(c);
      } catch (err) {
        this.#log.error('live listener failed', { error: errorMessage(err) });
      }
    }
  }

  /**
   * Loads the given parts (default: all) now. Concurrent calls share the
   * running load; parts asked for meanwhile are loaded right after it. Rejects
   * if the last load attempt failed; the last good directory stays in use.
   */
  async reload(parts: readonly LivePart[] = LIVE_PARTS): Promise<void> {
    for (const p of parts) this.#queued.add(p);
    if (this.#reloading) return this.#reloading;
    this.#reloading = (async () => {
      while (this.#queued.size > 0) {
        // Without a full snapshot yet, everything is loaded.
        const take = this.#snapshot === null ? [...LIVE_PARTS] : [...this.#queued];
        this.#queued.clear();
        this.#lastReloadStart = Date.now();
        try {
          const loaded = await this.#store.loadLiveSnapshot(take);
          const merged = { ...(this.#snapshot ?? {}), ...loaded } as LiveSnapshot;
          this.#dir = new Directory(merged);
          this.#snapshot = merged;
          if (take.includes('access')) this.#accessLoadedAt = this.#clock.now();
          this.metrics.reloads++;
          this.metrics.lastReloadAt = this.#clock.now().toISOString();
          this.#emit({ all: true });
        } catch (err) {
          this.metrics.reloadFailures++;
          // Keep serving the last directory (until it is too old for members).
          this.#log.error('live directory reload failed', { error: errorMessage(err), parts: take.join(',') });
          if (this.#queued.size === 0) {
            // Retried with the next reload.
            for (const p of take) this.#queued.add(p);
            throw err;
          }
          for (const p of take) this.#queued.add(p);
        }
      }
    })().finally(() => { this.#reloading = null; });
    return this.#reloading;
  }

  /**
   * First load in the background: retried every `retryMs` until it works,
   * so a broken live snapshot (e.g. the engine deployed before its migration)
   * never blocks the engine's start. The live API answers 503 until then.
   */
  async loadInBackground(retryMs: number, isStopped: () => boolean = () => false): Promise<void> {
    while (!this.loaded && !isStopped()) {
      try {
        await this.reload();
      } catch {
        await new Promise((r) => setTimeout(r, retryMs).unref());
      }
    }
  }

  /** Debounced reload of a table's part after a database change notification. */
  #scheduleReload(table: string | null): void {
    this.metrics.notifications++;
    const part = table === null ? undefined : PART_OF_TABLE[table];
    if (part) this.#queued.add(part);
    else for (const p of LIVE_PARTS) this.#queued.add(p);
    if (this.#timer) return;
    const wait = Math.max(this.#debounceMs, this.#lastReloadStart + this.#minReloadIntervalMs - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.reload([]).catch(() => undefined);
    }, wait);
  }

  /** Whether LISTEN is set up (it is retried by the periodic reload otherwise). */
  get listening(): boolean {
    return this.#unlisten !== null;
  }

  /** Listens for change notifications (LISTEN buspilot_live); reloads everything on every (re)connect too. */
  async listen(): Promise<void> {
    this.#unlisten = await this.#store.listenLiveChanges(
      (table) => { this.#scheduleReload(table); },
      () => { this.#scheduleReload(null); },
    );
  }

  async close(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#unlisten?.().catch(() => undefined);
    this.#unlisten = null;
  }

  // --- TripObserver (from the engine) -----------------------------------

  tripUpdated(u: TripUpdate): void {
    this.#emit({ all: false, routeIds: [u.instance.pattern.routeId], tripIds: [u.instance.id] });
  }

  tripsReloaded(): void {
    this.#emit({ all: true });
  }

  vehicleUpdated(fix: VehicleFix): void {
    const prev = this.#fixes.get(fix.vehicleId);
    if (prev && prev.at >= fix.at) return;
    this.#fixes.set(fix.vehicleId, fix);
    // Only a position linked to a trip is shown to anyone.
    const tripIds = [fix.tripInstanceId, prev?.tripInstanceId].filter((x): x is string => x !== null && x !== undefined);
    if (tripIds.length === 0) return;
    const routeIds = new Set<string>();
    for (const id of tripIds) {
      const routeId = this.#trips().get(id)?.instance.pattern.routeId ?? this.#dir?.instances.get(id)?.routeId;
      if (routeId) routeIds.add(routeId);
    }
    this.#emit({ all: false, routeIds: [...routeIds], tripIds: [...new Set(tripIds)] });
  }
}
