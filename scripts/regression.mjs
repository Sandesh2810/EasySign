// npm run regression [-- --start-after 00:02]
// Phase 5 slice 10 (AT5.7, D-98): every end-to-end check, one after another, then the whole verification bundle; a
// summary is written to exports\phase5\regression-<time>.md. Needs the app AND the background worker running.
// --start-after HH:MM waits until that UTC time first (for example just after the daily email reset, so emails the
// checks need are not held back by the allowance). A check that failed because of the sign-in limit (30 a quarter hour
// from one address) is tried once more after 15 minutes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(appDir, '..', 'exports', 'phase5');
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const CHECKS = ['team', 'templates', 'fields', 'formulas', 'prefill', 'groups', 'handoff', 'comments', 'bulk', 'inperson', 'forms', 'branding', 'api', 'webhooks', 'reports', 'usage', 'languages', 'pwa'];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startAfter = argAt('--start-after');
if (startAfter && /^\d{2}:\d{2}$/.test(startAfter)) {
  const [h, m] = startAfter.split(':').map(Number);
  const now = new Date();
  let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m);
  if (at < now.getTime() - 12 * 3600_000) at += 86_400_000; // "00:02" said late in the evening means tomorrow
  if (at > Date.now()) {
    log(`waiting until ${new Date(at).toISOString().slice(11, 16)} UTC`);
    await sleep(at - Date.now());
  }
}

function run(script) {
  const t = Date.now();
  const r = spawnSync(npm, ['run', '--silent', script], { cwd: appDir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const last = out.trim().split(/\r?\n/).filter((l) => /PASSED|FAILED|could not|COMPLETED/i.test(l)).at(-1) ?? out.trim().split(/\r?\n/).at(-1) ?? '';
  return { ok: r.status === 0, seconds: Math.round((Date.now() - t) / 1000), last: last.slice(0, 200), limited: /too many|rate.?limit|429/i.test(out) };
}

const results = [];
for (const name of CHECKS) {
  log(`e2e:${name}…`);
  let r = run(`e2e:${name}`);
  if (!r.ok && r.limited) {
    log(`  e2e:${name} hit a limit; trying again in 15 minutes`);
    await sleep(15 * 60_000);
    r = { ...run(`e2e:${name}`), retried: true };
  }
  results.push({ name: `e2e:${name}`, ...r });
  log(`  ${r.ok ? 'PASS' : 'FAIL'} e2e:${name} (${r.seconds} s) ${r.last}`);
}
log('verify:phase4…');
const v = run('verify:phase4');
results.push({ name: 'verify:phase4', ...v });
log(`  ${v.ok ? 'PASS' : 'FAIL'} verify:phase4 (${v.seconds} s) ${v.last}`);

mkdirSync(OUT, { recursive: true });
const at = new Date().toISOString();
const md = [`# Regression, ${at.slice(0, 16).replace('T', ' ')} UTC`, '', '| Check | Result | Seconds | Last line |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'}${r.retried ? ' (after a retry)' : ''} | ${r.seconds} | ${r.last.replace(/\|/g, '/')} |`), ''].join('\n');
const file = path.join(OUT, `regression-${at.replace(/[:.]/g, '-')}.md`);
writeFileSync(file, md);
console.log(`\n${md}`);
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log(failed.length ? `REGRESSION FAILED: ${failed.join(', ')} (summary ${file})` : `REGRESSION PASSED (${results.length} checks; summary ${file})`);
process.exit(failed.length ? 1 : 0);
