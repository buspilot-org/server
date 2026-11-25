/**
 * HTTP API:
 *
 * - `POST /v1/traccar/positions/:secret`: Traccar JSON forwarding. The secret
 *   is in the path because Traccar only sends `forward.header` with the
 *   global URL (engine.md, "Forwarding only Buspilot devices").
 * - `GET /healthz`
 *
 * Answers: 2xx once a position is processed and written, or dropped on
 * purpose (unknown device, duplicate, invalid); 401 for a wrong secret; 400
 * for a malformed payload; 503 while the cache is not loaded or a write
 * failed, so Traccar retries.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AlertMetrics } from '../alerts/dispatcher.ts';
import type { Engine } from '../core/engine.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import { PayloadError, parseTraccarPosition, traccarDeviceId } from '../traccar.ts';

/** Constant-time comparison (hashing first makes the lengths equal). */
export function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface AppDeps {
  engine: Engine;
  traccarSecret: string;
  log: Logger;
  /** Extra health checks, e.g. a database ping. */
  checkDatabase?: () => Promise<void>;
  /** Alert counters for /healthz (absent when push is not configured). */
  alertMetrics?: () => AlertMetrics;
}

export function createApp(deps: AppDeps): Hono {
  const { engine, log } = deps;
  const app = new Hono();

  app.post(
    '/v1/traccar/positions/:secret',
    bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload too large' }, 413) }),
    async (c) => {
      if (!secretMatches(c.req.param('secret'), deps.traccarSecret)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      if (!engine.loaded) return c.json({ error: 'not ready' }, 503);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid JSON' }, 400);
      }
      // Unknown devices are dropped before the position is even parsed.
      const deviceId = traccarDeviceId(body);
      if (deviceId === null) return c.json({ error: 'missing device' }, 400);
      if (!engine.vehicleForDevice(deviceId)) {
        engine.noteUnknownDevice();
        return c.json({ result: 'ignored' }, 202);
      }
      let position;
      try {
        position = parseTraccarPosition(body);
      } catch (err) {
        if (err instanceof PayloadError) return c.json({ error: err.message }, 400);
        throw err;
      }
      try {
        const outcome = await engine.handlePosition(position);
        return c.json({ result: outcome }, 200);
      } catch (err) {
        log.error('position processing failed', { error: errorMessage(err) });
        return c.json({ error: 'temporarily unavailable' }, 503);
      }
    },
  );

  app.get('/healthz', async (c) => {
    let database = 'ok';
    if (deps.checkDatabase) {
      try {
        await deps.checkDatabase();
      } catch {
        database = 'unreachable';
      }
    }
    const ok = engine.loaded && database === 'ok';
    // Public: counters about Buspilot vehicles only. Nothing about other
    // devices on the shared Traccar server (no unknown-device count).
    const m = engine.metrics;
    return c.json({
      status: ok ? 'ok' : 'degraded',
      cacheLoaded: engine.loaded,
      database,
      staleTrips: engine.staleTrips().length,
      metrics: {
        positionsProcessed: m.positionsProcessed,
        positionsDuplicate: m.positionsDuplicate,
        positionsInvalid: m.positionsInvalid,
        positionsFailed: m.positionsFailed,
        lastReloadAt: m.lastReloadAt,
      },
      // null: no FCM service account configured, alerts are off.
      alerts: deps.alertMetrics ? deps.alertMetrics() : null,
    }, ok ? 200 : 503);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    log.error('unhandled error', { error: errorMessage(err) });
    return c.json({ error: 'internal error' }, 500);
  });
  return app;
}
