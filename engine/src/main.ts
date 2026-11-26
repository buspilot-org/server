/**
 * Entry point: configuration, database, cache, alert dispatcher, HTTP server
 * and the periodic jobs (cache and subscription reload, trip instance
 * creation, closing trips whose window passed).
 */
import { serve } from '@hono/node-server';
import { AlertDispatcher } from './alerts/dispatcher.ts';
import { FcmSender } from './alerts/fcm.ts';
import { loadConfig } from './config.ts';
import { Engine, systemClock } from './core/engine.ts';
import { createApp } from './http/app.ts';
import { TokenVerifier } from './live/auth.ts';
import { LiveHub } from './live/hub.ts';
import { StreamRegistry } from './live/streams.ts';
import { createLogger, errorMessage } from './log.ts';
import { PgStore } from './store/pg.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
const store = new PgStore(config.databaseUrl);
const alerts = config.push === null ? null : new AlertDispatcher({
  store,
  sender: new FcmSender({ serviceAccount: config.push.serviceAccount, projectId: config.push.projectId, targetField: config.push.targetField }),
  clock: systemClock,
  log,
  config: config.alerts,
});
if (alerts === null) log.warn('no FCM service account configured (FCM_SERVICE_ACCOUNT_FILE): arrival alerts are off');
// The live API is answered from memory: the engine's trips plus the live
// directory (names, schedule, access), reloaded on change (LISTEN) and every
// LIVE_RELOAD_SECONDS.
let engineRef: Engine | null = null;
const liveHub = new LiveHub({
  store,
  clock: systemClock,
  log,
  trips: () => engineRef?.trips ?? new Map(),
  staleAfterS: config.thresholds.staleAfterS,
});
const verifier = config.live.supabaseUrl === null ? null : new TokenVerifier({
  supabaseUrl: config.live.supabaseUrl,
  ...(config.live.jwtIssuer ? { issuer: config.live.jwtIssuer } : {}),
});
if (verifier === null) log.warn('SUPABASE_URL is not set: the live API for members (/v1/live) answers 503; public endpoints work');
const streams = new StreamRegistry(config.live.streams);
const engine = new Engine({ store, thresholds: config.thresholds, log, observers: [...(alerts ? [alerts] : []), liveHub] });
engineRef = engine;

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
      // Subscriptions first, so the first reload can already send cancellations.
      await alerts?.reloadSubscriptions();
      await engine.reload();
      await liveHub.reload();
      break;
    } catch (err) {
      log.error('startup failed, retrying in 10 s', { error: errorMessage(err) });
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

const app = createApp({
  engine, traccarSecret: config.traccarSecret, log, checkDatabase: () => store.ping(), ...(alerts ? { alertMetrics: () => alerts.metrics } : {}),
  live: { hub: liveHub, verifier, streams, log },
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info('listening', { port: info.port });
});

const timers: NodeJS.Timeout[] = [];
void verifier?.refresh().catch((err: unknown) => { log.warn('signing keys (JWKS) not loaded yet', { error: errorMessage(err) }); });
void start().then(async () => {
  try {
    await liveHub.listen();
  } catch (err) {
    log.error('LISTEN for live changes failed; relying on the periodic reload', { error: errorMessage(err) });
  }
  timers.push(
    every('live reload', config.live.reloadS, () => liveHub.reload()),
    every('cache reload', config.cacheReloadS, () => engine.reload()),
    every('trip instance creation', config.schedulerIntervalS, async () => {
      if (await createInstances() > 0) await engine.reload();
    }),
    every('tick', config.tickS, () => engine.tick()),
  );
  if (alerts) timers.push(every('subscription reload', config.subscriptionReloadS, () => alerts.reloadSubscriptions()));
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  for (const t of timers) clearInterval(t);
  // Open SSE streams keep the server from closing: end them first (clients
  // reconnect to the next engine).
  void streams.closeAll().then(() => liveHub.close()).then(() => {
    server.close(() => {
      // Let sends in progress finish (they are claimed already), then close.
      void (alerts?.idle() ?? Promise.resolve())
        .then(() => store.close())
        .finally(() => process.exit(0));
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
