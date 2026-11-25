/**
 * Types of the alert dispatcher (engine.md, "Alert dispatcher";
 * arrival-alerts.md, "Decisions (2026-11-26)").
 */
import type { TripInstance, TripProgress, TripRuntime } from '../core/types.ts';

/** `alert_kind` in the database: part of the exactly-once key. */
export type AlertKind = 'approaching' | 'passed' | 'delayed' | 'cancelled';

/**
 * What the rider is told. `arrived` ("the bus is at your stop") replaces a
 * missed approaching alert and is stored with kind `approaching`, so the
 * unique key allows only one of the two per subscription, trip and stop.
 */
export type AlertVariant = 'approaching' | 'arrived' | 'passed' | 'delayed' | 'cancelled';

export function kindOf(variant: AlertVariant): AlertKind {
  return variant === 'arrived' ? 'approaching' : variant;
}

/** Translatable text as stored in the database: language tag → string. */
export type I18nText = Record<string, string>;

/**
 * A subscription the engine may alert: the device has a push target and may
 * see the route (active route; public, or a membership whose audience
 * includes it). Loaded with the names needed for the notification text.
 */
export interface Subscription {
  id: string;
  operatorId: string;
  deviceId: string;
  patternId: string;
  stopSequence: number;
  trigger: 'minutes' | 'stops';
  triggerValue: number;
  notifyPassed: boolean;
  mutedUntil: Date | null;
  createdAt: Date;
  /** Firebase Installation ID (or registration token) registered by the rider app. Never logged. */
  pushToken: string;
  /** BCP 47 tag from `device.language`, or null. */
  language: string | null;
  timezone: string;
  routeId: string;
  routeName: I18nText;
  routeShortName: string | null;
  stopId: string;
  stopName: I18nText;
}

/** One trip's state after a position was processed and written. */
export interface TripUpdate {
  instance: TripInstance;
  progress: TripProgress;
  /** ETAs computed for this position (stops still ahead); empty while off route. */
  etas: ReadonlyMap<number, Date>;
  /** Fix time of the position. */
  fixAt: Date;
}

/** Receives trip changes from the engine. Must not throw or block. */
export interface TripObserver {
  tripUpdated(u: TripUpdate): void;
  tripsReloaded(trips: Iterable<TripRuntime>): void;
}

export interface DeliveryClaim {
  operatorId: string;
  subscriptionId: string;
  tripInstanceId: string;
  stopSequence: number;
  kind: AlertKind;
}

/** Persistence for alerts. Implemented by PgStore; tests use an in-memory store. */
export interface AlertStore {
  loadSubscriptions(): Promise<Subscription[]>;
  /**
   * `INSERT … ON CONFLICT DO NOTHING` into alert_delivery. Returns the new
   * row's ID, or null if the key exists already (or the subscription or trip
   * instance is gone). Only a caller that got an ID may send.
   */
  claimDelivery(c: DeliveryClaim): Promise<string | null>;
  /** Stores the outcome of a claimed delivery. */
  finishDelivery(id: string, sentAt: Date | null, result: string): Promise<void>;
  /** Clears `device.push_token` if it still is `token` (FCM said it is invalid). */
  clearPushToken(deviceId: string, token: string): Promise<void>;
}

/** The FCM message without its target (`message` in FCM HTTP v1, minus fid/token). */
export interface PushPayload {
  data: Record<string, string>;
  notification: { title: string; body: string };
  android: {
    priority: 'HIGH' | 'NORMAL';
    ttl: string;
    notification: { channel_id: string; tag: string; sound: string };
  };
  apns: {
    headers: Record<string, string>;
    payload: { aps: { 'thread-id': string; sound: string } };
  };
}

export interface PushMessage {
  /** Push target. Never logged. */
  target: string;
  payload: PushPayload;
}

export type SendResult =
  | { ok: true }
  | {
    ok: false;
    /** FCM error code (e.g. UNREGISTERED, UNAVAILABLE) or NETWORK / AUTH. */
    code: string;
    retryable: boolean;
    /** The target is not (or no longer) valid: clear the device's push token. */
    invalidTarget: boolean;
    retryAfterS?: number;
  };

export interface PushSender {
  send(msg: PushMessage): Promise<SendResult>;
}
