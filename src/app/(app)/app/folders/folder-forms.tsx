'use client';
import { useActionState } from 'react';
import { Button } from '@/components/ui';
import { addRuleAction, createFolderAction, deleteFolderAction, deleteRuleAction, moveToFolderAction, type FolderResult } from './actions';

const INPUT = 'min-h-11 rounded-sm border border-control-border bg-surface px-3 text-base text-ink';
const Said = ({ state }: { state: FolderResult }) =>
  state ? (
    <span role={state.ok ? 'status' : 'alert'} className="text-sm text-ink">
      {state.message}
    </span>
  ) : null;

export function CreateFolderForm() {
  const [state, action, pending] = useActionState<FolderResult, FormData>(createFolderAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-folder" className="text-sm font-medium text-ink">
          New folder
        </label>
        <input id="new-folder" name="name" required maxLength={120} autoComplete="off" className={INPUT} />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Creating…' : 'Create folder'}
      </Button>
      <Said state={state} />
    </form>
  );
}

export function DeleteFolderForm({ folderId, name }: { folderId: string; name: string }) {
  const [state, action, pending] = useActionState<FolderResult, FormData>(deleteFolderAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="folder_id" value={folderId} />
      <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`Delete folder: ${name}`}>
        Delete folder
      </Button>
      <Said state={state} />
    </form>
  );
}

export function AddRuleForm({ folders }: { folders: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FolderResult, FormData>(addRuleAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rule-words" className="text-sm font-medium text-ink">
          When the title contains
        </label>
        <input id="rule-words" name="words" required minLength={2} maxLength={100} autoComplete="off" placeholder="e.g. lease" className={INPUT} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rule-folder" className="text-sm font-medium text-ink">
          file it in
        </label>
        <select id="rule-folder" name="folder_id" required className={INPUT}>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Adding…' : 'Add rule'}
      </Button>
      <Said state={state} />
    </form>
  );
}

export function DeleteRuleForm({ ruleId, label }: { ruleId: string; label: string }) {
  const [state, action, pending] = useActionState<FolderResult, FormData>(deleteRuleAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="rule_id" value={ruleId} />
      <Button type="submit" variant="outline" className="min-h-10 px-4 text-sm" disabled={pending} aria-label={`Remove the rule: ${label}`}>
        Remove
      </Button>
      <Said state={state} />
    </form>
  );
}

export function MoveToFolderForm({ envelopeId, current, folders }: { envelopeId: string; current: string | null; folders: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FolderResult, FormData>(moveToFolderAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="envelope_id" value={envelopeId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`move-${envelopeId}`} className="text-sm font-medium text-ink">
          Folder
        </label>
        <select id={`move-${envelopeId}`} name="folder_id" defaultValue={current ?? ''} className={INPUT}>
          <option value="">No folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" className="min-h-11 px-4 text-sm" disabled={pending}>
        {pending ? 'Moving…' : 'Move'}
      </Button>
      <Said state={state} />
    </form>
  );
}
