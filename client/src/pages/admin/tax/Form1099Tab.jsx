import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  Select,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from "../../../components/ui";
import { etParts } from "../../../lib/timezone";

// 1099-NEC list, GATE_TAX_WORKSHEETS: who was paid enough for the year to need
// a 1099-NEC, from contract labor and legal and professional expenses in the
// books. Reads the books only; no writes. Renders nothing while the gate is
// off. Same shared V2 primitives and fetch idiom as ReturnTab.

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

function money(n) {
  const v = Number(n) || 0;
  const txt = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-$${txt}` : `$${txt}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2027-02-01" -> "Feb 1, 2027" (a string split: no time zone can move the day)
function readableDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return String(value || "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const CHANNEL = {
  zelle: "Zelle",
  venmo: "Venmo",
  cash_app: "Cash App",
  paypal: "PayPal",
  wise: "Wise",
  check: "Check",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  unknown: "Not clear",
};
const channelWord = (c) => CHANNEL[c] || "Not clear";
const channelsText = (list) => (list?.length ? list.map(channelWord).join(", ") : "Not clear");

const SCHEDULE_C = { "11": "Contract labor", "17": "Legal and professional" };

function PayeeRows({ payee, threshold, open, onToggle }) {
  return (
    <>
      <TR>
        <TD className="font-medium">{payee.name}</TD>
        <TD className="text-right whitespace-nowrap">{money(payee.total)}</TD>
        <TD className="text-right">{payee.count}</TD>
        <TD>{channelsText(payee.channels)}</TD>
        <TD>
          <div className="flex flex-col gap-1 items-start">
            {payee.needs_1099 ? <Badge tone="strong">Needs a 1099-NEC</Badge> : <span className="text-sm text-ink-secondary">Under {money(threshold)}</span>}
            {payee.unresolved && <span className="text-sm text-ink-secondary">Payee not in the bank text: check who you paid</span>}
            {payee.unclear_method && <span className="text-sm text-ink-secondary">Check how you paid</span>}
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={onToggle}>
              {open ? "Hide payments" : "Show payments"}
            </Button>
          </div>
        </TD>
      </TR>
      {open && (
        <TR>
          <TD colSpan={5}>
            <div className="flex flex-col gap-1 text-sm" data-testid={`payments-${payee.key}`}>
              {payee.payments.map((p) => (
                <div key={p.expense_id} className="flex flex-wrap gap-x-3">
                  <span>{readableDate(p.date)}</span>
                  <span>{money(p.amount)}</span>
                  <span>{channelWord(p.channel)}</span>
                  <span>{SCHEDULE_C[p.line] || `Line ${p.line}`}</span>
                  {p.text && <span className="text-ink-secondary">{p.text}</span>}
                </div>
              ))}
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}

export default function Form1099Tab() {
  const thisYear = etParts().year;
  const [enabled, setEnabled] = useState(false);
  const [year, setYear] = useState(thisYear - 1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState(null);
  // only the newest year's answer may land: a slow answer for a year the
  // owner already left must not fill the screen under the new year
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
    setData(null);
    setError("");
    setOpenKey(null);
    adminFetch(`${T}/worksheets/1099?year=${year}`)
      .then((d) => { if (mine === seq.current) setData(d); })
      .catch((e) => { if (mine === seq.current) setError(e.message); });
  }, [year]);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  if (!enabled) return null;
  const years = [];
  for (let y = thisYear; y >= FIRST_YEAR; y -= 1) years.push(y);
  const left = data?.left_out;
  const inbox = data?.inbox_pending;

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <Card>
        <CardBody className="flex flex-col gap-3 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="flex-1 min-w-[160px]">1099-NEC list</strong>
            <Select aria-label="Year" className="w-28" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </div>
          {error && <ActionFeedback error>{error}</ActionFeedback>}
          {!data && !error && <div className="text-sm text-ink-secondary">Loading the list…</div>}
          {data && (
            <>
              <div className="text-sm text-ink-secondary" data-testid="summary">
                Threshold {money(data.threshold)} per person · 1099-NEC due {readableDate(data.due_date)}
              </div>
              {data.payees.length === 0 ? (
                <div className="text-sm text-ink-secondary">
                  No contract labor or legal and professional payments for {year} that need a 1099 check.
                </div>
              ) : (
                <div className="overflow-x-auto max-w-full">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Payee</TH>
                        <TH className="text-right">Paid</TH>
                        <TH className="text-right">Payments</TH>
                        <TH>How paid</TH>
                        <TH>Status</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data.payees.map((p) => (
                        <PayeeRows key={p.key} payee={p} threshold={data.threshold} open={openKey === p.key} onToggle={() => setOpenKey(openKey === p.key ? null : p.key)} />
                      ))}
                    </TBody>
                  </Table>
                </div>
              )}
              <div className="flex flex-col gap-1 text-sm text-ink-secondary">
                {left?.count > 0 && (
                  <div>
                    Left out: {left.count} card, debit card or platform payments ({money(left.total)}). The card network or the platform files a 1099-K for those.
                  </div>
                )}
                {inbox?.count > 0 && (
                  <div>
                    {inbox.count} Zelle, Venmo, Cash App or Wise payments ({money(inbox.total)}) still wait in the Inbox. Book the helper payments as contract labor to complete this list.
                  </div>
                )}
                {(data.notes || []).map((n) => <div key={n}>{n}</div>)}
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
