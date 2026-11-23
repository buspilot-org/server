-- Demo data for local development: one fictional operator in Kobe.
--
-- No real people. Stops are public places (stations, a street), not homes.
-- The school is fictional.
--
-- Demo invite code (published here on purpose, demo only): DEMO-KOBE-2026
--
-- Fixed UUIDs make the demo easy to reference from apps and tests:
--   operator  d0000000-0000-4000-8000-000000000001
--   route     d0000000-0000-4000-8000-000000000101
--   pattern   d0000000-0000-4000-8000-000000000301
--   audience  d0000000-0000-4000-8000-000000000601
--   vehicle   d0000000-0000-4000-8000-000000000701 (Traccar device 23273424)

insert into public.operator (id, slug, name, timezone, languages, default_visibility)
values (
  'd0000000-0000-4000-8000-000000000001',
  'demo-kobe',
  '{"en": "Kitano Demo International School", "ja": "北野デモ国際学校", "de": "Kitano Demo International School"}',
  'Asia/Tokyo',
  '{en,ja,de}',
  'invited_eta'
);

insert into public.operator_link (operator_id, label, url, sort_order)
values (
  'd0000000-0000-4000-8000-000000000001',
  '{"en": "School office", "ja": "学校事務室"}',
  'mailto:office@example.org',
  1
);

-- Stops. Kitano-zaka is served twice by the loop (stop_sequence 2 and 5).
insert into public.stop (id, operator_id, gtfs_id, name, location) values
  ('d0000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001', 'shin-kobe',
   '{"en": "Shin-Kobe Station", "ja": "新神戸駅"}', 'SRID=4326;POINT(135.1953 34.7067)'),
  ('d0000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000001', 'kitano-zaka',
   '{"en": "Kitano-zaka", "ja": "北野坂"}', 'SRID=4326;POINT(135.1915 34.6995)'),
  ('d0000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001', 'sannomiya',
   '{"en": "Sannomiya", "ja": "三宮"}', 'SRID=4326;POINT(135.1956 34.6947)'),
  ('d0000000-0000-4000-8000-000000000204', 'd0000000-0000-4000-8000-000000000001', 'motomachi',
   '{"en": "Motomachi", "ja": "元町"}', 'SRID=4326;POINT(135.1866 34.6897)'),
  ('d0000000-0000-4000-8000-000000000205', 'd0000000-0000-4000-8000-000000000001', 'school',
   '{"en": "School", "ja": "学校"}', 'SRID=4326;POINT(135.1880 34.7020)');

insert into public.route (id, operator_id, gtfs_id, name, short_name, color, text_color)
values (
  'd0000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'morning-a',
  '{"en": "Morning route A", "ja": "朝便A"}', 'A', '1E6FD9', 'FFFFFF'
);

-- Shape: straight lines through the stops in order (a real shape follows the
-- roads; this one is enough for the demo).
insert into public.shape (id, operator_id, gtfs_id, geom, source)
values (
  'd0000000-0000-4000-8000-000000000401', 'd0000000-0000-4000-8000-000000000001', 'morning-a-loop',
  'SRID=4326;LINESTRING(135.1953 34.7067, 135.1915 34.6995, 135.1956 34.6947, 135.1866 34.6897, 135.1915 34.6995, 135.1880 34.7020)',
  'drawn'
);

insert into public.trip_pattern (id, operator_id, route_id, shape_id, name, direction)
values (
  'd0000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000401',
  'Morning loop', 0
);

-- dist_along_shape: cumulative distance between consecutive stops (the shape
-- vertices are the stops). ST_LineLocatePoint would put both Kitano-zaka
-- visits at the first one, which is exactly the loop problem.
with seq (stop_sequence, stop_id, arrival_offset, departure_offset) as (
  values
    (1, 'd0000000-0000-4000-8000-000000000201'::uuid,    0,   60),
    (2, 'd0000000-0000-4000-8000-000000000202'::uuid,  300,  330),
    (3, 'd0000000-0000-4000-8000-000000000203'::uuid,  540,  600),
    (4, 'd0000000-0000-4000-8000-000000000204'::uuid,  900,  930),
    (5, 'd0000000-0000-4000-8000-000000000202'::uuid, 1260, 1290),
    (6, 'd0000000-0000-4000-8000-000000000205'::uuid, 1500, 1500)
),
legs as (
  select seq.*,
         coalesce(
           extensions.st_distance(s.location, lag(s.location) over (order by seq.stop_sequence)),
           0
         ) as leg_m
  from seq
  join public.stop s on s.id = seq.stop_id
)
insert into public.pattern_stop (operator_id, pattern_id, stop_sequence, stop_id, arrival_offset, departure_offset, dist_along_shape)
select 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000301',
       stop_sequence, stop_id, arrival_offset, departure_offset,
       round(sum(leg_m) over (order by stop_sequence)::numeric, 1)
from legs;

-- School days: Monday–Friday (bits 0–4), school year 2026/27, no national
-- holidays, winter break removed.
insert into public.service_calendar (id, operator_id, gtfs_id, name, weekdays, start_date, end_date, skip_national_holidays)
values (
  'd0000000-0000-4000-8000-000000000501', 'd0000000-0000-4000-8000-000000000001', 'school-days',
  'School days 2026/27', 31, '2026-04-01', '2027-03-31', true
);

insert into public.calendar_exception (operator_id, calendar_id, start_date, end_date, type, reason)
values (
  'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000501',
  '2026-12-24', '2027-01-07', 'removed', 'Winter break'
);

-- Two trips of the same pattern: 07:30 and 08:10.
insert into public.trip (id, operator_id, gtfs_id, pattern_id, service_calendar_id, start_time, headsign) values
  ('d0000000-0000-4000-8000-000000000801', 'd0000000-0000-4000-8000-000000000001', 'morning-a-0730',
   'd0000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000501', 7 * 3600 + 30 * 60,
   '{"en": "School", "ja": "学校"}'),
  ('d0000000-0000-4000-8000-000000000802', 'd0000000-0000-4000-8000-000000000001', 'morning-a-0810',
   'd0000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000501', 8 * 3600 + 10 * 60,
   '{"en": "School", "ja": "学校"}');

insert into public.vehicle (id, operator_id, name, traccar_device_id, capacity)
values ('d0000000-0000-4000-8000-000000000701', 'd0000000-0000-4000-8000-000000000001', 'Bus 1', '23273424', 29);

-- Parents of the morning route: arrival times only (school default).
insert into public.audience (id, operator_id, name)
values (
  'd0000000-0000-4000-8000-000000000601', 'd0000000-0000-4000-8000-000000000001',
  '{"en": "Parents – morning route A", "ja": "朝便A 保護者"}'
);

insert into public.audience_route (operator_id, audience_id, route_id, can_see_map)
values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000601',
        'd0000000-0000-4000-8000-000000000101', false);

insert into public.invite_code (operator_id, audience_id, code_hash, label)
values ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000601',
        private.hash_invite_code('DEMO-KOBE-2026'), 'Demo code (published in the repository)');

insert into public.post (operator_id, title, body, published_at)
values (
  'd0000000-0000-4000-8000-000000000001',
  '{"en": "Welcome to Buspilot", "ja": "Buspilot へようこそ"}',
  '{"en": "This is a demo operator.", "ja": "これはデモ用の事業者です。"}',
  '2026-11-23T00:00:00Z'
);
