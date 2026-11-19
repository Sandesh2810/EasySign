-- EasySign Phase 2 / migration 16: let the server READ the identity-check counters (slice 7).
-- New tables get no privileges at all (migration 1), and migration 15 granted none on recipient_auth,
-- so the document page could not show the sender that a person's link is locked. Read access only:
-- every change still goes through the functions of migration 15. Signed-in users and visitors get nothing.

grant select on public.recipient_auth to service_role;

-- down (manual): revoke select on public.recipient_auth from service_role;
