// Workspace export (Phase 3 slice 7, D-72): a plain link, because the answer is a file. The route checks the owner
// and a fresh authenticator code, and sends the owner to the code page first when needed.
import { Notice } from '@/components/ui';

export function ExportSection({ owner, note }: { owner: boolean; note: string | null }) {
  return (
    <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="export-heading">
      <h2 id="export-heading" className="mb-3 text-base font-medium text-ink">Download everything</h2>
      <p className="text-sm text-ink-body">
        One ZIP file with a list of your folders, documents and the people on them, and for every sent document its full audit trail; completed documents
        also include the signed PDF and the certificate. It can be large. You will be asked for a code from your authenticator app, and the download is
        recorded in your workspace&apos;s history.
      </p>
      {note === 'needs-mfa' ? (
        <div className="mt-3">
          <Notice tone="info">Switch on two-step sign-in under Security first; the export needs a code from your authenticator app.</Notice>
        </div>
      ) : null}
      {note === 'ready' ? (
        <div className="mt-3">
          <Notice tone="success">Code accepted. Select the link again to download.</Notice>
        </div>
      ) : null}
      <p className="mt-4">
        {owner ? (
          <a href="/api/workspace/export" className="text-base">Download the workspace (ZIP)</a>
        ) : (
          <span className="text-sm text-ink-muted">Only the workspace owner can download everything.</span>
        )}
      </p>
    </section>
  );
}
