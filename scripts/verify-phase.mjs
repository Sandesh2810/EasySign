// npm run verify:phase3   |   npm run verify:phase4
// Runs every automatic check for that phase in order and prints one summary. Works in cmd.exe.
// Start the app first (Start-YouNMeSign.cmd, or npm run dev) for the route tests.
//   1. type check   2. lint   3. unit tests   4. free-tier budget (fails above 80%)   5. secret scan
//   6. route tests against the running app   7. database tests (npm run test:sql; Phase 3: the Phase 1-3 files,
//   Phase 4: every file)   8. production build   9. accessibility audit (on a separate server at port 3100, which
//   is stopped again afterwards)
// The end-to-end checks (npm run e2e:...) are not part of this bundle: each signs in, and the sign-in limits do not
// allow them all in a row. They are listed at the end; run them as the RUNBOOK says.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
const phase = process.argv[2];
if (phase !== '3' && phase !== '4') {
  console.error('Usage: node scripts/verify-phase.mjs 3|4');
  process.exit(2);
}
const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';
const npx = win ? 'npx.cmd' : 'npx';
const sqlFilter = phase === '3' ? ['rls_phase1', 'slice8_', 'slice10_', 'slice11_', 'phase3_'] : [];
const AUDIT_PORT = 3100;

const steps = [
  ['Type check', npx, ['tsc', '--noEmit']],
  ['Lint', npx, ['eslint', '.']],
  ['Unit tests', npm, ['test', '--silent']],
  ['Free-tier budget', npm, ['run', '--silent', 'check:budget']],
  ['Secret scan', npm, ['run', '--silent', 'secret-scan']],
  ['Route tests (running app)', npm, ['run', '--silent', 'test:api']],
  [`Database tests (${phase === '3' ? 'Phases 1-3' : 'all'})`, npm, ['run', '--silent', 'test:sql', '--', ...sqlFilter]],
  ['Production build', npm, ['run', '--silent', 'build']],
];

const results = [];
const run = (name, cmd, args, env) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, env: { ...process.env, ...env } });
  results.push({ name, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
  return r.status === 0;
};
for (const [name, cmd, args] of steps) run(name, cmd, args);

// accessibility audit against the production build, on its own port; the server is always stopped afterwards
if (results.at(-1).ok) {
  process.stdout.write(`\n=== Accessibility audit (port ${AUDIT_PORT}) ===\n`);
  const server = spawn(npx, ['next', 'start', '-p', String(AUDIT_PORT)], { shell: win, env: { ...process.env, APP_URL: `http://localhost:${AUDIT_PORT}` }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://localhost:${AUDIT_PORT}/login`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (up) run('Accessibility audit', npm, ['run', '--silent', 'a11y', '--', '--app', `http://localhost:${AUDIT_PORT}`]);
  else results.push({ name: 'Accessibility audit', ok: false, seconds: 0 });
  if (win) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill('SIGTERM');
} else {
  results.push({ name: 'Accessibility audit (needs the build)', ok: false, seconds: 0 });
}

console.log(`\n================ YouNMeSign Phase ${phase} verification ================`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(34)} ${String(r.seconds).padStart(4)} s`);
console.log('NOTE  End-to-end checks are run separately (sign-in limits):');
console.log(
  phase === '3'
    ? '        Phase 3 has no npm end-to-end scripts; its browser runs are in exports\\phase3*.'
    : '        npm run e2e:team, e2e:templates, e2e:fields, e2e:formulas, e2e:prefill, e2e:groups, e2e:handoff,\n        e2e:comments, e2e:bulk, e2e:inperson, e2e:forms, e2e:branding',
);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `VERIFY PHASE ${phase} FAILED (${failed.length} of ${results.length})` : `VERIFY PHASE ${phase} PASSED (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
