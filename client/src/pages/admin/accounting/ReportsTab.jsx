import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Input,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../../../components/ui";
import { etDateString } from "../../../lib/timezone";
import { getJson, formatCents } from "./api";

const REPORT_TYPES = [
  { value: "pnl", label: "Profit & Loss" },
  { value: "balance-sheet", label: "Balance Sheet" },
  { value: "trial-balance", label: "Trial Balance" },
  { value: "cash-flow", label: "Statement of Cash Flows" },
  { value: "sales-tax", label: "FL Sales Tax Liability (DR-15)" },
];

function MoneyRow({ label, code, amount, strong = false, subtle = false }) {
  return (
    <TR className={strong ? "bg-zinc-50" : undefined}>
      <TD className={strong ? "font-semibold text-zinc-900" : subtle ? "text-zinc-600" : "text-zinc-900"}>
        {code ? <span className="font-mono text-zinc-500 mr-2">{code}</span> : null}
        {label}
      </TD>
      <TD className={`text-right font-mono whitespace-nowrap ${strong ? "font-semibold text-zinc-900" : "text-zinc-900"}`}>
        {formatCents(amount)}
      </TD>
    </TR>
  );
}

function PnlView({ data }) {
  if (!data) return null;
  const { sections, totals } = data;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          Profit &amp; Loss ({data.basis === "cash" ? "Cash Basis" : "Accrual Basis"}) — {data.from} to {data.to}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge tone="neutral">Gross Margin: {totals.gross_margin_pct}%</Badge>
          <Badge tone={totals.net_income_cents >= 0 ? "strong" : "alert"}>
            Net Income: {formatCents(totals.net_income_cents)}
          </Badge>
        </div>
      </CardHeader>
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>Account</TH>
              <TH align="right">Amount</TH>
            </TR>
          </THead>
          <TBody>
            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Revenue</TD></TR>
            {sections.revenue.map((r) => (
              <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />
            ))}
            <MoneyRow label="Total Revenue" amount={totals.revenue_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Cost of Goods Sold</TD></TR>
            {sections.cogs.map((r) => (
              <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />
            ))}
            <MoneyRow label="Total COGS" amount={totals.cogs_cents} strong />
            <MoneyRow label={`Gross Profit (${totals.gross_margin_pct}%)`} amount={totals.gross_profit_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Operating Expenses</TD></TR>
            {sections.expenses.map((r) => (
              <MoneyRow
                key={r.id}
                code={r.code}
                label={`${r.name}${r.schedule_c_line ? ` (Line ${r.schedule_c_line})` : ""}${r.deductible_pct < 100 ? ` — ${r.deductible_pct}% deductible` : ""}`}
                amount={r.amount_cents}
              />
            ))}
            <MoneyRow label="Total Operating Expenses" amount={totals.operating_expenses_cents} strong />
            <MoneyRow label="EBITDA (Before Interest & Depreciation)" amount={totals.ebitda_cents} subtle />
            <MoneyRow label={`Net Income (${totals.net_margin_pct}%)`} amount={totals.net_income_cents} strong />
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function BalanceSheetView({ data }) {
  if (!data) return null;
  const { sections, totals } = data;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Balance Sheet — As of {data.as_of}</CardTitle>
        <Badge tone={totals.balanced ? "strong" : "alert"}>
          {totals.balanced ? "Balanced (Assets = Liabilities + Equity)" : `Out of balance by ${formatCents(totals.discrepancy_cents)}`}
        </Badge>
      </CardHeader>
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>Account</TH>
              <TH align="right">Balance</TH>
            </TR>
          </THead>
          <TBody>
            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Current Assets</TD></TR>
            {sections.current_assets.map((r) => <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />)}
            <MoneyRow label="Total Current Assets" amount={totals.current_assets_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Fixed Assets (Net of Accumulated Depreciation)</TD></TR>
            {sections.fixed_assets.map((r) => <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />)}
            <MoneyRow label="Total Fixed Assets (Net)" amount={totals.fixed_assets_net_cents} strong />
            <MoneyRow label="TOTAL ASSETS" amount={totals.total_assets_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Current Liabilities</TD></TR>
            {sections.current_liabilities.map((r) => <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />)}
            <MoneyRow label="Total Current Liabilities" amount={totals.current_liabilities_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Long-Term Liabilities</TD></TR>
            {sections.long_term_liabilities.map((r) => <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />)}
            <MoneyRow label="Total Liabilities" amount={totals.total_liabilities_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Equity</TD></TR>
            {sections.equity.map((r) => <MoneyRow key={r.id} code={r.code} label={r.name} amount={r.amount_cents} />)}
            <MoneyRow label="Current Period Net Income" amount={totals.net_income_cents} />
            <MoneyRow label="Total Equity" amount={totals.total_equity_cents} strong />
            <MoneyRow label="TOTAL LIABILITIES & EQUITY" amount={totals.liabilities_and_equity_cents} strong />
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function TrialBalanceView({ data }) {
  if (!data) return null;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Trial Balance — As of {data.as_of}</CardTitle>
        <Badge tone={data.balanced ? "strong" : "alert"}>
          {data.balanced ? "Balanced ($0.00 difference)" : `Out of balance: ${formatCents(data.out_of_balance_cents)}`}
        </Badge>
      </CardHeader>
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR>
              <TH>Code</TH>
              <TH>Account</TH>
              <TH>Type</TH>
              <TH align="right">Debit</TH>
              <TH align="right">Credit</TH>
            </TR>
          </THead>
          <TBody>
            {data.rows.length === 0 ? (
              <TR><TD colSpan={5} className="text-zinc-500 text-center py-6">No posted activity as of {data.as_of}.</TD></TR>
            ) : data.rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-zinc-600">{r.code}</TD>
                <TD className="text-zinc-900">{r.name}</TD>
                <TD className="capitalize text-zinc-600">{r.account_type}</TD>
                <TD className="text-right font-mono">{r.debit_balance_cents ? formatCents(r.debit_balance_cents) : ""}</TD>
                <TD className="text-right font-mono">{r.credit_balance_cents ? formatCents(r.credit_balance_cents) : ""}</TD>
              </TR>
            ))}
            <TR className="bg-zinc-50 font-semibold">
              <TD colSpan={3}>Totals</TD>
              <TD className="text-right font-mono">{formatCents(data.total_debit_cents)}</TD>
              <TD className="text-right font-mono">{formatCents(data.total_credit_cents)}</TD>
            </TR>
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function CashFlowView({ data }) {
  if (!data) return null;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Statement of Cash Flows — {data.from} to {data.to}</CardTitle>
        <Badge tone={data.summary.reconciles_to_cash ? "strong" : "alert"}>
          {data.summary.reconciles_to_cash ? "Reconciles to Cash" : `Cash variance: ${formatCents(data.summary.discrepancy_cents)}`}
        </Badge>
      </CardHeader>
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR><TH>Cash Flow Category</TH><TH align="right">Amount</TH></TR>
          </THead>
          <TBody>
            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Operating Activities</TD></TR>
            <MoneyRow label="Net Income" amount={data.operating.net_income_cents} />
            <MoneyRow label="Non-Cash Depreciation Add-Back" amount={data.operating.depreciation_addback_cents} />
            {data.operating.working_capital.map((w) => (
              <MoneyRow key={w.code} code={w.code} label={w.name} amount={w.amount_cents} />
            ))}
            <MoneyRow label="Net Cash Provided by Operating Activities" amount={data.operating.total_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Investing Activities</TD></TR>
            {data.investing.items.map((w) => <MoneyRow key={w.code} code={w.code} label={w.name} amount={w.amount_cents} />)}
            <MoneyRow label="Net Cash Used in Investing Activities" amount={data.investing.total_cents} strong />

            <TR className="bg-zinc-50"><TD colSpan={2} className="font-semibold text-zinc-700">Financing Activities</TD></TR>
            {data.financing.items.map((w) => <MoneyRow key={w.code} code={w.code} label={w.name} amount={w.amount_cents} />)}
            <MoneyRow label="Net Cash from Financing Activities" amount={data.financing.total_cents} strong />

            <MoneyRow label="Net Change in Cash" amount={data.summary.net_cash_change_cents} strong />
            <MoneyRow label="Beginning Cash & Clearing" amount={data.summary.beginning_cash_cents} />
            <MoneyRow label="Ending Cash & Clearing" amount={data.summary.ending_cash_cents} strong />
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

function SalesTaxView({ data }) {
  if (!data) return null;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Florida DR-15 Sales Tax Liability (Accrual) — {data.from} to {data.to}</CardTitle>
        <Badge tone={data.ending_payable_cents > 0 ? "warn" : "strong"}>
          Ending Payable: {formatCents(data.ending_payable_cents)}
        </Badge>
      </CardHeader>
      <CardBody className="p-0">
        <Table>
          <THead>
            <TR><TH>Line</TH><TH align="right">Amount</TH></TR>
          </THead>
          <TBody>
            <MoneyRow label="Opening FL Sales Tax Payable (Account 2100)" amount={data.opening_payable_cents} />
            <MoneyRow label="Sales Tax Accrued on Taxable Invoices" amount={data.tax_accrued_cents} />
            <MoneyRow label="Less: Sales Tax Reversed on Refunds" amount={-data.tax_reversed_on_refunds_cents} />
            <MoneyRow label="Net Period DR-15 Tax Due" amount={data.net_tax_due_for_period_cents} strong />
            <MoneyRow label="Less: FL DOR Remittances Paid" amount={-data.tax_remitted_cents} />
            <MoneyRow label="Ending Sales Tax Payable" amount={data.ending_payable_cents} strong />
          </TBody>
        </Table>
      </CardBody>
    </Card>
  );
}

export default function ReportsTab() {
  const today = etDateString(new Date());
  const [reportType, setReportType] = useState("pnl");
  const [basis, setBasis] = useState("accrual");
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [result, setResult] = useState({ key: null, reportType: null, data: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestSeqRef = useRef(0);

  const requestKey = `${reportType}|${from}|${to}|${basis}`;

  const loadReport = useCallback(async () => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setLoading(true);
    setError("");
    try {
      const qs = reportType === "balance-sheet" || reportType === "trial-balance"
        ? `?asOf=${encodeURIComponent(to)}`
        : reportType === "pnl"
          ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&basis=${encodeURIComponent(basis)}`
          : `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await getJson(`/reports/${reportType}${qs}`);
      if (seq !== requestSeqRef.current) return;
      setResult({ key: requestKey, reportType, data: res });
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err.message || "Could not load report.");
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [reportType, from, to, basis, requestKey]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const isPointInTime = reportType === "balance-sheet" || reportType === "trial-balance";
  const activeData = result.reportType === reportType && result.key === requestKey ? result.data : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="gl-report-type">Report</label>
            <Select id="gl-report-type" value={reportType} onChange={(e) => setReportType(e.target.value)}>
              {REPORT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </div>
          {reportType === "pnl" ? (
            <div className="min-w-[160px]">
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="gl-report-basis">Basis</label>
              <Select id="gl-report-basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="accrual">Accrual Basis</option>
                <option value="cash">Cash Basis</option>
              </Select>
            </div>
          ) : null}
          {!isPointInTime ? (
            <div>
              <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="gl-report-from">From</label>
              <Input id="gl-report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
          ) : null}
          <div>
            <label className="block text-14 font-medium text-zinc-700 mb-1" htmlFor="gl-report-to">
              {isPointInTime ? "As of" : "To"}
            </label>
            <Input id="gl-report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={loadReport} loading={loading}>Refresh</Button>
        </CardBody>
      </Card>

      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}

      {loading && !activeData ? (
        <Card>
          <CardBody className="text-14 text-zinc-500 py-6">Loading financial statement...</CardBody>
        </Card>
      ) : null}

      {reportType === "pnl" ? <PnlView data={activeData} /> : null}
      {reportType === "balance-sheet" ? <BalanceSheetView data={activeData} /> : null}
      {reportType === "trial-balance" ? <TrialBalanceView data={activeData} /> : null}
      {reportType === "cash-flow" ? <CashFlowView data={activeData} /> : null}
      {reportType === "sales-tax" ? <SalesTaxView data={activeData} /> : null}
    </div>
  );
}
