// npm run restore:drill [backup folder]  (or double-click Run-Restore-Drill.cmd)
// Proves a backup can be restored (Phase 3 slice 8, AT3.7, D-73). Timed. Steps:
//   1. Open the backup with the passphrase (a wrong passphrase is reported before anything else happens).
//   2. Decrypt every file and check its SHA-256 and, for tables, its row count against the manifest.
//   3. Restore every app table into a scratch schema "restore_drill_<time>" in the database (same columns as the live
//      tables), and count the rows back.
//   4. Re-verify every audit chain from the restored rows plus the restored archive files.
//   5. Check every restored sealed PDF against the SHA-256 recorded for its document.
//   6. Drop the scratch schema (keep it with --keep) and write a report next to the backup.
// It never changes the live tables or stored files.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dbClient } from './lib/db.mjs';
import { decryptFile, deriveKey, keyMatches } from './lib/backup-crypto.mjs';
import { prompt } from './setup-env.mjs';
import { verifyChain } from '../src/lib/audit-chain.ts';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appDir);
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const report = [];
const say = (m) => {
  console.log(m);
  report.push(m);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hex = (v) => (typeof v === 'string' ? v.replace(/^\\x/, '').toLowerCase() : '');

function pickBackup() {
  const given = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (given) return path.resolve(given);
  const root = path.join(appDir, '..', 'backups');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => existsSync(path.join(root, d, 'backup.json'))).sort() : [];
  if (!dirs.length) throw new Error('No backup found in the backups folder. Make one first (npm run backup).');
  return path.join(root, dirs[dirs.length - 1]);
}

async function main() {
  const dir = pickBackup();
  const info = JSON.parse(readFileSync(path.join(dir, 'backup.json'), 'utf8'));
  if (info.format !== 'younmesign-backup' || info.v !== 1) throw new Error('That folder is not a YouNMeSign backup.');
  say(`Restore drill of ${dir} (made ${info.created_at})`);
  const passphrase = process.env.BACKUP_PASSPHRASE ?? (await prompt('Backup passphrase (nothing appears as you type): ', true));
  const t0 = Date.now();
  const key = await deriveKey(passphrase, info.kdf.salt, info.kdf);
  if (!keyMatches(key, info.key_check)) throw new Error('Wrong passphrase. Nothing was changed.');

  // 1-2: every file decrypts and matches the manifest
  const manifest = JSON.parse(decryptFile(key, 'manifest', readFileSync(path.join(dir, 'manifest.bin'))).toString('utf8'));
  const plain = new Map();
  let bytes = 0;
  for (const f of manifest.files) {
    const p = decryptFile(key, f.name, readFileSync(path.join(dir, f.disk)));
    if (sha256(p) !== f.sha256) throw new Error(`${f.name}: content does not match the manifest`);
    plain.set(f.name, p);
    bytes += statSync(path.join(dir, f.disk)).size;
  }
  const tables = manifest.files.filter((f) => f.table);
  const stored = manifest.files.filter((f) => f.bucket);
  const rowsOf = (t) => {
    const text = plain.get(`db/${t}.ndjson`)?.toString('utf8') ?? '';
    return text ? text.trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
  };
  for (const t of tables) {
    const rows = rowsOf(t.table);
    if (rows.length !== t.rows) throw new Error(`${t.table}: ${rows.length} rows, the manifest says ${t.rows}`);
    if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error(`${t.table}: the backup holds something that is not a table row`);
  }
  say(`1. Opened with the passphrase; ${manifest.files.length} files (${Math.round(bytes / 1024)} KB) decrypted, every SHA-256 and row count matches the manifest.`);

  // 3: restore the app tables into a scratch schema
  const scratch = `restore_drill_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const client = dbClient(appDir, 'younmesign-restore-drill', say);
  await client.connect();
  let restoredRows = 0;
  try {
    await client.query(`create schema ${scratch}`);
    await client.query(`revoke all on schema ${scratch} from public`);
    for (const t of tables.filter((x) => x.table.startsWith('public.') || x.table.startsWith('app_private.'))) {
      const [schema, table] = t.table.split('.');
      const target = `${scratch}."${schema}__${table}"`;
      await client.query(`create table ${target} (like "${schema}"."${table}")`);
      const rows = rowsOf(t.table);
      for (let i = 0; i < rows.length; i += 500) {
        await client
          .query(`insert into ${target} select * from jsonb_populate_recordset(null::${target}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 500))])
          .catch((e) => {
            throw new Error(`${t.table}: ${e.message}`);
          });
      }
      const { rows: c } = await client.query(`select count(*)::int n from ${target}`);
      if (c[0].n !== t.rows) throw new Error(`${t.table}: restored ${c[0].n} rows, expected ${t.rows}`);
      restoredRows += c[0].n;
    }
    say(`2. Restored ${restoredRows} rows of ${tables.filter((x) => !x.table.includes('.') || x.table.startsWith('public.') || x.table.startsWith('app_private.')).length} app tables into the scratch schema ${scratch}; every count matches.`);

    // 4: every audit chain, from the restored rows plus the restored archive files
    const { rows: events } = await client.query(
      `select chain_key, chain_seq, id, org_id, envelope_id, recipient_id, actor_type, actor_id, event_type, payload, host(ip) ip, user_agent,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at, canonical,
              encode(prev_hash, 'hex') prev_hash, encode(event_hash, 'hex') event_hash
         from ${scratch}."public__audit_events" order by chain_key, chain_seq`,
    );
    const { rows: parts } = await client.query(`select chain_key, first_seq, last_seq, storage_path, file_sha256 from ${scratch}."public__audit_archives" order by chain_key, first_seq`);
    const chains = new Map();
    for (const p of parts) {
      const file = plain.get(`storage/audit-archives/${p.storage_path}`);
      if (!file || sha256(file) !== p.file_sha256) throw new Error(`archive ${p.storage_path} is missing or changed`);
      const lines = gunzipSync(file).toString('utf8').split('\n').filter(Boolean);
      const list = chains.get(p.chain_key) ?? [];
      list.push(...lines.slice(1).map((l) => JSON.parse(l)));
      chains.set(p.chain_key, list);
    }
    for (const e of events) {
      const list = chains.get(e.chain_key) ?? [];
      list.push({ ...e, prev_hash: hex(e.prev_hash), event_hash: hex(e.event_hash) });
      chains.set(e.chain_key, list);
    }
    let eventCount = 0;
    const broken = [];
    for (const [k, list] of chains) {
      const v = verifyChain(list);
      eventCount += list.length;
      if (!v.ok) broken.push(`${k}: ${v.reason} at ${v.brokenAt}`);
    }
    if (broken.length) throw new Error(`audit chains broken after restore: ${broken.slice(0, 5).join('; ')}`);
    say(`3. Re-verified ${chains.size} audit chains (${eventCount} events, ${parts.length} archived part${parts.length === 1 ? '' : 's'} included) from the restored data: all intact.`);

    // 5: every sealed PDF matches its document's recorded SHA-256
    const { rows: sealed } = await client.query(
      `select id, final_sha256, sealed_storage_path from ${scratch}."public__envelopes" where status = 'completed' and deleted_at is null and sealed_storage_path is not null`,
    );
    let pdfs = 0;
    for (const s of sealed) {
      const file = plain.get(`storage/sealed/${s.sealed_storage_path}`);
      if (!file) throw new Error(`sealed PDF of ${s.id} is missing from the backup`);
      if (sha256(file) !== s.final_sha256) throw new Error(`sealed PDF of ${s.id} does not match its recorded SHA-256`);
      if (file.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`sealed file of ${s.id} is not a PDF`);
      pdfs += 1;
    }
    say(`4. All ${pdfs} sealed PDFs in the backup match the SHA-256 recorded for their document; ${stored.length} stored files in total were restored from the backup.`);
  } finally {
    if (!process.argv.includes('--keep')) await client.query(`drop schema if exists ${scratch} cascade`).catch(() => {});
    await client.end();
  }
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  say(`5. ${process.argv.includes('--keep') ? `Scratch schema ${scratch} kept (--keep).` : 'Scratch schema removed.'} The live data was not touched.`);
  say(`RESTORE DRILL PASSED in ${seconds} s.`);
  writeFileSync(path.join(dir, `restore-drill-${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, 'Z')}.txt`), report.join('\n') + '\n');
}

main().catch((e) => {
  const msg = `RESTORE DRILL FAILED: ${e instanceof Error ? e.message : String(e)}`;
  console.error(msg);
  process.exit(1);
});
