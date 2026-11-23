# buspilot-engine

Turns raw vehicle positions into what riders care about: which trip is running, where the bus is along the route, which stops it has served, and when it will arrive. Supabase only stores the results.

TypeScript on Node.js 26 (LTS), run directly with Node's type stripping (no build step). [Hono](https://hono.dev) for HTTP, [postgres.js](https://github.com/porsager/postgres) for a direct database connection.

## Running

```bash
npm install
cp .env.example .env      # set DATABASE_URL and TRACCAR_FORWARD_SECRET
node --env-file=.env src/main.ts
```

Docker:

```bash
docker build -t buspilot-engine .
docker run --env-file .env -p 8080:8080 buspilot-engine
```

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – | Direct Postgres connection with a role that bypasses RLS (as the service role does). Local: `postgres://postgres:postgres@127.0.0.1:55322/postgres` |
| `TRACCAR_FORWARD_SECRET` | – | At least 32 URL-safe characters (`openssl rand -hex 32`) |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `CACHE_RELOAD_SECONDS` | `300` | Safety-net reload of vehicles, shapes, patterns and trip instances |
| `SCHEDULER_INTERVAL_SECONDS` | `3600` | Creates trip instances for today and tomorrow (idempotent) |
| `TICK_SECONDS` | `30` | Completes active trips whose window has closed |
| `LOG_LEVEL` | `info` | JSON lines on stdout |

Matching thresholds (distances, windows, speeds) are in `src/config.ts` (`defaultThresholds`) with a comment for each; they are global for now.

## API

| | |
|---|---|
| `POST /v1/traccar/positions/:secret` | Traccar JSON position forwarding (`PositionData`: `{position, device}`). `200` processed / duplicate / invalid, `202` device is not a Buspilot vehicle (dropped), `400` malformed, `401` wrong secret, `503` not ready or the database write failed (Traccar retries) |
| `GET /healthz` | `200 {"status": "ok", …}` or `503 {"status": "degraded", …}` with database reachability, stale trips and counters about Buspilot vehicles (nothing about other devices on the Traccar server) |

## Traccar setup

The Traccar server is shared with other devices, so positions are forwarded per group, not globally:

1. `traccar.xml` (needs a restart): `forward.type = json`, `forward.url` present but **empty**, `forward.retry.enable = true`. Devices without a URL are not forwarded.
2. A Traccar group "Buspilot" with the attribute `forward.url = https://<engine>/v1/traccar/positions/<TRACCAR_FORWARD_SECRET>`. The secret is in the path because Traccar only sends `forward.header` with the global URL. Rotate it by changing the attribute and the environment variable.
3. Every Buspilot vehicle's device goes into that group, and `vehicle.traccar_device_id` holds the device's Traccar identifier (`uniqueId`).

The engine still drops positions of devices it does not know, before reading anything else from them: nothing about them is stored or logged.

The secret is part of the URL path: make sure a reverse proxy, tunnel or load balancer in front of the engine does not write request paths to its access logs (or masks them).

## How a position is processed

1. **Accept or drop**: unknown device → `202`, counted, nothing else. Positions of one vehicle are processed one at a time, in order.
2. **Deduplicate**: same Traccar position ID, or a fix time not newer than the last one (also after a restart: `vehicle_state.recorded_at`). Invalid fixes and fixes far in the future are dropped.
3. **Trip assigner**: the vehicle's active trip instance, or a planned one whose window is open (scheduled start − 15 min … scheduled end + 30 min) for this vehicle: `trip_instance.vehicle_id` if staff set one for the day, else the trip's default `trip.vehicle_id`, else any vehicle of the operator. A trip starts when the bus moves in route direction on the first kilometre of the route (two fixes, at least 30 m, currently moving). A bus parked at the first stop does not start a trip (holidays); once it pulls away, the first stop counts as arrived (at the time the bus was first seen standing there inside the trip window). If several trips could start, the one whose schedule fits the position best wins. **No trip → no stop events.** A cancellation, a driver start or a vehicle change made in the database is picked up at the next cache reload.
4. **Route matcher**: shapes are projected once to metres (a local plane per operator; distances scaled to the PostGIS geodesic length). Each fix is matched only inside a window from progress − 30 m to + 1.5 km (more after a gap); progress only increases. Where the route passes the same place twice:
   - above 10 km/h the GPS course must fit the direction of the route;
   - the match continuing a pending confirmation wins, else the match nearest ahead of the progress (near-ties: the schedule);
   - a fix is accepted at once only if the bus can have driven there since the previous fix (50 m + 80 km/h × the time) and no earlier pass of the route is within 100 m of it (looking back to 130 m behind the progress);
   - otherwise it needs three fixes that continue each other, at least two with the bus moving, together 20 m forward. A standing bus confirms nothing, however long it stands or however its GPS jitters.

   More than 100 m from the route for more than 60 s → off route: progress kept, ETAs held, three fixes on the route to come back. Between 50 m and 100 m from the route the engine holds (neither on route nor off route).
5. **Stop state machine**: `arrived` within 30 m of the stop along the route and below 5 km/h (the nearest stop only); `departed` beyond the stop + 20 m; `passed` beyond the stop + 50 m without having arrived. Arriving at a stop closes all earlier stops. The final stop is departed when the bus is 50 m away from it for two fixes. States only move forward; when all stops are final, the trip is completed. `approaching` is per subscriber and left to the alert dispatcher.
6. **ETA v1**: scheduled arrival + current delay (delay at the current progress, interpolated between stops), never earlier than the remaining distance at 60 km/h. While the bus stands at a stop, waiting until the scheduled departure is no delay, and an early bus does not make ETAs early. Written when an ETA moves by 30 s or more.
7. **Persist** trip progress, stop events, ETAs and the vehicle state in one transaction. Writes are idempotent and forward-only, so a retried position or a replay changes nothing. The in-memory state is only updated after the write succeeded; a failed write answers `503` and Traccar retries.

On start (and every few minutes) the engine loads vehicles, shapes, patterns and the planned/active trip instances around today. A restarted engine continues active trips from the database.

## Tests

```bash
npm run check     # eslint, tsc, unit and replay tests (no database needed)
npm run test:db   # integration test against the local Supabase database
```

- `test/unit/`: projection, matcher, stop state machine (with the examples from the design), ETA and service times, Traccar payload, HTTP API.
- `test/replay/`: synthetic tracks with a fake clock and an in-memory store: the German School loop (passing near stop N+2 before N+1, also standing with GPS pulled onto the later pass), a stop served twice on a loop (with and without `dist_along_shape`), a skipped stop, excursions outside any trip, a bus parked at the first stop, GPS jumps, detours off the route, a tracker reporting every minute, two trips of the same pattern back to back, two vehicles on a trip any vehicle may run, cancellation and vehicle reassignment in the database, an engine restart mid-trip, a failed database write, and ETAs.
- `test/db/`: the seed's loop against the real database: trip instance creation, projection compared with PostGIS, a full trip with a restart, idempotent writes.

## Not yet

Alert dispatch (FCM), the vehicle events endpoint, Realtime broadcast, backfill from Traccar's REST API after downtime, the Supabase outage journal, driver overrides (`trip_start` / `trip_end`), national holidays in calendars (`skip_national_holidays`), per-operator thresholds.
