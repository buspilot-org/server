/**
 * Verifies Supabase access tokens (engine.md, "Live API": "verify the
 * Supabase JWT with the project's signing keys (JWKS, cached)").
 *
 * Only asymmetric signing keys from the project's JWKS endpoint
 * (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) are accepted: ES256 (the
 * Supabase default), RS256 and EdDSA. Tokens signed with the legacy shared
 * JWT secret (HS256) are rejected, so the engine never holds that secret.
 *
 * Keys are cached. They are fetched again every `refreshS`, and at most once
 * every `minRefetchS` when a token names an unknown key (key rotation). If
 * the endpoint is unreachable the cached keys stay in use (Supabase outage:
 * the live API keeps working).
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface Claims {
  /** auth.users.id */
  sub: string;
  /** Expiry (seconds since epoch). */
  exp: number;
  isAnonymous: boolean;
}

export class AuthError extends Error {}

const ALGORITHMS: Record<string, { kty: string; hash: string | null; crv?: string; ecdsa?: boolean }> = {
  ES256: { kty: 'EC', crv: 'P-256', hash: 'sha256', ecdsa: true },
  RS256: { kty: 'RSA', hash: 'sha256' },
  EdDSA: { kty: 'OKP', hash: null },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Key {
  alg: string;
  key: KeyObject;
}

export interface JwksFetcher {
  (url: string): Promise<unknown>;
}

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS request failed: ${res.status}`);
  return res.json();
};

function decodePart(part: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new AuthError('malformed token');
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('malformed token');
  }
}

/** The algorithm a JWK without `alg` is used with (Supabase's key types). */
function inferAlg(jwk: Record<string, unknown>): string | null {
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface VerifierOptions {
  /** Project URL, e.g. https://xyz.supabase.co or http://127.0.0.1:55321. */
  supabaseUrl: string;
  /** Expected `iss`; defaults to `<supabaseUrl>/auth/v1`. */
  issuer?: string;
  /** Expected `aud`. */
  audience?: string;
  refreshS?: number;
  minRefetchS?: number;
  /** Allowed clock skew (s). */
  leewayS?: number;
  fetcher?: JwksFetcher;
  now?: () => Date;
}

export class TokenVerifier {
  readonly #jwksUrl: string;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #refreshMs: number;
  readonly #minRefetchMs: number;
  readonly #leewayS: number;
  readonly #fetch: JwksFetcher;
  readonly #now: () => Date;
  #keys = new Map<string, Key>();
  #fetchedAt = 0;
  #attemptedAt = -Infinity;
  #inflight: Promise<void> | null = null;

  constructor(o: VerifierOptions) {
    const base = o.supabaseUrl.replace(/\/+$/, '');
    this.#jwksUrl = `${base}/auth/v1/.well-known/jwks.json`;
    this.#issuer = o.issuer ?? `${base}/auth/v1`;
    this.#audience = o.audience ?? 'authenticated';
    this.#refreshMs = (o.refreshS ?? 600) * 1000;
    this.#minRefetchMs = (o.minRefetchS ?? 30) * 1000;
    this.#leewayS = o.leewayS ?? 30;
    this.#fetch = o.fetcher ?? defaultFetcher;
    this.#now = o.now ?? (() => new Date());
  }

  /** Number of cached keys (health output). */
  get keyCount(): number {
    return this.#keys.size;
  }

  /** Fetches the keys now (startup); failures are reported, cached keys kept. */
  async refresh(): Promise<void> {
    this.#inflight ??= this.#load().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #load(): Promise<void> {
    this.#attemptedAt = this.#now().getTime();
    const body = await this.#fetch(this.#jwksUrl);
    if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error('JWKS response has no keys');
    const keys = new Map<string, Key>();
    for (const jwk of body.keys) {
      if (!isRecord(jwk) || typeof jwk.kid !== 'string') continue;
      // `alg` is optional in a JWK; then it follows from the key type.
      const alg = typeof jwk.alg === 'string' ? jwk.alg : inferAlg(jwk);
      if (alg === null) continue;
      const spec = ALGORITHMS[alg];
      if (!spec || jwk.kty !== spec.kty || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
      if (spec.crv !== undefined && jwk.crv !== spec.crv) continue;
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        if (key.type !== 'public') continue;
        keys.set(jwk.kid, { alg, key });
      } catch {
        // Skip keys Node cannot import.
      }
    }
    if (keys.size === 0) throw new Error('JWKS has no usable signing keys');
    this.#keys = keys;
    this.#fetchedAt = this.#now().getTime();
  }

  async #keyFor(kid: string): Promise<Key | undefined> {
    const now = this.#now().getTime();
    const known = this.#keys.get(kid);
    const mayFetch = now - this.#attemptedAt > this.#minRefetchMs;
    if (known) {
      // Periodic refresh in the background (a removed key stops working).
      if (now - this.#fetchedAt > this.#refreshMs && mayFetch) void this.refresh().catch(() => undefined);
      return known;
    }
    if (mayFetch || this.#inflight) {
      try {
        await this.refresh();
      } catch {
        // Keep the cached keys (outage); an unknown key stays unknown.
      }
    }
    return this.#keys.get(kid);
  }

  /** Verifies a bearer token and returns its claims, or throws AuthError. */
  async verify(token: string): Promise<Claims> {
    if (token.length > 8192) throw new AuthError('token too long');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('malformed token');
    const [h, p, s] = parts as [string, string, string];
    const header = decodePart(h);
    if (!isRecord(header) || typeof header.alg !== 'string' || typeof header.kid !== 'string') {
      throw new AuthError('unsupported token');
    }
    const spec = ALGORITHMS[header.alg];
    if (!spec) throw new AuthError('unsupported algorithm');
    const key = await this.#keyFor(header.kid);
    if (!key || key.alg !== header.alg) throw new AuthError('unknown signing key');
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new AuthError('malformed token');
    const signature = Buffer.from(s, 'base64url');
    const data = Buffer.from(`${h}.${p}`);
    let valid: boolean;
    try {
      valid = cryptoVerify(spec.hash, data, spec.ecdsa ? { key: key.key, dsaEncoding: 'ieee-p1363' } : key.key, signature);
    } catch {
      throw new AuthError('invalid signature');
    }
    if (!valid) throw new AuthError('invalid signature');

    const c = decodePart(p);
    if (!isRecord(c)) throw new AuthError('malformed token');
    const nowS = this.#now().getTime() / 1000;
    if (typeof c.exp !== 'number' || c.exp + this.#leewayS < nowS) throw new AuthError('token expired');
    if (typeof c.nbf === 'number' && c.nbf - this.#leewayS > nowS) throw new AuthError('token not yet valid');
    if (c.iss !== this.#issuer) throw new AuthError('wrong issuer');
    const aud = c.aud;
    if (!(aud === this.#audience || (Array.isArray(aud) && aud.includes(this.#audience)))) throw new AuthError('wrong audience');
    // Signed-in users only (anonymous rider devices and staff); not the anon
    // or service role keys.
    if (c.role !== 'authenticated') throw new AuthError('not a user token');
    if (typeof c.sub !== 'string' || !UUID.test(c.sub)) throw new AuthError('no user');
    return { sub: c.sub.toLowerCase(), exp: c.exp, isAnonymous: c.is_anonymous === true };
  }
}
