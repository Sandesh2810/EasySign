// "Emails left today" meter (brief: visible to senders and administrators; AT1.11).
// A server component: it reads the shared counters with the service role, for the signed-in user only.
import { allowanceFor, DEFAULT_BUDGET, meter, type AllowanceLimit } from '@/lib/email-budget';
import { loadBudget } from '@/lib/email-budget-state';
import { supabaseAdmin } from '@/lib/supabase/admin';

const LIMIT_REASON: Record<AllowanceLimit, string> = {
  day: 'EasySign runs on a free email service with a fixed number of emails a day, shared by everyone who uses it.',
  month: 'The monthly email allowance is nearly used up, so each remaining day gets a smaller share.',
  'new-accounts': 'New accounts share a smaller daily allowance until an administrator marks them as trusted.',
  you: 'Each account has its own daily email limit, so one person cannot use up everyone’s share.',
};

/** 00:00 UTC, said in words a person can act on, e.g. "in about 6 hours (00:00 UTC)". */
function resetText(resetsAt: Date, now: Date): string {
  const minutes = Math.max(1, Math.round((resetsAt.getTime() - now.getTime()) / 60_000));
  const span = minutes >= 90 ? `about ${Math.round(minutes / 60)} hours` : minutes >= 60 ? 'about an hour' : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `in ${span} (00:00 UTC)`;
}

export async function EmailMeter({ userId }: { userId: string }) {
  let snapshot;
  let waiting = 0;
  try {
    const db = supabaseAdmin();
    const [b, w] = await Promise.all([
      loadBudget(userId),
      db.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('sender_user_id', userId).eq('status', 'deferred'),
    ]);
    snapshot = b;
    waiting = w.count ?? 0;
  } catch {
    // The meter is information, not a gate: if it cannot be read, the page still works.
    return null;
  }
  const now = new Date();
  const opts = { restrictedSender: snapshot.restricted, userSentToday: snapshot.userSentToday };
  const requests = allowanceFor('P0_REQUEST', snapshot.state, DEFAULT_BUDGET, opts);
  const m = meter(snapshot.state, DEFAULT_BUDGET, now);
  // what this sender could ever send in a day, under the limit that binds them
  const ceiling =
    requests.limitedBy === 'you' ? DEFAULT_BUDGET.perUserDaily : requests.limitedBy === 'new-accounts' ? DEFAULT_BUDGET.restrictedPoolDaily : Math.max(m.sharedPool, 1);
  const left = Math.min(requests.left, ceiling);
  const state = left === 0 ? 'none' : left <= Math.ceil(ceiling * (1 - DEFAULT_BUDGET.lowAt)) ? 'low' : 'ok';

  return (
    <section aria-labelledby="email-meter-heading" className="rounded-lg bg-surface px-6 py-5 shadow-soft">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="email-meter-heading" className="text-base font-medium text-ink">
          Emails left today
        </h2>
        <p className="text-sm text-ink-muted">Resets {resetText(m.resetsAt, now)}</p>
      </div>
      <p className="mt-2 text-3xl font-light text-ink">
        {left} <span className="text-base text-ink-muted">of {ceiling}</span>
      </p>
      <div
        role="meter"
        aria-labelledby="email-meter-heading"
        aria-valuemin={0}
        aria-valuemax={ceiling}
        aria-valuenow={left}
        aria-valuetext={`${left} of ${ceiling} emails left today`}
        className="mt-3 h-2 w-full overflow-hidden rounded-pill bg-surface-sand"
      >
        <div className={state === 'ok' ? 'h-full bg-ink' : 'h-full bg-warning'} style={{ width: `${Math.round((left / ceiling) * 100)}%` }} />
      </div>
      <p className="mt-3 text-sm text-ink-body">
        {state === 'none'
          ? 'No more emails can go out today. Anything you send now waits in line and goes out after the reset. Nothing is lost.'
          : state === 'low'
            ? 'Running low. Requests to sign go first; reminders and copies may wait until tomorrow.'
            : 'Each person you send a document to uses one email, and each completed copy uses one more.'}{' '}
        You can always copy a signing link and share it yourself, which uses no email.
      </p>
      {waiting > 0 ? (
        <p className="mt-2 text-sm text-ink-body">
          <strong className="font-medium text-ink">
            {waiting === 1 ? 'One of your emails is' : `${waiting} of your emails are`} waiting
          </strong>{' '}
          for the next allowance and will go out by {waiting === 1 ? 'itself' : 'themselves'}.
        </p>
      ) : null}
      <details className="mt-2 text-sm text-ink-muted">
        <summary className="cursor-pointer">Why is there a limit?</summary>
        <p className="mt-1">{LIMIT_REASON[requests.limitedBy]}</p>
      </details>
    </section>
  );
}
