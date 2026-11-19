// npm run verify:phase2
// Runs every automatic check for Phase 2 in order and prints one summary. Works in cmd.exe.
//   1. type check   2. lint   3. unit tests   4. free-tier budget (fails above 80%)
//   5. secret scan  6. route tests against the running app (start it first: Start-YouNMeSign.cmd)
//   7. production build
// The database tests (supabase\tests\*.sql) cannot be run from here: this PC has no direct database
// connection, only the app's keys. They are run through the Supabase connector and their results are kept
// in exports\ (see the last lines of the summary). This script says so rather than pretending.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const steps = [
  ['Type check', npx, ['tsc', '--noEmit']],
  ['Lint', npx, ['eslint', '.']],
  ['Unit tests', npm, ['test', '--silent']],
  ['Free-tier budget', npm, ['run', '--silent', 'check:budget']],
  ['Secret scan', npm, ['run', '--silent', 'secret-scan']],
  ['Route tests (running app)', npm, ['run', '--silent', 'test:api']],
  ['Production build', npm, ['run', '--silent', 'build']],
];

const results = [];
for (const [name, cmd, args] of steps) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  results.push({ name, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

const exportsDir = path.resolve(process.cwd(), '..', 'exports');
const sqlEvidence = existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => /sql-tests/.test(f)).sort() : [];

console.log('\n================ YouNMeSign Phase 2 verification ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${String(r.seconds).padStart(4)} s`);
console.log('NOTE  Database tests: run through the Supabase connector, not from this PC. Latest saved results:');
for (const f of sqlEvidence) console.log(`        exports\\${f}`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? 'RESULT: PASS (automatic checks on this PC)' : `RESULT: FAIL (${failed.map((r) => r.name).join(', ')})`);
process.exit(failed.length === 0 ? 0 : 1);
