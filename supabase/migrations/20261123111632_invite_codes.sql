-- Invite codes: creation (editors) and redemption (rider devices).
--
-- Codes are 10 characters from a 32-character alphabet without 0/O/1/I
-- (50 bits), shown as XXXXX-XXXXX. Only sha256(normalised code) is stored.
-- Normalising (upper case, letters and digits only) lets riders type the code
-- with or without the dash and in any case.

create function private.hash_invite_code(p_code text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(
    extensions.digest(regexp_replace(upper(p_code), '[^A-Z0-9]', '', 'g'), 'sha256'),
    'hex'
  )
$$;

create function private.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 characters
  v_bytes bytea := extensions.gen_random_bytes(10);
  v_code text := '';
begin
  -- 256 is a multiple of 32, so `byte % 32` is uniform.
  for i in 0..9 loop
    v_code := v_code || substr(v_alphabet, get_byte(v_bytes, i) % 32 + 1, 1);
    if i = 4 then
      v_code := v_code || '-';
    end if;
  end loop;
  return v_code;
end;
$$;

-- Failed redemption attempts per user, for throttling. Not exposed.
create table private.invite_redemption_failure (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index invite_redemption_failure_user_idx on private.invite_redemption_failure (user_id, attempted_at);

alter table private.invite_redemption_failure enable row level security;
revoke all on private.invite_redemption_failure from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Create a code (editors). Runs with the caller's rights, so RLS applies.
-- Returns the plain code once; it cannot be retrieved later.
-- -----------------------------------------------------------------------------

create function public.create_invite_code(
  p_audience_id uuid,
  p_label text default null,
  p_expires_at timestamptz default null,
  p_max_uses integer default null
)
returns table (invite_code_id uuid, code text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_operator_id uuid;
  v_code text;
  v_id uuid;
begin
  select a.operator_id into v_operator_id from public.audience a where a.id = p_audience_id;
  if v_operator_id is null or not private.can_edit(v_operator_id) then
    raise exception 'audience not found or not allowed' using errcode = 'insufficient_privilege';
  end if;

  v_code := private.generate_invite_code();
  insert into public.invite_code (operator_id, audience_id, code_hash, label, expires_at, max_uses, created_by)
  values (v_operator_id, p_audience_id, private.hash_invite_code(v_code), p_label, p_expires_at, p_max_uses, auth.uid())
  returning id into v_id;

  return query select v_id, v_code;
end;
$$;

revoke execute on function public.create_invite_code(uuid, text, timestamptz, integer) from public, anon;
grant execute on function public.create_invite_code(uuid, text, timestamptz, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- Redeem a code (rider devices)
-- -----------------------------------------------------------------------------

-- Returns status:
--   joined          new membership created
--   already_member  the device already has an active membership in the audience
--   invalid         unknown, expired, revoked or used-up code (not told apart,
--                   so the result does not reveal whether a code exists)
--   rate_limited    10 failed attempts within the last hour
-- Creates the device row if the app has not done so yet.
create function public.redeem_invite_code(p_code text)
returns table (status text, operator_id uuid, audience_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.invite_code%rowtype;
  v_failures integer;
begin
  if v_uid is null then
    raise exception 'sign in (anonymously) first' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_failures
    from private.invite_redemption_failure f
   where f.user_id = v_uid
     and f.attempted_at > now() - interval '1 hour';
  if v_failures >= 10 then
    return query select 'rate_limited'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_invite
    from public.invite_code ic
   where ic.code_hash = private.hash_invite_code(coalesce(p_code, ''))
   for update;

  if not found
     or v_invite.revoked_at is not null
     or (v_invite.expires_at is not null and v_invite.expires_at <= now())
     or (v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses) then
    insert into private.invite_redemption_failure (user_id) values (v_uid);
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.device (id) values (v_uid)
  on conflict (id) do update set last_seen_at = now();

  if exists (
    select 1 from public.membership m
     where m.device_id = v_uid
       and m.audience_id = v_invite.audience_id
       and m.revoked_at is null
  ) then
    return query select 'already_member'::text, v_invite.operator_id, v_invite.audience_id;
    return;
  end if;

  insert into public.membership (operator_id, device_id, audience_id, invite_code_id)
  values (v_invite.operator_id, v_uid, v_invite.audience_id, v_invite.id);

  update public.invite_code set uses = uses + 1 where id = v_invite.id;

  return query select 'joined'::text, v_invite.operator_id, v_invite.audience_id;
end;
$$;

revoke execute on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;
