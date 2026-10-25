import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
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
import { etParts, etDateString } from "../../../lib/timezone";

// Florida sales tax return worksheet (DR-15), GATE_TAX_WORKSHEETS: the lines
// of the return for one period, worked out by the server from the books.
// Reads the books only; the one write is Mark filed on the existing filing
// calendar row (PUT /filings/:id). Renders nothing while the gate is off.
// Same shared V2 primitives and fetch idiom as ReturnTab.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const FIRST_YEAR = 2024;
const T = "/admin/tax";

// Same helper as ReturnTab.jsx / LedgerInboxTab.jsx / TaxPage.jsx (not imported: circular).
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      let detail = "";
      try {
        detail = (await r.json())?.error || "";
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

const put = (path, body) => adminFetch(path, { method: "PUT", body: JSON.stringify(body) });

function money(n) {
  const v = Number(n) || 0;
  const txt = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${txt}` : `$${txt}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-20" -> "Nov 20, 2026" (a string split: no time zone can move the day)
function readableDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return String(value || "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const KINDS = [["month", "Month"], ["quarter", "Quarter"], ["half", "Half year"], ["year", "Year"]];
const INDEXES = {
  month: MONTHS.map((label, i) => [i + 1, label]),
  quarter: [[1, "Q1"], [2, "Q2"], [3, "Q3"], [4, "Q4"]],
  half: [[1, "Jan–Jun"], [2, "Jul–Dec"]],
};

// The default period is the previous calendar month in ET (December of last year in January).
function previousMonth() {
  const { year, month } = etParts();
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function indexFor(kind, month) {
  if (kind === "month") return month;
  if (kind === "quarter") return Math.ceil(month / 3);
  if (kind === "half") return month <= 6 ? 1 : 2;
  return null;
}

function Row({ label, value, strong, note, testId }) {
  return (
    <TR>
      <TD className={strong ? "font-semibold" : ""}>
        {label}
        {note && <div className="text-sm font-normal text-ink-secondary">{note}</div>}
      </TD>
      <TD className={`text-right whitespace-nowrap align-top ${strong ? "font-semibold" : ""}`} data-testid={testId}>{value}</TD>
    </TR>
  );
}

function FilingBox({ sheet, busy, onMarkFiled }) {
  const { filing, lines } = sheet;
  const [filedDate, setFiledDate] = useState(() => etDateString());
  const [amount, setAmount] = useState(() => String(Number(lines.amount_due) || 0));
  const [confirmation, setConfirmation] = useState("");
  const [amountError, setAmountError] = useState("");
  if (!filing) {
    return <div className="text-sm text-ink-secondary">No filing calendar row for this period, so it cannot be marked filed here.</div>;
  }
  if (filing.status === "filed" || filing.status === "paid") {
    return (
      <div className="flex flex-col gap-1 text-sm" data-testid="filing-done">
        <strong>Filed {filing.filed_date}</strong>
        <div>Amount paid: {money(filing.amount_paid)}</div>
        {filing.confirmation_number && <div>Confirmation number: {filing.confirmation_number}</div>}
      </div>
    );
  }
  const submit = (e) => {
    e.preventDefault();
    // "$1,000.00" is fine; text that is not an amount, or a negative one, is refused
    const cleaned = amount.replace(/[$,\s]/g, "");
    const paid = cleaned === "" ? NaN : Number(cleaned);
    if (!Number.isFinite(paid) || paid < 0) {
      setAmountError("Enter the amount paid as a number, for example 13.04.");
      return;
    }
    setAmountError("");
    onMarkFiled(filing.id, {
      status: paid > 0 ? "paid" : "filed",
      filedDate,
      paidDate: paid > 0 ? filedDate : null,
      amountPaid: paid,
      confirmationNumber: confirmation.trim() || null,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <strong>Mark filed</strong>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Filed date" type="date" className="flex-1 min-w-[160px]" disabled={busy} value={filedDate} onChange={(e) => setFiledDate(e.target.value)} />
        <Input aria-label="Amount paid" inputMode="decimal" className="flex-1 min-w-[140px]" disabled={busy} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Input aria-label="Confirmation number" placeholder="Confirmation number" className="flex-1 min-w-[180px]" disabled={busy} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      </div>
      {amountError && <ActionFeedback error>{amountError}</ActionFeedback>}
      <div>
        <Button type="submit" variant="primary" disabled={busy}>Mark filed</Button>
      </div>
    </form>
  );
}

export default function SalesTaxTab() {
  const thisYear = etParts().year;
  const prev = previousMonth();
  const [enabled, setEnabled] = useState(false);
  const [kind, setKind] = useState("month");
  const [year, setYear] = useState(prev.year);
  const [index, setIndex] = useState(prev.month);
  const [sheet, setSheet] = useState(null);
  const [sheetError, setSheetError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // only the newest period's answer may land: a slow answer for a period the
  // owner already left must not fill the screen under the new period
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    adminFetch(`${T}/worksheets/status`)
      .then((d) => { if (live) setEnabled(!!d?.enabled); })
      .catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, []);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setSheet(null);
    setSheetError("");
    const q = new URLSearchParams({ kind, year: String(year) });
    if (kind !== "year") q.set("index", String(index));
    adminFetch(`${T}/worksheets/sales-tax?${q.toString()}`)
      .then((d) => { if (mine === seq.current) setSheet(d); })
      .catch((e) => { if (mine === seq.current) setSheetError(e.message); });
  }, [kind, year, index]);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  const markFiled = async (id, body) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await put(`${T}/filings/${id}`, body);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;
  const years = [];
  for (let y = thisYear; y >= FIRST_YEAR; y -= 1) years.push(y);
  const onKind = (e) => {
    const next = e.target.value;
    setKind(next);
    setIndex(indexFor(next, prev.month));
  };

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Card>
        <CardBody className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="flex-1 min-w-[160px]">Florida sales tax return</strong>
            <Select aria-label="Period type" className="w-36" value={kind} disabled={busy} onChange={onKind}>
              {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </Select>
            <Select aria-label="Year" className="w-28" value={String(year)} disabled={busy} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            {kind !== "year" && (
              <Select aria-label="Period" className="w-32" value={String(index)} disabled={busy} onChange={(e) => setIndex(Number(e.target.value))}>
                {INDEXES[kind].map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </Select>
            )}
          </div>
          {sheetError && <ActionFeedback error>{sheetError}</ActionFeedback>}
          {!sheet && !sheetError && <div className="text-sm text-ink-secondary">Loading the worksheet…</div>}
          {sheet && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <strong>{sheet.period.label}</strong>
                <span className="text-sm text-ink-secondary">Due {readableDate(sheet.due_date)}</span>
                {sheet.late && <Badge tone="alert">Late</Badge>}
                {sheet.period.in_progress && <Badge tone="warn">In progress</Badge>}
              </div>
              {sheet.warnings?.length > 0 && (
                <div className="flex flex-col gap-1 text-sm" data-testid="warnings">
                  {sheet.warnings.map((w) => <div key={w.code + w.text}>{w.text}</div>)}
                </div>
              )}
              <div className="overflow-x-auto max-w-full">
                <Table>
                  <THead>
                    <TR>
                      <TH>Line</TH>
                      <TH className="text-right">Amount</TH>
                    </TR>
                  </THead>
                  <TBody>
                    <Row label="Line A, column 1 — Gross sales" value={money(sheet.lines.gross_sales)} />
                    <Row label="Line A, column 2 — Exempt sales (residential work)" value={money(sheet.lines.exempt_sales)} />
                    <Row label="Line A, column 3 — Taxable amount (commercial work)" value={money(sheet.lines.taxable_amount)} />
                    <Row label="Line A, column 4 — Tax collected" value={money(sheet.lines.tax_collected)} />
                    <Row label="Line 6 — Lawful deductions (tax refunded)" value={money(Number(sheet.lines.lawful_deductions) > 0 ? -sheet.lines.lawful_deductions : 0)} />
                    <Row label="Line 7 — Total tax due" value={money(sheet.lines.tax_due)} />
                    <Row label="Line 15(d) — Surtax collected (part of column 4)" value={money(sheet.lines.surtax_collected)} />
                    <Row
                      label="Line 11 — Collection allowance"
                      value={money(Number(sheet.lines.collection_allowance) > 0 ? -sheet.lines.collection_allowance : 0)}
                      note={sheet.allowance_note}
                    />
                    <Row label="Line 12 — Penalty" value={money(sheet.lines.penalty)} note={sheet.penalty_note} />
                    <Row label="Line 13 — Interest" value="DOR works it out when the return is late" />
                    <Row label="Line 14 — Amount due with the return" value={money(sheet.lines.amount_due)} strong testId="amount-due" />
                  </TBody>
                </Table>
              </div>
              <div className="text-sm text-ink-secondary">File on the Florida Department of Revenue site and copy these numbers across.</div>
              <FilingBox key={sheet.filing?.id ?? "none"} sheet={sheet} busy={busy} onMarkFiled={markFiled} />
              {error && <ActionFeedback error>{error}</ActionFeedback>}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
