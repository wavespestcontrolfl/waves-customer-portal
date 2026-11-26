import { useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { etDateString, formatETTime } from '../../lib/timezone';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';
import { centsToDollars, dayLabel, lastFinishedWeekStart } from './payrollFormat';
import { dollarsToCents } from './PayLinesPanel';

// Production share, preview (Technician Terms v3, owner 2026-11-23): the weekly CREDIT and the numbers it is computed
// with. The preview itself pays nothing. When GATE_PAYROLL_PRODUCTION_SHARE is on, a pay run pays the share from these
// numbers (PR 2); refunds are the owner's call (PR 3a): a refund_flagged stop shows its reason and the stop credit box, and a refund on
// a paid stop is answered with the total to take back; the page is not told the gate state, so its words are neutral. The owner account saves the
// numbers; the preview shows each completed stop's credit, the shifts, the bar and the share the week would give.

const KIND_WORDS = {
  priced: 'Priced visit', prepaid_plan: 'Prepaid plan visit', multi_visit_job: 'Part of a multi-visit job',
  callback_own: 'Callback, own work', callback_other: "Callback, another technician's work", callback_review: 'Callback',
  free_assessment: 'Free assessment', free_visit: 'Free visit', unpriced: 'No price',
  not_performed: 'No work performed', unverified: 'No closeout record', refund_flagged: 'Refund recorded',
  owner_set: 'Set by the owner', already_paid: 'Already paid', invoice_paid_elsewhere: 'Invoice paid elsewhere',
  package_paid_elsewhere: 'Package paid elsewhere', basis_exhausted: 'Package visit used', owner_override_reassigned: 'Reassigned since you set it', owner_override_closeout_changed: 'Closeout changed since you set it', owner_override_conflict_changed: 'Paid elsewhere since you set it', owner_override_refund_changed: 'New refund since you set it',
};

// '15' -> 1500, '12.5' -> 1250. Anything else -> null.
export function percentToBps(text) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text || '').trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
}
const bpsToPercent = bps => String(Number(bps) / 100);
const centsToPlain = cents => (Number(cents) / 100).toFixed(2);

function SettingsForm({ call, technicians, technicianId, weekStart, current, generation, onSaved }) {
  const [scope, setScope] = useState('technician');
  const [rate, setRate] = useState(current ? bpsToPercent(current.rateBps) : '');
  const [barType, setBarType] = useState(current ? current.barType : 'per_shift');
  const [bar, setBar] = useState(current ? centsToPlain(current.barCents) : '');
  const [callbackValue, setCallbackValue] = useState(current ? centsToPlain(current.callbackStopValueCents) : '');
  const [fromWeek, setFromWeek] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const rateBps = percentToBps(rate);
  const barCents = dollarsToCents(bar);
  const callbackCents = dollarsToCents(callbackValue);
  const ready = rateBps != null && rateBps <= 10000 && barCents != null && callbackCents != null;
  const who = (technicians || []).find(tech => tech.id === technicianId);

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    // The selection this save was started under: the answer is refreshed only if the selection is still the same after the save.
    const startedUnder = generation();
    try {
      await call('/production-share/settings', {
        method: 'PUT',
        body: {
          technicianId: scope === 'default' ? null : technicianId,
          ...(fromWeek ? { fromWeek } : {}),
          rateBps, barType, barCents, callbackStopValueCents: callbackCents,
        },
      });
      setMessage('Saved. A pay run uses these numbers for the weeks they apply to, when the production share is turned on for pay runs.');
      onSaved(startedUnder);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <form onSubmit={save} className="grid gap-3" aria-label="Production share numbers">
    <h3 className="m-0 text-ui-body font-medium text-zinc-900">Numbers</h3>
    <p className="m-0 text-ui-caption text-ink-secondary">
      {current
        ? `In force for the week of ${dayLabel(weekStart)}: from the week of ${dayLabel(current.fromWeek)}${current.technicianId ? ', for this employee' : ', for everyone'}.`
        : `No numbers are set for the week of ${dayLabel(weekStart)}, so the share is $0.`}
    </p>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Applies to">
        <Select value={scope} onChange={event => setScope(event.target.value)}>
          <option value="technician">{who ? who.name : 'This employee'} only</option>
          <option value="default">Everyone (the default)</option>
        </Select>
      </Field>
      <Field label="Share of the amount above the bar (%)">
        <Input inputMode="decimal" autoComplete="off" value={rate} onChange={event => setRate(event.target.value)} />
      </Field>
      <Field label="The bar is">
        <Select value={barType} onChange={event => setBarType(event.target.value)}>
          <option value="per_shift">An amount for each shift worked</option>
          <option value="weekly">One amount for the week</option>
        </Select>
      </Field>
      <Field label={barType === 'per_shift' ? 'Bar for each shift ($)' : 'Bar for the week ($)'}>
        <Input inputMode="decimal" autoComplete="off" value={bar} onChange={event => setBar(event.target.value)} />
      </Field>
      <Field label="Average value of one stop, for a callback on another employee's work ($)">
        <Input inputMode="decimal" autoComplete="off" value={callbackValue} onChange={event => setCallbackValue(event.target.value)} />
      </Field>
      <Field label="From the week of (a Monday, empty = this week)">
        <Input type="date" value={fromWeek} onChange={event => setFromWeek(event.target.value)} />
      </Field>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={busy || !ready}>Save numbers</Button>
      {message && <span role="status" className="text-ui-caption text-zinc-900">{message}</span>}
      {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
    </div>
  </form>;
}

// The owner sets the credit of a stop the rules cannot credit, with a reason; a pay run uses it for that stop in that week. A paid week refuses.
// A stop whose work was not done or confirmed, or that a pay run paid, is never credited by hand (the server refuses it too).
const NOT_BY_HAND = new Set(['already_paid', 'not_performed', 'unverified']);
// A credit the owner set, or one the rules ignore now (the stop was reassigned, or its closeout changed): the owner can clear it.
const CLEARABLE = new Set(['owner_set', 'owner_override_reassigned', 'owner_override_closeout_changed', 'owner_override_conflict_changed', 'owner_override_refund_changed']);

// Which visit a review row is: a short id, the time it was completed, its address, and the schedule of the day it was SCHEDULED for
// (not the pay work date, which can differ) to open it from.
function VisitReference({ stop }) {
  const parts = [`Visit ${String(stop.visitId || '').slice(0, 8)}`];
  if (stop.completedAt) parts.push(formatETTime(stop.completedAt));
  if (stop.address) parts.push(stop.address);
  return <p className="m-0 mt-1 text-ui-caption text-ink-secondary" aria-label="Visit reference">
    {parts.join(' · ')}
    {stop.scheduledDate && <> · <a className="underline" href={`/admin/schedule?date=${encodeURIComponent(stop.scheduledDate)}`} target="_blank" rel="noreferrer">Open the day</a></>}
  </p>;
}

function StopCreditForm({ call, technicianId, weekStart, stop, generation, onChanged }) {
  const [credit, setCredit] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = dollarsToCents(credit);
  const body = { technicianId, visitId: stop.visitId, weekStart };
  // A clear names the credit the page is showing: the server refuses it when that credit changed meanwhile.
  const clearBody = { ...body, revision: stop.overrideRevision };

  async function run(method, payload) {
    setBusy(true); setError('');
    // The selection this change was started under: the week is reloaded only if the selection is still the same after it.
    const startedUnder = generation();
    try {
      await call('/production-share/stop-override', { method, body: payload });
      onChanged(startedUnder);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }
  if (CLEARABLE.has(stop.kind)) {
    return <>
      <VisitReference stop={stop} />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => run('DELETE', clearBody)}>
          {stop.kind === 'owner_set' ? 'Clear the credit I set' : 'Clear the old credit'}
        </Button>
        {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
      </div>
    </>;
  }
  if (!stop.needsReview) return null;
  // A stop that cannot be credited by hand says what to do instead.
  if (NOT_BY_HAND.has(stop.kind)) {
    const week = /week of (\d{4}-\d{2}-\d{2})/.exec(stop.reason || '');
    const words = stop.kind === 'already_paid'
      ? `Already paid in the week of ${week ? dayLabel(week[1]) : 'an earlier pay run'}. Its credit cannot change here.`
      : 'Fix the closeout first: this stop has no confirmed closeout. Reload the week once it is done.';
    return <>
      <VisitReference stop={stop} />
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">{words}</p>
    </>;
  }
  return <>
    <VisitReference stop={stop} />
    <form className="mt-1 flex flex-wrap items-end gap-2" aria-label="Set the credit of this stop"
      onSubmit={event => { event.preventDefault(); run('PUT', { ...body, creditCents: cents, reason: reason.trim(), stopRevision: stop.stopRevision || '' }); }}>
      <Field label="Credit ($)">
        <Input inputMode="decimal" autoComplete="off" value={credit} onChange={event => setCredit(event.target.value)} />
      </Field>
      <Field label="Reason">
        <Input autoComplete="off" value={reason} onChange={event => setReason(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" disabled={busy || cents == null || !reason.trim()}>Set credit</Button>
      {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
    </form>
  </>;
}

// A refund on a stop a pay run already paid: the owner sets the TOTAL credit to take back for it (the code never works a refund out).
// A paid stop with a new refund is listed with an empty box; a stop he answered keeps its row, with his total, so he can change or clear it.
// Which paid visit a take-back row is: a short id, its service, window and completion time, and a link to the day it was scheduled for (the
// schedule link the stop review rows use). A visit that is gone shows its id only.
function PaidVisitReference({ row }) {
  const visit = row.visit || {};
  const parts = [`Visit ${String(row.visitId || '').slice(0, 8)}`];
  if (visit.serviceType) parts.push(visit.serviceType);
  if (visit.windowDisplay) parts.push(visit.windowDisplay);
  if (visit.completedAt) parts.push(`done ${formatETTime(visit.completedAt)}`);
  return <p className="m-0 mt-1 text-ui-caption text-ink-secondary" aria-label="Visit reference">
    {parts.join(' · ')}
    {visit.scheduledDate && <> · <a className="underline" href={`/admin/schedule?date=${encodeURIComponent(visit.scheduledDate)}`} target="_blank" rel="noreferrer">Open the day</a></>}
  </p>;
}

function RefundTakeBackRow({ call, row, generation, onChanged }) {
  // A stop that needs an answer starts empty: the owner saves a new total against the refunds now.
  const [text, setText] = useState(row.cents == null || row.isNew ? '' : centsToPlain(row.cents));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = dollarsToCents(text);
  const tooMuch = cents != null && cents > row.creditCents;

  async function run(method, body) {
    setBusy(true); setError('');
    // The selection this change was started under: the week is reloaded only if the selection is still the same after it.
    const startedUnder = generation();
    try {
      await call('/production-share/refund-take-back', { method, body });
      onChanged(startedUnder);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }
  return <TR>
    <TD>
      {dayLabel(row.workDate)}
      <PaidVisitReference row={row} />
    </TD>
    <TD>{dayLabel(row.paidWeekStart)}</TD>
    <TD nums align="right">{centsToDollars(row.creditCents)}</TD>
    <TD>
      {row.isNew ? <span className="text-warn-fg">{row.reason === 'changed' ? 'A refund you answered changed' : 'New refund'}</span> : 'Answered'}
      {row.isNew && row.previousCents != null && <p className="m-0 text-ui-caption text-ink-secondary">
        Previous total {centsToDollars(row.previousCents)}. Nothing more is taken from this stop until you save a new total.
      </p>}
    </TD>
    <TD>
      <form className="flex flex-wrap items-end gap-2" aria-label="Set the refund take-back of this paid stop"
        onSubmit={event => { event.preventDefault(); run('PUT', { checkId: row.checkId, visitId: row.visitId, cents, signalRevision: row.signalRevision, answerRevision: row.answerRevision || 'none' }); }}>
        <Field label="Take back ($, up to the credit paid)">
          <Input inputMode="decimal" autoComplete="off" value={text} onChange={event => setText(event.target.value)} />
        </Field>
        <Button type="submit" variant="secondary" disabled={busy || cents == null || tooMuch}>Save</Button>
        {row.cents != null && <Button type="button" variant="secondary" disabled={busy} onClick={() => run('DELETE', { checkId: row.checkId, visitId: row.visitId, signalRevision: row.signalRevision, answerRevision: row.answerRevision || 'none' })}>Clear</Button>}
        {tooMuch && <span role="alert" className="text-ui-caption text-alert-fg">More than the {centsToDollars(row.creditCents)} paid.</span>}
        {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
      </form>
    </TD>
  </TR>;
}

function RefundTakeBacks({ call, preview, generation, onChanged }) {
  const rows = new Map();
  for (const one of preview.takeBackAnswers || []) rows.set(`${one.checkId}:${one.visitId}`, { ...one, isNew: false });
  for (const one of preview.takeBackToSet || []) rows.set(`${one.checkId}:${one.visitId}`, { ...(rows.get(`${one.checkId}:${one.visitId}`) || {}), ...one, isNew: true });
  const applied = (preview.takeBacks || []).filter(one => one.cents !== 0);
  if (!rows.size && !applied.length) return null;
  return <div className="grid gap-2" aria-label="Refunds on paid stops">
    <h3 className="m-0 text-ui-body font-medium text-zinc-900">Refunds on paid stops</h3>
    {rows.size > 0 && <Table aria-label="Paid stops with a refund">
      <THead><TR><TH>Visit day</TH><TH>Paid in week of</TH><TH align="right">Credit paid</TH><TH>State</TH><TH>Take-back</TH></TR></THead>
      <TBody>
        {[...rows.values()].map(row => <RefundTakeBackRow key={`${row.checkId}:${row.visitId}:${row.answerRevision}:${(row.newSignals || []).join(',')}`}
          call={call} row={row} generation={generation} onChanged={onChanged} />)}
      </TBody>
    </Table>}
    {applied.map(one => <p key={`${one.sourceCheckId}:${one.visitId}`} className="m-0 text-ui-caption text-ink-secondary">
      {one.cents > 0
        ? `Refund taken back from a paid week: ${centsToDollars(one.cents)} (visit of ${dayLabel(one.workDate || one.paidWeekStart)})`
        : `Refund given back to a paid week: ${centsToDollars(-one.cents)} (visit of ${dayLabel(one.workDate || one.paidWeekStart)})`}
    </p>)}
    {preview.outstandingTakeBackCents > 0 && <p className="m-0 text-ui-caption text-ink-secondary">
      Still owed and not yet taken: {centsToDollars(preview.outstandingTakeBackCents)}. It comes off the next share week. A take-back is never taken from wages.
    </p>}
  </div>;
}

function PreviewNotes({ preview }) {
  return <>
        {!preview.configured && <p className="m-0 text-ui-caption text-ink-secondary">No numbers are set for this week, so the share shows $0.</p>}
        {preview.refundCents > 0 && <p className="m-0 text-ui-caption text-ink-secondary">
          Refunds recorded on these stops total {centsToDollars(preview.refundCents)}. A stop with a refund shows $0 until you set its credit.
        </p>}
        {preview.unallocatedRefundCents > 0 && <p role="status" className="m-0 text-ui-caption text-warn-fg">
          Refunds of {centsToDollars(preview.unallocatedRefundCents)} are on shared invoices that cannot be split across their visits. They are not in any stop above.
        </p>}
        {preview.needsReview.length > 0 && <p role="status" className="m-0 text-ui-caption text-warn-fg">
          {preview.needsReview.length} stop{preview.needsReview.length === 1 ? '' : 's'} need review. Each shows $0 until you set its credit below, so pay is never guessed.
        </p>}
  </>;
}

export default function ProductionSharePanel({ call, technicians }) {
  const [open, setOpen] = useState(false);
  const [technicianId, setTechnicianId] = useState('');
  const [weekStart, setWeekStart] = useState(() => lastFinishedWeekStart(etDateString(new Date())));
  const [loaded, setLoaded] = useState(null);
  // Only the newest request may write, and a change of employee or week drops the answer on screen and any request on its way.
  const newest = useRef(0);
  // Counts only changes of the employee or week. A save or clear reloads the week whenever the selection is unchanged, however many
  // requests started or finished meanwhile (newest orders the requests; it is not the selection).
  const selection = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function load(id = technicianId, week = weekStart) {
    if (!id || !week) return;
    newest.current += 1;
    const mine = newest.current;
    setBusy(true); setError('');
    try {
      const answer = await call(`/production-share/preview?technicianId=${encodeURIComponent(id)}&weekStart=${encodeURIComponent(week)}`);
      if (mine === newest.current) setLoaded(answer);
    } catch (failure) {
      if (mine === newest.current) { setLoaded(null); setError(failure.message); }
    }
    if (mine === newest.current) setBusy(false);
  }

  // Any change of the selection starts over: nothing shown or saved belongs to a different employee or week.
  function select(change) {
    newest.current += 1;
    selection.current += 1;
    setLoaded(null); setError(''); setBusy(false);
    if (change.technicianId !== undefined) setTechnicianId(change.technicianId);
    if (change.weekStart !== undefined) setWeekStart(change.weekStart);
  }
  // The answer is shown, and its settings form saves, only for the employee and week it was loaded for.
  const preview = loaded && loaded.technician.id === technicianId && loaded.weekStart === weekStart ? loaded : null;

  const options = (technicians || []).filter(tech => !tech.notW2);
  return <Card>
    <div className="grid gap-4 p-4">
      <header>
        <h2 className="m-0 text-18 font-medium text-zinc-900">Production share preview</h2>
        <p className="m-0 mt-1 text-ui-caption text-ink-secondary">
          This is an estimate: the credit each employee earned in a pay week and the share it would give. The preview pays nothing. When the production share is turned on for pay runs, a pay run pays the share from these numbers.
        </p>
      </header>
      {!open && <div><Button variant="secondary" onClick={() => setOpen(true)}>Open the production share preview</Button></div>}
      {open && <>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); load(); }}>
        <Field label="Employee">
          <Select value={technicianId} onChange={event => select({ technicianId: event.target.value })}>
            <option value="">Choose an employee</option>
            {options.map(tech => <option key={tech.id} value={tech.id}>{tech.name}</option>)}
          </Select>
        </Field>
        <Field label="Week starting (Monday)">
          <Input type="date" value={weekStart} onChange={event => select({ weekStart: event.target.value })} />
        </Field>
        <Button type="button" variant="secondary" disabled={busy || !technicianId || !weekStart}
          onClick={() => select({ weekStart: addStaffCalendarDays(weekStart, -7) })}>Week before</Button>
        <Button type="submit" disabled={busy || !technicianId || !weekStart}>Show the week</Button>
      </form>
      {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
      {preview && <div className="grid gap-4">
        <dl className="m-0 grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Week summary">
          <div><dt className="text-ui-caption text-ink-secondary">Shifts</dt><dd className="m-0 text-zinc-900">{preview.shifts}</dd></div>
          <div><dt className="text-ui-caption text-ink-secondary">Credited production</dt><dd className="m-0 text-zinc-900">{centsToDollars(preview.creditedCents)}</dd></div>
          <div><dt className="text-ui-caption text-ink-secondary">Bar</dt><dd className="m-0 text-zinc-900">{preview.configured ? centsToDollars(preview.barCents) : 'Not set'}</dd></div>
          <div><dt className="text-ui-caption text-ink-secondary">Above the bar</dt><dd className="m-0 text-zinc-900">{centsToDollars(preview.aboveBarCents)}</dd></div>
          <div><dt className="text-ui-caption text-ink-secondary">Share (estimate)</dt><dd className="m-0 text-zinc-900">{centsToDollars(preview.shareCents)}</dd></div>
        </dl>
        <PreviewNotes preview={preview} />
        <RefundTakeBacks call={call} preview={preview} generation={() => selection.current}
          onChanged={(startedUnder) => { if (startedUnder === selection.current) load(preview.technician.id, preview.weekStart); }} />
        {preview.stops.length === 0
          ? <p className="m-0">No completed stops in this week.</p>
          : <Table aria-label="Stops and their credit">
            <THead><TR>
              <TH>Day</TH><TH>Service</TH><TH>Credit for</TH><TH align="right">Credit</TH><TH>Why</TH><TH align="right">Refunded</TH>
            </TR></THead>
            <TBody>
              {preview.stops.map(stop => <TR key={stop.visitId}>
                <TD>{dayLabel(stop.workDate)}</TD>
                <TD>{stop.serviceType}</TD>
                <TD>{KIND_WORDS[stop.kind] || stop.kind}</TD>
                <TD nums align="right">{centsToDollars(stop.creditCents)}</TD>
                <TD>
                  {stop.needsReview && <span className="text-warn-fg">Needs review: </span>}{stop.reason}
                  <StopCreditForm key={`${stop.visitId}:${stop.kind}:${stop.creditCents}:${stop.stopRevision || ''}`} call={call} technicianId={preview.technician.id}
                    weekStart={preview.weekStart} stop={stop} generation={() => selection.current}
                    onChanged={(startedUnder) => { if (startedUnder === selection.current) load(preview.technician.id, preview.weekStart); }} />
                </TD>
                <TD nums align="right">{stop.refundCents > 0 ? centsToDollars(stop.refundCents) : ''}</TD>
              </TR>)}
            </TBody>
          </Table>}
        <SettingsForm
          key={`${preview.technician.id}:${preview.weekStart}:${preview.settings ? preview.settings.id : 'none'}`}
          call={call} technicians={technicians} technicianId={preview.technician.id} weekStart={preview.weekStart}
          current={preview.settings} generation={() => selection.current}
          onSaved={(startedUnder) => { if (startedUnder === selection.current) load(preview.technician.id, preview.weekStart); }}
        />
      </div>}
      </>}
    </div>
  </Card>;
}
