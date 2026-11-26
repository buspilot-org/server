/**
 * ETA v1 (engine.md, "ETA"): scheduled offsets shifted by the current delay.
 *
 * delay = now − scheduled time at the current progress (interpolated between
 * stops); ETA(stop) = scheduled arrival + delay, but never earlier than now
 * plus the remaining distance at etaMaxSpeedKmh (the shortest plausible
 * travel time). While the bus stands at a stop (before it has left the first
 * stop, or arrived at a later one) it is expected to wait for the scheduled
 * departure: waiting on time is no delay, and an early bus does not make
 * ETAs early.
 */
import type { Thresholds } from '../config.ts';
import { addSeconds, secondsBetween } from './time.ts';
import type { PatternStop, StopProgress, TripInstance } from './types.ts';

/** Scheduled time (seconds from trip start) at a distance along the route. */
export function scheduledOffsetAt(stops: readonly PatternStop[], m: number): number {
  const first = stops[0];
  if (first === undefined) return 0;
  if (m <= first.distM) return first.departureOffsetS;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a === undefined || b === undefined) continue;
    if (m <= b.distM) {
      if (b.distM <= a.distM) return a.departureOffsetS;
      const f = (m - a.distM) / (b.distM - a.distM);
      return a.departureOffsetS + f * (b.arrivalOffsetS - a.departureOffsetS);
    }
  }
  return stops[stops.length - 1]?.arrivalOffsetS ?? 0;
}

/** Expected progress at a time, from the schedule (the inverse of scheduledOffsetAt). */
export function expectedProgressAt(inst: TripInstance, at: Date): number {
  const stops = inst.pattern?.stops ?? [];
  const s = secondsBetween(inst.startAt, at);
  const first = stops[0];
  if (first === undefined) return 0;
  if (s <= first.departureOffsetS) return first.distM;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (a === undefined || b === undefined) continue;
    if (s <= b.arrivalOffsetS) {
      const span = b.arrivalOffsetS - a.departureOffsetS;
      if (span <= 0) return b.distM;
      return a.distM + ((s - a.departureOffsetS) / span) * (b.distM - a.distM);
    }
    if (s <= b.departureOffsetS) return b.distM;
  }
  return stops[stops.length - 1]?.distM ?? 0;
}

/** ETAs for stops that are still ahead (upcoming or approaching). */
export function computeEtas(
  inst: TripInstance,
  stops: readonly StopProgress[],
  progressM: number,
  now: Date,
  t: Thresholds,
): Map<number, Date> {
  const pstops = inst.pattern?.stops ?? [];
  let delayS = secondsBetween(addSeconds(inst.startAt, scheduledOffsetAt(pstops, progressM)), now);
  const dwelling = [...stops].reverse().find((s) => s.state === 'arrived');
  const dwellStop = dwelling ? pstops.find((p) => p.sequence === dwelling.sequence) : undefined;
  const firstSeq = pstops[0]?.sequence;
  const firstStop = stops.find((s) => s.sequence === firstSeq);
  if (dwellStop) {
    delayS = Math.max(0, secondsBetween(addSeconds(inst.startAt, dwellStop.departureOffsetS), now));
  } else if (firstStop && (firstStop.state === 'upcoming' || firstStop.state === 'approaching')) {
    delayS = Math.max(0, delayS);
  }
  const maxSpeedMps = t.etaMaxSpeedKmh / 3.6;
  const out = new Map<number, Date>();
  for (const s of stops) {
    if (s.state !== 'upcoming' && s.state !== 'approaching') continue;
    const ps = pstops.find((p) => p.sequence === s.sequence);
    if (ps === undefined) continue;
    const scheduled = addSeconds(inst.startAt, ps.arrivalOffsetS + delayS);
    const earliest = addSeconds(now, Math.max(0, ps.distM - progressM) / maxSpeedMps);
    out.set(s.sequence, scheduled > earliest ? scheduled : earliest);
  }
  return out;
}
