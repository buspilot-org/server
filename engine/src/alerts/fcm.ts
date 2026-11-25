/**
 * FCM HTTP v1 sender (Android, and iOS through FCM → APNs).
 *
 * Authenticates with a Google service account (OAuth 2.0 JWT bearer grant,
 * signed here with node:crypto, no Google SDK). The service account key is
 * read from a file or an environment variable on the engine host and is
 * never committed or logged; neither are push targets or access tokens.
 *
 * The rider app (firebase_messaging 17) registers a Firebase Installation ID
 * (FID), which FCM HTTP v1 addresses with `message.fid`. `token` (a legacy
 * registration token) can be chosen instead with FCM_TARGET=token.
 *
 * HTTP goes through a `HttpTransport`, so tests use a fake one.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Clock } from '../core/engine.ts';
import type { PushMessage, PushSender, SendResult } from './types.ts';

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  /** Lower-case header names. */
  header(name: string): string | null;
  text: string;
}

export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** POST with fetch and a timeout. */
export function fetchTransport(timeoutMs = 10_000): HttpTransport {
  return async (req) => {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, header: (n) => res.headers.get(n), text: await res.text() };
  };
}

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Parses a service account key file (JSON as downloaded from the Firebase console). */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('the FCM service account is not valid JSON');
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? o[k] : '');
  if (str('type') !== 'service_account' || str('client_email') === '' || str('private_key') === '' || str('project_id') === '') {
    throw new Error('the FCM service account needs type "service_account", project_id, client_email and private_key');
  }
  return { projectId: str('project_id'), clientEmail: str('client_email'), privateKey: str('private_key'), tokenUri: str('token_uri') || DEFAULT_TOKEN_URI };
}

/**
 * The service account from FCM_SERVICE_ACCOUNT_FILE (a path) or
 * FCM_SERVICE_ACCOUNT_JSON (the JSON itself), or null if neither is set
 * (push disabled).
 */
export function loadServiceAccount(env: NodeJS.ProcessEnv): ServiceAccount | null {
  const file = env.FCM_SERVICE_ACCOUNT_FILE ?? '';
  const json = env.FCM_SERVICE_ACCOUNT_JSON ?? '';
  if (file !== '' && json !== '') throw new Error('set FCM_SERVICE_ACCOUNT_FILE or FCM_SERVICE_ACCOUNT_JSON, not both');
  if (file !== '') return parseServiceAccount(readFileSync(file, 'utf8'));
  if (json !== '') return parseServiceAccount(json);
  return null;
}

function base64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

/** OAuth access tokens for the service account, cached until shortly before they expire. */
export class GoogleAuth {
  readonly #sa: ServiceAccount;
  readonly #http: HttpTransport;
  readonly #clock: Clock;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;

  constructor(sa: ServiceAccount, http: HttpTransport, clock: Clock = { now: () => new Date() }) {
    this.#sa = sa;
    this.#http = http;
    this.#clock = clock;
  }

  invalidate(): void {
    this.#token = null;
  }

  async accessToken(): Promise<string> {
    const now = this.#clock.now().getTime();
    if (this.#token && this.#token.expiresAt - 300_000 > now) return this.#token.value;
    this.#pending ??= this.#fetch().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #fetch(): Promise<string> {
    const iat = Math.floor(this.#clock.now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: this.#sa.clientEmail, scope: SCOPE, aud: this.#sa.tokenUri, iat, exp: iat + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.#sa.privateKey).toString('base64url');
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` });
    const res = await this.#http({ url: this.#sa.tokenUri, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (res.status !== 200) throw new Error(`OAuth token request failed with HTTP ${res.status}`);
    const parsed = JSON.parse(res.text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string') throw new Error('OAuth token response has no access_token');
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
    this.#token = { value: parsed.access_token, expiresAt: iat * 1000 + expiresIn * 1000 };
    return parsed.access_token;
  }
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: { '@type'?: string; errorCode?: string }[];
  };
}

/** Maps an FCM HTTP v1 response to a send result (https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode). */
export function classifyFcmResponse(res: HttpResponse): SendResult {
  if (res.status >= 200 && res.status < 300) return { ok: true };
  let body: FcmErrorBody = {};
  try {
    body = JSON.parse(res.text) as FcmErrorBody;
  } catch {
    // Not JSON (a proxy error page): classify by status only.
  }
  const fcmCode = body.error?.details?.find((d) => d['@type']?.endsWith('google.firebase.fcm.v1.FcmError'))?.errorCode;
  const code = fcmCode ?? body.error?.status ?? `HTTP_${res.status}`;
  const retryAfter = Number(res.header('retry-after'));
  const retryAfterS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  const fail = (retryable: boolean, invalidTarget = false): SendResult => ({ ok: false, code, retryable, invalidTarget, ...(retryAfterS === undefined ? {} : { retryAfterS }) });

  if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return fail(false, true);
  if (code === 'INVALID_ARGUMENT') {
    // Also used for a malformed message; only clear the target if FCM says it is the target.
    return fail(false, /registration token|installation|\bfid\b/i.test(body.error?.message ?? ''));
  }
  if (res.status === 401) return fail(true);
  if (res.status === 429 || res.status >= 500 || code === 'QUOTA_EXCEEDED' || code === 'UNAVAILABLE' || code === 'INTERNAL') return fail(true);
  return fail(false);
}

export class FcmSender implements PushSender {
  readonly #auth: GoogleAuth;
  readonly #http: HttpTransport;
  readonly #url: string;
  readonly #targetField: 'fid' | 'token';

  constructor(opts: { serviceAccount: ServiceAccount; http?: HttpTransport; clock?: Clock; projectId?: string; targetField?: 'fid' | 'token' }) {
    this.#http = opts.http ?? fetchTransport();
    this.#auth = new GoogleAuth(opts.serviceAccount, this.#http, opts.clock);
    const project = opts.projectId ?? opts.serviceAccount.projectId;
    this.#url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`;
    this.#targetField = opts.targetField ?? 'fid';
  }

  async send(msg: PushMessage): Promise<SendResult> {
    let accessToken: string;
    try {
      accessToken = await this.#auth.accessToken();
    } catch {
      return { ok: false, code: 'AUTH', retryable: true, invalidTarget: false };
    }
    let res: HttpResponse;
    try {
      res = await this.#http({
        url: this.#url,
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message: { [this.#targetField]: msg.target, ...msg.payload } }),
      });
    } catch {
      return { ok: false, code: 'NETWORK', retryable: true, invalidTarget: false };
    }
    const result = classifyFcmResponse(res);
    if (!result.ok && res.status === 401) this.#auth.invalidate();
    return result;
  }
}
