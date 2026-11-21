-- D-95 (Phase 5 slice 6): languages. The language a person reads their signing page in is kept with them, so the
-- emails they receive after that (code, answers, cancellation, completion, reminders) are in the same language. It is
-- set only through a live signing link of that person. New column and one new function.

alter table public.recipients add column locale text check (locale in ('en', 'es', 'hi', 'ar'));

create function public.signer_set_locale(p_token_id uuid, p_locale text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_rcp uuid;
begin
  if p_locale is null or p_locale not in ('en', 'es', 'hi', 'ar') then
    raise exception 'ES_INVALID: unknown language' using errcode = '22023';
  end if;
  select k.recipient_id into v_rcp from public.recipient_tokens k
   where k.id = p_token_id and k.revoked_at is null and k.expires_at > now();
  if v_rcp is null then return; end if;
  perform app_private.sanction();
  update public.recipients r set locale = p_locale where r.id = v_rcp and r.locale is distinct from p_locale;
  perform set_config('easysign.sanctioned', '', true);
end
$$;
revoke all on function public.signer_set_locale(uuid, text) from public, anon, authenticated;
grant execute on function public.signer_set_locale(uuid, text) to service_role;

-- down:
-- drop function public.signer_set_locale(uuid, text); alter table public.recipients drop column locale;
