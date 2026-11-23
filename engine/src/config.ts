/**
 * Engine configuration. Thresholds come from internal/concept/engine.md and
 * arrival-alerts.md; every value marked "assumption" there still needs
 * checking against real tracks from the pilot.
 *
 * All thresholds are global for now. Per-operator overrides (kindergarten vs.
 * hotel shuttle) are an open question in engine.md.
 */
export interface Thresholds {
  /** Trip window opens this long before the scheduled start (s). */
  tripWindowBeforeS: number;
  /** Trip window closes this long after the scheduled end (s). */
  tripWindowAfterS: number;

  /** Search window behind the current progress, for GPS jitter (m). */
  windowBehindM: number;
  /** Search window ahead of the current progress (m), at least. */
  windowAheadM: number;
  /** The window ahead also grows with time since the last accepted fix × this speed (m/s). */
  windowMaxSpeedMps: number;

  /** Distance to the route line that counts as on route (m). */
  onRouteM: number;
  /** Distance to the route line that counts as away from the route (m). */
  offRouteM: number;
  /** Away from the route for longer than this → off route (s). */
  offRouteAfterS: number;
  /** Consecutive on-route fixes needed to leave the off-route state. */
  backOnRouteFixes: number;

  /** A forward move larger than this is a jump (m)… */
  jumpM: number;
  /** …unless the time since the previous fix at this speed covers it (km/h), e.g. a tracker reporting every minute. */
  jumpSpeedKmh: number;
  /** Consistent fixes needed before a jump is accepted. */
  jumpConfirmFixes: number;
  /** A confirmation must cover at least this distance along the route (m): a standing bus confirms nothing. */
  jumpConfirmMinAdvanceM: number;
  /** Above this speed the GPS course must match the direction of the route (km/h)… */
  headingCheckMinSpeedKmh: number;
  /** …within this angle (degrees). Tells apart the two directions of a street served twice. */
  headingToleranceDeg: number;
  /** Two candidates whose distance ahead differs by less than this are a tie, broken by the schedule (m). */
  tieMarginM: number;

  /** Automatic trip start: the bus must be within this progress from the start of the route (m). */
  autoStartMaxProgressM: number;
  /** Automatic trip start: within this distance of the first stop counts as "at the first stop" (m). */
  autoStartFirstStopM: number;
  /** Automatic trip start: consecutive fixes moving in route direction… */
  autoStartConfirmFixes: number;
  /** …covering at least this distance along the route (m). A parked bus never starts a trip. */
  autoStartMinAdvanceM: number;

  /** Arrived: within this distance of the stop, measured along the route (m). */
  arrivedRadiusM: number;
  /** Arrived: slower than this (km/h). */
  arrivedMaxSpeedKmh: number;
  /** Departed: progress beyond the stop by more than this (m). */
  departedMarginM: number;
  /** Passed without stopping: progress beyond the stop by more than this (m). */
  passedMarginM: number;
  /** Final stop at the end of the shape: the bus has left it when it is this far from the stop (m)… */
  finalLeaveM: number;
  /** …for this many consecutive fixes (GPS multipath while parked). */
  finalLeaveFixes: number;

  /** No position for longer than this during a trip → stale (s). */
  staleAfterS: number;

  /** ETA lower bound: the remaining distance at this speed (km/h). */
  etaMaxSpeedKmh: number;
  /** Only write an ETA when it moved by at least this much (s). */
  etaWriteThresholdS: number;

  /** Fixes more than this far in the future are dropped (s). */
  maxFutureFixS: number;
}

export const defaultThresholds: Thresholds = {
  tripWindowBeforeS: 15 * 60,
  tripWindowAfterS: 30 * 60,
  windowBehindM: 30,
  windowAheadM: 1500,
  windowMaxSpeedMps: 25,
  onRouteM: 50,
  offRouteM: 100,
  offRouteAfterS: 60,
  backOnRouteFixes: 3,
  jumpM: 500,
  jumpSpeedKmh: 50,
  jumpConfirmFixes: 3,
  jumpConfirmMinAdvanceM: 20,
  headingCheckMinSpeedKmh: 10,
  headingToleranceDeg: 90,
  tieMarginM: 100,
  autoStartMaxProgressM: 1000,
  autoStartFirstStopM: 50,
  autoStartConfirmFixes: 2,
  autoStartMinAdvanceM: 30,
  arrivedRadiusM: 30,
  arrivedMaxSpeedKmh: 5,
  departedMarginM: 20,
  passedMarginM: 50,
  finalLeaveM: 50,
  finalLeaveFixes: 2,
  staleAfterS: 120,
  etaMaxSpeedKmh: 60,
  etaWriteThresholdS: 30,
  maxFutureFixS: 300,
};

export interface AppConfig {
  databaseUrl: string;
  traccarSecret: string;
  port: number;
  host: string;
  cacheReloadS: number;
  schedulerIntervalS: number;
  tickS: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  thresholds: Thresholds;
}

const MIN_SECRET_LENGTH = 32;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Reads the configuration from the environment. Throws on missing or invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL ?? '';
  if (databaseUrl === '') throw new Error('DATABASE_URL is required');
  const traccarSecret = env.TRACCAR_FORWARD_SECRET ?? '';
  if (traccarSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`TRACCAR_FORWARD_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(traccarSecret)) {
    throw new Error('TRACCAR_FORWARD_SECRET may only contain letters, digits, "-" and "_" (it is part of a URL path)');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (logLevel !== 'debug' && logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
    throw new Error('LOG_LEVEL must be debug, info, warn or error');
  }
  return {
    databaseUrl,
    traccarSecret,
    port: int(env, 'PORT', 8080),
    host: env.HOST ?? '0.0.0.0',
    cacheReloadS: int(env, 'CACHE_RELOAD_SECONDS', 300),
    schedulerIntervalS: int(env, 'SCHEDULER_INTERVAL_SECONDS', 3600),
    tickS: int(env, 'TICK_SECONDS', 30),
    logLevel,
    thresholds: { ...defaultThresholds },
  };
}
