/**
 * Traccar JSON position forwarding (`forward.type = json`).
 *
 * Traccar posts a `PositionData` object (org.traccar.forward.PositionData,
 * checked against Traccar master 2026-11-23): `{"position": Position,
 * "device": Device}`, serialised by Jackson with dates as ISO 8601 strings
 * and null fields left out. Relevant fields:
 *
 * - position: id, deviceId, fixTime, deviceTime, serverTime, valid, latitude,
 *   longitude, speed (knots), course (degrees), accuracy (m), attributes
 * - device: id, uniqueId (the identifier configured on the tracker), name
 */
import type { PositionInput } from './core/types.ts';

const KNOTS_TO_KMH = 1.852;

export class PayloadError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The device identifier only, so unknown devices can be dropped before anything else is read. */
export function traccarDeviceId(body: unknown): string | null {
  if (!isObject(body) || !isObject(body.device)) return null;
  const id = body.device.uniqueId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Parses a forwarded position. Throws PayloadError on a malformed payload (without echoing values). */
export function parseTraccarPosition(body: unknown): PositionInput {
  const deviceId = traccarDeviceId(body);
  if (deviceId === null || !isObject(body) || !isObject(body.position)) throw new PayloadError('missing device or position');
  const pos = body.position;
  const lat = finite(pos.latitude);
  const lon = finite(pos.longitude);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new PayloadError('invalid coordinates');
  }
  const timeRaw = pos.fixTime ?? pos.deviceTime;
  const fixTime = typeof timeRaw === 'string' || typeof timeRaw === 'number' ? new Date(timeRaw) : null;
  if (fixTime === null || Number.isNaN(fixTime.getTime())) throw new PayloadError('invalid fix time');
  const speedKnots = finite(pos.speed) ?? 0;
  const course = finite(pos.course);
  const accuracy = finite(pos.accuracy);
  const id = finite(pos.id);
  return {
    deviceId,
    positionId: id !== null && id > 0 ? id : null,
    fixTime,
    lat,
    lon,
    speedKmh: Math.max(0, speedKnots * KNOTS_TO_KMH),
    course: course === null ? null : ((course % 360) + 360) % 360,
    accuracyM: accuracy !== null && accuracy > 0 ? accuracy : null,
    valid: pos.valid !== false,
  };
}
