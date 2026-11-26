import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { AuthError, TokenVerifier } from '../../src/live/auth.ts';
import { ISSUER, SUPABASE_URL, TokenSigner } from '../replay/live.ts';

const USER = '0f000000-0000-4000-8000-000000000001';

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

describe('access token verification (JWKS)', () => {
  it('accepts a valid ES256 token and returns the user', async () => {
    const t = new TokenSigner();
    const claims = await t.verifier().verify(t.token(USER));
    assert.equal(claims.sub, USER);
    assert.equal(claims.isAnonymous, true);
    assert.equal(t.fetches, 1);
  });

  it('caches the keys: one JWKS fetch for many tokens', async () => {
    const t = new TokenSigner();
    const v = t.verifier();
    for (let i = 0; i < 5; i++) await v.verify(t.token(USER));
    assert.equal(t.fetches, 1);
  });

  for (const [name, over] of [
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 120 }],
    ['a token from another issuer', { iss: 'https://other.supabase.co/auth/v1' }],
    ['a token for another audience', { aud: 'other' }],
    ['the anon key (role anon)', { role: 'anon' }],
    ['the service role key', { role: 'service_role' }],
    ['a token without a user', { sub: undefined }],
    ['a token whose sub is not a UUID', { sub: 'admin' }],
    ['a token not valid yet', { nbf: Math.floor(Date.now() / 1000) + 600 }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const t = new TokenSigner();
      await assert.rejects(t.verifier().verify(t.token(USER, over)), AuthError);
    });
  }

  it('accepts a little clock skew', async () => {
    const t = new TokenSigner();
    await t.verifier().verify(t.token(USER, { exp: Math.floor(Date.now() / 1000) - 10 }));
  });

  it('rejects a tampered payload and a token signed by another key', async () => {
    const t = new TokenSigner();
    const v = t.verifier();
    const [h, , s] = t.token(USER).split('.');
    const forged = `${h ?? ''}.${b64({ iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: USER, exp: 9e9 })}.${s ?? ''}`;
    await assert.rejects(v.verify(forged), /invalid signature/);
    const other = new TokenSigner();
    await assert.rejects(v.verify(other.token(USER, {}, { kid: t.kid })), /invalid signature/);
  });

  it('rejects HS256 (the legacy shared secret) and alg "none"', async () => {
    const t = new TokenSigner();
    const v = t.verifier();
    const h = b64({ alg: 'HS256', kid: t.kid, typ: 'JWT' });
    const p = b64({ iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: USER, exp: 9e9 });
    const mac = createHmac('sha256', 'super-secret-jwt-token-with-at-least-32-characters-long').update(`${h}.${p}`).digest('base64url');
    await assert.rejects(v.verify(`${h}.${p}.${mac}`), /unsupported algorithm/);
    await assert.rejects(v.verify(`${b64({ alg: 'none', kid: t.kid })}.${p}.`), /unsupported algorithm/);
  });

  it('rejects a header algorithm that does not match the key (RS256 header, ES256 key)', async () => {
    const t = new TokenSigner();
    await assert.rejects(t.verifier().verify(t.token(USER, {}, { alg: 'RS256' })), /unknown signing key/);
  });

  it('verifies RS256 keys too', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'rsa-1';
    const v = new TokenVerifier({
      supabaseUrl: SUPABASE_URL,
      fetcher: () => Promise.resolve({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] }),
    });
    const h = b64({ alg: 'RS256', kid, typ: 'JWT' });
    const p = b64({ iss: ISSUER, aud: 'authenticated', role: 'authenticated', sub: USER, exp: Math.floor(Date.now() / 1000) + 60 });
    const s = sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    assert.equal((await v.verify(`${h}.${p}.${s}`)).sub, USER);
  });

  it('fetches the keys again for an unknown key ID (rotation), at most every 30 s', async () => {
    let now = new Date('2026-11-27T00:00:00Z');
    const t = new TokenSigner();
    const v = t.verifier(() => now);
    await v.verify(t.token(USER, {}, {}, now));
    const rotated = new TokenSigner();
    // Unknown key, fetched again: still unknown (the endpoint serves the old key).
    now = new Date(now.getTime() + 60_000);
    await assert.rejects(v.verify(rotated.token(USER, {}, {}, now)), /unknown signing key/);
    assert.equal(t.fetches, 2);
    // Within 30 s: no new fetch, however many unknown tokens come in.
    await assert.rejects(v.verify(rotated.token(USER, {}, {}, now)), /unknown signing key/);
    assert.equal(t.fetches, 2);
  });

  it('keeps the cached keys while the JWKS endpoint is unreachable (Supabase outage)', async () => {
    let now = new Date('2026-11-27T00:00:00Z');
    const t = new TokenSigner();
    const v = t.verifier(() => now);
    await v.verify(t.token(USER, {}, {}, now));
    t.failFetch = true;
    now = new Date(now.getTime() + 11 * 60_000); // refresh due
    assert.equal((await v.verify(t.token(USER, {}, {}, now))).sub, USER);
    await new Promise((r) => setImmediate(r));
    assert.equal(v.keyCount, 1);
  });

  it('rejects malformed tokens', async () => {
    const t = new TokenSigner();
    const v = t.verifier();
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '!!.??.**', `${b64({ alg: 'ES256' })}.e30.`]) {
      await assert.rejects(v.verify(bad), AuthError, bad);
    }
  });
});
