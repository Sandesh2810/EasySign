-- YouNMeSign (EasySign) Phase 3 / migration 28: audit-trail archiving (slice 7, AT3.10 technical part, D-72).
-- The free database has 500 MB. The audit events of finished documents are moved to compressed files in storage
-- (bucket "audit-archives", private); the database keeps, per archived part, its range, its last hash (the chain
-- head) and the file's SHA-256. Rules:
--   * Only archive_audit_commit can remove audit rows, only rows of one chain, only the range it has just recorded,
--     and only after re-checking in the same transaction that the range verifies and ends at the recorded head.
--     The append-only trigger stays for everything else (it now lets exactly that delete through).
--   * New events of an archived chain (for example /verify lookups) continue from the archived head, so the chain
--     never restarts; audit_verify checks the remaining rows from that head.
--   * The archive file holds every column of every row, so the whole chain can be re-verified from the file plus the
--     remaining rows (src/lib/audit-read.ts).
-- All functions are server-only (service role).

insert into storage.buckets (id, name, public) values ('audit-archives', 'audit-archives', false)
  on conflict (id) do nothing;

create table public.audit_archives (
  id uuid primary key default gen_random_uuid(),
  chain_key text not null,
  org_id uuid references public.organizations (id) on delete restrict,
  envelope_id uuid,
  first_seq int not null check (first_seq >= 1),
  last_seq int not null,
  events int not null,
  head_hash bytea not null check (octet_length(head_hash) = 32),
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/audit-[0-9]+-[0-9]+\.jsonl\.gz$'),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (last_seq >= first_seq and events = last_seq - first_seq + 1),
  unique (chain_key, first_seq)
);
create index audit_archives_chain_idx on public.audit_archives (chain_key, last_seq desc);
create index audit_archives_org_idx on public.audit_archives (org_id);
alter table public.audit_archives enable row level security;
grant select on public.audit_archives to authenticated, service_role;
create policy audit_archives_select on public.audit_archives for select to authenticated
  using (org_id is not null and app_private.is_org_member(org_id));

-- The append-only trigger, with one door: the archive function sets a transaction-local marker naming the chain and
-- the last sequence it may remove. Clients cannot set it (the REST API offers no way to run SET).
create or replace function app_private.audit_block() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_chain text := current_setting('easysign.audit_archive_chain', true);
  v_last int := nullif(current_setting('easysign.audit_archive_last', true), '')::int;
begin
  if tg_op = 'DELETE' and coalesce(v_chain, '') <> '' and v_last is not null then
    if old.chain_key = v_chain and old.chain_seq <= v_last then
      return old;
    end if;
  end if;
  raise exception 'audit_events is append-only' using errcode = '42501';
end
$$;

-- The chain head: the newest row, or else the newest archived part, or else the genesis.
create function app_private.audit_head(p_chain_key text, out seq int, out hash bytea, out at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  select e.chain_seq, e.event_hash, e.created_at into seq, hash, at
    from public.audit_events e where e.chain_key = p_chain_key order by e.chain_seq desc limit 1;
  if found then return; end if;
  select a.last_seq, a.head_hash, a.created_at into seq, hash, at
    from public.audit_archives a where a.chain_key = p_chain_key order by a.last_seq desc limit 1;
  if found then return; end if;
  seq := 0; hash := decode(repeat('00', 32), 'hex'); at := null;
end
$$;

create or replace function app_private.audit_append(
  p_chain_key text, p_org_id uuid, p_envelope_id uuid, p_recipient_id uuid,
  p_actor_type text, p_actor_id uuid, p_event_type text, p_payload jsonb default '{}'::jsonb,
  p_ip inet default null, p_user_agent text default null
) returns public.audit_events
language plpgsql security definer set search_path = '' as $$
declare
  v_prev bytea;
  v_seq int;
  v_prev_ts timestamptz;
  v_ts timestamptz;
  v_id uuid := gen_random_uuid();
  v_canon text;
  v_row public.audit_events;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_chain_key, 0));
  select h.seq, h.hash, h.at into v_seq, v_prev, v_prev_ts from app_private.audit_head(p_chain_key) h;
  v_ts := clock_timestamp();
  if v_prev_ts is not null and v_ts <= v_prev_ts then
    v_ts := v_prev_ts + interval '1 microsecond';
  end if;
  v_canon := app_private.audit_canonical(p_chain_key, v_seq + 1, v_id, p_org_id, p_envelope_id, p_recipient_id,
    p_actor_type, p_actor_id, p_event_type, p_payload, p_ip, left(p_user_agent, 500), v_ts)::text;
  insert into public.audit_events (id, chain_key, chain_seq, org_id, envelope_id, recipient_id, actor_type, actor_id,
    event_type, payload, ip, user_agent, created_at, canonical, prev_hash, event_hash)
  values (v_id, p_chain_key, v_seq + 1, p_org_id, p_envelope_id, p_recipient_id, p_actor_type, p_actor_id,
    p_event_type, coalesce(p_payload, '{}'::jsonb), p_ip, left(p_user_agent, 500), v_ts, v_canon, v_prev,
    sha256(v_prev || convert_to(v_canon, 'UTF8')))
  returning * into v_row;
  return v_row;
end
$$;

-- Verifies the rows still in the database, starting from the archived head when part of the chain is archived.
-- (The archived files are verified by the app, which has to read them from storage.) Same columns as before;
-- "events" counts every event of the chain, archived ones included.
create or replace function app_private.audit_verify(p_chain_key text)
returns table (ok boolean, events int, broken_seq int, reason text, head text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.audit_events;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  v_n int := 0;
  a public.audit_archives;
begin
  -- archived parts must be contiguous from 1, each starting where the previous ended
  for a in select * from public.audit_archives x where x.chain_key = p_chain_key order by x.first_seq loop
    if a.first_seq <> v_n + 1 then
      return query select false, v_n, a.first_seq, 'archived parts are not contiguous'::text, encode(v_prev, 'hex'); return;
    end if;
    v_n := a.last_seq;
    v_prev := a.head_hash;
  end loop;
  for r in select * from public.audit_events e where e.chain_key = p_chain_key order by e.chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_n then
      return query select false, v_n - 1, r.chain_seq, 'sequence gap'::text, encode(v_prev, 'hex'); return;
    end if;
    if r.prev_hash <> v_prev then
      return query select false, v_n - 1, r.chain_seq, 'prev link does not match the previous event'::text, encode(v_prev, 'hex'); return;
    end if;
    if sha256(v_prev || convert_to(r.canonical, 'UTF8')) <> r.event_hash then
      return query select false, v_n - 1, r.chain_seq, 'event hash does not match the stored text'::text, encode(v_prev, 'hex'); return;
    end if;
    if r.canonical::jsonb is distinct from app_private.audit_canonical(r.chain_key, r.chain_seq, r.id, r.org_id, r.envelope_id,
        r.recipient_id, r.actor_type, r.actor_id, r.event_type, r.payload, r.ip, r.user_agent, r.created_at) then
      return query select false, v_n - 1, r.chain_seq, 'a column disagrees with the hashed text'::text, encode(v_prev, 'hex'); return;
    end if;
    v_prev := r.event_hash;
  end loop;
  return query select true, v_n, null::int, null::text, encode(v_prev, 'hex');
end
$$;

-- Step 1: which finished documents are due, oldest first (finished at least p_min_age_days ago, events still in the
-- database, no sealing or deletion half-done).
create function public.audit_archive_due(p_min_age_days int, p_limit int) returns table (envelope_id uuid, chain_key text, events bigint)
language sql stable security definer set search_path = '' as $$
  select e.id, 'env:' || e.id::text, count(*)
    from public.envelopes e
    join public.audit_events x on x.chain_key = 'env:' || e.id::text
   where e.status in ('completed', 'declined', 'voided', 'expired')
     and coalesce(e.completed_at, e.expired_at, e.updated_at) < now() - make_interval(days => greatest(p_min_age_days, 0))
     and (e.deletion_started_at is null or e.deleted_at is not null)
     and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id and j.status in ('queued', 'running'))
   group by e.id
   order by min(coalesce(e.completed_at, e.expired_at, e.updated_at))
   limit greatest(least(p_limit, 100), 1)
$$;

-- Step 2: the rows to put in the file (every column, in chain order).
create function public.audit_archive_rows(p_chain_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'chain_key', e.chain_key, 'chain_seq', e.chain_seq, 'id', e.id, 'org_id', e.org_id, 'envelope_id', e.envelope_id,
      'recipient_id', e.recipient_id, 'actor_type', e.actor_type, 'actor_id', e.actor_id, 'event_type', e.event_type,
      'payload', e.payload, 'ip', host(e.ip), 'user_agent', e.user_agent,
      'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'canonical', e.canonical, 'prev_hash', encode(e.prev_hash, 'hex'), 'event_hash', encode(e.event_hash, 'hex'))
    order by e.chain_seq), '[]'::jsonb)
  from public.audit_events e where e.chain_key = p_chain_key
$$;

-- Step 3 (after the app stored the file): record the part and remove exactly those rows.
create function public.audit_archive_commit(p_chain_key text, p_first_seq int, p_last_seq int, p_head_hash text,
  p_storage_path text, p_file_sha256 text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_env uuid;
  v_org uuid;
  v_head bytea := decode(p_head_hash, 'hex');
  v_check record;
  v_n int;
begin
  if p_chain_key !~ '^env:[0-9a-f-]{36}$' then
    raise exception 'ES_INVALID: only document chains are archived' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_chain_key, 0));   -- no event can be appended meanwhile
  v_env := substr(p_chain_key, 5)::uuid;
  select e.org_id into v_org from public.envelopes e where e.id = v_env;
  -- the range must start right after what is already archived and end at a row that exists with that hash
  if p_first_seq <> coalesce((select max(a.last_seq) from public.audit_archives a where a.chain_key = p_chain_key), 0) + 1
     or not exists (select 1 from public.audit_events x where x.chain_key = p_chain_key and x.chain_seq = p_last_seq and x.event_hash = v_head) then
    raise exception 'ES_INVALID: the archive range does not match the chain' using errcode = '22023';
  end if;
  select * into v_check from app_private.audit_verify(p_chain_key);
  if not v_check.ok then
    raise exception 'ES_INVALID: the chain does not verify (%): nothing archived', v_check.reason using errcode = '22023';
  end if;
  insert into public.audit_archives (chain_key, org_id, envelope_id, first_seq, last_seq, events, head_hash, storage_path, file_sha256)
    values (p_chain_key, v_org, v_env, p_first_seq, p_last_seq, p_last_seq - p_first_seq + 1, v_head, p_storage_path, p_file_sha256);
  perform set_config('easysign.audit_archive_chain', p_chain_key, true);
  perform set_config('easysign.audit_archive_last', p_last_seq::text, true);
  delete from public.audit_events x where x.chain_key = p_chain_key and x.chain_seq between p_first_seq and p_last_seq;
  get diagnostics v_n = row_count;
  perform set_config('easysign.audit_archive_chain', '', true);
  perform set_config('easysign.audit_archive_last', '', true);
  if v_n <> p_last_seq - p_first_seq + 1 then
    raise exception 'ES_INVALID: expected to archive % events, found %', p_last_seq - p_first_seq + 1, v_n using errcode = '22023';
  end if;
  select * into v_check from app_private.audit_verify(p_chain_key);
  if not v_check.ok then
    raise exception 'ES_INVALID: the chain would not verify after archiving (%)', v_check.reason using errcode = '22023';
  end if;
  return v_n;
end
$$;

revoke all on function app_private.audit_head(text) from public, anon, authenticated, service_role;
revoke all on function public.audit_archive_due(int, int), public.audit_archive_rows(text),
  public.audit_archive_commit(text, int, int, text, text, text) from public, anon, authenticated;
grant execute on function public.audit_archive_due(int, int), public.audit_archive_rows(text),
  public.audit_archive_commit(text, int, int, text, text, text) to service_role;

-- down (manual): only while nothing has been archived (archived rows cannot be put back by a migration):
-- drop the three public functions and app_private.audit_head; re-create app_private.audit_append, audit_verify and
-- audit_block exactly as in 20261118050720_functions.sql; drop table public.audit_archives;
-- delete from storage.buckets where id = 'audit-archives' (only if empty).
