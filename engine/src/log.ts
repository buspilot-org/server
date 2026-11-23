/**
 * Minimal JSON logger.
 *
 * Privacy rule (engine.md, "Security and privacy"): logs contain IDs and
 * states, never positions. Do not pass coordinates in `fields`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel, write: (line: string) => void = (line) => process.stdout.write(line + '\n')): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (order[lvl] < order[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
  };
  return {
    debug: (msg, fields) => { emit('debug', msg, fields); },
    info: (msg, fields) => { emit('info', msg, fields); },
    warn: (msg, fields) => { emit('warn', msg, fields); },
    error: (msg, fields) => { emit('error', msg, fields); },
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Message of an unknown error, for logs. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
