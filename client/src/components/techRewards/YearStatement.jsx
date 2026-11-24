import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { adminFetch } from '../../lib/adminFetch';
import { centsToDollars, dayLabel } from '../payroll/payrollFormat';

// Tech Rewards Plan D5-6 (owner 2026-11-20): one technician's pay for one calendar year, under the scoreboard. The
// technician sees their OWN statement (Staff page, Time > Scoreboard, behind GATE_TECH_REWARDS_SCOREBOARD); the owner
// opens any one technician's (Staff > Team > Scoreboard preview, not gated). Both load the same server object
// (services/tech-rewards-year-statement.js): sums of what payroll stored on the finalized paychecks with a pay date in
// the year. These are the amounts on finalized paychecks, not estimates. The words never say "paid": a finalized check
// can still wait for its bank transfer, and the transfer can fail (the Mercury send is a separate step). The row names
// are the pay stub's. Nothing here changes pay or sends a message. No customer data is shown.

// The parts of gross pay, in the pay stub's order. A part with nothing in the year is not shown.
const PAY_ROWS = [
  ['regularPayCents', 'Regular pay'],
  ['overtimePayCents', 'Overtime pay'],
  ['ptoPayCents', 'Paid time off'],
  ['holidayPayCents', 'Holiday pay'],
  ['minimumWeekPayCents', 'Minimum week pay'],
  ['holidayWorkPremiumCents', 'Holiday work premium'],
  ['reviewBonusCents', 'Review bonus'],
  ['commissionCents', 'Commission'],
  ['healthAllowanceCents', 'Health allowance'],
  ['seasonBonusCents', 'Season bonus'],
  ['stayBonusCents', 'Stay bonus'],
  ['decemberGiftCents', 'December gift'],
  ['lineOvertimePremiumCents', 'Overtime on bonus, commission and allowance'],
  ['otherCents', 'Other pay'],
];
const TAX_ROWS = [
  ['federalIncomeTaxCents', 'Federal income tax'],
  ['socialSecurityCents', 'Social Security'],
  ['medicareCents', 'Medicare'],
];
// What payroll stored on the paychecks as Waves' own money for the person: its 2% SIMPLE IRA contribution and the HSA money.
// The deposits themselves are not recorded in the portal, so the words say where the money comes from, not that it was sent.
const WAVES_ROWS = [
  ['simpleEmployerCents', 'SIMPLE IRA from Waves'],
  ['hsaEmployerCents', 'HSA from Waves'],
];

const AmountRow = ({ label, cents, strong = false }) => <TR>
  <TD>{strong ? <strong>{label}</strong> : label}</TD>
  <TD nums align="right">{strong ? <strong>{centsToDollars(cents)}</strong> : centsToDollars(cents)}</TD>
</TR>;
const amountRows = (rows, figures) => rows.filter(([key]) => figures[key] !== 0)
  .map(([key, label]) => <AmountRow key={key} label={label} cents={figures[key]} />);

export function YearStatementView({ statement }) {
  const { pay, fromWaves, withheld } = statement;
  if (statement.checkCount === 0) return <p className="m-0">No paychecks with a pay date in {statement.year}.</p>;
  const wavesRows = amountRows(WAVES_ROWS, fromWaves);
  return <div className="grid gap-3">
    <p className="m-0 text-ui-caption text-ink-secondary">
      {statement.checkCount} {statement.checkCount === 1 ? 'paycheck' : 'paychecks'}, pay dates {dayLabel(statement.firstPayDate)} to {dayLabel(statement.lastPayDate)}.
    </p>
    <Table aria-label={`Pay in ${statement.year}`}>
      <THead><TR><TH>Item</TH><TH align="right">{statement.year}</TH></TR></THead>
      <TBody>
        {amountRows(PAY_ROWS, pay)}
        <AmountRow label="Gross pay" cents={pay.grossCents} strong />
        {amountRows(TAX_ROWS, withheld)}
        {statement.simpleSavingsCents !== 0 && <AmountRow label="SIMPLE IRA (pre-tax)" cents={statement.simpleSavingsCents} />}
        <AmountRow label="Net pay" cents={statement.netCents} strong />
      </TBody>
    </Table>
    {wavesRows.length > 0 && <Table aria-label={`From Waves in ${statement.year}, on top of gross pay`}>
      <THead><TR><TH>From Waves, on top of gross pay</TH><TH align="right">{statement.year}</TH></TR></THead>
      <TBody>
        {wavesRows}
        <AmountRow label="Gross pay plus the money from Waves" cents={statement.totalCents} strong />
      </TBody>
    </Table>}
  </div>;
}

// `path` is the statement's API path for one person: the caller's own, or the one technician the owner picked.
export default function YearStatement({ path }) {
  // '' = no year asked: the server answers with this year
  const [year, setYear] = useState('');
  const [years, setYears] = useState([]);
  const [state, setState] = useState({ status: 'loading', statement: null, error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', statement: null, error: '' });
    adminFetch(`${path}${year ? `?year=${year}` : ''}`, { signal: controller.signal })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.statement) {
          setState({ status: 'error', statement: null, error: payload.error || `Unable to load the pay statement (${response.status}).` });
          return;
        }
        setYears(payload.statement.years);
        setState({ status: 'ready', statement: payload.statement, error: '' });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', statement: null, error: 'Unable to load the pay statement.' }); });
    return () => controller.abort();
  }, [path, year]);

  const shown = state.statement ? String(state.statement.year) : year;
  return <Card className="grid gap-3 p-4" aria-label="Pay statement">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 className="m-0 text-ui-title font-medium">Pay statement</h3>
        <p className="m-0 text-ui-caption text-ink-secondary">Amounts from finalized paychecks, by pay date. Not estimates.</p>
      </div>
      {years.length > 0 && <Field label="Year">
        <Select value={shown} onChange={event => setYear(event.target.value)}>
          {years.map(option => <option key={option} value={option}>{option}</option>)}
        </Select>
      </Field>}
    </div>
    {state.status === 'loading' && <p role="status" className="m-0">Loading…</p>}
    {state.status === 'error' && <p role="alert" className="m-0 text-ui-caption text-alert-fg">{state.error}</p>}
    {state.status === 'ready' && <YearStatementView statement={state.statement} />}
  </Card>;
}
