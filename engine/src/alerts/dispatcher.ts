/**
 * Alert dispatcher (engine.md, "Alert dispatcher").
 *
 * - Keeps the subscriptions the engine may alert in memory, by pattern
 *   (reloaded every SUBSCRIPTION_RELOAD_SECONDS).
 * - After each processed position, evaluates the subscriptions of the trip's
 *   pattern (due.ts) and, for each due alert, claims it in `alert_delivery`
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
 *
 * Never blocks or fails position processing: all database and FCM work runs
 * in the background, errors are logged. Logs contain IDs and results, never
 * push targets or positions.
 */
import type { Clock } from '../core/engine.ts';
import { addSeconds } from '../core/time.ts';
import type { StopProgress, TripInstance, TripProgress, TripRuntime } from '../core/types.ts';
import { isFinalStopState } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { DueConfig } from './due.ts';
import { dueAlert, isMuted } from './due.ts';
import { buildPayload } from './messages.ts';
import type { AlertStore, AlertVariant, PushSender, Subscription, TripObserver, TripUpdate } from './types.ts';
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
  /** Not sent because they were no longer useful when a retry came up. */
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

/** Runs at most `n` tasks at a time. */
class Limiter {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  readonly #n: number;
  constructor(n: number) {
    this.#n = Math.max(1, n);
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#n) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
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
  /** Keys claimed (or being claimed) by this process, per trip instance: `subscription:stop:kind`. */
  readonly #claimed = new Map<string, Set<string>>();
  /** Latest stop states per trip instance, to drop retries of alerts that are no longer useful. */
  readonly #latest = new Map<string, readonly StopProgress[]>();
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
    for (const s of subs) {
      const list = byPattern.get(s.patternId) ?? [];
      list.push(s);
      byPattern.set(s.patternId, list);
    }
    this.#byPattern = byPattern;
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
      this.#latest.set(u.instance.id, u.progress.stops);
      const subs = this.#byPattern.get(u.instance.pattern.id);
      if (!subs) return;
      const now = this.#clock.now();
      for (const sub of subs) {
        const ps = u.instance.pattern.stops.find((p) => p.sequence === sub.stopSequence);
        if (ps === undefined) continue;
        const due = dueAlert({
          sub,
          pattern: u.instance.pattern,
          tripStatus: u.progress.status,
          stops: u.progress.stops,
          etas: u.etas,
          scheduledArrival: addSeconds(u.instance.startAt, ps.arrivalOffsetS),
          offRoute: u.progress.offRouteSince !== null,
          fixAt: u.fixAt,
          now,
          approachingClaimed: this.#isClaimed(u.instance.id, sub, 'approaching'),
        }, this.#cfg);
        if (due === null) continue;
        const expiresAt = due.variant === 'passed'
          ? addSeconds(now, this.#cfg.passedMaxAgeS)
          // Approaching, arrived, delayed: useful until the bus leaves the stop (checked on retry), at most 30 min.
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
        if (tr.progress.status === 'cancelled') this.#cancelled(tr.instance, tr.progress, now);
      }
      for (const id of [...this.#claimed.keys()]) if (!seen.has(id)) this.#claimed.delete(id);
      for (const id of [...this.#latest.keys()]) if (!seen.has(id)) this.#latest.delete(id);
    } catch (err) {
      this.#log.error('alert evaluation failed', { error: errorMessage(err) });
    }
  }

  #cancelled(instance: TripInstance, progress: TripProgress, now: Date): void {
    if ((instance.startAt.getTime() - now.getTime()) / 1000 > this.#cfg.cancelLookaheadS) return;
    this.#latest.set(instance.id, progress.stops);
    for (const sub of this.#byPattern.get(instance.pattern.id) ?? []) {
      const ps = instance.pattern.stops.find((p) => p.sequence === sub.stopSequence);
      const state = progress.stops.find((s) => s.sequence === sub.stopSequence)?.state;
      if (ps === undefined || state === undefined || isFinalStopState(state) || isMuted(sub, now)) continue;
      // Not once the bus would have been there already.
      const scheduled = addSeconds(instance.startAt, ps.arrivalOffsetS);
      if (scheduled <= now) continue;
      this.#dispatch({ variant: 'cancelled', sub, instance, eta: null, delayS: null, expiresAt: scheduled });
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
   * Whether a retry is still useful: not expired, and the bus has not left
   * the stop (approaching, arrived, delayed). An approaching alert whose bus
   * has arrived meanwhile becomes "the bus is at your stop" (same key).
   */
  #check(p: Pending, now: Date): Pending | null {
    if (now > p.expiresAt) return null;
    if (p.variant === 'passed' || p.variant === 'cancelled') return p;
    const state = this.#latest.get(p.instance.id)?.find((s) => s.sequence === p.sub.stopSequence)?.state;
    if (state === undefined || state === 'upcoming' || state === 'approaching') return p;
    if (state !== 'arrived') return null;
    if (p.variant === 'approaching') return { ...p, variant: 'arrived', eta: null };
    return p.variant === 'arrived' ? p : null;
  }

  async #deliver(id: string, first: Pending): Promise<void> {
    const delays = this.#cfg.retryDelaysS;
    let p = first;
    const fields = { alertId: id, tripInstanceId: p.instance.id, kind: p.variant };
    for (let attempt = 0; ; attempt++) {
      const now = this.#clock.now();
      const current = attempt === 0 ? p : this.#check(p, now);
      if (current !== null) p = current;
      if (current === null) {
        this.metrics.alertsExpired++;
        await this.#finish(id, null, 'expired');
        this.#log.info('alert expired before it could be sent', fields);
        return;
      }
      const target = p.sub.pushToken;
      if (this.#invalidTargets.get(p.sub.deviceId) === target) {
        await this.#finish(id, null, 'invalid_token');
        return;
      }
      const payload = buildPayload({
        variant: p.variant, sub: p.sub, tripInstanceId: p.instance.id, serviceDate: p.instance.serviceDate,
        tripStart: p.instance.startAt, eta: p.eta, delayS: p.delayS, deliveryId: id, now,
        ttlS: (p.expiresAt.getTime() - now.getTime()) / 1000,
      });
      const res = await this.#limiter.run(() => this.#sender.send({ target, payload }));
      if (res.ok) {
        this.metrics.alertsSent++;
        await this.#finish(id, this.#clock.now(), 'sent');
        this.#log.info('alert sent', fields);
        return;
      }
      if (res.invalidTarget) {
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
        this.#log.warn('alert send failed', { ...fields, code: res.code, attempts: attempt + 1 });
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
