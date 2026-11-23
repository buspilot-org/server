/**
 * Persistence boundary. `PgStore` (pg.ts) is the real one; tests use an
 * in-memory store with the same semantics.
 */
import type { StartedBy, StopState, TripStatus, Writes } from '../core/types.ts';

export interface OperatorRow {
  id: string;
  timezone: string;
}

export interface VehicleRow {
  id: string;
  operatorId: string;
  deviceId: string;
  /** `vehicle_state.recorded_at`: the last position written, for deduplication after a restart. */
  lastFixAt: Date | null;
}

export interface ShapeRow {
  id: string;
  operatorId: string;
  /** [lon, lat] pairs. */
  coordinates: [number, number][];
  /** Geodesic length (PostGIS `ST_Length` on geography), metres. */
  lengthM: number;
}

export interface PatternRow {
  id: string;
  operatorId: string;
  routeId: string;
  shapeId: string | null;
}

export interface PatternStopRow {
  patternId: string;
  sequence: number;
  lon: number;
  lat: number;
  distAlongShape: number | null;
  arrivalOffsetS: number;
  departureOffsetS: number;
}

export interface StopEventRow {
  sequence: number;
  state: StopState;
  arrivedAt: Date | null;
  departedAt: Date | null;
  passedAt: Date | null;
  eta: Date | null;
}

export interface InstanceRow {
  id: string;
  operatorId: string;
  serviceDate: string;
  tripId: string;
  patternId: string;
  /** `trip.start_time`, seconds since the service day start. */
  startTimeS: number;
  /** Vehicle that runs (or ran) this instance: set when it starts, or by staff for one day. */
  vehicleId: string | null;
  /** The trip's default vehicle (`trip.vehicle_id`), used while the instance has none. */
  defaultVehicleId: string | null;
  status: TripStatus;
  startedBy: StartedBy;
  progressM: number;
  progressAt: Date | null;
  lastConfirmedStopSequence: number | null;
  offRouteSince: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  stopEvents: StopEventRow[];
}

export interface SnapshotRows {
  operators: OperatorRow[];
  vehicles: VehicleRow[];
  shapes: ShapeRow[];
  patterns: PatternRow[];
  patternStops: PatternStopRow[];
  instances: InstanceRow[];
}

export interface Store {
  /**
   * Everything the engine caches: active vehicles, shapes, patterns and the
   * scheduled trip instances (any status, so cancellations and completions
   * made elsewhere are seen) on service dates around `now`.
   */
  loadSnapshot(now: Date): Promise<SnapshotRows>;
  /** Writes one position's (or tick's) changes in one transaction. Idempotent. */
  persist(writes: Writes): Promise<void>;
  /** Creates trip instances and their stop events for today and tomorrow (operator-local). Returns the number created. */
  createTripInstances(now: Date): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
