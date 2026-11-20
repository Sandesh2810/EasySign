-- YouNMeSign (EasySign) Phase 3 / migration 31: audit_archive_due can be asked about one document (slice 7).
-- Found by test T541: the list is oldest first and capped at 100, so with many finished documents a new one is not in
-- the first 100. An optional third argument limits the list to one document (also useful to archive one on request).
-- Two-argument calls (the worker) behave exactly as before.

drop function public.audit_archive_due(int, int);

create function public.audit_archive_due(p_min_age_days int, p_limit int, p_envelope_id uuid default null)
returns table (envelope_id uuid, chain_key text, events bigint)
language sql stable security definer set search_path = '' as $$
  select e.id, 'env:' || e.id::text, count(*)
    from public.envelopes e
    join public.audit_events x on x.chain_key = 'env:' || e.id::text
   where e.status in ('completed', 'declined', 'voided', 'expired')
     and (p_envelope_id is null or e.id = p_envelope_id)
     and coalesce(e.completed_at, e.expired_at, e.updated_at) <= now() - make_interval(days => greatest(p_min_age_days, 0))
     and (e.deletion_started_at is null or e.deleted_at is not null)
     and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id and j.status in ('queued', 'running'))
   group by e.id
   order by min(coalesce(e.completed_at, e.expired_at, e.updated_at))
   limit greatest(least(p_limit, 100), 1)
$$;
revoke all on function public.audit_archive_due(int, int, uuid) from public, anon, authenticated;
grant execute on function public.audit_archive_due(int, int, uuid) to service_role;

-- down (manual): drop function public.audit_archive_due(int, int, uuid); re-create the two-argument version exactly as
-- in 20261120082128_archive_due_inclusive.sql, with its grants (revoke from public, anon, authenticated; grant to service_role).
