/**
 * Parity of the live API's access decisions with the database's RLS
 * (engine.md, "Live API": "for the seed data, the engine's decision 'may see
 * route / map' must equal what RLS returns for the same user").
 *
 * For the seed and a fixture operator (public, invited_map, invited_eta and
 * inactive routes; live trips with audiences and planned stops; members,
 * staff and drivers), every user's level per route, trip instance and stop
 * is compared with private.route_access, private.trip_instance_access and
 * private.stop_access, and the visible routes and stop locations with what
 * `public.route` and `public.stop_location` return under RLS.
 *
 * Needs the local Supabase database with all migrations (`npx supabase
 * start`). Creates its own operator and users (IDs e9…) and removes them.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AccessIndex } from '../../src/live/access.ts';
import { PgStore } from '../../src/store/pg.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const store = new PgStore(DATABASE_URL, { max: 3 });
const sql = store.sql;

const id = (n: string): string => `e9000000-0000-4000-8000-${n.padStart(12, '0')}`;
const OP = id('1');
const SEED_OP = 'd0000000-0000-4000-8000-000000000001';
const SEED_AUDIENCE = 'd0000000-0000-4000-8000-000000000601';
const SEED_ROUTE = 'd0000000-0000-4000-8000-000000000101';

const USERS = {
  member: id('a1'), mapper: id('a2'), tourist: id('a3'), stranger: id('a4'), revoked: id('a5'),
  editor: id('b1'), driver: id('b2'), driverNoVehicle: id('b3'),
};
const ROUTES = { pub: id('101'), map: id('102'), eta: id('103'), off: id('104') };
const STOPS = { s1: id('201'), s2: id('202'), s3: id('203'), s4: id('204'), s5: id('205'), tour: id('206') };

const FIXTURE = `
insert into auth.users (id, email, is_anonymous) values
  ('${USERS.member}', null, true), ('${USERS.mapper}', null, true), ('${USERS.tourist}', null, true),
  ('${USERS.stranger}', null, true), ('${USERS.revoked}', null, true),
  ('${USERS.editor}', 'live-parity-editor@example.test', false), ('${USERS.driver}', 'live-parity-driver@example.test', false),
  ('${USERS.driverNoVehicle}', 'live-parity-driver2@example.test', false);
insert into public.device (id) values ('${USERS.member}'), ('${USERS.mapper}'), ('${USERS.tourist}'), ('${USERS.stranger}'), ('${USERS.revoked}');

insert into public.operator (id, slug, name, default_visibility) values ('${OP}', 'live-parity-test', '{"en": "Parity"}', 'invited_eta');
insert into public.staff_role (operator_id, user_id, role) values
  ('${OP}', '${USERS.editor}', 'owner'), ('${OP}', '${USERS.driver}', 'driver'), ('${OP}', '${USERS.driverNoVehicle}', 'driver');
insert into public.route (id, operator_id, name, visibility, active, slug) values
  ('${ROUTES.pub}', '${OP}', '{"en": "pub"}', 'public', true, 'pub'),
  ('${ROUTES.map}', '${OP}', '{"en": "map"}', 'invited_map', true, 'map'),
  ('${ROUTES.eta}', '${OP}', '{"en": "eta"}', null, true, 'eta'),
  ('${ROUTES.off}', '${OP}', '{"en": "off"}', 'public', false, 'off');
insert into public.stop (id, operator_id, name, location) values
  ('${STOPS.s1}', '${OP}', '{"en": "s1"}', 'SRID=4326;POINT(135.20 34.70)'),
  ('${STOPS.s2}', '${OP}', '{"en": "s2"}', 'SRID=4326;POINT(135.21 34.70)'),
  ('${STOPS.s3}', '${OP}', '{"en": "s3"}', 'SRID=4326;POINT(135.22 34.70)'),
  ('${STOPS.s4}', '${OP}', '{"en": "s4"}', 'SRID=4326;POINT(135.23 34.70)'),
  ('${STOPS.s5}', '${OP}', '{"en": "s5"}', 'SRID=4326;POINT(135.24 34.70)'),
  ('${STOPS.tour}', '${OP}', '{"en": "tour"}', 'SRID=4326;POINT(135.78 34.99)');
insert into public.trip_pattern (id, operator_id, route_id, name) values
  ('${id('301')}', '${OP}', '${ROUTES.pub}', 'pub'), ('${id('302')}', '${OP}', '${ROUTES.map}', 'map'),
  ('${id('303')}', '${OP}', '${ROUTES.eta}', 'eta'), ('${id('304')}', '${OP}', '${ROUTES.off}', 'off');
insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset) values
  ('${OP}', '${id('301')}', 1, '${STOPS.s4}', 0, 0),
  ('${OP}', '${id('302')}', 1, '${STOPS.s2}', 0, 0), ('${OP}', '${id('302')}', 2, '${STOPS.s5}', 60, 60),
  ('${OP}', '${id('303')}', 1, '${STOPS.s1}', 0, 0), ('${OP}', '${id('303')}', 2, '${STOPS.s2}', 60, 60),
  ('${OP}', '${id('303')}', 3, '${STOPS.s3}', 120, 120),
  ('${OP}', '${id('304')}', 1, '${STOPS.s5}', 0, 0);
insert into public.service_calendar (id, operator_id, name, weekdays, start_date, end_date) values
  ('${id('501')}', '${OP}', 'all', 127, '2026-01-01', '2027-12-31');
insert into public.vehicle (id, operator_id, name) values ('${id('701')}', '${OP}', 'V1'), ('${id('702')}', '${OP}', 'V2');
insert into public.driver_vehicle (operator_id, user_id, vehicle_id) values ('${OP}', '${USERS.driver}', '${id('701')}');
insert into public.trip (id, operator_id, pattern_id, service_calendar_id, start_time, vehicle_id) values
  ('${id('801')}', '${OP}', '${id('303')}', '${id('501')}', 28800, '${id('701')}'),
  ('${id('802')}', '${OP}', '${id('303')}', '${id('501')}', 32400, null),
  ('${id('803')}', '${OP}', '${id('301')}', '${id('501')}', 28800, null);
insert into public.trip_instance (id, operator_id, service_date, kind, trip_id, vehicle_id, status) values
  ('${id('901')}', '${OP}', current_date, 'scheduled', '${id('801')}', null, 'active'),
  ('${id('902')}', '${OP}', current_date, 'scheduled', '${id('802')}', '${id('702')}', 'planned'),
  ('${id('903')}', '${OP}', current_date, 'scheduled', '${id('803')}', null, 'planned');
insert into public.trip_instance (id, operator_id, service_date, kind, route_id, vehicle_id, status, title, visible_until, ended_at) values
  ('${id('911')}', '${OP}', current_date, 'live', null, '${id('701')}', 'active', '{"en": "tour"}', null, null),
  ('${id('912')}', '${OP}', current_date, 'live', '${ROUTES.eta}', null, 'active', '{"en": "on eta"}', null, null),
  ('${id('913')}', '${OP}', current_date, 'live', null, null, 'active', '{"en": "over"}', now() - interval '1 minute', null),
  -- Yesterday's tour, ended more than a day ago: loaded, but its planned stops no longer count.
  ('${id('914')}', '${OP}', current_date - 1, 'live', null, null, 'completed', '{"en": "old"}', null, now() - interval '30 hours'),
  ('${id('915')}', '${OP}', current_date + 1, 'live', '${ROUTES.map}', '${id('702')}', 'planned', '{"en": "map trip"}', null, null);
insert into public.trip_instance_stop (operator_id, trip_instance_id, stop_sequence, stop_id) values
  ('${OP}', '${id('911')}', 1, '${STOPS.tour}'), ('${OP}', '${id('911')}', 2, '${STOPS.s1}'),
  ('${OP}', '${id('913')}', 1, '${STOPS.s3}'),
  ('${OP}', '${id('914')}', 1, '${STOPS.s5}'),
  ('${OP}', '${id('915')}', 1, '${STOPS.s3}');
insert into public.audience (id, operator_id, name) values
  ('${id('601')}', '${OP}', '{"en": "eta"}'), ('${id('602')}', '${OP}', '{"en": "map"}'), ('${id('603')}', '${OP}', '{"en": "tour"}');
insert into public.audience_route (operator_id, audience_id, route_id, can_see_map) values
  ('${OP}', '${id('601')}', '${ROUTES.eta}', true), ('${OP}', '${id('601')}', '${ROUTES.map}', false),
  ('${OP}', '${id('602')}', '${ROUTES.map}', true);
insert into public.trip_instance_audience (operator_id, trip_instance_id, audience_id, can_see_map) values
  ('${OP}', '${id('911')}', '${id('603')}', true), ('${OP}', '${id('912')}', '${id('603')}', true),
  ('${OP}', '${id('913')}', '${id('603')}', true), ('${OP}', '${id('914')}', '${id('603')}', true),
  ('${OP}', '${id('915')}', '${id('603')}', false);
insert into public.membership (operator_id, device_id, audience_id, revoked_at) values
  ('${OP}', '${USERS.member}', '${id('601')}', null), ('${OP}', '${USERS.mapper}', '${id('602')}', null),
  ('${OP}', '${USERS.tourist}', '${id('603')}', null), ('${OP}', '${USERS.revoked}', '${id('602')}', now()),
  ('${SEED_OP}', '${USERS.member}', '${SEED_AUDIENCE}', null);
-- Followed stops: the member follows three stops of the eta route (first two
-- get a location), the tourist one planned stop of the tour.
insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence) values
  ('${OP}', '${USERS.member}', '${id('303')}', 1), ('${OP}', '${USERS.member}', '${id('303')}', 2),
  ('${OP}', '${USERS.member}', '${id('303')}', 3);
insert into public.subscription (operator_id, device_id, trip_instance_id, stop_sequence) values
  ('${OP}', '${USERS.tourist}', '${id('911')}', 2);
`;

async function cleanup(): Promise<void> {
  await sql`delete from public.operator where id = ${OP}`;
  await sql`delete from public.membership where device_id = any(${Object.values(USERS)}::uuid[])`;
  await sql`delete from auth.users where id = any(${Object.values(USERS)}::uuid[])`;
}

type Claims = string | null;

/** Runs `query` as the user (role authenticated with their claims), or as a visitor (anon). */
async function asUser<T>(uid: Claims, query: (tx: typeof sql) => Promise<T>): Promise<T> {
  let result!: T;
  await sql.begin(async (tx) => {
    if (uid === null) {
      await tx`set local role anon`;
    } else {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: 'authenticated' })}, true)`;
    }
    result = await query(tx as unknown as typeof sql);
  });
  return result;
}

describe('live API access = RLS (parity)', () => {
  let index: AccessIndex;
  let now: Date;
  const routeIds = [...Object.values(ROUTES), SEED_ROUTE];
  let tripIds: string[] = [];
  let stopIds: string[] = [];
  const viewers: [string, Claims][] = [['visitor', null], ...Object.entries(USERS)];

  before(async () => {
    await cleanup();
    await sql.unsafe(FIXTURE);
    const snapshot = await store.loadLiveSnapshot();
    index = new AccessIndex(snapshot);
    now = snapshot.loadedAt;
    tripIds = snapshot.instances.filter((i) => i.operatorId === OP || i.operatorId === SEED_OP).map((i) => i.id);
    stopIds = snapshot.stops.filter((s) => s.operatorId === OP || s.operatorId === SEED_OP).map((s) => s.id);
    assert.ok(tripIds.length >= 8, 'fixture trips loaded');
  });

  after(async () => {
    await cleanup();
    await store.close();
  });

  for (const [name, uid] of viewers) {
    it(`${name}: route levels, visible routes and "may see map"`, async () => {
      const db = await asUser(uid, async (tx) => {
        const levels = await tx<{ id: string; level: number }[]>`select id, private.route_access(id) as level from unnest(${routeIds}::uuid[]) as id`;
        const visible = await tx<{ id: string }[]>`select id from public.route where id = any(${routeIds}::uuid[])`;
        return { levels, visible: new Set(visible.map((r) => r.id)) };
      });
      for (const r of db.levels) {
        const mine = index.routeAccess(uid, r.id);
        assert.equal(mine, r.level, `route ${r.id}`);
        assert.equal(mine >= 1, db.visible.has(r.id), `route ${r.id} visible`);
        assert.equal(mine >= 2, r.level >= 2, `route ${r.id} map`);
      }
    });

    it(`${name}: trip instance levels and visible trips`, async () => {
      const db = await asUser(uid, async (tx) => {
        const levels = await tx<{ id: string; level: number }[]>`select id, private.trip_instance_access(id) as level from unnest(${tripIds}::uuid[]) as id`;
        const visible = await tx<{ id: string }[]>`select id from public.trip_instance where id = any(${tripIds}::uuid[])`;
        return { levels, visible: new Set(visible.map((r) => r.id)) };
      });
      for (const r of db.levels) {
        const mine = index.tripAccess(uid, r.id, now);
        assert.equal(mine, r.level, `trip instance ${r.id}`);
        assert.equal(mine >= 1, db.visible.has(r.id), `trip instance ${r.id} visible`);
      }
    });

    it(`${name}: stop levels and stop locations (stop_location)`, async () => {
      const db = await asUser(uid, async (tx) => {
        const levels = await tx<{ id: string; level: number }[]>`select id, private.stop_access(id) as level from unnest(${stopIds}::uuid[]) as id`;
        const located = await tx<{ id: string }[]>`select id from public.stop_location where id = any(${stopIds}::uuid[])`;
        return { levels, located: new Set(located.map((r) => r.id)) };
      });
      for (const r of db.levels) {
        assert.equal(index.stopAccess(uid, r.id, now), r.level, `stop ${r.id}`);
        assert.equal(index.stopLocationVisible(uid, r.id, now), db.located.has(r.id), `stop ${r.id} location`);
      }
    });
  }

  it('the fixture covers every level', () => {
    const seen = new Set<number>();
    for (const [, uid] of viewers) {
      for (const r of routeIds) seen.add(index.routeAccess(uid, r));
      for (const t of tripIds) seen.add(index.tripAccess(uid, t, now));
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
    assert.equal(index.stopLocationVisible(USERS.member, STOPS.s1, now), true, 'first followed stop');
    assert.equal(index.stopLocationVisible(USERS.member, STOPS.s3, now), false, 'third followed stop');
  });
});
