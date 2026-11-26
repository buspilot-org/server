import type { LocalPlane, Polyline, XY } from '../geo/plane.ts';

export type StopState = 'upcoming' | 'approaching' | 'arrived' | 'departed' | 'passed';
export type TripStatus = 'planned' | 'active' | 'completed' | 'cancelled';
export type StartedBy = 'schedule' | 'driver';
export type TripKind = 'scheduled' | 'live';

/** Translatable text as stored in the database: language tag → string. */
export type I18nText = Record<string, string>;

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

/** A planned stop of a live trip without a pattern (`trip_instance_stop`). */
export interface ItineraryStop {
  sequence: number;
  /** Stop position in the operator's plane. */
  point: XY;
  /** The stop's location (the plane can change between reloads). */
  lon: number;
  lat: number;
  plannedArrival: Date | null;
  plannedDeparture: Date | null;
  /** Straight-line distance from the first planned stop through all stops before (m): progress_m of a trip without a shape. */
  distM: number;
}

/** The planned stops of a live trip without a pattern, sorted by sequence (a tour itinerary). */
export interface Itinerary {
  stops: readonly ItineraryStop[];
}

/**
 * The static part of a trip instance (from the schedule, or a live trip as
 * staff saved it). How the engine follows it:
 * - `pattern` set (scheduled trips, live trips on a pattern): the shape;
 * - else `itinerary` set (live trip with planned stops): the planned stops
 *   in order (itinerary.ts);
 * - neither (live trip without route or stops): position only.
 */
export interface TripInstance {
  id: string;
  operatorId: string;
  serviceDate: string;
  kind: TripKind;
  /** null for live trips. */
  tripId: string | null;
  routeId: string | null;
  pattern: Pattern | null;
  itinerary: Itinerary | null;
  /** Live trips: the title riders see. */
  title: I18nText | null;
  /** Live trips: riders see the trip (and get alerts) until then; the engine stops following it then. */
  visibleUntil: Date | null;
  /**
   * Scheduled trips: the scheduled start. Live trips: when the trip may
   * start: the first planned stop's time if it has one (`timedStart`), else
   * when it was saved (not before its service day).
   */
  startAt: Date;
  /**
   * Scheduled trips: the scheduled arrival at the last stop. Live trips: the
   * last planned stop's time if it has one (`timedEnd`), else the end of the
   * service day.
   */
  endAt: Date;
  /** Live trips: startAt is the first planned stop's time. */
  timedStart: boolean;
  /** Live trips: endAt is the last planned stop's time. */
  timedEnd: boolean;
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
  /** Fixes of the confirmation with the bus moving along the new section. */
  moving: number;
  at: Date;
  /** The held fixes, replayed into the stop state machine once confirmed (a stop dwell during the hold). */
  held: HeldFix[];
}

export interface HeldFix {
  m: number;
  speedKmh: number;
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
  /** Where that position was (operator plane), for the direction of movement. */
  lastFixXY: XY | null;
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
  /** Consecutive fixes away from the final stop after reaching it (itinerary: from the stop the bus is at). */
  finalLeaveCount: number;
  stops: StopProgress[];
  /** Live trips without a pattern: matching state along the planned stops (itinerary.ts). */
  itinerary: ItineraryProgress | null;
}

/** Order-aware matching state of a trip that follows planned stops (no shape). */
export interface ItineraryProgress {
  /** The next stop (sequence) the bus has come near without stopping; null: none. */
  touchedSeq: number | null;
  /** When the bus was last near that stop (its `passed_at` if it drives on). */
  touchedAt: Date | null;
  /** The bus has been slow near this later stop since `since` (a skip being confirmed). */
  dwell: { sequence: number; since: Date } | null;
}

export interface TripRuntime {
  instance: TripInstance;
  /** Vehicle from the schedule (null = any vehicle of the operator). Live trips: the vehicle staff set. */
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
  /**
   * A running live trip of this vehicle to put back to `planned` (a due
   * scheduled trip takes over, assigner.ts rule 5): no progress, no ETAs.
   * Applied first, only while it has reached no stop.
   */
  release: string | null;
  vehicleState: VehicleStateWrite | null;
  trip: TripWrite | null;
  stopEvents: StopEventWrite[];
  etas: EtaWrite[];
}

export function isEmpty(w: Writes): boolean {
  return w.release === null && w.vehicleState === null && w.trip === null && w.stopEvents.length === 0 && w.etas.length === 0;
}
