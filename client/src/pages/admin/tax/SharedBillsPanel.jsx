import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  Checkbox,
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

// Shared bills + home office (GATE_TAX_SHARED_BILLS). A shared bill is a
// payee that is part business (a phone plan with business lines, home
// internet): Bank Import books it at the business share. The home office is
// one row per tax year, simplified or actual method. Renders nothing while the
// gate is off. Same shared V2 primitives and fetch idiom as LedgerInboxTab.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const RATE = 5;
const MAX_SQ_FT = 300;

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
const del = (path) => adminFetch(path, { method: "DELETE" });

const T = "/admin/tax";

function money(n) {
  return `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// The same arithmetic the server uses (the server's number is the one stored
// and exported; this one only previews what the owner is typing).
function previewDeduction(form) {
  if (form.method === "actual") {
    const office = Number(form.sq_ft) || 0;
    const home = Number(form.home_sq_ft) || 0;
    if (office <= 0 || home <= 0) return 0;
    const cents = ["rent", "utilities", "insurance", "other"].reduce(
      (sum, k) => sum + Math.round((Number(form[k]) || 0) * 100),
      0,
    );
    return Math.round((cents * Math.min(office, home)) / home) / 100;
  }
  const sq = Math.min(Math.max(Number(form.sq_ft) || 0, 0), MAX_SQ_FT);
  const m = Math.min(Math.max(Number(form.months) || 0, 0), 12);
  return Math.round((RATE * 100 * sq * m) / 12) / 100;
}

const EMPTY_HOME = {
  method: "simplified", sq_ft: "", months: "12", home_sq_ft: "", rent: "", utilities: "", insurance: "", other: "", notes: "",
};
const amountText = (v) => (v == null ? "" : String(Number(v)));

function homeForm(row) {
  if (!row) return EMPTY_HOME;
  return {
    method: row.method || "simplified",
    sq_ft: String(row.sq_ft),
    months: String(row.months),
    home_sq_ft: row.home_sq_ft == null ? "" : String(row.home_sq_ft),
    rent: amountText(row.rent),
    utilities: amountText(row.utilities),
    insurance: amountText(row.insurance),
    other: amountText(row.other),
    notes: row.notes || "",
  };
}

// what goes up is what was typed, never silently changed: the server decides
function homeBody(form) {
  if (form.method === "actual") {
    return {
      method: "actual",
      sq_ft: form.sq_ft.trim(),
      home_sq_ft: form.home_sq_ft.trim(),
      rent: form.rent.trim(),
      utilities: form.utilities.trim(),
      insurance: form.insurance.trim(),
      other: form.other.trim(),
      notes: form.notes,
    };
  }
  return { method: "simplified", sq_ft: form.sq_ft.trim(), months: form.months.trim(), notes: form.notes };
}

function BillsTable({ bills, categories, busy, onChange, onDelete }) {
  if (bills.length === 0) return <div className="text-sm text-ink-secondary">No shared bills yet.</div>;
  return (
    <div className="overflow-x-auto max-w-full">
      <Table>
        <THead>
          <TR>
            <TH>Bill</TH>
            <TH>Bank text</TH>
            <TH>Business %</TH>
            <TH>Category</TH>
            <TH>On</TH>
            <TH>Remove</TH>
          </TR>
        </THead>
        <TBody>
          {bills.map((b) => (
            <TR key={b.id}>
              <TD className="[overflow-wrap:anywhere]">{b.label}</TD>
              <TD className="[overflow-wrap:anywhere]">{b.pattern}</TD>
              <TD>{Number(b.business_pct)}%</TD>
              <TD>
                <Select
                  aria-label={`Category for ${b.label}`}
                  value={b.category_id || ""}
                  disabled={busy}
                  onChange={(e) => onChange(b, { category_id: e.target.value || null })}
                >
                  <option value="">None</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </TD>
              <TD>
                <Checkbox
                  role="switch"
                  aria-label={`Enable ${b.label}`}
                  checked={!!b.enabled}
                  disabled={busy}
                  onChange={() => onChange(b, { enabled: !b.enabled })}
                />
              </TD>
              <TD>
                <Button variant="secondary" aria-label={`Remove ${b.label}`} disabled={busy} onClick={() => onDelete(b)}>
                  Remove
                </Button>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function BillsBox({ categories }) {
  const [bills, setBills] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ label: "", pattern: "", business_pct: "", category_id: "" });

  const load = useCallback(() => {
    adminFetch(`${T}/shared-bills`)
      .then((d) => setBills(d.bills || []))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
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

  const change = (bill, patch) => run(() => put(`${T}/shared-bills/${bill.id}`, patch));
  const remove = (bill) => run(() => del(`${T}/shared-bills/${bill.id}`));

  const add = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) { setError("Enter a name for the bill."); return; }
    if (!form.pattern.trim()) { setError("Enter the text the bank prints for this bill."); return; }
    if (form.business_pct.trim() === "") { setError("Enter the business share, from 0 to 100."); return; }
    const body = { label: form.label.trim(), pattern: form.pattern.trim(), business_pct: form.business_pct.trim() };
    if (form.category_id) body.category_id = form.category_id;
    await run(async () => {
      await post(`${T}/shared-bills`, body);
      setForm({ label: "", pattern: "", business_pct: "", category_id: "" });
    });
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card>
      <CardBody className="flex flex-col gap-3 min-w-0">
        <strong>Shared bills</strong>
        <div className="text-sm text-ink-secondary">
          A bill that is part business. When you book its bank row as an expense, only the business share counts as a deduction.
        </div>
        <BillsTable bills={bills} categories={categories} busy={busy} onChange={change} onDelete={remove} />
        <form onSubmit={add} className="flex flex-col gap-2">
          <strong>Add shared bill</strong>
          <Input aria-label="Bill name" placeholder="Name (for example, Phone plan)" value={form.label} onChange={set("label")} />
          <Input aria-label="Bank text" placeholder="Text on the bank line (for example, VERIZON)" value={form.pattern} onChange={set("pattern")} />
          <div className="text-sm text-ink-secondary">
            Capital letters, spaces and symbols do not matter. The text must match whole words: VERIZON finds
            &quot;VERIZON WIRELESS&quot; but not &quot;VERIZONWRLS&quot;. Use 3 to 60 letters or digits.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Business percent"
              placeholder="Business % (0 to 100)"
              inputMode="decimal"
              className="flex-1 min-w-[140px]"
              value={form.business_pct}
              onChange={set("business_pct")}
            />
            <Select aria-label="New bill category" className="flex-1 min-w-[160px]" value={form.category_id} onChange={set("category_id")}>
              <option value="">No category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>Add shared bill</Button>
          </div>
        </form>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
      </CardBody>
    </Card>
  );
}

function HomeOfficeBox() {
  const thisYear = etParts().year;
  const [year, setYear] = useState(thisYear);
  const [form, setForm] = useState(EMPTY_HOME);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // only the newest year's response may fill the form: a slower answer for a
  // year the operator already left must not land under the new year's Save
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError("");
    setNotice("");
    adminFetch(`${T}/home-office/${year}`)
      .then((d) => {
        if (seq !== loadSeq.current) return;
        setSaved(d.row);
        setForm(homeForm(d.row));
        setLoading(false);
      })
      .catch((e) => { if (seq === loadSeq.current) setError(e.message); });
  }, [year]);
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const d = await put(`${T}/home-office/${year}`, homeBody(form));
      setSaved(d.row);
      setNotice(`Saved. ${year} home office deduction: ${money(d.deduction)}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await del(`${T}/home-office/${year}`);
      setSaved(null);
      setForm(EMPTY_HOME);
      setNotice(`Removed the ${year} home office.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const years = [];
  for (let y = thisYear + 1; y >= 2020; y -= 1) years.push(y);

  return (
    <Card>
      <CardBody className="flex flex-col gap-3 min-w-0">
        <strong>Home office</strong>
        <div className="text-sm text-ink-secondary">
          {form.method === "actual"
            ? "Actual method (Form 8829): the year's rent, utilities, insurance and other home costs × office square feet ÷ home square feet. No square foot limit."
            : `Simplified method: $${RATE} × square feet × months ÷ 12, up to ${MAX_SQ_FT} square feet ($1,500 a year at most).`}
          {" "}The tax package lists it in home-office.csv.
        </div>
        <div className="text-sm text-ink-secondary">
          The simplified method is only valid on a timely original return (Rev. Proc. 2013-13, section 4.03). A late return needs the actual method.
        </div>
        <form onSubmit={save} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Home office year" className="flex-1 min-w-[120px]" value={String(year)} disabled={busy} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            <Select aria-label="Home office method" className="flex-1 min-w-[140px]" value={form.method} onChange={set("method")}>
              <option value="simplified">Simplified</option>
              <option value="actual">Actual</option>
            </Select>
            <Input
              aria-label="Square feet"
              placeholder={form.method === "actual" ? "Office square feet" : `Square feet (up to ${MAX_SQ_FT})`}
              inputMode="numeric"
              className="flex-1 min-w-[140px]"
              value={form.sq_ft}
              onChange={set("sq_ft")}
            />
            {form.method === "actual" ? (
              <Input
                aria-label="Home square feet"
                placeholder="Whole home square feet"
                inputMode="numeric"
                className="flex-1 min-w-[140px]"
                value={form.home_sq_ft}
                onChange={set("home_sq_ft")}
              />
            ) : (
              <Input
                aria-label="Months used"
                placeholder="Months (1 to 12)"
                inputMode="numeric"
                className="flex-1 min-w-[120px]"
                value={form.months}
                onChange={set("months")}
              />
            )}
          </div>
          {form.method === "actual" && (
            <div className="flex flex-wrap items-center gap-2">
              {[["rent", "Rent for the year"], ["utilities", "Utilities for the year"], ["insurance", "Insurance for the year"], ["other", "Other home costs for the year"]].map(([k, label]) => (
                <Input
                  key={k}
                  aria-label={label}
                  placeholder={label}
                  inputMode="decimal"
                  className="flex-1 min-w-[160px]"
                  value={form[k]}
                  onChange={set(k)}
                />
              ))}
            </div>
          )}
          <Input aria-label="Home office notes" placeholder="Notes (optional)" value={form.notes} onChange={set("notes")} />
          <div className="text-sm" data-testid="home-office-deduction">
            Deduction for {year}: <strong>{money(previewDeduction(form))}</strong>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy || loading}>Save home office</Button>
            {saved && <Button variant="secondary" disabled={busy || loading} onClick={remove}>Remove {year}</Button>}
            {loading && error && <Button variant="secondary" onClick={load}>Try again</Button>}
          </div>
        </form>
        {notice && <div className="text-sm text-ink-secondary">{notice}</div>}
        {error && <ActionFeedback error>{error}</ActionFeedback>}
      </CardBody>
    </Card>
  );
}

export default function SharedBillsPanel() {
  const [enabled, setEnabled] = useState(false);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    let live = true;
    adminFetch(`${T}/shared-bills/status`)
      .then((d) => { if (live) setEnabled(!!d?.enabled); })
      .catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    adminFetch(`${T}/expense-categories`)
      .then((d) => setCategories(d.categories || []))
      .catch(() => setCategories([]));
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <BillsBox categories={categories} />
      <HomeOfficeBox />
    </div>
  );
}
