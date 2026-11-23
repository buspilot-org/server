# Buspilot server

Server side of [Buspilot](https://buspilot.org), a bus tracking service for privately operated buses (schools, kindergartens, driving schools, hotel shuttles, sports clubs).

| Folder | Content |
|---|---|
| `supabase/` | Supabase project: `config.toml`, SQL migrations (schema, PostGIS, row-level security), seed data for a demo operator |
| `engine/` | (planned) Service next to Traccar: assigns positions to trips, detects stops, sends alerts, receives vehicle events |

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

Migrations in `supabase/migrations/` create the schema (Postgres + PostGIS), row-level security and a daily retention job (pg_cron). Tests in `supabase/tests/` are pgTAP.

- **Identities** are Supabase Auth users: staff sign in with email and get a role per operator in `staff_role` (`owner`, `editor`, `driver`); rider devices sign in anonymously and get a `device` row with the same ID.
- **Riders** join an audience with an invite code: `select * from redeem_invite_code('XXXXX-XXXXX')` (RPC). Editors create codes with `create_invite_code(audience_id)`; only the hash is stored.
- **Route visibility** (`public`, `invited_map`, `invited_eta`) decides what a rider sees: arrival times only, or also the map (shape, stop locations, vehicle position). Stop locations are read through the `stop_location` view, not `stop.location`.
- **The engine** writes live state (trip progress, stop events, vehicle state, alerts, vehicle events) with the service role.

`seed.sql` adds a fictional demo school in Kobe with one route (a loop that serves one stop twice), two trips, a vehicle for Traccar device `23273424`, and the invite code `DEMO-KOBE-2026`. To try the admin side locally, sign up a user in Studio and give it a role:

```sql
insert into public.staff_role (operator_id, user_id, role)
values ('d0000000-0000-4000-8000-000000000001', '<auth user id>', 'owner');
```

## Contributing

Every pull request gets at least one thorough self-review before merge; see the [Buspilot agent policy](https://github.com/buspilot-org/.github/blob/main/docs/agent-policy.md).

## License

[GNU Affero General Public License v3.0](LICENSE)
