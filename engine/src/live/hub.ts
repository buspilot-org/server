/**
 * The live API's in-memory state (engine.md, "Live API"): the directory
 * (names, schedule, trips, access) reloaded from the database on change and
 * every `reloadS`, plus the engine's trip state and the latest fix of each
 * vehicle, which arrive as the engine processes positions. Requests are
 * answered from here, without database reads.
 *
 * Listeners (SSE streams) are told which routes and trips changed.
 */
import type { TripObserver, TripUpdate } from '../alerts/types.ts';
import type { Clock } from '../core/engine.ts';
import type { TripRuntime } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import { Directory } from './directory.ts';
import type { LiveStore, VehicleFix } from './types.ts';
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
}

export class LiveHub implements TripObserver {
  readonly #store: LiveStore;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #trips: () => ReadonlyMap<string, TripRuntime>;
  readonly #staleAfterS: number;
  readonly #debounceMs: number;
  #dir: Directory | null = null;
  readonly #fixes = new Map<string, VehicleFix>();
  readonly #listeners = new Set<ChangeListener>();
  #reloading: Promise<void> | null = null;
  #again = false;
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
  }

  get loaded(): boolean {
    return this.#dir !== null;
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

  /** Loads the directory now; concurrent calls share a load, and a call during a load causes one more. */
  async reload(): Promise<void> {
    if (this.#reloading) {
      this.#again = true;
      return this.#reloading;
    }
    this.#reloading = (async () => {
      for (;;) {
        this.#again = false;
        try {
          const snapshot = await this.#store.loadLiveSnapshot();
          this.#dir = new Directory(snapshot);
          this.metrics.reloads++;
          this.metrics.lastReloadAt = this.#clock.now().toISOString();
          this.#emit({ all: true });
        } catch (err) {
          this.metrics.reloadFailures++;
          // Keep serving the last directory (Supabase outage).
          this.#log.error('live directory reload failed', { error: errorMessage(err) });
          if (!this.#requestedAgain()) throw err;
        }
        if (!this.#requestedAgain()) return;
      }
    })().finally(() => { this.#reloading = null; });
    return this.#reloading;
  }

  /** A reload was asked for while one was running (set from other calls during the await). */
  #requestedAgain(): boolean {
    return this.#again;
  }

  /** Debounced reload after a database change notification. */
  #scheduleReload(): void {
    this.metrics.notifications++;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.reload().catch(() => undefined);
    }, this.#debounceMs);
  }

  /** Listens for change notifications (LISTEN buspilot_live); reloads on every (re)connect too. */
  async listen(): Promise<void> {
    this.#unlisten = await this.#store.listenLiveChanges(
      () => { this.#scheduleReload(); },
      () => { this.#scheduleReload(); },
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
