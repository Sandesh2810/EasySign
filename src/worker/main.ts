// easysign-worker: a second small Node process beside the web app. It has no listening port.
// Jobs: seal fully signed envelopes (one at a time) and dispatch queued email through the budget gate.
//   npm run worker        -> runs until stopped (Ctrl+C)
//   npm run worker:once   -> drains what is waiting, then exits (used by tests and verify scripts)
import { NOTIFY_MODE } from '@/config/brand';
import { runOutbox } from './outbox';
import { runOneSealJob } from './seal-job';

const once = process.argv.includes('--once');
const IDLE_MS = 5000;
const BUSY_MS = 500;
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

/** One pass: returns true when something was done (so the loop looks again straight away). */
async function tick(): Promise<boolean> {
  let busy = false;
  const seal = await runOneSealJob(log);
  if (seal !== 'none') busy = true;
  if ((await runOutbox(log)) > 0) busy = true;
  return busy;
}

async function main() {
  log(`worker started (mode: ${once ? 'once' : 'loop'}, email: ${NOTIFY_MODE})`);
  let failures = 0;
  while (!stopping) {
    let busy = false;
    try {
      busy = await tick();
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
  log('worker stopped');
}

void main();
