// npm run test:sql [-- <file name filter> ...]
// Runs the database test files in supabase\tests against the project's database, one at a time, through the direct
// connection the backups use (SUPABASE_DB_URL, see RUNBOOK "Backups"). Each file is one block that always ends by
// raising RLS_TEST_RESULTS, so everything it did is rolled back and nothing is left behind. Prints each file's result
// and a total; exits with an error if any test failed or any file stopped early. Works in cmd.exe.
//   npm run test:sql                     every file
//   npm run test:sql -- phase4_ slice1   only files whose name contains one of these
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbClient } from './lib/db.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const dir = path.join(appDir, 'supabase', 'tests');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Phase 1 first, then the rest in name order
const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort((a, b) => (a === 'rls_phase1.sql' ? -1 : b === 'rls_phase1.sql' ? 1 : a.localeCompare(b)));
const files = filters.length ? all.filter((f) => filters.some((x) => f.includes(x))) : all;
if (!files.length) {
  console.error(`No test files match ${filters.join(', ')}.`);
  process.exit(2);
}

const client = dbClient(appDir, 'younmesign-sql-tests');
await client.connect();
const rows = [];
try {
  for (const f of files) {
    const t0 = Date.now();
    let message = '';
    try {
      await client.query(readFileSync(path.join(dir, f), 'utf8'));
      message = 'the file finished without its results block';
    } catch (e) {
      message = String(e?.message ?? e);
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const m = /SUMMARY passed=(\d+) failed=(\d+)/.exec(message);
    if (m) {
      const failedLine = /FAILED: (.*)/.exec(message)?.[1] ?? '';
      rows.push({ f, passed: Number(m[1]), failed: Number(m[2]), seconds, note: Number(m[2]) ? failedLine.slice(0, 400) : '' });
    } else {
      rows.push({ f, passed: 0, failed: 1, seconds, note: `stopped early: ${message.split('\n')[0].slice(0, 300)}` });
    }
    const r = rows.at(-1);
    console.log(`${r.failed ? 'FAIL' : 'PASS'}  ${f.padEnd(40)} ${String(r.passed).padStart(4)} passed ${String(r.failed).padStart(3)} failed  ${seconds} s${r.note ? `\n      ${r.note}` : ''}`);
  }
} finally {
  await client.end();
}
const passed = rows.reduce((n, r) => n + r.passed, 0);
const failed = rows.reduce((n, r) => n + r.failed, 0);
console.log(failed ? `SQL TESTS FAILED: ${failed} failed, ${passed} passed, in ${rows.length} files` : `SQL TESTS PASSED: ${passed} tests in ${rows.length} files`);
process.exit(failed ? 1 : 0);
