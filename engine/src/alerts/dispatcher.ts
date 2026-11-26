/**
 * Alert dispatcher (engine.md, "Alert dispatcher").
 *
 * - Keeps the subscriptions the engine may alert in memory, by pattern and
 *   by live trip (reloaded every SUBSCRIPTION_RELOAD_SECONDS).
 * - After each processed position, evaluates the subscriptions of the trip:
 *   those of its pattern (every trip of the pattern, live trips on it
 *   included) and those of the trip instance itself (a planned stop of a
 *   live trip) (due.ts), and, for each due alert, claims it in `alert_delivery`
 *   (`INSERT … ON CONFLICT DO NOTHING`). Only the caller that inserted the
 *   row sends; the result is stored on the row. This makes every alert
 *   exactly-once across positions, retries, restarts and several engine
 *   processes. (At most once: if the engine dies between the claim and the
 *   send, that alert is lost rather than sent twice.)
 * - Failed sends are retried with backoff while the alert is still useful,
 *   then marked failed. A target FCM reports as invalid clears
 *   `device.push_token`.
 * - On each cache reload: `cancelled` alerts for trip instances staff
 *   cancelled.
 * - Live trips: nothing once `visible_until` has passed (riders no longer
 *   see the trip); `delayed` only against planned arrival times.
 *
 * Never blocks or fails position processing: all database and FCM work runs
 * in the background, errors are logged. Logs contain IDs and results, never
 * push targets or positions.
 */
import { stopSequences } from '../core/cache.ts';
import type { Clock } from '../core/engine.ts';
import { addSeconds } from '../core/time.ts';
import type { StopProgress, TripInstance, TripProgress, TripRuntime } from '../core/types.ts';
import { isFinalStopState } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { DueConfig } from './due.ts';
import { dueAlert, isMuted } from './due.ts';
import { buildPayload } from './messages.ts';
import type { AlertStore, AlertVariant, PushSender, SendResult, Subscription, TripObserver, TripUpdate } from './types.ts';
import { kindOf } from './types.ts';

export interface AlertConfig extends DueConfig {
  /** `cancelled` alerts for trips starting within this time (s). */
  cancelLookaheadS: number;
  /** Waits between send attempts (s); attempts = length + 1. */
  retryDelaysS: number[];
  /** Concurrent FCM requests. */
  maxConcurrentSends: number;
}

export const defaultAlertConfig: Omit<AlertConfig, 'staleAfterS'> = {
  passedMaxAgeS: 10 * 60,
  delayThresholdS: 10 * 60,
  cancelLookaheadS: 24 * 3600,
  retryDelaysS: [2, 10, 30],
  maxConcurrentSends: 8,
};

export interface AlertMetrics {
  subscriptions: number;
  alertsClaimed: number;
  alertsSent: number;
  alertsFailed: number;
  /** Not sent because they were no longer useful when an attempt came up (bus left, muted, unsubscribed, trip ended). */
  alertsExpired: number;
  pushTokensCleared: number;
  lastSubscriptionReloadAt: string | null;
}

interface Pending {
  variant: AlertVariant;
  sub: Subscription;
  instance: TripInstance;
  eta: Date | null;
  delayS: number | null;
  /** Not sent after this. */
  expiresAt: Date;
}

/** Runs at most `n` tasks at a time, in FIFO order. */
export class Limiter {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  readonly #n: number;
  constructor(n: number) {
    this.#n = Math.max(1, n);
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot to the next waiter directly, so no
    // task starting in between can take it.
    if (this.#active >= this.#n) await new Promise<void>((resolve) => this.#queue.push(resolve));
    else this.#active++;
    try {
      return await task();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }
}

export class AlertDispatcher implements TripObserver {
  readonly #store: AlertStore;
  readonly #sender: PushSender;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #cfg: AlertConfig;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: Limiter;
  #byPattern = new Map<string, Subscription[]>();
  #byTrip = new Map<string, Subscription[]>();
  /** Keys claimed (or being claimed) by this process, per trip instance: `subscription:stop:kind`. */
  readonly #claimed = new Map<string, Set<string>>();
  /** Latest state per trip instance, to drop retries of alerts that are no longer useful. */
  readonly #latest = new Map<string, { status: TripProgress['status']; stops: readonly StopProgress[] }>();
  /** Push targets FCM rejected, by device, until the next subscription reload. */
  readonly #invalidTargets = new Map<string, string>();
  readonly #inflight = new Set<Promise<void>>();
  readonly metrics: AlertMetrics = {
    subscriptions: 0,
    alertsClaimed: 0,
    alertsSent: 0,
    alertsFailed: 0,
    alertsExpired: 0,
    pushTokensCleared: 0,
    lastSubscriptionReloadAt: null,
  };

  constructor(opts: {
    store: AlertStore;
    sender: PushSender;
    clock: Clock;
    log: Logger;
    config: AlertConfig;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.#store = opts.store;
    this.#sender = opts.sender;
    this.#clock = opts.clock;
    this.#log = opts.log;
    this.#cfg = opts.config;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#limiter = new Limiter(opts.config.maxConcurrentSends);
  }

  async reloadSubscriptions(): Promise<void> {
    const subs = await this.#store.loadSubscriptions();
    const byPattern = new Map<string, Subscription[]>();
    const byTrip = new Map<string, Subscription[]>();
    for (const s of subs) {
      const [map, key] = s.patternId !== null ? [byPattern, s.patternId] : [byTrip, s.tripInstanceId];
      if (key === null) continue;
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    this.#byPattern = byPattern;
    this.#byTrip = byTrip;
    this.#invalidTargets.clear();
    this.metrics.subscriptions = subs.length;
    this.metrics.lastSubscriptionReloadAt = this.#clock.now().toISOString();
  }

  /** Resolves once all claims and sends started so far are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  tripUpdated(u: TripUpdate): void {
    try {
      this.#latest.set(u.instance.id, { status: u.progress.status, stops: u.progress.stops });
      const subs = this.#subsOf(u.instance);
      const now = this.#clock.now();
      if (subs.length === 0 || hidden(u.instance, now)) return;
      const sequences = stopSequences(u.instance);
      for (const sub of subs) {
        if (!sequences.includes(sub.stopSequence)) continue;
        const due = dueAlert({
          sub,
          sequences,
          tripStatus: u.progress.status,
          stops: u.progress.stops,
          etas: u.etas,
          scheduledArrival: scheduledArrival(u.instance, sub.stopSequence),
          offRoute: u.progress.offRouteSince !== null,
          fixAt: u.fixAt,
          now,
          approachingClaimed: this.#isClaimed(u.instance.id, sub, 'approaching'),
        }, this.#cfg);
        if (due === null) continue;
        const passedAt = u.progress.stops.find((s) => s.sequence === sub.stopSequence)?.passedAt ?? now;
        const expiresAt = due.variant === 'passed'
          ? addSeconds(passedAt, this.#cfg.passedMaxAgeS)
          // Approaching, arrived, delayed: useful until the bus leaves the stop (checked before each attempt), at most 30 min.
          : addSeconds(now, 30 * 60);
        this.#dispatch({ variant: due.variant, sub, instance: u.instance, eta: due.eta, delayS: due.delayS, expiresAt });
      }
    } catch (err) {
      this.#log.error('alert evaluation failed', { tripInstanceId: u.instance.id, error: errorMessage(err) });
    }
  }

  /** After a cache reload: forget trips that left the cache, send `cancelled` alerts. */
  tripsReloaded(trips: Iterable<TripRuntime>): void {
    try {
      const seen = new Set<string>();
      const now = this.#clock.now();
      for (const tr of trips) {
        seen.add(tr.instance.id);
        // Trips completed by the tick or taken over from the database: retries see it.
        if (this.#latest.has(tr.instance.id)) this.#latest.set(tr.instance.id, { status: tr.progress.status, stops: tr.progress.stops });
        if (tr.progress.status === 'cancelled') this.#cancelled(tr.instance, tr.progress, now);
      }
      for (const id of [...this.#claimed.keys()]) if (!seen.has(id)) this.#claimed.delete(id);
      for (const id of [...this.#latest.keys()]) if (!seen.has(id)) this.#latest.delete(id);
    } catch (err) {
      this.#log.error('alert evaluation failed', { error: errorMessage(err) });
    }
  }

  #subsOf(instance: TripInstance): Subscription[] {
    const ofPattern = instance.pattern === null ? undefined : this.#byPattern.get(instance.pattern.id);
    const ofTrip = this.#byTrip.get(instance.id);
    return [...(ofPattern ?? []), ...(ofTrip ?? [])];
  }

  #cancelled(instance: TripInstance, progress: TripProgress, now: Date): void {
    if ((instance.startAt.getTime() - now.getTime()) / 1000 > this.#cfg.cancelLookaheadS || hidden(instance, now)) return;
    this.#latest.set(instance.id, { status: progress.status, stops: progress.stops });
    const sequences = stopSequences(instance);
    for (const sub of this.#subsOf(instance)) {
      const state = progress.stops.find((s) => s.sequence === sub.stopSequence)?.state;
      if (!sequences.includes(sub.stopSequence) || state === undefined || isFinalStopState(state) || isMuted(sub, now)) continue;
      // A trip that ran: every stop not yet served (it may run late). A trip
      // that never started: not once the bus would have been there already
      // (a live trip without planned times: until the end of its service day).
      const scheduled = scheduledArrival(instance, sub.stopSequence) ?? instance.endAt;
      const started = progress.startedAt !== null;
      if (!started && scheduled <= now) continue;
      let expiresAt = started && scheduled < addSeconds(now, 30 * 60) ? addSeconds(now, 30 * 60) : scheduled;
      if (instance.visibleUntil !== null && instance.visibleUntil < expiresAt) expiresAt = instance.visibleUntil;
      this.#dispatch({ variant: 'cancelled', sub, instance, eta: null, delayS: null, expiresAt });
    }
  }

  #key(sub: Subscription, kind: string): string {
    return `${sub.id}:${sub.stopSequence}:${kind}`;
  }

  #isClaimed(tripInstanceId: string, sub: Subscription, kind: string): boolean {
    return this.#claimed.get(tripInstanceId)?.has(this.#key(sub, kind)) ?? false;
  }

  #dispatch(p: Pending): void {
    const kind = kindOf(p.variant);
    const tripId = p.instance.id;
    const key = this.#key(p.sub, kind);
    let set = this.#claimed.get(tripId);
    if (!set) {
      set = new Set();
      this.#claimed.set(tripId, set);
    }
    if (set.has(key)) return;
    set.add(key);
    const work = (async () => {
      let id: string | null;
      try {
        id = await this.#store.claimDelivery({
          operatorId: p.sub.operatorId, subscriptionId: p.sub.id, tripInstanceId: tripId, stopSequence: p.sub.stopSequence, kind,
        });
      } catch (err) {
        // Not claimed: the next position tries again.
        set.delete(key);
        this.#log.warn('alert claim failed', { tripInstanceId: tripId, subscriptionId: p.sub.id, kind, error: errorMessage(err) });
        return;
      }
      if (id === null) return; // Sent before (another process, or before a restart).
      this.metrics.alertsClaimed++;
      await this.#deliver(id, p);
    })();
    this.#track(work);
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => {
      this.#log.error('alert delivery failed', { error: errorMessage(err) });
    }).finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  /**
   * Checked right before each attempt (also after waiting for a send slot or
   * a retry): the alert is still useful. Not expired; the subscription still
   * exists, may still be alerted and is not muted (it is taken fresh from the
   * last reload, with its current push target); for approaching, arrived and
   * delayed, the trip is still active and the bus has not left the stop. An
   * approaching alert whose bus has arrived meanwhile becomes "the bus is at
   * your stop" (same key).
   */
  #check(p: Pending, now: Date): Pending | null {
    if (now > p.expiresAt) return null;
    const list = p.sub.patternId !== null ? this.#byPattern.get(p.sub.patternId) : this.#byTrip.get(p.sub.tripInstanceId ?? '');
    const sub = list?.find((s) => s.id === p.sub.id && s.stopSequence === p.sub.stopSequence);
    if (sub === undefined || isMuted(sub, now) || (p.variant === 'passed' && !sub.notifyPassed)) return null;
    if (hidden(p.instance, now)) return null;
    if (p.variant === 'passed' || p.variant === 'cancelled') return { ...p, sub };
    const trip = this.#latest.get(p.instance.id);
    if (trip?.status !== 'active') return null;
    const state = trip.stops.find((s) => s.sequence === sub.stopSequence)?.state;
    if (state === 'upcoming' || state === 'approaching') return p.variant === 'arrived' ? null : { ...p, sub };
    if (state !== 'arrived') return null;
    if (p.variant === 'approaching') return { ...p, sub, variant: 'arrived', eta: null };
    return p.variant === 'arrived' ? { ...p, sub } : null;
  }

  async #deliver(id: string, first: Pending): Promise<void> {
    const delays = this.#cfg.retryDelaysS;
    let p = first;
    const fields = { alertId: id, tripInstanceId: p.instance.id, kind: p.variant };
    for (let attempt = 0; ; attempt++) {
      const res = await this.#limiter.run(async (): Promise<SendResult | 'expired' | 'invalid_token'> => {
        const now = this.#clock.now();
        const current = this.#check(p, now);
        if (current === null) return 'expired';
        p = current;
        if (this.#invalidTargets.get(p.sub.deviceId) === p.sub.pushToken) return 'invalid_token';
        const payload = buildPayload({
          variant: p.variant, sub: p.sub, tripInstanceId: p.instance.id, serviceDate: p.instance.serviceDate,
          tripKind: p.instance.kind, tripTitle: p.instance.title, tripStart: p.instance.startAt, eta: p.eta, delayS: p.delayS, deliveryId: id, now,
          ttlS: (p.expiresAt.getTime() - now.getTime()) / 1000,
        });
        return this.#sender.send({ target: p.sub.pushToken, payload });
      });
      if (res === 'expired') {
        this.metrics.alertsExpired++;
        await this.#finish(id, null, 'expired');
        this.#log.info('alert no longer useful, not sent', { ...fields, attempts: attempt });
        return;
      }
      if (res === 'invalid_token') {
        await this.#finish(id, null, 'invalid_token');
        return;
      }
      if (res.ok) {
        this.metrics.alertsSent++;
        await this.#finish(id, this.#clock.now(), 'sent');
        this.#log.info('alert sent', { ...fields, kind: p.variant });
        return;
      }
      if (res.invalidTarget) {
        const target = p.sub.pushToken;
        this.metrics.alertsFailed++;
        this.#invalidTargets.set(p.sub.deviceId, target);
        await this.#finish(id, null, 'invalid_token');
        try {
          await this.#store.clearPushToken(p.sub.deviceId, target);
          this.metrics.pushTokensCleared++;
        } catch (err) {
          this.#log.warn('clearing an invalid push token failed', { ...fields, error: errorMessage(err) });
        }
        this.#log.info('alert not sent: push target invalid, cleared', { ...fields, code: res.code });
        return;
      }
      const wait = delays[attempt];
      if (!res.retryable || wait === undefined) {
        this.metrics.alertsFailed++;
        await this.#finish(id, null, `failed: ${res.code}`);
        // Not retryable: usually configuration (wrong project, key without permission) or a malformed message.
        const level = res.retryable ? 'warn' : 'error';
        this.#log[level]('alert send failed', { ...fields, code: res.code, attempts: attempt + 1 });
        return;
      }
      await this.#sleep(Math.max(wait, res.retryAfterS ?? 0) * 1000);
    }
  }

  async #finish(id: string, sentAt: Date | null, result: string): Promise<void> {
    try {
      await this.#store.finishDelivery(id, sentAt, result);
    } catch (err) {
      this.#log.warn('storing an alert result failed', { alertId: id, result, error: errorMessage(err) });
    }
  }
}

/** A live trip past visible_until: riders no longer see it, so no alerts. */
function hidden(instance: TripInstance, now: Date): boolean {
  return instance.visibleUntil !== null && instance.visibleUntil <= now;
}

/**
 * When the bus should be at a stop by the plan: scheduled trips from the
 * schedule, live trips from the planned arrival (falling back to the
 * planned departure). A live trip on a pattern has no plan: null.
 */
export function scheduledArrival(instance: TripInstance, sequence: number): Date | null {
  if (instance.kind === 'scheduled') {
    const ps = instance.pattern?.stops.find((p) => p.sequence === sequence);
    return ps === undefined ? null : addSeconds(instance.startAt, ps.arrivalOffsetS);
  }
  const planned = instance.itinerary?.stops.find((p) => p.sequence === sequence);
  return planned?.plannedArrival ?? planned?.plannedDeparture ?? null;
}
