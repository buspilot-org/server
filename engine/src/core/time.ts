/**
 * Service-day arithmetic. Times of day in the schedule are seconds since
 * "noon minus 12 h" of the service date in the operator's time zone, as in
 * GTFS (equal to midnight except on DST change days; Japan has none).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(instant: Date, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

/** Offset of the time zone from UTC at the instant, in ms (local − UTC). */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function parseDate(serviceDate: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate);
  if (!m) throw new Error(`invalid service date: ${serviceDate}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The instant from which a service date's times of day count. */
export function serviceDayStart(serviceDate: string, timeZone: string): Date {
  const [y, mo, d] = parseDate(serviceDate);
  const noonAsUtc = Date.UTC(y, mo - 1, d, 12);
  let noon = noonAsUtc - tzOffsetMs(new Date(noonAsUtc), timeZone);
  noon = noonAsUtc - tzOffsetMs(new Date(noon), timeZone);
  return new Date(noon - 12 * 3600 * 1000);
}

/** The instant of a time of day (seconds) on a service date. */
export function serviceTime(serviceDate: string, seconds: number, timeZone: string): Date {
  return new Date(serviceDayStart(serviceDate, timeZone).getTime() + seconds * 1000);
}

/** The local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  const pad = (n: number | undefined): string => String(n ?? 0).padStart(2, '0');
  return `${String(p.year ?? 0).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
}

export function addSeconds(t: Date, s: number): Date {
  return new Date(t.getTime() + s * 1000);
}

export function secondsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 1000;
}
