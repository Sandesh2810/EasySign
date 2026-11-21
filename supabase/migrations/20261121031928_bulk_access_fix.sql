-- D-85 follow-up: app_private.bulk_access returned NULL (not false) for someone with no membership in the batch's
-- workspace, because member_role() is NULL for them and "NULL in (...)" is NULL. Callers test
-- "if not found or not bulk_access(...)", and "not NULL" does not take the branch, so an outsider who knew a batch id
-- could cancel or view another workspace's bulk send. Found by T687. The function now always answers true or false.
create or replace function app_private.bulk_access(p_actor uuid, p_batch public.bulk_batches) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null
    and (p_batch.created_by = p_actor or app_private.member_role(p_actor, p_batch.org_id) in ('owner', 'admin')), false)
$$;
revoke all on function app_private.bulk_access(uuid, public.bulk_batches) from public, anon, authenticated, service_role;

-- down
-- create or replace function app_private.bulk_access(p_actor uuid, p_batch public.bulk_batches) returns boolean
-- language sql stable security definer set search_path = '' as $$
--   select p_actor is not null and (p_batch.created_by = p_actor or app_private.member_role(p_actor, p_batch.org_id) in ('owner', 'admin'))
-- $$;
