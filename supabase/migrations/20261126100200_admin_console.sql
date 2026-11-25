-- Admin console needs (buspilot-org/admin#1, "Needed server changes"):
-- post categories, atomic revocation of invite codes, operator branding
-- (documented keys, Storage bucket for logo and cover image).

-- -----------------------------------------------------------------------------
-- Post categories
-- -----------------------------------------------------------------------------

-- Riders mute push per category ("mute general, keep cancellations";
-- rider-app.md). Existing posts become `general`.
create type public.post_category as enum ('cancellation', 'delay', 'general', 'event');

alter table public.post add column category public.post_category not null default 'general';

comment on column public.post.category is
  'cancellation, delay, general or event; riders choose push per category.';

-- -----------------------------------------------------------------------------
-- Revoke an invite code, optionally with the memberships made with it
-- -----------------------------------------------------------------------------

-- One transaction: either the code and its memberships are revoked, or
-- nothing is. Runs with the caller's rights, so RLS (editors of the
-- operator) decides; idempotent (an already revoked code keeps its
-- revoked_at). Returns the number of memberships revoked now. Revoked
-- memberships stay (the device cannot rejoin with another code of the same
-- audience); their subscriptions to routes the device can no longer see are
-- deleted by the membership trigger.
create function public.revoke_invite_code(p_invite_code_id uuid, p_revoke_memberships boolean default false)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_operator_id uuid;
  v_revoked integer := 0;
begin
  select ic.operator_id into v_operator_id
    from public.invite_code ic
   where ic.id = p_invite_code_id
   for update;
  if v_operator_id is null or not private.can_edit(v_operator_id) then
    raise exception 'invite code not found or not allowed' using errcode = 'insufficient_privilege';
  end if;

  update public.invite_code
     set revoked_at = coalesce(revoked_at, now())
   where id = p_invite_code_id;

  if p_revoke_memberships then
    update public.membership
       set revoked_at = now()
     where invite_code_id = p_invite_code_id
       and revoked_at is null;
    get diagnostics v_revoked = row_count;
  end if;

  return v_revoked;
end;
$$;

comment on function public.revoke_invite_code(uuid, boolean) is
  'Revokes an invite code and, if asked, the active memberships made with it, in one transaction (editors). Returns the number of memberships revoked.';

revoke execute on function public.revoke_invite_code(uuid, boolean) from public, anon;
grant execute on function public.revoke_invite_code(uuid, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Operator branding
-- -----------------------------------------------------------------------------

-- operator.branding keys (all optional; null = not set):
--   logo_url    https URL of the logo, normally the public URL of
--               operator-branding/<operator_id>/logo.<ext>
--   cover_url   https URL of the cover image (same bucket, cover.<ext>)
--   color       brand colour, RRGGBB without '#', like route.color
--   text_color  text colour on `color`, RRGGBB (the admin console picks it
--               for contrast)
-- Other keys are rejected, so the apps can rely on this list.
create function private.is_valid_branding(p_branding jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_branding) = 'object'
    and not exists (
      select 1
        from jsonb_each(p_branding) as e(key, val)
       where e.key not in ('logo_url', 'cover_url', 'color', 'text_color')
          or (
            jsonb_typeof(e.val) <> 'null'
            and (
              jsonb_typeof(e.val) <> 'string'
              or (e.key in ('logo_url', 'cover_url') and (e.val #>> '{}') !~ '^https://[^\s]+$')
              or (e.key in ('color', 'text_color') and (e.val #>> '{}') !~ '^[0-9A-Fa-f]{6}$')
            )
          )
    )
$$;

alter table public.operator drop constraint operator_branding_check;
alter table public.operator
  add constraint operator_branding_check check (private.is_valid_branding(branding));

comment on column public.operator.branding is
  'Logo, cover and colours for the apps. Keys: logo_url, cover_url (https URLs, normally of the operator-branding bucket), color, text_color (RRGGBB without #). All optional; other keys are rejected.';

-- Storage bucket for logos and cover images. Public (anyone may load the
-- files by URL: they are shown on public pages and rider cards); only owners
-- of the operator write, under "<operator_id>/…". Small raster images only:
-- no SVG (scripts) and nothing else.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('operator-branding', 'operator-branding', true, 2 * 1024 * 1024,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The operator a branding object belongs to: the first path segment, if it
-- is a UUID.
create function private.branding_object_operator(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 1)::uuid
  end
$$;

-- Owners list, upload, replace and delete their operator's files. Reading a
-- file by URL needs no policy (public bucket). Listing is for owners only,
-- so nobody can enumerate other operators' folders.
create policy "owners read branding files" on storage.objects
  for select to authenticated
  using (bucket_id = 'operator-branding' and private.is_owner(private.branding_object_operator(name)));

create policy "owners upload branding files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'operator-branding' and private.is_owner(private.branding_object_operator(name)));

create policy "owners replace branding files" on storage.objects
  for update to authenticated
  using (bucket_id = 'operator-branding' and private.is_owner(private.branding_object_operator(name)))
  with check (bucket_id = 'operator-branding' and private.is_owner(private.branding_object_operator(name)));

create policy "owners delete branding files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'operator-branding' and private.is_owner(private.branding_object_operator(name)));

revoke execute on all functions in schema private from public;
grant execute on function
  private.is_valid_branding(jsonb),
  private.branding_object_operator(text)
to anon, authenticated, service_role;
