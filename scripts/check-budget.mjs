// npm run check:budget
// Reports how much of each free-tier limit the EasySign project is using: database size, stored files,
// registered users, emails today and this month. Warns from 70%. Exits with an error (so a phase
// verification fails) when anything is above 80%. Prints no secrets. Works in cmd.exe.
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { assess, formatAmount, verificationFails } from '../src/lib/free-tier.ts';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('Settings are missing. Run "npm run setup:env" first (or double-click Enter-Supabase-Key.cmd).');
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await db.rpc('platform_usage');
const row = Array.isArray(data) ? data[0] : data;
if (error || !row) {
  console.error(`The usage numbers could not be read: ${error?.message ?? 'no data'}`);
  process.exit(2);
}

const metrics = assess({
  dbBytes: Number(row.db_bytes),
  storageBytes: Number(row.storage_bytes),
  userCount: Number(row.user_count),
  emailsToday: Number(row.emails_today),
  emailsMonth: Number(row.emails_month),
});

const WORD = { ok: 'ok', warn: 'WARNING (70% or more)', fail: 'TOO HIGH (above 80%)', block: 'FULL (90% or more: new sign-ups and uploads are refused)' };
console.log('EasySign free-tier check');
console.log('------------------------');
for (const m of metrics) {
  const pct = `${(m.share * 100).toFixed(1)}%`.padStart(6);
  console.log(`${m.label.padEnd(24)} ${formatAmount(m.used, m.unit).padStart(10)} of ${formatAmount(m.limit, m.unit).padEnd(9)} ${pct}  ${WORD[m.level]}`);
}
console.log('------------------------');
console.log('Limits: Supabase Free and Resend Free, as recorded in docs\\FREE_TIER_BUDGET.md. "Registered users" counts every account, which is more than the monthly-active figure the limit is about.');
if (verificationFails(metrics)) {
  console.error('RESULT: FAIL. At least one number is above 80% of its free limit.');
  process.exit(1);
}
console.log(metrics.some((m) => m.level === 'warn') ? 'RESULT: PASS, with warnings.' : 'RESULT: PASS. Everything is under 70% of its free limit.');
