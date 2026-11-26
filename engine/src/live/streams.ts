/**
 * Server-Sent Events for the live API (`…/stream`): the same JSON as the
 * polling endpoint, sent again whenever it changes, while the map or route
 * screen is open.
 *
 * - First message at once, then on every change of the route or trip, at
 *   most every `minIntervalMs`, and only if the content changed.
 * - A comment line (`: ping`) every `heartbeatS`, so proxies keep the
 *   connection open and clients notice a dead one.
 * - Limits: `maxTotal` open streams in all, `maxPerUser` per user and, when
 *   a trusted proxy header gives the client IP, `maxPerIp` per IP (anonymous
 *   accounts cost nothing, so the per-user limit alone does not stop one
 *   client from taking every slot); more answer 429. A client that does not
 *   read for `writeTimeoutS` is dropped.
 * - The stream ends with `event: end` and `data: {"reason": …}`:
 *   `token_expired` (at the access token's expiry: reconnect with a fresh
 *   token), `not_found` (access lost, or the route is gone), `trip_ended`
 *   (a trip stream's trip is over and no longer today's), `unavailable` (the
 *   engine could not reload access data for too long; reconnect later), `shutdown`
 *   (engine restart: reconnect after the `retry` delay).
 */
import type { SSEStreamingApi } from 'hono/streaming';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { Change, LiveHub } from './hub.ts';

export interface StreamLimits {
  maxTotal: number;
  maxPerUser: number;
  /** Per client IP; only applied when the IP comes from a trusted proxy header (LIVE_CLIENT_IP_HEADER). */
  maxPerIp: number;
  heartbeatS: number;
  minIntervalMs: number;
  /** Reconnect delay suggested to clients (`retry:`), ms. */
  retryMs: number;
  writeTimeoutS: number;
}

export const defaultStreamLimits: StreamLimits = {
  maxTotal: 2000,
  maxPerUser: 4,
  maxPerIp: 20,
  heartbeatS: 20,
  minIntervalMs: 1000,
  retryMs: 5000,
  writeTimeoutS: 30,
};

export type EndReason = 'token_expired' | 'not_found' | 'trip_ended' | 'unavailable' | 'shutdown' | 'slow_client';

interface Slot {
  user: string;
  end(reason: EndReason): void;
  done: Promise<void>;
}

/** Open streams, their limits and shutdown. */
export class StreamRegistry {
  readonly limits: StreamLimits;
  readonly #open = new Set<Slot>();
  readonly #perUser = new Map<string, number>();
  readonly #perIp = new Map<string, number>();
  #closing = false;
  metrics = { opened: 0, rejected: 0 };

  constructor(limits: StreamLimits) {
    this.limits = limits;
  }

  get size(): number {
    return this.#open.size;
  }

  /** Reserves a slot for a user (and client IP, if known), or null when a limit is reached (or the engine is shutting down). */
  reserve(user: string, ip: string | null = null): { release(): void; register(s: Omit<Slot, 'user'>): void } | null {
    if (
      this.#closing || this.#open.size >= this.limits.maxTotal
      || (this.#perUser.get(user) ?? 0) >= this.limits.maxPerUser
      || (ip !== null && (this.#perIp.get(ip) ?? 0) >= this.limits.maxPerIp)
    ) {
      this.metrics.rejected++;
      return null;
    }
    this.#perUser.set(user, (this.#perUser.get(user) ?? 0) + 1);
    if (ip !== null) this.#perIp.set(ip, (this.#perIp.get(ip) ?? 0) + 1);
    let slot: Slot | null = null;
    // Counted at once, so concurrent requests cannot pass the limits.
    const placeholder: Slot = { user, end: () => undefined, done: Promise.resolve() };
    this.#open.add(placeholder);
    this.metrics.opened++;
    let released = false;
    return {
      register: (s) => {
        this.#open.delete(placeholder);
        slot = { user, ...s };
        this.#open.add(slot);
      },
      release: () => {
        if (released) return;
        released = true;
        this.#open.delete(slot ?? placeholder);
        decrement(this.#perUser, user);
        if (ip !== null) decrement(this.#perIp, ip);
      },
    };
  }

  /** Ends every stream (`event: end`, reason shutdown) and waits until they are closed, at most `timeoutMs`. */
  async closeAll(timeoutMs = 3000): Promise<void> {
    this.#closing = true;
    const slots = [...this.#open];
    for (const s of slots) s.end('shutdown');
    await Promise.race([
      Promise.allSettled(slots.map((s) => s.done)),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
  }
}

function decrement(m: Map<string, number>, key: string): void {
  const n = (m.get(key) ?? 1) - 1;
  if (n <= 0) m.delete(key);
  else m.set(key, n);
}

export interface StreamSpec {
  /** SSE event name of the content messages (`route`, `trip`). */
  event: string;
  /** Builds the current content; null = no longer visible. */
  build(): object | null;
  /** Why build() returned null (not_found: access lost or gone; unavailable; trip_ended). */
  goneReason?(): EndReason;
  /** Whether a change concerns this stream. */
  relevant(c: Change): boolean;
  /** When the viewer's access token expires (ms since epoch). */
  expiresAt: number;
  /**
   * Closes the connection at once (destroys the socket). Used when the
   * client does not read: its pending writes would otherwise keep the
   * socket, its buffers and server.close() waiting.
   */
  drop(): void;
}

/** Runs one SSE stream until the client goes away or the stream ends. */
export async function runStream(
  stream: SSEStreamingApi,
  spec: StreamSpec,
  first: object,
  hub: LiveHub,
  slot: { release(): void; register(s: Omit<Slot, 'user'>): void },
  limits: StreamLimits,
  log: Logger,
): Promise<void> {
  let finished = false;
  /** (A function: finish() may set `finished` during an await.) */
  const isFinished = (): boolean => finished;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let lastBody = '';
  let lastSentAt = 0;
  let pending: NodeJS.Timeout | null = null;
  let writing = false;
  let dirty = false;
  const timers: NodeJS.Timeout[] = [];

  /** Writes with a deadline: a client that stops reading is dropped. */
  const write = async (text: string): Promise<boolean> => {
    writing = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const ok = await Promise.race([
        stream.write(text).then(() => true),
        new Promise<false>((r) => { timer = setTimeout(() => { r(false); }, limits.writeTimeoutS * 1000); }),
      ]);
      if (!ok) void finish('slow_client');
      return ok;
    } finally {
      clearTimeout(timer);
      writing = false;
      // A change that came in during the write.
      if (dirty && !finished) schedule();
    }
  };

  const sendContent = async (content: object): Promise<void> => {
    // Compared without the timestamp: only real changes are sent.
    const rest: Record<string, unknown> = { ...content };
    delete rest.generatedAt;
    const body = JSON.stringify(rest);
    if (body === lastBody) return;
    lastBody = body;
    lastSentAt = Date.now();
    await write(`event: ${spec.event}\ndata: ${JSON.stringify(content)}\n\n`);
  };

  const flush = async (): Promise<void> => {
    pending = null;
    if (finished) return;
    if (writing) {
      dirty = true;
      return;
    }
    dirty = false;
    let content: object | null;
    try {
      content = spec.build();
    } catch (err) {
      log.error('live stream build failed', { error: errorMessage(err) });
      return;
    }
    if (content === null) {
      await finish(spec.goneReason?.() ?? 'not_found');
      return;
    }
    await sendContent(content);
  };

  function schedule(): void {
    if (pending || finished) return;
    const wait = Math.max(0, lastSentAt + limits.minIntervalMs - Date.now());
    pending = setTimeout(() => { void flush(); }, wait);
  }

  async function finish(reason: EndReason | null): Promise<void> {
    if (finished) return;
    finished = true;
    if (pending) clearTimeout(pending);
    for (const t of timers) clearInterval(t);
    unsubscribe();
    slot.release();
    let dropped = reason === 'slow_client';
    if (reason !== null && !dropped && !stream.aborted) {
      // A client that does not take the end message within a second is dropped.
      const sent = await Promise.race([
        stream.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`).then(() => true),
        new Promise<false>((r) => setTimeout(() => { r(false); }, 1000).unref()),
      ]);
      dropped = !sent;
    }
    if (dropped) {
      try {
        spec.drop();
      } catch (err) {
        log.warn('dropping a live stream connection failed', { error: errorMessage(err) });
      }
    }
    resolveDone();
  }

  const unsubscribe = hub.onChange((c) => {
    if (spec.relevant(c)) schedule();
  });
  slot.register({ end: (reason) => { void finish(reason); }, done });
  stream.onAbort(() => { void finish(null); });

  // Timers before the first write: finish() (abort, shutdown, slow client)
  // can run during it and must find them to clear them.
  timers.push(setInterval(() => {
    if (!writing && !finished) void write(': ping\n\n');
  }, limits.heartbeatS * 1000));
  const untilExpiry = Math.min(spec.expiresAt - Date.now(), 2 ** 31 - 1);
  timers.push(setTimeout(() => { void finish('token_expired'); }, Math.max(0, untilExpiry)));
  if (await write(`retry: ${limits.retryMs}\n\n`) && !isFinished()) await sendContent(first);
  await done;
}
