import React, { useState } from 'react';
import { ActionFeedback } from './ActionFeedback';
import { Button } from './Button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from './Dialog';
import { Field } from './Field';
import { Input } from './Input';
import { Select } from './Select';

export function TableSavedViews({ label, controller, onApply = controller.applyView }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [unexpectedError, setUnexpectedError] = useState('');
  const [pending, setPending] = useState('');
  const selected = controller.views.find((view) => view.id === selectedId);
  if (!controller.available) return null;

  const save = async (event) => {
    event.preventDefault();
    if (pending) return;
    setMessage('');
    setUnexpectedError('');
    setPending('save');
    let saved = false;
    try {
      saved = await controller.saveView(name);
    } catch { setUnexpectedError('The view could not be saved. Try again.'); }
    finally { setPending(''); }
    if (!saved) return;
    setMessage('View saved.');
    setOpen(false);
  };
  const apply = async () => {
    if (pending || !selected) return;
    const selectedName = selected.name;
    setMessage('');
    setUnexpectedError('');
    setPending('apply');
    let applied = null;
    try {
      applied = await onApply(selected.id);
    } catch { setUnexpectedError('The view could not be applied. Try again.'); }
    finally { setPending(''); }
    if (!applied) return;
    setMessage(`View “${selectedName}” applied.`);
    setOpen(false);
  };
  const remove = async () => {
    if (pending || !selected) return;
    setMessage('');
    setUnexpectedError('');
    setPending('remove');
    let removed = false;
    try {
      removed = await controller.removeView(selected.id);
    } catch { setUnexpectedError('The view could not be deleted. Try again.'); }
    finally { setPending(''); }
    if (!removed) return;
    setSelectedId('');
    setMessage('View deleted.');
  };
  const feedback = controller.error || unexpectedError
    ? <ActionFeedback error>{controller.error || unexpectedError}</ActionFeedback>
    : message && <ActionFeedback>{message}</ActionFeedback>;

  return <>
    <Button variant="secondary" disabled={Boolean(pending)} aria-label={`${label} saved views`} aria-haspopup="dialog" aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setName('');
        setSelectedId('');
        setMessage('');
        setUnexpectedError('');
        setOpen(true);
      }}>Views</Button>
    {!open && feedback && <div className="basis-full">{feedback}</div>}
    <Dialog open={open} onClose={() => { if (!pending) setOpen(false); }} size="sm">
      <DialogHeader><DialogTitle>{label} saved views</DialogTitle></DialogHeader>
      <form onSubmit={save}>
        <DialogBody>
          <p className="mb-4 text-ui-body text-ink-secondary">Table settings and named views are saved for your account in this browser.</p>
          {controller.catalogLoading ? <p className="text-ui-body text-ink-secondary" role="status">Loading saved views…</p>
            : controller.views.length ? <div className="grid gap-3">
            <Field label="Saved view">
              <Select aria-label={`${label} saved view`} value={selected?.id || ''} disabled={Boolean(pending)} onChange={(event) => setSelectedId(event.target.value)}>
                <option value="">Choose a view</option>
                {controller.views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" loading={pending === 'apply'} disabled={Boolean(pending) || !selected} onClick={apply}>Use view</Button>
              <Button variant="ghost" loading={pending === 'remove'} disabled={Boolean(pending) || !selected} onClick={remove}>Delete view</Button>
            </div>
          </div> : <p className="text-ui-body text-ink-secondary">No saved views yet.</p>}
          <div className="mt-4 border-t border-zinc-200 pt-4">
            <Field label="View name">
              <Input value={name} disabled={Boolean(pending) || controller.catalogLoading} onChange={(event) => setName(event.target.value)} maxLength={64} required autoComplete="off" />
            </Field>
          </div>
          {feedback && <div className="mt-3">{feedback}</div>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={Boolean(pending)} onClick={() => setOpen(false)}>Done</Button>
          <Button type="submit" loading={pending === 'save'} disabled={Boolean(pending) || controller.catalogLoading || !name.trim()}>Save current view</Button>
        </DialogFooter>
      </form>
    </Dialog>
  </>;
}
