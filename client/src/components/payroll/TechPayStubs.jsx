import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table';
import { adminFetch } from '../../lib/adminFetch';
import { centsToDollars, dayLabel, weekLabel } from './payrollFormat';
import { StubDialog } from './PayRuns';

// Staff page, Pay stubs tab (GATE_TECH_PAY_STUBS, owner 2026-10-28, payroll item 7). A technician opens their
// own finalized pay stubs. The same stub the admin sees, no employer taxes. Nothing here changes pay or sends
// a message. The list comes from useTechPayStubs, which reads only the signed-in person's own checks.

// Same call shape as the Payroll tab: resolves with the JSON body, rejects with the server's message.
async function call(path) {
  const response = await adminFetch(`/tech/payroll${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pay stub request failed (${response.status}).`);
  return data;
}

export default function TechPayStubs({ stubs }) {
  const [open, setOpen] = useState(null);
  if (stubs.status !== 'ready') return null;
  return <Card className="grid gap-3 p-4" aria-label="Pay stubs">
    <div>
      <h2 className="m-0 text-ui-title font-medium">Pay stubs</h2>
      <p className="m-0 text-ui-caption text-ink-secondary">Your own pay stubs, once the office has finalized the pay run.</p>
    </div>
    {stubs.checks.length === 0
      ? <p className="m-0">No pay stubs yet.</p>
      : <Table aria-label="Your pay stubs">
        <THead><TR><TH>Week</TH><TH>Pay date</TH><TH align="right">Hours</TH><TH align="right">Gross</TH><TH align="right">Net</TH><TH><span className="sr-only">Open</span></TH></TR></THead>
        <TBody>
          {stubs.checks.map(check => <TR key={check.id}>
            <TD>{weekLabel(check.weekStart)}</TD>
            <TD>{dayLabel(check.payDate)}</TD>
            <TD nums align="right">{check.regularHours}{Number(check.overtimeHours) > 0 ? ` + ${check.overtimeHours} OT` : ''}</TD>
            <TD nums align="right">{centsToDollars(check.grossCents)}</TD>
            <TD nums align="right">{centsToDollars(check.netCents)}</TD>
            <TD><Button variant="secondary" onClick={() => setOpen(check)} aria-label={`Open pay stub for pay date ${dayLabel(check.payDate)}`}>Stub</Button></TD>
          </TR>)}
        </TBody>
      </Table>}
    {open && <StubDialog call={call} check={open} onClose={() => setOpen(null)} />}
  </Card>;
}
