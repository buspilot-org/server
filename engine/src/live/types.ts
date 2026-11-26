/**
 * What the live API keeps in memory besides the engine's trip state: the
 * names and slugs of operators, routes and stops, the schedule needed for
 * scheduled times, the trip instances around today (also live trips, which
 * the engine does not follow yet), and everything access is decided from.
 * Loaded from the database (LiveStore) on change and every minute.
 */
import type { I18nText } from '../alerts/types.ts';
import type { StopState, TripStatus } from '../core/types.ts';
import type { StopEventRow } from '../store/store.ts';

export type Visibility = 'public' | 'invited_map' | 'invited_eta';
export type StaffRole = 'owner' | 'editor' | 'driver';

/** Access level, as private.route_access returns it: 0 none, 1 arrival times only, 2 map, 3 staff. */
export type Level = 0 | 1 | 2 | 3;

export interface LiveOperatorRow {
  id: string;
  slug: string;
  name: I18nText;
  timezone: string;
  defaultVisibility: Visibility;
}

export interface LiveRouteRow {
  id: string;
  operatorId: string;
  slug: string | null;
  name: I18nText;
  shortName: string | null;
  color: string | null;
  textColor: string | null;
  /** null = operator default. */
  visibility: Visibility | null;
  active: boolean;
}

export interface LiveStopRow {
  id: string;
  operatorId: string;
  slug: string | null;
  name: I18nText;
  lon: number;
  lat: number;
}

export interface LivePatternRow {
  id: string;
  operatorId: string;
  routeId: string;
}

export interface LivePatternStopRow {
  patternId: string;
  sequence: number;
  stopId: string;
  arrivalOffsetS: number;
  departureOffsetS: number;
}

export interface LiveTripRow {
  id: string;
  patternId: string;
  startTimeS: number;
  headsign: I18nText | null;
  /** Default vehicle (`trip.vehicle_id`), for drivers' access. */
  vehicleId: string | null;
}

export interface PlannedStopRow {
  sequence: number;
  stopId: string;
  plannedArrival: Date | null;
  plannedDeparture: Date | null;
}

export interface LiveInstanceRow {
  id: string;
  operatorId: string;
  kind: 'scheduled' | 'live';
  tripId: string | null;
  patternId: string | null;
  routeId: string | null;
  serviceDate: string;
  status: TripStatus;
  vehicleId: string | null;
  visibleUntil: Date | null;
  title: I18nText | null;
  startedAt: Date | null;
  endedAt: Date | null;
  offRouteSince: Date | null;
  stopEvents: StopEventRow[];
  /** Planned stops of a live trip without a pattern (trip_instance_stop). */
  plannedStops: PlannedStopRow[];
}

export interface LiveSnapshot {
  /** Database time the snapshot was taken. */
  loadedAt: Date;
  operators: LiveOperatorRow[];
  routes: LiveRouteRow[];
  stops: LiveStopRow[];
  patterns: LivePatternRow[];
  patternStops: LivePatternStopRow[];
  trips: LiveTripRow[];
  instances: LiveInstanceRow[];
  staffRoles: { operatorId: string; userId: string; role: StaffRole }[];
  driverVehicles: { operatorId: string; userId: string; vehicleId: string }[];
  /** Active memberships only (revoked_at is null). */
  memberships: { deviceId: string; audienceId: string }[];
  audienceRoutes: { audienceId: string; routeId: string; canSeeMap: boolean }[];
  tripAudiences: { tripInstanceId: string; audienceId: string; canSeeMap: boolean }[];
  /** Subscriptions with their stop resolved (pattern stop or planned stop). */
  subscriptions: { deviceId: string; stopId: string; patternId: string | null; tripInstanceId: string | null }[];
  /** private.followed_stop_log: the first two stops per device and operator (by log order). */
  followedStops: { deviceId: string; operatorId: string; stopId: string }[];
}

/** The latest fix of a vehicle, as processed by the engine. Never written to logs. */
export interface VehicleFix {
  vehicleId: string;
  operatorId: string;
  /** The active trip the engine linked this fix to (as vehicle_state.trip_instance_id). */
  tripInstanceId: string | null;
  lon: number;
  lat: number;
  speedKmh: number;
  heading: number | null;
  accuracyM: number | null;
  at: Date;
}

/**
 * Parts of the snapshot, reloaded separately after a change notification:
 * schedule (names, slugs, patterns, trips), access (staff, drivers,
 * memberships, audiences), trips (trip instances with stop events and planned
 * stops), follows (subscriptions and the followed-stop log; only reloaded
 * periodically, see the migration).
 */
export type LivePart = 'schedule' | 'access' | 'trips' | 'follows';
export const LIVE_PARTS: readonly LivePart[] = ['schedule', 'access', 'trips', 'follows'];

/** Which part a notifying table belongs to (payload of buspilot_live). Unknown tables reload everything. */
export const PART_OF_TABLE: Readonly<Record<string, LivePart>> = {
  operator: 'schedule', route: 'schedule', stop: 'schedule', trip_pattern: 'schedule', pattern_stop: 'schedule', trip: 'schedule',
  staff_role: 'access', driver_vehicle: 'access', membership: 'access', audience_route: 'access', trip_instance_audience: 'access',
  trip_instance: 'trips', trip_instance_stop: 'trips',
};

/** A loaded snapshot part: `loadedAt` plus the fields of the parts asked for. */
export type LiveSnapshotPart = Pick<LiveSnapshot, 'loadedAt'> & Partial<Omit<LiveSnapshot, 'loadedAt'>>;

export interface LiveStore {
  /** Loads the given parts (default: all). */
  loadLiveSnapshot(parts?: readonly LivePart[]): Promise<LiveSnapshotPart>;
  /** Calls `onChange(table)` when the database notifies a change (channel buspilot_live). Resolves to an unlisten function. */
  listenLiveChanges(onChange: (table: string) => void, onReconnect: () => void): Promise<() => Promise<void>>;
}

export type { StopState, TripStatus };
