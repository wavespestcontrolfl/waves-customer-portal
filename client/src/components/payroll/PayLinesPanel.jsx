import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';
import { etStartOfWeek } from '../../lib/timezone';
import { centsToDollars, dayLabel, weekLabel } from './payrollFormat';

// Pay runs section, "Pay lines" (owner ruling 2026-10-29, dark behind
// GATE_PAYROLL_PAY_LINES). A review bonus, a commission, a health allowance or
// the HSA money Waves pays in: the next pay run that reaches the week pays it.
// With the gate off the server answers 404 and this panel renders nothing.

const KINDS = [
  { value: 'review_bonus', label: 'Review bonus' },
  { value: 'commission', label: 'Commission' },
  { value: 'health_allowance', label: 'Health allowance' },
  { value: 'hsa_employer', label: 'HSA from Waves' },
];
const kindWord = kind => (KINDS.find(k => k.value === kind) || { label: kind }).label;
const WEEK_CHOICES = 12;

// '46.15' -> 4615. Anything that is not dollars with at most 2 decimals -> null.
export function dollarsToCents(text) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text || '').trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
}

const blankForm = () => ({ technicianId: '', kind: 'review_bonus', amount: '', earnedWeekStart: '', coversFrom: '', coversTo: '', note: '' });

function spanWord(line) {
  return line.coversFrom ? `${dayLabel(line.coversFrom)} to ${dayLabel(line.coversTo)}` : 'Earned week only';
}

function LinesTable({ title, lines, onRemove, busy }) {
  return <Table aria-label={title}>
    <THead><TR>
      <TH>Employee</TH><TH>Kind</TH><TH align="right">Amount</TH><TH>Week</TH><TH>Covers</TH><TH>Note</TH>
      {onRemove && <TH><span className="sr-only">Actions</span></TH>}
    </TR></THead>
    <TBody>
      {lines.map(line => <TR key={line.id}>
        <TD>{line.name}</TD>
        <TD>{kindWord(line.kind)}</TD>
        <TD nums align="right">{centsToDollars(line.amountCents)}</TD>
        <TD>{weekLabel(line.earnedWeekStart)}</TD>
        <TD>{spanWord(line)}</TD>
        <TD>{line.note || ''}</TD>
        {onRemove && <TD>
          <Button variant="secondary" disabled={busy} onClick={() => onRemove(line)} aria-label={`Remove ${kindWord(line.kind)} for ${line.name}`}>Remove</Button>
        </TD>}
      </TR>)}
    </TBody>
  </Table>;
}

export default function PayLinesPanel({ call, weekStart, onChanged }) {
  // null until the first answer; false when the server says the gate is off.
  const [enabled, setEnabled] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [open, setOpen] = useState([]);
  const [paid, setPaid] = useState([]);
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const openData = await call('/pay-lines?status=open');
      setEnabled(true);
      setOpen(openData.payLines || []);
      setError('');
      // Every W-2 employee, one who has left too (a commission paid after the last day).
      const [paidData, techData] = await Promise.all([call('/pay-lines?status=paid'), call('/pay-lines/technicians')]);
      setPaid((paidData.payLines || []).slice(0, 10));
      setTechnicians(techData.technicians || []);
    } catch (failure) {
      if (failure.status === 404) { setEnabled(false); return; }
      // Fail closed: only a successful gated answer opens the panel.
      setError(failure.message);
    }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  if (enabled !== true) return null;

  // The week the pay run is looking at and the weeks before it.
  // Pay that covers dates is earned in the week that holds the last of them, until the person picks one.
  const earned = form.earnedWeekStart || (form.coversTo ? etStartOfWeek(form.coversTo) : weekStart);
  const recent = Array.from({ length: WEEK_CHOICES }, (_, n) => addStaffCalendarDays(weekStart, -7 * n));
  const weeks = recent.includes(earned) ? recent : [earned, ...recent].sort().reverse();
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
  const cents = dollarsToCents(form.amount);
  const spanStarted = Boolean(form.coversFrom || form.coversTo);
  const ready = form.technicianId && cents && cents > 0 && (!spanStarted || (form.coversFrom && form.coversTo));

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await call('/pay-lines', {
        method: 'POST',
        body: {
          kind: form.kind,
          technicianId: form.technicianId,
          amountCents: cents,
          earnedWeekStart: earned,
          ...(spanStarted ? { coversFrom: form.coversFrom, coversTo: form.coversTo } : {}),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      });
      setMessage('Pay line added. The next pay run that reaches the week pays it.');
      setForm(blankForm());
      await load();
      if (onChanged) onChanged();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  async function remove(line) {
    setBusy(true); setError(''); setMessage('');
    try {
      await call(`/pay-lines/${line.id}`, { method: 'DELETE' });
      setMessage('Pay line removed.');
      await load();
      if (onChanged) onChanged();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <section className="grid gap-3" aria-label="Pay lines">
    <header>
      <h3 className="m-0 text-ui-body font-medium">Pay lines</h3>
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">
        A review bonus, a commission, a health allowance or the HSA money Waves pays in. The next pay run that reaches the week pays it.
        The bonus, commission and allowance are taxable wages. The HSA money is not wages. All four count toward overtime pay.
        For pay that covers several weeks, give the dates it covers.
      </p>
    </header>
    {message && <p role="status" className="m-0 text-ui-caption text-zinc-900">{message}</p>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    <Card className="p-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3 sm:items-end" aria-label="Add pay line">
        <Field label="Employee" required>
          <Select value={form.technicianId} onChange={set('technicianId')}>
            <option value="">Pick an employee</option>
            {technicians.map(tech => <option key={tech.id} value={tech.id}>
              {tech.employmentStatus === 'inactive' ? `${tech.name} (former employee)` : tech.name}
            </option>)}
          </Select>
        </Field>
        <Field label="Kind" required>
          <Select value={form.kind} onChange={set('kind')}>
            {KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </Select>
        </Field>
        <Field label="Amount ($)" required help="Dollars, at most 2 decimals.">
          <Input inputMode="decimal" autoComplete="off" placeholder="30.00" value={form.amount} onChange={set('amount')} />
        </Field>
        <Field label="Earned in the week of" required help="The pay run for this week or a later one pays it.">
          <Select value={earned} onChange={set('earnedWeekStart')}>
            {weeks.map(start => <option key={start} value={start}>{weekLabel(start)}</option>)}
          </Select>
        </Field>
        <Field label="Covers from" help="Only for pay that covers several weeks.">
          <Input type="date" value={form.coversFrom} onChange={set('coversFrom')} />
        </Field>
        <Field label="Covers to">
          <Input type="date" min={form.coversFrom || undefined} value={form.coversTo} onChange={set('coversTo')} />
        </Field>
        <Field label="Note" className="sm:col-span-2">
          <Input maxLength={500} autoComplete="off" value={form.note} onChange={set('note')} />
        </Field>
        <div><Button type="submit" disabled={busy || !ready}>Add pay line</Button></div>
      </form>
    </Card>

    {open.length === 0 && <p className="m-0">No pay lines waiting for a pay run.</p>}
    {open.length > 0 && <div className="grid gap-1">
      <h4 className="m-0 text-ui-body font-medium">Waiting for a pay run</h4>
      <LinesTable title="Pay lines waiting" lines={open} busy={busy} onRemove={remove} />
    </div>}
    {paid.length > 0 && <div className="grid gap-1">
      <h4 className="m-0 text-ui-body font-medium">Paid</h4>
      <LinesTable title="Pay lines paid" lines={paid} busy={busy} />
    </div>}
  </section>;
}
