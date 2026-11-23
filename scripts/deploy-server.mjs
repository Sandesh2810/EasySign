// npm run deploy:server [-- --build local|server] [-- --settings] [-- --dry-run]
// Puts the committed code on the server as a new release and switches to it (RUNBOOK "Server and domain").
// The server is shared with another app, so this script:
//   - logs in ONLY as the YouNMeSign Linux user (DEPLOY_USER), with its own key, and touches only that user's home;
//   - restarts ONLY the processes easysign-web and easysign-worker;
//   - checks the other app's address before and after and says so loudly if its answer changed;
//   - goes back to the previous release by itself when the new one does not answer.
// Where to log in is read from app\.env.deploy (never committed): DEPLOY_HOST, DEPLOY_USER, DEPLOY_KEY (path of the
// key file), DEPLOY_PORT (the local port the site listens on), DEPLOY_APP_URL, and OTHER_APP_URL (the other app's
// address, only ever fetched). --settings also writes the two settings files on the server from app\.env.local
// (values are never printed): web.env without the seal key, worker.env with it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
const argAt = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n) => process.argv.includes(n);
const check = (name, ok, detail = '') => {
  console.log(`CHECK | ${name} | ${ok ? 'PASS' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
  if (!ok) throw new Error(`${name}: ${detail || 'failed'}`);
};

if (!existsSync('.env.deploy')) {
  console.error('app\\.env.deploy is missing. It names the server (DEPLOY_HOST, DEPLOY_USER, DEPLOY_KEY, DEPLOY_PORT, DEPLOY_APP_URL, OTHER_APP_URL). See RUNBOOK "Server and domain".');
  process.exit(1);
}
const cfg = parseEnv(readFileSync('.env.deploy', 'utf8'));
for (const k of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_KEY', 'DEPLOY_PORT', 'DEPLOY_APP_URL']) {
  if (!cfg[k]) {
    console.error(`${k} is not set in app\\.env.deploy.`);
    process.exit(1);
  }
}
const MODE = argAt('--build') ?? cfg.DEPLOY_BUILD ?? 'local';
const DRY = has('--dry-run');
const target = `${cfg.DEPLOY_USER}@${cfg.DEPLOY_HOST}`;
const sshArgs = ['-i', cfg.DEPLOY_KEY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
const ssh = (command) => run('ssh', [...sshArgs, target, command]);
const scp = (from, to) => run('scp', [...sshArgs, '-q', from, `${target}:${to}`]);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function otherApp() {
  if (!cfg.OTHER_APP_URL) return 'not checked (OTHER_APP_URL is not set)';
  try {
    const r = await fetch(cfg.OTHER_APP_URL, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    return `HTTP ${r.status}`;
  } catch (e) {
    return `no answer (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** The two settings files, made from .env.local with the server's own values; written with owner-only rights. */
function settingsFiles(dir) {
  const local = parseEnv(readFileSync('.env.local', 'utf8'));
  const server = {
    ...local,
    APP_URL: cfg.DEPLOY_APP_URL,
    NOTIFY_MODE: cfg.DEPLOY_NOTIFY_MODE ?? 'sandbox',   // "live" only on Sandesh's explicit go-ahead
    NODE_ENV: 'production',
  };
  delete server.WEBHOOK_ALLOW_LOOPBACK;                  // a development-only allowance
  delete server.SUPABASE_DB_URL;                         // the owner database connection never goes to the server
  if (cfg.DEPLOY_WEBHOOK_DENY_IPS) server.WEBHOOK_DENY_IPS = cfg.DEPLOY_WEBHOOK_DENY_IPS;
  const line = ([k, v]) => `${k}=${JSON.stringify(v)}`;
  const isSeal = (k) => k.startsWith('SEAL_');
  const isPublic = (k) => k.startsWith('NEXT_PUBLIC_');
  writeFileSync(path.join(dir, 'worker.env'), `${Object.entries(server).map(line).join('\n')}\n`);
  writeFileSync(path.join(dir, 'web.env'), `${Object.entries(server).filter(([k]) => !isSeal(k)).map(line).join('\n')}\n`);
  writeFileSync(path.join(dir, 'build.env'), `${Object.entries(server).filter(([k]) => isPublic(k)).map(line).join('\n')}\n`);
  return ['web.env', 'worker.env', 'build.env'];
}

async function main() {
  console.log(`Deploy to ${target} (${cfg.DEPLOY_APP_URL}), build: ${MODE}${DRY ? ', DRY RUN (nothing is uploaded)' : ''}`);
  check('build mode', MODE === 'local' || MODE === 'server', MODE);
  check('nothing uncommitted', run('git', ['status', '--porcelain']).out === '', 'commit first: a release is exactly one commit');
  const commit = run('git', ['rev-parse', '--short', 'HEAD']).out;
  const rel = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${commit}`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'younmesign-deploy-'));
  try {
    const before = await otherApp();
    console.log(`CHECK | other app before | ${before}`);

    const who = ssh('id -un; test "$(id -u)" != 0 && echo notroot; test -x "$HOME/node/bin/node" && "$HOME/node/bin/node" -v');
    check('server login', who.ok && who.out.split(/\r?\n/)[0] === cfg.DEPLOY_USER && who.out.includes('notroot'), who.ok ? who.out.replace(/\s+/g, ' ') : who.out.slice(-200));

    // ---------- pack ----------
    const source = path.join(tmp, `${rel}-source.tar.gz`);
    check('pack the code', run('git', ['archive', '--format=tar.gz', '-o', source, 'HEAD']).ok, commit);
    let build = null;
    if (MODE === 'local') {
      const env = { ...process.env, APP_URL: cfg.DEPLOY_APP_URL };   // https in the build turns HSTS on
      const b = run(npm, ['run', '--silent', 'build'], { env, shell: process.platform === 'win32' });
      check('build the site', b.ok, b.ok ? '' : b.out.slice(-400));
      const w = run('node', ['scripts/build-worker.mjs']);
      check('build the worker', w.ok && existsSync('dist/worker.mjs'), w.ok ? '' : w.out.slice(-400));
      build = path.join(tmp, `${rel}-build.tar.gz`);
      const t = run('tar', ['-czf', build, '--exclude=.next/cache', '--exclude=.next/dev', '--exclude=.next/trace*', '.next', 'dist/worker.mjs']);
      check('pack the build', t.ok, t.out.slice(-200));
    }
    if (DRY) {
      console.log(`DRY RUN: would upload ${path.basename(source)}${build ? ` and ${path.basename(build)}` : ''} and run deploy/remote-install.sh ${rel} ${MODE} ${cfg.DEPLOY_PORT}`);
      return;
    }

    // ---------- upload ----------
    check('server folders', ssh('umask 077; mkdir -p "$HOME/incoming" "$HOME/releases" "$HOME/shared" "$HOME/logs"').ok);
    if (has('--settings')) {
      const dir = path.join(tmp, 'settings');
      mkdirSync(dir);
      for (const f of settingsFiles(dir)) check(`settings file ${f}`, scp(path.join(dir, f), `shared/${f}`).ok);
      check('settings readable only by the app user', ssh('chmod 600 "$HOME"/shared/*.env && chmod 700 "$HOME/shared"').ok);
    }
    check('upload the code', scp(source, `incoming/${path.basename(source)}`).ok);
    if (build) check('upload the build', scp(build, `incoming/${path.basename(build)}`).ok);
    check('upload the installer', scp('deploy/remote-install.sh', 'incoming/remote-install.sh').ok);

    // ---------- install and switch ----------
    const inst = ssh(`bash "$HOME/incoming/remote-install.sh" ${rel} ${MODE} ${cfg.DEPLOY_PORT} ${cfg.DEPLOY_APP_URL}`);
    console.log(inst.out);
    check('install and switch', inst.ok);

    const after = await otherApp();
    console.log(`CHECK | other app after | ${after}`);
    if (after !== before) throw new Error(`THE OTHER APP ANSWERS DIFFERENTLY NOW (before: ${before}; after: ${after}). Look at it at once; "pm2 stop easysign-web easysign-worker" as the app user frees this app's memory.`);
    console.log(`DEPLOYED ${rel}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`DEPLOY FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
