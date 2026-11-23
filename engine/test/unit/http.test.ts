import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp, secretMatches } from '../../src/http/app.ts';
import { createLogger } from '../../src/log.ts';
import { PayloadError, parseTraccarPosition } from '../../src/traccar.ts';
import { DEVICE, Scenario } from '../replay/harness.ts';

const SECRET = 'a'.repeat(40);

/** What Traccar's JSON forwarder posts (PositionData, Jackson, dates as ISO strings). */
function payload(over: { uniqueId?: string; lat?: number; lon?: number; fixTime?: string; id?: number; speed?: number } = {}): unknown {
  return {
    position: {
      id: over.id ?? 4711,
      attributes: { batteryLevel: 69, distance: 12.3, motion: true },
      deviceId: 17,
      protocol: 'osmand',
      serverTime: '2026-11-23T22:20:01.000+00:00',
      deviceTime: over.fixTime ?? '2026-11-23T22:20:00.000+00:00',
      fixTime: over.fixTime ?? '2026-11-23T22:20:00.000+00:00',
      outdated: false,
      valid: true,
      latitude: over.lat ?? 34.69,
      longitude: over.lon ?? 135.19,
      altitude: 12,
      speed: over.speed ?? 10,
      course: 370,
      accuracy: 8,
      network: null,
    },
    device: {
      id: 17,
      attributes: {},
      groupId: 3,
      calendarId: 0,
      name: 'Bus 1',
      uniqueId: over.uniqueId ?? DEVICE,
      status: 'online',
      lastUpdate: '2026-11-23T22:20:01.000+00:00',
      positionId: 4711,
      phone: null,
      model: null,
      contact: null,
      category: 'bus',
      disabled: false,
      expirationTime: null,
    },
  };
}

describe('Traccar payload', () => {
  it('parses PositionData: knots to km/h, course normalised', () => {
    const p = parseTraccarPosition(payload());
    assert.equal(p.deviceId, DEVICE);
    assert.equal(p.positionId, 4711);
    assert.equal(p.fixTime.toISOString(), '2026-11-23T22:20:00.000Z');
    assert.ok(Math.abs(p.speedKmh - 18.52) < 1e-9);
    assert.equal(p.course, 10);
    assert.equal(p.accuracyM, 8);
    assert.equal(p.valid, true);
  });

  it('rejects malformed payloads without echoing values', () => {
    assert.throws(() => parseTraccarPosition({}), PayloadError);
    assert.throws(() => parseTraccarPosition(payload({ lat: 123 })), /invalid coordinates/);
    assert.throws(() => parseTraccarPosition(payload({ fixTime: 'yesterday' })), /invalid fix time/);
  });
});

describe('secret check', () => {
  it('compares in constant time, any length', () => {
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches('short', SECRET), false);
    assert.equal(secretMatches(SECRET + 'x', SECRET), false);
  });
});

describe('HTTP API', () => {
  async function setup(): Promise<{ s: Scenario; app: ReturnType<typeof createApp>; logs: string[] }> {
    const s = await Scenario.create({
      shape: [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
      stops: [
        { sequence: 1, at: { x: 0, y: 0 }, arrivalOffsetS: 0, departureOffsetS: 0 },
        { sequence: 2, at: { x: 1000, y: 0 }, arrivalOffsetS: 300, departureOffsetS: 300 },
      ],
      trips: [{ id: 'T1', serviceDate: '2026-11-24', start: '07:30' }],
    });
    s.clock.set(new Date('2026-11-23T22:21:00Z'));
    const logs: string[] = [];
    const app = createApp({ engine: s.engine, traccarSecret: SECRET, log: createLogger('debug', (l) => logs.push(l)) });
    return { s, app, logs };
  }
  const post = (app: ReturnType<typeof createApp>, body: unknown, secret = SECRET): Promise<Response> =>
    Promise.resolve(app.request(`/v1/traccar/positions/${secret}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

  it('accepts a position of a known vehicle and deduplicates retries', async () => {
    const { s, app } = await setup();
    const r1 = await post(app, payload());
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { result: 'processed' });
    assert.ok(s.store.vehicleState.get('veh-1'));
    const r2 = await post(app, payload());
    assert.deepEqual(await r2.json(), { result: 'duplicate' });
  });

  it('rejects a wrong secret with 401', async () => {
    const { app } = await setup();
    const r = await post(app, payload(), 'b'.repeat(40));
    assert.equal(r.status, 401);
  });

  it('drops unknown devices with 2xx, writes and logs nothing about them', async () => {
    const { s, app, logs } = await setup();
    const r = await post(app, payload({ uniqueId: 'not-a-bus', lat: 35.123456, lon: 139.654321 }));
    assert.equal(r.status, 202);
    assert.equal(s.store.persistCalls, 0);
    assert.equal(s.engine.metrics.positionsUnknownDevice, 1);
    const all = logs.join('\n');
    assert.ok(!all.includes('35.12') && !all.includes('139.65') && !all.includes('not-a-bus'));
  });

  it('400 for malformed JSON or payloads, 404 elsewhere', async () => {
    const { app } = await setup();
    const bad = await app.request(`/v1/traccar/positions/${SECRET}`, { method: 'POST', body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await post(app, { position: {} })).status, 400);
    assert.equal((await post(app, payload({ lat: 99 }))).status, 400);
    assert.equal((await app.request('/nothing')).status, 404);
  });

  it('503 when the write fails, so Traccar retries', async () => {
    const { s, app } = await setup();
    s.store.failNext = 1;
    assert.equal((await post(app, payload())).status, 503);
    assert.equal((await post(app, payload())).status, 200);
  });

  it('healthz', async () => {
    const { app } = await setup();
    const r = await app.request('/healthz');
    assert.equal(r.status, 200);
    const body = await r.json() as { status: string };
    assert.equal(body.status, 'ok');
  });
});
