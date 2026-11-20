-- YouNMeSign (EasySign) Phase 3 / migration 30: fix found by test T541 (slice 7).
-- audit_archive_due listed documents finished strictly earlier than "now minus N days", so with N = 0 a document
-- finished in the same instant was never listed. "Finished at least N days ago" is inclusive. Nothing else changes.

create or replace function public.audit_archive_due(p_min_age_days int, p_limit int) returns table (envelope_id uuid, chain_key text, events bigint)
language sql stable security definer set search_path = '' as $$
  select e.id, 'env:' || e.id::text, count(*)
    from public.envelopes e
    join public.audit_events x on x.chain_key = 'env:' || e.id::text
   where e.status in ('completed', 'declined', 'voided', 'expired')
     and coalesce(e.completed_at, e.expired_at, e.updated_at) <= now() - make_interval(days => greatest(p_min_age_days, 0))
     and (e.deletion_started_at is null or e.deleted_at is not null)
     and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id and j.status in ('queued', 'running'))
   group by e.id
   order by min(coalesce(e.completed_at, e.expired_at, e.updated_at))
   limit greatest(least(p_limit, 100), 1)
$$;

-- down (manual): re-create public.audit_archive_due exactly as in 20261120081856_audit_archive.sql.
