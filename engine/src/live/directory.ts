/**
 * Lookup tables over one LiveSnapshot, built once per reload. Immutable:
 * a reload builds a new Directory and swaps it in.
 */
import { AccessIndex } from './access.ts';
import type {
  LiveInstanceRow,
  LiveOperatorRow,
  LivePatternStopRow,
  LiveRouteRow,
  LiveSnapshot,
  LiveStopRow,
  LiveTripRow,
} from './types.ts';

/** One stop of a trip instance, in order. */
export interface PlannedVisit {
  sequence: number;
  stopId: string;
  /** Seconds from trip start (scheduled trips), or null. */
  arrivalOffsetS: number | null;
  departureOffsetS: number | null;
  /** Planned instants (live trips with planned stops), or null. */
  plannedArrival: Date | null;
  plannedDeparture: Date | null;
}

export class Directory {
  readonly access: AccessIndex;
  readonly operators: Map<string, LiveOperatorRow>;
  readonly routes: Map<string, LiveRouteRow>;
  readonly stops: Map<string, LiveStopRow>;
  readonly trips: Map<string, LiveTripRow>;
  readonly instances: Map<string, LiveInstanceRow>;
  readonly #operatorBySlug: Map<string, LiveOperatorRow>;
  readonly #routeBySlug = new Map<string, LiveRouteRow>();
  readonly #stopBySlug = new Map<string, LiveStopRow>();
  readonly #patternStops = new Map<string, LivePatternStopRow[]>();
  readonly #patternRoute: Map<string, string>;
  readonly #instancesByRoute = new Map<string, LiveInstanceRow[]>();
  readonly #instancesByStop = new Map<string, Set<LiveInstanceRow>>();

  constructor(s: LiveSnapshot) {
    this.access = new AccessIndex(s);
    this.operators = new Map(s.operators.map((o) => [o.id, o]));
    this.#operatorBySlug = new Map(s.operators.map((o) => [o.slug, o]));
    this.routes = new Map(s.routes.map((r) => [r.id, r]));
    this.stops = new Map(s.stops.map((st) => [st.id, st]));
    this.trips = new Map(s.trips.map((t) => [t.id, t]));
    this.instances = new Map(s.instances.map((i) => [i.id, i]));
    this.#patternRoute = new Map(s.patterns.map((p) => [p.id, p.routeId]));
    for (const r of s.routes) if (r.slug !== null) this.#routeBySlug.set(`${r.operatorId}/${r.slug}`, r);
    for (const st of s.stops) if (st.slug !== null) this.#stopBySlug.set(`${st.operatorId}/${st.slug}`, st);
    for (const ps of s.patternStops) {
      const list = this.#patternStops.get(ps.patternId);
      if (list) list.push(ps);
      else this.#patternStops.set(ps.patternId, [ps]);
    }
    for (const list of this.#patternStops.values()) list.sort((a, b) => a.sequence - b.sequence);
    for (const i of s.instances) {
      if (i.routeId !== null) {
        const list = this.#instancesByRoute.get(i.routeId);
        if (list) list.push(i);
        else this.#instancesByRoute.set(i.routeId, [i]);
      }
      for (const v of this.visits(i)) {
        let set = this.#instancesByStop.get(v.stopId);
        if (!set) this.#instancesByStop.set(v.stopId, set = new Set());
        set.add(i);
      }
    }
  }

  routeBySlug(operatorSlug: string, routeSlug: string): LiveRouteRow | undefined {
    const op = this.#operatorBySlug.get(operatorSlug);
    return op ? this.#routeBySlug.get(`${op.id}/${routeSlug}`) : undefined;
  }

  stopBySlug(operatorSlug: string, stopSlug: string): LiveStopRow | undefined {
    const op = this.#operatorBySlug.get(operatorSlug);
    return op ? this.#stopBySlug.get(`${op.id}/${stopSlug}`) : undefined;
  }

  routeOfPattern(patternId: string): string | undefined {
    return this.#patternRoute.get(patternId);
  }

  instancesOfRoute(routeId: string): readonly LiveInstanceRow[] {
    return this.#instancesByRoute.get(routeId) ?? [];
  }

  instancesAtStop(stopId: string): Iterable<LiveInstanceRow> {
    return this.#instancesByStop.get(stopId) ?? [];
  }

  /** The stops of a trip instance in order: its pattern's, or a live trip's planned stops. */
  visits(i: LiveInstanceRow): PlannedVisit[] {
    if (i.patternId !== null) {
      return (this.#patternStops.get(i.patternId) ?? []).map((ps) => ({
        sequence: ps.sequence,
        stopId: ps.stopId,
        arrivalOffsetS: ps.arrivalOffsetS,
        departureOffsetS: ps.departureOffsetS,
        plannedArrival: null,
        plannedDeparture: null,
      }));
    }
    return i.plannedStops.map((p) => ({
      sequence: p.sequence,
      stopId: p.stopId,
      arrivalOffsetS: null,
      departureOffsetS: null,
      plannedArrival: p.plannedArrival,
      plannedDeparture: p.plannedDeparture,
    }));
  }
}
