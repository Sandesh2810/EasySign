-- EasySign Phase 1 / migration 5: promote the bootstrap administrator when their email is confirmed,
-- and a Postgres-backed rate limiter for the server. Down script at the bottom (commented).

-- handle_new_user (migration 2) promotes the bootstrap admin only when the address arrives already
-- verified (Google/Microsoft sign-in). With email + password the address is confirmed later, so the
-- promotion has to happen at that moment too. Nobody can confirm an address they do not control.
create function app_private.handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_admin_email text;
  v_org uuid;
begin
  if old.email_confirmed_at is not null or new.email_confirmed_at is null then
    return new;
  end if;
  select lower(s.value #>> '{}') into v_admin_email from public.platform_settings s where s.key = 'bootstrap_admin_email';
  if v_admin_email is null or v_admin_email = '' or lower(coalesce(new.email, '')) <> v_admin_email then
    return new;
  end if;
  update public.account_controls
     set approved = true, is_platform_admin = true, admin_trusted = true, trust_level = 'trusted'
   where user_id = new.id;
  update public.registration_requests set status = 'approved', decided_at = now()
   where user_id = new.id and status = 'pending';
  select m.org_id into v_org from public.memberships m where m.user_id = new.id and m.role = 'owner' limit 1;
  if v_org is not null then
    perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'system', null, 'account_approved',
      jsonb_build_object('reason', 'bootstrap_admin', 'user_id', new.id));
  end if;
  return new;
end
$$;

create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row execute function app_private.handle_user_confirmed();

-- Fixed-window rate limiter. Returns true while the caller is within the limit.
-- The key (an IP address, an email, a token prefix) is stored only as a SHA-256 hash.
create function public.rate_limit_hit(p_bucket text, p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_count int;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (bucket, key_hash, window_start, count)
    values (p_bucket, sha256(convert_to(coalesce(p_key, ''), 'UTF8')), v_start, 1)
  on conflict (bucket, key_hash, window_start) do update set count = r.count + 1
  returning r.count into v_count;
  return v_count <= p_limit;
end
$$;

revoke all on function public.rate_limit_hit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, int, int) to service_role;

-- down (manual):
-- drop function if exists public.rate_limit_hit(text, text, int, int);
-- drop trigger if exists on_auth_user_confirmed on auth.users;
-- drop function if exists app_private.handle_user_confirmed();
