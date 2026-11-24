// easysign-worker: a second small Node process beside the web app. It has no listening port.
// Jobs: seal fully signed envelopes (one at a time), dispatch queued email through the budget gate, and deliver webhooks.
//   npm run worker        -> runs until stopped (Ctrl+C)
//   npm run worker:once   -> drains what is waiting, then exits (used by tests and verify scripts)
import { NOTIFY_MODE } from '@/config/brand';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { runOutbox } from './outbox';
import { runOneSealJob } from './seal-job';
import { archiveDue, ARCHIVE_AFTER_DAYS } from './audit-archive';
import { runBulk } from './bulk';
import { pruneIdempotency, pruneWebhooks, runWebhooks } from './webhooks';
import { beat, BEAT_MS, liveWorkerRunning, refusal, release, siteOf } from './lease';

const once = process.argv.includes('--once');
// --archive-now [days] [document id]: archive the audit trails of documents finished at least [days] ago
// (default 30), or of that one document, then exit
const archiveNowAt = process.argv.indexOf('--archive-now');
const IDLE_MS = 5000;
const BUSY_MS = 500;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

const DUE_EVERY_MS = 60_000;
let lastDueCheck = 0;

/** About once a minute: close documents whose date has passed and queue reminders that have come due. */
async function runDue(): Promise<boolean> {
  if (Date.now() - lastDueCheck < DUE_EVERY_MS) return false;
  lastDueCheck = Date.now();
  const { data, error } = await supabaseAdmin().rpc('process_due', {});
  if (error) throw new Error(`process_due: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { expired_count: number; reminder_count: number } | null;
  // daily summaries for the people who asked for one (at most one each per 24 hours)
  const digests = await supabaseAdmin().rpc('queue_digests', {});
  if (digests.error) throw new Error(`queue_digests: ${digests.error.message}`);
  const digestCount = typeof digests.data === 'number' ? digests.data : 0;
  // D-84: documents scheduled to go out by now (a failure leaves the draft and tells the sender, inside the database)
  const scheduled = await supabaseAdmin().rpc('run_scheduled_sends', { p_limit: 10 });
  if (scheduled.error) throw new Error(`run_scheduled_sends: ${scheduled.error.message}`);
  if (typeof scheduled.data === 'number' && scheduled.data > 0) log(`due: ${scheduled.data} scheduled document(s) sent`);
  if ((row && (row.expired_count > 0 || row.reminder_count > 0)) || digestCount > 0) {
    log(`due: ${row?.expired_count ?? 0} document(s) expired, ${row?.reminder_count ?? 0} reminder(s) queued, ${digestCount} daily summar${digestCount === 1 ? 'y' : 'ies'} queued`);
    return true;
  }
  return false;
}

/** One pass: returns true when something was done (so the loop looks again straight away). */
const ARCHIVE_EVERY_MS = 6 * 3600_000;
let lastArchive = 0;

async function tick(withWebhooks: boolean): Promise<boolean> {
  let busy = await runDue();
  if (Date.now() - lastArchive >= ARCHIVE_EVERY_MS) {
    lastArchive = Date.now();
    await archiveDue(log, ARCHIVE_AFTER_DAYS, 5);
    await pruneWebhooks(log);
    await pruneIdempotency(log);
  }
  const seal = await runOneSealJob(log);
  if (seal !== 'none') busy = true;
  if ((await runOutbox(log)) > 0) busy = true;
  // D-85: a few bulk-send rows per pass (paced by the email allowance)
  if ((await runBulk(log)) > 0) busy = true;
  // D-92: signed webhook deliveries (retries are scheduled by the database). In loop mode they have their own loop
  // (D-98), so slow receivers never hold up sealing or email; --once drains them here.
  if (withWebhooks && (await runWebhooks(log)) > 0) busy = true;
  return busy;
}

/** D-98: webhooks on their own loop beside the main one (each delivery stops after 10 seconds at most). */
async function webhookLoop(): Promise<void> {
  let failures = 0;
  while (!stopping) {
    let busy = false;
    try {
      busy = (await runWebhooks(log)) > 0;
      failures = 0;
    } catch (e) {
      failures++;
      log(`webhook pass failed (${failures}): ${e instanceof Error ? e.message : 'unknown error'}`);
    }
    if (!stopping) await new Promise((r) => setTimeout(r, busy ? BUSY_MS : Math.min(IDLE_MS * 2 ** Math.min(failures, 4), 60_000)));
  }
}

// D-99: the server and this PC share one database. The live site's worker records a heartbeat; a worker on a local
// address never runs beside it (it would take the live site's emails and write them to a folder here).
const me = siteOf(process.env.APP_URL);
let lastLease = 0;

/** False when this worker must not run (a local worker while the live one is running). */
async function lease(): Promise<boolean> {
  if (Date.now() - lastLease < BEAT_MS) return true;
  lastLease = Date.now();
  if (!me.local) {
    if (!once) await beat(me.site, NOTIFY_MODE);
    return true;
  }
  const live = await liveWorkerRunning();
  if (!live) return true;
  log(`not running: ${refusal(live)}`);
  return false;
}

async function main() {
  log(`worker started (mode: ${once ? 'once' : 'loop'}, email: ${NOTIFY_MODE})`);
  if (!(await lease())) {
    process.exitCode = 3;
    return;
  }
  let failures = 0;
  const webhooks = once ? Promise.resolve() : webhookLoop();
  while (!stopping) {
    let busy = false;
    try {
      if (!(await lease())) {
        process.exitCode = 3;
        break;
      }
      busy = await tick(once);
      failures = 0;
    } catch (e) {
      failures++;
      log(`tick failed (${failures}): ${e instanceof Error ? e.message : 'unknown error'}`);
      if (once) {
        process.exitCode = 1;
        break;
      }
    }
    if (once && !busy) break;
    if (!stopping) await new Promise((r) => setTimeout(r, busy ? BUSY_MS : Math.min(IDLE_MS * 2 ** Math.min(failures, 4), 60_000)));
  }
  stopping = true;
  await webhooks;
  if (!me.local && !once) await release(me.site).catch(() => undefined);   // stopped properly: no heartbeat left behind
  log('worker stopped');
}

if (archiveNowAt >= 0) {
  const days = Number.parseInt(process.argv[archiveNowAt + 1] ?? "", 10);
  const one = /^[0-9a-f-]{36}$/.test(process.argv[archiveNowAt + 2] ?? "") ? process.argv[archiveNowAt + 2] : null;
  void archiveDue(log, Number.isFinite(days) ? days : ARCHIVE_AFTER_DAYS, 20, one).then(
    (n) => log(`audit archive: ${n} document(s) archived`),
    (e) => {
      log(`audit archive failed: ${e instanceof Error ? e.message : "unknown error"}`);
      process.exitCode = 1;
    },
  );
} else {
  void main();
}
