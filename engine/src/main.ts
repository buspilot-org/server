/**
 * Entry point: configuration, database, cache, HTTP server and the periodic
 * jobs (cache reload, trip instance creation, closing trips whose window
 * passed).
 */
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { Engine } from './core/engine.ts';
import { createApp } from './http/app.ts';
import { createLogger, errorMessage } from './log.ts';
import { PgStore } from './store/pg.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
const store = new PgStore(config.databaseUrl);
const engine = new Engine({ store, thresholds: config.thresholds, log });

async function createInstances(): Promise<number> {
  const created = await store.createTripInstances(new Date());
  if (created > 0) log.info('trip instances created', { count: created });
  return created;
}

/** Runs a job every `seconds`, never overlapping itself; failures are logged and retried next time. */
function every(name: string, seconds: number, job: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    job()
      .catch((err: unknown) => { log.error(`${name} failed`, { error: errorMessage(err) }); })
      .finally(() => { running = false; });
  }, seconds * 1000);
}

async function start(): Promise<void> {
  // Retry until the database is reachable; /healthz reports "degraded" meanwhile.
  for (;;) {
    try {
      await createInstances();
      await engine.reload();
      break;
    } catch (err) {
      log.error('startup failed, retrying in 10 s', { error: errorMessage(err) });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

const app = createApp({ engine, traccarSecret: config.traccarSecret, log, checkDatabase: () => store.ping() });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info('listening', { port: info.port });
});

const timers: NodeJS.Timeout[] = [];
void start().then(() => {
  timers.push(
    every('cache reload', config.cacheReloadS, () => engine.reload()),
    every('trip instance creation', config.schedulerIntervalS, async () => {
      if (await createInstances() > 0) await engine.reload();
    }),
    every('tick', config.tickS, () => engine.tick()),
  );
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  for (const t of timers) clearInterval(t);
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
