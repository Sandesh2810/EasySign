// npm run server:worker -- status | pause | resume
// The live site's background worker (PM2 name easysign-worker on the server; D-99). The server and this PC share one
// database, so tests on this PC need the live worker paused: while paused, the live site still answers, but it sends
// no email and seals no document until "resume". Touches only the YouNMeSign user's own two processes.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runs one action; returns { ok, state, text }. state: "online" | "stopped" | "absent" | "unknown". */
export function serverWorker(action) {
  const file = path.join(appDir, '.env.deploy');
  if (!existsSync(file)) return { ok: false, state: 'unknown', text: 'app\\.env.deploy is missing (the site is not on a server yet).' };
  const cfg = parseEnv(readFileSync(file, 'utf8'));
  const pm2 = 'export PATH=$HOME/node/bin:$PATH PM2_HOME=$HOME/.pm2; ';
  const show = `pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).find(x=>x.name==="easysign-worker");console.log("STATE="+(p?p.pm2_env.status:"absent"))})'`;
  const steps = { status: '', pause: 'pm2 stop easysign-worker >/dev/null; ', resume: 'pm2 start easysign-worker >/dev/null; pm2 save >/dev/null; ' }[action];
  if (steps === undefined) return { ok: false, state: 'unknown', text: 'Say status, pause or resume.' };
  const r = spawnSync('ssh', ['-i', cfg.DEPLOY_KEY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    `${cfg.DEPLOY_USER}@${cfg.DEPLOY_HOST}`, `${pm2}${steps}${show}`], { encoding: 'utf8' });
  const state = /STATE=(\w+)/.exec(r.stdout ?? '')?.[1] ?? 'unknown';
  const want = { status: state, pause: 'stopped', resume: 'online' }[action];
  const ok = r.status === 0 && state === want && state !== 'unknown';
  return { ok, state, text: ok ? `The live worker is ${state === 'online' ? 'running' : state === 'stopped' ? 'paused (no email is sent and nothing is sealed on the live site until "resume")' : state}.` : `Could not ${action} the live worker: ${(r.stderr || r.stdout || 'no answer').trim().slice(-300)}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = serverWorker(process.argv[2] ?? 'status');
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
