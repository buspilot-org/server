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

## Contributing

Every pull request gets at least one thorough self-review before merge; see the [Buspilot agent policy](https://github.com/buspilot-org/.github/blob/main/docs/agent-policy.md).

## License

[GNU Affero General Public License v3.0](LICENSE)
