-- Invite code redemption (security definer function) with the demo code from
-- seed.sql and a few test codes.
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, is_anonymous) values
  ('f0000000-0000-4000-8000-0000000000d1', true),
  ('f0000000-0000-4000-8000-0000000000d2', true),
  ('f0000000-0000-4000-8000-0000000000d3', true);

insert into public.invite_code (operator_id, audience_id, code_hash, expires_at, max_uses, uses, revoked_at) values
  ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000601',
   private.hash_invite_code('EXPIRED-1'), now() - interval '1 day', null, 0, null),
  ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000601',
   private.hash_invite_code('REVOKED-1'), null, null, 0, now()),
  ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000601',
   private.hash_invite_code('USEDUP-1'), null, 1, 1, null);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-0000000000d1", "role": "authenticated", "is_anonymous": true}', true);

select is_empty(
  $$ select 1 from public.route where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'before redeeming, the rider sees no route of the demo school'
);
select results_eq(
  $$ select status, operator_id, audience_id from public.redeem_invite_code('demo kobe 2026') $$,
  $$ values ('joined', 'd0000000-0000-4000-8000-000000000001'::uuid, 'd0000000-0000-4000-8000-000000000601'::uuid) $$,
  'the demo code works in any case and spacing'
);
select is((select count(*) from public.device), 1::bigint, 'redeeming created the device row');
select set_eq(
  $$ select id from public.route where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  array['d0000000-0000-4000-8000-000000000101']::uuid[],
  'after redeeming, the rider sees the route'
);
select is_empty(
  $$ select 1 from public.stop_location where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'the demo audience has arrival times only: no stop locations'
);
select is(
  (select status from public.redeem_invite_code('DEMO-KOBE-2026')),
  'already_member',
  'redeeming twice does not create a second membership'
);
select is((select count(*) from public.membership), 1::bigint, 'one membership');

select is((select status from public.redeem_invite_code('EXPIRED-1')), 'invalid', 'expired code is invalid');
select is((select status from public.redeem_invite_code('REVOKED-1')), 'invalid', 'revoked code is invalid');
select is((select status from public.redeem_invite_code('USEDUP-1')), 'invalid', 'used-up code is invalid');
select is((select status from public.redeem_invite_code('NO-SUCH-CODE')), 'invalid', 'unknown code is invalid');

reset role;
select is(
  (select uses from public.invite_code where code_hash = private.hash_invite_code('DEMO-KOBE-2026')),
  1,
  'uses counts new memberships only'
);

-- Revoked members cannot rejoin with the same code.
update public.membership set revoked_at = now()
 where device_id = 'f0000000-0000-4000-8000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-0000000000d1", "role": "authenticated", "is_anonymous": true}', true);
select is((select status from public.redeem_invite_code('DEMO-KOBE-2026')), 'revoked', 'a revoked member cannot rejoin');
select is_empty(
  $$ select 1 from public.route where operator_id = 'd0000000-0000-4000-8000-000000000001' $$,
  'after revocation, the rider sees no route of the demo school'
);
reset role;

-- Retention: inactive devices and anonymous users without a device go.
insert into auth.users (id, is_anonymous, created_at) values
  ('f0000000-0000-4000-8000-0000000000e1', true, now() - interval '200 days'),
  ('f0000000-0000-4000-8000-0000000000e2', true, now() - interval '200 days'),
  ('f0000000-0000-4000-8000-0000000000e3', true, now() - interval '200 days');
insert into public.device (id, last_seen_at) values
  ('f0000000-0000-4000-8000-0000000000e1', now() - interval '91 days'),
  ('f0000000-0000-4000-8000-0000000000e2', now() - interval '10 days');
select private.purge_expired_data();
select set_eq(
  $$ select id from auth.users where id::text like 'f0000000-0000-4000-8000-0000000000e_' $$,
  array['f0000000-0000-4000-8000-0000000000e2']::uuid[],
  'purge deletes inactive devices and old anonymous users without a device'
);
select throws_ok(
  $$ update public.device set last_seen_at = '9999-01-01' where id = 'f0000000-0000-4000-8000-0000000000e2' $$,
  '23514', null, 'last_seen_at cannot be pushed into the future'
);

-- Throttling: 10 failures within an hour block further attempts, even with a
-- valid code.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-0000000000d2", "role": "authenticated", "is_anonymous": true}', true);
select is(
  (select count(*) from generate_series(1, 10) as i, lateral public.redeem_invite_code('WRONG-' || i) r where r.status = 'invalid'),
  10::bigint,
  '10 wrong codes in a row'
);
select is(
  (select status from public.redeem_invite_code('DEMO-KOBE-2026')),
  'rate_limited',
  'after 10 failed attempts, redemption is rate limited'
);

-- Another rider is not affected.
select set_config('request.jwt.claims', '{"sub": "f0000000-0000-4000-8000-0000000000d3", "role": "authenticated", "is_anonymous": true}', true);
select is((select status from public.redeem_invite_code('DEMO-KOBE-2026')), 'joined', 'other riders are not throttled');

select * from finish();
rollback;
