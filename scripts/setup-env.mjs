// Interactive setup of app\.env.local (gitignored). Run from cmd:  npm run setup:env
// Easiest way on Windows: double-click "Enter-Supabase-Key.cmd" in the EasySign folder.
// Secrets are typed here, never into chat. Existing values are kept unless you type a new one.
// Generated keys are created once and never shown.
//   --only=NAME[,NAME]   ask only for these variables (everything else is kept or defaulted)
//   --defaults           ask nothing
//   --set=NAME=value     set a non-secret value from the command line
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSealP12 } from './lib/seal-key.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, '.env.local');

// name, description, kind: plain (shown), secret (hidden input), generated (random 32 bytes), default
export const VARS = [
  ['NEXT_PUBLIC_SUPABASE_URL', 'Supabase project URL', 'plain', 'https://jwvmviijpdarawrfvzan.supabase.co'],
  ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'Supabase publishable key (starts sb_publishable_; safe to expose)', 'plain', ''],
  ['SUPABASE_SECRET_KEY', 'Supabase SECRET key (starts sb_secret_)', 'secret', ''],
  ['APP_URL', 'Base URL of the app', 'plain', 'http://localhost:3000'],
  ['NOTIFY_MODE', 'Email mode: log | sandbox | live', 'plain', 'log'],
  ['RESEND_API_KEY', 'Resend API key (starts re_; sending access only)', 'secret', ''],
  ['MAIL_FROM', 'Sender shown on emails, e.g. YouNMeSign <notify@younmesign.com>', 'plain', 'YouNMeSign <notify@younmesign.com>'],
  ['SANDBOX_RECIPIENTS', 'Sandbox mode only: the ONLY addresses that may receive email (comma-separated)', 'plain', ''],
  ['SIGNER_TOKEN_KEY', 'Key that derives signer links', 'generated', ''],
  ['SESSION_COOKIE_KEY', 'Key that signs signer session cookies', 'generated', ''],
  ['STORAGE_KEY', 'Key that encrypts files kept on server disk', 'generated', ''],
  ['SEAL_P12_PASSPHRASE', 'Passphrase of the seal certificate', 'generated', ''],
  ['SEAL_P12_BASE64', 'Seal certificate that signs sealed PDFs (self-signed, made on this PC)', 'seal', ''],
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

// When input is piped (tests, automation) lines are read in order; in a real window keys are read
// one at a time so a secret is never shown on screen, including when it is pasted.
let pipedLines = null;
async function readPipedLine() {
  if (!pipedLines) {
    pipedLines = [];
    for await (const line of createInterface({ input: process.stdin })) pipedLines.push(line);
  }
  return (pipedLines.shift() ?? '').trim();
}

function prompt(question, hidden) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) return readPipedLine().then((v) => (process.stdout.write('\n'), v));
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write(hidden && buf ? `(received ${buf.trim().length} characters, hidden)\n` : '\n');
      resolve(buf.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          process.stdout.write('\nCancelled. Nothing was changed.\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            if (!hidden) process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Catch the common mistake of pasting the wrong key. Returns a problem description or null. */
export function checkSecretKey(value) {
  if (!value) return null;
  if (value.startsWith('sb_publishable_')) return 'That is the PUBLISHABLE key. The SECRET key starts with sb_secret_.';
  if (value.startsWith('sb_secret_') && value.length >= 30) return null;
  if (value.startsWith('eyJ') && value.split('.').length === 3) return null; // legacy service_role key also works
  return 'That does not look like a Supabase secret key (it should start with sb_secret_).';
}

/** Catch pasting the wrong thing into the Resend key. Returns a problem description or null. */
export function checkResendKey(value) {
  if (!value) return null;
  if (value.startsWith('re_') && value.length >= 20 && !/\s/.test(value)) return null;
  return 'That does not look like a Resend API key (it should start with re_).';
}

async function main() {
  const current = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith('--set=')).map((a) => a.slice(6).split(/=(.*)/s).slice(0, 2)));
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const askNothing = args.includes('--defaults');
  const next = { ...current };

  console.log('YouNMeSign environment setup.\n');
  for (const [name, desc, kind, def] of VARS) {
    const has = Boolean(current[name]);
    if (kind === 'generated') {
      if (!has) next[name] = randomBytes(32).toString('base64url');
      if (!only) console.log(`${name}: ${has ? 'kept' : 'generated'}`);
      continue;
    }
    if (kind === 'seal') {
      // made once on this PC; remade only if missing or if its passphrase was just (re)generated
      const passphraseIsNew = next.SEAL_P12_PASSPHRASE !== current.SEAL_P12_PASSPHRASE;
      if (!has || passphraseIsNew) {
        const made = createSealP12({ passphrase: next.SEAL_P12_PASSPHRASE });
        next[name] = made.p12.toString('base64');
        if (!only) console.log(`${name}: generated (key id ${made.certSha256.slice(0, 16)}…, valid until ${made.notAfter.toISOString().slice(0, 10)})`);
      } else if (!only) console.log(`${name}: kept`);
      continue;
    }
    if (flags[name] !== undefined) {
      next[name] = flags[name];
      console.log(`${name}: set from command line`);
      continue;
    }
    if (askNothing || (only && !only.includes(name))) {
      if (!has) next[name] = def;
      if (!only) console.log(`${name}: ${has ? 'kept' : def ? 'default' : 'empty'}`);
      continue;
    }
    const shown = kind === 'secret' ? (has ? '(already set, hidden)' : '(not set)') : current[name] || def || '(empty)';
    for (;;) {
      const a = await prompt(`${name}\n  ${desc}\n  current: ${shown}\n  ${kind === 'secret' ? 'Paste the value and press Enter (nothing will appear as you paste): ' : 'New value (Enter keeps the current one): '}`, kind === 'secret');
      const problem = name === 'SUPABASE_SECRET_KEY' ? checkSecretKey(a) : name === 'RESEND_API_KEY' ? checkResendKey(a) : null;
      if (problem) {
        console.log(`  ${problem} Try again, or press Enter to skip.\n`);
        continue;
      }
      next[name] = a || current[name] || def;
      break;
    }
  }

  const body =
    '# YouNMeSign local environment. NEVER commit this file. Managed by: npm run setup:env\n' +
    VARS.map(([name]) => `${name}=${next[name] ?? ''}`).join('\n') +
    '\n';
  writeFileSync(file, body, { mode: 0o600 });
  if (only) {
    // Say plainly, per item, what is now saved (never the value of a secret).
    console.log('\nWhat is saved now:');
    for (const name of only) {
      const kind = VARS.find(([n]) => n === name)?.[2];
      const v = next[name] ?? '';
      const hidden = kind === 'secret' || kind === 'generated' || kind === 'seal';
      const what = !v ? 'NOT SAVED (empty)' : hidden ? `saved (${v.length} characters, hidden)` : `saved: ${v}`;
      console.log(`  ${name.padEnd(20)} ${what}`);
    }
  }
  const missing = VARS.filter(([n, , k]) => !next[n] && k !== 'generated' && !n.includes('TURNSTILE')).map(([n]) => n);
  console.log(`\nSaved to app\\.env.local.` + (missing.length ? `\nStill empty: ${missing.join(', ')}` : '\nAll required values are present. You can close this window.'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
