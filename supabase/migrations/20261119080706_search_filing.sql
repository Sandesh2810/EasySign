-- EasySign Phase 2 / migration 18: dashboard search and filters, moving documents between folders, and
-- filing rules that place a completed document in a folder by its title (slice 10; AT2.8 filing, AT2.12 search).
-- All new public functions are server-only (service role) and take the acting user explicitly (D-35).

create extension if not exists pg_trgm with schema extensions;

-- Search by part of a title, a verification code, or a person's name or email (trigram indexes make
-- "contains" searches fast on large tables).
create index envelopes_title_trgm_idx on public.envelopes using gin (lower(title) extensions.gin_trgm_ops);
create index envelopes_code_trgm_idx on public.envelopes using gin (public_code extensions.gin_trgm_ops);
create index recipients_name_trgm_idx on public.recipients using gin (lower(name) extensions.gin_trgm_ops);
create index recipients_email_trgm_idx on public.recipients using gin (lower(email) extensions.gin_trgm_ops);
create index envelopes_org_created_idx on public.envelopes (org_id, created_at desc);

-- ---------------------------------------------------------------- filing rules
create table public.filing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  folder_id uuid not null references public.folders (id) on delete cascade,
  title_contains text not null check (char_length(title_contains) between 2 and 100),
  position int not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index filing_rules_org_idx on public.filing_rules (org_id, position);
create index filing_rules_folder_idx on public.filing_rules (folder_id);
create index filing_rules_created_by_idx on public.filing_rules (created_by);
alter table public.filing_rules enable row level security;
revoke all on public.filing_rules from public, anon, authenticated;
grant select on public.filing_rules to authenticated, service_role;
create policy filing_rules_select on public.filing_rules for select to authenticated
  using (app_private.is_org_member(org_id));

-- When a document is completed, the first rule (lowest position, then oldest) whose words appear in its
-- title decides its folder. Without a matching rule the folder chosen by the sender stays.
create function app_private.file_on_complete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    select fr.id, fr.folder_id into r
      from public.filing_rules fr join public.folders f on f.id = fr.folder_id and f.org_id = new.org_id
     where fr.org_id = new.org_id and strpos(lower(new.title), lower(fr.title_contains)) > 0
     order by fr.position, fr.created_at
     limit 1;
    if found and r.folder_id is distinct from new.folder_id then
      new.folder_id := r.folder_id;
      perform app_private.audit_append('env:' || new.id::text, new.org_id, new.id, null, 'system', null, 'envelope_filed',
        jsonb_build_object('folder_id', r.folder_id, 'rule_id', r.id));
    end if;
  end if;
  return new;
end
$$;
-- Runs before envelopes_guard (triggers of one kind fire in name order); the folder is in the same workspace by construction.
create trigger envelopes_file_on_complete before update of status on public.envelopes
  for each row execute function app_private.file_on_complete();

create function public.set_filing_rule(p_actor uuid, p_org_id uuid, p_folder_id uuid, p_title_contains text, p_position int default 0) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_text text := btrim(coalesce(p_title_contains, ''));
  v_id uuid;
begin
  if p_actor is null or not app_private.is_member_of(p_actor, p_org_id, 'member') then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  if char_length(v_text) not between 2 and 100 then
    raise exception 'ES_RULE_TEXT: the words to look for must be 2 to 100 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.folders f where f.id = p_folder_id and f.org_id = p_org_id) then
    raise exception 'ES_NOT_FOUND: folder not found' using errcode = '42501';
  end if;
  insert into public.filing_rules (org_id, folder_id, title_contains, position, created_by)
    values (p_org_id, p_folder_id, v_text, greatest(0, least(coalesce(p_position, 0), 1000)), p_actor)
    returning id into v_id;
  perform app_private.audit_append('org:' || p_org_id::text, p_org_id, null, null, 'user', p_actor, 'filing_rule_added',
    jsonb_build_object('rule_id', v_id, 'folder_id', p_folder_id));
  return v_id;
end
$$;

create function public.delete_filing_rule(p_actor uuid, p_rule_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.filing_rules;
begin
  select * into r from public.filing_rules x where x.id = p_rule_id;
  if not found or p_actor is null or not app_private.is_member_of(p_actor, r.org_id, 'member') then
    raise exception 'ES_NOT_FOUND: rule not found' using errcode = '42501';
  end if;
  delete from public.filing_rules x where x.id = p_rule_id;
  perform app_private.audit_append('org:' || r.org_id::text, r.org_id, null, null, 'user', p_actor, 'filing_rule_removed',
    jsonb_build_object('rule_id', r.id));
  return true;
end
$$;

-- ---------------------------------------------------------------- move a document to another folder
create function public.move_to_folder(p_actor uuid, p_envelope_id uuid, p_folder_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or p_actor is null or not app_private.is_member_of(p_actor, v_env.org_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if p_folder_id is not null and not exists (select 1 from public.folders f where f.id = p_folder_id and f.org_id = v_env.org_id) then
    raise exception 'ES_NOT_FOUND: folder not found' using errcode = '42501';
  end if;
  if v_env.folder_id is not distinct from p_folder_id then
    return false;
  end if;
  update public.envelopes e set folder_id = p_folder_id where e.id = p_envelope_id;
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'user', p_actor, 'envelope_moved',
    jsonb_build_object('folder_id', p_folder_id));
  return true;
end
$$;

-- ---------------------------------------------------------------- search and filters for the dashboard
-- p_view: all | action (waiting for the actor's own signature) | waiting (with other people) | expiring (open, links stop
-- within 3 days) | draft | completed | closed (declined, cancelled or expired).
-- p_query matches part of the title, the verification code, or a person's name or email. Only the actor's workspaces.
create function public.search_envelopes(p_actor uuid, p_query text, p_view text, p_folder_id uuid, p_limit int default 50, p_offset int default 0)
returns table (id uuid, title text, status text, public_code text, created_at timestamptz, completed_at timestamptz, expires_at timestamptz,
               folder_id uuid, folder_name text, people text, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_like text;
  v_email text;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
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
       where e.org_id in (select m.org_id from public.memberships m where m.user_id = p_actor)
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

do $$
declare fn text;
begin
  revoke all on function app_private.file_on_complete() from public, anon, authenticated, service_role;
  foreach fn in array array[
    'public.set_filing_rule(uuid, uuid, uuid, text, int)',
    'public.delete_filing_rule(uuid, uuid)',
    'public.move_to_folder(uuid, uuid, uuid)',
    'public.search_envelopes(uuid, text, text, uuid, int, int)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual):
-- drop function public.search_envelopes(uuid, text, text, uuid, int, int), public.move_to_folder(uuid, uuid, uuid),
--   public.delete_filing_rule(uuid, uuid), public.set_filing_rule(uuid, uuid, uuid, text, int);
-- drop trigger envelopes_file_on_complete on public.envelopes; drop function app_private.file_on_complete();
-- drop table public.filing_rules;
-- drop index public.envelopes_org_created_idx, public.recipients_email_trgm_idx, public.recipients_name_trgm_idx,
--   public.envelopes_code_trgm_idx, public.envelopes_title_trgm_idx;
-- (pg_trgm is left installed: other projects' objects may use it)
