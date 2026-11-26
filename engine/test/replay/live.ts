/**
 * Live API test helpers: a signer for Supabase-like access tokens with a
 * fake JWKS endpoint, and an in-memory LiveStore whose snapshot follows a
 * replay Scenario (operator, route, stops, trips and their state in the
 * memory store) plus access rows set by the test.
 */
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { TokenVerifier } from '../../src/live/auth.ts';
import type { LivePart, LiveSnapshot, LiveStore, Visibility } from '../../src/live/types.ts';
import { LIVE_PARTS } from '../../src/live/types.ts';
import { OPERATOR, PATTERN, ROUTE, TZ, type Scenario } from './harness.ts';

export const SUPABASE_URL = 'http://supabase.test';
export const ISSUER = `${SUPABASE_URL}/auth/v1`;

export class TokenSigner {
  readonly kid = randomUUID();
  readonly #private: KeyObject;
  readonly #public: KeyObject;
  /** How often the JWKS was fetched. */
  fetches = 0;
  /** Make the JWKS endpoint fail (outage). */
  failFetch = false;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#private = privateKey;
    this.#public = publicKey;
  }

  jwks(): unknown {
    return { keys: [{ ...this.#public.export({ format: 'jwk' }), kid: this.kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] }] };
  }

  verifier(now: () => Date = () => new Date()): TokenVerifier {
    return new TokenVerifier({
      supabaseUrl: SUPABASE_URL,
      now,
      fetcher: (url) => {
        this.fetches++;
        if (this.failFetch) return Promise.reject(new Error('unreachable'));
        if (url !== `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) return Promise.reject(new Error(`unexpected URL ${url}`));
        return Promise.resolve(this.jwks());
      },
    });
  }

  /** A signed ES256 token for `sub`, valid for an hour from `now`. */
  token(sub: string, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}, now = new Date()): string {
    const iat = Math.floor(now.getTime() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.kid, typ: 'JWT', ...header })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub, iat, exp: iat + 3600, is_anonymous: true, ...over,
    })).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${p}`), { key: this.#private, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${p}.${s}`;
  }
}

export const OPERATOR_SLUG = 'demo-op';
export const ROUTE_SLUG = 'line-a';
export const AUDIENCE = 'audience-1';
export const stopId = (sequence: number): string => `00000000-0000-4000-8000-0000000005${String(sequence).padStart(2, '0')}`;

/** Access rows and route settings a test changes; the rest follows the scenario. */
export interface LiveExtras {
  visibility: Visibility | null;
  defaultVisibility: Visibility;
  active: boolean;
  memberships: LiveSnapshot['memberships'];
  audienceRoutes: LiveSnapshot['audienceRoutes'];
  staffRoles: LiveSnapshot['staffRoles'];
  driverVehicles: LiveSnapshot['driverVehicles'];
  tripAudiences: LiveSnapshot['tripAudiences'];
  subscriptions: LiveSnapshot['subscriptions'];
  followedStops: LiveSnapshot['followedStops'];
  /** Live trips (and other instances) not in the scenario. */
  instances: LiveSnapshot['instances'];
  stops: LiveSnapshot['stops'];
}

export class MemoryLiveStore implements LiveStore {
  readonly s: Scenario;
  extras: LiveExtras;
  loads = 0;
  /** Parts asked for, per load. */
  partsLoaded: LivePart[][] = [];
  failNext = 0;
  /** Make every load fail (e.g. a missing migration). */
  failAlways = false;
  /** Make loads that include this part fail (e.g. one broken query). */
  failPart: LivePart | null = null;
  #notify: ((table: string) => void) | null = null;

  constructor(s: Scenario, extras: Partial<LiveExtras> = {}) {
    this.s = s;
    this.extras = {
      visibility: null, defaultVisibility: 'invited_eta', active: true,
      memberships: [], audienceRoutes: [{ audienceId: AUDIENCE, routeId: ROUTE, canSeeMap: false }],
      staffRoles: [], driverVehicles: [], tripAudiences: [], subscriptions: [], followedStops: [], instances: [], stops: [],
      ...extras,
    };
  }

  /** Always returns everything (a superset of the parts asked for). */
  loadLiveSnapshot(parts: readonly LivePart[] = LIVE_PARTS): Promise<LiveSnapshot> {
    this.loads++;
    this.partsLoaded.push([...parts]);
    if (this.failAlways || (this.failPart !== null && parts.includes(this.failPart))) {
      return Promise.reject(new Error('relation "public.route" has no column "slug"'));
    }
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('simulated database failure'));
    }
    const s = this.s;
    const e = this.extras;
    const rows = s.store.rows;
    // A place served twice (a loop) is one stop: the first sequence there names it.
    const idOf = (seq: number): string => {
      const at = s.def.stops.find((x) => x.sequence === seq)?.at;
      const first = s.def.stops.find((x) => at !== undefined && x.at.x === at.x && x.at.y === at.y);
      return stopId(first?.sequence ?? seq);
    };
    return Promise.resolve(structuredClone({
      loadedAt: s.clock.now(),
      operators: [{ id: OPERATOR, slug: OPERATOR_SLUG, name: { en: 'Demo operator' }, timezone: TZ, defaultVisibility: e.defaultVisibility }],
      routes: [{
        id: ROUTE, operatorId: OPERATOR, slug: ROUTE_SLUG, name: { en: 'Line A' }, shortName: 'A', color: '1E6FD9', textColor: 'FFFFFF',
        visibility: e.visibility, active: e.active,
      }],
      stops: [
        ...s.def.stops.filter((st) => idOf(st.sequence) === stopId(st.sequence)).map((st) => {
          const ll = s.plane.toLonLat(st.at);
          return { id: stopId(st.sequence), operatorId: OPERATOR, slug: `stop-${st.sequence}`, name: { en: `Stop ${st.sequence}` }, lon: ll.lon, lat: ll.lat };
        }),
        ...e.stops,
      ],
      patterns: [{ id: PATTERN, operatorId: OPERATOR, routeId: ROUTE }],
      patternStops: s.def.stops.map((st) => ({
        patternId: PATTERN, sequence: st.sequence, stopId: idOf(st.sequence), arrivalOffsetS: st.arrivalOffsetS, departureOffsetS: st.departureOffsetS,
      })),
      trips: rows.instances.map((i) => ({ id: i.tripId, patternId: PATTERN, startTimeS: i.startTimeS, headsign: { en: 'School' }, vehicleId: i.defaultVehicleId })),
      instances: [
        ...rows.instances.map((i) => ({
          id: i.id, operatorId: OPERATOR, kind: 'scheduled' as const, tripId: i.tripId, patternId: PATTERN, routeId: ROUTE,
          serviceDate: i.serviceDate, status: i.status, vehicleId: i.vehicleId, visibleUntil: null, title: null,
          startedAt: i.startedAt, endedAt: i.endedAt, offRouteSince: i.offRouteSince, stopEvents: i.stopEvents, plannedStops: [],
        })),
        ...e.instances,
      ],
      staffRoles: e.staffRoles,
      driverVehicles: e.driverVehicles,
      memberships: e.memberships,
      audienceRoutes: e.audienceRoutes,
      tripAudiences: e.tripAudiences,
      subscriptions: e.subscriptions,
      followedStops: e.followedStops,
    } satisfies LiveSnapshot));
  }

  listenLiveChanges(onChange: (table: string) => void): Promise<() => Promise<void>> {
    this.#notify = onChange;
    return Promise.resolve(() => {
      this.#notify = null;
      return Promise.resolve();
    });
  }

  /** Simulates a NOTIFY on buspilot_live with the table as payload. */
  notify(table = 'membership'): void {
    this.#notify?.(table);
  }
}
