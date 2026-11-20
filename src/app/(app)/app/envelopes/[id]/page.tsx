import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { loadLinkLocks, type LinkLock } from "@/lib/signing/locks";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Button, Notice } from "@/components/ui";
import { StatusChip } from "@/components/status-chip";
import type { FieldOptions, FieldType } from "@/lib/fields";
import {
  progressLabel,
  ROLE_LABEL,
  type IdentityCheck,
} from "@/lib/recipient-labels";
import type { RecipientStatus, Role, RoutingMode } from "@/lib/routing";
import { deleteDraftAction } from "../actions";
import { MoveToFolderForm } from "../../folders/folder-forms";
import { buildTimeline } from "@/lib/timeline";
import { FieldEditor, type EditorField } from "./field-editor";
import { PersonActions, VoidPanel } from "./open-actions";
import { RecipientsEditor, type EditableRecipient } from "./recipients-editor";
import { SendPanel, SigningLinkPanel } from "./send-panel";
import { SenderTasks, type TaskView } from "./sender-tasks";
import { DeleteForm, LegalHoldForm } from "./retention-panel";
import { retentionWindow } from "@/lib/retention";
import { loadAuditTrail } from "@/lib/audit-read";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SaveAsTemplateForm } from "../../templates/template-forms";

export const metadata: Metadata = { title: "Document" };

export default function EnvelopePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<p className="text-ink-muted">Loading document…</p>}>
      <Envelope params={params} />
    </Suspense>
  );
}

interface RecipientRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: RecipientStatus;
  is_sender: boolean;
  routing_order: number;
  decline_reason: string | null;
  auth_method: IdentityCheck;
}

async function Envelope({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const user = await requireUser(`/app/envelopes/${rawId}`);
  const id = z.uuid().safeParse(rawId);
  if (!id.success) notFound();

  const supabase = await createSupabaseServerClient();
  const [
    { data: env },
    { data: docs },
    { data: recipientRows },
    { data: fields },
    { data: profile },
    { data: folderRows },
    { data: events },
    { data: taskRows },
  ] = await Promise.all([
    supabase
      .from("envelopes")
      .select(
        "id, title, status, public_code, created_at, self_sign, final_sha256, completed_at, routing_mode, delivery, void_reason, expires_at, expired_at, remind_after_days, remind_every_days, remind_max, folder_id, org_id, updated_at, legal_hold, legal_hold_reason, legal_hold_set_at, deleted_at",
      )
      .eq("id", id.data)
      .maybeSingle(),
    supabase
      .from("envelope_documents")
      .select("id, filename, page_count, size_bytes, sha256")
      .eq("envelope_id", id.data)
      .order("position"),
    supabase
      .from("recipients")
      .select(
        "id, name, email, role, status, is_sender, routing_order, decline_reason, auth_method",
      )
      .eq("envelope_id", id.data)
      .order("routing_order")
      .order("created_at"),
    supabase
      .from("fields")
      .select("id, recipient_id, type, page, x, y, w, h, required, locked, options")
      .eq("envelope_id", id.data),
    supabase
      .from("profiles")
      .select("display_name")
      .eq("id", user.id)
      .maybeSingle(),
    supabase.from("folders").select("id, name, org_id").order("name"),
    // the audit trail, read through the user's own session (row-level security)
    supabase
      .from("audit_events")
      .select("event_type, created_at, recipient_id")
      .eq("envelope_id", id.data)
      .order("chain_seq")
      .limit(500),
    supabase
      .from("sender_tasks")
      .select("id, kind, note, created_at, recipient_id")
      .eq("envelope_id", id.data)
      .is("done_at", null)
      .order("created_at"),
  ]);
  if (!env) notFound(); // row-level security: someone else's document does not exist for this user
  // files signers attached (D-78); read through the person's own session, like everything else here
  const { data: attachmentRows } = await supabase
    .from("field_attachments")
    .select("field_id, recipient_id, file_name, kind, size_bytes, sha256")
    .eq("envelope_id", id.data)
    .order("created_at");
  const doc = docs?.[0];
  const recipients = (recipientRows ?? []) as RecipientRow[];
  const signers = recipients
    .filter((r) => r.role === "signer" || r.role === "in_person")
    .map((r) => ({ id: r.id, name: r.name }));
  const isDraft = env.status === "draft";
  const isOpen = env.status === "sent" || env.status === "in_progress";
  // A viewer reads everything and changes nothing (D-75): no editing controls. The database refuses their changes anyway.
  const { data: myMembership } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", env.org_id)
    .eq("user_id", user.id)
    .is("deactivated_at", null)
    .maybeSingle();
  const viewOnly = myMembership?.role === "viewer";
  const canEditDraft = isDraft && !viewOnly;
  // the whole audit trail, archived parts included (D-72); drafts have only their own creation events
  const trail = isDraft
    ? null
    : await loadAuditTrail(env.id as string).catch(() => null);
  const isFinished = ["completed", "declined", "voided", "expired"].includes(
    env.status as string,
  );
  const deleted = Boolean(env.deleted_at);
  // who may hold or delete, and until when this document must be kept (D-71); the database checks all of it again
  const [{ data: myRole }, { data: myControls }, { data: orgControls }] =
    isFinished
      ? await Promise.all([
          supabase
            .from("memberships")
            .select("role")
            .eq("org_id", env.org_id)
            .eq("user_id", user.id)
            .maybeSingle(),
          supabase
            .from("account_controls")
            .select("is_platform_admin")
            .eq("user_id", user.id)
            .maybeSingle(),
          supabaseAdmin()
            .from("org_controls")
            .select("retention_years")
            .eq("org_id", env.org_id)
            .maybeSingle(),
        ])
      : [{ data: null }, { data: null }, { data: null }];
  const isOwner = myRole?.role === "owner";
  const canHold = isOwner || Boolean(myControls?.is_platform_admin);
  const retentionYears = Number(orgControls?.retention_years ?? 7);
  const { keepUntil, mayDeleteNow } = retentionWindow(
    (env.completed_at ?? env.expired_at ?? env.updated_at) as string,
    retentionYears,
  );
  const selfSign = isDraft
    ? recipients.length === 1 &&
      recipients[0].is_sender &&
      recipients[0].role === "signer"
    : Boolean(env.self_sign);
  const decliner = recipients.find((r) => r.status === "declined");
  const nameOf = new Map(recipients.map((r) => [r.id, r.name]));
  const tasks: TaskView[] = (taskRows ?? []).map((t) => ({
    id: t.id as string,
    kind: t.kind as TaskView["kind"],
    who: nameOf.get(t.recipient_id as string) ?? "A recipient",
    note: (t.note as string | null) ?? null,
    createdAt: t.created_at as string,
  }));
  const initialFields: EditorField[] = (fields ?? []).map((f) => ({
    key: f.id as string,
    recipientId: f.recipient_id as string,
    type: f.type as FieldType,
    page: f.page as number,
    x: Number(f.x),
    y: Number(f.y),
    w: Number(f.w),
    h: Number(f.h),
    required: Boolean(f.required),
    locked: Boolean(f.locked),
    options: (f.options ?? {}) as FieldOptions,
  }));
  const editable: EditableRecipient[] = recipients
    .filter((r) => r.role !== "in_person")
    .map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role as EditableRecipient["role"],
      order: r.routing_order,
      check: r.auth_method,
      codeSet: r.auth_method === "access_code",
    }));
  // Whose link is locked after too many wrong codes. This table is server-only; the document itself was
  // already read through the user's own session above, so only a member of the workspace gets this far.
  const locked: Map<string, LinkLock> =
    isOpen && recipients.some((r) => r.auth_method !== "link")
      ? await loadLinkLocks(env.id as string)
      : new Map();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          <Link href="/app">Dashboard</Link> / Document
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-serif text-4xl font-light italic text-ink">
            {env.title}
          </h1>
          <StatusChip status={env.status} />
        </div>
        <p className="mt-1 font-mono text-sm text-ink-muted">
          Verification code {env.public_code}
        </p>
      </div>

      {env.status === "declined" && decliner ? (
        <Notice tone="danger">
          {decliner.name} declined this document.{" "}
          {decliner.decline_reason
            ? `Their reason: “${decliner.decline_reason}”`
            : "They gave no reason."}{" "}
          It has been stopped for everyone and every signing link is switched
          off. To try again, create a new document.
        </Notice>
      ) : null}

      {env.status === "expired" ? (
        <Notice tone="danger">
          This document expired
          {env.expired_at
            ? ` on ${new Date(env.expired_at as string).toISOString().slice(0, 10)}`
            : ""}{" "}
          before everyone had finished. Every signing link is switched off and
          nothing was completed. To try again, create a new document; you can
          choose a longer time limit when you send it.
        </Notice>
      ) : null}

      {env.status === "voided" ? (
        <Notice tone="danger">
          You cancelled this document.{" "}
          {env.void_reason
            ? `Your reason: “${env.void_reason}”`
            : "No reason was recorded."}{" "}
          Every signing link is switched off and nothing was completed. To try
          again, create a new document.
        </Notice>
      ) : null}

      {tasks.length > 0 && !viewOnly ? (
        <section
          className="rounded-lg bg-surface p-6 shadow-soft"
          aria-labelledby="tasks-heading"
        >
          <h2
            id="tasks-heading"
            className="mb-3 text-base font-medium text-ink"
          >
            Needs your attention
          </h2>
          <SenderTasks envelopeId={env.id} tasks={tasks} />
        </section>
      ) : null}

      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="mb-3 text-base font-medium text-ink">
          {isDraft ? "1. Who is involved?" : "People"}
        </h2>
        {canEditDraft ? (
          <RecipientsEditor
            key={`${env.routing_mode}:${recipients.map((r) => `${r.id}${r.role}${r.routing_order}${r.auth_method}`).join(",")}`}
            envelopeId={env.id}
            initial={editable}
            initialMode={env.routing_mode as RoutingMode}
            me={{
              name: (profile?.display_name as string | undefined) || "Me",
              email: user.email ?? "",
            }}
          />
        ) : recipients.length === 0 ? (
          <p className="text-sm text-ink-muted">Nobody was added.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-hairline">
            {recipients.map((r) => (
              <li
                key={r.id}
                className="grid gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[3rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)]"
              >
                <span className="text-ink-muted">
                  {r.role === "cc" ? "End" : `Turn ${r.routing_order}`}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-ink">{r.name}</span>
                  <span className="block truncate text-ink-muted">
                    {r.email}
                  </span>
                </span>
                <span className="text-ink-body">
                  {ROLE_LABEL[r.role]}
                  {r.auth_method !== "link" ? (
                    <span className="block text-ink-muted">
                      Extra check:{" "}
                      {r.auth_method === "access_code"
                        ? "access code"
                        : "code by email"}
                    </span>
                  ) : null}
                </span>
                <span className="font-medium text-ink">
                  {progressLabel(r.role, r.status)}
                  {locked.has(r.id) ? (
                    <span className="block font-normal text-ink-body">
                      Locked after too many wrong codes
                      {locked.get(r.id) === "timed"
                        ? " (opens again by itself shortly)"
                        : ""}
                    </span>
                  ) : null}
                </span>
                {isOpen && !viewOnly ? (
                  <PersonActions
                    envelopeId={env.id}
                    person={{ id: r.id, name: r.name, email: r.email }}
                    canResend={
                      env.delivery === "email" &&
                      r.role !== "cc" &&
                      !r.is_sender &&
                      ["sent", "viewed", "consented"].includes(r.status)
                    }
                    canCorrect={[
                      "created",
                      "sent",
                      "viewed",
                      "consented",
                    ].includes(r.status)}
                    locked={locked.has(r.id)}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {isOpen && env.expires_at ? (
          <p className="mt-4 border-t border-hairline pt-4 text-sm text-ink-body">
            The signing links stop working on{" "}
            {new Date(env.expires_at as string).toISOString().slice(0, 10)}.{" "}
            {env.delivery !== "email"
              ? "No reminders: you chose to share the links yourself."
              : Number(env.remind_max) > 0
                ? `People who have not finished are reminded by email after ${env.remind_after_days} day${Number(env.remind_after_days) === 1 ? "" : "s"}, then every ${env.remind_every_days} day${Number(env.remind_every_days) === 1 ? "" : "s"}, up to ${env.remind_max} time${Number(env.remind_max) === 1 ? "" : "s"}.`
                : "No reminders will be sent."}
          </p>
        ) : null}
      </section>

      <section className="rounded-lg bg-surface p-6 shadow-soft">
        <h2 className="text-base font-medium text-ink">Original file</h2>
        {doc ? (
          <>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
              <dt className="text-ink-muted">File</dt>
              <dd className="truncate text-ink">{doc.filename}</dd>
              <dt className="text-ink-muted">Pages</dt>
              <dd className="text-ink">{doc.page_count}</dd>
              <dt className="text-ink-muted">Size</dt>
              <dd className="text-ink">
                {Math.max(1, Math.round(Number(doc.size_bytes) / 1024))} KB
              </dd>
              <dt className="text-ink-muted">SHA-256</dt>
              <dd className="break-all font-mono text-xs text-ink">
                {doc.sha256}
              </dd>
            </dl>
            {deleted ? (
              <p className="mt-4 text-sm text-ink-muted">
                The file was deleted; only its fingerprint above remains.
              </p>
            ) : (
              <p className="mt-4 text-sm">
                <a
                  href={`/api/envelopes/${env.id}/document`}
                  target="_blank"
                  rel="noopener"
                >
                  Open the original PDF in a new tab
                </a>
              </p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            No file is attached to this document.
          </p>
        )}
      </section>

      {doc && !deleted ? (
        <section>
          <h2 className="mb-3 text-base font-medium text-ink">
            {isDraft ? "2. Where do they sign?" : "Fields"}
          </h2>
          <FieldEditor
            key={signers.map((s) => s.id).join(",") || "none"}
            envelopeId={env.id}
            documentId={doc.id}
            signers={signers}
            initialFields={initialFields}
            readOnly={!canEditDraft}
          />
        </section>
      ) : null}

      {doc && !viewOnly && (isDraft || isOpen) ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">
            {isDraft ? "3. Send" : "Signing links"}
          </h2>
          {isDraft ? (
            <SendPanel
              envelopeId={env.id}
              selfSign={selfSign}
              hasSigner={signers.length > 0}
            />
          ) : (
            <SigningLinkPanel envelopeId={env.id} selfSign={selfSign} />
          )}
        </section>
      ) : null}

      {isOpen && !viewOnly ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">
            Cancel this document
          </h2>
          <VoidPanel envelopeId={env.id} />
        </section>
      ) : null}

      {deleted ? (
        <Notice tone="info">
          This document was deleted on{" "}
          {new Date(env.deleted_at as string).toISOString().slice(0, 10)} by the
          workspace owner. Its files, what people typed, their signatures and
          their names are gone. Its fingerprints and its history remain, with a
          record of the deletion.
        </Notice>
      ) : null}

      {env.status === "completed" && !deleted ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft">
          <h2 className="mb-3 text-base font-medium text-ink">Completed</h2>
          <p className="text-sm text-ink-body">
            Everyone has finished. The sealed file and its certificate are
            ready.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-ink-muted">
            SHA-256 of the sealed file: {env.final_sha256}
          </p>
          <p className="mt-4 flex flex-wrap gap-4 text-sm">
            <a href={`/api/envelopes/${env.id}/sealed`}>
              Download the signed PDF
            </a>
            <a href={`/api/envelopes/${env.id}/sealed?part=certificate`}>
              Download the certificate
            </a>
          </p>
        </section>
      ) : null}

      {isFinished && !deleted ? (
        <section
          className="rounded-lg bg-surface p-6 shadow-soft"
          aria-labelledby="keep-heading"
        >
          <h2 id="keep-heading" className="mb-3 text-base font-medium text-ink">
            Keeping and deleting
          </h2>
          <p className="text-sm text-ink-body">
            {retentionYears > 0 ? (
              <>
                Your workspace keeps finished documents for {retentionYears}{" "}
                {retentionYears === 1 ? "year" : "years"}: this one until{" "}
                <strong>{keepUntil.toISOString().slice(0, 10)}</strong>.
              </>
            ) : (
              <>
                Your workspace has no minimum keeping period, so the owner can
                delete finished documents at any time.
              </>
            )}{" "}
            Nothing is ever deleted automatically.
            {isOwner ? (
              <>
                {" "}
                You can change the period in{" "}
                <Link href="/app/settings">Settings</Link>.
              </>
            ) : null}
          </p>
          {env.legal_hold ? (
            <div className="mt-4">
              <Notice tone="info">
                On legal hold since{" "}
                {new Date(env.legal_hold_set_at as string)
                  .toISOString()
                  .slice(0, 10)}
                {env.legal_hold_reason ? (
                  <>: &ldquo;{env.legal_hold_reason}&rdquo;</>
                ) : null}
                . It cannot be deleted while the hold is on.
              </Notice>
            </div>
          ) : null}
          {canHold ? (
            <div className="mt-4">
              <LegalHoldForm envelopeId={env.id} on={Boolean(env.legal_hold)} />
            </div>
          ) : null}
          {isOwner && !env.legal_hold && mayDeleteNow ? (
            <div className="mt-6 border-t border-hairline pt-4">
              <DeleteForm
                envelopeId={env.id}
                code={env.public_code as string}
              />
            </div>
          ) : null}
          {isOwner && !env.legal_hold && !mayDeleteNow ? (
            <p className="mt-4 text-sm text-ink-muted">
              It can be deleted after the retention period ends.
            </p>
          ) : null}
        </section>
      ) : null}

      {canEditDraft ? (
        <form action={deleteDraftAction}>
          <input type="hidden" name="envelope_id" value={env.id} />
          <Button type="submit" variant="outline">
            Delete this draft
          </Button>
        </form>
      ) : null}
      {attachmentRows && attachmentRows.length > 0 && !env.deleted_at ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="attachments-heading">
          <h2 id="attachments-heading" className="mb-3 text-base font-medium text-ink">
            Files attached by signers
          </h2>
          <ul className="flex flex-col gap-2">
            {attachmentRows.map((a) => (
              <li key={a.field_id as string} className="text-base text-ink [overflow-wrap:anywhere]">
                <a href={`/api/envelopes/${env.id}/attachments/${a.field_id}`} download>
                  {a.file_name as string}
                </a>
                <span className="text-sm text-ink-muted">
                  {" "}
                  · {recipients.find((r) => r.id === a.recipient_id)?.name ?? "a signer"} · {Math.max(1, Math.round(Number(a.size_bytes) / 1024))} KB · SHA-256{" "}
                  {String(a.sha256).slice(0, 16)}…
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {doc && !viewOnly && !env.deleted_at && recipients.some((r) => ["signer", "approver", "cc", "in_person"].includes(r.role)) ? (
        <section className="rounded-lg bg-surface p-6 shadow-soft" aria-labelledby="template-heading">
          <h2 id="template-heading" className="mb-3 text-base font-medium text-ink">
            Save as template
          </h2>
          <SaveAsTemplateForm
            envelopeId={env.id as string}
            title={env.title as string}
            people={recipients
              .filter((r) => ["signer", "approver", "cc", "in_person"].includes(r.role))
              .map((r) => ({ id: r.id, name: r.name, role: r.role }))}
          />
        </section>
      ) : null}
      <section
        className="rounded-lg bg-surface p-6 shadow-soft"
        aria-labelledby="history-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="history-heading" className="text-base font-medium text-ink">
            Folder and history
          </h2>
          {viewOnly ? null : (
            <MoveToFolderForm
              envelopeId={env.id as string}
              current={(env.folder_id as string | null) ?? null}
              folders={(folderRows ?? [])
                .filter((f) => f.org_id === env.org_id)
                .map((f) => ({ id: f.id as string, name: f.name as string }))}
            />
          )}
        </div>
        <ol className="mt-4 flex flex-col gap-2 border-l border-hairline pl-4 text-sm">
          {buildTimeline(
            (trail ? trail.rows : (events ?? [])) as {
              event_type: string;
              created_at: string;
              recipient_id: string | null;
            }[],
            new Map(recipients.map((r) => [r.id, r.name])),
          ).map((t, i) => (
            <li key={i}>
              <time dateTime={t.when} className="text-ink-muted">
                {t.when.slice(0, 10)} {t.when.slice(11, 16)} UTC
              </time>{" "}
              <span className="text-ink">{t.what}</span>
              {t.who ? <span className="text-ink-body"> · {t.who}</span> : null}
            </li>
          ))}
        </ol>
        {trail ? (
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <p
              className={
                trail.verify.ok ? "text-ink-body" : "font-medium text-ink"
              }
              role={trail.verify.ok ? undefined : "alert"}
            >
              {trail.verify.ok
                ? `History check: all ${trail.rows.length} events are intact and linked${trail.archivedParts.length > 0 ? " (older events are kept in a compressed archive)" : ""}.`
                : `History check FAILED: ${trail.verify.reason ?? "unknown reason"}. Contact the administrator.`}
            </p>
            <p className="flex flex-wrap gap-4">
              <a href={`/api/envelopes/${env.id}/audit?format=pdf`}>
                Download the full audit trail (PDF)
              </a>
              <a href={`/api/envelopes/${env.id}/audit?format=json`}>
                Download it as data (JSON, re-checkable)
              </a>
            </p>
          </div>
        ) : null}
        <p className="mt-3 text-sm text-ink-muted">
          The complete, tamper-evident record (with internet addresses and
          devices) is in the audit trail downloads above and in the certificate
          of the completed document.
        </p>
      </section>
    </div>
  );
}
