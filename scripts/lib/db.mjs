// Database connection for the backup scripts (Phase 3 slice 8, D-73).
// The Session pooler presents a certificate signed by Supabase's own root, which is not in the normal trust store.
// When that root certificate is saved as app\certs\supabase-ca.crt (downloaded from the Supabase dashboard:
// Project Settings > Database > SSL configuration), the certificate is checked. Without it the connection is still
// encrypted but the server is not authenticated, and the scripts say so.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export function dbClient(appDir, applicationName, say = console.log) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error('The database connection string is not set. Double-click Enter-Database-Password.cmd first.');
  const caPath = path.join(appDir, 'certs', 'supabase-ca.crt');
  if (existsSync(caPath)) {
    return new pg.Client({ connectionString: url, ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }, application_name: applicationName });
  }
  say('  Note: the database certificate is not being checked (app\\certs\\supabase-ca.crt is missing). The connection is encrypted; see RUNBOOK "Backups".');
  return new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, application_name: applicationName });
}
