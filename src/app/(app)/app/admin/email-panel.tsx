// Administrator's view of the email budget: today's counters and what is waiting in the queue.
// The database function refuses anyone who is not a platform administrator.
import { DEFAULT_BUDGET, meter } from '@/lib/email-budget';
import { loadBudget } from '@/lib/email-budget-state';
import { supabaseAdmin } from '@/lib/supabase/admin';

interface Overview {
  queued: number;
  deferred: number;
  sending: number;
  dead: number;
  sent_today: number;
  oldest_waiting: string | null;
}

export async function EmailPanel({ adminId }: { adminId: string }) {
  const [overview, budget] = await Promise.all([supabaseAdmin().rpc('admin_email_overview', { p_actor: adminId }), loadBudget(null).catch(() => null)]);
  const o = ((Array.isArray(overview.data) ? overview.data[0] : overview.data) ?? null) as Overview | null;
  if (overview.error || !o || !budget) return null;
  const m = meter(budget.state, DEFAULT_BUDGET);
  const s = budget.state;
  const rows: [string, string][] = [
    ['Sent today (all kinds)', `${m.usedToday} of ${m.dailyAllowance}`],
    ['Left for documents (requests, copies, notices)', `${m.sharedLeft} of ${m.sharedPool}`],
    ['Left of the share kept for sign-up and security emails', `${m.authLeft} of ${m.authReserve}`],
    ['Sent today by new, not yet trusted accounts', `${s.restrictedSentToday} of ${DEFAULT_BUDGET.restrictedPoolDaily}`],
    ['Sent earlier this month', `${s.sentMonthBeforeToday} of ${DEFAULT_BUDGET.monthlyCap}`],
    ['Waiting to be sent now', String(o.queued + o.sending)],
    ['Held until the next daily allowance', String(o.deferred)],
    ['Given up after repeated failures', String(o.dead)],
  ];
  return (
    <section className="rounded-lg bg-surface px-6 py-5 shadow-soft" aria-labelledby="admin-email-heading">
      <h2 id="admin-email-heading" className="text-base font-medium text-ink">
        Email today
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-body">
        The free email service allows a fixed number of emails a day for the whole platform. Requests to sign go first; copies, notices, reminders and summaries wait when
        the day runs short. Nothing is dropped: held emails go out after the reset at 00:00 UTC.
        {s.providerClosed ? ' The email service itself reported that today’s quota is used up, so nothing more goes out today.' : ''}
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 border-b border-hairline py-1.5">
            <dt className="text-ink-body">{label}</dt>
            <dd className="font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {o.oldest_waiting ? <p className="mt-3 text-sm text-ink-muted">Oldest email still waiting was queued on {o.oldest_waiting.slice(0, 10)}.</p> : null}
    </section>
  );
}
