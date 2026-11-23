-- Buspilot data model: tables, types and constraints.
--
-- Design: internal/concept/data-model.md, arrival-alerts.md, privacy-and-access.md,
-- server.md and boarding-check.md (private repository buspilot-org/internal).
--
-- Conventions
-- - Every tenant table has `operator_id`. Child tables reference their parent
--   with a composite foreign key (operator_id, parent_id), so a row can never
--   point to another operator's data, whatever the API caller sends.
-- - Primary keys are UUIDs. Tables that map to GTFS have `gtfs_id`, unique per
--   operator.
-- - Times of day are seconds since local midnight (integer, may exceed 24 h
--   for trips past midnight, like GTFS). Timestamps are timestamptz; the
--   operator's time zone is `operator.timezone`.
-- - Translatable text is jsonb keyed by language: {"ja": "…", "en": "…"}.
-- - Identities live in Supabase Auth (`auth.users`): staff sign in with email,
--   rider devices sign in anonymously. No rider names, emails or phone numbers.
-- - Raw vehicle positions stay in Traccar. Only the current vehicle state is
--   stored here (`vehicle_state`).

-- Schema for helper functions and tables that must not be exposed through the
-- Data API (only `public` and `graphql_public` are). RLS policies call the
-- helpers, so API roles need USAGE on the schema.
create schema private;
grant usage on schema private to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Translatable text: a non-empty object of language tag → string.
create function private.is_i18n_text(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and value <> '{}'::jsonb
    and not exists (
      select 1
      from jsonb_each(value) as e(key, val)
      where e.key !~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'
         or jsonb_typeof(e.val) <> 'string'
    )
$$;

comment on function private.is_i18n_text(jsonb) is
  'True for translatable text: a non-empty jsonb object keyed by language tag with string values.';

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

create type public.route_visibility as enum (
  'public',       -- anyone with the link sees the map
  'invited_map',  -- invited riders see the map
  'invited_eta'   -- invited riders see arrival times only, no map
);

create type public.staff_role_kind as enum ('owner', 'editor', 'driver');
create type public.shape_source as enum ('recording', 'drawn', 'import');
create type public.calendar_exception_type as enum ('added', 'removed');
create type public.route_recording_status as enum ('recording', 'review', 'converted', 'discarded');
create type public.trip_instance_kind as enum ('scheduled', 'live');
create type public.trip_instance_status as enum ('planned', 'active', 'completed', 'cancelled');
create type public.trip_started_by as enum ('schedule', 'driver');
create type public.stop_event_state as enum ('upcoming', 'approaching', 'arrived', 'departed', 'passed');
create type public.alert_trigger as enum ('minutes', 'stops');
create type public.alert_kind as enum ('approaching', 'passed', 'delayed', 'cancelled');
create type public.device_platform as enum ('ios', 'android', 'web');
create type public.vehicle_event_type as enum ('tag_seen', 'tag_gone', 'tags_on_board', 'device_health');
create type public.boarding_event_kind as enum ('boarded', 'alighted', 'on_board_at_trip_end');

-- -----------------------------------------------------------------------------
-- Operator (tenant)
-- -----------------------------------------------------------------------------

create table public.operator (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 63),
  name jsonb not null check (private.is_i18n_text(name)),
  timezone text not null default 'Asia/Tokyo',
  languages text[] not null default '{ja,en}' check (cardinality(languages) > 0),
  -- Logo, colour, cover image (Storage paths), shown in the app.
  branding jsonb not null default '{}' check (jsonb_typeof(branding) = 'object'),
  default_visibility public.route_visibility not null default 'invited_eta',
  plan text not null default 'demo',
  -- Boarding check (BLE tags) stores who boarded where: off unless the
  -- operator turns it on (boarding-check.md).
  boarding_check_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operator is 'The tenant: a school, kindergarten, hotel, club … GTFS agency.';

-- -----------------------------------------------------------------------------
-- Staff
-- -----------------------------------------------------------------------------

-- Staff identities are Supabase Auth users (email, passkeys). This table only
-- links a user to an operator with a role. One role per user and operator.
create table public.staff_role (
  operator_id uuid not null references public.operator (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.staff_role_kind not null,
  created_at timestamptz not null default now(),
  primary key (operator_id, user_id)
);

create index staff_role_user_id_idx on public.staff_role (user_id);

-- Anonymous (rider) sessions must never hold a staff role.
create function private.staff_role_reject_anonymous()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users u where u.id = new.user_id and u.is_anonymous) then
    raise exception 'anonymous users cannot be staff' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger staff_role_reject_anonymous
  before insert or update of user_id on public.staff_role
  for each row execute function private.staff_role_reject_anonymous();

-- Every operator keeps at least one owner. Deleting the operator itself
-- (cascade) is allowed.
create function private.staff_role_keep_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Serialise owner changes per operator, so two owners cannot demote each
  -- other at the same time.
  perform 1 from public.operator o where o.id = old.operator_id for update;

  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.operator_id <> old.operator_id)
     and exists (select 1 from public.operator o where o.id = old.operator_id)
     and not exists (
       select 1 from public.staff_role sr
        where sr.operator_id = old.operator_id
          and sr.role = 'owner'
          and sr.user_id <> old.user_id
     ) then
    raise exception 'an operator needs at least one owner' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

-- Deleting the auth user of an operator's only owner fails too: transfer
-- ownership or delete the operator first.
create trigger staff_role_keep_owner
  after update or delete on public.staff_role
  for each row execute function private.staff_role_keep_owner();

-- -----------------------------------------------------------------------------
-- Schedule (GTFS part)
-- -----------------------------------------------------------------------------

create table public.route (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  gtfs_id text,
  name jsonb not null check (private.is_i18n_text(name)),
  short_name text,
  color text check (color ~ '^[0-9A-Fa-f]{6}$'),
  text_color text check (text_color ~ '^[0-9A-Fa-f]{6}$'),
  -- null = operator.default_visibility
  visibility public.route_visibility,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, gtfs_id)
);

create table public.stop (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  gtfs_id text,
  name jsonb not null check (private.is_i18n_text(name)),
  location extensions.geography(Point, 4326) not null,
  notes jsonb check (private.is_i18n_text(notes)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, gtfs_id)
);

create index stop_location_idx on public.stop using gist (location);

comment on column public.stop.location is
  'Hidden from the Data API for riders who may not see the map; read it through the stop_location view.';

create table public.shape (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  gtfs_id text,
  geom extensions.geography(LineString, 4326) not null,
  source public.shape_source not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, gtfs_id)
);

-- Not in GTFS: the ordered stops plus time offsets that many trips share.
create table public.trip_pattern (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  route_id uuid not null,
  shape_id uuid,
  name text not null,
  -- GTFS direction_id
  direction smallint check (direction in (0, 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  foreign key (operator_id, route_id) references public.route (operator_id, id) on delete cascade,
  -- Deferred, so deleting a whole operator (cascade) works; deleting a shape
  -- that is still in use fails at commit.
  foreign key (operator_id, shape_id) references public.shape (operator_id, id) deferrable initially deferred
);

create index trip_pattern_route_id_idx on public.trip_pattern (operator_id, route_id);
create index trip_pattern_shape_id_idx on public.trip_pattern (operator_id, shape_id);

-- GTFS stop_times, once per pattern. The same stop may appear twice with a
-- different stop_sequence (loops).
create table public.pattern_stop (
  operator_id uuid not null,
  pattern_id uuid not null,
  stop_sequence integer not null check (stop_sequence >= 0),
  stop_id uuid not null,
  -- Seconds from trip start.
  arrival_offset integer not null check (arrival_offset >= 0),
  departure_offset integer not null,
  -- Metres along the shape (GTFS shape_dist_traveled).
  dist_along_shape double precision check (dist_along_shape >= 0),
  primary key (pattern_id, stop_sequence),
  unique (operator_id, pattern_id, stop_sequence),
  check (departure_offset >= arrival_offset),
  foreign key (operator_id, pattern_id) references public.trip_pattern (operator_id, id) on delete cascade,
  foreign key (operator_id, stop_id) references public.stop (operator_id, id) deferrable initially deferred
);

create index pattern_stop_stop_id_idx on public.pattern_stop (operator_id, stop_id);

-- GTFS calendar. weekdays: bit 0 = Monday … bit 6 = Sunday.
create table public.service_calendar (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  gtfs_id text,
  name text not null,
  weekdays smallint not null check (weekdays between 0 and 127),
  start_date date not null,
  end_date date not null,
  skip_national_holidays boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, gtfs_id),
  check (end_date >= start_date)
);

-- GTFS calendar_dates, stored as date ranges (school holidays) and expanded on
-- export. A single day has start_date = end_date.
create table public.calendar_exception (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  calendar_id uuid not null,
  start_date date not null,
  end_date date not null,
  type public.calendar_exception_type not null,
  reason text,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  foreign key (operator_id, calendar_id) references public.service_calendar (operator_id, id) on delete cascade
);

create index calendar_exception_calendar_id_idx on public.calendar_exception (operator_id, calendar_id);

create table public.trip (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  gtfs_id text,
  pattern_id uuid not null,
  service_calendar_id uuid not null,
  -- Seconds since local midnight; < 48 h.
  start_time integer not null check (start_time >= 0 and start_time < 172800),
  headsign jsonb check (private.is_i18n_text(headsign)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, gtfs_id),
  foreign key (operator_id, pattern_id) references public.trip_pattern (operator_id, id) on delete cascade,
  foreign key (operator_id, service_calendar_id) references public.service_calendar (operator_id, id) deferrable initially deferred
);

create index trip_pattern_id_idx on public.trip (operator_id, pattern_id);
create index trip_service_calendar_id_idx on public.trip (operator_id, service_calendar_id);

-- -----------------------------------------------------------------------------
-- Vehicles
-- -----------------------------------------------------------------------------

create table public.vehicle (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  name text not null,
  -- Traccar device identifier (uniqueId). One Traccar server for all operators.
  traccar_device_id text unique,
  capacity integer check (capacity > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);

-- Credential for the vehicle app → engine "Vehicle events" API. Only the hash
-- of the bearer token is stored.
create table public.vehicle_credential (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  vehicle_id uuid not null,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete cascade
);

create index vehicle_credential_vehicle_id_idx on public.vehicle_credential (operator_id, vehicle_id);

create table public.route_recording (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  vehicle_id uuid,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Raw track; deleted once the recording is turned into a pattern.
  track extensions.geography(LineString, 4326),
  suggested_stops jsonb not null default '[]' check (jsonb_typeof(suggested_stops) = 'array'),
  status public.route_recording_status not null default 'recording',
  pattern_id uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (status <> 'converted' or (track is null and pattern_id is not null)),
  check (ended_at is null or ended_at >= started_at),
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete set null (vehicle_id),
  foreign key (operator_id, pattern_id) references public.trip_pattern (operator_id, id) on delete set null (pattern_id)
);

create index route_recording_operator_id_idx on public.route_recording (operator_id);

-- -----------------------------------------------------------------------------
-- Live operation
-- -----------------------------------------------------------------------------

-- One run of a trip on a service date, or a live trip started by the driver.
create table public.trip_instance (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  service_date date not null,
  kind public.trip_instance_kind not null,
  -- null for live trips.
  trip_id uuid,
  -- Copied from the trip for scheduled instances (trigger); optional for live
  -- trips. Visibility for riders follows route_id.
  pattern_id uuid,
  route_id uuid,
  vehicle_id uuid,
  status public.trip_instance_status not null default 'planned',
  started_by public.trip_started_by not null default 'schedule',
  -- Metres along the shape; only increases.
  progress_m double precision not null default 0 check (progress_m >= 0),
  progress_at timestamptz,
  last_confirmed_stop_sequence integer,
  -- Set while the vehicle is off route; riders then see "off route", not the
  -- position.
  off_route_since timestamptz,
  -- Live trips only.
  title jsonb check (private.is_i18n_text(title)),
  visible_until timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (service_date, trip_id),
  check ((kind = 'scheduled') = (trip_id is not null)),
  foreign key (operator_id, trip_id) references public.trip (operator_id, id) on delete cascade,
  foreign key (operator_id, pattern_id) references public.trip_pattern (operator_id, id) on delete cascade,
  foreign key (operator_id, route_id) references public.route (operator_id, id) on delete cascade,
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete set null (vehicle_id)
);

create index trip_instance_route_id_idx on public.trip_instance (route_id) where route_id is not null;
create index trip_instance_vehicle_id_idx on public.trip_instance (vehicle_id) where vehicle_id is not null;
create index trip_instance_active_idx on public.trip_instance (operator_id, service_date) where status = 'active';

create function private.trip_instance_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Scheduled instances follow their trip's pattern and route.
  if new.trip_id is not null then
    select t.pattern_id, p.route_id
      into new.pattern_id, new.route_id
      from public.trip t
      join public.trip_pattern p on p.id = t.pattern_id
     where t.id = new.trip_id;
  elsif new.pattern_id is not null then
    select p.route_id into new.route_id from public.trip_pattern p where p.id = new.pattern_id;
  end if;

  if tg_op = 'UPDATE' and new.progress_m < old.progress_m then
    raise exception 'progress_m only increases (% → %)', old.progress_m, new.progress_m
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trip_instance_before_write
  before insert or update on public.trip_instance
  for each row execute function private.trip_instance_before_write();

-- One row per stop of a trip instance (arrival-alerts.md).
create table public.stop_event (
  operator_id uuid not null,
  trip_instance_id uuid not null,
  stop_sequence integer not null,
  state public.stop_event_state not null default 'upcoming',
  eta timestamptz,
  approaching_at timestamptz,
  arrived_at timestamptz,
  departed_at timestamptz,
  passed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (trip_instance_id, stop_sequence),
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete cascade,
  check (state not in ('arrived', 'departed') or arrived_at is not null),
  check (state <> 'departed' or departed_at is not null),
  -- "Passed without stopping": never arrived.
  check (state <> 'passed' or (passed_at is not null and arrived_at is null))
);

-- States only move forward; departed and passed are final.
create function private.stop_event_forward_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state in ('departed', 'passed') and new.state <> old.state then
    raise exception 'stop event state % is final', old.state using errcode = 'check_violation';
  end if;
  -- A stop that was arrived at can only be departed, never "passed without
  -- stopping" (clearing arrived_at does not help).
  if old.arrived_at is not null and new.state = 'passed' then
    raise exception 'stop event was arrived at; it can be departed, not passed'
      using errcode = 'check_violation';
  end if;
  -- Enum order: upcoming < approaching < arrived < departed < passed.
  if new.state < old.state then
    raise exception 'stop event state cannot go back from % to %', old.state, new.state
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger stop_event_forward_only
  before update on public.stop_event
  for each row execute function private.stop_event_forward_only();

-- Current state per vehicle, written by the engine. History stays in Traccar.
create table public.vehicle_state (
  vehicle_id uuid primary key,
  operator_id uuid not null,
  trip_instance_id uuid,
  location extensions.geography(Point, 4326),
  speed_kmh real,
  heading real check (heading >= 0 and heading < 360),
  accuracy_m real,
  recorded_at timestamptz not null,
  updated_at timestamptz not null default now(),
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete cascade,
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete set null (trip_instance_id)
);

create index vehicle_state_trip_instance_id_idx on public.vehicle_state (trip_instance_id) where trip_instance_id is not null;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------

create table public.audience (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  name jsonb not null check (private.is_i18n_text(name)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id)
);

create table public.audience_route (
  operator_id uuid not null,
  audience_id uuid not null,
  route_id uuid not null,
  -- Map, or arrival times only. A route with visibility invited_eta never shows
  -- the map to riders, whatever this says.
  can_see_map boolean not null default false,
  primary key (audience_id, route_id),
  foreign key (operator_id, audience_id) references public.audience (operator_id, id) on delete cascade,
  foreign key (operator_id, route_id) references public.route (operator_id, id) on delete cascade
);

create index audience_route_route_id_idx on public.audience_route (route_id);

create table public.invite_code (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  audience_id uuid not null,
  -- sha256 of the normalised code (private.hash_invite_code). The code itself
  -- is shown once and never stored.
  code_hash text not null unique,
  label text,
  expires_at timestamptz,
  max_uses integer check (max_uses > 0),
  uses integer not null default 0 check (uses >= 0),
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  check (max_uses is null or uses <= max_uses),
  foreign key (operator_id, audience_id) references public.audience (operator_id, id) on delete cascade
);

create index invite_code_audience_id_idx on public.invite_code (operator_id, audience_id);

-- A rider device = an anonymous Supabase Auth user. No name, email or phone.
-- Deleted after 90 days without activity (retention migration).
create table public.device (
  id uuid primary key references auth.users (id) on delete cascade,
  push_token text,
  platform public.device_platform,
  -- BCP 47 language tag for notifications.
  language text check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index device_last_seen_at_idx on public.device (last_seen_at);

-- Clients may touch last_seen_at but not push it into the future to escape
-- the 90-day retention.
create function private.device_clamp_last_seen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.last_seen_at := least(new.last_seen_at, now());
  return new;
end;
$$;

create trigger device_clamp_last_seen
  before insert or update on public.device
  for each row execute function private.device_clamp_last_seen();

comment on table public.device is
  'Anonymous rider device (id = auth.users.id of an anonymous user). No operator_id: a device can join several operators.';

create table public.membership (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  device_id uuid not null references public.device (id) on delete cascade,
  audience_id uuid not null,
  invite_code_id uuid references public.invite_code (id) on delete set null,
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (operator_id, audience_id) references public.audience (operator_id, id) on delete cascade
);

create unique index membership_active_uniq on public.membership (device_id, audience_id) where revoked_at is null;
create index membership_audience_id_idx on public.membership (audience_id);
create index membership_invite_code_id_idx on public.membership (invite_code_id) where invite_code_id is not null;

-- -----------------------------------------------------------------------------
-- Alerts
-- -----------------------------------------------------------------------------

-- "Stop X on pattern P, 5 minutes before". Applies to every trip of the pattern.
create table public.subscription (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  device_id uuid not null references public.device (id) on delete cascade,
  pattern_id uuid not null,
  stop_sequence integer not null,
  trigger public.alert_trigger not null default 'minutes',
  trigger_value integer not null default 5 check (trigger_value > 0),
  notify_passed boolean not null default false,
  muted_until timestamptz,
  created_at timestamptz not null default now(),
  unique (device_id, pattern_id, stop_sequence),
  foreign key (operator_id, pattern_id, stop_sequence)
    references public.pattern_stop (operator_id, pattern_id, stop_sequence) on delete cascade on update cascade
);

create index subscription_pattern_stop_idx on public.subscription (operator_id, pattern_id, stop_sequence);

-- Log of sent alerts. The unique key guarantees one alert per subscription,
-- trip instance, stop and kind, also across engine restarts. Kept 30 days.
create table public.alert_delivery (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  subscription_id uuid not null references public.subscription (id) on delete cascade,
  trip_instance_id uuid not null,
  stop_sequence integer not null,
  kind public.alert_kind not null,
  sent_at timestamptz,
  result text,
  created_at timestamptz not null default now(),
  unique (subscription_id, trip_instance_id, stop_sequence, kind),
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete cascade
);

create index alert_delivery_trip_instance_id_idx on public.alert_delivery (trip_instance_id);
create index alert_delivery_created_at_idx on public.alert_delivery (created_at);

-- -----------------------------------------------------------------------------
-- Content
-- -----------------------------------------------------------------------------

create table public.post (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  title jsonb not null check (private.is_i18n_text(title)),
  body jsonb not null check (private.is_i18n_text(body)),
  -- null = everyone who can see the operator.
  audience_id uuid,
  route_id uuid,
  -- null = draft.
  published_at timestamptz,
  expires_at timestamptz,
  send_push boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or published_at is null or expires_at > published_at),
  foreign key (operator_id, audience_id) references public.audience (operator_id, id) on delete cascade,
  foreign key (operator_id, route_id) references public.route (operator_id, id) on delete cascade
);

create index post_operator_published_idx on public.post (operator_id, published_at desc);

create table public.operator_link (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  label jsonb not null check (private.is_i18n_text(label)),
  url text not null check (url ~ '^(https://|mailto:|tel:)'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index operator_link_operator_id_idx on public.operator_link (operator_id);

-- -----------------------------------------------------------------------------
-- Vehicle events and boarding check
-- -----------------------------------------------------------------------------

-- Events from the "Vehicle events" API (server.md), stored by the engine.
-- The client-generated event id makes retries idempotent per vehicle.
-- Kept 30 days.
create table public.vehicle_event (
  vehicle_id uuid not null,
  id uuid not null,
  operator_id uuid not null,
  type public.vehicle_event_type not null,
  occurred_at timestamptz not null,
  -- The event as received, minus deviceId/id/type/time.
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  primary key (vehicle_id, id),
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete cascade
);

create index vehicle_event_received_at_idx on public.vehicle_event (received_at);

-- A BLE tag registered to the operator. The link to a passenger is held by
-- the operator; if stored here at all, only encrypted with a key Buspilot
-- does not have (boarding-check.md).
create table public.tag (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operator (id) on delete cascade,
  -- "ibeacon:<uuid>:<major>:<minor>" or "eddystone:<namespace>:<instance>"
  tag_uid text not null check (tag_uid ~ '^(ibeacon|eddystone):'),
  passenger_ref_encrypted bytea,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, tag_uid)
);

-- Boarding / alighting derived by the engine from vehicle events. Tag IDs and
-- events only, no names. Kept 30 days.
create table public.boarding_event (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  tag_id uuid not null,
  vehicle_id uuid,
  trip_instance_id uuid,
  stop_sequence integer,
  kind public.boarding_event_kind not null,
  occurred_at timestamptz not null,
  -- vehicle_event.id it was derived from, for idempotency.
  source_event_id uuid,
  created_at timestamptz not null default now(),
  unique (source_event_id, tag_id, kind),
  foreign key (operator_id, tag_id) references public.tag (operator_id, id) on delete cascade,
  foreign key (operator_id, vehicle_id) references public.vehicle (operator_id, id) on delete set null (vehicle_id),
  foreign key (operator_id, trip_instance_id) references public.trip_instance (operator_id, id) on delete set null (trip_instance_id)
);

create index boarding_event_trip_instance_id_idx on public.boarding_event (trip_instance_id) where trip_instance_id is not null;
create index boarding_event_occurred_at_idx on public.boarding_event (occurred_at);

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'operator', 'route', 'stop', 'shape', 'trip_pattern', 'service_calendar', 'trip',
    'vehicle', 'trip_instance', 'stop_event', 'vehicle_state', 'audience', 'post'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()',
      t
    );
  end loop;
end;
$$;

-- Functions in `private` are not executable by PUBLIC. (Per-schema default
-- privileges cannot remove the global PUBLIC EXECUTE, so each migration that
-- adds private functions revokes it.) The RLS migration grants the access
-- helpers to the API roles.
revoke execute on all functions in schema private from public;
