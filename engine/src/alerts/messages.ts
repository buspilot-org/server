/**
 * Push message format (FCM HTTP v1). Documented in engine/README.md,
 * "Push message format".
 *
 * - `data`: IDs, the kind and the ETA, all strings, so the app can open the
 *   route at the stop and build its own text. No positions, ever.
 * - `notification`: a ready text in the device's language (ja, en, de;
 *   others get English, no language Japanese), so Android shows it while the
 *   app is in the background without any app code.
 */
import type { TripKind } from '../core/types.ts';
import type { AlertVariant, I18nText, PushPayload, Subscription } from './types.ts';

export type Lang = 'ja' | 'en' | 'de';

export function languageOf(tag: string | null): Lang {
  if (tag === null || tag === '') return 'ja';
  const base = tag.toLowerCase().split('-')[0];
  return base === 'ja' || base === 'de' ? base : 'en';
}

/** Text in `lang`, else English, Japanese, or any. */
export function pick(text: I18nText, lang: Lang): string {
  return text[lang] ?? text.en ?? text.ja ?? Object.values(text)[0] ?? '';
}

export interface MessageInput {
  variant: AlertVariant;
  sub: Subscription;
  tripInstanceId: string;
  serviceDate: string;
  tripKind: TripKind;
  /** Live trips: `trip_instance.title`, the notification title. */
  tripTitle: I18nText | null;
  /** Scheduled start of the trip (for `cancelled`); live trips: the first planned time, or when it may start. */
  tripStart: Date;
  eta: Date | null;
  delayS: number | null;
  /** alert_delivery.id */
  deliveryId: string;
  now: Date;
  /** How long the notification is useful (s): FCM and APNs drop it afterwards. */
  ttlS: number;
}

function clock(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

function dayMonth(d: Date, timezone: string): { day: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'numeric' }).formatToParts(d);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { day: get('day'), month: get('month') };
}

function minutesUntil(eta: Date, now: Date): number {
  return Math.max(1, Math.round((eta.getTime() - now.getTime()) / 60_000));
}

/** Title and body in the device's language. */
export function notificationText(m: MessageInput): { title: string; body: string } {
  const lang = languageOf(m.sub.language);
  const stop = pick(m.sub.stopName, lang);
  const routeName = m.sub.routeName === null ? '' : pick(m.sub.routeName, lang);
  const routeTitle = m.sub.routeShortName ? `${m.sub.routeShortName} ${routeName}` : routeName;
  // A live trip is known by its title (an away game, a tour), not its route.
  const title = m.tripKind === 'live' && m.tripTitle !== null ? pick(m.tripTitle, lang) || routeTitle : routeTitle;
  const tz = m.sub.timezone;
  const min = m.eta ? minutesUntil(m.eta, m.now) : null;
  const delayMin = m.delayS === null ? null : Math.round(m.delayS / 60);
  const at = m.eta ? clock(m.eta, tz) : null;
  const start = clock(m.tripStart, tz);
  const { day, month } = dayMonth(m.tripStart, tz);

  let body: string;
  switch (m.variant) {
    case 'approaching':
      body = min === null
        ? { ja: `バスが${stop}に近づいています。`, en: `The bus is approaching ${stop}.`, de: `Der Bus nähert sich ${stop}.` }[lang]
        : { ja: `バスはあと約${min}分で${stop}に到着します。`, en: `The bus arrives at ${stop} in about ${min} min.`, de: `Der Bus erreicht ${stop} in etwa ${min} Min.` }[lang];
      break;
    case 'arrived':
      body = { ja: `バスが${stop}に到着しました。`, en: `The bus is at ${stop}.`, de: `Der Bus ist an der Haltestelle ${stop}.` }[lang];
      break;
    case 'passed':
      body = { ja: `バスは${stop}に停車せずに通過しました。`, en: `The bus passed ${stop} without stopping.`, de: `Der Bus ist ohne Halt an ${stop} vorbeigefahren.` }[lang];
      break;
    case 'delayed':
      body = {
        ja: `バスは約${delayMin ?? 0}分遅れています。${stop}には${at ?? ''}ごろ到着予定です。`,
        en: `The bus is running about ${delayMin ?? 0} min late. Expected at ${stop} around ${at ?? ''}.`,
        de: `Der Bus hat etwa ${delayMin ?? 0} Min. Verspätung. Ankunft an ${stop} gegen ${at ?? ''}.`,
      }[lang];
      break;
    case 'cancelled':
      body = m.tripKind === 'live' ? {
        ja: 'この運行は中止になりました。',
        en: 'This trip is cancelled.',
        de: 'Diese Fahrt fällt aus.',
      }[lang] : {
        ja: `${month}月${day}日 ${start}発の便は運休です。`,
        en: `The ${start} trip on ${day}/${month} is cancelled.`,
        de: `Die Fahrt um ${start} am ${day}.${month}. fällt aus.`,
      }[lang];
      break;
  }
  return { title, body };
}

/** Android notification channel; the rider app creates these (see README). */
export function channelOf(variant: AlertVariant): string {
  return variant === 'cancelled' || variant === 'delayed' ? 'trip_changes' : 'arrival_alerts';
}

export function buildPayload(m: MessageInput): PushPayload {
  const ttlS = Math.max(60, Math.round(m.ttlS));
  // One notification per trip and stop on the phone: "the bus is at your
  // stop" replaces "arrives in 5 min".
  const tag = `${m.tripInstanceId}:${m.sub.stopSequence}`;
  return {
    data: {
      v: '1',
      type: 'stop_alert',
      kind: m.variant,
      alert_id: m.deliveryId,
      operator_id: m.sub.operatorId,
      route_id: m.sub.routeId ?? '',
      pattern_id: m.sub.patternId ?? '',
      stop_id: m.sub.stopId,
      stop_sequence: String(m.sub.stopSequence),
      subscription_id: m.sub.id,
      trip_instance_id: m.tripInstanceId,
      trip_kind: m.tripKind,
      service_date: m.serviceDate,
      trip_start: m.tripStart.toISOString(),
      eta: m.eta?.toISOString() ?? '',
      delay_s: m.delayS === null ? '' : String(Math.round(m.delayS)),
    },
    notification: notificationText(m),
    android: {
      priority: 'HIGH',
      ttl: `${ttlS}s`,
      notification: { channel_id: channelOf(m.variant), tag, sound: 'default' },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(m.now.getTime() / 1000) + ttlS),
        'apns-collapse-id': tag,
      },
      payload: { aps: { 'thread-id': m.tripInstanceId, sound: 'default' } },
    },
  };
}
