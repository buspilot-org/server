/**
 * Alert persistence against the local Supabase database (`npx supabase db
 * reset` first): which subscriptions the engine may alert (access as RLS
 * decides it for riders), and exactly-once claims in `alert_delivery` with
 * two engine processes evaluating the same trip at the same time.
 *
 * Uses the seed's morning loop on 2027-03-03 and its own anonymous devices;
 * removes everything it created.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AlertDispatcher, defaultAlertConfig } from '../../src/alerts/dispatcher.ts';
import type { TripUpdate } from '../../src/alerts/types.ts';
import { buildCache, progressFromRow } from '../../src/core/cache.ts';
import { silentLogger } from '../../src/log.ts';
import { PgStore } from '../../src/store/pg.ts';
import { FakeClock, FakeSender } from '../replay/harness.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55322/postgres';
const DATE = '2027-03-03';
const OPERATOR = 'd0000000-0000-4000-8000-000000000001';
const ROUTE = 'd0000000-0000-4000-8000-000000000101';
const PATTERN = 'd0000000-0000-4000-8000-000000000301';
const AUDIENCE = 'd0000000-0000-4000-8000-000000000601';
const TRIP_0730 = 'd0000000-0000-4000-8000-000000000801';
const NOW = new Date('2027-03-02T22:40:00Z'); // 07:40 JST

/** Rider devices: a member, a member without push token, a revoked member, no membership. */
const DEV = {
  member: 'a1e70000-0000-4000-8000-000000000001',
  noToken: 'a1e70000-0000-4000-8000-000000000002',
  revoked: 'a1e70000-0000-4000-8000-000000000003',
  outsider: 'a1e70000-0000-4000-8000-000000000004',
} as const;
const SUB = {
  member: 'a1e70000-0000-4000-8000-0000000000a1',
  memberLoop: 'a1e70000-0000-4000-8000-0000000000a2',
  noToken: 'a1e70000-0000-4000-8000-0000000000a3',
  revoked: 'a1e70000-0000-4000-8000-0000000000a4',
  outsider: 'a1e70000-0000-4000-8000-0000000000a5',
} as const;

const store = new PgStore(DATABASE_URL, { max: 3 });
const store2 = new PgStore(DATABASE_URL, { max: 3 });
const sql = store.sql;
let tripInstanceId = '';

async function cleanup(): Promise<void> {
  await sql`delete from public.trip_instance where service_date = ${DATE}`;
  await sql`delete from auth.users where id = any(${Object.values(DEV)}::uuid[])`;
}

describe('alerts against the seeded database', () => {
  before(async () => {
    await cleanup();
    await sql`insert into auth.users (id, is_anonymous) select unnest(${Object.values(DEV)}::uuid[]), true`;
    await sql`
      insert into public.device (id, push_token, platform, language) values
        (${DEV.member}, 'fid-member', 'android', 'de'),
        (${DEV.noToken}, null, 'android', 'ja'),
        (${DEV.revoked}, 'fid-revoked', 'android', 'ja'),
        (${DEV.outsider}, 'fid-outsider', 'android', 'ja')`;
    await sql`
      insert into public.membership (operator_id, device_id, audience_id, revoked_at) values
        (${OPERATOR}, ${DEV.member}, ${AUDIENCE}, null),
        (${OPERATOR}, ${DEV.noToken}, ${AUDIENCE}, null),
        (${OPERATOR}, ${DEV.revoked}, ${AUDIENCE}, now())`;
    await sql`
      insert into public.subscription (id, operator_id, device_id, pattern_id, stop_sequence, trigger, trigger_value) values
        (${SUB.member}, ${OPERATOR}, ${DEV.member}, ${PATTERN}, 4, 'minutes', 5),
        (${SUB.memberLoop}, ${OPERATOR}, ${DEV.member}, ${PATTERN}, 5, 'stops', 1),
        (${SUB.noToken}, ${OPERATOR}, ${DEV.noToken}, ${PATTERN}, 4, 'minutes', 5),
        (${SUB.revoked}, ${OPERATOR}, ${DEV.revoked}, ${PATTERN}, 4, 'minutes', 5),
        (${SUB.outsider}, ${OPERATOR}, ${DEV.outsider}, ${PATTERN}, 4, 'minutes', 5)`;
    const [row] = await sql<{ id: string }[]>`
      insert into public.trip_instance (operator_id, service_date, kind, trip_id, status)
      values (${OPERATOR}, ${DATE}, 'scheduled', ${TRIP_0730}, 'active')
      returning id`;
    assert.ok(row);
    tripInstanceId = row.id;
  });

  after(async () => {
    await cleanup();
    await store.close();
    await store2.close();
  });

  it('loads only subscriptions of devices with a push target that may see the route', async () => {
    const subs = (await store.loadSubscriptions()).filter((s) => Object.values(SUB).includes(s.id as never));
    assert.deepEqual(subs.map((s) => s.id).sort(), [SUB.member, SUB.memberLoop].sort());
    const s = subs.find((x) => x.id === SUB.member);
    assert.ok(s);
    assert.equal(s.pushToken, 'fid-member');
    assert.equal(s.language, 'de');
    assert.equal(s.timezone, 'Asia/Tokyo');
    assert.equal(s.routeId, ROUTE);
    assert.equal(s.routeShortName, 'A');
    assert.equal(s.routeName?.ja, '朝便A');
    assert.equal(s.stopName.en, 'Motomachi');
    assert.equal(subs.find((x) => x.id === SUB.memberLoop)?.stopName.en, 'Kitano-zaka', 'the second visit of the loop');

    // The route made public: everyone with a push target.
    await sql`update public.route set visibility = 'public' where id = ${ROUTE}`;
    try {
      const pub = (await store.loadSubscriptions()).filter((x) => Object.values(SUB).includes(x.id as never));
      assert.deepEqual(pub.map((x) => x.id).sort(), [SUB.member, SUB.memberLoop, SUB.revoked, SUB.outsider].sort());
    } finally {
      await sql`update public.route set visibility = null where id = ${ROUTE}`;
    }
  });

  it('a claim succeeds exactly once, even from two connections at the same time', async () => {
    const claim = { operatorId: OPERATOR, subscriptionId: SUB.member, tripInstanceId, stopSequence: 4, kind: 'passed' as const };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : store2).claimDelivery(claim)));
    const ids = results.filter((r) => r !== null);
    assert.equal(ids.length, 1);
    const [row] = await sql<{ result: string; sent_at: Date | null }[]>`select result, sent_at from public.alert_delivery where id = ${ids[0] ?? ''}`;
    assert.deepEqual(row, { result: 'pending', sent_at: null });

    await store.finishDelivery(ids[0] ?? '', NOW, 'sent');
    const [done] = await sql<{ result: string; sent_at: Date | null }[]>`select result, sent_at from public.alert_delivery where id = ${ids[0] ?? ''}`;
    assert.deepEqual(done, { result: 'sent', sent_at: NOW });
  });

  it('two engines evaluating the same trip at the same time send each alert once', async () => {
    const clock = new FakeClock(NOW);
    const cache = buildCache(await store.loadSnapshot(NOW));
    const entry = cache.instances.get(tripInstanceId);
    assert.ok(entry, 'trip instance in the cache');
    const progress = { ...progressFromRow(entry.row, entry.instance), status: 'active' as const };
    const update: TripUpdate = { instance: entry.instance, progress, etas: new Map([[4, new Date(NOW.getTime() + 240_000)]]), fixAt: NOW };
    const engines = [store, store2].map((st) => {
      const sender = new FakeSender(clock);
      const d = new AlertDispatcher({ store: st, sender, clock, log: silentLogger, config: { ...defaultAlertConfig, staleAfterS: 120 } });
      return { d, sender };
    });
    await Promise.all(engines.map((e) => e.d.reloadSubscriptions()));
    for (let i = 0; i < 3; i++) for (const e of engines) e.d.tripUpdated(update);
    await Promise.all(engines.map((e) => e.d.idle()));

    const sent = engines.flatMap((e) => e.sender.sent).filter((m) => m.payload.data.trip_instance_id === tripInstanceId);
    assert.equal(sent.length, 1);
    const [first] = sent;
    assert.ok(first);
    assert.equal(first.target, 'fid-member');
    assert.match(first.payload.notification.body, /^Der Bus erreicht Motomachi in etwa 4 Min\.$/);
    const rows = await sql<{ subscription_id: string; kind: string; result: string }[]>`
      select subscription_id, kind::text as kind, result from public.alert_delivery
       where trip_instance_id = ${tripInstanceId} and kind = 'approaching'`;
    assert.deepEqual([...rows], [{ subscription_id: SUB.member, kind: 'approaching', result: 'sent' }]);
  });

  it('a claim for a deleted subscription is skipped; an invalid token is cleared only if unchanged', async () => {
    await sql`delete from public.subscription where id = ${SUB.outsider}`;
    assert.equal(await store.claimDelivery({ operatorId: OPERATOR, subscriptionId: SUB.outsider, tripInstanceId, stopSequence: 4, kind: 'approaching' }), null);

    await store.clearPushToken(DEV.revoked, 'some-older-token');
    const [kept] = await sql<{ push_token: string | null }[]>`select push_token from public.device where id = ${DEV.revoked}`;
    assert.equal(kept?.push_token, 'fid-revoked');
    await store.clearPushToken(DEV.revoked, 'fid-revoked');
    const [cleared] = await sql<{ push_token: string | null }[]>`select push_token from public.device where id = ${DEV.revoked}`;
    assert.equal(cleared?.push_token, null);
  });
});
