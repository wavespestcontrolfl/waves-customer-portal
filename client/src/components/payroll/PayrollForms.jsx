import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { etDateString } from '../../lib/timezone';
import { centsToDollars } from './payrollFormat';

// Payroll tab, "Tax forms" (owner 2026-10-25, basic payroll layer 3a, dark behind
// GATE_PAYROLL_FORM_FIGURES). The line-by-line figures to type onto Form 941, the
// Florida RT-6, Form 940 and each W-2 with the W-3 totals. The portal fills in no
// form and files nothing. No SSN, EIN or bank number is held: those fields say
// "Enter from your records". With the gate off the server answers 404 and this
// section renders nothing.

const FIRST_YEAR = 2026;
const FROM_RECORDS = 'Enter from your records';

// A plain decimal pastes into a form field better than "$1,234.56".
const plainAmount = (kind, value) => {
  if (kind === 'count') return String(value);
  const sign = value < 0 ? '-' : '';
  return `${sign}${(Math.abs(value) / 100).toFixed(2)}`;
};

const shown = (kind, value) => (kind === 'count' ? String(value) : centsToDollars(value));

function selectText(node) {
  if (!node || typeof window === 'undefined' || !window.getSelection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// One amount with its copy button. If the browser refuses the clipboard, the
// number is selected so the person can press the copy keys.
function Amount({ label, kind, value }) {
  const textRef = useRef(null);
  const [state, setState] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(plainAmount(kind, value));
      setState('copied');
    } catch {
      selectText(textRef.current);
      setState('selected');
    }
  }
  return <span className="inline-flex items-center justify-end gap-2">
    <span ref={textRef} className="tabular-nums">{shown(kind, value)}</span>
    <Button variant="secondary" size="sm" aria-label={`Copy ${label}`} onClick={copy}>
      {state === 'copied' ? 'Copied' : state === 'selected' ? 'Selected' : 'Copy'}
    </Button>
    {state === 'selected' && <span role="status" className="text-ui-caption text-ink-secondary">Selected. Press Ctrl+C or Cmd+C.</span>}
  </span>;
}

function LineTable({ name, rows }) {
  const twoColumns = rows.some(row => row.value2 !== undefined);
  return <Table aria-label={name}>
    <THead><TR>
      <TH>Line</TH><TH>Description</TH><TH align="right">{twoColumns ? 'Amount or wages' : 'Amount'}</TH>
      {twoColumns && <TH align="right">Tax</TH>}
    </TR></THead>
    <TBody>
      {rows.map((row, index) => <TR key={`${row.line}-${index}`}>
        <TD nums>{row.line}</TD>
        <TD>
          {row.label}
          {row.rate && <span className="block text-ui-caption text-ink-secondary">Rate {row.rate}</span>}
          {row.note && <span className="block text-ui-caption text-ink-secondary">{row.note}</span>}
        </TD>
        <TD align="right" nums>
          {row.kind === 'text'
            ? row.value
            : <Amount label={`${name} line ${row.line} ${row.kind === 'count' ? 'count' : 'amount'}`} kind={row.kind} value={row.value} />}
        </TD>
        {twoColumns && <TD align="right" nums>
          {row.value2 !== undefined && <Amount label={`${name} line ${row.line} tax`} kind="cents" value={row.value2} />}
        </TD>}
      </TR>)}
    </TBody>
  </Table>;
}

function Notes({ notes }) {
  if (!notes || notes.length === 0) return null;
  return <ul className="m-0 grid gap-1 pl-5 text-ui-caption text-ink-secondary">
    {notes.map(note => <li key={note}>{note}</li>)}
  </ul>;
}

function FormCard({ title, subtitle, children }) {
  return <Card className="grid gap-3 p-4" aria-label={title}>
    <div>
      <h3 className="m-0 text-ui-body font-medium">{title}</h3>
      {subtitle && <p className="m-0 text-ui-caption text-ink-secondary">{subtitle}</p>}
    </div>
    {children}
  </Card>;
}

const w2Rows = form => [
  { line: 'Box 1', label: 'Wages, tips, other compensation', kind: 'cents', value: form.box1 },
  { line: 'Box 2', label: 'Federal income tax withheld', kind: 'cents', value: form.box2 },
  { line: 'Box 3', label: 'Social security wages', kind: 'cents', value: form.box3 },
  { line: 'Box 4', label: 'Social security tax withheld', kind: 'cents', value: form.box4 },
  { line: 'Box 5', label: 'Medicare wages and tips', kind: 'cents', value: form.box5 },
  { line: 'Box 6', label: 'Medicare tax withheld (with Additional Medicare Tax)', kind: 'cents', value: form.box6 },
  ...(form.box12TT ? [{ line: 'Box 12 TT', label: 'Qualified overtime compensation', kind: 'cents', value: form.box12TT }] : []),
  // Only with GATE_PAYROLL_PAY_LINES on: the employer's cafeteria-plan HSA contributions.
  ...(form.box12W ? [{ line: 'Box 12 W', label: 'Employer contributions to a health savings account (cafeteria plan)', kind: 'cents', value: form.box12W }] : []),
];

const w3Rows = totals => [
  { line: 'Box c', label: 'Total number of Forms W-2', kind: 'count', value: totals.boxC },
  { line: 'Box 1', label: 'Wages, tips, other compensation', kind: 'cents', value: totals.box1 },
  { line: 'Box 2', label: 'Federal income tax withheld', kind: 'cents', value: totals.box2 },
  { line: 'Box 3', label: 'Social security wages', kind: 'cents', value: totals.box3 },
  { line: 'Box 4', label: 'Social security tax withheld', kind: 'cents', value: totals.box4 },
  { line: 'Box 5', label: 'Medicare wages and tips', kind: 'cents', value: totals.box5 },
  { line: 'Box 6', label: 'Medicare tax withheld (with Additional Medicare Tax)', kind: 'cents', value: totals.box6 },
];

function Rt6Employees({ employees }) {
  if (!employees || employees.length === 0) return null;
  return <Table aria-label="RT-6 employee list">
    <THead><TR>
      <TH>Employee</TH><TH>Social Security number</TH><TH align="right">Gross wages</TH><TH align="right">Taxable wages</TH>
    </TR></THead>
    <TBody>
      {employees.map(employee => <TR key={employee.name}>
        <TD>{employee.name}</TD>
        <TD>{employee.ssn || FROM_RECORDS}</TD>
        <TD align="right" nums><Amount label={`${employee.name} gross wages`} kind="cents" value={employee.grossCents} /></TD>
        <TD align="right" nums><Amount label={`${employee.name} taxable wages`} kind="cents" value={employee.taxableCents} /></TD>
      </TR>)}
    </TBody>
  </Table>;
}

export default function PayrollForms({ call, refreshKey = 0 }) {
  const thisYear = Number(etDateString(new Date()).slice(0, 4));
  const thisQuarter = Math.ceil(Number(etDateString(new Date()).slice(5, 7)) / 3);
  const [year, setYear] = useState(Math.max(thisYear, FIRST_YEAR));
  const [quarter, setQuarter] = useState(thisQuarter);
  const [data, setData] = useState(null);
  const [off, setOff] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null); setError('');
    call(`/forms?year=${year}&quarter=${quarter}`)
      .then(result => { if (live) { setData(result); setOff(false); setAnswered(true); } })
      .catch(failure => {
        if (!live) return;
        if (failure.status === 404) setOff(true);
        else { setError(failure.message); setAnswered(true); }
      });
    return () => { live = false; };
    // refreshKey: PayrollSettings bumps it when a pay run is finalized or voided.
  }, [call, year, quarter, refreshKey]);

  // Nothing shows until the server answers, so a dark gate never flashes the section.
  if (off || !answered) return null;

  const years = [];
  for (let y = Math.max(thisYear, FIRST_YEAR); y >= FIRST_YEAR; y -= 1) years.push(y);
  const quarterLabel = `Q${quarter} ${year}`;

  return <section aria-labelledby="payroll-tax-forms" className="grid gap-4">
    <header>
      <h2 id="payroll-tax-forms" className="m-0 text-ui-body font-medium">Tax forms</h2>
      <p className="m-0 mt-1 text-ui-caption text-ink-secondary">
        The figures to type onto each form, added up from final pay checks by pay date. The portal fills in no form and files nothing.
        Social Security numbers and the EIN stay on your records.
      </p>
    </header>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Year">
        <Select value={year} onChange={event => setYear(Number(event.target.value))}>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </Select>
      </Field>
      <Field label="Quarter" help="Form 941 and RT-6 use the quarter. Form 940 and W-2 use the whole year.">
        <Select value={quarter} onChange={event => setQuarter(Number(event.target.value))}>
          {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
        </Select>
      </Field>
    </div>
    {error && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{error}</p>}
    {!data && !error && <p role="status">Loading tax form figures…</p>}
    {data && <>
      <FormCard title={`Form 941, ${quarterLabel}`} subtitle="Employer's Quarterly Federal Tax Return">
        <LineTable name={`Form 941 ${quarterLabel}`} rows={data.f941.rows} />
        <Notes notes={data.f941.notes} />
      </FormCard>
      <FormCard title={`Florida RT-6, ${quarterLabel}`} subtitle="Employer's Quarterly Report (reemployment tax)">
        <LineTable name={`RT-6 ${quarterLabel}`} rows={data.rt6.rows} />
        <Rt6Employees employees={data.rt6.employees} />
        <Notes notes={data.rt6.notes} />
      </FormCard>
      <FormCard title={`Form 940, ${year}`} subtitle="Employer's Annual Federal Unemployment (FUTA) Tax Return">
        <LineTable name={`Form 940 ${year}`} rows={data.f940.rows} />
        <Notes notes={data.f940.notes} />
      </FormCard>
      <FormCard title={`W-2 and W-3, ${year}`} subtitle="One W-2 for each employee, then the W-3 totals">
        {data.w2.length === 0 && <p className="m-0">No final pay checks in {year}.</p>}
        {data.w2.map(form => <div key={form.technicianId} className="grid gap-2">
          <div>
            <h4 className="m-0 text-ui-body font-medium">{form.name}</h4>
            <p className="m-0 text-ui-caption text-ink-secondary">
              Social Security number: {form.ssn || FROM_RECORDS}. Address: {form.address || FROM_RECORDS}.
            </p>
          </div>
          <LineTable name={`W-2 for ${form.name}`} rows={w2Rows(form)} />
          <p className="m-0 text-ui-caption text-ink-secondary">{form.state}</p>
        </div>)}
        {data.w2.length > 0 && <div className="grid gap-2">
          <h4 className="m-0 text-ui-body font-medium">W-3 totals</h4>
          <LineTable name="W-3 totals" rows={w3Rows(data.w3)} />
        </div>}
        <Notes notes={[`Employer: ${data.employer?.name || ''}, ${data.employer?.address || ''}. EIN: ${FROM_RECORDS}.`]} />
      </FormCard>
    </>}
  </section>;
}
