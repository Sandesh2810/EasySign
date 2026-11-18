import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { supabaseAdmin } from '@/lib/supabase/admin';
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
}

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading accounts…</p>}>
      <Accounts />
    </Suspense>
  );
}

async function Accounts() {
  const user = await requireUser('/app/admin');
  // The database function refuses anyone who is not a platform administrator; they see "not found".
  const { data, error } = await supabaseAdmin().rpc('admin_list_accounts', { p_actor: user.id });
  if (error) notFound();
  const rows = (data ?? []) as AccountRow[];
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
          {waiting > 0 ? ` ${waiting} waiting.` : ' Nobody is waiting.'}
        </p>
      </div>
      <section className="overflow-x-auto rounded-lg bg-surface shadow-soft">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="sr-only">Registered accounts and their approval state</caption>
          <thead>
            <tr className="border-b border-hairline text-ink-muted">
              <th scope="col" className="px-6 py-3 font-medium">
                Person
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Registered
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                State
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.account_id} className="border-b border-hairline last:border-0">
                <th scope="row" className="px-6 py-4 font-normal">
                  <span className="block text-ink">{r.display_name || '(no name)'}</span>
                  <span className="block text-ink-muted">{r.account_email}</span>
                </th>
                <td className="px-6 py-4 text-ink-body">{new Date(r.registered_at).toISOString().slice(0, 10)}</td>
                <td className="px-6 py-4 text-ink">
                  {r.is_admin ? 'Administrator' : r.trust === 'suspended' ? 'Suspended' : r.is_approved ? 'Approved' : r.email_confirmed ? 'Waiting for approval' : 'Email not confirmed'}
                </td>
                <td className="px-6 py-4">
                  <ApprovalForm
                    userId={r.account_id}
                    approved={r.is_approved}
                    who={r.display_name || r.account_email}
                    disabled={r.is_admin ? 'Always approved' : !r.email_confirmed && !r.is_approved ? 'Waiting for them to confirm their email' : undefined}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <EmailPanel adminId={user.id} />
    </div>
  );
}
