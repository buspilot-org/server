/**
 * The JSON the live API returns (format version 1, documented in the
 * README, "Live API"). Built from memory on every request: the directory
 * (names, schedule, access), the engine's trip state and the latest vehicle
 * fixes.
 *
 * Privacy rules (engine.md "Live API", privacy-and-access.md):
 * - nothing the viewer may not see: routes, trips and stops by the same
 *   rules as the database's RLS (access.ts);
 * - the bus position only at map level, only while the trip is active, the
 *   bus on route and its position fresh, and only from the trip the engine
 *   linked the fix to;
 * - stop locations only where public.stop_location would return them;
 * - never history: only the current state and the times of today's stop
 *   events.
 */
import type { I18nText } from '../alerts/types.ts';
import { localDate, serviceTime } from '../core/time.ts';
import type { StopState, TripRuntime, TripStatus } from '../core/types.ts';
import type { StopEventRow } from '../store/store.ts';
import type { Directory, PlannedVisit } from './directory.ts';
import type { Level, LiveInstanceRow, LiveRouteRow, LiveStopRow, VehicleFix } from './types.ts';

export const FORMAT_VERSION = 1;

/** At most this many visits in a stop view. */
export const MAX_STOP_VISITS = 50;

export interface Viewer {
  /** auth.uid() of a signed-in user; null for visitors (public endpoints). */
  uid: string | null;
}

export interface ViewContext {
  dir: Directory;
  /** The engine's state of a scheduled trip it follows. */
  runtime(tripInstanceId: string): TripRuntime | undefined;
  /** The latest processed fix of a vehicle. */
  fix(vehicleId: string): VehicleFix | undefined;
  now: Date;
  staleAfterS: number;
}

export type AccessName = 'eta' | 'map';

export interface RouteRef {
  id: string;
  slug: string | null;
  name: I18nText;
  shortName: string | null;
  color: string | null;
  textColor: string | null;
}

export interface OperatorRef {
  id: string;
  slug: string;
  name: I18nText;
}

export interface StopRef {
  id: string;
  slug: string | null;
  name: I18nText;
  /** [lon, lat], only if the viewer may see this stop on a map. */
  location: [number, number] | null;
}

export interface StopVisitView {
  sequence: number;
  stop: StopRef;
  state: StopState;
  /** From the schedule (scheduled trips) or the plan (live trips). */
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  /** Expected arrival while the bus has not reached the stop and the trip is active. */
  eta: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  passedAt: string | null;
}

export interface VehicleView {
  lon: number;
  lat: number;
  /** Degrees clockwise from north, or null. */
  heading: number | null;
  speedKmh: number;
  accuracyM: number | null;
  recordedAt: string;
}

export interface TripView {
  id: string;
  kind: 'scheduled' | 'live';
  status: TripStatus;
  serviceDate: string;
  routeId: string | null;
  access: AccessName;
  /** Headsign (scheduled trips) or title (live trips). */
  headsign: I18nText | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The engine follows this trip (scheduled trips today; live trips later): stop states, ETAs and position are live. */
  tracked: boolean;
  /** Active and more than `staleAfterS` without a position: ETAs are uncertain, no position. */
  stale: boolean;
  /** Time of the vehicle's latest position (active tracked trips), without the position itself. */
  lastSeenAt: string | null;
  /** Active and off route: no position, ETAs held. */
  offRoute: boolean;
  /** ETA − scheduled arrival at the next stop (s), active trips only. */
  delayS: number | null;
  /** Map level, active, on route and fresh only; otherwise null. */
  vehicle: VehicleView | null;
  stops: StopVisitView[];
}

export interface RouteView {
  v: number;
  generatedAt: string;
  operator: OperatorRef;
  route: RouteRef;
  access: AccessName;
  /** Today's trips (operator time zone) and active ones, by start. */
  trips: TripView[];
}

export interface TripOnlyView {
  v: number;
  generatedAt: string;
  operator: OperatorRef;
  route: RouteRef | null;
  trip: TripView;
}

export interface StopArrivalView {
  tripInstanceId: string;
  kind: 'scheduled' | 'live';
  tripStatus: TripStatus;
  routeId: string | null;
  headsign: I18nText | null;
  sequence: number;
  state: StopState;
  scheduledArrival: string | null;
  scheduledDeparture: string | null;
  eta: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  passedAt: string | null;
  tracked: boolean;
  stale: boolean;
  offRoute: boolean;
  delayS: number | null;
}

export interface StopView {
  v: number;
  generatedAt: string;
  operator: OperatorRef;
  stop: StopRef;
  /** Routes of the visits below. */
  routes: RouteRef[];
  /** Today's visits of trips the viewer may see (a loop visits twice), by time; at most MAX_STOP_VISITS. */
  arrivals: StopArrivalView[];
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

function accessName(level: Level): AccessName {
  return level >= 2 ? 'map' : 'eta';
}

function operatorRef(ctx: ViewContext, operatorId: string): OperatorRef | null {
  const o = ctx.dir.operators.get(operatorId);
  return o ? { id: o.id, slug: o.slug, name: o.name } : null;
}

export function routeRef(r: LiveRouteRow): RouteRef {
  return { id: r.id, slug: r.slug, name: r.name, shortName: r.shortName, color: r.color, textColor: r.textColor };
}

function stopRef(ctx: ViewContext, viewer: Viewer, stop: LiveStopRow, cache?: Map<string, boolean>): StopRef {
  let visible = cache?.get(stop.id);
  if (visible === undefined) {
    visible = ctx.dir.access.stopLocationVisible(viewer.uid, stop.id, ctx.now);
    cache?.set(stop.id, visible);
  }
  return { id: stop.id, slug: stop.slug, name: stop.name, location: visible ? [round(stop.lon, 6), round(stop.lat, 6)] : null };
}

/** Today's trips (operator-local service date) and active ones. */
function isCurrent(ctx: ViewContext, i: LiveInstanceRow, status: TripStatus): boolean {
  if (status === 'active') return true;
  const tz = ctx.dir.operators.get(i.operatorId)?.timezone ?? 'Asia/Tokyo';
  return i.serviceDate === localDate(ctx.now, tz);
}

interface TripState {
  status: TripStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  offRoute: boolean;
  tracked: boolean;
  stale: boolean;
  lastSeenAt: Date | null;
  events: Map<number, StopEventRow>;
  scheduledStart: Date | null;
  timeOf(v: PlannedVisit, which: 'arrival' | 'departure'): Date | null;
  fix: VehicleFix | null;
}

/** Merges the database row with the engine's live state of the trip. */
function tripState(ctx: ViewContext, i: LiveInstanceRow): TripState {
  const rt = ctx.runtime(i.id);
  const tz = ctx.dir.operators.get(i.operatorId)?.timezone ?? 'Asia/Tokyo';
  const trip = i.tripId === null ? undefined : ctx.dir.trips.get(i.tripId);
  const scheduledStart = trip ? serviceTime(i.serviceDate, trip.startTimeS, tz) : null;
  const timeOf = (v: PlannedVisit, which: 'arrival' | 'departure'): Date | null => {
    const offset = which === 'arrival' ? v.arrivalOffsetS : v.departureOffsetS;
    if (scheduledStart !== null && offset !== null) return new Date(scheduledStart.getTime() + offset * 1000);
    return which === 'arrival' ? v.plannedArrival : v.plannedDeparture;
  };
  if (!rt) {
    return {
      status: i.status, startedAt: i.startedAt, endedAt: i.endedAt, offRoute: i.status === 'active' && i.offRouteSince !== null,
      tracked: false, stale: false, lastSeenAt: null,
      events: new Map(i.stopEvents.map((e) => [e.sequence, e])), scheduledStart, timeOf, fix: null,
    };
  }
  const p = rt.progress;
  const active = p.status === 'active';
  const fix = active && p.vehicleId !== null ? ctx.fix(p.vehicleId) ?? null : null;
  let lastSeen = p.lastFixAt;
  if (fix && (!lastSeen || fix.at > lastSeen)) lastSeen = fix.at;
  const stale = active && (lastSeen === null || (ctx.now.getTime() - lastSeen.getTime()) / 1000 > ctx.staleAfterS);
  return {
    status: p.status, startedAt: p.startedAt, endedAt: p.endedAt, offRoute: active && p.offRouteSince !== null,
    tracked: true, stale, lastSeenAt: active ? lastSeen : null,
    events: new Map(p.stops.map((s) => [s.sequence, s])), scheduledStart, timeOf, fix,
  };
}

interface Visit {
  v: PlannedVisit;
  state: StopState;
  scheduledArrival: Date | null;
  scheduledDeparture: Date | null;
  eta: Date | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
  passedAt: Date | null;
}

function visitsOf(ctx: ViewContext, i: LiveInstanceRow, st: TripState): Visit[] {
  return ctx.dir.visits(i).map((v) => {
    const e = st.events.get(v.sequence);
    const state = e?.state ?? 'upcoming';
    const ahead = state === 'upcoming' || state === 'approaching';
    return {
      v,
      state,
      scheduledArrival: st.timeOf(v, 'arrival'),
      scheduledDeparture: st.timeOf(v, 'departure'),
      eta: st.status === 'active' && ahead ? e?.eta ?? null : null,
      arrivedAt: e?.arrivedAt ?? null,
      departedAt: e?.departedAt ?? null,
      passedAt: e?.passedAt ?? null,
    };
  });
}

function delayOf(st: TripState, visits: Visit[]): number | null {
  if (st.status !== 'active') return null;
  const next = visits.find((x) => (x.state === 'upcoming' || x.state === 'approaching') && x.eta !== null && x.scheduledArrival !== null);
  if (!next?.eta || !next.scheduledArrival) return null;
  return Math.round((next.eta.getTime() - next.scheduledArrival.getTime()) / 1000);
}

function headsignOf(ctx: ViewContext, i: LiveInstanceRow): I18nText | null {
  if (i.kind === 'live') return i.title;
  return i.tripId === null ? null : ctx.dir.trips.get(i.tripId)?.headsign ?? null;
}

/** A trip as the viewer may see it; null if not at all. */
export function tripView(ctx: ViewContext, viewer: Viewer, i: LiveInstanceRow, locations = new Map<string, boolean>()): TripView | null {
  const level = ctx.dir.access.tripAccess(viewer.uid, i.id, ctx.now);
  if (level === 0) return null;
  const st = tripState(ctx, i);
  const visits = visitsOf(ctx, i, st);
  const last = visits[visits.length - 1];
  const fix = st.fix;
  const showVehicle = level >= 2 && st.status === 'active' && st.tracked && !st.offRoute && !st.stale
    && fix !== null && fix.tripInstanceId === i.id;
  const stops: StopVisitView[] = [];
  for (const x of visits) {
    const stop = ctx.dir.stops.get(x.v.stopId);
    if (!stop) continue;
    stops.push({
      sequence: x.v.sequence,
      stop: stopRef(ctx, viewer, stop, locations),
      state: x.state,
      scheduledArrival: iso(x.scheduledArrival),
      scheduledDeparture: iso(x.scheduledDeparture),
      eta: iso(x.eta),
      arrivedAt: iso(x.arrivedAt),
      departedAt: iso(x.departedAt),
      passedAt: iso(x.passedAt),
    });
  }
  return {
    id: i.id,
    kind: i.kind,
    status: st.status,
    serviceDate: i.serviceDate,
    routeId: i.routeId,
    access: accessName(level),
    headsign: headsignOf(ctx, i),
    scheduledStart: iso(st.scheduledStart ?? visits[0]?.scheduledArrival ?? null),
    scheduledEnd: iso(last?.scheduledArrival ?? null),
    startedAt: iso(st.startedAt),
    endedAt: iso(st.endedAt),
    tracked: st.tracked,
    stale: st.stale,
    lastSeenAt: iso(st.lastSeenAt),
    offRoute: st.offRoute,
    delayS: delayOf(st, visits),
    vehicle: showVehicle ? {
      lon: round(fix.lon, 6),
      lat: round(fix.lat, 6),
      heading: fix.heading === null ? null : Math.round(fix.heading),
      speedKmh: round(fix.speedKmh, 1),
      accuracyM: fix.accuracyM === null ? null : Math.round(fix.accuracyM),
      recordedAt: fix.at.toISOString(),
    } : null,
    stops,
  };
}

function startKey(t: TripView): string {
  return t.scheduledStart ?? t.startedAt ?? t.serviceDate;
}

/** GET /v1/live/routes/:routeId and /v1/public/routes/…: null = 404. */
export function routeView(ctx: ViewContext, viewer: Viewer, routeId: string): RouteView | null {
  const route = ctx.dir.routes.get(routeId);
  if (!route) return null;
  const level = ctx.dir.access.routeAccess(viewer.uid, routeId);
  if (level === 0) return null;
  const operator = operatorRef(ctx, route.operatorId);
  if (!operator) return null;
  const locations = new Map<string, boolean>();
  const trips: TripView[] = [];
  for (const i of ctx.dir.instancesOfRoute(routeId)) {
    const status = ctx.runtime(i.id)?.progress.status ?? i.status;
    if (!isCurrent(ctx, i, status)) continue;
    const t = tripView(ctx, viewer, i, locations);
    if (t) trips.push(t);
  }
  trips.sort((a, b) => startKey(a).localeCompare(startKey(b)) || a.id.localeCompare(b.id));
  return { v: FORMAT_VERSION, generatedAt: ctx.now.toISOString(), operator, route: routeRef(route), access: accessName(level), trips };
}

/** GET /v1/live/trips/:tripInstanceId: null = 404. */
export function tripOnlyView(ctx: ViewContext, viewer: Viewer, tripInstanceId: string): TripOnlyView | null {
  const i = ctx.dir.instances.get(tripInstanceId);
  if (!i) return null;
  const trip = tripView(ctx, viewer, i);
  const operator = operatorRef(ctx, i.operatorId);
  if (!trip || !operator) return null;
  // The route itself only if the viewer may see it (a live trip's audience
  // may not).
  const route = i.routeId === null ? undefined : ctx.dir.routes.get(i.routeId);
  const showRoute = route !== undefined && ctx.dir.access.routeAccess(viewer.uid, route.id) >= 1;
  return { v: FORMAT_VERSION, generatedAt: ctx.now.toISOString(), operator, route: showRoute ? routeRef(route) : null, trip };
}

/** GET /v1/live/stops/:stopId and /v1/public/stops/…: null = 404. */
export function stopView(ctx: ViewContext, viewer: Viewer, stopId: string): StopView | null {
  const stop = ctx.dir.stops.get(stopId);
  if (!stop) return null;
  if (ctx.dir.access.stopAccess(viewer.uid, stopId, ctx.now) === 0) return null;
  const operator = operatorRef(ctx, stop.operatorId);
  if (!operator) return null;
  const arrivals: (StopArrivalView & { sortAt: number })[] = [];
  const routes = new Map<string, RouteRef>();
  for (const i of ctx.dir.instancesAtStop(stopId)) {
    if (ctx.dir.access.tripAccess(viewer.uid, i.id, ctx.now) === 0) continue;
    const st = tripState(ctx, i);
    if (!isCurrent(ctx, i, st.status)) continue;
    const visits = visitsOf(ctx, i, st);
    const delayS = delayOf(st, visits);
    for (const x of visits) {
      if (x.v.stopId !== stopId) continue;
      const at = x.arrivedAt ?? x.passedAt ?? x.eta ?? x.scheduledArrival ?? st.startedAt;
      arrivals.push({
        tripInstanceId: i.id,
        kind: i.kind,
        tripStatus: st.status,
        routeId: i.routeId,
        headsign: headsignOf(ctx, i),
        sequence: x.v.sequence,
        state: x.state,
        scheduledArrival: iso(x.scheduledArrival),
        scheduledDeparture: iso(x.scheduledDeparture),
        eta: iso(x.eta),
        arrivedAt: iso(x.arrivedAt),
        departedAt: iso(x.departedAt),
        passedAt: iso(x.passedAt),
        tracked: st.tracked,
        stale: st.stale,
        offRoute: st.offRoute,
        delayS,
        sortAt: at?.getTime() ?? Number.MAX_SAFE_INTEGER,
      });
    }
    // The route is named only if the viewer may see it.
    const route = i.routeId === null ? undefined : ctx.dir.routes.get(i.routeId);
    if (route && ctx.dir.access.routeAccess(viewer.uid, route.id) >= 1) routes.set(route.id, routeRef(route));
  }
  arrivals.sort((a, b) => a.sortAt - b.sortAt || a.tripInstanceId.localeCompare(b.tripInstanceId) || a.sequence - b.sequence);
  // The nearest visits: the latest served ones and what comes next.
  const nowMs = ctx.now.getTime();
  let firstUpcoming = arrivals.findIndex((a) => a.sortAt >= nowMs);
  if (firstUpcoming < 0) firstUpcoming = arrivals.length;
  const from = Math.max(0, Math.min(firstUpcoming - 5, arrivals.length - MAX_STOP_VISITS));
  const kept: StopArrivalView[] = arrivals.slice(from, from + MAX_STOP_VISITS).map((a) => {
    const out: Partial<typeof a> = { ...a };
    delete out.sortAt;
    return out as StopArrivalView;
  });
  return {
    v: FORMAT_VERSION,
    generatedAt: ctx.now.toISOString(),
    operator,
    stop: stopRef(ctx, viewer, stop),
    routes: [...routes.values()],
    arrivals: kept,
  };
}
