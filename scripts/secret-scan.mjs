// Blocks commits that contain secret-shaped strings or secret files.
// Used by .githooks/pre-commit (staged files) and by verify scripts (--all = every tracked file).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

const mode = process.argv.includes('--all') ? 'all' : 'staged';
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = mode === 'all' ? git(['ls-files']) : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);

const forbiddenNames = [/(^|\/)\.env(\..*)?$/, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /(^|\/)id_(rsa|ed25519)$/];
const allowedNames = [/(^|\/)\.env\.example$/];
const patterns = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{20,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{20,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
  ['Postgres URL with password', /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]{6,}@/],
  ['Hard-coded secret assignment', /\b(SECRET|PASSWORD|PASSPHRASE|API_KEY|TOKEN_KEY)[A-Z_]*\s*[:=]\s*["'][^"'\s]{16,}["']/],
];

const findings = [];
for (const f of files) {
  if (allowedNames.some((r) => r.test(f))) continue;
  if (forbiddenNames.some((r) => r.test(f))) {
    findings.push(`${f}: file type must never be committed`);
    continue;
  }
  if (!existsSync(f) || statSync(f).size > 2_000_000) continue;
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|otf)$/i.test(f) || f === 'package-lock.json') continue;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const [name, re] of patterns) {
      if (re.test(line)) findings.push(`${f}:${i + 1}: looks like a ${name}`);
    }
  });
}

if (findings.length) {
  console.error('SECRET SCAN FAILED - commit blocked:\n' + findings.map((x) => '  ' + x).join('\n'));
  console.error('Remove the value (keep it only in .env.local) and try again.');
  process.exit(1);
}
console.log(`Secret scan OK (${files.length} ${mode} file(s)).`);
