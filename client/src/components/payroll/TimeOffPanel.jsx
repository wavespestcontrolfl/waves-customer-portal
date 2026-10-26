import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { etDateString } from '../../lib/timezone';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';
import { dayLabel } from './payrollFormat';

// Pay runs section, "Time off" (owner ruling 2026-10-26, dark behind
// GATE_PAYROLL_TIME_OFF). Paid time off and holidays are hours not worked, paid
// at the straight rate on the pay run for that week. The allowance only warns.
// With the gate off the server answers 404 and this panel renders nothing.

const KINDS = [{ value: 'pto', label: 'Paid time off' }, { value: 'holiday', label: 'Holiday' }];
const kindWord = kind => (KINDS.find(k => k.value === kind) || { label: kind }).label;
const MAX_RANGE_DAYS = 400;
const UPCOMING_DAYS = 120;

// '20.00' -> '20', '7.75' -> '7.75'
const plainHours = value => String(Number(value));

const blankForm = () => ({ technicianId: '', workDate: '', kind: 'pto', hours: '', note: '' });

function yearLine(balance, year) {
  const booked = plainHours(balance.ptoHoursBooked);
  if (balance.allowanceHours == null) return `Paid time off booked in ${year}: ${booked} hours`;
  return `Paid time off booked in ${year}: ${booked} of ${plainHours(balance.allowanceHours)} hours`;
}

const isOver = balance => balance.allowanceHours != null && Number(balance.ptoHoursBooked) > Number(balance.allowanceHours);

function EntriesTable({ title, entries, onEdit, onRemove, busy }) {
  if (!entries.length) return null;
  return <Table aria-label={title}>
    <THead><TR>
      <TH>Date</TH><TH>Employee</TH><TH>Kind</TH><TH align="right">Hours</TH><TH>Note</TH><TH><span className="sr-only">Actions</span></TH>
    </TR></THead>
    <TBody>
      {entries.map(entry => <TR key={entry.id}>
        <TD>{dayLabel(entry.workDate)}</TD>
        <TD>{entry.name}</TD>
        <TD>{kindWord(entry.kind)}</TD>
        <TD nums align="right">{entry.hours}</TD>
        <TD>{entry.note || ''}</TD>
        <TD>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onEdit(entry)} aria-label={`Edit time off for ${entry.name} on ${dayLabel(entry.workDate)}`}>Edit</Button>
            <Button variant="secondary" disabled={busy} onClick={() => onRemove(entry)} aria-label={`Remove time off for ${entry.name} on ${dayLabel(entry.workDate)}`}>Remove</Button>
          </div>
        </TD>
      </TR>)}
    </TBody>
  </Table>;
}

export default function TimeOffPanel({ call, weekStart, onChanged }) {
  // null until the first answer; false when the server says the gate is off.
  const [enabled, setEnabled] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [entries, setEntries] = useState([]);
  const [balances, setBalances] = useState([]);
  const [form, setForm] = useState(blankForm);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [warning, setWarning] = useState('');

  const weekEnd = addStaffCalendarDays(weekStart, 6);
  const year = weekStart.slice(0, 4);

  const load = useCallback(async () => {
    const today = etDateString(new Date());
    const upcoming = addStaffCalendarDays(today, UPCOMING_DAYS);
    const wanted = upcoming > weekEnd ? upcoming : weekEnd;
    const limit = addStaffCalendarDays(weekStart, MAX_RANGE_DAYS);
    const to = wanted < limit ? wanted : limit;
    try {
      const list = await call(`/time-off?from=${weekStart}&to=${to}`);
      setEnabled(true);
      setEntries(list.entries || []);
      setError('');
      const techs = (await call('/technicians')).technicians || [];
      setTechnicians(techs);
      const found = await Promise.all(techs.map(async tech => {
        const data = await call(`/time-off/balance?technicianId=${tech.id}&year=${year}`);
        return { name: tech.name, balance: data.balance };
      }));
      setBalances(found);
    } catch (failure) {
      if (failure.status === 404) { setEnabled(false); return; }
      setEnabled(prev => (prev === null ? true : prev));
      setError(failure.message);
    }
  }, [call, weekStart, weekEnd, year]);
  useEffect(() => { load(); }, [load]);

  if (enabled !== true) return null;

  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
  const reset = () => { setForm(blankForm()); setEditing(null); };

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage(''); setWarning('');
    try {
      const body = { kind: form.kind, hours: form.hours.trim(), note: form.note.trim() };
      const data = editing
        ? await call(`/time-off/${editing}`, { method: 'PUT', body })
        : await call('/time-off', { method: 'POST', body: { technicianId: form.technicianId, workDate: form.workDate, ...body } });
      setMessage(editing ? 'Time off changed.' : 'Time off saved.');
      if (data.warning) setWarning(data.warning);
      reset();
      await load();
      if (onChanged) onChanged();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  async function remove(entry) {
    setBusy(true); setError(''); setMessage(''); setWarning('');
    try {
      await call(`/time-off/${entry.id}`, { method: 'DELETE' });
      setMessage('Time off removed.');
      if (editing === entry.id) reset();
      await load();
      if (onChanged) onChanged();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  function edit(entry) {
    setMessage(''); setWarning(''); setError('');
    setEditing(entry.id);
    setForm({ technicianId: entry.technicianId, workDate: entry.workDate, kind: entry.kind, hours: plainHours(entry.hours), note: entry.note || '' });
  }

  const inWeek = entries.filter(entry => entry.workDate >= weekStart && entry.workDate <= weekEnd);
  const later = entries.filter(entry => entry.workDate > weekEnd);
  const ready = (editing || (form.technicianId && form.workDate)) && form.hours.trim();

  return <section className="grid gap-3" aria-label="Time off">
    <header>
      <h3 className="m-0 text-ui-body font-medium">Time off</h3>
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">
        Paid time off and holidays are hours not worked. The pay run for that week pays them at the regular rate. They never count toward overtime.
        Once a week's pay run is final, void it before you change a day.
      </p>
    </header>
    {message && <p role="status" className="m-0 text-ui-caption text-zinc-900">{message}</p>}
    {warning && <p role="status" className="m-0 text-ui-caption text-warn-fg">{warning}</p>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    <Card className="p-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3 sm:items-end" aria-label={editing ? 'Change time off' : 'Add time off'}>
        <Field label="Employee" required>
          <Select value={form.technicianId} onChange={set('technicianId')} disabled={Boolean(editing)}>
            <option value="">Pick an employee</option>
            {technicians.map(tech => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </Select>
        </Field>
        <Field label="Date" required>
          <Input type="date" value={form.workDate} onChange={set('workDate')} disabled={Boolean(editing)} />
        </Field>
        <Field label="Kind" required>
          <Select value={form.kind} onChange={set('kind')}>
            {KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </Select>
        </Field>
        <Field label="Hours" required help="Up to 24, with at most 2 decimals.">
          <Input inputMode="decimal" autoComplete="off" placeholder="8" value={form.hours} onChange={set('hours')} />
        </Field>
        <Field label="Note">
          <Input maxLength={500} autoComplete="off" value={form.note} onChange={set('note')} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !ready}>{editing ? 'Save changes' : 'Add time off'}</Button>
          {editing && <Button type="button" variant="secondary" disabled={busy} onClick={reset}>Cancel</Button>}
        </div>
      </form>
    </Card>

    {entries.length === 0 && <p className="m-0">No time off recorded for this week or later.</p>}
    {inWeek.length > 0 && <div className="grid gap-1">
      <h4 className="m-0 text-ui-body font-medium">This pay run&apos;s week</h4>
      <EntriesTable title="Time off this week" entries={inWeek} busy={busy} onEdit={edit} onRemove={remove} />
    </div>}
    {later.length > 0 && <div className="grid gap-1">
      <h4 className="m-0 text-ui-body font-medium">Upcoming</h4>
      <EntriesTable title="Upcoming time off" entries={later} busy={busy} onEdit={edit} onRemove={remove} />
    </div>}

    {balances.length > 0 && <ul className="m-0 grid list-none gap-1 p-0" aria-label={`Paid time off in ${year}`}>
      {balances.map(({ name, balance }) => <li key={balance.technicianId} className="text-ui-caption">
        <strong>{name}</strong>: {yearLine(balance, year)}
        {balance.holidayDaysBooked > 0 && `. Holidays booked: ${balance.holidayDaysBooked}`}
        {isOver(balance) && <span className="text-warn-fg"> Over the yearly allowance by {plainHours(Math.round((Number(balance.ptoHoursBooked) - Number(balance.allowanceHours)) * 100) / 100)} hours.</span>}
      </li>)}
    </ul>}
  </section>;
}
