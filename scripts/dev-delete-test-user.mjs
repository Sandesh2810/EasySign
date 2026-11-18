// Development helper: remove a synthetic @example.test account that has no sent documents (drafts are
// removed with it). Refuses any address that is not @example.test. Prints no secrets.
// Usage: node --env-file=.env.local scripts/dev-delete-test-user.mjs someone@example.test
//        node --env-file=.env.local scripts/dev-delete-test-user.mjs --prefix=signup.check.
import { createClient } from '@supabase/supabase-js';

const arg = (process.argv[2] ?? '').toLowerCase();
const prefix = arg.startsWith('--prefix=') ? arg.slice(9) : null;
if (!prefix && !/^[a-z0-9._-]+@example\.test$/.test(arg)) {
  console.error('Give a synthetic address ending in @example.test, or --prefix=<start of the address>');
  process.exit(2);
}
if (prefix !== null && !/^[a-z0-9._-]{6,}$/.test(prefix)) {
  console.error('The prefix must be at least 6 characters.');
  process.exit(2);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
const users = (list.data?.users ?? []).filter((u) => {
  const e = (u.email ?? '').toLowerCase();
  return e.endsWith('@example.test') && (prefix !== null ? e.startsWith(prefix) : e === arg);
});
if (users.length === 0) console.log('No matching account.');
for (const u of users) {
  const orgs = await db.from('memberships').select('org_id').eq('user_id', u.id).eq('role', 'owner');
  let blocked = false;
  for (const o of orgs.data ?? []) {
    const sent = await db.from('envelopes').select('id', { count: 'exact', head: true }).eq('org_id', o.org_id).neq('status', 'draft');
    if ((sent.count ?? 0) > 0) {
      blocked = true;
      continue;
    }
    await db.from('envelopes').delete().eq('org_id', o.org_id);
    await db.from('organizations').delete().eq('id', o.org_id);
  }
  if (blocked) {
    console.log(`${u.email}: kept (it has sent documents, which cannot be deleted)`);
    continue;
  }
  const del = await db.auth.admin.deleteUser(u.id);
  console.log(`${u.email}: ${del.error ? `not deleted (${del.error.message})` : 'deleted'}`);
}
