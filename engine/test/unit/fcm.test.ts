import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import type { HttpRequest, HttpResponse } from '../../src/alerts/fcm.ts';
import { FcmSender, classifyFcmResponse, loadServiceAccount, parseServiceAccount } from '../../src/alerts/fcm.ts';
import { buildPayload, languageOf, notificationText, pick } from '../../src/alerts/messages.ts';
import type { PushPayload } from '../../src/alerts/types.ts';
import { FakeClock, subscription } from '../replay/harness.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  type: 'service_account', project_id: 'buspilot-test', client_email: 'engine@buspilot-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.example.test/token',
});

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse {
  return { status, header: (n) => headers[n] ?? null, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

function fcmError(status: number, code: string, message = '', fcmCode?: string): HttpResponse {
  const details = fcmCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: fcmCode }] : [];
  return response(status, { error: { code: status, status: code, message, details } });
}

const payload = { data: { kind: 'approaching' } } as unknown as PushPayload;

/** Fake HTTP: OAuth token endpoint and FCM. */
function fakeHttp(fcm: (req: HttpRequest) => HttpResponse) {
  const requests: HttpRequest[] = [];
  let tokens = 0;
  const http = (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (req.url === 'https://oauth2.example.test/token') {
      tokens++;
      return Promise.resolve(response(200, { access_token: `access-${tokens}`, expires_in: 3600, token_type: 'Bearer' }));
    }
    return Promise.resolve(fcm(req));
  };
  return { http, requests, tokenRequests: () => tokens };
}

describe('FCM service account', () => {
  it('parses a key file and rejects anything else', () => {
    const sa = parseServiceAccount(KEY_JSON);
    assert.equal(sa.projectId, 'buspilot-test');
    assert.throws(() => parseServiceAccount('{"type": "authorized_user"}'), /service_account/);
    assert.throws(() => parseServiceAccount('not json'), /not valid JSON/);
  });

  it('comes from FCM_SERVICE_ACCOUNT_JSON or _FILE; none means push is off', () => {
    assert.equal(loadServiceAccount({}), null);
    assert.equal(loadServiceAccount({ FCM_SERVICE_ACCOUNT_JSON: KEY_JSON })?.clientEmail, 'engine@buspilot-test.iam.gserviceaccount.com');
    assert.throws(() => loadServiceAccount({ FCM_SERVICE_ACCOUNT_JSON: KEY_JSON, FCM_SERVICE_ACCOUNT_FILE: '/x' }), /not both/);
  });
});

describe('FCM sender', () => {
  it('gets an OAuth token with a signed JWT, caches it, and sends to the FID', async () => {
    const clock = new FakeClock(new Date('2026-11-24T07:00:00Z'));
    const fake = fakeHttp(() => response(200, { name: 'projects/buspilot-test/messages/1' }));
    const sender = new FcmSender({ serviceAccount: parseServiceAccount(KEY_JSON), http: fake.http, clock });
    assert.deepEqual(await sender.send({ target: 'fid-123', payload }), { ok: true });
    assert.deepEqual(await sender.send({ target: 'fid-456', payload }), { ok: true });
    assert.equal(fake.tokenRequests(), 1, 'token cached');

    const [tokenReq, send] = fake.requests;
    assert.ok(tokenReq && send);
    const form = new URLSearchParams(tokenReq.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = (form.get('assertion') ?? '').split('.');
    assert.ok(h && c && sig);
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'signed with the key');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>;
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, 'https://oauth2.example.test/token');

    assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/buspilot-test/messages:send');
    assert.equal(send.headers.authorization, 'Bearer access-1');
    assert.deepEqual(JSON.parse(send.body), { message: { fid: 'fid-123', data: { kind: 'approaching' } } });

    clock.set(new Date('2026-11-24T07:56:00Z')); // less than 5 min before expiry
    await sender.send({ target: 'fid-123', payload });
    assert.equal(fake.tokenRequests(), 2, 'refreshed before it expires');
  });

  it('can address a registration token instead (FCM_TARGET=token)', async () => {
    const fake = fakeHttp(() => response(200));
    const sender = new FcmSender({ serviceAccount: parseServiceAccount(KEY_JSON), http: fake.http, targetField: 'token', projectId: 'other' });
    await sender.send({ target: 't', payload });
    const send = fake.requests[1];
    assert.equal(send?.url, 'https://fcm.googleapis.com/v1/projects/other/messages:send');
    assert.equal((JSON.parse(send.body) as { message: Record<string, unknown> }).message.token, 't');
  });

  it('401: retryable, and the next attempt gets a new access token', async () => {
    let first = true;
    const fake = fakeHttp(() => {
      const r = first ? fcmError(401, 'UNAUTHENTICATED') : response(200);
      first = false;
      return r;
    });
    const sender = new FcmSender({ serviceAccount: parseServiceAccount(KEY_JSON), http: fake.http });
    assert.deepEqual(await sender.send({ target: 'f', payload }), { ok: false, code: 'UNAUTHENTICATED', retryable: true, invalidTarget: false });
    assert.deepEqual(await sender.send({ target: 'f', payload }), { ok: true });
    assert.equal(fake.tokenRequests(), 2);
  });

  it('network errors and token endpoint failures are retryable', async () => {
    const sender = new FcmSender({ serviceAccount: parseServiceAccount(KEY_JSON), http: () => Promise.reject(new Error('ECONNRESET')) });
    assert.deepEqual(await sender.send({ target: 'f', payload }), { ok: false, code: 'AUTH', retryable: true, invalidTarget: false });
    let calls = 0;
    const flaky = new FcmSender({
      serviceAccount: parseServiceAccount(KEY_JSON),
      http: (req) => (++calls === 1 || req.url.includes('oauth2') ? Promise.resolve(response(200, { access_token: 'a' })) : Promise.reject(new Error('timeout'))),
    });
    assert.deepEqual(await flaky.send({ target: 'f', payload }), { ok: false, code: 'NETWORK', retryable: true, invalidTarget: false });
  });
});

describe('FCM error classification', () => {
  const c = (r: HttpResponse) => {
    const res = classifyFcmResponse(r);
    return res.ok ? 'ok' : `${res.code} retry=${String(res.retryable)} invalid=${String(res.invalidTarget)}${res.retryAfterS ? ` after=${res.retryAfterS}` : ''}`;
  };

  it('maps FCM errors', () => {
    assert.equal(c(response(200)), 'ok');
    assert.equal(c(fcmError(404, 'NOT_FOUND', 'Requested entity was not found.', 'UNREGISTERED')), 'UNREGISTERED retry=false invalid=true');
    assert.equal(c(fcmError(403, 'PERMISSION_DENIED', '', 'SENDER_ID_MISMATCH')), 'SENDER_ID_MISMATCH retry=false invalid=true');
    assert.equal(c(fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token', 'INVALID_ARGUMENT')), 'INVALID_ARGUMENT retry=false invalid=true');
    assert.equal(c(fcmError(400, 'INVALID_ARGUMENT', 'Invalid value at \'message.android.ttl\'', 'INVALID_ARGUMENT')), 'INVALID_ARGUMENT retry=false invalid=false', 'a bad message does not clear the target');
    assert.equal(c(fcmError(429, 'RESOURCE_EXHAUSTED', '', 'QUOTA_EXCEEDED')), 'QUOTA_EXCEEDED retry=true invalid=false');
    assert.equal(c({ ...fcmError(503, 'UNAVAILABLE', '', 'UNAVAILABLE'), header: (n) => (n === 'retry-after' ? '30' : null) }), 'UNAVAILABLE retry=true invalid=false after=30');
    assert.equal(c(fcmError(500, 'INTERNAL', '', 'INTERNAL')), 'INTERNAL retry=true invalid=false');
    assert.equal(c(fcmError(401, 'UNAUTHENTICATED', '', 'THIRD_PARTY_AUTH_ERROR')), 'THIRD_PARTY_AUTH_ERROR retry=true invalid=false');
    assert.equal(c(response(502, '<html>bad gateway</html>')), 'HTTP_502 retry=true invalid=false');
    assert.equal(c(fcmError(403, 'PERMISSION_DENIED')), 'PERMISSION_DENIED retry=false invalid=false');
  });
});

describe('push messages', () => {
  const now = new Date('2026-11-24T07:35:00+09:00');
  const base = {
    sub: subscription('A', 4, { routeShortName: 'A' }), tripInstanceId: 'T1', serviceDate: '2026-11-24',
    tripStart: new Date('2026-11-24T07:30:00+09:00'), eta: new Date(now.getTime() + 290_000), delayS: null, deliveryId: 'd1', now, ttlS: 1800,
  };

  it('language: ja, en or de from the device tag; Japanese without one', () => {
    assert.equal(languageOf(null), 'ja');
    assert.equal(languageOf('ja-JP'), 'ja');
    assert.equal(languageOf('de'), 'de');
    assert.equal(languageOf('pt-BR'), 'en');
    assert.equal(pick({ ja: '北野', de: 'Kitano' }, 'en'), '北野');
    assert.equal(pick({ fr: 'x' }, 'ja'), 'x');
  });

  it('texts for every kind', () => {
    const t = (variant: Parameters<typeof notificationText>[0]['variant'], lang: string, over = {}) =>
      notificationText({ ...base, variant, sub: subscription('A', 4, { language: lang, routeShortName: 'A' }), ...over }).body;
    assert.equal(notificationText({ ...base, variant: 'approaching' }).title, 'A Morning route A');
    assert.equal(t('approaching', 'en'), 'The bus arrives at Stop 4 in about 5 min.');
    assert.equal(t('approaching', 'en', { eta: null }), 'The bus is approaching Stop 4.');
    assert.equal(t('approaching', 'en', { eta: new Date(now.getTime() + 10_000) }), 'The bus arrives at Stop 4 in about 1 min.');
    assert.equal(t('arrived', 'ja'), 'バスが停留所4に到着しました。');
    assert.equal(t('passed', 'de'), 'Der Bus ist ohne Halt an Stop 4 vorbeigefahren.');
    assert.equal(t('delayed', 'de', { delayS: 720 }), 'Der Bus hat etwa 12 Min. Verspätung. Ankunft an Stop 4 gegen 07:39.');
    assert.equal(t('cancelled', 'de'), 'Die Fahrt um 07:30 am 24.11. fällt aus.');
  });

  it('payload: string data, channel, TTL and collapse keys', () => {
    const p = buildPayload({ ...base, variant: 'approaching' });
    assert.equal(p.android.ttl, '1800s');
    assert.equal(p.android.priority, 'HIGH');
    assert.equal(p.apns.headers['apns-expiration'], String(Math.floor(now.getTime() / 1000) + 1800));
    assert.equal(p.apns.headers['apns-collapse-id'], 'T1:4');
    assert.equal(p.data.eta, base.eta.toISOString());
    assert.equal(p.data.delay_s, '');
    assert.equal(buildPayload({ ...base, variant: 'cancelled', ttlS: 5 }).android.ttl, '60s', 'at least a minute');
  });
});
