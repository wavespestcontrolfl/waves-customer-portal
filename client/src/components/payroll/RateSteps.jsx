import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { etDateString } from '../../lib/timezone';
import { dayLabel, dollars } from './payrollFormat';

// Payroll tab, pay rate changes (owner 2026-11-05: the first technician starts at one rate, then $25
// in the first full pay week after day 90). An admin records a future hourly rate and the Monday it
// starts. The portal changes the pay rate on that Monday by itself; a pay run for an earlier week keeps
// the old rate. A step that was applied is history. Only a scheduled step can be cancelled.

const STATUS = {
  scheduled: { tone: 'strong', label: 'Scheduled' },
  applied: { tone: 'neutral', label: 'Applied' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

const blankForm = () => ({ hourlyRate: '', effectiveOn: '', note: '' });
const firstScheduled = steps => (steps || []).find(step => step.status === 'scheduled') || null;

export function RateStepSummary({ step }) {
  if (!step) return null;
  return <span className="block text-ui-caption text-ink-secondary">{dollars(step.hourlyRate)}/hr from {dayLabel(step.effectiveOn)}</span>;
}

function StepFacts({ step }) {
  return <>
    <span className="block">{dollars(step.hourlyRate)}/hr from {dayLabel(step.effectiveOn)}</span>
    {step.status === 'applied' && step.previousRate != null && <span className="block text-ui-caption text-ink-secondary">Replaced {dollars(step.previousRate)}/hr</span>}
    {step.note && <span className="block text-ui-caption">{step.note}</span>}
  </>;
}

function CancelStep({ step, busy, onConfirm }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button variant="secondary" className="justify-self-start" disabled={busy} onClick={() => setAsking(true)}>Cancel this change</Button>;
  return <div role="group" aria-label="Confirm cancel pay rate change" className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3">
    <p className="m-0">Cancel the change to {dollars(step.hourlyRate)}/hr on {dayLabel(step.effectiveOn)}? The pay rate stays as it is.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="danger" disabled={busy} onClick={() => onConfirm(step)}>Yes, cancel this change</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>Keep it</Button>
    </div>
  </div>;
}

function StepList({ steps, busy, onCancel }) {
  if (steps.length === 0) return <p className="m-0 text-ui-caption text-ink-secondary">No pay rate changes yet.</p>;
  return <ol className="m-0 grid list-none gap-2 p-0" aria-label="Pay rate changes, newest first">
    {steps.map(step => <li key={step.id} className="grid gap-2 rounded-sm border-hairline border-zinc-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><StepFacts step={step} /></div>
        <Badge tone={STATUS[step.status].tone}>{STATUS[step.status].label}</Badge>
      </div>
      {step.status === 'scheduled' && <CancelStep step={step} busy={busy} onConfirm={onCancel} />}
    </li>)}
  </ol>;
}

function StepForm({ form, setForm, helper, busy, onSubmit }) {
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
  return <form onSubmit={onSubmit} aria-label="Add a pay rate change" className="grid gap-4 sm:grid-cols-2">
    <h3 className="m-0 text-ui-body font-medium sm:col-span-2">Add a pay rate change</h3>
    <p className="m-0 text-ui-caption text-ink-secondary sm:col-span-2">
      The portal changes the pay rate on the first pay week by itself. A pay run for an earlier week keeps the old rate.
    </p>
    <Field label="New hourly rate ($)" required>
      <Input inputMode="decimal" autoComplete="off" placeholder="25.00" value={form.hourlyRate} onChange={set('hourlyRate')} />
    </Field>
    <Field label="First pay week" required help={helper || 'Must be a Monday after today.'}>
      <Input type="date" min={etDateString(new Date())} value={form.effectiveOn} onChange={set('effectiveOn')} />
    </Field>
    <Field label="Note" className="sm:col-span-2">
      <Textarea rows={2} maxLength={500} value={form.note} onChange={set('note')} />
    </Field>
    <div className="sm:col-span-2"><Button type="submit" disabled={busy || !form.hourlyRate.trim() || !form.effectiveOn}>{busy ? 'Saving…' : 'Save pay rate change'}</Button></div>
  </form>;
}

// Everything the dialog does against the server: load, add, cancel. Each write reloads the list.
function useRateSteps({ call, technician, onChange, onSaved }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = await call(`/technicians/${technician.id}/rate-steps`);
    setData(next);
    onChange(firstScheduled(next.steps));
    // The day-90 Monday is offered only while nothing is scheduled.
    if (!firstScheduled(next.steps) && next.suggestedDay90Monday) setForm(prev => ({ ...prev, effectiveOn: prev.effectiveOn || next.suggestedDay90Monday }));
  }, [call, technician.id, onChange]);

  useEffect(() => { load().catch(failure => setError(failure.message)); }, [load]);

  async function write(request, doneText) {
    setBusy(true); setError('');
    try {
      await request();
      await load();
      onSaved(doneText);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  const add = event => {
    event.preventDefault();
    const body = { effectiveOn: form.effectiveOn, hourlyRate: form.hourlyRate.trim(), ...(form.note.trim() ? { note: form.note.trim() } : {}) };
    return write(async () => {
      await call(`/technicians/${technician.id}/rate-steps`, { method: 'POST', body });
      setForm(blankForm());
    }, `Pay rate change saved for ${technician.name}.`);
  };
  const cancel = step => write(() => call(`/rate-steps/${step.id}`, { method: 'DELETE' }), `Pay rate change cancelled for ${technician.name}.`);

  return { data, form, setForm, busy, error, add, cancel };
}

export function RateStepsDialog({ call, technician, onClose, onChange, onSaved }) {
  const { data, form, setForm, busy, error, add, cancel } = useRateSteps({ call, technician, onChange, onSaved });
  const steps = data ? data.steps : [];
  const helper = !firstScheduled(steps) && data && data.suggestedDay90Monday && form.effectiveOn === data.suggestedDay90Monday
    ? 'The first full pay week after day 90. Must be a Monday after today.' : '';

  return <Dialog open onClose={onClose} size="lg">
    <DialogHeader>
      <DialogTitle>Pay rate changes for {technician.name}</DialogTitle>
      <p className="mt-1 text-ui-caption text-ink-secondary">
        Pay rate now: {technician.payRate != null ? `${dollars(technician.payRate)}/hr` : 'Not set'}
      </p>
    </DialogHeader>
    <DialogBody className="grid gap-4">
      {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
      {!data && !error && <p role="status" className="m-0">Loading pay rate changes…</p>}
      {data && <StepList steps={steps} busy={busy} onCancel={cancel} />}
      {data && <StepForm form={form} setForm={setForm} helper={helper} busy={busy} onSubmit={add} />}
    </DialogBody>
    <DialogFooter><Button type="button" variant="secondary" onClick={onClose}>Close</Button></DialogFooter>
  </Dialog>;
}

// The row button with its own dialog. The row summary shows a scheduled step once the dialog has loaded
// the list in this visit, so the Payroll tab fetches nothing per row.
export function RateStepsButton({ call, technician, onSaved }) {
  const [open, setOpen] = useState(false);
  const [scheduled, setScheduled] = useState(null);
  return <div className="grid justify-items-start gap-1">
    <Button variant="secondary" onClick={() => setOpen(true)}>Pay rate change</Button>
    <RateStepSummary step={scheduled} />
    {open && <RateStepsDialog call={call} technician={technician} onClose={() => setOpen(false)} onChange={setScheduled} onSaved={onSaved} />}
  </div>;
}
