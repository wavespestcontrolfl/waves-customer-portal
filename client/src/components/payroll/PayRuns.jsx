import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { Textarea } from '../ui/Textarea';
import { FieldDocumentBody, FieldFooter, FieldMasthead, FieldTitle } from '../FieldDocument';
import { centsToDollars, dayLabel, defaultPayDate, lastFinishedWeekStart, weekLabel } from './payrollFormat';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';
import TimeOffPanel from './TimeOffPanel';
import PayLinesPanel from './PayLinesPanel';
import { SimpleStubRow } from './SimpleIra';
import './pay-runs-print.css';

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
const NO_W4_NOTE = 'No W-4 on file: withheld as single, no adjustments (IRS default)';

function StatusChip({ status }) {
  const known = STATUS[status] || { tone: 'neutral', label: status };
  return <Badge tone={known.tone}>{known.label}</Badge>;
}

const hoursWord = hours => `${hours} h`;

// Bank status of a final check (GATE_PAYROLL_BANK_MATCH): only a run read with the gate on carries it.
function bankWords(bank) {
  if (bank.state === 'matched') return `Bank: matched ${dayLabel(bank.date)}`;
  if (bank.state === 'needs_pick') return 'Bank: needs your pick (Tax page, Bank Import)';
  return 'Bank: not seen yet';
}

function StubLine({ label, value, strong = false }) {
  return <div className={`flex justify-between gap-4 py-0.5 ${strong ? 'font-medium' : ''}`}>
    <span>{label}</span><span className="tabular-nums">{value}</span>
  </div>;
}

// Time-off bank on the stub: only on a check of an employee with a bank (the server sends `timeOffBank`).
function StubBank({ bank }) {
  if (!bank) return null;
  return <>
    <h2 className="field-section-heading">Time-off bank</h2>
    <div className="pay-stub-meta">
      <StubLine label="Earned this pay" value={`${bank.earnedHours} h`} />
      <StubLine label="Used this pay" value={`${bank.usedHours} h`} />
      {Number(bank.unpaidHours) > 0 && <StubLine label="Time off not paid" value={`${bank.unpaidHours} h`} />}
      {bank.paidOutHours && <StubLine label="Paid out at leaving" value={`${bank.paidOutHours} h`} />}
      <StubLine label="Balance after this pay" value={`${bank.balanceHours} h`} strong />
    </div>
  </>;
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

  return <Dialog open onClose={onClose} size="lg" className="pay-stub-dialog">
    <DialogHeader className="waves-field-no-print"><DialogTitle>Pay stub for {check.name}</DialogTitle></DialogHeader>
    <DialogBody className="pay-stub-dialog-body">
      {error && <p role="alert" className="text-ui-caption text-alert-fg">{error}</p>}
      {!stub && !error && <p role="status">Loading…</p>}
      {stub && <div aria-label="Pay stub">
        <FieldDocumentBody className="pay-stub field-document-scroll">
          <FieldMasthead variant="staff" />
          <FieldTitle
            eyebrow="Payroll record"
            title="Pay stub"
            reference={`Pay date ${dayLabel(stub.payDate)}`}
          />

          <h2 className="field-section-heading">Employer and employee</h2>
          <div className="field-info-grid pay-stub-meta grid sm:grid-cols-2">
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
          </div>

          <h2 className="field-section-heading">Earnings and withholding</h2>
          <Table aria-label="Pay stub amounts" containerClassName="pay-stub-table-wrap">
            <THead><TR><TH>Item</TH><TH align="right">This pay</TH><TH align="right">Year to date</TH></TR></THead>
            <TBody>
              <TR><TD>Regular pay ({stub.hours.regular} h at {centsToDollars(Math.round(Number(stub.hourlyRate) * 100))}/h)</TD><TD nums align="right">{centsToDollars(stub.earnings.regularPayCents)}</TD><TD nums align="right" /></TR>
              <TR><TD>Overtime pay ({stub.hours.overtime} h)</TD><TD nums align="right">{centsToDollars(stub.earnings.overtimePayCents)}</TD><TD nums align="right" /></TR>
              {stub.earnings.ptoPayCents > 0 && <TR><TD>Paid time off ({stub.hours.pto} h at {centsToDollars(Math.round(Number(stub.hourlyRate) * 100))}/h)</TD><TD nums align="right">{centsToDollars(stub.earnings.ptoPayCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.minimumWeekPayCents > 0 && <TR><TD>Minimum week pay ({stub.hours.minimumWeek} h at {centsToDollars(Math.round(Number(stub.hourlyRate) * 100))}/h, not hours worked)</TD><TD nums align="right">{centsToDollars(stub.earnings.minimumWeekPayCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.holidayWorkPremiumCents > 0 && <TR><TD>Holiday work premium (extra half on {stub.hours.holidayWork} h worked on a holiday; the hours are paid above)</TD><TD nums align="right">{centsToDollars(stub.earnings.holidayWorkPremiumCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.holidayPayCents > 0 && <TR><TD>Holiday pay ({stub.hours.holiday} h at {centsToDollars(Math.round(Number(stub.hourlyRate) * 100))}/h)</TD><TD nums align="right">{centsToDollars(stub.earnings.holidayPayCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.reviewBonusCents > 0 && <TR><TD>Review bonus</TD><TD nums align="right">{centsToDollars(stub.earnings.reviewBonusCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.commissionCents > 0 && <TR><TD>Commission</TD><TD nums align="right">{centsToDollars(stub.earnings.commissionCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.healthAllowanceCents > 0 && <TR><TD>Health allowance</TD><TD nums align="right">{centsToDollars(stub.earnings.healthAllowanceCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.techRewardsCents > 0 && <TR><TD>Tech rewards (season bonus, stay bonus or December gift)</TD><TD nums align="right">{centsToDollars(stub.earnings.techRewardsCents)}</TD><TD nums align="right" /></TR>}
              {stub.earnings.lineOvertimePremiumCents > 0 && <TR><TD>Overtime on bonus, commission and allowance</TD><TD nums align="right">{centsToDollars(stub.earnings.lineOvertimePremiumCents)}</TD><TD nums align="right" /></TR>}
              <TR><TD><strong>Gross pay</strong></TD><TD nums align="right"><strong>{centsToDollars(stub.earnings.grossCents)}</strong></TD><TD nums align="right">{centsToDollars(stub.ytd.grossCents)}</TD></TR>
              <TR><TD>Federal income tax</TD><TD nums align="right">{centsToDollars(stub.taxes.federalIncomeTaxCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.federalIncomeTaxCents)}</TD></TR>
              <TR><TD>Social Security</TD><TD nums align="right">{centsToDollars(stub.taxes.socialSecurityCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.socialSecurityCents)}</TD></TR>
              <TR><TD>Medicare</TD><TD nums align="right">{centsToDollars(stub.taxes.medicareCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.medicareCents)}</TD></TR>
              {stub.taxes.additionalMedicareCents > 0 && <TR><TD>Additional Medicare</TD><TD nums align="right">{centsToDollars(stub.taxes.additionalMedicareCents)}</TD><TD nums align="right">{centsToDollars(stub.ytd.additionalMedicareCents)}</TD></TR>}
              <SimpleStubRow stub={stub} />
              <TR><TD><strong>Net pay</strong></TD><TD nums align="right"><strong>{centsToDollars(stub.netCents)}</strong></TD><TD nums align="right">{centsToDollars(stub.ytd.netCents)}</TD></TR>
            </TBody>
          </Table>
          {stub.w4Default && <p className="m-0 text-ui-caption text-ink-secondary">{NO_W4_NOTE}</p>}

          <StubBank bank={stub.timeOffBank} />

          {stub.employerContributions && stub.employerContributions.hsaCents > 0 && <>
            <h2 className="field-section-heading">Employer contributions</h2>
            <div className="pay-stub-meta">
              <StubLine label="HSA from Waves (not part of gross pay or taxes)" value={centsToDollars(stub.employerContributions.hsaCents)} />
            </div>
          </>}

          <h2 className="field-section-heading">Payment record</h2>
          <div className="pay-stub-meta">
            <StubLine label="Paid by" value={stub.payMethod === 'bank_transfer' ? 'Bank transfer' : 'Paper check'} />
            {stub.payMethod === 'check' && <StubLine label="Check number" value={stub.checkNumber || 'Not entered'} />}
          </div>
          <FieldFooter label="Payroll record" reference={`Pay date ${dayLabel(stub.payDate)}`} />
        </FieldDocumentBody>
      </div>}
    </DialogBody>
    <DialogFooter className="waves-field-no-print">
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

// A Tech Rewards line (December gift, stay bonus, season bonus) that is due but not on this run (GATE_TECH_REWARDS_PAY_LINES,
// GATE_TECH_REWARDS_STAY_BONUS, GATE_TECH_REWARDS_SEASON_BONUS). It holds nothing.
function WaitingBonuses({ notes = [] }) {
  if (!notes.length) return null;
  return <div>
    <h4 className="m-0 mb-1 text-ui-body font-medium">Bonuses waiting</h4>
    <p className="m-0 mb-1 text-ui-caption text-ink-secondary">These are not on this pay run. Each line gives the last pay date that can add it. A draft also says what the bonus waited for when this pay run was last worked out. Press Recompute to check again.</p>
    <ul className="m-0 grid list-none gap-1 p-0" aria-label="Bonuses waiting">
      {notes.map(note => <li key={note} className="rounded-sm border-hairline border-zinc-200 p-2 text-ui-caption">{note}</li>)}
    </ul>
  </div>;
}

// `action(item)`: a button for the row, or nothing.
function Problems({ title, items, action }) {
  if (!items.length) return null;
  return <div>
    <h4 className="m-0 mb-1 text-ui-body font-medium">{title}</h4>
    <ul className="m-0 grid list-none gap-1 p-0" aria-label={title}>
      {items.map(item => <li key={item.technicianId} className="rounded-sm border-hairline border-zinc-200 p-2">
        <strong>{item.name}</strong>
        <span className="block text-ui-caption text-ink-secondary">{item.reason}</span>
        {action && action(item)}
      </li>)}
    </ul>
  </div>;
}

// Time off a time-off bank did not pay, with the server's reason (the bank is short, or the first-90-days rule).
// It does not block the pay run; the server sends the list only when there is some.
function UnpaidTimeOff({ rows = [] }) {
  return <Problems
    title="Time off not paid"
    items={rows.map(row => ({ technicianId: row.technicianId, name: row.name, reason: row.reason }))}
  />;
}

// The time-off bank payouts this pay run decides (an employee leaves, "Pay out the bank"). A payout of an empty
// bank has no paycheck to show it, so this list is where the owner sees it. The server sends it only when there is one.
function BankPayouts({ rows = [] }) {
  return <Problems
    title="Time-off bank paid out"
    items={rows.map(row => ({
      technicianId: row.technicianId, name: row.name,
      reason: Number(row.hours) > 0 ? `${row.hours} hours, on the paycheck.` : 'The bank is empty: nothing is paid out.',
    }))}
  />;
}

// Mercury paychecks (GATE_PAYROLL_MERCURY_STATUS / _PAY, owner plan A): Mercury sends a bank-transfer paycheck only
// after the owner approves the request in the Mercury app. Present only when the server sends `payment` on a check.
const PAYMENT_CHIPS = {
  queued: { tone: 'warn', label: 'Sending to Mercury' },
  requested: { tone: 'warn', label: 'Waiting for your approval in Mercury' },
  approved: { tone: 'neutral', label: 'Approved' },
  sent: { tone: 'strong', label: 'Sent' },
  failed: { tone: 'alert', label: 'Failed' },
  rejected: { tone: 'alert', label: 'Rejected' },
  cancelled: { tone: 'alert', label: 'Cancelled' },
  returned: { tone: 'alert', label: 'Returned' },
  unknown: { tone: 'alert', label: 'Outcome unknown' },
};

function PaymentChip({ payment }) {
  if (payment.state === 'none') return <span className="text-ink-secondary">Not sent</span>;
  if (payment.state === 'paper') return <Badge tone="neutral">Paid by check #{payment.checkNumber}</Badge>;
  const known = PAYMENT_CHIPS[payment.state] || { tone: 'neutral', label: payment.state };
  const sentOn = payment.state === 'sent' && payment.postedOn ? ` ${dayLabel(payment.postedOn)}` : '';
  return <Badge tone={known.tone}>{known.label}{sentOn}</Badge>;
}

function MercuryCell({ call, check, onSaved }) {
  const payment = check.payment;
  const [mode, setMode] = useState(null);
  const [number, setNumber] = useState('');
  const [requestId, setRequestId] = useState('');
  const [nothingWaiting, setNothingWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (check.payMethod !== 'bank_transfer' && payment.state === 'none') return <span className="text-ink-secondary">Paper check</span>;

  async function run(path, body, done) {
    setBusy(true); setError('');
    try {
      const data = await call(path, { method: 'POST', body });
      setMode(null);
      // A send-again can answer 200 and still not have reached Mercury: say what happened.
      const outcome = data && data.result && data.result.outcome;
      if (outcome === 'failed' || outcome === 'unknown') {
        onSaved(outcome === 'failed'
          ? `Mercury did not take the new request for ${check.name}. Look at the payment below.`
          : `We cannot tell if Mercury got the new request for ${check.name}. Look in Mercury before you send again.`);
      } else onSaved(done);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <div className="grid gap-2">
    <div><PaymentChip payment={payment} /></div>
    {payment.error && <p className="m-0 text-ui-caption text-alert-fg">{payment.error}</p>}
    {payment.state === 'unknown' && <p className="m-0 text-ui-caption text-ink-secondary">
      We cannot tell if Mercury got this request. Look in Mercury for a request of this amount before you send again.
    </p>}
    {mode === null && <div className="flex flex-wrap gap-2">
      {payment.canSendAgain && <Button variant="secondary" disabled={busy} onClick={() => setMode('again')} aria-label={`Send again for ${check.name}`}>Send again</Button>}
      {payment.state === 'unknown' && <Button variant="secondary" disabled={busy} onClick={() => setMode('link')} aria-label={`Link the Mercury request for ${check.name}`}>Link the Mercury request</Button>}
      {payment.canPaper && <Button variant="secondary" disabled={busy} onClick={() => setMode('paper')} aria-label={`Paid by paper check instead for ${check.name}`}>Paid by paper check instead</Button>}
    </div>}
    {mode === 'again' && <div role="group" aria-label={`Confirm send again for ${check.name}`} className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3">
      <p className="m-0">Ask Mercury for a new approval request of {centsToDollars(check.netCents)} for {check.name}?</p>
      {payment.canSendAgain === 'confirm' && <Checkbox
        id={`nothing-waiting-${check.id}`} label="Nothing is waiting in Mercury"
        checked={nothingWaiting} onChange={event => setNothingWaiting(event.target.checked)}
      />}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || (payment.canSendAgain === 'confirm' && !nothingWaiting)}
          onClick={() => run(`/checks/${check.id}/send-again`, payment.canSendAgain === 'confirm' ? { confirmNothingWaiting: true } : {}, `Asked Mercury again for ${check.name}. Approve it in the Mercury app.`)}
        >Yes, send again</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
      </div>
    </div>}
    {mode === 'link' && <form
      aria-label={`Link request for ${check.name}`} className="grid gap-2"
      onSubmit={event => { event.preventDefault(); run(`/payments/${payment.id}/link-request`, { requestId }, `Linked the Mercury request for ${check.name}.`); }}
    >
      <p className="m-0 text-ui-caption text-ink-secondary">Find the request in Mercury (Send money, approval requests), copy its id and paste it here. Nothing is sent.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={`Mercury request id for ${check.name}`} className="w-72" maxLength={64} autoComplete="off" value={requestId} onChange={event => setRequestId(event.target.value)} />
        <Button type="submit" disabled={busy || !requestId.trim()}>Link request</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
      </div>
    </form>}
    {mode === 'paper' && <form
      aria-label={`Paper check for ${check.name}`} className="flex flex-wrap items-center gap-2"
      onSubmit={event => { event.preventDefault(); run(`/checks/${check.id}/paper`, { checkNumber: number }, `Recorded a paper check for ${check.name}.`); }}
    >
      <Input aria-label={`Paper check number for ${check.name}`} className="w-28" maxLength={30} autoComplete="off" value={number} onChange={event => setNumber(event.target.value)} />
      <Button type="submit" disabled={busy || !number.trim()}>Save paper check</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
    </form>}
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </div>;
}

function ChecksTable({ call, run, isFinal, onStub, onSaved }) {
  if (run.checks.length === 0) return <p className="m-0">{run.status === 'draft' ? 'No paychecks in this run yet.' : 'No paychecks in this run.'}</p>;
  const t = run.totals;
  // Only a pay run drafted with time off turned on carries these figures.
  const showPto = run.checks.some(check => check.ptoPayCents > 0);
  const showHoliday = run.checks.some(check => check.holidayPayCents > 0);
  // Only a check of an employee with a minimum paid week carries this figure.
  const showMinimum = run.checks.some(check => check.minimumWeekPayCents > 0);
  // Only a check with hours worked on a holiday taken carries this figure.
  const showHolidayWork = run.checks.some(check => check.holidayWorkPremiumCents > 0);
  const showBank = isFinal && run.checks.some(check => check.bank);
  // Only a run read with GATE_PAYROLL_MERCURY_STATUS on carries each check's payment.
  const showMercury = isFinal && run.checks.some(check => check.payment);
  // Only a pay run drafted with pay lines turned on carries these figures.
  const showLines = run.checks.some(check => check.reviewBonusCents > 0 || check.commissionCents > 0 || check.healthAllowanceCents > 0 || check.techRewardsCents > 0 || check.lineOvertimePremiumCents > 0);
  const showHsa = run.checks.some(check => check.hsaEmployerCents > 0);
  return <>
    <Table aria-label="Paychecks">
      <THead><TR>
        <TH>Employee</TH><TH align="right">Regular</TH><TH align="right">Overtime</TH>
        {showPto && <TH align="right">Paid time off</TH>}
        {showHoliday && <TH align="right">Holiday</TH>}
        {showMinimum && <TH align="right">Minimum week</TH>}
        {showHolidayWork && <TH align="right">Holiday work premium</TH>}
        {showLines && <TH align="right">Bonus, commission, allowance</TH>}
        {showLines && <TH align="right">Overtime on those</TH>}
        <TH align="right">Rate</TH><TH align="right">Gross</TH>
        <TH align="right">Federal income tax</TH><TH align="right">Social Security</TH><TH align="right">Medicare</TH><TH align="right">Net</TH>
        {showHsa && <TH align="right">HSA from Waves</TH>}
        {isFinal && <TH>Check</TH>}
        {showBank && <TH>Bank</TH>}
        {showMercury && <TH>Mercury</TH>}
      </TR></THead>
      <TBody>
        {run.checks.map(check => <TR key={check.id}>
          <TD>
            {check.name}
            {check.w4Default && <p className="m-0 text-ui-caption text-ink-secondary">{NO_W4_NOTE}</p>}
            {check.timeOffBank && <p className="m-0 text-ui-caption text-ink-secondary">
              Time-off bank: earned {check.timeOffBank.earnedHours} h, used {check.timeOffBank.usedHours} h
              {check.timeOffBank.paidOutHours ? `, paid out ${check.timeOffBank.paidOutHours} h` : ''}, balance {check.timeOffBank.balanceHours} h
            </p>}
            {check.timeOffBank?.notPaidOutHours && <p className="m-0 text-ui-caption text-ink-secondary">
              {`This week was paid after the bank was paid out. It would have earned up to ${check.timeOffBank.notPaidOutHours} h of time off (less if the bank was near the 120 h cap). They are not on this check: pay them by hand if you choose.`}
            </p>}
          </TD>
          <TD nums align="right">{hoursWord(check.regularHours)}</TD>
          <TD nums align="right">{hoursWord(check.overtimeHours)}</TD>
          {showPto && <TD nums align="right">{hoursWord(check.ptoHours)} · {centsToDollars(check.ptoPayCents)}</TD>}
          {showHoliday && <TD nums align="right">{hoursWord(check.holidayHours)} · {centsToDollars(check.holidayPayCents)}</TD>}
          {showMinimum && <TD nums align="right">{check.minimumWeekPayCents > 0 ? `${hoursWord(check.minimumWeekHours)} · ${centsToDollars(check.minimumWeekPayCents)}` : ''}</TD>}
          {showHolidayWork && <TD nums align="right">{check.holidayWorkPremiumCents > 0 ? `${hoursWord(check.holidayWorkHours)} · ${centsToDollars(check.holidayWorkPremiumCents)}` : ''}</TD>}
          {showLines && <TD nums align="right">{centsToDollars(check.reviewBonusCents + check.commissionCents + check.healthAllowanceCents + (check.techRewardsCents || 0))}</TD>}
          {showLines && <TD nums align="right">{centsToDollars(check.lineOvertimePremiumCents)}</TD>}
          <TD nums align="right">{centsToDollars(Math.round(Number(check.hourlyRate) * 100))}</TD>
          <TD nums align="right">{centsToDollars(check.grossCents)}</TD>
          <TD nums align="right">{centsToDollars(check.federalIncomeTaxCents)}</TD>
          <TD nums align="right">{centsToDollars(check.socialSecurityCents)}</TD>
          <TD nums align="right">{centsToDollars(check.medicareCents + check.additionalMedicareCents)}</TD>
          <TD nums align="right">{centsToDollars(check.netCents)}</TD>
          {showHsa && <TD nums align="right">{centsToDollars(check.hsaEmployerCents)}</TD>}
          {isFinal && <TD>
            <div className="grid gap-2">
              <CheckNumberCell call={call} check={check} onSaved={onSaved} />
              <div><Button variant="secondary" onClick={() => onStub(check)} aria-label={`Stub for ${check.name}`}>Stub</Button></div>
            </div>
          </TD>}
          {showBank && <TD>{check.bank ? bankWords(check.bank) : ''}</TD>}
          {showMercury && <TD>{check.payment ? <MercuryCell call={call} check={check} onSaved={onSaved} /> : ''}</TD>}
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

const OUTCOME_WORDS = { requested: 'asked Mercury', failed: 'Mercury did not take it', unknown: 'outcome unknown', skipped: 'not sent' };

// The line after Send. "Nothing was sent" only when no request can have reached Mercury: an unknown one may have.
function sendSummary(results) {
  const count = outcome => results.filter(item => item.outcome === outcome).length;
  const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const asked = count('requested');
  const unknown = count('unknown');
  const failed = count('failed');
  const parts = [
    asked > 0 && `Asked Mercury for ${many(asked, 'payment')}. Approve them in the Mercury app.`,
    unknown > 0 && `We cannot tell if Mercury got ${many(unknown, 'request')}. Look in Mercury before you send again.`,
    failed > 0 && `Mercury did not take ${many(failed, 'request')}. Look at the payments below.`,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Nothing was sent to Mercury.';
}
const SKIP_WORDS = { no_recipient: 'no Mercury recipient id', no_pay: 'no pay', already_has_payment: 'already has a payment' };
const skipWords = reason => SKIP_WORDS[String(reason).split(':')[0]] || 'not sent';

function Warning({ children, tone = 'neutral' }) {
  return <li className={`rounded-sm border-hairline p-2 ${tone === 'warn' ? 'border-warn-fg text-warn-fg' : 'border-zinc-200'}`}>{children}</li>;
}

// GATE_PAYROLL_MERCURY_PAY: ask Mercury for an approval request for each bank-transfer paycheck. The confirm step shows the
// three warnings (never a block): funding, key health and the approve-by day. Money leaves only when you approve in Mercury.
function SendToMercury({ call, run, onChanged, onMessage }) {
  const [step, setStep] = useState('idle');
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const info = run.mercury;
  if (run.status !== 'finalized' || !info || !info.payEnabled) return null;

  async function openConfirm() {
    setBusy(true); setError(''); setResults(null);
    try {
      const data = await call(`/runs/${run.id}/send-preview`);
      setPreview(data.preview); setStep('confirm');
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  async function send() {
    setBusy(true); setError('');
    try {
      const data = await call(`/runs/${run.id}/send`, { method: 'POST', body: {} });
      setResults(data.results); setStep('idle');
      onMessage(sendSummary(data.results));
      await onChanged(run.id);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <div className="grid gap-2">
    {info.missingRecipient.length > 0 && <p className="m-0 text-ui-caption text-ink-secondary">
      No Mercury recipient id yet for {info.missingRecipient.join(', ')}. Add it in the employee table above.
    </p>}
    {step === 'idle' && info.canSend && <div>
      <Button disabled={busy} onClick={openConfirm}>Send to Mercury</Button>
    </div>}
    {step === 'confirm' && preview && <div role="group" aria-label="Confirm send to Mercury" className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3">
      <p className="m-0">
        Ask Mercury to pay {preview.eligible.length} paycheck{preview.eligible.length === 1 ? '' : 's'}
        {' '}({preview.eligible.map(item => `${item.name} ${centsToDollars(item.netCents)}`).join(', ')}).
        Nothing is paid until you approve each one in the Mercury app.
      </p>
      <ul className="m-0 grid list-none gap-1 p-0" aria-label="Before you send">
        <Warning tone={preview.funding.short ? 'warn' : 'neutral'}>{preview.funding.text}</Warning>
        <Warning tone={preview.key.stale ? 'warn' : 'neutral'}>{preview.key.text}</Warning>
        <Warning>{preview.approveBy.text}</Warning>
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={send}>Yes, send to Mercury</Button>
        <Button variant="secondary" disabled={busy} onClick={() => setStep('idle')}>Cancel</Button>
      </div>
    </div>}
    {results && <ul className="m-0 grid list-none gap-1 p-0" aria-label="Send results">
      {results.map(item => <li key={item.checkId} className="text-ui-caption">
        {item.name}: {item.outcome === 'skipped' ? skipWords(item.reason) : OUTCOME_WORDS[item.outcome] || item.outcome}
        {item.message ? ` (${item.message})` : ''}
      </li>)}
    </ul>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
  </div>;
}

// A run with no paycheck can still be finalized when it lists time off a time-off bank did not pay (that closes
// the week, and those hours stop waiting for a pay run) or the payout of an empty bank (that settles the payout).
// What such a run decides, in the words of the finalize prompt; '' when it decides nothing.
const noCheckWords = run => (run.checks.length > 0 ? '' : [
  (run.unpaidTimeOff || []).length > 0 && 'the time off above stays unpaid',
  (run.bankPayouts || []).length > 0 && 'the empty time-off bank above is settled with nothing paid out',
].filter(Boolean).join(', and '));
// `unverified`: the last read of the run failed, so its numbers can be from before a change.
const canFinalizeRun = (run, unverified) => run.status === 'draft' && !run.stale && !unverified
  && run.blocked.length + run.waiting.length === 0
  && (run.checks.length > 0 || noCheckWords(run) !== '');

// Why the owner cannot trust a draft's numbers yet. Recompute works them out again and reads them.
function DraftNotices({ run, unverified }) {
  if (run.status !== 'draft') return null;
  return <>
    {run.stale && <p role="status" className="m-0 text-ui-caption text-warn-fg">Hours or settings changed since this draft. Press Recompute.</p>}
    {unverified && <p role="status" className="m-0 text-ui-caption text-warn-fg">This draft could not be read again after a change. Press Recompute.</p>}
  </>;
}

function ConfirmFinalize({ run, busy, onYes, onCancel }) {
  return <div role="group" aria-label="Confirm finalize" className="grid gap-2 rounded-sm border-hairline border-zinc-300 p-3">
    <p className="m-0">{noCheckWords(run)
      ? `Finalize this pay run? It has no paycheck. The week closes and ${noCheckWords(run)}. You can void the run later to redo the week.`
      : 'Finalize this pay run? The paychecks become final. You can void the run later to redo the week.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={onYes}>Yes, finalize</Button>
      <Button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
    </div>
  </div>;
}

export function RunDetail({ call, run, unverified, onChanged, onMessage, onRunsChanged }) {
  // While the finalize prompt is open: the review token of the numbers on screen when Finalize was pressed.
  const [confirmToken, setConfirmToken] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stubFor, setStubFor] = useState(null);
  const canFinalize = canFinalizeRun(run, unverified);
  // A read in the background can bring other numbers under the open prompt. Time off that a time-off bank
  // does not pay changes the token and does not make the draft out of date, so "Yes" would finalize numbers
  // the owner did not confirm. The prompt closes, and the owner reviews them and presses Finalize again.
  const confirming = confirmToken !== null && (busy || (confirmToken === run.token && canFinalize));
  useEffect(() => {
    if (confirmToken === null || confirming) return;
    setConfirmToken(null);
    setError('The numbers changed. Review them, then press Finalize again.');
  }, [confirmToken, confirming]);

  async function act(action, path, body, done) {
    setBusy(true); setError('');
    // A finalize or a void settles the run: it changes the time-off banks, the pay lines and the tax forms.
    const settles = action === 'finalize' || action === 'void';
    try {
      const data = await call(path, { method: 'POST', ...(body ? { body } : {}) });
      setConfirmToken(null); setVoiding(false);
      onMessage(done);
      await onChanged(data.run.id);
    } catch (failure) {
      setError(failure.message);
      // The server can have committed before the error reached the page: a changed draft it saved in place
      // of a finalize, or a void whose answer was lost. Read the run again and show what the server holds.
      if (settles) { setConfirmToken(null); setVoiding(false); await onChanged(run.id); }
    }
    // The tax form figures on this page are read again for the same reason, after a failure too.
    if (settles && onRunsChanged) onRunsChanged();
    setBusy(false);
  }

  // A payout whose bank is gone holds the run: the server lists the employee as blocked, with `payoutWeek`. The
  // owner takes the payout back on that row. The Time off panel has no line for an employee with no bank.
  async function takePayoutBack(item) {
    setBusy(true); setError('');
    try {
      // The payout this row is for: set for this run's week, which no final pay run has paid (the run is a
      // draft). The server refuses when the payout is another one now, or in another state (another tab).
      await call(`/technicians/${item.technicianId}/pto-payout-week`, { method: 'PUT', body: { weekStart: null, shownWeekStart: item.payoutWeek, shownState: 'set' } });
      onMessage(`The time-off bank of ${item.name} is not paid out.`);
      await onChanged(run.id);
    } catch (failure) {
      setError(failure.message);
      // The run is read again: after a change elsewhere this row can be gone.
      await onChanged(run.id);
    }
    setBusy(false);
  }
  const payoutAction = item => (item.payoutWeek
    ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => takePayoutBack(item)} aria-label={`Do not pay out the bank of ${item.name}`}>Do not pay out</Button>
    : null);

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

  return <Card className="grid gap-4 p-4" aria-label={`Pay run for ${weekLabel(run.weekStart)}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="m-0 text-ui-body font-medium">Week of {weekLabel(run.weekStart)}</h3>
        <p className="m-0 text-ui-caption text-ink-secondary">Pay date {dayLabel(run.payDate)}</p>
      </div>
      <StatusChip status={run.status} />
    </div>

    {run.status === 'voided' && <p className="m-0 text-ui-caption">Voided{run.voidReason ? `: ${run.voidReason}` : ''}</p>}
    <DraftNotices run={run} unverified={unverified} />

    <Problems title="Waiting for approval" items={run.waiting} />
    <Problems title="Blocked" items={run.blocked} action={payoutAction} />
    <WaitingBonuses notes={run.techRewardsNotes} />
    <UnpaidTimeOff rows={run.unpaidTimeOff} />
    <BankPayouts rows={run.bankPayouts} />

    <ChecksTable
      call={call} run={run} isFinal={isFinal} onStub={setStubFor}
      onSaved={text => { onMessage(text); onChanged(run.id); }}
    />

    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}

    {confirming && <ConfirmFinalize
      run={run} busy={busy}
      onYes={() => act('finalize', `/runs/${run.id}/finalize`, { token: confirmToken }, 'Pay run finalized.')}
      onCancel={() => setConfirmToken(null)}
    />}

    {voiding && <VoidForm
      busy={busy}
      onVoid={reason => act('void', `/runs/${run.id}/void`, { reason }, 'Pay run voided.')}
      onCancel={() => setVoiding(false)}
    />}

    {!confirming && !voiding && <div className="flex flex-wrap gap-2">
      {isDraft && <Button variant="secondary" disabled={busy} onClick={() => act('recompute', `/runs/${run.id}/recompute`, null, 'Pay run recomputed.')}>Recompute</Button>}
      {isDraft && <Button disabled={busy || !canFinalize} onClick={() => { setError(''); setConfirmToken(run.token); }}>Finalize</Button>}
      {(isDraft || isFinal) && <Button variant="secondary" disabled={busy} onClick={() => setVoiding(true)}>Void</Button>}
      {run.status !== 'voided' && run.checks.length > 0 && <Button variant="secondary" disabled={busy} onClick={exportCsv}>Export CSV</Button>}
    </div>}

    <SendToMercury call={call} run={run} onChanged={onChanged} onMessage={onMessage} />

    {stubFor && <StubDialog call={call} check={stubFor} onClose={() => setStubFor(null)} />}
  </Card>;
}

// What the owner asked for while a new pay run is being made: no run id exists yet.
const NEW_RUN = Symbol('new pay run');

export default function PayRuns({ call, onRunsChanged, bankKey = '' }) {
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
  // The last read of the run on screen failed. The list reload clears `error`, so this stays apart from it:
  // the run keeps a line that says so, and Finalize waits until a read of it succeeds.
  const [unverified, setUnverified] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const data = await call('/runs');
      setRuns(data.runs || []); setError('');
    } catch (failure) { setError(failure.message); }
  }, [call]);
  useEffect(() => { loadList(); }, [loadList]);

  // Only the newest read sets the open run. An older read that answers last (a reload after a setting was
  // saved, a slow network) must not put another run back under the Finalize and Void buttons.
  // `shown` is the run on screen. `wanted` is the run the owner last asked for: it differs from `shown`
  // only while that read is on its way. `changes` counts the changes of something a run depends on, and
  // `readThrough` is the count the run on screen was read at. A read that a change ended under can be from
  // before the change, so it is made once more; and the run on screen is behind while the two counts differ.
  const newestOpen = useRef(0);
  const shown = useRef(null);
  const wanted = useRef(null);
  const changes = useRef(0);
  const readThrough = useRef(0);
  const show = useCallback((next, seen) => {
    shown.current = next.id; wanted.current = next.id; readThrough.current = seen;
    setRun(next); setUnverified(false);
  }, []);
  // `kept` is the failure that sent the owner back to the run on screen. It stays up while that run is read
  // again: the list is not reloaded then, because a list reload clears the message.
  const open = useCallback(async (id, kept = '') => {
    wanted.current = id;
    newestOpen.current += 1;
    const mine = newestOpen.current;
    try {
      let data;
      let seen;
      do {
        seen = changes.current;
        data = await call(`/runs/${id}`);
        if (mine !== newestOpen.current) return;
      } while (seen !== changes.current);
      show(data.run, seen); setError(kept);
    } catch (failure) {
      if (mine !== newestOpen.current) return;
      wanted.current = shown.current;
      setError(failure.message);
      if (shown.current === id) setUnverified(true);
      // The owner is back on the run on screen. A change that ended while they waited is not in it (its read
      // was held back, or dropped for this one): read it now.
      if (shown.current && shown.current !== id && readThrough.current !== changes.current) {
        open(shown.current, failure.message);
        return;
      }
    }
    if (!kept) loadList();
  }, [call, loadList, show]);
  // Something a run depends on changed (time off, a yearly-hours setting, another run finalized or voided).
  // The run on screen is read again now. While the owner waits for another run or a new one, that read is
  // not started: it would be dropped for this one, and the first run would stay under the buttons. The run
  // they wait for is read once more when it answers, and the run on screen is read when that one fails
  // (both by the count). Returns the read it started, or null.
  const refresh = useCallback(() => {
    changes.current += 1;
    if (shown.current && wanted.current === shown.current) return open(shown.current);
    return null;
  }, [open]);

  // A recompute, a finalize or a void answers for the run it started on. Read that run again only while it
  // is still the run the owner wants: an answer that arrives after they opened another run must not put the
  // first run back under the buttons. That answer can still have changed a time-off bank or a pay line, and
  // the run the owner looks at or waits for can have read them before it: the panels reload
  // (settledElsewhere) and that run is read again, so a draft shows as out of date. The list reloads either way.
  const [settledElsewhere, setSettledElsewhere] = useState(0);
  const changed = useCallback((id) => {
    // The answer is a change too. When the read below is dropped for a run that then does not come, the
    // run on screen is behind by this count, and the failed open reads it.
    if (wanted.current === id) { changes.current += 1; return open(id); }
    setSettledElsewhere(count => count + 1);
    return refresh() || loadList();
  }, [open, loadList, refresh]);

  // A yearly-hours setting changes what an open draft would pay. Read the run again, so a draft shows as
  // out of date and Finalize waits for a Recompute.
  const bankKeySeen = useRef(bankKey);
  useEffect(() => {
    if (bankKeySeen.current === bankKey) return;
    bankKeySeen.current = bankKey;
    refresh();
  }, [bankKey, refresh]);

  function pickWeek(event) {
    setWeek(event.target.value);
    setPayDate(defaultPayDate(event.target.value));
  }

  async function start(event) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    // The owner asks for a new run. It becomes the open run when it answers, unless they picked another
    // run meanwhile. Until then no refresh may read the shown run again: that read would take its place.
    // A change that ended while the run was being made can be missing from its answer: read it once more.
    // When no run comes, the run on screen has not read that change: read it, as a failed open does.
    wanted.current = NEW_RUN;
    newestOpen.current += 1;
    const mine = newestOpen.current;
    const seen = changes.current;
    try {
      const data = await call('/runs', { method: 'POST', body: { weekStart: week, payDate } });
      if (mine === newestOpen.current) {
        show(data.run, seen);
        if (seen !== changes.current) open(data.run.id);
      }
      loadList();
    } catch (failure) {
      setError(failure.message);
      if (mine === newestOpen.current) {
        wanted.current = shown.current;
        if (shown.current && readThrough.current !== changes.current) open(shown.current, failure.message);
      }
    }
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
      key={run.id} call={call} run={run} unverified={unverified}
      onChanged={changed} onMessage={setMessage} onRunsChanged={onRunsChanged}
    />}

    <TimeOffPanel
      call={call} weekStart={run ? run.weekStart : week}
      // A finalize adds to and takes from the time-off banks, a void undoes that, and a yearly-hours setting
      // (bankKey, from the settings table) turns a bank on or off: reload the balances on each.
      refreshKey={`${run ? `${run.id}:${run.status}` : ''}|${bankKey}|${settledElsewhere}`}
      onChanged={refresh}
    />

    <PayLinesPanel
      call={call} weekStart={run ? run.weekStart : week}
      // A finalize pays the open lines and a void reopens them: reload when the run's status changes, and
      // when a finalize or a void of another run ends (settledElsewhere).
      refreshKey={`${run ? `${run.id}:${run.status}` : ''}|${settledElsewhere}`}
      onChanged={refresh}
    />

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
