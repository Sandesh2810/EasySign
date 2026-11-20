// Prints what the report-only Content-Security-Policy would have blocked (Phase 3 slice 5, AT3.5, D-70).
// Usage:  npm run csp:report            (last 48 hours)
//         npm run csp:report -- 168     (last 168 hours)
// The policy may be switched to enforcing only after 48 hours of end-to-end runs show "No reports".
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('Settings are missing. Run "npm run setup:env" first.');
  process.exit(1);
}
const hours = Math.max(1, Math.min(720, Number.parseInt(process.argv[2] ?? '48', 10) || 48));
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await db.rpc('csp_report_summary', { p_hours: hours });
if (error) {
  console.error(`Could not read the reports: ${error.message}`);
  process.exit(1);
}
if (!data.length) {
  console.log(`No reports in the last ${hours} hours.`);
} else {
  console.log(`Reports in the last ${hours} hours (what the policy WOULD have blocked):`);
  for (const r of data) console.log(`  ${String(r.reports).padStart(5)}  ${r.directive.padEnd(18)} ${(r.blocked || '-').padEnd(30)} on ${r.document_path || '-'}  (last ${r.last_seen.slice(0, 16).replace('T', ' ')} UTC)`);
  process.exitCode = 2;
}
