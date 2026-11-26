/**
 * Live trips against the local Supabase database (`npx supabase db reset`
 * first): loading live trips with planned stops, subscriptions to a planned
 * stop (access through the trip's audiences), and a live trip on the seed's
 * pattern run end to end by the engine (its stop events created by the
 * engine, written as for scheduled trips).
 *
 * Works on 2027-03-05 with its own trip instances and anonymous devices;
 * removes everything it created and restores Bus 1's vehicle_state.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AlertDispatcher, defaultAlertConfig } from '../../src/alerts/dispatcher.ts';
import { defaultThresholds } from '../../src/config.ts';
import { buildCache, progressFromRow } from '../../src/core/cache.ts';
import { Engine } from '../../src/core/engine.ts';
import { LocalPlane, Polyline } from '../../src/geo/plane.ts';
import { silentLogger } from '../../src/log.ts';
import { PgStore } from '../../src/store/pg.ts';
import { FakeClock, FakeSender, Track } from '../replay/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const DATE = '2027-03-05';
const OPERATOR = 'd0000000-0000-4000-8000-000000000001';
const PATTERN = 'd0000000-0000-4000-8000-000000000301';
const SHAPE = 'd0000000-0000-4000-8000-000000000401';
const AUDIENCE = 'd0000000-0000-4000-8000-000000000601';
const VEHICLE = 'd0000000-0000-4000-8000-000000000701';
const DEVICE = '23273424';
const START = new Date('2027-03-04T22:30:00Z'); // 07:30 JST on 03-05

const L_PATTERN = 'b1170000-0000-4000-8000-000000000001';
const L_TOUR = 'b1170000-0000-4000-8000-000000000002';
const DEV = { member: 'b1170000-0000-4000-8000-0000000000d1', outsider: 'b1170000-0000-4000-8000-0000000000d2' } as const;
const SUB = { member: 'b1170000-0000-4000-8000-0000000000e1', outsider: 'b1170000-0000-4000-8000-0000000000e2' } as const;

const store = new PgStore(DATABASE_URL, { max: 3 });
const sql = store.sql;
let savedVehicleState: Record<string, unknown>[] = [];

async function cleanup(): Promise<void> {
  await sql`delete from public.trip_instance where id = any(${[L_PATTERN, L_TOUR]}::uuid[])`;
  await sql`delete from auth.users where id = any(${Object.values(DEV)}::uuid[])`;
}

describe('live trips against the seeded database', () => {
  let stopIds: string[] = [];

  before(async () => {
    savedVehicleState = await sql`select * from public.vehicle_state where vehicle_id = ${VEHICLE}`;
    await cleanup();
    stopIds = (await sql<{ stop_id: string }[]>`
      select stop_id from public.pattern_stop where pattern_id = ${PATTERN} order by stop_sequence`).map((r) => r.stop_id);
    assert.ok(stopIds.length >= 4, 'seed pattern missing: run npx supabase db reset');
    // A tour without a route, seen by the demo audience: three planned stops.
    await sql`
      insert into public.trip_instance (id, operator_id, service_date, kind, started_by, title, vehicle_id, visible_until)
      values (${L_TOUR}, ${OPERATOR}, ${DATE}, 'live', 'driver', ${sql.json({ ja: '遠足', en: 'Excursion' })}, null, null)`;
    await sql`
      insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id, planned_arrival, planned_departure) values
        (${OPERATOR}, ${L_TOUR}, 10, ${stopIds[0] ?? ''}, null, '2027-03-05T09:00:00+09:00'),
        (${OPERATOR}, ${L_TOUR}, 20, ${stopIds[2] ?? ''}, '2027-03-05T09:20:00+09:00', '2027-03-05T10:30:00+09:00'),
        (${OPERATOR}, ${L_TOUR}, 30, ${stopIds[3] ?? ''}, '2027-03-05T11:00:00+09:00', null)`;
    await sql`insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id) values (${OPERATOR}, ${L_TOUR}, ${AUDIENCE})`;
    await sql`insert into auth.users (id, is_anonymous) select unnest(${Object.values(DEV)}::uuid[]), true`;
    await sql`
      insert into public.device (id, push_token, platform, language) values
        (${DEV.member}, 'fid-live-member', 'android', 'en'),
        (${DEV.outsider}, 'fid-live-outsider', 'android', 'ja')`;
    await sql`insert into public.membership (operator_id, device_id, audience_id) values (${OPERATOR}, ${DEV.member}, ${AUDIENCE})`;
    // The outsider's subscription is inserted directly (RLS would refuse it); the engine must not alert it.
    await sql`
      insert into public.subscription (id, operator_id, device_id, trip_instance_id, stop_sequence, trigger, trigger_value) values
        (${SUB.member}, ${OPERATOR}, ${DEV.member}, ${L_TOUR}, 20, 'minutes', 5),
        (${SUB.outsider}, ${OPERATOR}, ${DEV.outsider}, ${L_TOUR}, 20, 'minutes', 5)`;
    // A live trip on the seed's pattern for Bus 1.
    await sql`
      insert into public.trip_instance (id, operator_id, service_date, kind, started_by, title, vehicle_id, pattern_id)
      values (${L_PATTERN}, ${OPERATOR}, ${DATE}, 'live', 'driver', ${sql.json({ ja: '臨時便', en: 'Extra run' })}, ${VEHICLE}, ${PATTERN})`;
  });

  after(async () => {
    await cleanup();
    await sql`delete from public.vehicle_state where vehicle_id = ${VEHICLE}`;
    const saved = savedVehicleState[0];
    if (saved) await sql`insert into public.vehicle_state ${sql(saved)}`;
    await store.close();
  });

  it('loads live trips: planned stops with their location and times, the title, the pattern', async () => {
    const rows = await store.loadSnapshot(START);
    const tour = rows.instances.find((i) => i.id === L_TOUR);
    assert.ok(tour);
    assert.equal(tour.kind, 'live');
    assert.equal(tour.patternId, null);
    assert.deepEqual(tour.title, { ja: '遠足', en: 'Excursion' });
    assert.deepEqual(tour.plannedStops.map((p) => p.sequence), [10, 20, 30]);
    assert.equal(tour.plannedStops[1]?.plannedArrival?.toISOString(), '2027-03-05T00:20:00.000Z');
    assert.ok(tour.plannedStops.every((p) => p.lon > 135 && p.lat > 34));
    assert.deepEqual(tour.stopEvents.map((e) => e.state), ['upcoming', 'upcoming', 'upcoming'], 'created by the planned-stop trigger');
    const onPattern = rows.instances.find((i) => i.id === L_PATTERN);
    assert.equal(onPattern?.patternId, PATTERN);
    assert.equal(onPattern.stopEvents.length, 0);

    const cache = buildCache(rows);
    const inst = cache.instances.get(L_TOUR)?.instance;
    assert.ok(inst?.itinerary);
    assert.equal(inst.itinerary.stops.length, 3);
    assert.equal(inst.timed, true);
    assert.equal(inst.startAt.toISOString(), '2027-03-05T00:00:00.000Z');
    assert.equal(cache.instances.get(L_PATTERN)?.instance.pattern?.id, PATTERN);
  });

  it('loads subscriptions to a planned stop for devices that may see the trip (its audiences)', async () => {
    const subs = (await store.loadSubscriptions()).filter((s) => Object.values(SUB).includes(s.id as never));
    assert.deepEqual(subs.map((s) => s.id), [SUB.member]);
    const [s] = subs;
    assert.ok(s);
    assert.equal(s.tripInstanceId, L_TOUR);
    assert.equal(s.patternId, null);
    assert.equal(s.routeId, null);
    assert.equal(s.routeName, null);
    assert.equal(s.stopSequence, 20);
    assert.equal(s.pushToken, 'fid-live-member');
  });

  it('alerts a live-trip subscription once, with the trip title, and records it in alert_delivery', async () => {
    const now = new Date('2027-03-05T00:16:00Z'); // 09:16 JST
    const clock = new FakeClock(now);
    const cache = buildCache(await store.loadSnapshot(now));
    const entry = cache.instances.get(L_TOUR);
    assert.ok(entry);
    const progress = { ...progressFromRow(entry.row, entry.instance), status: 'active' as const };
    const sender = new FakeSender(clock);
    const d = new AlertDispatcher({ store, sender, clock, log: silentLogger, config: { ...defaultAlertConfig, staleAfterS: 120 } });
    await d.reloadSubscriptions();
    const update = { instance: entry.instance, progress, etas: new Map([[20, new Date(now.getTime() + 240_000)]]), fixAt: now };
    d.tripUpdated(update);
    d.tripUpdated(update);
    await d.idle();
    assert.equal(sender.sent.length, 1);
    const m = sender.sent[0];
    assert.equal(m?.target, 'fid-live-member');
    assert.equal(m.payload.notification.title, 'Excursion');
    assert.equal(m.payload.data.trip_instance_id, L_TOUR);
    assert.equal(m.payload.data.trip_kind, 'live');
    const rows = await sql<{ subscription_id: string; stop_sequence: number; kind: string; result: string }[]>`
      select subscription_id, stop_sequence, kind::text as kind, result from public.alert_delivery where trip_instance_id = ${L_TOUR}`;
    assert.deepEqual([...rows], [{ subscription_id: SUB.member, stop_sequence: 20, kind: 'approaching', result: 'sent' }]);
  });

  it('runs a live trip on the seed pattern: auto start, stop events created and moved forward, completed', async () => {
    const [s] = await sql<{ coordinates: [number, number][]; length_m: number }[]>`
      select (extensions.st_asgeojson(geom::extensions.geometry)::json -> 'coordinates') as coordinates,
             extensions.st_length(geom) as length_m
        from public.shape where id = ${SHAPE}`;
    assert.ok(s);
    const plane = LocalPlane.around(s.coordinates.map(([lon, lat]) => ({ lon, lat })));
    const shape = new Polyline(s.coordinates.map(([lon, lat]) => plane.toXY({ lon, lat })), s.length_m);
    const stopM = (await sql<{ dist_along_shape: number }[]>`
      select dist_along_shape from public.pattern_stop where pattern_id = ${PATTERN} order by stop_sequence`).map((r) => r.dist_along_shape);
    const t = new Track(shape, new Date(START.getTime() - 5 * 60_000), { intervalS: 5 });
    t.dwell(6 * 60);
    for (const m of stopM.slice(1)) t.drive(m - 3, 30).dwell(30);
    const end = shape.pointAt(shape.length);
    t.goTo({ x: end.x - 150, y: end.y + 150 }, 15);

    const clock = new FakeClock(START);
    const engine = new Engine({ store, thresholds: defaultThresholds, clock, log: silentLogger });
    await engine.reload();
    for (const f of t.fixes) {
      clock.set(new Date(f.t.getTime() + 1000));
      const ll = plane.toLonLat(f.xy);
      await engine.handlePosition({
        deviceId: DEVICE, positionId: null, fixTime: f.t, lon: ll.lon, lat: ll.lat,
        speedKmh: f.speedKmh, course: f.course ?? null, accuracyM: 5, valid: true,
      });
    }
    const [inst] = await sql<{ status: string; started_by: string; vehicle_id: string; progress_m: number }[]>`
      select status::text as status, started_by::text as started_by, vehicle_id, progress_m from public.trip_instance where id = ${L_PATTERN}`;
    assert.equal(inst?.status, 'completed');
    assert.equal(inst.started_by, 'driver');
    assert.equal(inst.vehicle_id, VEHICLE);
    const events = await sql<{ state: string }[]>`
      select state::text as state from public.stop_event where trip_instance_id = ${L_PATTERN} order by stop_sequence`;
    assert.deepEqual(events.map((e) => e.state), Array(stopM.length).fill('departed'));
    // The tour (no vehicle) was not started by Bus 1.
    const [tour] = await sql<{ status: string }[]>`select status::text as status from public.trip_instance where id = ${L_TOUR}`;
    assert.equal(tour?.status, 'planned');
  });
});
