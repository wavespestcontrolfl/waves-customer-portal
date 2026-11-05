import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { TD, TR } from '../ui/Table';
import { Textarea } from '../ui/Textarea';
import { etDateString } from '../../lib/timezone';
import { centsToDollars, dayLabel } from './payrollFormat';

// Payroll tab, SIMPLE IRA (owner 2026-11-04, B2 A; plan at Schwab from Jan 1, 2027). An admin types
// what the employee signed: whether they take part (Waves pays 2% of their pay into the IRA, never
// taken from pay) and how much of each check they save before income tax. Like the W-4, a row is
// evidence: a correction is a new row. No SSN and no account number are asked for here.

const PLAN_START = '2027-01-01';

const percentText = bp => `${(Number(bp) / 100).toString()}%`;

export function SimpleSummary({ election }) {
  if (!election) return <span className="text-ink-secondary">Not set up</span>;
  if (!election.participant) return <span>Not taking part</span>;
  let saves = 'saves nothing from pay';
  if (election.deferralBp != null) saves = `saves ${percentText(election.deferralBp)} of each check`;
  if (election.deferralCents != null) saves = `saves ${centsToDollars(election.deferralCents)} from each check`;
  return <span>
    Takes part · {saves}
    <span className="block text-ui-caption text-ink-secondary">Applies from {dayLabel(election.effectiveOn)}</span>
  </span>;
}

// The stub line: this pay, and the year to date (which stays after savings end). Nothing without savings.
export function SimpleStubRow({ stub }) {
  const thisPay = stub.preTaxDeductions ? stub.preTaxDeductions.simpleIraCents : 0;
  const yearToDate = stub.ytd.simpleIraCents || 0;
  if (!stub.preTaxDeductions && yearToDate <= 0) return null;
  return <TR><TD>SIMPLE IRA (pre-tax)</TD><TD nums align="right">{centsToDollars(thisPay)}</TD><TD nums align="right">{centsToDollars(yearToDate)}</TD></TR>;
}

export function SimpleIraDialog({ call, technician, onClose, onSaved }) {
  const [form, setForm] = useState({ participant: true, saveBy: 'none', amount: '', signedOn: '', effectiveOn: '', note: '' });
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const saving = form.participant && form.saveBy !== 'none';

  useEffect(() => {
    let live = true;
    call(`/technicians/${technician.id}/simple-ira`)
      .then(data => { if (live) setHistory(data.elections || []); })
      .catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [call, technician.id]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/simple-ira`, {
        method: 'POST',
        body: {
          participant: form.participant,
          ...(saving ? { [form.saveBy === 'percent' ? 'deferralPercent' : 'deferralDollars']: form.amount } : {}),
          signedOn: form.signedOn,
          ...(form.effectiveOn ? { effectiveOn: form.effectiveOn } : {}),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      });
      onSaved(`SIMPLE IRA saved for ${technician.name}.`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return <Dialog open onClose={onClose} size="lg">
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>SIMPLE IRA for {technician.name}</DialogTitle>
        <p className="mt-1 text-ui-caption text-ink-secondary">
          Type what the employee signed. Waves pays 2% of a participant's pay into the IRA; it is not taken from pay.
          Enter every employee the plan covers, even one who saves nothing: Waves owes the 2% for each of them.
          The employee's own savings come out of each check before income tax. A correction is a new entry.
        </p>
      </DialogHeader>
      <DialogBody className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Checkbox id="simple-participant" label="Takes part in the SIMPLE IRA" checked={form.participant} onChange={set('participant')} /></div>
        {form.participant && <Field label="Saves from each check">
          <Select value={form.saveBy} onChange={set('saveBy')}>
            <option value="none">Nothing (only the 2% from Waves)</option>
            <option value="percent">A percent of the check</option>
            <option value="dollars">A dollar amount</option>
          </Select>
        </Field>}
        {saving && <Field label={form.saveBy === 'percent' ? 'Percent of each check (%)' : 'Dollars from each check ($)'} required>
          <Input inputMode="decimal" autoComplete="off" value={form.amount} onChange={set('amount')} />
        </Field>}
        <Field label="Date the employee signed" required>
          <Input type="date" max={etDateString(new Date())} value={form.signedOn} onChange={set('signedOn')} />
        </Field>
        <Field label="First pay date it applies to" help={`Leave blank to use the date signed, or ${dayLabel(PLAN_START)} if that is later. The plan starts ${dayLabel(PLAN_START)}.`}>
          <Input type="date" min={PLAN_START} value={form.effectiveOn} onChange={set('effectiveOn')} />
        </Field>
        <Field label="Note" className="sm:col-span-2">
          <Textarea rows={2} maxLength={500} value={form.note} onChange={set('note')} />
        </Field>
        {error && <p role="alert" className="text-ui-caption text-alert-fg sm:col-span-2">{error}</p>}
        {history && history.length > 0 && <div className="sm:col-span-2">
          <h3 className="m-0 mb-2 text-ui-body font-medium">Earlier entries, newest first</h3>
          <ol className="m-0 grid list-none gap-2 p-0" aria-label="SIMPLE IRA history, newest first">
            {history.map(row => <li key={row.id} className="rounded-sm border-hairline border-zinc-200 p-3">
              <SimpleSummary election={row} />
              <span className="block text-ui-caption text-ink-secondary">Signed {dayLabel(row.signedOn)}</span>
              {row.note && <span className="block text-ui-caption">{row.note}</span>}
            </li>)}
          </ol>
        </div>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !form.signedOn || (saving && !form.amount.trim())}>{busy ? 'Saving…' : 'Save SIMPLE IRA'}</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

// The row button with its own dialog, so the Payroll tab table carries no extra state for it.
export function SimpleIraButton({ call, technician, onSaved }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="secondary" onClick={() => setOpen(true)}>SIMPLE IRA</Button>
    {open && <SimpleIraDialog call={call} technician={technician} onClose={() => setOpen(false)} onSaved={text => { setOpen(false); onSaved(text); }} />}
  </>;
}
