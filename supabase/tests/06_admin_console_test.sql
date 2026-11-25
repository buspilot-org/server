-- Admin console needs: post categories, revoke_invite_code(), operator
-- branding (keys and Storage bucket). Uses the demo operator from seed.sql
-- plus a second operator.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

insert into auth.users (id, email, is_anonymous) values
  ('e6000000-0000-4000-8000-000000000001', 'owner-demo@example.test', false),
  ('e6000000-0000-4000-8000-000000000002', 'editor-demo@example.test', false),
  ('e6000000-0000-4000-8000-000000000003', 'driver-demo@example.test', false),
  ('e6000000-0000-4000-8000-000000000004', 'owner-other@example.test', false),
  ('f6000000-0000-4000-8000-000000000001', null, true),
  ('f6000000-0000-4000-8000-000000000002', null, true);

insert into public.operator (id, slug, name) values
  ('e6000000-0000-4000-8000-0000000000f1', 'other-admin-test', '{"en": "Other"}');

insert into public.staff_role (operator_id, user_id, role) values
  ('d0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'owner'),
  ('d0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', 'editor'),
  ('d0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000003', 'driver'),
  ('e6000000-0000-4000-8000-0000000000f1', 'e6000000-0000-4000-8000-000000000004', 'owner');

-- Two devices joined with the demo code; one subscribes to a stop.
insert into public.device (id) values
  ('f6000000-0000-4000-8000-000000000001'),
  ('f6000000-0000-4000-8000-000000000002');
insert into public.membership (operator_id, device_id, audience_id, invite_code_id)
select 'd0000000-0000-4000-8000-000000000001', d.id, 'd0000000-0000-4000-8000-000000000601', ic.id
  from (values ('f6000000-0000-4000-8000-000000000001'::uuid), ('f6000000-0000-4000-8000-000000000002'::uuid)) as d (id)
 cross join public.invite_code ic
 where ic.operator_id = 'd0000000-0000-4000-8000-000000000001';
insert into public.subscription (operator_id, device_id, pattern_id, stop_sequence)
values ('d0000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000301', 3);

-- Post categories -------------------------------------------------------------
select is(
  (select category::text from public.post where operator_id = 'd0000000-0000-4000-8000-000000000001' limit 1),
  'general',
  'existing posts are general'
);
select enum_has_labels('public', 'post_category', array['cancellation', 'delay', 'general', 'event'],
  'post categories: cancellation, delay, general, event');

-- Branding keys ---------------------------------------------------------------
select lives_ok(
  $$ update public.operator
        set branding = '{"logo_url": "https://example.test/logo.png", "cover_url": null, "color": "1E6FD9", "text_color": "FFFFFF"}'
      where id = 'd0000000-0000-4000-8000-000000000001' $$,
  'documented branding keys are accepted (null = not set)'
);
select throws_ok(
  $$ update public.operator set branding = '{"logo": "https://example.test/logo.png"}'
      where id = 'd0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'unknown branding keys are rejected'
);
select throws_ok(
  $$ update public.operator set branding = '{"logo_url": "http://example.test/logo.png"}'
      where id = 'd0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'logo_url must be https'
);
select throws_ok(
  $$ update public.operator set branding = '{"color": "#1E6FD9"}'
      where id = 'd0000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'colours are RRGGBB without #, like route.color'
);

-- Storage bucket -------------------------------------------------------------
select results_eq(
  $$ select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'operator-branding' $$,
  $$ values (true, 2097152::bigint, array['image/png', 'image/jpeg', 'image/webp']) $$,
  'operator-branding bucket: public read, 2 MiB, raster images only'
);

-- Owner of the demo operator.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner_id)
     values ('operator-branding', 'd0000000-0000-4000-8000-000000000001/logo.png', 'e6000000-0000-4000-8000-000000000001') $$,
  'owner uploads a logo into the operator''s folder'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('operator-branding', 'e6000000-0000-4000-8000-0000000000f1/logo.png') $$,
  '42501', null, 'owner cannot upload into another operator''s folder'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('operator-branding', 'logo.png') $$,
  '42501', null, 'files outside an operator folder are rejected'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'operator-branding'),
  1::bigint,
  'owner lists its own branding files'
);

-- Editor: no branding writes (owner-only, like operator settings).
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('operator-branding', 'd0000000-0000-4000-8000-000000000001/cover.png') $$,
  '42501', null, 'editor cannot upload branding files'
);
-- The Storage API deletes with this setting on (storage.protect_delete).
select set_config('storage.allow_delete_query', 'true', true);
select is_empty(
  $$ delete from storage.objects where bucket_id = 'operator-branding' returning 1 $$,
  'editor cannot delete branding files'
);

-- Owner of the other operator: cannot see or replace the demo logo.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000004", "role": "authenticated"}', true);
select is_empty(
  $$ select 1 from storage.objects where bucket_id = 'operator-branding' $$,
  'other operators'' owners cannot list the demo operator''s files'
);
select is_empty(
  $$ update storage.objects set metadata = '{}' where bucket_id = 'operator-branding' returning 1 $$,
  'other operators'' owners cannot replace the demo operator''s files'
);

-- Anonymous visitors cannot list either (they load public URLs).
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is_empty(
  $$ select 1 from storage.objects where bucket_id = 'operator-branding' $$,
  'anon cannot list branding files'
);

-- The owner deletes its logo.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select results_eq(
  $$ with d as (delete from storage.objects where bucket_id = 'operator-branding' returning 1) select count(*) from d $$,
  $$ values (1::bigint) $$,
  'owner deletes its own branding file'
);

-- revoke_invite_code() --------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000003", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.revoke_invite_code((select id from public.invite_code limit 1), true) $$,
  '42501', null, 'drivers cannot revoke invite codes'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000004", "role": "authenticated"}', true);
select throws_ok(
  $$ select public.revoke_invite_code('00000000-0000-4000-8000-000000000000', false) $$,
  '42501', null, 'unknown codes are refused'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f6000000-0000-4000-8000-000000000001", "role": "authenticated", "is_anonymous": true}', true);
select throws_ok(
  format('select public.revoke_invite_code(%L, true)',
         (select ic.id from public.invite_code ic join public.membership m on m.invite_code_id = ic.id limit 1)),
  '42501', null, 'riders cannot revoke invite codes'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e6000000-0000-4000-8000-000000000002", "role": "authenticated"}', true);
select is(
  public.revoke_invite_code((select id from public.invite_code where operator_id = 'd0000000-0000-4000-8000-000000000001'), false),
  0,
  'editor revokes the code only: no memberships revoked'
);
select ok(
  (select revoked_at is not null from public.invite_code where operator_id = 'd0000000-0000-4000-8000-000000000001')
  and (select count(*) from public.membership where invite_code_id is not null and revoked_at is null) = 2,
  'the code is revoked, the memberships stay active'
);
select is(
  public.revoke_invite_code((select id from public.invite_code where operator_id = 'd0000000-0000-4000-8000-000000000001'), true),
  2,
  'again with memberships: both memberships made with the code are revoked'
);
select is(
  public.revoke_invite_code((select id from public.invite_code where operator_id = 'd0000000-0000-4000-8000-000000000001'), true),
  0,
  'idempotent: nothing left to revoke'
);

reset role;
select is(
  (select count(*) from public.subscription where device_id = 'f6000000-0000-4000-8000-000000000001'),
  0::bigint,
  'the revoked device''s subscriptions to the invited route are gone'
);
select ok(
  not has_function_privilege('anon', 'public.revoke_invite_code(uuid, boolean)', 'execute'),
  'anon cannot call revoke_invite_code'
);

select * from finish();
rollback;
