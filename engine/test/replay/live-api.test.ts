/**
 * Live API over HTTP, fed by replayed positions: polling endpoints, public
 * endpoints, Server-Sent Events, and the vehicle_state throttle.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../../src/http/app.ts';
import { LiveHub } from '../../src/live/hub.ts';
import { defaultStreamLimits, StreamRegistry, type StreamLimits } from '../../src/live/streams.ts';
import type { LiveInstanceRow } from '../../src/live/types.ts';
import type { RouteView, StopView, TripOnlyView, TripView } from '../../src/live/views.ts';
import { silentLogger } from '../../src/log.ts';
import { OPERATOR, ROUTE, Scenario, Track, VEHICLE } from './harness.ts';
import { AUDIENCE, MemoryLiveStore, OPERATOR_SLUG, ROUTE_SLUG, stopId, TokenSigner, type LiveExtras } from './live.ts';
import { STOP_M, germanSchool, loopRoute, normalRun } from './routes.ts';

const DATE = '2026-11-27';
const TRIP = '00000000-0000-4000-8000-0000000007a1';
const MEMBER = '0f000000-0000-4000-8000-00000000000a';
const OTHER = '0f000000-0000-4000-8000-00000000000b';
const TOURIST = '0f000000-0000-4000-8000-00000000000c';
const LIVE_TRIP = '00000000-0000-4000-8000-0000000007b1';
const TOUR_STOP = '00000000-0000-4000-8000-0000000005f1';

interface Setup {
  s: Scenario;
  live: MemoryLiveStore;
  hub: LiveHub;
  signer: TokenSigner;
  streams: StreamRegistry;
  app: ReturnType<typeof createApp>;
  get(path: string, uid?: string | null, headers?: Record<string, string>): Promise<Response>;
}

async function setup(opts: { extras?: Partial<LiveExtras>; limits?: Partial<StreamLimits>; route?: 'loop' } = {}): Promise<Setup> {
  const trips = [{ id: TRIP, serviceDate: DATE, start: '07:30' }];
  const s = await Scenario.create(opts.route === 'loop' ? loopRoute(trips) : germanSchool(trips));
  const live = new MemoryLiveStore(s, { memberships: [{ deviceId: MEMBER, audienceId: AUDIENCE }], ...opts.extras });
  const hub = new LiveHub({ store: live, clock: s.clock, log: silentLogger, trips: () => s.engine.trips, staleAfterS: s.thresholds.staleAfterS, debounceMs: 0 });
  s.observers.push(hub);
  await s.restart();
  await hub.reload();
  await hub.listen();
  const signer = new TokenSigner();
  const streams = new StreamRegistry({ ...defaultStreamLimits, minIntervalMs: 0, ...opts.limits });
  const app = createApp({ engine: s.engine, traccarSecret: 'a'.repeat(40), log: silentLogger, live: { hub, verifier: signer.verifier(), streams, log: silentLogger } });
  const get = (path: string, uid: string | null = MEMBER, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(app.request(path, { headers: { ...(uid ? { Authorization: `Bearer ${signer.token(uid)}` } : {}), ...headers } }));
  return { s, live, hub, signer, streams, app, get };
}

/** Reload after a database change, as the LISTEN notification does. */
async function changed(t: Setup): Promise<void> {
  t.live.notify();
  await new Promise((r) => setTimeout(r, 5));
  await t.hub.reload();
}

/** The bus drives the first part of the trip: departed stops 1 and 2, on the way to stop 3. */
function firstHalf(s: Scenario): Track {
  const t = new Track(s.shape, new Date(s.tripStart(TRIP).getTime() - 60_000));
  t.dwell(120).drive(STOP_M[2] - 5, 30).dwell(30).drive(1200, 30);
  return t;
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function firstTrip(body: RouteView): TripView {
  const t = body.trips[0];
  assert.ok(t, 'a trip');
  return t;
}

describe('live API: members polling a route', () => {
  it('arrival-time member: trip status, stop states and ETAs, no position, no stop locations', async () => {
    const t = await setup();
    await t.s.feed(firstHalf(t.s).fixes);
    const res = await t.get(`/v1/live/routes/${ROUTE}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=5');
    assert.match(res.headers.get('vary') ?? '', /Authorization/);
    const body = await json<RouteView>(res);
    assert.equal(body.v, 1);
    assert.equal(body.access, 'eta');
    assert.equal(body.operator.slug, OPERATOR_SLUG);
    assert.equal(body.trips.length, 1);
    const trip = body.trips[0];
    assert.ok(trip);
    assert.equal(trip.status, 'active');
    assert.equal(trip.tracked, true);
    assert.equal(trip.vehicle, null, 'no position at arrival-time level');
    assert.deepEqual(trip.stops.map((x) => x.state), ['departed', 'departed', 'upcoming', 'upcoming', 'upcoming']);
    assert.ok(trip.stops[2]?.eta, 'ETA for the next stop');
    assert.equal(trip.stops[0]?.eta, null, 'no ETA for a departed stop');
    assert.ok(trip.stops.every((x) => x.stop.location === null), 'no stop locations');
    assert.equal(typeof trip.delayS, 'number');
    // No coordinates anywhere in the response.
    assert.doesNotMatch(JSON.stringify(body), /"lon"|"lat"/);
  });

  it('answers 304 to a matching If-None-Match (cheap polling)', async () => {
    const t = await setup();
    const first = await t.get(`/v1/live/routes/${ROUTE}`);
    const tag = first.headers.get('etag');
    assert.ok(tag);
    const again = await t.get(`/v1/live/routes/${ROUTE}`, MEMBER, { 'If-None-Match': tag });
    assert.equal(again.status, 304);
  });

  it('map member: the position while the trip is active, on route and fresh; never after', async () => {
    const t = await setup({ extras: { visibility: 'invited_map', audienceRoutes: [{ audienceId: AUDIENCE, routeId: ROUTE, canSeeMap: true }] } });
    const fixes = firstHalf(t.s).fixes;
    await t.s.feed(fixes);
    let body = await json<RouteView>(await t.get(`/v1/live/routes/${ROUTE}`));
    assert.equal(body.access, 'map');
    const vehicle = body.trips[0]?.vehicle;
    assert.ok(vehicle);
    const last = fixes[fixes.length - 1];
    assert.ok(last);
    const ll = t.s.plane.toLonLat(last.xy);
    assert.ok(Math.abs(vehicle.lon - ll.lon) < 1e-5 && Math.abs(vehicle.lat - ll.lat) < 1e-5);
    assert.equal(vehicle.recordedAt, last.t.toISOString());
    assert.ok(body.trips[0]?.stops.every((x) => x.stop.location !== null), 'stop locations at map level');

    // Three minutes without a position: stale, no position, only the time.
    t.s.clock.set(new Date(last.t.getTime() + 180_000));
    body = await json<RouteView>(await t.get(`/v1/live/routes/${ROUTE}`));
    assert.equal(firstTrip(body).stale, true);
    assert.equal(firstTrip(body).vehicle, null);
    assert.equal(firstTrip(body).lastSeenAt, last.t.toISOString());

    // The trip ends: no position, however fresh.
    const rest = new Track(t.s.shape, new Date(last.t.getTime() + 185_000), { startM: 1200 });
    rest.drive(STOP_M[3] - 2, 30).dwell(30).drive(STOP_M[4] - 2, 30).dwell(30).drive(STOP_M[5] - 2, 30).dwell(60).goTo({ x: 800, y: 480 }, 15);
    await t.s.feed(rest.fixes);
    body = await json<RouteView>(await t.get(`/v1/live/routes/${ROUTE}`));
    assert.equal(firstTrip(body).status, 'completed');
    assert.equal(firstTrip(body).vehicle, null);
    assert.equal(firstTrip(body).lastSeenAt, null);
  });

  it('off route: no position, the trip says so', async () => {
    const t = await setup({ extras: { visibility: 'invited_map', audienceRoutes: [{ audienceId: AUDIENCE, routeId: ROUTE, canSeeMap: true }] } });
    const track = firstHalf(t.s);
    track.goTo({ x: 1200, y: -400 }, 20).dwell(90);
    await t.s.feed(track.fixes);
    const body = await json<RouteView>(await t.get(`/v1/live/routes/${ROUTE}`));
    assert.equal(firstTrip(body).offRoute, true);
    assert.equal(firstTrip(body).vehicle, null);
  });

  it('401 without a valid token; 404 for unknown, invalid and not visible routes alike', async () => {
    const t = await setup();
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}`, null)).status, 401);
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}`, null, { Authorization: 'Bearer nope' })).status, 401);
    const notMember = await t.get(`/v1/live/routes/${ROUTE}`, OTHER);
    const unknown = await t.get('/v1/live/routes/00000000-0000-4000-8000-00000000dead');
    const invalid = await t.get('/v1/live/routes/route-1');
    for (const r of [notMember, unknown, invalid]) {
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: 'not found' });
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });

  it('a revoked membership answers 404 after the change notification', async () => {
    const t = await setup();
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}`)).status, 200);
    t.live.extras.memberships = [];
    await changed(t);
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}`)).status, 404);
  });

  it('keeps answering from memory when a reload fails (Supabase outage)', async () => {
    const t = await setup();
    t.live.failNext = 1;
    await assert.rejects(t.hub.reload());
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}`)).status, 200);
  });
});

describe('live API: public routes and stops', () => {
  it('a public route by slug: anyone, position while active, cacheable at the edge', async () => {
    const t = await setup({ extras: { visibility: 'public' } });
    await t.s.feed(firstHalf(t.s).fixes);
    const res = await t.get(`/v1/public/routes/${OPERATOR_SLUG}/${ROUTE_SLUG}`, null);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=5, s-maxage=5');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await json<RouteView>(res);
    assert.equal(body.access, 'map');
    assert.ok(body.trips[0]?.vehicle);
    const stop = await t.get(`/v1/public/stops/${OPERATOR_SLUG}/stop-3`, null);
    assert.equal(stop.status, 200);
    const sv = await json<StopView>(stop);
    assert.ok(sv.stop.location);
    assert.equal(sv.arrivals.length, 1);
    assert.ok(sv.arrivals[0]?.eta);
  });

  it('an invited route or an inactive public route is 404 on the public endpoints', async () => {
    for (const extras of [{}, { visibility: 'invited_map' as const }, { visibility: 'public' as const, active: false }]) {
      const t = await setup({ extras });
      const r = await t.get(`/v1/public/routes/${OPERATOR_SLUG}/${ROUTE_SLUG}`, null);
      assert.equal(r.status, 404);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=30, s-maxage=30');
      assert.equal((await t.get(`/v1/public/stops/${OPERATOR_SLUG}/stop-1`, null)).status, 404);
    }
    const t = await setup({ extras: { visibility: 'public' } });
    assert.equal((await t.get(`/v1/public/routes/${OPERATOR_SLUG}/nope`, null)).status, 404);
    assert.equal((await t.get(`/v1/public/routes/NOT_A_SLUG/${ROUTE_SLUG}`, null)).status, 404);
  });
});

describe('live API: stops and live trips', () => {
  it('a stop served twice by a loop lists both visits', async () => {
    const t = await setup({ route: 'loop' });
    const body = await json<StopView>(await t.get(`/v1/live/stops/${stopId(2)}`));
    assert.deepEqual(body.arrivals.map((a) => a.sequence), [2, 5]);
    assert.equal(body.routes[0]?.id, ROUTE);
    assert.equal(body.stop.location, null);
  });

  it('a live trip with planned stops: its audience sees it, others do not; no position until the engine follows it', async () => {
    const start = new Date('2026-11-27T01:00:00Z');
    const liveTrip: LiveInstanceRow = {
      id: LIVE_TRIP, operatorId: OPERATOR, kind: 'live', tripId: null, patternId: null, routeId: null, serviceDate: DATE,
      status: 'active', vehicleId: VEHICLE, visibleUntil: null, title: { en: 'Kiyomizu tour' }, startedAt: start, endedAt: null,
      offRouteSince: null,
      stopEvents: [{ sequence: 1, state: 'departed', arrivedAt: start, departedAt: start, passedAt: null, eta: null }],
      plannedStops: [
        { sequence: 1, stopId: stopId(1), plannedArrival: start, plannedDeparture: start },
        { sequence: 2, stopId: TOUR_STOP, plannedArrival: new Date(start.getTime() + 3600_000), plannedDeparture: new Date(start.getTime() + 7200_000) },
      ],
    };
    const t = await setup({
      extras: {
        instances: [liveTrip],
        stops: [{ id: TOUR_STOP, operatorId: OPERATOR, slug: 'temple', name: { en: 'Temple' }, lon: 135.78, lat: 34.99 }],
        memberships: [{ deviceId: MEMBER, audienceId: AUDIENCE }, { deviceId: TOURIST, audienceId: 'tour' }],
        tripAudiences: [{ tripInstanceId: LIVE_TRIP, audienceId: 'tour', canSeeMap: true }],
      },
    });
    t.s.clock.set(new Date(start.getTime() + 600_000));
    const res = await t.get(`/v1/live/trips/${LIVE_TRIP}`, TOURIST);
    assert.equal(res.status, 200);
    const body = await json<TripOnlyView>(res);
    assert.equal(body.route, null);
    assert.equal(body.trip.kind, 'live');
    assert.equal(body.trip.tracked, false);
    assert.equal(body.trip.vehicle, null);
    assert.equal(body.trip.access, 'map');
    assert.deepEqual(body.trip.stops.map((x) => [x.stop.id, x.state, x.scheduledArrival]), [
      [stopId(1), 'departed', start.toISOString()],
      [TOUR_STOP, 'upcoming', new Date(start.getTime() + 3600_000).toISOString()],
    ]);
    assert.ok(body.trip.stops[1]?.stop.location, 'map level: planned stop locations');
    assert.equal((await t.get(`/v1/live/trips/${LIVE_TRIP}`, MEMBER)).status, 404);
    const stop = await json<StopView>(await t.get(`/v1/live/stops/${TOUR_STOP}`, TOURIST));
    assert.deepEqual(stop.arrivals.map((a) => [a.tripInstanceId, a.kind]), [[LIVE_TRIP, 'live']]);
    assert.equal((await t.get(`/v1/live/stops/${TOUR_STOP}`, MEMBER)).status, 404);
  });
});

/** Reads an SSE response incrementally. */
class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  text = '';
  done = false;

  constructor(res: Response) {
    assert.ok(res.body);
    this.#reader = res.body.getReader();
  }

  async until(pred: (text: string) => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.text)) {
      if (this.done) throw new Error(`stream ended; got:\n${this.text}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; got:\n${this.text}`);
      const chunk = await Promise.race([this.#reader.read(), new Promise<null>((r) => setTimeout(() => { r(null); }, left))]);
      if (chunk === null) continue;
      if (chunk.done) this.done = true;
      else this.text += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  events(name: string): unknown[] {
    return [...this.text.matchAll(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`, 'g'))].map((m) => JSON.parse(m[1] ?? 'null') as unknown);
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

describe('live API: Server-Sent Events', () => {
  it('sends the route at once, then each change; heartbeats in between', async () => {
    const t = await setup({ limits: { heartbeatS: 1 } });
    const res = await t.get(`/v1/live/routes/${ROUTE}/stream`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const r = new SseReader(res);
    await r.until((x) => x.includes('event: route'));
    assert.match(r.text, /^retry: 5000\n\n/);
    assert.equal((r.events('route')[0] as RouteView).trips[0]?.status, 'planned');
    await t.s.feed(firstHalf(t.s).fixes);
    await r.until((x) => (r.events('route').at(-1) as RouteView | undefined)?.trips[0]?.status === 'active' && x.length > 0);
    const states = (r.events('route').at(-1) as RouteView).trips[0]?.stops.map((x) => x.state);
    assert.deepEqual(states, ['departed', 'departed', 'upcoming', 'upcoming', 'upcoming']);
    await r.until((x) => x.includes(': ping'), 2500);
    assert.equal(t.streams.size, 1);
    await r.cancel();
    await new Promise((res2) => setTimeout(res2, 20));
    assert.equal(t.streams.size, 0, 'the slot is freed when the client goes away');
  });

  it('limits streams per user and in total (429)', async () => {
    const t = await setup({ limits: { maxPerUser: 1, maxTotal: 2 } });
    const a = new SseReader(await t.get(`/v1/live/routes/${ROUTE}/stream`));
    await a.until((x) => x.includes('event: route'));
    const second = await t.get(`/v1/live/routes/${ROUTE}/stream`);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '30');
    t.live.extras.memberships.push({ deviceId: OTHER, audienceId: AUDIENCE }, { deviceId: TOURIST, audienceId: AUDIENCE });
    await changed(t);
    const b = new SseReader(await t.get(`/v1/live/routes/${ROUTE}/stream`, OTHER));
    await b.until((x) => x.includes('event: route'));
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}/stream`, TOURIST)).status, 429, 'total limit');
    await a.cancel();
    await b.cancel();
  });

  it('ends with "not_found" when access is lost, and "shutdown" on shutdown', async () => {
    const t = await setup();
    t.live.extras.memberships.push({ deviceId: OTHER, audienceId: AUDIENCE });
    await changed(t);
    const a = new SseReader(await t.get(`/v1/live/routes/${ROUTE}/stream`));
    const b = new SseReader(await t.get(`/v1/live/routes/${ROUTE}/stream`, OTHER));
    await a.until((x) => x.includes('event: route'));
    await b.until((x) => x.includes('event: route'));
    t.live.extras.memberships = [{ deviceId: OTHER, audienceId: AUDIENCE }];
    await changed(t);
    await a.until((x) => x.includes('event: end'));
    assert.deepEqual(a.events('end'), [{ reason: 'not_found' }]);
    await t.streams.closeAll(1000);
    await b.until((x) => x.includes('event: end'));
    assert.deepEqual(b.events('end'), [{ reason: 'shutdown' }]);
    await b.until(() => b.done);
    assert.equal(t.streams.size, 0);
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}/stream`, OTHER)).status, 429, 'no new streams while shutting down');
  });

  it('ends with "token_expired" when the access token expires', async () => {
    const t = await setup();
    const token = t.signer.token(MEMBER, { exp: Math.floor(Date.now() / 1000) + 1 });
    const r = new SseReader(await Promise.resolve(t.app.request(`/v1/live/routes/${ROUTE}/stream`, { headers: { Authorization: `Bearer ${token}` } })));
    await r.until((x) => x.includes('event: end'), 4000);
    assert.deepEqual(r.events('end'), [{ reason: 'token_expired' }]);
  });

  it('a stream for a route the user may not see is 404, not a stream', async () => {
    const t = await setup();
    assert.equal((await t.get(`/v1/live/routes/${ROUTE}/stream`, OTHER)).status, 404);
    assert.equal(t.streams.size, 0);
  });
});

describe('vehicle_state throttle', () => {
  it('writes vehicle_state about every 30 s, at once on trip start, off route and after a gap', async () => {
    const s = await Scenario.create(germanSchool([{ id: TRIP, serviceDate: DATE, start: '07:30' }]));
    const track = normalRun(s, TRIP);
    await s.feed(track.fixes);
    const writes = s.store.vehicleStateWrites;
    assert.ok(writes.length < track.fixes.length / 3, `${writes.length} writes for ${track.fixes.length} fixes`);
    // Never more than 30 s plus one fix interval between two writes.
    for (let i = 1; i < writes.length; i++) {
      const gap = ((writes[i]?.getTime() ?? 0) - (writes[i - 1]?.getTime() ?? 0)) / 1000;
      assert.ok(gap <= 35, `gap of ${gap} s`);
    }
    // The last stored state is at most 30 s old, and linked to no trip after it ended.
    const last = track.fixes[track.fixes.length - 1];
    const stored = s.store.vehicleState.get(VEHICLE);
    assert.ok(last && stored);
    assert.ok((last.t.getTime() - stored.recordedAt.getTime()) / 1000 <= 30);
    assert.equal(stored.tripInstanceId, null);

    // Off route: written at once.
    const s2 = await Scenario.create(germanSchool([{ id: TRIP, serviceDate: DATE, start: '07:30' }]));
    const t2 = new Track(s2.shape, new Date(s2.tripStart(TRIP).getTime() - 60_000));
    t2.dwell(120).drive(600, 30).goTo({ x: 600, y: -400 }, 20).dwell(120);
    let wentOff: { written: boolean } | null = null;
    for (const f of t2.fixes) {
      const before = s2.store.vehicleStateWrites.length;
      const wasOff = s2.store.instance(TRIP).offRouteSince !== null;
      await s2.feed([f]);
      if (!wasOff && s2.store.instance(TRIP).offRouteSince !== null) wentOff = { written: s2.store.vehicleStateWrites.length > before };
    }
    assert.ok(wentOff, 'the bus went off route');
    assert.equal(wentOff.written, true, 'written with the fix that went off route');
  });
});
