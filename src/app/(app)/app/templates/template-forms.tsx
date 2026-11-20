'use client';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { deleteTemplateAction, saveAsTemplateAction, updateTemplateAction, useTemplateAction, type TemplateResult } from './actions';

export function DeleteTemplateForm({ templateId, name }: { templateId: string; name: string }) {
  return (
    <form
      action={deleteTemplateAction}
      onSubmit={(e) => {
        if (!window.confirm(`Delete the template “${name}”? Documents already made from it are not affected.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="template_id" value={templateId} />
      <Button type="submit" variant="outline">
        Delete this template
      </Button>
    </form>
  );
}

const INPUT = 'min-h-11 w-full rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const Said = ({ state }: { state: TemplateResult }) =>
  state ? (
    <p role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">
      {state.message}
    </p>
  ) : null;

export function UseTemplateForm({ templateId, name, roles }: { templateId: string; name: string; roles: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState<TemplateResult, FormData>(useTemplateAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="template_id" value={templateId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="use-title" className="text-sm font-medium text-ink">
          Document title
        </label>
        <input id="use-title" name="title" defaultValue={name} maxLength={200} className={INPUT} />
      </div>
      {roles.map((r) => (
        <fieldset key={r.id} className="flex flex-col gap-2 rounded-md border border-hairline p-3">
          <legend className="px-1 text-sm font-medium text-ink">{r.label}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`name-${r.id}`} className="text-sm text-ink">
                Name
              </label>
              <input id={`name-${r.id}`} name={`name_${r.id}`} required maxLength={200} autoComplete="off" className={INPUT} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`email-${r.id}`} className="text-sm text-ink">
                Email
              </label>
              <input id={`email-${r.id}`} name={`email_${r.id}`} type="email" required maxLength={254} autoComplete="off" className={INPUT} />
            </div>
          </div>
        </fieldset>
      ))}
      <Said state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating the draft…' : 'Create draft'}
        </Button>
      </div>
    </form>
  );
}

type EditRole = { id: string; label: string; role: string };
type EditField = { id: string; label: string; locked: boolean };

export function EditTemplateForm({ templateId, name, shared, roles, fields }: { templateId: string; name: string; shared: boolean; roles: EditRole[]; fields: EditField[] }) {
  const [state, action, pending] = useActionState<TemplateResult, FormData>(updateTemplateAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="template_id" value={templateId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tpl-name" className="text-sm font-medium text-ink">
          Template name
        </label>
        <input id="tpl-name" name="name" required maxLength={120} defaultValue={name} className={INPUT} />
      </div>
      <label className="flex items-center gap-3 text-base text-ink">
        <input type="checkbox" name="shared" defaultChecked={shared} className="size-5 accent-ink" />
        Share with the team (members can use it; the owner and administrators can also edit it)
      </label>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-ink">Role names</legend>
        {roles.map((r, i) => (
          <div key={r.id} className="flex flex-col gap-1.5">
            <label htmlFor={`role-${r.id}`} className="text-sm text-ink">
              Role {i + 1} ({r.role.replace('_', ' ')})
            </label>
            <input id={`role-${r.id}`} name={`role_${r.id}`} required maxLength={60} defaultValue={r.label} className={INPUT} />
          </div>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">Locked fields</legend>
        <p className="text-sm text-ink-muted">A locked field cannot be moved, resized or removed in documents made from this template.</p>
        {fields.map((f) => (
          <label key={f.id} className="flex items-center gap-3 text-base text-ink">
            <input type="checkbox" name="locked" value={f.id} defaultChecked={f.locked} className="size-5 accent-ink" />
            {f.label}
          </label>
        ))}
      </fieldset>
      <Said state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Save template'}
        </Button>
      </div>
    </form>
  );
}

export function SaveAsTemplateForm({ envelopeId, title, people }: { envelopeId: string; title: string; people: { id: string; name: string; role: string }[] }) {
  const [state, action, pending] = useActionState<TemplateResult, FormData>(saveAsTemplateAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <p className="text-sm text-ink-muted">
        Keeps a copy of this document and its fields. Give each person a role name (for example “Tenant”); their name and email are not kept.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="tpl-new-name" className="text-sm font-medium text-ink">
          Template name
        </label>
        <input id="tpl-new-name" name="name" required maxLength={120} defaultValue={title} className={INPUT} />
      </div>
      {people.map((p, i) => (
        <div key={p.id} className="flex flex-col gap-1.5">
          <label htmlFor={`label-${p.id}`} className="text-sm text-ink">
            Role for {p.name}
          </label>
          <input id={`label-${p.id}`} name={`label_${p.id}`} maxLength={60} placeholder={`${p.role === 'signer' ? 'Signer' : p.role.charAt(0).toUpperCase() + p.role.slice(1)} ${i + 1}`} className={INPUT} />
        </div>
      ))}
      <label className="flex items-center gap-3 text-base text-ink">
        <input type="checkbox" name="shared" defaultChecked className="size-5 accent-ink" />
        Share with the team
      </label>
      <Said state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Save as template'}
        </Button>
      </div>
    </form>
  );
}
