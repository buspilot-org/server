# Buspilot server

Server side of [Buspilot](https://buspilot.org), a bus tracking service for privately operated buses (schools, kindergartens, driving schools, hotel shuttles, sports clubs).

| Folder | Content |
|---|---|
| `supabase/` | Supabase project: `config.toml`, SQL migrations (schema, PostGIS, row-level security), seed data for a demo operator |
| `engine/` | Service next to Traccar: assigns positions to trips, tracks progress along the route, stop events, ETAs, arrival alerts by push, and the live API for the rider app and public pages (see [engine/README.md](engine/README.md)) |

Positions come from a [Traccar](https://www.traccar.org) server. The engine turns them into trip state; Supabase stores schedules, trip state, access and content.

## Local development

Requirements: Node.js, and Docker or Podman.

```bash
npm install
npx supabase start
```

The Supabase CLI version is pinned in `package.json` (`npx supabase --version`). Local ports are 553xx (API `http://127.0.0.1:55321`, Studio `http://127.0.0.1:55323`, database port `55322`), so they don't clash with other local Supabase projects.

With Podman, point the CLI at the Podman socket first:

```bash
export DOCKER_HOST="unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
```

Useful commands:

```bash
npx supabase migration new <name>   # new empty migration in supabase/migrations/
npx supabase db reset               # recreate the local database from migrations + seed
npx supabase test db                # run database tests (pgTAP) in supabase/tests/
npx supabase stop
```

## Database

Migrations in `supabase/migrations/` create the schema (Postgres + PostGIS), row-level security, a daily retention job (pg_cron) and the reference data for Japanese national holidays. Tests in `supabase/tests/` are pgTAP.

- **Identities** are Supabase Auth users: staff sign in with an email one-time code and get a role per operator in `staff_role` (`owner`, `editor`, `driver`); rider devices sign in anonymously and get a `device` row with the same ID.
- **Drivers** see the trips of their vehicles (`driver_vehicle`, set by owners and editors) and trips any vehicle may run; owners and editors see everything of their operator.
- **Riders** join an audience with an invite code: `select * from redeem_invite_code('XXXXX-XXXXX')` (RPC). Editors create codes with `create_invite_code(audience_id)` (only the hash is stored) and revoke them with `revoke_invite_code(id, revoke_memberships)` (one transaction).
- **Route visibility** (`public`, `invited_map`, `invited_eta`) decides what a rider sees: arrival times only, or also the map (shape, stop locations, vehicle position). Stop locations are read through the `stop_location` view, not `stop.location`; arrival-time-only riders get the location of the stops they follow (a subscription) for a mini map, at most the first two distinct stops per operator within 30 days, nothing else.
- **Live trips** (`trip_instance.kind = 'live'`) can have planned stops with times (`trip_instance_stop`, e.g. a tour itinerary) and audiences chosen per trip (`trip_instance_audience`). Riders follow a stop of a live trip with a `subscription` that has `trip_instance_id` instead of `pattern_id`. Staff save a live trip with its planned stops and audiences in one transaction with `save_live_trip(p_trip_id, p_operator_id, p_title, p_vehicle_id, p_route_id, p_visible_until, p_service_date, p_stops, p_audiences)` (RPC, caller's rights: owners and editors, drivers of the trip's vehicle or of trips without a vehicle; `p_trip_id` null creates the trip; returns the saved trip, stops and audiences). It saves the whole form: on update, null `p_vehicle_id`, `p_route_id` or `p_visible_until` clears them, while null `p_service_date`, `p_stops` or `p_audiences` keeps what is saved. Planned stops are matched by `stop_sequence`: keep a stop's sequence to keep its followers. Subscriptions to live trips completed or cancelled over an hour ago, past `visible_until`, or never ended 7 days after their service date are deleted by the daily retention job.
- **Posts** have a `category` (`cancellation`, `delay`, `general`, `event`). General posts (no audience, no route) are for members only; posts on a route are for everyone who sees the route.
- **National holidays** (`national_holiday`, names in ja/en/de) are readable by everyone. Calendars with `skip_national_holidays` do not run on them, unless an `added` exception says so; `service_days(from, to, operator_id)` returns the dates each visible calendar runs.
- **Rider app RPCs**: `my_routes()` returns only the routes of the device's operators and the routes it follows (embeddable: `rpc/my_routes?select=*,trip_pattern(*)`), `delete_my_device()` deletes the device's anonymous auth user with its memberships and subscriptions.
- **Branding**: `operator.branding` takes `logo_url`, `cover_url` (https URLs), `color` and `text_color` (`RRGGBB` without `#`); other keys are rejected. Owners upload logo and cover to the public Storage bucket `operator-branding` under `<operator_id>/`, for example `<operator_id>/logo.png` (PNG, JPEG or WebP, at most 2 MiB).
- **Slugs**: `route.slug` and `stop.slug` (optional, unique per operator, lower case with hyphens) name public pages: `buspilot.org/r/<operator.slug>/<route.slug>` and `buspilot.org/s/<operator.slug>/<stop.slug>`.
- **The engine** writes live state (trip progress, stop events, vehicle state every ~30 s, alerts, vehicle events) with the service role, and is notified of access changes on channel `buspilot_live` (statement triggers on memberships, audiences, staff, routes, stops and trips).

`seed.sql` adds a fictional demo school in Kobe with one route (a loop that serves one stop twice), two trips, a vehicle for Traccar device `23273424`, and the invite code `DEMO-KOBE-2026`. To try the admin side locally, sign up a user in Studio and give it a role:

```sql
insert into public.staff_role (operator_id, user_id, role)
values ('d0000000-0000-4000-8000-000000000001', '<auth user id>', 'owner');
```

Staff sign in with a 6-digit code; locally the email lands in Mailpit (`http://127.0.0.1:55324`).

### National holidays

The Cabinet Office publishes next year's holidays every February in its [holiday CSV](https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv) (Shift_JIS). Generate a migration from it, review it and commit it:

```bash
npx supabase migration new national_holidays_2028
node supabase/scripts/national-holidays.mjs 2027 2028 > supabase/migrations/<new file>.sql
```

The script replaces the listed years and stops on a holiday name it has no English and German translation for (add it to `NAMES` in the script).

### Staff sign-in email

`supabase/templates/magic_link.html` puts the code (`{{ .Token }}`) into the sign-in email (subject `Buspilot ログインコード / sign-in code / Anmeldecode`). `config.toml` uses it locally and on the hosted project.

## Hosted project (demo)

| | |
|---|---|
| Project | `buspilot-demo`, ref `xamiinjzlreewnxrwvhx` |
| Plan, region | Free, Tokyo (`ap-northeast-1`), Postgres 17 |

**Deploys.** The Supabase GitHub integration deploys `main` (working directory `.`): merging a pull request applies its new migrations, and the db, api, auth and storage settings of `supabase/config.toml` with the `[remotes.demo]` overrides on top (for example site URL, redirect URLs, email frequency, pooler size, TOTP, no vector buckets, no seed). `seed.sql` never runs on the hosted project. Before merging a change to `config.toml`, check what it would change (read-only):

```bash
npx supabase config diff --remote=xamiinjzlreewnxrwvhx
```

`config diff` compares the email template subject but not the body: after a deploy that changes `supabase/templates/`, check Authentication → Emails → Magic Link (the body must contain `{{ .Token }}`). Don't run `config push` or `db push` by hand; merging deploys, so run `npx supabase db reset` and `npx supabase test db` before merging (there is no CI).

**Set by hand in the dashboard** (not in `config.toml`, so the integration leaves them alone):

- custom SMTP through Cloudflare Email Sending (`smtp.mx.cloudflare.net:465`, user `api_token`, sender `noreply@mail.buspilot.org`); the token is only in the dashboard and the team password manager. Keep `[auth.email.smtp]` out of `config.toml`;
- the email rate limit (Authentication → Rate Limits, 30 emails per hour): the CLI only applies `email_sent` together with SMTP settings.

Anonymous sign-ins on, email confirmation off, sign-ups allowed and the 6-digit email OTP were also first set by hand; `config.toml` declares the same values.

**Keep-alive.** Free projects are paused after about a week of low database activity. A pg_cron job (`buspilot-keep-alive`, every 6 hours) updates the one row of `private.heartbeat` so the demo stays up between uses (`20261129100000_keep_alive.sql`). Supabase does not define exactly what counts as activity: if the project still pauses after a week without use, add an external ping.

**RLS.** The hosted project has "enable RLS on new tables automatically" turned on; the local database does not. `supabase/tests/12_hosted_parity_test.sql` fails if a table in `public` has RLS off, so every migration enables it explicitly.

## Engine

The engine (`engine/`, TypeScript on Node.js 26 LTS) receives positions from Traccar's JSON forwarding, matches them to the running trip and writes trip progress, stop events, ETAs and the vehicle state to Postgres. It also creates each day's trip instances from the calendars, sends arrival alerts through Firebase Cloud Messaging (set `FCM_SERVICE_ACCOUNT_FILE` to the Firebase service account key; without it, alerts are off), and serves live positions and ETAs to the rider app and the public pages (`/v1/live/…` with the Supabase access token, `/v1/public/…` for public routes; set `SUPABASE_URL`). Riders never get positions from Supabase or Traccar.

```bash
cd engine
npm install
cp .env.example .env   # set TRACCAR_FORWARD_SECRET
npm run check          # lint, typecheck, unit and replay tests
npm run test:db        # integration test against the local database (after npx supabase db reset)
node --env-file=.env src/main.ts
```

Details, configuration and the Traccar setup: [engine/README.md](engine/README.md).

## Contributing

Every pull request gets at least one thorough self-review before merge; see the [Buspilot agent policy](https://github.com/buspilot-org/.github/blob/main/docs/agent-policy.md).

## License

[GNU Affero General Public License v3.0](LICENSE)
