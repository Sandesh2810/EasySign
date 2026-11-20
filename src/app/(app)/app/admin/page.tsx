import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdminMfa } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { LimitsForm, ReportForm, ResetMfaForm, SuspendForm } from './account-controls';
import { ApprovalForm } from './approval-form';
import { EmailPanel } from './email-panel';

export const metadata: Metadata = { title: 'Accounts' };

interface AccountRow {
  account_id: string;
  account_email: string;
  display_name: string;
  is_approved: boolean;
  trust: string;
  is_admin: boolean;
  email_confirmed: boolean;
  request_status: string | null;
  registered_at: string;
  documents_per_day: number;
  people_per_day: number;
  is_trusted: boolean;
  suspended_since: string | null;
  suspension_reason: string | null;
  open_documents: number;
  open_reports: number;
}

interface ReportRow {
  report_id: string;
  reported_at: string;
  report_status: 'open' | 'actioned' | 'dismissed';
  reason: string;
  reporter_name: string;
  reporter_email: string;
  envelope_title: string;
  envelope_status: string;
  sender_id: string;
  sender_email: string;
  sender_name: string;
  sender_trust: string;
  sender_open_reports: number;
  decided_at: string | null;
  note: string | null;
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading accounts…</p>}>
      <Accounts />
    </Suspense>
  );
}

const day = (iso: string) => iso.slice(0, 10);

async function Accounts() {
  const user = await requireAdminMfa('/app/admin');
  // The database functions refuse anyone who is not a platform administrator; they see "not found".
  const db = supabaseAdmin();
  const [accounts, reportList] = await Promise.all([db.rpc('admin_list_accounts', { p_actor: user.id }), db.rpc('admin_list_abuse_reports', { p_actor: user.id })]);
  if (accounts.error || reportList.error) notFound();
  const rows = (accounts.data ?? []) as AccountRow[];
  const reports = (reportList.data ?? []) as ReportRow[];
  const openReports = reports.filter((r) => r.report_status === 'open');
  const closedReports = reports.filter((r) => r.report_status !== 'open').slice(0, 10);
  const waiting = rows.filter((r) => !r.is_approved).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app">Dashboard</Link> / Accounts
        </p>
        <h1 className="mt-2 font-serif text-4xl font-light italic text-ink">Accounts</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-body">
          Registration is by approval. A new account can prepare documents and sign its own, but cannot send to other people until you approve it here.
          {waiting > 0 ? ` ${waiting} waiting.` : ' Nobody is waiting.'} {openReports.length > 0 ? `${openReports.length} report${openReports.length === 1 ? '' : 's'} to look at.` : ''}
        </p>
      </div>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="reports-heading">
        <h2 id="reports-heading" className="text-base font-medium text-ink">
          Reported documents
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-body">
          Anyone who receives a signing link can report the document. You cannot open other people’s documents, so judge by the report and by what you know about the sender. If it looks like
          fraud, suspend the sender below: that puts all their open documents on hold at once.
        </p>
        {openReports.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted">No open reports.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-hairline">
            {openReports.map((r) => (
              <li key={r.report_id} className="flex flex-col gap-3 py-4">
                <div className="text-sm">
                  <p className="text-ink">
                    <span className="font-medium">“{r.envelope_title}”</span> sent by {r.sender_name || '(no name)'} ({r.sender_email})
                    {r.sender_trust === 'suspended' ? ' · sender is suspended' : ''}
                    {r.sender_open_reports > 1 ? ` · ${r.sender_open_reports} open reports about this sender` : ''}
                  </p>
                  <p className="mt-1 text-ink-muted">
                    Reported on {day(r.reported_at)} by {r.reporter_name || 'a recipient'} ({r.reporter_email})
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-sand px-3 py-2 text-ink-body">{r.reason}</p>
                </div>
                <ReportForm reportId={r.report_id} />
              </li>
            ))}
          </ul>
        )}
        {closedReports.length > 0 ? (
          <details className="mt-4 text-sm text-ink-body">
            <summary className="cursor-pointer text-ink-muted">Recently closed reports ({closedReports.length})</summary>
            <ul className="mt-2 flex flex-col gap-2">
              {closedReports.map((r) => (
                <li key={r.report_id}>
                  “{r.envelope_title}” ({r.sender_email}): {r.report_status === 'actioned' ? 'handled' : 'nothing wrong'}
                  {r.decided_at ? ` on ${day(r.decided_at)}` : ''}
                  {r.note ? `. Note: ${r.note}` : ''}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className="text-base font-medium text-ink">
          People
        </h2>
        <ul className="mt-2 flex flex-col divide-y divide-hairline">
          {rows.map((r) => {
            const who = r.display_name || r.account_email;
            const suspended = r.trust === 'suspended';
            const state = r.is_admin ? 'Administrator' : suspended ? 'Suspended' : r.is_approved ? 'Approved' : r.email_confirmed ? 'Waiting for approval' : 'Email not confirmed';
            return (
              <li key={r.account_id} className="flex flex-col gap-3 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
                  <p>
                    <span className="block text-base text-ink">{r.display_name || '(no name)'}</span>
                    <span className="block text-ink-muted">{r.account_email}</span>
                  </p>
                  <p className="text-ink">
                    <span className="font-medium">{state}</span>
                    {r.is_trusted && !r.is_admin ? ' · trusted' : ''}
                    <span className="block text-ink-muted">
                      Registered {day(r.registered_at)} · {r.open_documents} open document{r.open_documents === 1 ? '' : 's'}
                      {r.open_reports > 0 ? ` · ${r.open_reports} open report${r.open_reports === 1 ? '' : 's'}` : ''}
                    </span>
                  </p>
                </div>
                {suspended ? (
                  <p className="text-sm text-ink-body">
                    Suspended since {r.suspended_since ? day(r.suspended_since) : 'an unknown date'}
                    {r.suspension_reason ? `. Reason: ${r.suspension_reason}` : '. No reason was recorded.'} Their open documents are on hold.
                  </p>
                ) : null}
                <ApprovalForm
                  userId={r.account_id}
                  approved={r.is_approved}
                  who={who}
                  disabled={r.is_admin ? 'Always approved' : !r.email_confirmed && !r.is_approved ? 'Waiting for them to confirm their email' : undefined}
                />
                {r.is_admin ? null : (
                  <details className="text-sm">
                    <summary className="min-h-11 cursor-pointer py-2 text-ink">Limits and suspension for {who}</summary>
                    <div className="mt-2 flex flex-col gap-5 rounded-md border border-hairline p-4">
                      <LimitsForm userId={r.account_id} documents={r.documents_per_day} people={r.people_per_day} trusted={r.is_trusted} />
                      <SuspendForm userId={r.account_id} who={who} suspended={suspended} />
                      <ResetMfaForm userId={r.account_id} who={who} />
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <EmailPanel adminId={user.id} />
    </div>
  );
}
