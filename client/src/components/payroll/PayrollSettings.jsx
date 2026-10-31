import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Checkbox } from '../ui/Checkbox';
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog';
import { Field } from '../ui/Field';
import { Input } from '../ui/Input';
import { Radio } from '../ui/Radio';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { Textarea } from '../ui/Textarea';
import { UiSurface } from '../ui/UiSurface';
import { adminFetch } from '../../lib/adminFetch';
import { etDateString } from '../../lib/timezone';
import { dayLabel, dollars } from './payrollFormat';
import PayRuns from './PayRuns';
import PayrollForms from './PayrollForms';

// Staff page, Payroll tab (owner 2026-10-25, basic payroll layer 1b-2a). An admin
// types the W-4 elections from the signed PAPER form and records how each W-2
// technician is paid. No SSN and no bank account number are asked for here.

const FILING_OPTIONS = [
  { value: 'single', label: 'Single or Married filing separately' },
  { value: 'married_jointly', label: 'Married filing jointly' },
  { value: 'head_of_household', label: 'Head of household' },
];
const FILING_WORDS = {
  single: 'Single or married filing separately',
  married_separately: 'Married filing separately',
  married_jointly: 'Married filing jointly',
  head_of_household: 'Head of household',
};
export const filingWords = status => FILING_WORDS[status] || 'Not recorded';

// raw: true hands back the Response (the CSV download); errors read the same.
async function call(path, { raw = false, ...options } = {}) {
  const response = await adminFetch(`/admin/payroll${path}`, options);
  if (raw && response.ok) return response;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Payroll request failed (${response.status}).`), { status: response.status });
  return data;
}

export function W4Summary({ w4 }) {
  if (!w4) return <span className="text-ink-secondary">No W-4 on file</span>;
  return <span>
    {w4.exempt ? 'Exempt' : filingWords(w4.filingStatus)}
    {w4.step2Checkbox ? ' · Step 2 box checked' : ''}
    {Number(w4.step4cExtraWithholding) > 0 ? ` · extra withholding ${dollars(w4.step4cExtraWithholding)}` : ''}
    <span className="block text-ui-caption text-ink-secondary">Form {w4.formYear} · applies from {dayLabel(w4.effectiveOn)}</span>
  </span>;
}

const blankForm = () => ({
  formYear: etDateString(new Date()).slice(0, 4),
  filingStatus: 'single', step2Checkbox: false, step3Amount: '', step4aOtherIncome: '',
  step4bDeductions: '', step4cExtraWithholding: '', exempt: false, signedOn: '', effectiveOn: '', note: '',
});

export function W4Dialog({ technician, onClose, onSaved }) {
  const [form, setForm] = useState(blankForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/w4`, {
        method: 'POST',
        body: {
          formYear: Number(form.formYear),
          filingStatus: form.filingStatus,
          step2Checkbox: form.step2Checkbox,
          step3Amount: form.step3Amount,
          step4aOtherIncome: form.step4aOtherIncome,
          step4bDeductions: form.step4bDeductions,
          step4cExtraWithholding: form.step4cExtraWithholding,
          exempt: form.exempt,
          signedOn: form.signedOn,
          ...(form.effectiveOn ? { effectiveOn: form.effectiveOn } : {}),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      });
      onSaved(`W-4 saved for ${technician.name}.`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  const money = (key, label, help) => (
    <Field label={label} help={help}>
      <Input inputMode="decimal" autoComplete="off" placeholder="0.00" value={form[key]} onChange={set(key)} />
    </Field>
  );

  return <Dialog open onClose={onClose} size="lg">
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Enter W-4 for {technician.name}</DialogTitle>
        <p className="mt-1 text-ui-caption text-ink-secondary">Type the elections from the signed paper W-4. Keep the paper form for 4 years. The SSN stays on the paper.</p>
      </DialogHeader>
      <DialogBody className="grid gap-4 sm:grid-cols-2">
        <Field label="Form year" required>
          <Input inputMode="numeric" value={form.formYear} onChange={set('formYear')} />
        </Field>
        <Field label="Step 1(c) filing status" required>
          <Select value={form.filingStatus} onChange={set('filingStatus')}>
            {FILING_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2"><Checkbox id="w4-step2" label="Step 2(c) box checked" checked={form.step2Checkbox} onChange={set('step2Checkbox')} /></div>
        {money('step3Amount', 'Step 3 total credits ($)')}
        {money('step4aOtherIncome', 'Step 4(a) other income ($)')}
        {money('step4bDeductions', 'Step 4(b) deductions ($)')}
        {money('step4cExtraWithholding', 'Step 4(c) extra withholding per pay period ($)')}
        <div className="sm:col-span-2"><Checkbox id="w4-exempt" label="Exempt" checked={form.exempt} onChange={set('exempt')} /></div>
        <Field label="Date the employee signed" required>
          <Input type="date" max={etDateString(new Date())} value={form.signedOn} onChange={set('signedOn')} />
        </Field>
        <Field label="First pay date it applies to" help="Leave blank to use the date signed.">
          <Input type="date" min={form.signedOn || undefined} value={form.effectiveOn} onChange={set('effectiveOn')} />
        </Field>
        <Field label="Note" className="sm:col-span-2">
          <Textarea rows={2} maxLength={500} value={form.note} onChange={set('note')} />
        </Field>
        {error && <p role="alert" className="text-ui-caption text-alert-fg sm:col-span-2">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !form.signedOn}>{busy ? 'Saving…' : 'Save W-4'}</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

export function PayMethodDialog({ technician, onClose, onSaved }) {
  const [payMethod, setPayMethod] = useState(technician.payMethod || 'check');
  const [consentOn, setConsentOn] = useState(technician.payMethodConsentOn || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/pay-method`, {
        method: 'PUT',
        body: { payMethod, consentOn: payMethod === 'bank_transfer' ? consentOn : null },
      });
      onSaved(`Pay method saved for ${technician.name}.`);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return <Dialog open onClose={onClose} size="sm">
    <form onSubmit={submit} className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Pay method for {technician.name}</DialogTitle>
        <p className="mt-1 text-ui-caption text-ink-secondary">Bank account numbers stay off the portal.</p>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <fieldset className="grid gap-2 border-0 p-0">
          <legend className="ui-label mb-1">How this employee is paid</legend>
          <Radio id="pay-method-check" name="pay-method" label="Paper check" checked={payMethod === 'check'} onChange={() => setPayMethod('check')} />
          <Radio id="pay-method-bank" name="pay-method" label="Bank transfer" checked={payMethod === 'bank_transfer'} onChange={() => setPayMethod('bank_transfer')} />
        </fieldset>
        {payMethod === 'bank_transfer' && (
          <Field label="Written OK received on" required help="Florida law needs the employee's written OK before pay goes to a bank. Keep that paper.">
            <Input type="date" max={etDateString(new Date())} value={consentOn} onChange={event => setConsentOn(event.target.value)} />
          </Field>
        )}
        {error && <p role="alert" className="text-ui-caption text-alert-fg">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || (payMethod === 'bank_transfer' && !consentOn)}>{busy ? 'Saving…' : 'Save pay method'}</Button>
      </DialogFooter>
    </form>
  </Dialog>;
}

export function W4HistoryDialog({ technician, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    call(`/technicians/${technician.id}/w4`)
      .then(data => { if (live) setRows(data.elections || []); })
      .catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [technician.id]);

  return <Dialog open onClose={onClose} size="lg">
    <DialogHeader><DialogTitle>W-4 history for {technician.name}</DialogTitle></DialogHeader>
    <DialogBody>
      {error && <p role="alert" className="text-ui-caption text-alert-fg">{error}</p>}
      {!rows && !error && <p role="status">Loading…</p>}
      {rows && rows.length === 0 && <p>No W-4 on file.</p>}
      {rows && rows.length > 0 && <ol className="m-0 grid list-none gap-3 p-0" aria-label="W-4 history, newest first">
        {rows.map(row => <li key={row.id} className="rounded-sm border-hairline border-zinc-200 p-3">
          <W4Summary w4={row} />
          <span className="block text-ui-caption text-ink-secondary">
            Signed {dayLabel(row.signedOn)}
            {row.step3Amount && Number(row.step3Amount) > 0 ? ` · Step 3 ${dollars(row.step3Amount)}` : ''}
            {Number(row.step4aOtherIncome) > 0 ? ` · Step 4(a) ${dollars(row.step4aOtherIncome)}` : ''}
            {Number(row.step4bDeductions) > 0 ? ` · Step 4(b) ${dollars(row.step4bDeductions)}` : ''}
          </span>
          {row.note && <span className="block text-ui-caption">{row.note}</span>}
        </li>)}
      </ol>}
    </DialogBody>
    <DialogFooter><Button type="button" variant="secondary" onClick={onClose}>Close</Button></DialogFooter>
  </Dialog>;
}

// GATE_PAYROLL_TIME_OFF: the yearly paid time off allowance. It only warns when a
// day is booked past it. Empty = no allowance set.
function AllowanceCell({ technician, onSaved }) {
  const current = technician.ptoHoursPerYear == null ? '' : String(technician.ptoHoursPerYear);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/pto-allowance`, {
        method: 'PUT',
        body: { hoursPerYear: value.trim() === '' ? null : value.trim() },
      });
      onSaved(`Paid time off allowance saved for ${technician.name}.`);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <form onSubmit={save} className="flex flex-wrap items-center gap-2">
    <Input
      aria-label={`Paid time off hours per year for ${technician.name}`} className="w-24" inputMode="decimal"
      autoComplete="off" placeholder="None" value={value} onChange={event => setValue(event.target.value)}
    />
    <Button type="submit" variant="secondary" disabled={busy || value.trim() === current}>Save</Button>
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </form>;
}

// GATE_PAYROLL_PAY_LINES: whether federal overtime law covers the employee. W-2 box 12
// code TT is filled only when it does. 'unset' = not set yet = no code TT.
const COVERAGE_VALUES = { true: 'yes', false: 'no' };
const coverageOf = technician => COVERAGE_VALUES[String(technician.flsaOvertimeCovered)] || 'unset';

function CoverageCell({ technician, onSaved }) {
  const current = coverageOf(technician);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/flsa-coverage`, {
        method: 'PUT',
        body: { covered: value === 'unset' ? null : value === 'yes' },
      });
      onSaved(`Overtime coverage saved for ${technician.name}.`);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <form onSubmit={save} className="flex flex-wrap items-center gap-2">
    <Select aria-label={`Federal overtime law covers ${technician.name}`} value={value} onChange={event => setValue(event.target.value)}>
      <option value="unset">Not set</option>
      <option value="yes">Covered</option>
      <option value="no">Not covered</option>
    </Select>
    <Button type="submit" variant="secondary" disabled={busy || value === current}>Save</Button>
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </form>;
}

// GATE_PAYROLL_FAMILY_EMPLOYEE: the owner's parent or spouse. Waves pays no federal or Florida
// unemployment tax on their pay. Present only when the server sends `familyEmployment`.
const RELATIONSHIP_WORDS = { parent: 'Parent', spouse: 'Spouse' };
const ENTITY_WORDS = { sole_proprietorship: 'sole proprietorship', single_member_llc: 'single-member LLC' };

function FamilyCell({ technician, onSaved }) {
  const current = technician.familyEmployment;
  const [editing, setEditing] = useState(false);
  const [relationship, setRelationship] = useState(current?.relationship || 'parent');
  const [entity, setEntity] = useState(current?.entity || 'single_member_llc');
  const [exemptFrom, setExemptFrom] = useState(current?.exemptFrom || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send(event, body, text) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await call(`/technicians/${technician.id}/family-employment`, { method: 'PUT', body });
      onSaved(text);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  if (!editing) {
    return <div className="flex flex-wrap items-center gap-2">
      <span>{current
        ? `${RELATIONSHIP_WORDS[current.relationship]}, ${ENTITY_WORDS[current.entity]}, from ${dayLabel(current.exemptFrom)}`
        : 'Not set'}</span>
      <Button type="button" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
    </div>;
  }

  return <form
    onSubmit={event => send(event, { relationship, entity, exemptFrom }, `Family employee setting saved for ${technician.name}.`)}
    className="grid gap-2"
  >
    <Select aria-label={`Relationship to the owner for ${technician.name}`} value={relationship} onChange={event => setRelationship(event.target.value)}>
      <option value="parent">Parent</option>
      <option value="spouse">Spouse</option>
    </Select>
    <Select aria-label={`Employer entity for ${technician.name}`} value={entity} onChange={event => setEntity(event.target.value)}>
      <option value="single_member_llc">Single-member LLC (no S election)</option>
      <option value="sole_proprietorship">Sole proprietorship</option>
    </Select>
    <Input
      type="date" aria-label={`Family employee start date for ${technician.name}`} min="2020-01-01"
      value={exemptFrom} onChange={event => setExemptFrom(event.target.value)}
    />
    <p className="m-0 text-ui-caption text-ink-secondary">
      Waves pays no federal or Florida unemployment tax on this person's pay; income tax, Social Security and Medicare stay.
      Clear it if Waves elects S corporation status or takes a partner.
    </p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="secondary" disabled={busy || !exemptFrom}>Save</Button>
      <Button
        type="button" variant="secondary" disabled={busy || !current}
        onClick={event => send(event, { relationship: null }, `Family employee setting cleared for ${technician.name}.`)}
      >Clear</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
    </div>
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </form>;
}

// GATE_PAYROLL_MERCURY_STATUS: the id Mercury gave this employee as a payee. Saving it reads the recipient from Mercury and
// shows the name only, so the owner can tell it is the right person. No account number is ever shown or kept here.
function MercuryRecipientCell({ technician, onSaved }) {
  const current = technician.mercuryRecipientId || '';
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const data = await call(`/technicians/${technician.id}/mercury-recipient`, {
        method: 'PUT',
        body: { recipientId: value.trim() === '' ? null : value.trim() },
      });
      const name = data.technician.recipientName;
      onSaved(data.technician.mercuryRecipientId
        ? `Mercury recipient saved for ${technician.name}${name ? `. Mercury shows the name ${name}` : ''}.`
        : `Mercury recipient cleared for ${technician.name}.`);
    } catch (failure) { setError(failure.message); }
    setBusy(false);
  }

  return <form onSubmit={save} className="flex flex-wrap items-center gap-2">
    <Input
      aria-label={`Mercury recipient id for ${technician.name}`} className="w-72" autoComplete="off"
      placeholder="Not set" value={value} onChange={event => setValue(event.target.value)}
    />
    <Button type="submit" variant="secondary" disabled={busy || value.trim() === current}>Save</Button>
    {error && <span role="alert" className="text-ui-caption text-alert-fg">{error}</span>}
  </form>;
}

function payMethodLabel(technician) {
  if (technician.payMethod === 'bank_transfer') {
    return <span>Bank transfer<span className="block text-ui-caption text-ink-secondary">Written OK {dayLabel(technician.payMethodConsentOn)}</span></span>;
  }
  return 'Paper check';
}

// A gated column shows only when the server sent its field (gate on).
const hasField = (technicians, field) => Boolean(technicians) && technicians.some(tech => field in tech);

export default function PayrollSettings() {
  const [technicians, setTechnicians] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(null);
  // Bumped when a pay run is finalized or voided, so the tax form figures refetch.
  const [formsVersion, setFormsVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await call('/technicians');
      setTechnicians(data.technicians || []); setError('');
    } catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const close = () => setDialog(null);
  const saved = text => { setDialog(null); setMessage(text); load(); };
  // Present only when the server has GATE_PAYROLL_TIME_OFF on.
  const showAllowance = hasField(technicians, 'ptoHoursPerYear');
  // Present only when the server has GATE_PAYROLL_PAY_LINES on.
  const showCoverage = hasField(technicians, 'flsaOvertimeCovered');
  // Present only when the server has GATE_PAYROLL_FAMILY_EMPLOYEE on.
  const showFamily = hasField(technicians, 'familyEmployment');
  // Present only when the server has GATE_PAYROLL_MERCURY_STATUS on.
  const showMercury = hasField(technicians, 'mercuryRecipientId');

  return <UiSurface density="touch" className="grid gap-4">
    <header>
      <h1 className="m-0 text-22 font-medium tracking-tight text-zinc-900">Payroll</h1>
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">W-4 elections and pay method for W-2 employees. The paper W-4 is the legal record. This page keeps the numbers typed from it.</p>
    </header>
    {message && <p role="status" className="m-0 text-ui-caption text-zinc-900">{message}</p>}
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {!technicians && !error && <p role="status">Loading payroll settings…</p>}
    {technicians && technicians.length === 0 && <p>No W-2 employees yet.</p>}
    {technicians && technicians.length > 0 && <Card>
      <Table aria-label="W-2 employees">
        <THead><TR>
          <TH>Employee</TH><TH>Pay rate</TH><TH>Pay method</TH><TH>Current W-4</TH>
          {showAllowance && <TH>Paid time off hours per year</TH>}
          {showCoverage && <TH>Federal overtime law covers</TH>}
          {showFamily && <TH>Family employee</TH>}
          {showMercury && <TH>Mercury recipient id</TH>}
          <TH><span className="sr-only">Actions</span></TH>
        </TR></THead>
        <TBody>
          {technicians.map(tech => <TR key={tech.id}>
            <TD>{tech.name}{tech.employmentStatus === 'prospective' && <span className="block text-ui-caption text-ink-secondary">Not started</span>}</TD>
            <TD nums>{tech.payRate != null ? `${dollars(tech.payRate)}/hr` : 'Not set'}</TD>
            <TD>{payMethodLabel(tech)}</TD>
            <TD><W4Summary w4={tech.currentW4} /></TD>
            {showAllowance && <TD><AllowanceCell key={`${tech.id}:${tech.ptoHoursPerYear}`} technician={tech} onSaved={saved} /></TD>}
            {showCoverage && <TD><CoverageCell key={`${tech.id}:${tech.flsaOvertimeCovered}`} technician={tech} onSaved={saved} /></TD>}
            {showFamily && <TD><FamilyCell key={`${tech.id}:${JSON.stringify(tech.familyEmployment)}`} technician={tech} onSaved={saved} /></TD>}
            {showMercury && <TD><MercuryRecipientCell key={`${tech.id}:${tech.mercuryRecipientId}`} technician={tech} onSaved={saved} /></TD>}
            <TD>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setDialog({ kind: 'w4', tech })}>Enter W-4</Button>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'history', tech })}>History</Button>
                <Button variant="secondary" onClick={() => setDialog({ kind: 'pay', tech })}>Pay method</Button>
              </div>
            </TD>
          </TR>)}
        </TBody>
      </Table>
    </Card>}
    <PayRuns call={call} onRunsChanged={() => setFormsVersion(v => v + 1)} />
    <PayrollForms call={call} refreshKey={formsVersion} />
    {dialog?.kind === 'w4' && <W4Dialog technician={dialog.tech} onClose={close} onSaved={saved} />}
    {dialog?.kind === 'pay' && <PayMethodDialog technician={dialog.tech} onClose={close} onSaved={saved} />}
    {dialog?.kind === 'history' && <W4HistoryDialog technician={dialog.tech} onClose={close} />}
  </UiSurface>;
}
