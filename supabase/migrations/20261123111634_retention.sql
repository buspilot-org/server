-- Retention (data-model.md, "Personal data and retention").
--
-- | Data                                  | Kept                          |
-- |---------------------------------------|-------------------------------|
-- | Rider device (anonymous auth user)    | 90 days after last activity   |
-- | alert_delivery                        | 30 days                       |
-- | vehicle_event, boarding_event         | 30 days                       |
-- | Failed invite redemption attempts     | 1 day                         |
-- | route_recording.track                 | until converted (check constraint) |
-- Raw vehicle positions are not stored here (Traccar keeps them, 30 days).

create function private.purge_expired_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.alert_delivery where created_at < now() - interval '30 days';
  delete from public.vehicle_event where received_at < now() - interval '30 days';
  delete from public.boarding_event where occurred_at < now() - interval '30 days';
  delete from private.invite_redemption_failure where attempted_at < now() - interval '1 day';

  -- Inactive rider devices: delete the anonymous auth user; device,
  -- memberships, subscriptions and alert log follow by cascade.
  delete from auth.users u
   using public.device d
   where d.id = u.id
     and u.is_anonymous
     and d.last_seen_at < now() - interval '90 days';
  delete from public.device d where d.last_seen_at < now() - interval '90 days';
end;
$$;

revoke execute on function private.purge_expired_data() from public, anon, authenticated;

-- Daily at 03:17 JST (18:17 UTC).
select cron.schedule('buspilot-purge-expired-data', '17 18 * * *', 'select private.purge_expired_data()');
