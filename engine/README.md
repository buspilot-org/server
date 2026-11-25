# buspilot-engine

Turns raw vehicle positions into what riders care about: which trip is running, where the bus is along the route, which stops it has served, when it will arrive, and who gets an arrival alert. Supabase only stores the results.

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
| `FCM_SERVICE_ACCOUNT_FILE` | – | Path to the Firebase service account key (JSON) for push. Without it (or `FCM_SERVICE_ACCOUNT_JSON`), alerts are off |
| `FCM_SERVICE_ACCOUNT_JSON` | – | The same key as JSON in the variable (e.g. from a secret store); set one of the two |
| `FCM_PROJECT_ID` | key's `project_id` | Firebase project (`buspilot-84a51`) |
| `FCM_TARGET` | `fid` | What `device.push_token` holds: `fid` (Firebase Installation ID, as the rider app registers it) or `token` (legacy registration token) |
| `ALERT_DELAY_MINUTES` | `10` | "Running late" alert threshold; `0` turns it off |
| `SUBSCRIPTION_RELOAD_SECONDS` | `60` | Reload of subscriptions, push targets and access |

Matching thresholds (distances, windows, speeds) are in `src/config.ts` (`defaultThresholds`) with a comment for each; they are global for now.

### Firebase service account

1. Firebase console → project `buspilot-84a51` → Project settings → Service accounts → *Generate new private key*. The account needs only the *Firebase Cloud Messaging API Admin* role (`roles/firebasecloudmessaging.admin`); the generated Admin SDK account has more than that, so a dedicated service account with just this role is better.
2. Put the JSON file on the engine host only, readable by the engine alone (`chmod 600`), outside the repository, and set `FCM_SERVICE_ACCOUNT_FILE` to its path (Docker: mount it read-only, e.g. `-v /etc/buspilot/fcm.json:/run/secrets/fcm.json:ro` and `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json`). Never commit it; `.gitignore` blocks the usual file names.
3. The engine signs its own OAuth token requests with the key (scope `firebase.messaging`), so no Google SDK is needed. Rotate by creating a new key, swapping the file, restarting, then deleting the old key.

## API

| | |
|---|---|
| `POST /v1/traccar/positions/:secret` | Traccar JSON position forwarding (`PositionData`: `{position, device}`). `200` processed / duplicate / invalid, `202` device is not a Buspilot vehicle (dropped), `400` malformed, `401` wrong secret, `503` not ready or the database write failed (Traccar retries) |
| `GET /healthz` | `200 {"status": "ok", …}` or `503 {"status": "degraded", …}` with database reachability, stale trips and counters about Buspilot vehicles (nothing about other devices on the Traccar server), and alert counters (`alerts`: sent, failed, expired, push tokens cleared; `null` when push is off) |

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
   - passes are told apart geometrically: two points of the route belong to the same pass only if the route between them is no longer than the way through the fix (plus 10 m), so the two sides of a tight turn are two passes;
   - above 10 km/h the GPS course must fit the direction of the route;
   - the match nearest ahead of the progress wins (near-ties: the schedule); a match continuing a pending confirmation wins instead if it is at least as close to the fix;
   - a fix is accepted at once only if the bus can have driven there since the previous fix (50 m + 80 km/h × the time) and no earlier pass of the route is within 100 m of it (looking back to 130 m behind the progress);
   - otherwise it needs three fixes that continue each other, at least two with the bus moving along the new section (by GPS course, or by its movement since the previous fix), together 20 m forward. A standing bus confirms nothing, however long it stands or however its GPS jitters. Once confirmed, the held fixes are replayed into the stop state machine, so a stop dwell during the hold still counts as arrived.

   - a match up to 130 m behind the progress on the current pass (GPS a little behind, or a bus reversing) is on route but never advances the progress, and it beats a later pass that is not closer;
   - at the end of the route there is less line left than the 20 m advance, and a hold there is confirmed when the bus leaves the route (a final stop right after a turn).

   More than 100 m from the route for more than 60 s → off route: progress kept, ETAs held, three fixes on the route to come back. Between 50 m and 100 m from the route the engine holds (neither on route nor off route).
5. **Stop state machine**: `arrived` within 30 m of the stop along the route and below 5 km/h (the nearest stop only); `departed` when the bus is beyond the stop + 20 m; `passed` beyond the stop + 50 m without having arrived. Arriving at a stop closes all earlier stops. The final stop is departed when the bus is 50 m away from it for two fixes. States only move forward; when all stops are final, the trip is completed. `approaching` is per subscriber and left to the alert dispatcher.
6. **ETA v1**: scheduled arrival + current delay (delay at the current progress, interpolated between stops), never earlier than the remaining distance at 60 km/h. While the bus stands at a stop, waiting until the scheduled departure is no delay, and an early bus does not make ETAs early. Written when an ETA moves by 30 s or more.
7. **Persist** trip progress, stop events, ETAs and the vehicle state in one transaction. Writes are idempotent and forward-only, so a retried position or a replay changes nothing. The in-memory state is only updated after the write succeeded; a failed write answers `503` and Traccar retries.
8. **Alerts** (below) are evaluated on the written state, in the background: they never delay or fail a position.

On start (and every few minutes) the engine loads vehicles, shapes, patterns and the planned/active trip instances around today. A restarted engine continues active trips from the database.

## Arrival alerts

Rules from arrival-alerts.md ("Decisions (2026-11-26)"); code in `src/alerts/`.

**Who.** A subscription (`device`, `pattern_id`, `stop_sequence`, trigger) applies to every scheduled trip of its pattern. The engine loads only subscriptions whose device has a push target and may see the route, as `private.route_access` decides for riders: the route is active, and it is public or the device has a membership (not revoked) in an audience that includes the route. Reloaded every `SUBSCRIPTION_RELOAD_SECONDS`, so a new subscription, a revoked membership or a new push token counts within a minute. `muted_until` in the future: nothing is sent (and nothing is used up: an alert still due after the mute ends is sent then).

**When.** After every processed position, for each subscription of the trip's pattern, on the state just written (`src/alerts/due.ts`), at most one alert per subscription and position:

| Subscribed stop | Alert |
|---|---|
| `upcoming`, "N minutes before": ETA − now ≤ N minutes (inclusive) | **approaching** |
| `upcoming`, "N stops before": the stop N places earlier in the pattern is departed or passed (fewer than N stops before it: the first stop; assumption, the open point in arrival-alerts.md) | **approaching** |
| `upcoming`, not yet approaching, ETA ≥ scheduled arrival + `ALERT_DELAY_MINUTES` | **delayed** (once per trip and subscription) |
| `arrived` (the approaching alert was missed: data gap, late subscription) | **arrived** "the bus is at your stop", stored with kind `approaching`, so it goes out only if no approaching alert did |
| `passed`, `notify_passed` on, passed less than 10 min ago and after the subscription was made | **passed** |
| `departed`, or `passed` without `notify_passed` | nothing, ever |
| any, trip instance cancelled by staff (seen at the next cache reload, every `CACHE_RELOAD_SECONDS`), trip starting within 24 h, stop not yet served (a trip that never started: scheduled in the future) | **cancelled** |

- **Passed is checked before triggers**: the stop states are final before triggers are looked at, so stops passed in one update (after a GPS gap or a confirmed jump) never get an approaching alert.
- **Held** while the position is stale (fix older than 2 min when processed) or the bus is off route: nothing is due. The next fresh position on the route evaluates again, so a held alert goes out if it is still due, or becomes *arrived* / *passed* / nothing by the rules above.
- **Loops**: only the subscribed `stop_sequence` counts; the other visit of the same stop never alerts.
- No active trip, no alerts (excursions, trips not started).
- The first stop of a trip gets no approaching alert: the trip starts only when the bus pulls away from it, and that position already departs it.

**Exactly once.** Each due alert is claimed with `INSERT … ON CONFLICT DO NOTHING` into `alert_delivery` (unique subscription + trip instance + stop_sequence + kind, `result = 'pending'`); only the process that inserted the row sends. This holds across positions, Traccar retries, restarts and several engine processes. If the engine dies between the claim and the send, that alert is lost rather than sent twice. A claim that fails (database down) is tried again with the next position. The engine also remembers its claims in memory, so the database sees one insert per alert, not one per position.

**Sending** (FCM HTTP v1, `src/alerts/fcm.ts`), at most 8 requests at a time, in the background:

| FCM answer | Then | `alert_delivery.result` |
|---|---|---|
| 200 | `sent_at` set | `sent` |
| 429, 5xx, timeout, network, OAuth failure (also 401, with a new access token) | retried after 2 s, 10 s and 30 s (or `Retry-After`, at most 60 s) | `sent`, `expired` or `failed: <code>` |
| `UNREGISTERED`, or `INVALID_ARGUMENT` with a field violation on `message.fid` / `message.token` | `device.push_token` cleared (only if it still holds that target); the device's alerts not yet attempted are skipped | `invalid_token` |
| other 4xx: `SENDER_ID_MISMATCH` (wrong project or key), `PERMISSION_DENIED`, a malformed message | not retried, token kept, logged as an error: these hit every send, so they must not wipe every device's token | `failed: <code>` |

Before each attempt (also after waiting for a send slot or a retry) the alert is checked again: the subscription still exists, may be alerted and is not muted (taken from the last reload, with its current push target), and, for approaching / arrived / delayed, the trip is still active and the bus has not left the stop. An approaching alert whose bus has arrived meanwhile goes out as *arrived*; otherwise it is dropped (`expired`).

Known limits: an alert is at most once, not at least once (the engine stopping between claim and send, or after the 10 s shutdown grace, leaves it `pending`); after a restart, a `delayed` alert can follow an approaching alert sent before the restart (the engine only remembers its own claims); a subscription reload that started before an invalid token was cleared can bring that token back for one more attempt.

Logs carry the alert ID, trip instance, kind and FCM error code; never push targets, access tokens or positions.

### Push message format

One FCM HTTP v1 message per alert, addressed with `message.fid` (`FCM_TARGET=token`: `message.token`):

```json
{
  "message": {
    "fid": "<device.push_token>",
    "data": {
      "v": "1", "type": "stop_alert", "kind": "approaching",
      "alert_id": "<alert_delivery.id>", "subscription_id": "…",
      "operator_id": "…", "route_id": "…", "pattern_id": "…", "stop_id": "…", "stop_sequence": "4",
      "trip_instance_id": "…", "service_date": "2026-11-24", "trip_start": "2026-11-23T22:30:00.000Z",
      "eta": "2026-11-23T22:39:10.000Z", "delay_s": ""
    },
    "notification": { "title": "A Morning route A", "body": "The bus arrives at Motomachi in about 5 min." },
    "android": { "priority": "HIGH", "ttl": "1800s", "notification": { "channel_id": "arrival_alerts", "tag": "<trip_instance_id>:4", "sound": "default" } },
    "apns": { "headers": { "apns-priority": "10", "apns-expiration": "…", "apns-collapse-id": "<trip_instance_id>:4" }, "payload": { "aps": { "thread-id": "<trip_instance_id>", "sound": "default" } } }
  }
}
```

- `kind`: `approaching`, `arrived`, `passed`, `delayed`, `cancelled`. `eta` (ISO 8601, UTC) for approaching and delayed when known, else `""`; `delay_s` for delayed. All `data` values are strings (FCM requires it). **No positions**: only IDs, times and names the rider already follows.
- `notification` is localised from `device.language`: `ja`, `en` or `de` (base subtag; other languages get English, no language gets Japanese), with the route and stop names from the database in that language. This deviates from rider-app.md ("text built on the phone"): with a ready text, Android shows the notification while the app is in the background or killed without any app code. `data` still has everything to build a different text.
- One notification per trip and stop on the phone (`tag`, `apns-collapse-id`): "at your stop" replaces "arrives in 5 min". TTL: until the alert is useless (approaching / arrived / delayed 30 min, passed 10 min, cancelled until the scheduled time at the stop).
- Channels: `arrival_alerts` (approaching, arrived, passed) and `trip_changes` (delayed, cancelled).

**What the rider app must do** (follow-ups for buspilot-org/rider-app):

1. Create the Android notification channels `arrival_alerts` and `trip_changes` at start (localised names), so users can tune them in system settings; without them Android puts the notifications in the default channel from `com.google.firebase.messaging.default_notification_channel_id`.
2. Tap → open the route at that stop: handle `FirebaseMessaging.onMessageOpenedApp` and `getInitialMessage()` (app started from the notification) with `data.route_id`, `data.stop_id`, `data.stop_sequence` and `data.trip_instance_id`.
3. In the foreground FCM shows nothing: handle `onMessage` (in-app banner or `flutter_local_notifications` with the same tag).
4. Keep `device.push_token` and `device.language` current (language changes in the app, a new FID after reinstall or `register()`), and register again after the engine cleared an invalid target (the token is `null` in the device row).
5. Ignore unknown `kind` values and `v` other than `1` (later additions).
6. iOS later: APNs key in Firebase, `apns` block is already sent.

## Tests

```bash
npm run check     # eslint, tsc, unit and replay tests (no database needed)
npm run test:db   # integration test against the local Supabase database
```

- `test/unit/`: projection, matcher, stop state machine (with the examples from the design), ETA and service times, Traccar payload, HTTP API.
- `test/unit/`: also the alert due logic (every rule above), push texts, the FCM sender (OAuth JWT, error mapping) and dispatcher retries.
- `test/replay/alerts.test.ts`: alerts on replayed trips: minutes and stops before, mute, passed without stopping, a GPS gap (stop passed meanwhile; three stops passed in one update), missed approaching → "at your stop", stale positions, off route held and released, the German School loop, a stop served twice, restart and retried positions, a failed claim, the next day, delayed, cancelled, send retries, invalid tokens.
- `test/replay/` (scenarios): synthetic tracks with a fake clock and an in-memory store: the German School loop (passing near stop N+2 before N+1, also standing with GPS pulled onto the later pass), a stop served twice on a loop (with and without `dist_along_shape`), a skipped stop, excursions outside any trip, a bus parked at the first stop, GPS jumps, detours off the route, a tracker reporting every minute, two trips of the same pattern back to back, two vehicles on a trip any vehicle may run, cancellation and vehicle reassignment in the database, an engine restart mid-trip, a failed database write, and ETAs.
- `test/db/`: the seed's loop against the real database: trip instance creation, projection compared with PostGIS, a full trip with a restart, idempotent writes; alert subscriptions with access as RLS decides it, and exactly-once claims with two engines on two connections at the same time.

## Not yet

Alerts for live trips (subscriptions with `trip_instance_id`), alerts to staff, departure reminders, per-operator alert thresholds, the vehicle events endpoint, Realtime broadcast, backfill from Traccar's REST API after downtime, the Supabase outage journal, driver overrides (`trip_start` / `trip_end`), national holidays in calendars (`skip_national_holidays`), per-operator thresholds.
