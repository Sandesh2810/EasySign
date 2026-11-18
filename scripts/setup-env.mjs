// Interactive setup of app\.env.local (gitignored). Run from cmd:  npm run setup:env
// Secrets are typed here, never into chat. Existing values are kept unless you type a new one.
// Generated keys (signer-token and session keys) are created once and never shown.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env.local');

// name, description, kind: plain (shown), secret (hidden input), generated (random 32 bytes), default
export const VARS = [
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase project URL', 'plain', 'https://jwvmviijpdarawrfvzan.supabase.co'],
  ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'Supabase publishable key (starts sb_publishable_; safe to expose)', 'plain', ''],
  ['SUPABASE_SECRET_KEY', 'Supabase SECRET key (Dashboard > Project Settings > API Keys; starts sb_secret_)', 'secret', ''],
  ['APP_URL', 'Base URL of the app', 'plain', 'http://localhost:3000'],
  ['NOTIFY_MODE', 'Email mode: log | sandbox | live', 'plain', 'log'],
  ['SIGNER_TOKEN_KEY', 'Key that derives signer links', 'generated', ''],
  ['SESSION_COOKIE_KEY', 'Key that signs signer session cookies', 'generated', ''],
  ['NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'Cloudflare Turnstile site key (leave empty until set up)', 'plain', ''],
  ['TURNSTILE_SECRET_KEY', 'Cloudflare Turnstile secret key (leave empty until set up)', 'secret', ''],
];

const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

function ask(rl, question, hidden) {
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => resolve(a.trim()));
    const out = rl.output;
    const orig = rl._writeToOutput;
    rl.question(question, (a) => {
      rl._writeToOutput = orig;
      out.write('\n');
      resolve(a.trim());
    });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) orig.call(rl, s);
    };
  });
}

async function main() {
  const current = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
  const flags = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith('--set=')).map((a) => a.slice(6).split(/=(.*)/s).slice(0, 2)),
  );
  const nonInteractive = process.argv.includes('--defaults');
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const next = { ...current };

  console.log('EasySign environment setup. Press Enter to keep the current value.\n');
  for (const [name, desc, kind, def] of VARS) {
    const has = Boolean(current[name]);
    if (kind === 'generated') {
      if (!has) next[name] = randomBytes(32).toString('base64url');
      console.log(`${name}: ${has ? 'kept' : 'generated'}`);
      continue;
    }
    if (flags[name] !== undefined) {
      next[name] = flags[name];
      console.log(`${name}: set from command line`);
      continue;
    }
    if (nonInteractive) {
      if (!has) next[name] = def;
      console.log(`${name}: ${has ? 'kept' : def ? 'default' : 'empty'}`);
      continue;
    }
    const shown = kind === 'secret' ? (has ? '(set, hidden)' : '(not set)') : current[name] || def || '(empty)';
    const a = await ask(rl, `${name}\n  ${desc}\n  current: ${shown}\n  new value: `, kind === 'secret');
    next[name] = a || current[name] || def;
  }
  rl?.close();

  const body =
    '# EasySign local environment. NEVER commit this file. Managed by: npm run setup:env\n' +
    VARS.map(([name]) => `${name}=${next[name] ?? ''}`).join('\n') +
    '\n';
  writeFileSync(file, body, { mode: 0o600 });
  const missing = VARS.filter(([n, , k]) => !next[n] && k !== 'generated' && !n.includes('TURNSTILE')).map(([n]) => n);
  console.log(`\nWrote .env.local (${VARS.length} variables).` + (missing.length ? `\nStill empty: ${missing.join(', ')}` : '\nAll required values present.'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
