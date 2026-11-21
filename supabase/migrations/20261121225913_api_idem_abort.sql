-- D-98 (Phase 5 slice 10): an answer that should not be replayed (a server error, a rate or daily limit, a conflict that
-- may clear) releases its Idempotency-Key at once, so the same request can be tried again straight away instead of
-- getting "still being handled" for five minutes. Only an unfinished entry is removed.
create function public.api_idem_abort(p_key_id uuid, p_idem text) returns void
language sql security definer set search_path = '' as $$
  delete from public.api_idempotency x where x.key_id = p_key_id and x.idem_key = p_idem and x.status_code is null;
$$;

revoke all on function public.api_idem_abort(uuid, text) from public, anon, authenticated;
grant execute on function public.api_idem_abort(uuid, text) to service_role;

-- down: drop function public.api_idem_abort(uuid, text);
