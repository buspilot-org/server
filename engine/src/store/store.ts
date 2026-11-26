/**
 * Persistence boundary. `PgStore` (pg.ts) is the real one; tests use an
 * in-memory store with the same semantics.
 */
import type { I18nText, StartedBy, StopState, TripKind, TripStatus, Writes } from '../core/types.ts';

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

/** A planned stop of a live trip (`trip_instance_stop` with the stop's location). */
export interface PlannedStopRow {
  sequence: number;
  lon: number;
  lat: number;
  plannedArrival: Date | null;
  plannedDeparture: Date | null;
}

export interface InstanceRow {
  id: string;
  operatorId: string;
  serviceDate: string;
  kind: TripKind;
  /** null for live trips. */
  tripId: string | null;
  /** null for a live trip without a pattern. */
  patternId: string | null;
  routeId: string | null;
  /** `trip.start_time`, seconds since the service day start; null for live trips. */
  startTimeS: number | null;
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
  /** Live trips: title, visible_until, created_at and planned stops (sorted by sequence; empty for scheduled trips). */
  title: I18nText | null;
  visibleUntil: Date | null;
  createdAt: Date;
  plannedStops: PlannedStopRow[];
}

export interface SnapshotRows {
  operators: OperatorRow[];
  vehicles: VehicleRow[];
  shapes: ShapeRow[];
  patterns: PatternRow[];
  patternStops: PatternStopRow[];
  instances: InstanceRow[];
}

export interface PersistResult {
  tripApplied: boolean;
}

export interface Store {
  /**
   * Everything the engine caches: active vehicles, shapes, patterns and the
   * scheduled and live trip instances (any status, so cancellations and
   * completions made elsewhere are seen) on service dates around `now`.
   */
  loadSnapshot(now: Date): Promise<SnapshotRows>;
  /**
   * Writes one position's (or tick's) changes in one transaction. Idempotent.
   * `tripApplied` is false if the trip row was not updated because another
   * vehicle runs the trip, or it is cancelled (true when there was no trip write).
   */
  persist(writes: Writes): Promise<PersistResult>;
  /** Creates trip instances and their stop events for today and tomorrow (operator-local). Returns the number created. */
  createTripInstances(now: Date): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
