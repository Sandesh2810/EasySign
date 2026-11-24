// D-99: one database, two places a worker can run (the server and Sandesh's PC). A worker on the PC would take the
// live site's queued emails and write them to a folder instead of sending them. So:
//   - the server's worker records a heartbeat about every 30 seconds (table system_health, key "worker:<site>"),
//     and removes it when it is stopped properly;
//   - a worker started on a local address refuses to run while a live heartbeat is fresh, and stops itself when one
//     appears. To use the PC's worker (tests), pause the server's first: "npm run server:worker -- pause".
// The decisions are pure functions (tested in lease.test.ts); the database calls are thin.
import { supabaseAdmin } from '@/lib/supabase/admin';

export const BEAT_MS = 30_000;
/** A heartbeat older than this is from a worker that is gone (crashed, or the server is off). */
export const FRESH_MS = 180_000;
const PREFIX = 'worker:';

/** Which site this worker belongs to, from APP_URL, and whether that is a development address. */
export function siteOf(appUrl: string | undefined): { site: string; local: boolean } {
  let host = 'localhost';
  try {
    host = new URL(appUrl && appUrl.trim() ? appUrl : 'http://localhost:3000').hostname.toLowerCase();
  } catch {
    // an unreadable APP_URL is treated as this PC: the careful side
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.test');
  return { site: host, local };
}

export interface Beat {
  key: string;
  updated_at: string;
}

/** The live site whose worker is running now (a fresh heartbeat from a non-local site), or null. */
export function liveSite(beats: readonly Beat[], now: number, fresh = FRESH_MS): string | null {
  for (const b of beats) {
    if (!b.key.startsWith(PREFIX)) continue;
    const site = b.key.slice(PREFIX.length);
    if (siteOf(`https://${site}`).local) continue;
    const at = Date.parse(b.updated_at);
    if (Number.isFinite(at) && now - at < fresh) return site;
  }
  return null;
}

export const refusal = (site: string) =>
  `the worker of the live site (${site}) is running. A worker on this PC would take its emails and documents, so this one will not run. To use it here (tests), pause the live one first: npm run server:worker -- pause (and "resume" afterwards).`;

export async function liveWorkerRunning(): Promise<string | null> {
  const { data, error } = await supabaseAdmin().from('system_health').select('key, updated_at').like('key', `${PREFIX}%`);
  if (error) throw new Error(`worker heartbeat read: ${error.message}`);
  return liveSite((data ?? []) as Beat[], Date.now());
}

export async function beat(site: string, mode: string): Promise<void> {
  const { error } = await supabaseAdmin().from('system_health').upsert({ key: `${PREFIX}${site}`, value: { email: mode }, updated_at: new Date().toISOString() });
  if (error) throw new Error(`worker heartbeat: ${error.message}`);
}

export async function release(site: string): Promise<void> {
  await supabaseAdmin().from('system_health').delete().eq('key', `${PREFIX}${site}`);
}
