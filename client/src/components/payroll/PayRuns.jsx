import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { Textarea } from '../ui/Textarea';
import { centsToDollars, dayLabel, defaultPayDate, lastFinishedWeekStart, weekLabel } from './payrollFormat';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';

// Staff page, Payroll tab, "Pay runs" (owner 2026-10-25, basic payroll layer
// 1b-2b). The portal works out each paycheck from the approved weekly hours.
// The owner pays the technician and makes every tax payment himself. Nothing
// here moves money or sends a message.

const STATUS = {
  draft: { tone: 'warn', label: 'Draft' },
  finalized: { tone: 'strong', label: 'Final' },
  voided: { tone: 'neutral', label: 'Voided' },
};
const WEEK_CHOICES = 12;

function StatusChip({ status }) {
  const known = STATUS[status] || { tone: 'neutral', label: status };
  return <Badge tone={known.tone}>{known.label}</Badge>;
}

const hoursWord = hours => `${hours} h`;

// The stub is printed from the page: only the stub shows on paper.
const PRINT_CSS = '@media print { body * { visibility: hidden !important; } .pay-stub, .pay-stub * { visibility: visible !important; } .pay-stub { position: absolute; left: 0; top: 0; width: 100%; } .pay-stub-actions { display: none !important; } }';

function StubLine({ label, value, strong = false }) {
  return <div className={`flex justify-between gap-4 py-0.5 ${strong ? 'font-medium' : ''}`}>
    <span>{label}</span><span className="tabular-nums">{value}</span>
  </div>;
}

export function StubDialog({ call, check, onClose }) {
  const [stub, setStub] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call(`/checks/${check.id}/stub`)
      .then(data => { if (live) setStub(data.stub); })
      .catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [call, check.id]);

  return <Dialog open onClose={onClose} size="lg">
    <style>{PRINT_CSS}</style>
    <DialogHeader><DialogTitle>Pay stub for {check.name}</DialogTitle></DialogHeader>
    <DialogBody>
      {error && <p role="alert" className="text-ui-caption text-alert-fg">{error}</p>}
      {!stub && !error && <p role="status">Loading…</p>}
      {stub && <div className="pay-stub grid gap-3 text-ui-body" aria-label="Pay stub">
        <div>
          <p className="m-0 font-medium">{stub.employer.name}</p>
          <p className="m-0 text-ui-caption text-ink-secondary">{stub.employer.addressLine}</p>
        </div>
        <div>
          <p className="m-0 font-medium">{stub.employee.name}</p>
          {stub.employee.ssnLast4 && <p className="m-0 text-ui-caption text-ink-secondary">SSN ending {stub.employee.ssnLast4}</p>}
          <p className="m-0 text-ui-caption text-ink-secondary">
            Pay period {dayLabel(stub.payPeriod.start)} to {dayLabel(stub.payPeriod.end)} · Pay date {dayLabel(stub.payDate)}
          </p>
        </div>
        <Table aria-label="Pay stub amounts">
          <THead><TR><TH>Item</TH><TH align="right">This pay</TH><TH align="right">Year to date</TH></TR></THead>
          <TBody>
            <TR><TD>Regular pay ({stub.hours.regular} h at {centsToDollars(Math.round(Number(stub.hourlyRate) * 100))}/h)</TD><TD nums align="right">{centsToDollars(stub.earnings.regularPayCents)}</TD><TD nums align="right" /></TR>
            <TR><TD>Overtime pay ({stub.hours.overtime} h)</TD><TD nums align="right">{centsToDollars(stub.earnings.overtimePayCents)}</TD><TD nums align="right" /></TR>
            <TR><TD><strong>Gross pay</strong></TD><TD nums align="right"><strong>{centsToDollars(stub.earnings.grossCents)}</strong></TD><TD nums align="right">{centsToDollars(stub.ytd.grossCents)}</TD></TR>
            <TR><TD>Federal income tax</TD><TD nums align="right">{centsToDollars(stub.taxes.federalIncomeTaxCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.federalIncomeTaxCents)}</TD></TR>
            <TR><TD>Social Security</TD><TD nums align="right">{centsToDollars(stub.taxes.socialSecurityCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.socialSecurityCents)}</TD></TR>
            <TR><TD>Medicare</TD><TD nums align="right">{centsToDollars(stub.taxes.medicareCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.medicareCents)}</TD></TR>
            {stub.taxes.additionalMedicareCents > 0 && <TR><TD>Additional Medicare</TD><TD nums align="right">{centsToDollars(stub.taxes.additionalMedicareCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.additionalMedicareCents)}</TD></TR>}
            <TR><TD><strong>Net pay</strong></TD><TD nums align="right"><strong>{centsToDollars(stub.netCents)}</strong></TD><TD nums align="right">{centsToDollars(stub.ytd.netCents)}</TD></TR>
          </TBody>
        </Table>
        <div>
          <StubLine label="Paid by" value={stub.payMethod === 'bank_transfer' ? 'Bank transfer' : 'Paper check'} />
          {stub.payMethod === 'check' && <StubLine label="Check number" value={stub.checkNumber || 'Not entered'} />}
        </div>
      </div>}
    </DialogBody>
    <DialogFooter>
      <div className="pay-stub-actions flex gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
        <Button type="button" disabled={!stub} onClick={() => window.print()}>Print</Button>
      </div>
    </DialogFooter>
  </Dialog>;
}

function CheckNumberCell({ call, check, onSaved }) {
  const [value, setValue] = useState(check.checkNumber || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (check.payMethod !== 'check') return <span className="text-ink-secondary">Bank transfer</span>;

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/checks/${check.id}/check-number`, { method: 'PUT', body: { checkNumber: value } });
      onSaved(`Check number saved for ${check.name}.`);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <form onSubmit={save} className="flex flex-wrap items-center gap-2">
    <Input
      aria-label={`Check number for ${check.name}`} className="w-28" maxLength={30} autoComplete="off"
      value={value} onChange={event => setValue(event.target.value)}
    />
    <Button type="submit" variant="secondary" disabled={busy || !value.trim() || value.trim() === (check.checkNumber || '')}>Save number</Button>
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </form>;
}

function Problems({ title, items }) {
  if (!items.length) return null;
  return <div>
    <h4 className="m-0 mb-1 text-ui-body font-medium">{title}</h4>
    <ul className="m-0 grid list-none gap-1 p-0" aria-label={title}>
      {items.map(item => <li key={item.technicianId} className="rounded-sm border-hairline border-zinc-200 p-2">
        <strong>{item.name}</strong>
        <span className="block text-ui-caption text-ink-secondary">{item.reason}</span>
      </li>)}
    </ul>
  </div>;
}

function ChecksTable({ call, run, isFinal, onStub, onSaved }) {
  if (run.checks.length === 0) return <p className="m-0">No paychecks in this run yet.</p>;
  const t = run.totals;
  return <>
    <Table aria-label="Paychecks">
      <THead><TR>
        <TH>Employee</TH><TH align="right">Regular</TH><TH align="right">Overtime</TH><TH align="right">Rate</TH><TH align="right">Gross</TH>
        <TH align="right">Federal income tax</TH><TH align="right">Social Security</TH><TH align="right">Medicare</TH><TH align="right">Net</TH>
        {isFinal && <TH>Check</TH>}
      </TR></THead>
      <TBody>
        {run.checks.map(check => <TR key={check.id}>
          <TD>{check.name}</TD>
          <TD nums align="right">{hoursWord(check.regularHours)}</TD>
          <TD nums align="right">{hoursWord(check.overtimeHours)}</TD>
          <TD nums align="right">{centsToDollars(Math.round(Number(check.hourlyRate) * 100))}</TD>
          <TD nums align="right">{centsToDollars(check.grossCents)}</TD>
          <TD nums align="right">{centsToDollars(check.federalIncomeTaxCents)}</TD>
          <TD nums align="right">{centsToDollars(check.socialSecurityCents)}</TD>
          <TD nums align="right">{centsToDollars(check.medicareCents + check.additionalMedicareCents)}</TD>
          <TD nums align="right">{centsToDollars(check.netCents)}</TD>
          {isFinal && <TD>
            <div className="grid gap-2">
              <CheckNumberCell call={call} check={check} onSaved={onSaved} />
              <div><Button variant="secondary" onClick={() => onStub(check)} aria-label={`Stub for ${check.name}`}>Stub</Button></div>
            </div>
          </TD>}
        </TR>)}
      </TBody>
    </Table>

    <dl className="m-0 grid gap-1 text-ui-caption sm:grid-cols-2" aria-label="Run totals">
      <div className="flex justify-between gap-4"><dt>Gross pay</dt><dd className="m-0 tabular-nums">{centsToDollars(t.grossCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Employee taxes withheld</dt><dd className="m-0 tabular-nums">{centsToDollars(t.employeeTaxesCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Net pay</dt><dd className="m-0 tabular-nums">{centsToDollars(t.netCents)}</dd></div>
      <div className="flex justify-between gap-4"><dt>Employer taxes (you pay these)</dt><dd className="m-0 tabular-nums">{centsToDollars(t.employerTaxesCents)}</dd></div>
    </dl>
  </>;
}

function VoidForm({ busy, onVoid, onCancel }) {
  const [reason, setReason] = useState('');
  return <form
    aria-label="Void pay run" className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3"
    onSubmit={event => { event.preventDefault(); onVoid(reason.trim()); }}
  >
    <Field label="Why are you voiding this pay run?" required>
      <Textarea rows={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />
    </Field>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>Void pay run</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </form>;
}

export function RunDetail({ call, run, onChanged, onMessage }) {
  const [confirming, setConfirming] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stubFor, setStubFor] = useState(null);

  async function act(action, path, body, done) {
    setBusy(true); setError('');
    try {
      const data = await call(path, { method: 'POST', ...(body ? { body } : {}) });
      setConfirming(false); setVoiding(false);
      onMessage(done);
      await onChanged(data.run.id);
    } catch (failure) {
      setError(failure.message);
      // A changed draft was already saved by the server: show it.
      if (action === 'finalize') { setConfirming(false); await onChanged(run.id); }
    }
    setBusy(false);
  }

  async function exportCsv() {
    setBusy(true); setError('');
    try {
      const response = await call(`/runs/${run.id}/export.csv`, { raw: true });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = `pay-run-${run.weekStart}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  const isDraft = run.status === 'draft';
  const isFinal = run.status === 'finalized';
  const problems = run.blocked.length + run.waiting.length;
  const canFinalize = isDraft && run.checks.length > 0 && problems === 0 && !run.stale;

  return <Card className="grid gap-4 p-4" aria-label={`Pay run for ${weekLabel(run.weekStart)}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="m-0 text-ui-body font-medium">Week of {weekLabel(run.weekStart)}</h3>
        <p className="m-0 text-ui-caption text-ink-secondary">Pay date {dayLabel(run.payDate)}</p>
      </div>
      <StatusChip status={run.status} />
    </div>

    {run.status === 'voided' && <p className="m-0 text-ui-caption">Voided{run.voidReason ? `: ${run.voidReason}` : ''}</p>}
    {run.stale && <p role="status" className="m-0 text-ui-caption text-warn-fg">Hours or settings changed since this draft. Press Recompute.</p>}

    <Problems title="Waiting for approval" items={run.waiting} />
    <Problems title="Blocked" items={run.blocked} />

    <ChecksTable
      call={call} run={run} isFinal={isFinal} onStub={setStubFor}
      onSaved={text => { onMessage(text); onChanged(run.id); }}
    />

    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    {confirming && <div role="group" aria-label="Confirm finalize" className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3">
      <p className="m-0">Finalize this pay run? The paychecks become final. You can void the run later to redo the week.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => act('finalize', `/runs/${run.id}/finalize`, { token: run.token }, 'Pay run finalized.')}>Yes, finalize</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    </div>}

    {voiding && <VoidForm
      busy={busy}
      onVoid={reason => act('void', `/runs/${run.id}/void`, { reason }, 'Pay run voided.')}
      onCancel={() => setVoiding(false)}
    />}

    {!confirming && !voiding && <div className="flex flex-wrap gap-2">
      {isDraft && <Button variant="secondary" disabled={busy} onClick={() => act('recompute', `/runs/${run.id}/recompute`, null, 'Pay run recomputed.')}>Recompute</Button>}
      {isDraft && <Button disabled={busy || !canFinalize} onClick={() => setConfirming(true)}>Finalize</Button>}
      {(isDraft || isFinal) && <Button variant="secondary" disabled={busy} onClick={() => setVoiding(true)}>Void</Button>}
      {run.status !== 'voided' && run.checks.length > 0 && <Button variant="secondary" disabled={busy} onClick={exportCsv}>Export CSV</Button>}
    </div>}

    {stubFor && <StubDialog call={call} check={stubFor} onClose={() => setStubFor(null)} />}
  </Card>;
}

export default function PayRuns({ call }) {
  const weeks = useMemo(() => {
    const last = lastFinishedWeekStart();
    return Array.from({ length: WEEK_CHOICES }, (_, n) => addStaffCalendarDays(last, -7 * n));
  }, []);
  const [runs, setRuns] = useState(null);
  const [run, setRun] = useState(null);
  const [week, setWeek] = useState(weeks[0]);
  const [payDate, setPayDate] = useState(defaultPayDate(weeks[0]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadList = useCallback(async () => {
    try {
      const data = await call('/runs');
      setRuns(data.runs || []); setError('');
    } catch (failure) { setError(failure.message); }
  }, [call]);
  useEffect(() => { loadList(); }, [loadList]);

  const open = useCallback(async (id) => {
    try {
      const data = await call(`/runs/${id}`);
      setRun(data.run); setError('');
    } catch (failure) { setError(failure.message); }
    loadList();
  }, [call, loadList]);

  function pickWeek(event) {
    setWeek(event.target.value);
    setPayDate(defaultPayDate(event.target.value));
  }

  async function start(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const data = await call('/runs', { method: 'POST', body: { weekStart: week, payDate } });
      setRun(data.run);
      loadList();
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <section className="grid gap-3" aria-label="Pay runs">
    <header>
      <h2 className="m-0 text-18 font-medium tracking-tight text-zinc-900">Pay runs</h2>
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">The portal works out each paycheck from the approved hours. You pay the tech and make the tax payments yourself.</p>
    </header>
    {message && <p role="status" className="m-0 text-ui-caption text-zinc-900">{message}</p>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    <Card className="p-4">
      <form onSubmit={start} className="grid gap-3 sm:grid-cols-3 sm:items-end" aria-label="New pay run">
        <Field label="Week">
          <Select value={week} onChange={pickWeek}>
            {weeks.map(start_ => <option key={start_} value={start_}>{weekLabel(start_)}</option>)}
          </Select>
        </Field>
        <Field label="Pay date" help="The Friday after the week.">
          <Input type="date" min={addStaffCalendarDays(week, 7)} value={payDate} onChange={event => setPayDate(event.target.value)} />
        </Field>
        <div><Button type="submit" disabled={busy || !week || !payDate}>{busy ? 'Working…' : 'New pay run'}</Button></div>
      </form>
    </Card>

    {run && <RunDetail
      key={run.id} call={call} run={run}
      onChanged={open} onMessage={setMessage}
    />}

    {runs && runs.length === 0 && <p className="m-0">No pay runs yet.</p>}
    {runs && runs.length > 0 && <Card>
      <Table aria-label="Pay runs list">
        <THead><TR>
          <TH>Week</TH><TH>Pay date</TH><TH>Status</TH><TH align="right">Gross</TH><TH align="right">Net</TH><TH><span className="sr-only">Actions</span></TH>
        </TR></THead>
        <TBody>
          {runs.map(item => <TR key={item.id}>
            <TD>{weekLabel(item.weekStart)}</TD>
            <TD>{dayLabel(item.payDate)}</TD>
            <TD><StatusChip status={item.status} /></TD>
            <TD nums align="right">{centsToDollars(item.totals.grossCents)}</TD>
            <TD nums align="right">{centsToDollars(item.totals.netCents)}</TD>
            <TD><Button variant="secondary" onClick={() => { setMessage(''); open(item.id); }} aria-label={`Open pay run for ${weekLabel(item.weekStart)}`}>Open</Button></TD>
          </TR>)}
        </TBody>
      </Table>
    </Card>}
  </section>;
}
