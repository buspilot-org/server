-- Live trips: the engine may release a live trip it started too early.
--
-- A live trip without a planned time at its first stop starts with the
-- first position after it was saved. If a scheduled trip of the same
-- vehicle becomes due before the live trip has reached any stop, the
-- scheduled trip takes over (engine/README.md, "Live trips"): the engine
-- puts the live trip back to `planned` without progress, so it can start
-- again cleanly later. progress_m otherwise only increases; this allows the
-- reset for exactly that change (a live trip going from active to planned).
create or replace function private.trip_instance_before_write()
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

  if tg_op = 'UPDATE' and new.progress_m < old.progress_m
     and not (new.kind = 'live' and old.status = 'active' and new.status = 'planned') then
    raise exception 'progress_m only increases (% → %)', old.progress_m, new.progress_m
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
