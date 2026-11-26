/**
 * Integration test against the local Supabase database (`npx supabase start`
 * and `npx supabase db reset` first). Uses the seed: the demo school's loop
 * that serves Kitano-zaka twice, Bus 1 (Traccar device 23273424), trips at
 * 07:30 and 08:10 on school days.
 *
 * Works on 2027-03-01 (a Monday in the school year, far from today) and
 * removes what it created. Bus 1's vehicle_state is saved first and restored
 * afterwards, so local development data is left as it was.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { defaultThresholds } from '../../src/config.ts';
import { Engine } from '../../src/core/engine.ts';
import type { Writes } from '../../src/core/types.ts';
import { LocalPlane, Polyline } from '../../src/geo/plane.ts';
import { silentLogger } from '../../src/log.ts';
import { PgStore } from '../../src/store/pg.ts';
import { FakeClock, Track, type Fix } from '../replay/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const DATE = '2027-03-01';
const VEHICLE = 'd0000000-0000-4000-8000-000000000701';
const DEVICE = '23273424';
const SHAPE = 'd0000000-0000-4000-8000-000000000401';
const TRIP_0730 = 'd0000000-0000-4000-8000-000000000801';
const START = new Date('2027-02-28T22:30:00Z'); // 07:30 JST

const store = new PgStore(DATABASE_URL, { max: 3 });
const sql = store.sql;

let savedVehicleState: Record<string, unknown>[] = [];

async function cleanup(): Promise<void> {
  await sql`delete from public.trip_instance where service_date in ('2027-03-01', '2027-03-02')`;
  await sql`delete from public.vehicle_state where vehicle_id = ${VEHICLE}`;
}

interface StopRow { stop_sequence: number; state: string; arrived_at: Date | null; departed_at: Date | null; passed_at: Date | null; eta: Date | null }

async function stopEvents(): Promise<StopRow[]> {
  return sql<StopRow[]>`
    select se.stop_sequence, se.state::text as state, se.arrived_at, se.departed_at, se.passed_at, se.eta
      from public.stop_event se
      join public.trip_instance ti on ti.id = se.trip_instance_id
     where ti.service_date = ${DATE} and ti.trip_id = ${TRIP_0730}
     order by se.stop_sequence`;
}

async function instance(): Promise<{ id: string; status: string; progress_m: number; vehicle_id: string | null }> {
  const [row] = await sql<{ id: string; status: string; progress_m: number; vehicle_id: string | null }[]>`
    select id, status::text as status, progress_m, vehicle_id from public.trip_instance
     where service_date = ${DATE} and trip_id = ${TRIP_0730}`;
  assert.ok(row);
  return row;
}

describe('PgStore and engine against the seeded database', () => {
  let plane: LocalPlane;
  let shape: Polyline;
  let stopM: number[];
  let fixes: Fix[];

  before(async () => {
    savedVehicleState = await sql`select * from public.vehicle_state where vehicle_id = ${VEHICLE}`;
    await cleanup();
    const [s] = await sql<{ coordinates: [number, number][]; length_m: number }[]>`
      select (extensions.st_asgeojson(geom::extensions.geometry)::json -> 'coordinates') as coordinates,
             extensions.st_length(geom) as length_m
        from public.shape where id = ${SHAPE}`;
    assert.ok(s, 'seed shape missing: run npx supabase db reset');
    plane = LocalPlane.around(s.coordinates.map(([lon, lat]) => ({ lon, lat })));
    shape = new Polyline(s.coordinates.map(([lon, lat]) => plane.toXY({ lon, lat })), s.length_m);
    const ps = await sql<{ dist_along_shape: number }[]>`
      select dist_along_shape from public.pattern_stop
       where pattern_id = 'd0000000-0000-4000-8000-000000000301' order by stop_sequence`;
    stopM = ps.map((r) => r.dist_along_shape);

    const t = new Track(shape, new Date(START.getTime() - 5 * 60_000), { intervalS: 5 });
    t.dwell(6 * 60);
    for (const m of stopM.slice(1)) t.drive(m - 3, 30).dwell(30);
    // Leave the school: drive on, away from the end of the route.
    const end = shape.pointAt(shape.length);
    t.goTo({ x: end.x - 150, y: end.y + 150 }, 15);
    fixes = t.fixes;
  });

  after(async () => {
    await cleanup();
    const saved = savedVehicleState[0];
    if (saved) await sql`insert into public.vehicle_state ${sql(saved)}`;
    await store.close();
  });

  it('creates trip instances and stop events from the calendar (Tokyo dates)', async () => {
    const created = await store.createTripInstances(new Date('2027-02-28T16:00:00Z')); // 01:00 JST on 03-01
    assert.equal(created, 4, 'two trips on Monday and Tuesday');
    assert.equal(await store.createTripInstances(new Date('2027-02-28T16:00:00Z')), 0, 'idempotent');
    const events = await stopEvents();
    assert.deepEqual(events.map((e) => e.state), Array(6).fill('upcoming'));
    assert.equal((await instance()).vehicle_id, null, 'no vehicle until one runs it (the trip default applies)');
  });

  it('projects like PostGIS', async () => {
    // Reference: geodesic length of the shape up to ST_LineLocatePoint (PostGIS
    // 3.3 has no geography version of it; its geometry fraction is in degree
    // space, so it is turned into metres with ST_LineSubstring). Points on
    // legs the loop does not pass twice, so the nearest point is unambiguous.
    for (const [m, dx] of [[400, 0], [400, 5], [1900, 0], [1900, 8]] as const) {
      const p = shape.pointAt(m);
      const ll = plane.toLonLat({ x: p.x + dx, y: p.y });
      const ours = shape.nearest(plane.toXY(ll))?.m ?? -1;
      const [row] = await sql<{ m: number }[]>`
        select extensions.st_length(extensions.st_linesubstring(g, 0,
                 extensions.st_linelocatepoint(g, extensions.st_setsrid(extensions.st_makepoint(${ll.lon}, ${ll.lat}), 4326)))::extensions.geography) as m
          from (select geom::extensions.geometry as g from public.shape where id = ${SHAPE}) s`;
      assert.ok(row);
      assert.ok(Math.abs(ours - row.m) < 3, `at ${m} m (+${dx} m): engine ${ours.toFixed(1)} m vs PostGIS ${row.m.toFixed(1)} m`);
    }
  });

  it('runs the loop: Kitano-zaka twice, in order; a restart mid-trip continues from the database', async () => {
    const clock = new FakeClock(fixes[0]?.t ?? START);
    const mk = (): Engine => new Engine({ store, thresholds: defaultThresholds, clock, log: silentLogger });
    let engine = mk();
    await engine.reload();

    const feed = async (list: Fix[]): Promise<string[]> => {
      const out: string[] = [];
      for (const f of list) {
        clock.set(new Date(f.t.getTime() + 1000));
        const ll = plane.toLonLat(f.xy);
        out.push(await engine.handlePosition({
          deviceId: DEVICE, positionId: null, fixTime: f.t, lon: ll.lon, lat: ll.lat,
          speedKmh: f.speedKmh, course: f.course ?? null, accuracyM: 5, valid: true,
        }));
      }
      return out;
    };

    // Up to the first stop at Kitano-zaka.
    const atKitano = fixes.findIndex((f, i) => i > 0 && f.speedKmh === 0 && shape.nearest(f.xy, 0, (stopM[1] ?? 0) + 50)?.m !== undefined
      && Math.abs((shape.nearest(f.xy, 0, (stopM[1] ?? 0) + 50)?.m ?? 0) - (stopM[1] ?? 0)) < 10);
    assert.ok(atKitano > 0);
    await feed(fixes.slice(0, atKitano + 1));
    let events = await stopEvents();
    assert.equal(events[1]?.state, 'arrived', 'Kitano-zaka, first visit (stop_sequence 2)');
    const secondVisit = events[4];
    assert.ok(secondVisit);
    assert.equal(secondVisit.state, 'upcoming', 'Kitano-zaka, second visit (stop_sequence 5), same place');
    assert.ok(secondVisit.eta, 'ETAs written for stops ahead');
    assert.equal((await instance()).status, 'active');

    // Halfway: restart. The last positions are retried by Traccar.
    const half = Math.floor(fixes.length / 2);
    await feed(fixes.slice(atKitano + 1, half));
    engine = mk();
    await engine.reload();
    assert.deepEqual(await feed(fixes.slice(half - 2, half)), ['duplicate', 'duplicate']);
    await feed(fixes.slice(half));

    events = await stopEvents();
    assert.deepEqual(events.map((e) => e.state), Array(6).fill('departed'));
    const arrivals = events.map((e) => e.arrived_at?.getTime() ?? 0);
    assert.deepEqual(arrivals, [...arrivals].sort((a, b) => a - b), 'arrivals in route order');
    const inst = await instance();
    assert.equal(inst.status, 'completed');
    assert.equal(inst.vehicle_id, VEHICLE, 'the trip default vehicle ran it');
    assert.ok(inst.progress_m > (stopM[4] ?? 0));

    const [vs] = await sql<{ trip_instance_id: string | null; recorded_at: Date }[]>`
      select trip_instance_id, recorded_at from public.vehicle_state where vehicle_id = ${VEHICLE}`;
    assert.ok(vs);
    // Throttled (vehicleStateIntervalS): at most 30 s behind the last fix.
    const lastFix = fixes[fixes.length - 1]?.t.getTime() ?? 0;
    assert.ok(vs.recorded_at.getTime() <= lastFix && lastFix - vs.recorded_at.getTime() <= 30_000, 'vehicle_state recent');
    assert.equal(vs.trip_instance_id, null, 'no active trip after the end');
  });

  it('writes are idempotent and never move backwards', async () => {
    const inst = await instance();
    const before = await stopEvents();
    const oldFix = new Date(START.getTime() - 3600_000);
    const backwards: Writes = {
      vehicleId: VEHICLE,
      release: null,
      vehicleState: {
        vehicleId: VEHICLE, operatorId: 'd0000000-0000-4000-8000-000000000001', tripInstanceId: null,
        lon: 135.19, lat: 34.7, speedKmh: 0, heading: null, accuracyM: null, recordedAt: oldFix,
      },
      trip: {
        id: inst.id, status: 'active', vehicleId: VEHICLE, startedBy: 'schedule', progressM: 10, progressAt: START,
        lastConfirmedStopSequence: 1, offRouteSince: null, startedAt: START, endedAt: null,
      },
      stopEvents: [
        { tripInstanceId: inst.id, sequence: 2, state: 'arrived', arrivedAt: START, departedAt: null, passedAt: null },
        { tripInstanceId: inst.id, sequence: 3, state: 'passed', arrivedAt: null, departedAt: null, passedAt: START },
      ],
      etas: [{ tripInstanceId: inst.id, sequence: 4, eta: START }],
    };
    assert.deepEqual(await store.persist(backwards), { tripApplied: true }, 'its own (completed) trip');
    await store.persist(backwards);
    assert.deepEqual(await stopEvents(), before);
    // A vehicle that does not run the trip changes nothing.
    const stranger: Writes = { ...backwards, vehicleId: 'e0000000-0000-4000-8000-0000000007ff', vehicleState: null };
    assert.deepEqual(await store.persist(stranger), { tripApplied: false });
    assert.deepEqual(await stopEvents(), before);
    const after = await instance();
    assert.equal(after.status, 'completed');
    assert.equal(after.progress_m, inst.progress_m);
    const [vs] = await sql<{ recorded_at: Date }[]>`select recorded_at from public.vehicle_state where vehicle_id = ${VEHICLE}`;
    assert.ok(vs && vs.recorded_at > oldFix, 'older fix does not overwrite vehicle_state');
  });
});
