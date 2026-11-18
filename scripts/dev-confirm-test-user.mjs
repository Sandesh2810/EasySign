// Development helper: confirm the email of a synthetic @example.test account and mark it approved,
// so it can be used for trying the app locally without opening the confirmation "email".
// Usage: node --env-file=.env.local scripts/dev-confirm-test-user.mjs someone@example.test
// Refuses any address that is not @example.test. Prints no secrets.
import { createClient } from '@supabase/supabase-js';

const email = (process.argv[2] ?? '').toLowerCase();
if (!/^[a-z0-9._-]+@example\.test$/.test(email)) {
  console.error('Give a synthetic address ending in @example.test');
  process.exit(2);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const list = await db.auth.admin.listUsers({ page: 1, perPage: 500 });
const user = list.data?.users.find((u) => (u.email ?? '').toLowerCase() === email);
if (!user) {
  console.error('No such account. Sign up in the app first.');
  process.exit(1);
}
if (!user.email_confirmed_at) {
  const upd = await db.auth.admin.updateUserById(user.id, { email_confirm: true });
  if (upd.error) throw new Error(upd.error.message);
}
const ctl = await db.from('account_controls').update({ approved: true, daily_envelope_cap: 1000, daily_recipient_cap: 1000 }).eq('user_id', user.id).select('approved, trust_level, is_platform_admin').single();
if (ctl.error) throw new Error(ctl.error.message);
console.log(`${email}: email confirmed, approved=${ctl.data.approved}, trust=${ctl.data.trust_level}, admin=${ctl.data.is_platform_admin}`);
