// npm run backup  (or double-click Run-Backup.cmd)
// Encrypted backup of the YouNMeSign database and stored files to EasySign\backups\<date-time>\ (Phase 3 slice 8, D-73).
//   * Database: every table of the app's schemas (public, app_private) and the Auth and Storage rows the app needs,
//     read in one consistent snapshot over the Session pooler (SUPABASE_DB_URL), one file per table (JSON lines).
//   * Stored files: every object in every bucket (originals, sealed copies, certificates, signatures, audit archives).
//   * Which migrations the database had (so a restore knows the exact schema version).
//   * Everything encrypted with AES-256-GCM under a key from your passphrase; only backup.json (no data) is plain.
// The passphrase is asked for every time and never saved. Non-interactive drills may pass it in BACKUP_PASSPHRASE.
// Options: --out <folder> (default ..\backups); --yes-stored (skip the "have you stored it" question; drills only).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { dbClient } from './lib/db.mjs';
import { deriveKey, diskName, encryptFile, keyCheck, KDF, MIN_PASSPHRASE, newSalt } from './lib/backup-crypto.mjs';
import { prompt } from './setup-env.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const outRoot = path.resolve(arg('--out') ?? path.join(appDir, '..', 'backups'));
const say = (m) => console.log(m);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// Auth and Storage rows the app relies on (the rest of those schemas belongs to Supabase itself).
const EXTRA_TABLES = ['auth.users', 'auth.identities', 'auth.mfa_factors', 'storage.buckets', 'storage.objects', 'supabase_migrations.schema_migrations'];

async function askPassphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  say('');
  say(' Your backup passphrase protects everything in this backup. Only you hold it.');
  say(` Use at least ${MIN_PASSPHRASE} characters; a few unrelated words are easy to type and hard to guess.`);
  say(' IF YOU LOSE IT, THIS BACKUP CANNOT BE OPENED BY ANYONE, INCLUDING YOU.');
  say('');
  for (;;) {
    const a = await prompt('Passphrase (nothing appears as you type): ', true);
    if (a.length < MIN_PASSPHRASE) {
      say(`  Too short: at least ${MIN_PASSPHRASE} characters, please.\n`);
      continue;
    }
    const b = await prompt('Type it again: ', true);
    if (a !== b) {
      say('  The two did not match. Try again.\n');
      continue;
    }
    return a;
  }
}

async function confirmStored() {
  if (process.argv.includes('--yes-stored')) return;
  for (;;) {
    const a = await prompt('Have you stored this passphrase somewhere safe, away from this PC (a password manager or on paper)? Type YES: ', false);
    if (a === 'YES') return;
    say('  Store it first, then type YES. (Press Ctrl+C to stop without making a backup.)\n');
  }
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    say('The database connection string is not set. Double-click Enter-Database-Password.cmd first.');
    process.exit(1);
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    say('Settings are missing. Run "npm run setup:env" first.');
    process.exit(1);
  }
  const passphrase = await askPassphrase();
  await confirmStored();
  const started = Date.now();
  const salt = newSalt();
  const key = await deriveKey(passphrase, salt);
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, 'Z');
  const dir = path.join(outRoot, stamp);
  mkdirSync(dir, { recursive: true });

  const files = [];
  const write = (name, plain, extra = {}) => {
    const disk = diskName(files.length + 1);
    writeFileSync(path.join(dir, disk), encryptFile(key, name, plain));
    files.push({ name, disk, bytes: plain.length, sha256: sha256(plain), ...extra });
  };

  const client = dbClient(appDir, 'younmesign-backup', say);
  await client.connect();
  let objects = [];
  try {
    // one consistent snapshot of every table
    await client.query('begin isolation level repeatable read read only');
    const { rows: tables } = await client.query(
      `select table_schema || '.' || table_name as t from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema in ('public', 'app_private') order by 1`,
    );
    const all = [...tables.map((r) => r.t), ...EXTRA_TABLES];
    for (const t of all) {
      const [schema, table] = t.split('.');
      const ident = `"${schema}"."${table}"`;
      const lines = [];
      for (let offset = 0; ; offset += 5000) {
        // "src_row.*" is always the whole row, even when the table has a column with the alias's name (fields has "x").
        const { rows } = await client.query(`select to_jsonb(src_row.*) as r from ${ident} src_row order by ctid limit 5000 offset ${offset}`);
        for (const r of rows) {
          if (!r.r || typeof r.r !== 'object' || Array.isArray(r.r)) throw new Error(`${t}: a row did not read back as a record`);
          lines.push(JSON.stringify(r.r));
        }
        if (rows.length < 5000) break;
      }
      write(`db/${t}.ndjson`, Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf8'), { table: t, rows: lines.length });
      say(`  ${t}: ${lines.length} rows`);
    }
    ({ rows: objects } = await client.query(`select bucket_id, name from storage.objects order by bucket_id, name`));
    await client.query('commit');
  } finally {
    await client.end();
  }

  // stored files, through the Storage API (the same way the app reads them)
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  let fileBytes = 0;
  for (const o of objects) {
    const { data, error } = await supabase.storage.from(o.bucket_id).download(o.name);
    if (error || !data) throw new Error(`could not download ${o.bucket_id}/${o.name}: ${error?.message ?? 'no data'}`);
    const buf = Buffer.from(await data.arrayBuffer());
    fileBytes += buf.length;
    write(`storage/${o.bucket_id}/${o.name}`, buf, { bucket: o.bucket_id, object: o.name });
  }
  say(`  stored files: ${objects.length} (${Math.round(fileBytes / 1024)} KB)`);

  const manifest = { format: 'younmesign-backup-manifest', v: 1, created_at: new Date().toISOString(), project_url: process.env.NEXT_PUBLIC_SUPABASE_URL, files };
  writeFileSync(path.join(dir, 'manifest.bin'), encryptFile(key, 'manifest', Buffer.from(JSON.stringify(manifest), 'utf8')));
  writeFileSync(
    path.join(dir, 'backup.json'),
    JSON.stringify({ format: 'younmesign-backup', v: 1, created_at: manifest.created_at, kdf: { ...KDF, salt }, key_check: keyCheck(key), files: files.length }, null, 2) + '\n',
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  say('');
  say(`Backup complete in ${seconds} s: ${files.length} files in ${dir}`);
  say('Next: copy the whole backups folder to a second place (a USB drive or your Google Drive). One copy is not a backup.');
  say('To prove it can be restored: npm run restore:drill  (or double-click Run-Restore-Drill.cmd).');
}

main().catch((e) => {
  console.error(`Backup FAILED: ${e instanceof Error ? e.message : String(e)}`);
  console.error('Nothing was deleted. Fix the problem and run it again.');
  process.exit(1);
});
