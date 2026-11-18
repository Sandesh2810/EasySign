// Development helper: save a completed document's sealed PDF and certificate into exports\ so they can
// be looked at, and check the sealed file against its recorded SHA-256. Prints no secrets.
// Usage: node --env-file=.env.local scripts/dev-fetch-sealed.mjs <envelope-id> <output-folder> <name>
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [id, outDir, name = 'sealed'] = process.argv.slice(2);
if (!/^[0-9a-f-]{36}$/.test(id ?? '') || !outDir) {
  console.error('Usage: node --env-file=.env.local scripts/dev-fetch-sealed.mjs <envelope-id> <output-folder> [name]');
  process.exit(2);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: e, error } = await db.from('envelopes').select('status, sealed_storage_path, certificate_storage_path, final_sha256').eq('id', id).single();
if (error || e.status !== 'completed') {
  console.error('That document is not completed.');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const [suffix, p] of [['sealed', e.sealed_storage_path], ['certificate', e.certificate_storage_path]]) {
  const file = await db.storage.from('sealed').download(p);
  if (file.error) throw new Error(file.error.message);
  const bytes = Buffer.from(await file.data.arrayBuffer());
  writeFileSync(path.join(outDir, `${name}-${suffix}.pdf`), bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`${name}-${suffix}.pdf ${bytes.length} bytes${suffix === 'sealed' ? (sha === e.final_sha256 ? ' = recorded SHA-256' : ' MISMATCH with recorded SHA-256') : ''}`);
}
