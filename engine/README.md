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
| `DATABASE_URL` | – | Direct Postgres connection, or Supavisor in session mode; **not** transaction mode (port 6543), where `LISTEN` silently receives nothing. A role that bypasses RLS (as the service role does). The engine sets its session time zone to UTC (like Supabase), which the live API's access rules rely on (`current_date`). Local: `postgres://postgres:postgres@127.0.0.1:55322/postgres` |
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
| `SUPABASE_URL` | – | Project URL (local: `http://127.0.0.1:55321`). The live API reads the signing keys from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` to verify members' access tokens. Without it, `/v1/live/…` answers `503`; the public endpoints work |
| `SUPABASE_JWT_ISSUER` | `<SUPABASE_URL>/auth/v1` | Expected `iss` of access tokens, if the engine reaches Supabase under another URL than the apps do |
| `LIVE_RELOAD_SECONDS` | `60` | Full reload of the live API's names, trips and access (changes come in sooner through `LISTEN buspilot_live`, per table) |
| `LIVE_MAX_AGE_SECONDS` | `300` | If access data could not be reloaded for this long, member endpoints answer `503` (fail closed: a revoked membership must not keep working); public endpoints stay up |
| `LIVE_STREAMS_MAX`, `LIVE_STREAMS_PER_USER` | `2000`, `4` | Open Server-Sent Event streams in all and per user; more answer `429` |
| `LIVE_CLIENT_IP_HEADER` | – | Header with the client IP set by the proxy in front of the engine, e.g. `CF-Connecting-IP` behind Cloudflare. Only set it if every request comes through that proxy (otherwise clients can forge it). Enables the per-IP stream limit |
| `LIVE_STREAMS_PER_IP` | `20` | Open streams per client IP (only with `LIVE_CLIENT_IP_HEADER`). Anonymous accounts cost nothing, so the per-user limit alone does not keep one client from taking every slot |
| `LIVE_HEARTBEAT_SECONDS` | `20` | Comment line on open streams |
| `VEHICLE_STATE_INTERVAL_SECONDS` | `30` | `vehicle_state` (admin console) is written at most this often per vehicle |

Matching thresholds (distances, windows, speeds) are in `src/config.ts` (`defaultThresholds`) with a comment for each; they are global for now.

### Firebase service account

1. Firebase console → project `buspilot-84a51` → Project settings → Service accounts → *Generate new private key*. The account needs only the *Firebase Cloud Messaging API Admin* role (`roles/firebasecloudmessaging.admin`); the generated Admin SDK account has more than that, so a dedicated service account with just this role is better.
2. Put the JSON file on the engine host only, readable by the engine alone (`chmod 600`), outside the repository, and set `FCM_SERVICE_ACCOUNT_FILE` to its path (Docker: mount it read-only, e.g. `-v /etc/buspilot/fcm.json:/run/secrets/fcm.json:ro` and `FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm.json`). Never commit it; `.gitignore` blocks the usual file names.
3. The engine signs its own OAuth token requests with the key (scope `firebase.messaging`), so no Google SDK is needed. Rotate by creating a new key, swapping the file, restarting, then deleting the old key.

## API

| | |
|---|---|
| `POST /v1/traccar/positions/:secret` | Traccar JSON position forwarding (`PositionData`: `{position, device}`). `200` processed / duplicate / invalid, `202` device is not a Buspilot vehicle (dropped), `400` malformed, `401` wrong secret, `503` not ready or the database write failed (Traccar retries) |
| `GET /healthz` | `200 {"status": "ok", …}` or `503 {"status": "degraded", …}` with database reachability, stale trips and counters about Buspilot vehicles (nothing about other devices on the Traccar server), alert counters (`alerts`: sent, failed, expired, push tokens cleared; `null` when push is off) and the live API (`live`: loaded, fresh, age of the access data in seconds, LISTEN active, members enabled, last reload, reload failures, open streams) |
| `GET /v1/live/…`, `GET /v1/public/…` | Live API for the rider app and public pages, see [Live API](#live-api) |

## Traccar setup

The Traccar server is shared with other devices, so positions are forwarded per group, not globally:

1. `traccar.xml` (needs a restart): `forward.type = json`, `forward.url` present but **empty**, `forward.retry.enable = true`. Devices without a URL are not forwarded.
2. A Traccar group "Buspilot" with the attribute `forward.url = https://<engine>/v1/traccar/positions/<TRACCAR_FORWARD_SECRET>`. The secret is in the path because Traccar only sends `forward.header` with the global URL. Rotate it by changing the attribute and the environment variable.
3. Every Buspilot vehicle's device goes into that group, and `vehicle.traccar_device_id` holds the device's Traccar identifier (`uniqueId`).

The engine still drops positions of devices it does not know, before reading anything else from them: nothing about them is stored or logged.

The secret is part of the URL path: make sure a reverse proxy, tunnel or load balancer in front of the engine does not write request paths to its access logs (or masks them).

## How a position is processed

1. **Accept or drop**: unknown device → `202`, counted, nothing else. Positions of one vehicle are processed one at a time, in order.
2. **Deduplicate**: same Traccar position ID, or a fix time not newer than the last one (also after a restart: `vehicle_state.recorded_at` or the active trip's `progress_at`, whichever is newer). Invalid fixes and fixes far in the future are dropped.
3. **Trip assigner**: the vehicle's active trip instance, or a planned one whose window is open (scheduled start − 15 min … scheduled end + 30 min) for this vehicle: `trip_instance.vehicle_id` if staff set one for the day, else the trip's default `trip.vehicle_id`, else any vehicle of the operator. A trip starts when the bus moves in route direction on the first kilometre of the route (two fixes, at least 30 m, currently moving). A bus parked at the first stop does not start a trip (holidays); once it pulls away, the first stop counts as arrived (at the time the bus was first seen standing there inside the trip window). If several trips could start, the one whose schedule fits the position best wins. **No trip → no stop events.** A cancellation, a driver start or a vehicle change made in the database is picked up at the next cache reload. Live trips go first and follow their own rules ([Live trips](#live-trips)).
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
7. **Persist** trip progress, stop events, ETAs and the vehicle state in one transaction. The vehicle state (for the admin console) only every 30 s per vehicle, and at once when the trip starts or ends, the bus goes off route or comes back, after more than 2 minutes without a position, and with every stop event; riders get positions from the live API, not from Supabase. A position that changes nothing else is not written at all. Writes are idempotent and forward-only, so a retried position or a replay changes nothing. The in-memory state is only updated after the write succeeded; a failed write answers `503` and Traccar retries.
8. **Alerts** (below) are evaluated on the written state, in the background: they never delay or fail a position.
9. **Live API** (below): the state just written and the position are published to open streams.

On start (and every few minutes) the engine loads vehicles, shapes, patterns and the scheduled and live trip instances around today. A restarted engine continues active trips from the database.

## Live trips

One-off trips that staff or a driver save with `save_live_trip()` (`trip_instance.kind = 'live'`): an away game, a tour. Code: `src/core/assigner.ts` (window, precedence), `src/core/itinerary.ts` (planned stops), `src/core/engine.ts`.

**How a live trip is followed** depends on what it has:

| The live trip has | Followed by | Stop events | Alerts |
|---|---|---|---|
| a pattern (`pattern_id`) | the shape, as a scheduled trip: route matcher, stop state machine, ETA v1 (steps 4–6 above) | created by the engine when the trip starts (one per pattern stop) | subscribers of the pattern's stops |
| planned stops (`trip_instance_stop`), no pattern | the planned stops in order (below) | created with the planned stops (database trigger) | subscribers of its planned stops (`subscription.trip_instance_id`) |
| neither | position only (live map, `vehicle_state` linked to the trip) | none | none |

**Which vehicle, when, and precedence over scheduled trips.**

- A live trip is followed only with a vehicle (`trip_instance.vehicle_id`). One saved for "any vehicle" waits until staff choose one.
- Window: from the first planned stop's time − 15 min, or (no time there) from when it was saved, not before its service day; to the last planned stop's time + 30 min, or (no time there) the end of its service day + 30 min; a live trip on a pattern, once started, until its start + the pattern's running time + 30 min. Times of stops in between do not set the window. Never after `visible_until`: riders no longer see the trip then, so the engine completes it and sends nothing more.
- Start: a live trip on a pattern starts like a scheduled trip (moving in route direction on the first kilometre). One with planned stops or neither starts with the first position in its window (staff planned it for this vehicle; its stops can only be reached in order anyway). The engine sets `status = 'active'`; `started_by` stays `driver`.
- Precedence on one vehicle: (1) a running trip keeps its vehicle until it ends (last stop, window closed, cancelled or completed by staff), whatever its kind: nothing pre-empts it; (2) a vehicle without a running trip starts a due live trip before any scheduled trip; (3) except that a live trip **without a planned time at its first stop yields to scheduled trips** (this includes every live trip on a pattern, which has no planned times): it does not start while a scheduled trip of the same vehicle is due (window open, not started; the instance's vehicle for the day, or the trip's default vehicle; trips any vehicle may run, and trips the database refused to this vehicle, do not count), and starts once none is: after that trip has ended, or its window has closed without it starting (decided 2026-11-26). Back-to-back scheduled trips (or ones the bus never drives) can hold it back all day; give a live trip saved ahead a planned time at its first stop; (4) so while a live trip runs, no scheduled trip starts on its vehicle, and a scheduled trip that was not started in its window stays `planned`; (5) except that a **running** live trip without a planned time at its first stop that **has reached no stop yet** is taken over when a scheduled trip of its vehicle becomes due (as in rule 3; decided 2026-11-26): the engine puts it back to `planned` (its vehicle kept; no progress, no ETAs, `started_at` cleared; migration `20261128100000_live_trip_release.sql` allows `progress_m` to go back to 0 for exactly this change), sends no alerts for it, and it starts again by rule 3 once no scheduled trip is due. A live trip that has reached a stop keeps its vehicle (rule 1); a timed live trip is never taken over. Example: saved at 06:00 for the afternoon, started by a 06:30 position at the depot, released at the first position after 07:15 (the 07:30 school run's window), started again after the school run. `vehicle_state` and the live API follow the switch (the live trip shows as planned, the position is linked to the running trip or none). Alerts stay exactly once per subscription, trip, stop and kind: an approaching alert sent during the early start is not sent again after the restart, and "at your stop" shares its key.
- Staff can edit the planned stops while the trip runs: at the next cache reload, stops already reached keep their state, new ones are followed, removed ones are dropped (the database refuses removing a stop the bus has reached), a stop moved to another place starts again. A stop inserted before the one the bus has reached is closed (`passed`) with the next arrival or departure.
- Staff take the vehicle off a running live trip ("any vehicle"): the trip is released at the next reload and the vehicle is free; the trip stays `active` without a vehicle until staff cancel it (the engine cannot write a trip without its vehicle).
- Cancelled by staff: as for scheduled trips (taken over at the next reload, `cancelled` alerts below).

**Planned stops without a shape: order, not circles.** The trial app's 500 m geofence circles fired false and double alerts on loops, because the bus entered the circle of a later stop first. Here:

- Only the **next stop** (the first one after the last stop reached) can be arrived at or passed by being near it: within 75 m (`itineraryArrivedRadiusM`); arrived below 5 km/h. Being near any other stop does nothing, except for the skip rule. On a tour that starts and ends at the hotel, the hotel at the end is not arrived at in the morning.
- **Passed**: the bus came near the next stop without stopping (also between two fixes far apart) and then left it (farther than 150 m for 3 fixes), or came nearer to the stop after it (stops close together). `passed_at` is the last time it was near the stop (not before the departure from the stop before), so `passed` alerts and "N stops before" triggers come in time. A drive-by no fix came near is passed once the bus, moving, is beyond it on its way from the stop before and comes near the stop after it; a later stop's circle entered on the way *to* the next stop does not count.
- **Skip** (a GPS gap, a stop the bus never came near): a later stop is arrived at only after the bus has stood near it for 3 min (`itinerarySkipDwellS`, arrived since it started standing there): with a planned time, any later stop, but not earlier than 1 h before that time (`itinerarySkipEarlyS`); without one, at most 2 places after the next stop (`itinerarySkipStops`). The stops between are passed. No skip while the bus stands at the stop it is at, and none to a stop at the same place as the last stop reached: a red light next to a later stop, waiting at the hotel in the morning, or a return to the hotel hours before the planned return, does not skip the plan.
- **Departed only by leaving**: farther than 150 m (`itineraryLeaveM`) from the stop for 3 fixes in a row (`itineraryLeaveFixes`), or arriving at a later stop. Never by time: a long planned stay (10:30–12:00) stays `arrived` however long the bus stands there, with GPS jitter, and later stops are neither passed nor departed early. If the bus drops the group and parks elsewhere, the stop is departed when it leaves; plan the pick-up as its own stop. A pick-up planned at the drop-off place (within 75 m) is arrived at once its planned time has come while the bus stands there (without a planned time: it is passed when the bus leaves).
- **Progress** (`progress_m`): straight-line distance along the planned stops: up to the last stop reached, plus the position projected onto the leg to the next open stop. Only grows. Such a trip is never off route.
- **ETA**: from the bus now, or while it stands at a stop, from that stop at its planned departure (not before now; a long planned stay is not a delay). Travel to each stop: the planned time between the two stops (planned arrival − the previous stop's planned departure), for the first leg in proportion to the straight-line distance still to go; without planned times, straight-line distance × 1.3 at 30 km/h (`itineraryDetourFactor`, `itinerarySpeedKmh`). Never sooner than the straight-line distance at 60 km/h, and before the first stop is reached never before a stop's planned arrival (the window opens 15 min before the first stop's time). The bus leaves each later stop at its planned departure, or at once without one.
- The last stop is departed by leaving it like the others; then the trip is completed. Otherwise the window closes it.
- Planned stops are projected in the operator's plane, which is built from its shapes only (an operator without shapes: from its planned stops), so a far away game does not change how scheduled trips are matched.
- Known limits: which stop the bus came near without stopping is kept in memory only, so after an engine restart right after driving past a stop, that stop is closed by the next arrival, skip or drive-by instead of when the bus left it. If staff replace the stop at a sequence while the bus reaches the old one, the event can land on the new stop until the next reload (seconds, by notification).

## Arrival alerts

Rules from arrival-alerts.md ("Decisions (2026-11-26)"); code in `src/alerts/`.

**Who.** A subscription (`device`, `pattern_id`, `stop_sequence`, trigger) applies to every trip of its pattern, live trips on the pattern included. A subscription to a live trip (`device`, `trip_instance_id`, `stop_sequence`) applies to that planned stop of that one trip. The engine loads only subscriptions whose device has a push target and may see the route, as `private.route_access` decides for riders: the route is active, and it is public or the device has a membership (not revoked) in an audience that includes the route; for a live trip, its route as above or a membership in one of the trip's audiences (`private.device_can_see_trip_instance`). Live trips: nothing once `visible_until` has passed. Reloaded every `SUBSCRIPTION_RELOAD_SECONDS`, so a new subscription, a revoked membership or a new push token counts within a minute. `muted_until` in the future: nothing is sent (and nothing is used up: an alert still due after the mute ends is sent then).

**When.** After every processed position, for each subscription of the trip (its pattern's and its own), on the state just written (`src/alerts/due.ts`), at most one alert per subscription and position:

| Subscribed stop | Alert |
|---|---|
| `upcoming`, "N minutes before": ETA − now ≤ N minutes (inclusive) | **approaching** |
| `upcoming`, "N stops before": the stop N places earlier in the trip (pattern or planned stops) is departed or passed (fewer than N stops before it: the first stop; assumption, the open point in arrival-alerts.md) | **approaching** |
| `upcoming`, not yet approaching, ETA ≥ scheduled arrival + `ALERT_DELAY_MINUTES` (live trips: the planned arrival; none on a pattern, which has no times of its own) | **delayed** (once per trip and subscription) |
| `arrived` (the approaching alert was missed: data gap, late subscription) | **arrived** "the bus is at your stop", stored with kind `approaching`, so it goes out only if no approaching alert did |
| `passed`, `notify_passed` on, passed less than 10 min ago and after the subscription was made | **passed** |
| `departed`, or `passed` without `notify_passed` | nothing, ever |
| any, trip instance cancelled by staff (seen at the next cache reload, every `CACHE_RELOAD_SECONDS`), trip starting within 24 h, stop not yet served (a trip that never started: scheduled or planned in the future; a live trip without planned times: until the end of its day) | **cancelled** |

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
      "trip_instance_id": "…", "trip_kind": "scheduled", "service_date": "2026-11-24", "trip_start": "2026-11-23T22:30:00.000Z",
      "eta": "2026-11-23T22:39:10.000Z", "delay_s": ""
    },
    "notification": { "title": "A Morning route A", "body": "The bus arrives at Motomachi in about 5 min." },
    "android": { "priority": "HIGH", "ttl": "1800s", "notification": { "channel_id": "arrival_alerts", "tag": "<trip_instance_id>:4", "sound": "default" } },
    "apns": { "headers": { "apns-priority": "10", "apns-expiration": "…", "apns-collapse-id": "<trip_instance_id>:4" }, "payload": { "aps": { "thread-id": "<trip_instance_id>", "sound": "default" } } }
  }
}
```

- Live trips: `trip_kind` is `live`, the title is `trip_instance.title` in the device's language (not the route name), and `cancelled` says "This trip is cancelled." `pattern_id` and `route_id` are `""` when the trip has none; `trip_instance_id` always identifies the trip. `trip_start` is the first planned time (or when the trip may start).
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

## Live API

Live positions and ETAs for the rider app and the public web pages, served by the engine from memory (engine.md, "Live API"): no Supabase Realtime connection and no database read per viewer, and not Traccar (no trips, no visibility rules, and its share links expose position history). Code in `src/live/` and `src/http/live.ts`.

### Endpoints

| Endpoint | Who | Returns |
|---|---|---|
| `GET /v1/live/routes/:routeId` | Members | The route with today's trips (operator time zone) and active ones: status, stops with state and ETA, the bus position where allowed |
| `GET /v1/live/routes/:routeId/stream` | Members | The same as Server-Sent Events while the route or map screen is open |
| `GET /v1/live/trips/:tripInstanceId` | Members | One of today's, an active or a future trip, e.g. a live trip without a route (a tour) for its audiences; older trips answer `404` (no history) |
| `GET /v1/live/trips/:tripInstanceId/stream` | Members | The same as Server-Sent Events |
| `GET /v1/live/stops/:stopId` | Members | Today's arrivals at a stop (home cards): the latest served visits and what comes next, at most 50 |
| `GET /v1/public/routes/:operatorSlug/:routeSlug` | Anyone | A `public` route (`buspilot.org/r/<operator>/<route>`) |
| `GET /v1/public/stops/:operatorSlug/:stopSlug` | Anyone | A stop of `public` routes (`buspilot.org/s/<operator>/<stop>`); only arrivals of public routes |

**Members** send the Supabase access token of the signed-in session (anonymous rider device or staff) as `Authorization: Bearer <access_token>`. The engine verifies it with the project's signing keys (JWKS, cached; ES256/RS256/EdDSA, not the legacy HS256 secret) and needs `role = authenticated`. Refresh the session as `supabase_flutter` does and send the current token; an expired one answers `401`. Never put the token in the URL.

**Who sees what** is decided exactly as the database's row-level security decides it (`private.route_access`, `private.trip_instance_access`, `private.stop_access`, `public.stop_location`; a parity test checks this against Postgres):

- A route a user may not see, an unknown ID and a malformed ID all answer `404` (never `403`), so a private route's existence is not revealed. Public endpoints only know `public`, active routes.
- **Arrival-time-only** viewers (`access: "eta"`) get stop states and ETAs, never the bus position, and stop locations only for the first two stops they follow per operator (the mini map), like `stop_location`.
- **Map** viewers (`access: "map"`: public routes, `invited_map` with `can_see_map`, a live trip's audience with map, staff) get the bus position only while the trip is active, the bus is on route and its position is fresh (less than 2 minutes old), and stop locations.
- Live trips are visible to their audiences (`trip_instance_audience`) and, if they have a route, to the route's audiences; after `visible_until` to nobody.
- Membership, audience, staff, schedule and trip changes apply within about two seconds: the database notifies the engine on channel `buspilot_live` with the table name, and the engine reloads only that part (at most every 2 s). Everything is reloaded every `LIVE_RELOAD_SECONDS`; subscriptions (which followed stops get a mini-map location) only then, as they change often. An open stream whose viewer loses access ends with `not_found`.
- If the engine cannot reload access data for `LIVE_MAX_AGE_SECONDS` (database unreachable), member endpoints answer `503` and open streams end with `unavailable`; public endpoints keep working. The live API loads on its own after start: until then (or if its snapshot fails, e.g. before the migration is applied) it answers `503` while positions, trips and alerts work as usual.
- A live trip reached only through its own audiences, on a pattern of a route the viewer cannot see, comes with `"stop": null` for every stop (as RLS hides that pattern's stops), and the stop endpoint does not list it.
- A stop the viewer may not see as a row under RLS (e.g. a live trip's own audience on a pattern of a route they are not a member of) comes as `"stop": null`: its times and state, but no name, ID or location.
- Never history: only the current state, today's stop times, and the latest position.

### Response (format `v: 1`)

```jsonc
{
  "v": 1,
  "generatedAt": "2026-11-27T22:34:10.000Z",
  "operator": { "id": "…", "slug": "demo-kobe", "name": { "ja": "北野デモ国際学校", "en": "…" } },
  "route": { "id": "…", "slug": "morning-a", "name": { "ja": "朝便A", "en": "Morning route A" }, "shortName": "A", "color": "1E6FD9", "textColor": "FFFFFF" },
  "access": "eta",                        // "eta" or "map": what this viewer may see on the route
  "trips": [{
    "id": "…", "kind": "scheduled",       // or "live"
    "status": "active",                   // planned | active | completed | cancelled
    "serviceDate": "2026-11-28", "routeId": "…", "access": "eta",
    "headsign": { "ja": "学校", "en": "School" },   // live trips: their title
    "scheduledStart": "2026-11-27T22:30:00.000Z", "scheduledEnd": "2026-11-27T22:55:00.000Z",
    "startedAt": "2026-11-27T22:31:05.000Z", "endedAt": null,
    "tracked": true,      // the engine follows this trip; false: planned times and stored states only (live trips for now)
    "stale": false,       // active, but no position for more than 2 min: ETAs uncertain ("position unknown since lastSeenAt")
    "lastSeenAt": "2026-11-27T22:34:05.000Z",
    "offRoute": false,    // active and off route: ETAs held, no position
    "delayS": 120,        // ETA − scheduled arrival at the next stop
    "vehicle": null,      // map level only: { "lon", "lat", "heading", "speedKmh", "accuracyM", "recordedAt" }
    "stops": [{
      "sequence": 2,
      "stop": { "id": "…", "slug": "kitano-zaka", "name": { "ja": "北野坂", "en": "Kitano-zaka" }, "location": null },  // [lon, lat] where allowed
      "state": "upcoming",                // upcoming | approaching | arrived | departed | passed
      "scheduledArrival": "2026-11-27T22:35:00.000Z", "scheduledDeparture": "2026-11-27T22:35:30.000Z",
      "eta": "2026-11-27T22:37:00.000Z",  // only while the bus has not reached the stop and the trip is active
      "arrivedAt": null, "departedAt": null, "passedAt": null
    }]
  }]
}
```

`/v1/live/trips/:id` returns `{ v, generatedAt, operator, route, trip }` (`route` is `null` when the viewer may not see the route, e.g. a tour's audience). Stop endpoints return `{ v, generatedAt, operator, stop, routes, arrivals }`; each arrival has the trip ID, kind, trip status, route ID, headsign, `sequence` (a loop visits a stop twice), state, scheduled and expected times, `tracked`, `stale`, `offRoute` and `delayS`. Translatable texts are objects keyed by language, as in the database. Ignore fields you do not know; a breaking change raises `v`.

### Polling, caching and streams

- **Members' polling** (home cards, route screen without map): `Cache-Control: private, max-age=5`, `Vary: Authorization`, an `ETag` that ignores `generatedAt` (send `If-None-Match`: `304` while nothing changed). Every 10–30 s while visible is plenty.
- **Public pages** poll every ~10 s while visible (pause in background tabs). Responses are `Cache-Control: public, max-age=5, s-maxage=5` for Cloudflare, so thousands of visitors cost a few engine computations per minute; `404` is cached for 30 s. CORS is open (`*`, no cookies). Public pages need no Supabase call for live data; timetable, stops and shapes come from Supabase (anon key, RLS) and can be cached longer.
- **Streams** (`…/stream`, members, while the map or route screen is open; close them when it is not): `text/event-stream`, first `retry: 5000`, then an `event: route` (or `trip`) with the same JSON as polling, again whenever it changes (at most once a second, only real changes), and `: ping` every 20 s. A stream ends with `event: end` and `data: {"reason": …}`:
  - `token_expired`: at the access token's expiry; reconnect with the refreshed token;
  - `not_found`: access lost or the route is gone; stop streaming;
  - `trip_ended` (trip streams): the trip is over and no longer today's; stop streaming;
  - `unavailable`: the engine cannot read the database for too long; reconnect later (with backoff);
  - `shutdown`: the engine restarts; reconnect after the `retry` delay.

  At most 4 streams per user, 20 per client IP (behind a configured proxy) and 2000 in all (`429` with `Retry-After`). A client that does not read for 30 s is disconnected. EventSource in browsers cannot send headers: web clients use `fetch` streaming (or poll). The rider app (`http` package or `dio` with a streamed response) sends the header.
- `503` with `Retry-After` while the engine starts (or `SUPABASE_URL` is not set, for member endpoints).

Example (rider app, Dart, simplified):

```dart
final token = Supabase.instance.client.auth.currentSession!.accessToken;
final res = await http.get(
  Uri.parse('$engineUrl/v1/live/routes/$routeId'),
  headers: {'Authorization': 'Bearer $token'},
);
if (res.statusCode == 404) { /* not (or no longer) visible */ }
final route = jsonDecode(res.body) as Map<String, dynamic>;
```

Public page (Nuxt, server or browser):

```ts
const route = await $fetch(`${engineUrl}/v1/public/routes/${operatorSlug}/${routeSlug}`);
```

Route and stop slugs are `route.slug` and `stop.slug` (unique per operator, optional; migration `20261127100000_live_api.sql`); a route or stop without a slug has no public page.

## Tests

```bash
npm run check     # eslint, tsc, unit and replay tests (no database needed)
npm run test:db   # integration test against the local Supabase database
```

- `test/unit/`: projection, matcher, stop state machine (with the examples from the design), ETA and service times, Traccar payload, HTTP API.
- `test/unit/`: also the alert due logic (every rule above), push texts, the FCM sender (OAuth JWT, error mapping) and dispatcher retries.
- `test/replay/alerts.test.ts`: alerts on replayed trips: minutes and stops before, mute, passed without stopping, a GPS gap (stop passed meanwhile; three stops passed in one update), missed approaching → "at your stop", stale positions, off route held and released, the German School loop, a stop served twice, restart and retried positions, a failed claim, the next day, delayed, cancelled, send retries, invalid tokens.
- `test/replay/` (scenarios): synthetic tracks with a fake clock and an in-memory store: the German School loop (passing near stop N+2 before N+1, also standing with GPS pulled onto the later pass), a stop served twice on a loop (with and without `dist_along_shape`), a skipped stop, excursions outside any trip, a bus parked at the first stop, GPS jumps, detours off the route, a tracker reporting every minute, two trips of the same pattern back to back, two vehicles on a trip any vehicle may run, cancellation and vehicle reassignment in the database, an engine restart mid-trip, a failed database write, and ETAs.
- `test/unit/live-*.test.ts`: access token verification (JWKS, rotation, outage, rejected algorithms and claims), the access rules case by case, and the serialisation (scheduled times, delay, positions only from the linked trip, followed-stop locations, the stop window).
- `test/replay/live-api.test.ts`: the live API over HTTP on replayed trips: arrival-time and map members, stale and off route, the trip end, public routes and stops, 401/404, a revoked membership, a failed reload, failing closed after `LIVE_MAX_AGE_SECONDS`, per-table reloads, starting while the live snapshot fails, a loop's stop visited twice, a live trip with planned stops; Server-Sent Events (updates, heartbeat, per-user, per-IP and total limits, access lost, shutdown, token expiry, early abort); the `vehicle_state` throttle. `test/unit/live-streams.test.ts`: clients that stop reading are dropped.
- `test/db/live-parity.test.ts`: for the seed and a fixture operator (all visibilities, live trips with audiences and planned stops or on a pattern, members, staff, drivers, a revoked membership, followed and released stops), every viewer's route, trip and stop level and stop location equals what RLS returns for the same user, and trip views name a pattern's stops exactly when RLS shows that pattern's stops.
- `test/unit/itinerary.test.ts`, `test/unit/assigner.test.ts`: live trips along planned stops (a tour that starts and ends at the hotel, a later stop's circle entered first, a red light next to it, a revisit before its planned time, a long planned stay with GPS jitter, driving past a stop, skips, progress, ETAs), trip windows and precedence.
- `test/replay/live-trips.test.ts`: live trips through the engine and the dispatcher: on a pattern (auto start, stop events created, ETAs from the actual start, pattern subscribers alerted with the trip title), precedence against a scheduled trip on the same vehicle (a timed live trip and a scheduled trip due at once, an untimed live trip yielding: the scheduled trip runs first, waiting through the window of a trip the bus never drives, not held back by a trip any vehicle may run; takeover of an early-started untimed live trip (06:00 saved, 06:30 depot fix, 07:30 school run: released, `vehicle_state` unlinked, restarted after the run, no alert twice; position only; a trip that reached a stop or a timed one is not taken over); a running trip not pre-empted, no scheduled start during a live trip, other vehicles), a timed trip's window, planned-stop subscriptions (approaching, stops before, delayed, exactly once across a restart), planned stops edited while running, cancellation, `visible_until`, position only.
- `test/db/live-trips.test.ts`: live trips and their planned stops loaded from the database, planned-stop subscriptions with access through the trip's audiences, an alert claimed once, a live trip on the seed's pattern run end to end, and the release of an early-started live trip (refused once it reached a stop).
- `test/db/`: the seed's loop against the real database: trip instance creation, projection compared with PostGIS, a full trip with a restart, idempotent writes; alert subscriptions with access as RLS decides it, and exactly-once claims with two engines on two connections at the same time.

## Not yet

Ending a live trip from the admin console or driver app (only cancel exists; the engine completes it at the last stop or when its window closes), alerts to staff, departure reminders, per-operator alert thresholds, the vehicle events endpoint, Realtime broadcast, backfill from Traccar's REST API after downtime, the Supabase outage journal, driver overrides (`trip_start` / `trip_end`), national holidays in calendars (`skip_national_holidays`), per-operator thresholds.
