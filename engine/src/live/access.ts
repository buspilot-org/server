/**
 * Who may see what in the live API. Mirrors the database's row-level
 * security exactly, so the live API never shows more than Supabase would:
 *
 * - routeAccess        = private.route_access(route_id)
 * - tripAccess         = private.trip_instance_access(trip_instance_id)
 * - stopAccess         = private.stop_access(stop_id)
 * - stopLocationVisible = a row in public.stop_location
 *                         (stop_access ≥ 2 or private.follows_stop)
 *
 * (migrations 20261123111629_row_level_security.sql,
 * 20261126100300_trip_access.sql, 20261126100400_rider_app.sql). The parity
 * test (test/db/live-parity.test.ts) compares these with the SQL functions
 * for the seed and fixtures; change both together.
 *
 * `uid` is the signed-in user (auth.uid()), or null for a visitor (anon).
 */
import type { Level, LiveInstanceRow, LiveSnapshot, StaffRole, Visibility } from './types.ts';

const DAY_MS = 24 * 3600 * 1000;

function utcDate(t: Date): string {
  return t.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

export class AccessIndex {
  readonly #routes: Map<string, { operatorId: string; active: boolean; visibility: Visibility }>;
  readonly #stopOperator: Map<string, string>;
  readonly #patternRoute: Map<string, string>;
  readonly #tripVehicle: Map<string, string | null>;
  readonly #instances: Map<string, LiveInstanceRow>;
  /** userId → operatorId → role */
  readonly #staff = new Map<string, Map<string, StaffRole>>();
  /** userId → "operatorId:vehicleId" */
  readonly #drives = new Map<string, Set<string>>();
  /** deviceId → audience IDs (active memberships) */
  readonly #member = new Map<string, Set<string>>();
  readonly #audienceRoutes = new Map<string, { audienceId: string; canSeeMap: boolean }[]>();
  readonly #tripAudiences = new Map<string, { audienceId: string; canSeeMap: boolean }[]>();
  /** stopId → route IDs of patterns serving it */
  readonly #stopRoutes = new Map<string, Set<string>>();
  /** stopId → trip instances with a planned stop there (same operator) */
  readonly #stopPlanned = new Map<string, LiveInstanceRow[]>();
  readonly #subs = new Map<string, LiveSnapshot['subscriptions']>();
  /** deviceId → "operatorId:stopId" of the first two logged followed stops */
  readonly #followed = new Map<string, Set<string>>();

  constructor(s: LiveSnapshot) {
    const defaults = new Map(s.operators.map((o) => [o.id, o.defaultVisibility]));
    this.#routes = new Map(s.routes.map((r) => [r.id, {
      operatorId: r.operatorId,
      active: r.active,
      visibility: r.visibility ?? defaults.get(r.operatorId) ?? 'invited_eta',
    }]));
    this.#stopOperator = new Map(s.stops.map((st) => [st.id, st.operatorId]));
    this.#patternRoute = new Map(s.patterns.map((p) => [p.id, p.routeId]));
    this.#tripVehicle = new Map(s.trips.map((t) => [t.id, t.vehicleId]));
    this.#instances = new Map(s.instances.map((i) => [i.id, i]));
    for (const r of s.staffRoles) {
      let m = this.#staff.get(r.userId);
      if (!m) this.#staff.set(r.userId, m = new Map<string, StaffRole>());
      m.set(r.operatorId, r.role);
    }
    for (const d of s.driverVehicles) {
      let m = this.#drives.get(d.userId);
      if (!m) this.#drives.set(d.userId, m = new Set<string>());
      m.add(`${d.operatorId}:${d.vehicleId}`);
    }
    for (const m of s.memberships) {
      let set = this.#member.get(m.deviceId);
      if (!set) this.#member.set(m.deviceId, set = new Set<string>());
      set.add(m.audienceId);
    }
    for (const ar of s.audienceRoutes) push(this.#audienceRoutes, ar.routeId, { audienceId: ar.audienceId, canSeeMap: ar.canSeeMap });
    for (const ta of s.tripAudiences) push(this.#tripAudiences, ta.tripInstanceId, { audienceId: ta.audienceId, canSeeMap: ta.canSeeMap });
    for (const ps of s.patternStops) {
      const routeId = this.#patternRoute.get(ps.patternId);
      if (routeId === undefined) continue;
      let set = this.#stopRoutes.get(ps.stopId);
      if (!set) this.#stopRoutes.set(ps.stopId, set = new Set<string>());
      set.add(routeId);
    }
    for (const i of s.instances) {
      for (const p of i.plannedStops) {
        if (this.#stopOperator.get(p.stopId) === i.operatorId) push(this.#stopPlanned, p.stopId, i);
      }
    }
    for (const sub of s.subscriptions) push(this.#subs, sub.deviceId, sub);
    for (const f of s.followedStops) {
      let set = this.#followed.get(f.deviceId);
      if (!set) this.#followed.set(f.deviceId, set = new Set<string>());
      set.add(`${f.operatorId}:${f.stopId}`);
    }
  }

  #role(uid: string | null, operatorId: string): StaffRole | undefined {
    return uid === null ? undefined : this.#staff.get(uid)?.get(operatorId);
  }

  isStaff(uid: string | null, operatorId: string): boolean {
    return this.#role(uid, operatorId) !== undefined;
  }

  canEdit(uid: string | null, operatorId: string): boolean {
    const r = this.#role(uid, operatorId);
    return r === 'owner' || r === 'editor';
  }

  /** private.staff_trip_access */
  staffTripAccess(uid: string | null, operatorId: string, vehicleId: string | null, tripId: string | null): boolean {
    if (uid === null) return false;
    if (this.canEdit(uid, operatorId)) return true;
    if (this.#role(uid, operatorId) !== 'driver') return false;
    const v = vehicleId ?? (tripId === null ? null : this.#tripVehicle.get(tripId) ?? null);
    return v === null || (this.#drives.get(uid)?.has(`${operatorId}:${v}`) ?? false);
  }

  /** private.route_access */
  routeAccess(uid: string | null, routeId: string): Level {
    const r = this.#routes.get(routeId);
    if (!r) return 0;
    if (uid !== null && this.isStaff(uid, r.operatorId)) return 3;
    if (!r.active) return 0;
    if (r.visibility === 'public') return 2;
    if (uid === null) return 0;
    const audiences = this.#member.get(uid);
    if (!audiences) return 0;
    let found = false;
    let map = false;
    for (const ar of this.#audienceRoutes.get(routeId) ?? []) {
      if (!audiences.has(ar.audienceId)) continue;
      found = true;
      map ||= ar.canSeeMap;
    }
    if (!found) return 0;
    return map && r.visibility === 'invited_map' ? 2 : 1;
  }

  /** private.pattern_access */
  patternAccess(uid: string | null, patternId: string): Level {
    const routeId = this.#patternRoute.get(patternId);
    return routeId === undefined ? 0 : this.routeAccess(uid, routeId);
  }

  /** private.trip_instance_access */
  tripAccess(uid: string | null, instanceId: string, now: Date): Level {
    const ti = this.#instances.get(instanceId);
    if (!ti) return 0;
    if (uid !== null && this.isStaff(uid, ti.operatorId)) {
      return this.staffTripAccess(uid, ti.operatorId, ti.vehicleId, ti.tripId) ? 3 : 0;
    }
    if (ti.visibleUntil !== null && ti.visibleUntil <= now) return 0;
    let level: Level = ti.routeId === null ? 0 : this.routeAccess(uid, ti.routeId);
    if (ti.kind === 'live' && uid !== null) {
      const etaOnly = ti.routeId !== null && this.#routes.get(ti.routeId)?.visibility === 'invited_eta';
      const audiences = this.#member.get(uid);
      let found = false;
      let map = false;
      for (const ta of this.#tripAudiences.get(instanceId) ?? []) {
        if (!audiences?.has(ta.audienceId)) continue;
        found = true;
        map ||= ta.canSeeMap;
      }
      if (found) level = Math.max(level, map && !etaOnly ? 2 : 1) as Level;
    }
    return level;
  }

  /** private.stop_access (the live-trip part uses the database's current_date, which is UTC on Supabase). */
  stopAccess(uid: string | null, stopId: string, now: Date): Level {
    const operatorId = this.#stopOperator.get(stopId);
    if (operatorId === undefined) return 0;
    if (this.isStaff(uid, operatorId)) return 3;
    let level: Level = 0;
    for (const routeId of this.#stopRoutes.get(stopId) ?? []) {
      level = Math.max(level, this.routeAccess(uid, routeId)) as Level;
    }
    const yesterday = addDays(utcDate(now), -1);
    const dayAgo = now.getTime() - DAY_MS;
    for (const ti of this.#stopPlanned.get(stopId) ?? []) {
      if (ti.visibleUntil !== null && ti.visibleUntil <= now) continue;
      const current = ti.status === 'active'
        || (ti.status === 'planned' && ti.serviceDate >= yesterday)
        || (ti.endedAt !== null && ti.endedAt.getTime() > dayAgo);
      if (!current) continue;
      level = Math.max(level, this.tripAccess(uid, ti.id, now)) as Level;
    }
    return level;
  }

  /** private.follows_stop */
  followsStop(uid: string | null, stopId: string, now: Date): boolean {
    if (uid === null) return false;
    const operatorId = this.#stopOperator.get(stopId);
    if (operatorId === undefined || !this.#followed.get(uid)?.has(`${operatorId}:${stopId}`)) return false;
    return (this.#subs.get(uid) ?? []).some((s) => s.stopId === stopId && (
      s.patternId !== null ? this.patternAccess(uid, s.patternId) >= 1
        : s.tripInstanceId !== null && this.tripAccess(uid, s.tripInstanceId, now) >= 1
    ));
  }

  /** A row in public.stop_location for this user. */
  stopLocationVisible(uid: string | null, stopId: string, now: Date): boolean {
    return this.stopAccess(uid, stopId, now) >= 2 || this.followsStop(uid, stopId, now);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
