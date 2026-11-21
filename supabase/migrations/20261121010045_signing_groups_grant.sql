-- YouNMeSign Phase 4 slice 6 (D-81), fix: signed-in users read recipients through a column list (every column except the
-- access-code hash, migration 20261118050740); the two new signing-group columns were missing from it, so the document
-- page's query failed and showed no people. Found by npm run e2e:groups.
-- down: revoke select (signing_group, group_completed_by) on public.recipients from authenticated;
grant select (signing_group, group_completed_by) on public.recipients to authenticated;
