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
import { etParts } from "../../../lib/timezone";

// Federal return (GATE_TAX_RETURN_ENGINE): the year's inputs, the return the
// server computes from the books, the carryovers it hands to next year, and
// Mark filed, which freezes the answer. Renders nothing while the gate is off.
// The numbers are the server's: this file only shows them. Same shared V2
// primitives and fetch idiom as LedgerInboxTab and SharedBillsPanel.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const FIRST_YEAR = 2024;
const T = "/admin/tax";

// Same helper as LedgerInboxTab.jsx / TaxPage.jsx (not imported: circular).
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

const post = (path, body) => adminFetch(path, { method: "POST", body: JSON.stringify(body) });
const put = (path, body) => adminFetch(path, { method: "PUT", body: JSON.stringify(body) });

function money(n) {
  const v = Number(n) || 0;
  const txt = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${txt}` : `$${txt}`;
}

const FILING = [["single", "Single"], ["mfj", "Married filing jointly"], ["hoh", "Head of household"]];
const CARRY = [
  ["nol", "nol_in", "Net operating loss carried in"],
  ["qbi_loss", "qbi_loss_in", "QBI loss carried in"],
  ["sec179", "sec179_carry_in", "Section 179 carried in"],
  ["home_office", "home_office_carry_in", "Home office carried in"],
];

function formFrom(row) {
  const amount = (v) => (Number(v) ? String(Number(v)) : "");
  // a carry-in of NULL is the default (an empty box); a stored 0 stays "0"
  const carry = (v) => (v == null ? "" : String(Number(v)));
  return {
    filing_status: row.filing_status || "single",
    other_income: amount(row.other_income),
    estimates_paid: amount(row.estimates_paid),
    nol_in: carry(row.nol_in),
    qbi_loss_in: carry(row.qbi_loss_in),
    sec179_carry_in: carry(row.sec179_carry_in),
    home_office_carry_in: carry(row.home_office_carry_in),
    notes: row.notes || "",
  };
}

// An empty carry-in box goes up as null (use the default); a typed 0 is kept.
function bodyFrom(form) {
  const num = (v) => (v.trim() === "" ? "0" : v.trim());
  const carry = (v) => (v.trim() === "" ? null : v.trim());
  return {
    filing_status: form.filing_status,
    other_income: num(form.other_income),
    estimates_paid: num(form.estimates_paid),
    nol_in: carry(form.nol_in),
    qbi_loss_in: carry(form.qbi_loss_in),
    sec179_carry_in: carry(form.sec179_carry_in),
    home_office_carry_in: carry(form.home_office_carry_in),
    notes: form.notes,
  };
}

function defaultText(c) {
  return c.default_source === "prior_year"
    ? `${money(c.default_value)} from the ${c.default_from_year} filed return`
    : "$0.00 (no filed return for last year)";
}

function sourceText(c) {
  if (!c) return "";
  if (c.source === "entered") return `Your number. Clear the box to use the default: ${defaultText(c)}.`;
  return `Default: ${defaultText(c)}. Type a number, even 0, to use your own.`;
}

function Row({ label, value, strong, testId }) {
  return (
    <TR>
      <TD className={strong ? "font-semibold" : ""}>{label}</TD>
      <TD className={`text-right whitespace-nowrap ${strong ? "font-semibold" : ""}`} data-testid={testId}>{value}</TD>
    </TR>
  );
}

function Lines({ ret }) {
  const rows = [
    ["Self-employment tax (Schedule SE)", ret.se_tax],
    ["Half of self-employment tax (deduction)", -ret.half_se_deduction],
    ["Adjusted gross income", ret.agi, true],
    [`Standard deduction (${ret.filing_status})`, -ret.standard_deduction],
    ["Net operating loss deduction", -ret.nol_used],
    ["Qualified business income deduction", -ret.qbi_deduction],
    ["Taxable income", ret.taxable_income, true],
    ["Income tax", ret.income_tax],
  ];
  if (ret.additional_medicare_tax) rows.push(["Additional Medicare Tax", ret.additional_medicare_tax]);
  return (
    <div className="overflow-x-auto max-w-full">
      <Table>
        <THead>
          <TR>
            <TH>Line</TH>
            <TH className="text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {ret.schedule_c.map((l, i) => (
            <Row key={`c${l.line}-${i}`} label={`Schedule C line ${l.line}: ${l.label}`} value={money(l.amount)} strong={l.line === "31"} />
          ))}
          {rows.map(([label, v, strong]) => <Row key={label} label={label} value={money(v)} strong={strong} />)}
          <Row label="Total tax (income tax + self-employment tax)" value={money(ret.total_tax)} strong testId="total-tax" />
          <Row label="Estimated payments made" value={money(-ret.estimates_paid)} />
          <Row label={ret.owed < 0 ? "Refund" : "Balance due"} value={money(Math.abs(ret.owed))} strong testId="owed" />
        </TBody>
      </Table>
    </div>
  );
}

function Carryouts({ ret }) {
  const co = ret.carry_out;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="carry-out">
      <strong>Carried to {ret.year + 1}</strong>
      <div>Net operating loss: {money(co.nol)}</div>
      <div>QBI loss: {money(co.qbi_loss)}</div>
      <div>Section 179: {money(co.sec179)}</div>
      <div>Home office: {money(co.home_office)}</div>
    </div>
  );
}

function Planning({ ret }) {
  const r = ret.reserve;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <strong>Looking ahead</strong>
      <div>{ret.estimates.note}</div>
      {r.amount > 0 && (
        <div>
          Balance on this return: {money(r.amount)}. Set aside about {money(r.monthly)} a month ({r.basis}).
        </div>
      )}
    </div>
  );
}

function YearForm({ detail, disabled, busy, onSave }) {
  const [form, setForm] = useState(() => formFrom(detail.row));
  useEffect(() => { setForm(formFrom(detail.row)); }, [detail]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = (e) => { e.preventDefault(); onSave(bodyFrom(form)); };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Filing status" className="flex-1 min-w-[180px]" value={form.filing_status} disabled={disabled} onChange={set("filing_status")}>
          {FILING.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </Select>
        <Input aria-label="Other income" placeholder="Other income (wages, interest)" inputMode="decimal" className="flex-1 min-w-[180px]" disabled={disabled} value={form.other_income} onChange={set("other_income")} />
        <Input aria-label="Estimated payments made" placeholder="Estimated payments made" inputMode="decimal" className="flex-1 min-w-[180px]" disabled={disabled} value={form.estimates_paid} onChange={set("estimates_paid")} />
      </div>
      <strong>Carried in from {detail.year - 1}</strong>
      {CARRY.map(([key, col, label]) => (
        <div key={key} className="flex flex-col gap-1">
          <Input aria-label={label} placeholder={`${label} (default ${money(detail.carry_in[key]?.default_value)})`} inputMode="decimal" disabled={disabled} value={form[col]} onChange={set(col)} />
          <div className="text-sm text-ink-secondary" data-testid={`source-${key}`}>{sourceText(detail.carry_in[key])}</div>
        </div>
      ))}
      <Input aria-label="Year notes" placeholder="Notes (optional)" disabled={disabled} value={form.notes} onChange={set("notes")} />
      <div>
        <Button type="submit" variant="primary" disabled={disabled || busy}>Save year</Button>
      </div>
    </form>
  );
}

export default function ReturnTab() {
  const thisYear = etParts().year;
  const [enabled, setEnabled] = useState(false);
  const [year, setYear] = useState(thisYear);
  const [detail, setDetail] = useState(null);
  const [ret, setRet] = useState(null);
  const [retError, setRetError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // only the newest year's answers may land: a slow answer for a year the
  // owner already left must not fill the screen under the new year
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    adminFetch(`${T}/return-engine/status`)
      .then((d) => { if (live) setEnabled(!!d?.enabled); })
      .catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, []);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setDetail(null);
    setRet(null);
    setRetError("");
    setError("");
    adminFetch(`${T}/tax-years/${year}`)
      .then((d) => { if (mine === seq.current) setDetail(d); })
      .catch((e) => { if (mine === seq.current) setError(e.message); });
    adminFetch(`${T}/tax-years/${year}/return`)
      .then((d) => { if (mine === seq.current) setRet(d); })
      .catch((e) => { if (mine === seq.current) setRetError(e.message); });
  }, [year]);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;
  const filed = detail?.row?.status === "filed";
  const years = [];
  for (let y = thisYear; y >= FIRST_YEAR; y -= 1) years.push(y);

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Card>
        <CardBody className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="flex-1 min-w-[160px]">Federal return</strong>
            <Select aria-label="Tax year" className="w-32" value={String(year)} disabled={busy} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            {filed && <Badge tone="strong">Filed {detail.row.filed_on}</Badge>}
          </div>
          <div className="text-sm text-ink-secondary">
            Computed from your sales, expenses, equipment and home office. Review it with your tax preparer before you file.
          </div>
          {detail && (
            <YearForm detail={detail} disabled={filed} busy={busy} onSave={(body) => run(() => put(`${T}/tax-years/${year}`, body))} />
          )}
          {filed && <div className="text-sm text-ink-secondary">This year is marked filed. Unmark it to change the numbers above.</div>}
          {error && <ActionFeedback error>{error}</ActionFeedback>}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-3 min-w-0">
          <strong>{year} return</strong>
          {retError && <ActionFeedback error>{retError}</ActionFeedback>}
          {!ret && !retError && <div className="text-sm text-ink-secondary">Loading the return…</div>}
          {ret && (
            <>
              <Lines ret={ret} />
              <Carryouts ret={ret} />
              <Planning ret={ret} />
              {ret.warnings.length > 0 && (
                <div className="flex flex-col gap-1 text-sm" data-testid="warnings">
                  <strong>Check these</strong>
                  {ret.warnings.map((w) => <div key={w.code + w.message}>{w.message}</div>)}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {filed ? (
                  <Button variant="secondary" disabled={busy} onClick={() => run(() => post(`${T}/tax-years/${year}/unfile`, {}))}>Unmark filed</Button>
                ) : (
                  <Button variant="primary" disabled={busy || !detail} onClick={() => run(() => post(`${T}/tax-years/${year}/file`, {}))}>Mark filed</Button>
                )}
                <div className="text-sm text-ink-secondary">
                  {filed ? "Unmarking lets you edit this year again." : "Marking a year filed freezes these numbers and passes the carryovers to the next year."}
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
