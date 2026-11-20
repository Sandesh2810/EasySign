-- YouNMeSign Phase 4 slice 1, part 2: the team rules from migration 32 made search over 10,000 documents take 2.4 s
-- (limit 300 ms, T305) because the access check ran as a separate lookup for every row. Same rules, faster form:
-- * search_envelopes looks up the person's role ONCE;
-- * the read rules compare against the person's workspace lists, computed once per query (sub-select),
--   and child tables (recipients, fields, ...) follow the documents table's own rule through a join.
-- What anyone may see does not change (D-75). Down script at the bottom (commented).

-- Workspaces where the signed-in person sees every document (owner, admin, viewer) / only their own (member).
create function app_private.my_orgs_all_documents() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m
   where m.user_id = (select auth.uid()) and m.deactivated_at is null and m.role in ('owner', 'admin', 'viewer')
$$;
create function app_private.my_orgs_own_documents() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m
   where m.user_id = (select auth.uid()) and m.deactivated_at is null and m.role = 'member'
$$;
revoke all on function app_private.my_orgs_all_documents() from public, anon, service_role;
revoke all on function app_private.my_orgs_own_documents() from public, anon, service_role;
grant execute on function app_private.my_orgs_all_documents() to authenticated;
grant execute on function app_private.my_orgs_own_documents() to authenticated;

drop policy envelopes_select on public.envelopes;
create policy envelopes_select on public.envelopes for select to authenticated
  using (org_id in (select app_private.my_orgs_all_documents())
         or (sender_id = (select auth.uid()) and org_id in (select app_private.my_orgs_own_documents())));

-- children: visible exactly when their document is (the sub-query is itself filtered by envelopes_select)
drop policy envelope_documents_select on public.envelope_documents;
create policy envelope_documents_select on public.envelope_documents for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = envelope_documents.envelope_id));
drop policy recipients_select on public.recipients;
create policy recipients_select on public.recipients for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = recipients.envelope_id));
drop policy fields_select on public.fields;
create policy fields_select on public.fields for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = fields.envelope_id));
drop policy field_values_select on public.field_values;
create policy field_values_select on public.field_values for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = field_values.envelope_id));
drop policy consents_select on public.consents;
create policy consents_select on public.consents for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = consents.envelope_id));
drop policy seal_jobs_select on public.seal_jobs;
create policy seal_jobs_select on public.seal_jobs for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = seal_jobs.envelope_id));
drop policy sender_tasks_select on public.sender_tasks;
create policy sender_tasks_select on public.sender_tasks for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = sender_tasks.envelope_id));
drop policy audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events for select to authenticated
  using (org_id is not null and case when envelope_id is null then org_id in (select app_private.my_orgs_all_documents())
                                     else exists (select 1 from public.envelopes e where e.id = audit_events.envelope_id) end);
drop policy audit_archives_select on public.audit_archives;
create policy audit_archives_select on public.audit_archives for select to authenticated
  using (org_id is not null and case when envelope_id is null then org_id in (select app_private.my_orgs_all_documents())
                                     else exists (select 1 from public.envelopes e where e.id = audit_archives.envelope_id) end);
drop policy signature_assets_select on public.signature_assets;
create policy signature_assets_select on public.signature_assets for select to authenticated
  using (owner_user_id = (select auth.uid())
         or org_id in (select app_private.my_orgs_all_documents())
         or exists (select 1 from public.field_values v where v.signature_asset_id = signature_assets.id));

-- the per-row helpers are no longer used by any rule
drop function app_private.can_see_envelope(uuid, uuid);
drop function app_private.can_see_envelope_id(uuid);
drop function app_private.sees_whole_org(uuid);

-- search: the person's role is looked up once, not per document
create or replace function public.search_envelopes(p_actor uuid, p_org_id uuid, p_query text, p_view text, p_folder_id uuid, p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, title text, status text, public_code text, created_at timestamptz, completed_at timestamptz, expires_at timestamptz,
               folder_id uuid, folder_name text, people text, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_like text;
  v_email text;
  v_role text;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  v_role := app_private.member_role(p_actor, p_org_id);
  if v_role is null then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  if coalesce(p_view, 'all') not in ('all', 'action', 'waiting', 'expiring', 'draft', 'completed', 'closed') then
    raise exception 'unknown view' using errcode = '22023';
  end if;
  if char_length(v_q) > 100 then
    v_q := left(v_q, 100);
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_email := coalesce(app_private.user_email(p_actor), '');
  return query
    with mine as (
      select e.* from public.envelopes e
       where e.org_id = p_org_id
         and (v_role <> 'member' or e.sender_id = p_actor)   -- D-75: a member sees only the documents they sent
         and (p_folder_id is null or e.folder_id = p_folder_id)
         and case coalesce(p_view, 'all')
               when 'all' then true
               when 'draft' then e.status = 'draft'
               when 'completed' then e.status = 'completed'
               when 'closed' then e.status in ('declined', 'voided', 'expired')
               when 'waiting' then e.status in ('sent', 'in_progress')
               when 'expiring' then e.status in ('sent', 'in_progress') and e.expires_at is not null and e.expires_at <= now() + interval '3 days'
               when 'action' then e.status in ('sent', 'in_progress') and exists (
                 select 1 from public.recipients x where x.envelope_id = e.id and lower(x.email) = v_email
                    and x.role in ('signer', 'in_person', 'approver') and x.status in ('sent', 'viewed', 'consented'))
             end
         and (v_q = ''
              or lower(e.title) like v_like
              or e.public_code ilike v_like
              or exists (select 1 from public.recipients x where x.envelope_id = e.id and (lower(x.name) like v_like or lower(x.email) like v_like)))
    )
    select e.id, e.title, e.status, e.public_code, e.created_at, e.completed_at, e.expires_at, e.folder_id, f.name,
           (select string_agg(x.name, ', ' order by x.routing_order, x.created_at) from public.recipients x where x.envelope_id = e.id and x.role <> 'cc'),
           count(*) over ()
      from mine e left join public.folders f on f.id = e.folder_id
     order by e.created_at desc, e.id
     limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0));
end
$$;

-- down:
-- recreate can_see_envelope(uuid, uuid), can_see_envelope_id(uuid), sees_whole_org(uuid) and the policies from migration 32 (20261120191012_teams);
-- recreate search_envelopes from migration 32; drop function app_private.my_orgs_own_documents(); drop function app_private.my_orgs_all_documents();
