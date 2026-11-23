import type { LocalPlane, Polyline, XY } from '../geo/plane.ts';

export type StopState = 'upcoming' | 'approaching' | 'arrived' | 'departed' | 'passed';
export type TripStatus = 'planned' | 'active' | 'completed' | 'cancelled';
export type StartedBy = 'schedule' | 'driver';

/** Order of `stop_event_state` in the database enum. States only move forward. */
export const stopStateRank: Record<StopState, number> = {
  upcoming: 0,
  approaching: 1,
  arrived: 2,
  departed: 3,
  passed: 4,
};

export function isFinalStopState(s: StopState): boolean {
  return s === 'departed' || s === 'passed';
}

export interface Operator {
  id: string;
  timezone: string;
  plane: LocalPlane;
}

export interface Vehicle {
  id: string;
  operatorId: string;
  /** Traccar `uniqueId`. */
  deviceId: string;
}

export interface PatternStop {
  sequence: number;
  /** Distance along the shape (m). */
  distM: number;
  /** Seconds from trip start. */
  arrivalOffsetS: number;
  departureOffsetS: number;
  /** Stop position in the operator's plane. */
  point: XY;
}

export interface Pattern {
  id: string;
  operatorId: string;
  routeId: string;
  shape: Polyline;
  /** Sorted by sequence, distM non-decreasing. */
  stops: readonly PatternStop[];
}

/** The static part of a trip instance (from the schedule). */
export interface TripInstance {
  id: string;
  operatorId: string;
  serviceDate: string;
  tripId: string;
  pattern: Pattern;
  /** Scheduled start (instant). */
  startAt: Date;
  /** Scheduled arrival at the last stop. */
  endAt: Date;
}

export interface StopProgress {
  sequence: number;
  state: StopState;
  arrivedAt: Date | null;
  departedAt: Date | null;
  passedAt: Date | null;
  /** Last ETA written to the database. */
  eta: Date | null;
}

export interface PendingJump {
  /** Position of the first fix of the confirmation. */
  firstM: number;
  m: number;
  count: number;
  at: Date;
}

/** The changing part of a trip instance. Copied, changed and only kept once persisted. */
export interface TripProgress {
  status: TripStatus;
  vehicleId: string | null;
  startedBy: StartedBy;
  startedAt: Date | null;
  endedAt: Date | null;
  progressM: number;
  /** Fix time of the last accepted progress. */
  progressAt: Date | null;
  /** Fix time of the last position received during the trip (accepted or not). */
  lastFixAt: Date | null;
  lastConfirmedStopSequence: number | null;
  /** Since when the bus has been more than offRouteM from the route (not yet off route). */
  awaySince: Date | null;
  /** Set while off route. */
  offRouteSince: Date | null;
  /**
   * A position not yet accepted: a large jump forward, or the first fixes
   * back on the route after being off route. Accepted after enough
   * consistent fixes.
   */
  pendingJump: PendingJump | null;
  /** The bus came within arrivedRadiusM of the final stop. */
  reachedFinalStop: boolean;
  /** Consecutive fixes away from the final stop after reaching it. */
  finalLeaveCount: number;
  stops: StopProgress[];
}

export interface TripRuntime {
  instance: TripInstance;
  /** Vehicle from the schedule (null = any vehicle of the operator). */
  scheduledVehicleId: string | null;
  progress: TripProgress;
}

/** A position, after parsing Traccar's payload. */
export interface PositionInput {
  deviceId: string;
  /** Traccar position ID, if Traccar stored the position before forwarding. */
  positionId: number | null;
  fixTime: Date;
  lon: number;
  lat: number;
  speedKmh: number;
  /** Degrees clockwise from north, 0 ≤ course < 360, or null. */
  course: number | null;
  accuracyM: number | null;
  valid: boolean;
}

// --- Writes --------------------------------------------------------------

export interface VehicleStateWrite {
  vehicleId: string;
  operatorId: string;
  tripInstanceId: string | null;
  lon: number;
  lat: number;
  speedKmh: number;
  heading: number | null;
  accuracyM: number | null;
  recordedAt: Date;
}

export interface TripWrite {
  id: string;
  status: TripStatus;
  vehicleId: string | null;
  startedBy: StartedBy;
  progressM: number;
  progressAt: Date | null;
  lastConfirmedStopSequence: number | null;
  offRouteSince: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface StopEventWrite {
  tripInstanceId: string;
  sequence: number;
  state: StopState;
  arrivedAt: Date | null;
  departedAt: Date | null;
  passedAt: Date | null;
}

export interface EtaWrite {
  tripInstanceId: string;
  sequence: number;
  eta: Date;
}

/** Everything one position (or one tick) changes; written in one transaction. */
export interface Writes {
  /**
   * The vehicle these changes come from. Trip, stop event and ETA writes only
   * apply to a trip instance this vehicle runs (or that no vehicle runs yet).
   */
  vehicleId: string;
  vehicleState: VehicleStateWrite | null;
  trip: TripWrite | null;
  stopEvents: StopEventWrite[];
  etas: EtaWrite[];
}

export function isEmpty(w: Writes): boolean {
  return w.vehicleState === null && w.trip === null && w.stopEvents.length === 0 && w.etas.length === 0;
}
