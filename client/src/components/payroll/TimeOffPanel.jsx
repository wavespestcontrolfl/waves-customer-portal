import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Checkbox } from '../ui/Checkbox';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { etDateString } from '../../lib/timezone';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';
import { dayLabel } from './payrollFormat';

// Pay runs section, "Time off" (owner ruling 2026-10-26, dark behind
// GATE_PAYROLL_TIME_OFF). Paid time off and holidays are hours not worked, paid
// at the straight rate on the pay run for that week. An employee whose yearly hours
// are set has a time-off bank (owner 2026-11-21): the pay run pays paid time off only
// from the bank, and this panel shows the bank. A day is never refused here.
// "Pay out the bank" is the owner's decision when an employee leaves: the pay run of the
// week on screen then pays every hour the bank holds.
// With the gate off the server answers 404 and this panel renders nothing.

const KINDS = [{ value: 'pto', label: 'Paid time off' }, { value: 'holiday', label: 'Holiday' }];
const kindWord = kind => (KINDS.find(k => k.value === kind) || { label: kind }).label;
const MAX_RANGE_DAYS = 400;
const UPCOMING_DAYS = 120;

// '20.00' -> '20', '7.75' -> '7.75'
const plainHours = value => String(Number(value));

const blankForm = () => ({ technicianId: '', workDate: '', kind: 'pto', hours: '', note: '', illness: false });

// The time-off bank of an employee who has one: what it holds today, what waits for a pay run, and the rules.
function bankLine(bank, today) {
  const parts = [`Time-off bank: ${plainHours(bank.balanceHours)} hours`];
  if (Number(bank.waitingHours) > 0) parts.push(`Waiting for a pay run: ${plainHours(bank.waitingHours)} hours`);
  parts.push(`Earns ${bank.fullWeekHours} hours for a full week, up to ${bank.capHours} hours`);
  if (!bank.usableFrom) parts.push('No hire date on file');
  else if (bank.usableFrom > today) parts.push(`Until ${dayLabel(bank.usableFrom)} the bank pays illness days only`);
  return parts.join('. ');
}

const isShort = bank => Number(bank.waitingHours) > Math.max(0, Number(bank.balanceHours));

// An employee who has left (inactive) stays on the bank list while they have a yearly-hours setting: the server
// sends only those (?formerBank=1). An empty bank is no reason to hide them: a last check can still earn hours,
// also for one who was paid out before, came back and left again.
const isFormer = tech => tech.employmentStatus === 'inactive';
// What a line shows of a payout, as the server names it: the page sends it back with each change.
function payoutStateOf(payout) {
  if (!payout) return 'none';
  if (payout.final) return 'paid';
  return payout.missed ? 'missed' : 'set';
}

// "Pay out the bank" (handbook, "When you leave"; the owner account only). `payout` is the standing instruction:
// { weekStart, final, hours, missed }, or nothing. Nothing is paid before that week's pay run is final. Once that
// run is final and kept the payout (`final`, with the hours it paid out), the payout is decided: only a void of
// that run changes it, and the button is for another week (the employee leaves a second time). `missed`: that
// week's pay run is final and did not pay the bank out, so no run will until the owner acts.
function BankPayout({ name, payout, weekStart, busy, onSet }) {
  const week = payout ? dayLabel(payout.weekStart) : '';
  const takeBack = <Button variant="secondary" size="sm" disabled={busy} onClick={() => onSet(null)} aria-label={`Do not pay out the bank of ${name}`}>Do not pay out</Button>;
  if (payout && payout.missed) {
    return <span className="inline-flex flex-wrap items-center gap-2 text-warn-fg">
      Bank payout: set for the week of {week}, but that pay run is final and did not pay the bank out. Void that pay run and make it again, or press &quot;Do not pay out&quot; and pick another week.
      {takeBack}
    </span>;
  }
  if (payout && !payout.final) {
    return <span className="inline-flex flex-wrap items-center gap-2">
      Bank payout: on the pay run for the week of {week}.
      {takeBack}
    </span>;
  }
  if (payout && payout.weekStart === weekStart) return <span>Bank payout: {payout.hours} h on the pay run for the week of {week}, which is final.</span>;
  return <Button
    variant="secondary" size="sm" disabled={busy} onClick={() => onSet(weekStart)}
    aria-label={`Pay out the bank of ${name} in the week of ${dayLabel(weekStart)}`}
  >Pay out the bank in the week of {dayLabel(weekStart)}</Button>;
}

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
        <TD>{kindWord(entry.kind)}{entry.illness ? ' (illness)' : ''}</TD>
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

export default function TimeOffPanel({ call, weekStart, refreshKey, onChanged }) {
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

  // Only the newest load may write. A finalize, a void or a settings save starts a new load while an older
  // one can still wait for its answers; an old answer that arrives last must not put the old banks back.
  const newestLoad = useRef(0);
  const load = useCallback(async () => {
    newestLoad.current += 1;
    const mine = newestLoad.current;
    const superseded = () => mine !== newestLoad.current;
    const today = etDateString(new Date());
    const upcoming = addStaffCalendarDays(today, UPCOMING_DAYS);
    const wanted = upcoming > weekEnd ? upcoming : weekEnd;
    const limit = addStaffCalendarDays(weekStart, MAX_RANGE_DAYS);
    const to = wanted < limit ? wanted : limit;
    try {
      const list = await call(`/time-off?from=${weekStart}&to=${to}`);
      if (superseded()) return;
      setEnabled(true);
      setEntries(list.entries || []);
      setError('');
      // With the employees who have left and still have a bank setting: the owner pays that bank out here.
      const techs = (await call('/technicians?formerBank=1')).technicians || [];
      if (superseded()) return;
      // Time off is recorded for the employees of today only.
      setTechnicians(techs.filter(tech => !isFormer(tech)));
      const found = await Promise.all(techs.map(async tech => {
        const data = await call(`/time-off/balance?technicianId=${tech.id}&year=${year}`);
        return { name: tech.name, former: isFormer(tech), balance: data.balance };
      }));
      if (superseded()) return;
      setBalances(found);
    } catch (failure) {
      if (superseded()) return;
      if (failure.status === 404) { setEnabled(false); return; }
      // Fail closed: only a successful gated answer opens the panel. Any other
      // failure keeps it as it was (hidden until the first good load).
      setError(failure.message);
    }
  }, [call, weekStart, weekEnd, year]);
  // refreshKey changes when the open pay run is finalized or voided, or a yearly-hours setting is saved: each
  // changes a time-off bank and the hours waiting for a pay run.
  useEffect(() => { load(); }, [load, refreshKey]);
  // A save or a removal can end after the week on screen changed. It must reload that week, not the week
  // it started in: the old load would be the newest one, and it would put the old week's days back.
  const latestLoad = useRef(load);
  useEffect(() => { latestLoad.current = load; }, [load]);

  if (enabled !== true) return null;

  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }));
  const reset = () => { setForm(blankForm()); setEditing(null); };

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage(''); setWarning('');
    try {
      const body = { kind: form.kind, hours: form.hours.trim(), note: form.note.trim(), illness: form.kind === 'pto' && form.illness };
      const data = editing
        ? await call(`/time-off/${editing}`, { method: 'PUT', body })
        : await call('/time-off', { method: 'POST', body: { technicianId: form.technicianId, workDate: form.workDate, ...body } });
      setMessage(editing ? 'Time off changed.' : 'Time off saved.');
      if (data.warning) setWarning(data.warning);
      reset();
      await latestLoad.current();
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
      await latestLoad.current();
      if (onChanged) onChanged();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  // The pay run of `week` pays out the employee's bank; no week takes that back. The open draft is then out
  // of date: onChanged reads it again, and it asks for a Recompute. `shown` = the payout on this line when the
  // button was pressed: the server refuses the change when the payout is another one now, or in another state
  // (changed in another tab, or its pay run was made final or voided).
  async function setPayout(technicianId, name, week, shown) {
    setBusy(true); setError(''); setMessage(''); setWarning('');
    try {
      await call(`/technicians/${technicianId}/pto-payout-week`, { method: 'PUT', body: { weekStart: week, shownWeekStart: shown ? shown.weekStart : null, shownState: payoutStateOf(shown) } });
      setMessage(week
        ? `The pay run for the week of ${dayLabel(week)} pays out the time-off bank of ${name}. Nothing is paid until that pay run is final.`
        : `The time-off bank of ${name} is not paid out.`);
      await latestLoad.current();
      if (onChanged) onChanged();
    } catch (failure) {
      // A refusal can mean the payout changed elsewhere: the line shows what the server holds now, then its words.
      // The open draft is read again too: it was worked out from the payout this page showed, not from that one.
      await latestLoad.current();
      if (onChanged) onChanged();
      setError(failure.message);
    }
    setBusy(false);
  }

  function edit(entry) {
    setMessage(''); setWarning(''); setError('');
    setEditing(entry.id);
    setForm({ technicianId: entry.technicianId, workDate: entry.workDate, kind: entry.kind, hours: plainHours(entry.hours), note: entry.note || '', illness: entry.illness === true });
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
        For an employee with a time-off bank, the pay run pays paid time off only from the bank. Hours past the bank are unpaid.
        When an employee leaves and Waves owes the unused hours, press &quot;Pay out the bank&quot;: the pay run for that week pays every hour the bank holds.
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
        {form.kind === 'pto' && <Checkbox
          id="time-off-illness" label="Illness" checked={form.illness}
          onChange={event => setForm(prev => ({ ...prev, illness: event.target.checked }))}
        />}
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
      {balances.map(({ name, former, balance }) => <li key={balance.technicianId} className="text-ui-caption">
        <strong>{name}</strong>{former && ' (left)'}: {balance.bank
          ? bankLine(balance.bank, etDateString(new Date()))
          : `Paid time off booked in ${year}: ${plainHours(balance.ptoHoursBooked)} hours`}
        {balance.holidayDaysBooked > 0 && `. Holidays booked: ${balance.holidayDaysBooked}`}
        {balance.bank && isShort(balance.bank) && <span className="text-warn-fg"> The bank does not hold all the waiting hours today. A pay run pays only the hours the bank holds then.</span>}
        {balance.bank && <>{' '}<BankPayout
          name={name} payout={balance.bank.payout} weekStart={weekStart} busy={busy}
          onSet={week => setPayout(balance.technicianId, name, week, balance.bank.payout)}
        /></>}
      </li>)}
    </ul>}
  </section>;
}
