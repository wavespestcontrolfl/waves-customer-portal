import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ActionFeedback,
  Badge,
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

// Tax ledger Inbox: bank rows the rules could not settle on their own.
// Built on the shared V2 primitives (same surface as the rest of the Tax
// page); the owner reviews on a phone, so every control keeps its touch
// height and nothing scrolls sideways.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const PAGE = 50;
const KINDS = ["expense", "personal", "transfer", "income", "review"];
const VIEWS = [["open", "Open"], ["later", "Later"], ["income", "Income"]];
const EMPTY = { open: "Nothing to review.", later: "Nothing set aside for later.", income: "No receipts outside the processor." };

// Same helper as TaxPage.jsx (not imported: that would be a circular import).
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

const T = "/admin/tax/bank-import";

function fmtAmount(r) {
  const n = Math.abs(parseFloat(r.amount));
  const txt = Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(r.amount);
  return `${r.direction === "credit" ? "+" : "-"}$${txt}`;
}

// The API sends the calendar day as text; a Date that slipped through as an
// ISO timestamp still reads as its day, never shifted by the viewer's zone.
function fmtDate(v) {
  return String(v || "").slice(0, 10);
}

// The owner's decision first; a rule's label only while nothing was decided.
function chipText(sug) {
  if (!sug) return "";
  const kind = sug.decision || sug.rule?.kind || (sug.income ? "income" : sug.ignore ? "transfer" : sug.personal ? "personal" : "review");
  return [kind, sug.decision ? null : sug.categoryName].filter(Boolean).join(" · ");
}

function RowHeader({ row }) {
  const sug = row.suggestion || null;
  const note = sug && (sug.rule?.note || sug.reason);
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink-secondary shrink-0">{fmtDate(row.txn_date)}</span>
        <strong className="text-base shrink-0">{fmtAmount(row)}</strong>
      </div>
      <div className="font-semibold [overflow-wrap:anywhere]">{row.description}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{row.account_label}</Badge>
        {sug && <Badge tone="strong">{chipText(sug)}</Badge>}
      </div>
      {note && <div className="text-sm text-ink-secondary [overflow-wrap:anywhere]">{note}</div>}
    </>
  );
}

// Category pick + Business, for money out only (a credit is never an expense).
function BusinessAction({ row, categories, categoryId, onCategory, busy, onAct }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Category"
        className="flex-1 min-w-[160px]"
        value={categoryId}
        disabled={busy}
        onChange={(e) => onCategory(e.target.value)}
      >
        <option value="">Choose category…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Button variant="primary" disabled={busy} onClick={() => onAct(row, "expense")}>
        Business
      </Button>
    </div>
  );
}

// The shelf and park actions a row may take: no Income on money out, no
// Later or Recorded while Always is checked (neither makes a rule: the
// server would save the decision and no rule, and the owner would believe
// the payee is handled), and never the shelf the row is already on.
// A receipt on the Income shelf can also be marked recorded once its sale
// (invoice and payment) is in the portal: that settles the row.
function shelfActions(row, view, always) {
  const all = ["personal", "transfer", ...(row.direction === "credit" ? ["income"] : []), ...(always ? [] : ["later"]), ...(view === "income" && !always ? ["recorded"] : [])];
  return all.filter((d) => d !== view);
}

function ShelfActions({ row, view, always, busy, onAct }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {shelfActions(row, view, always).map((d) => (
        <Button key={d} variant="secondary" disabled={busy} onClick={() => onAct(row, d)}>
          {d[0].toUpperCase() + d.slice(1)}
        </Button>
      ))}
    </div>
  );
}

function InboxRow({ row, categories, busy, error, onAct, view = "open" }) {
  const sug = row.suggestion || null;
  const suggestedCategoryId = sug?.categoryId || "";
  const [categoryId, setCategoryId] = useState(suggestedCategoryId);
  const [touched, setTouched] = useState(false);
  const [always, setAlways] = useState(false);
  // a rule pass can refresh the suggestion under a mounted row: an untouched
  // selection follows it, a selection the owner made stays
  useEffect(() => {
    if (!touched) setCategoryId(suggestedCategoryId);
  }, [suggestedCategoryId, touched]);
  const act = (r, decision) => onAct(r, decision, { categoryId, always });
  return (
    <Card data-testid={`ledger-row-${row.id}`}>
      <CardBody className="flex flex-col gap-2 min-w-0">
        <RowHeader row={row} />
        {row.direction !== "credit" && (
          <BusinessAction
            row={row}
            categories={categories}
            categoryId={categoryId}
            onCategory={(v) => { setTouched(true); setCategoryId(v); }}
            busy={busy}
            onAct={act}
          />
        )}
        <ShelfActions row={row} view={view} always={always} busy={busy} onAct={act} />
        <Checkbox
          id={`always-${row.id}`}
          label="Always treat this payee this way (not for Later or Recorded)"
          checked={always}
          disabled={busy}
          onChange={(e) => setAlways(e.target.checked)}
        />
        {error && <ActionFeedback error>{error}</ActionFeedback>}
      </CardBody>
    </Card>
  );
}

function RulesTable({ rules, busy, onToggle }) {
  if (rules.length === 0) return <div className="text-sm text-ink-secondary">No rules yet.</div>;
  return (
    <div className="overflow-x-auto max-w-full">
      <Table>
        <THead>
          <TR>
            <TH>Pattern</TH>
            <TH>Kind</TH>
            <TH>Category</TH>
            <TH>Priority</TH>
            <TH>Hits</TH>
            <TH>On</TH>
          </TR>
        </THead>
        <TBody>
          {rules.map((r) => (
            <TR key={r.id}>
              <TD className="[overflow-wrap:anywhere]">{r.pattern}</TD>
              <TD>{r.kind}</TD>
              <TD>{r.category_name || "-"}</TD>
              <TD>{r.priority}</TD>
              <TD>{r.hits ?? 0}</TD>
              <TD>
                <Checkbox
                  role="switch"
                  aria-label={`Enable rule ${r.pattern}`}
                  checked={!!r.enabled}
                  disabled={busy}
                  onChange={() => onToggle(r)}
                />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function RulesPanel({ categories }) {
  const [rules, setRules] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ pattern: "", kind: "expense", categoryId: "", note: "", priority: 10 });

  const load = useCallback(() => {
    adminFetch(`${T}/ledger/rules`)
      .then((d) => setRules(d.rules || []))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (rule) => {
    setBusy(true);
    setError("");
    try {
      await put(`${T}/ledger/rules/${rule.id}`, { enabled: !rule.enabled });
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async (e) => {
    e.preventDefault();
    if (!form.pattern.trim()) { setError("Enter a pattern."); return; }
    if (form.kind === "expense" && !form.categoryId) { setError("Choose a category for an expense rule."); return; }
    // 0 is a valid priority (lower runs first): only a blank field means the default
    const priority = String(form.priority).trim() === "" ? 10 : Number(form.priority);
    if (!Number.isFinite(priority)) { setError("Priority must be a number (lower runs first; blank means 10)."); return; }
    setBusy(true);
    setError("");
    try {
      const body = { pattern: form.pattern.trim(), kind: form.kind, priority };
      if (form.kind === "expense") body.categoryId = form.categoryId;
      if (form.note.trim()) body.note = form.note.trim();
      await post(`${T}/ledger/rules`, body);
      setForm({ pattern: "", kind: "expense", categoryId: "", note: "", priority: 10 });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Card>
      <CardBody className="flex flex-col gap-3 min-w-0">
        <RulesTable rules={rules} busy={busy} onToggle={toggle} />
        <form onSubmit={add} className="flex flex-col gap-2">
          <strong>Add rule</strong>
          <Input aria-label="Pattern" placeholder="Pattern" value={form.pattern} onChange={set("pattern")} />
          <div className="text-sm text-ink-secondary">
            The pattern is a case-insensitive regular expression matched against the bank description.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Kind" className="flex-1 min-w-[120px]" value={form.kind} onChange={set("kind")}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
            {form.kind === "expense" && (
              <Select aria-label="Rule category" className="flex-1 min-w-[160px]" value={form.categoryId} onChange={set("categoryId")}>
                <option value="">Choose category…</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}
          </div>
          <Input aria-label="Note" placeholder="Note (optional)" value={form.note} onChange={set("note")} />
          <label className="flex items-center gap-2 text-sm">
            Priority
            <Input aria-label="Priority" type="number" className="w-24" value={form.priority} onChange={set("priority")} />
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={busy}>Add rule</Button>
          </div>
        </form>
        {error && <ActionFeedback error>{error}</ActionFeedback>}
      </CardBody>
    </Card>
  );
}

function StatusBar({ status, applying, onApply }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <strong className="flex-1 min-w-[180px]">
        {status.inbox} rows to review · {status.rules} rules{status.income ? ` · ${status.income} income` : ""}
      </strong>
      <Button variant="secondary" disabled={applying} onClick={onApply}>
        {applying ? "Applying…" : "Apply rules now"}
      </Button>
    </div>
  );
}

function ViewSwitch({ view, onView }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="View">
      {VIEWS.map(([v, label]) => (
        <Button
          key={v}
          variant={view === v ? "primary" : "secondary"}
          aria-label={`${label} view`}
          aria-pressed={view === v}
          onClick={() => onView(v)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function InboxNotices({ status, view, notice, loadError, categoryError, onRetryCategories }) {
  return (
    <>
      {status.unexamined > 0 && (
        <div className="text-sm text-ink-secondary">
          {plural(status.unexamined, "row waits", "rows wait")} for the matcher (next sync). A row is shown here only after the matcher found nothing already booked for it.
        </div>
      )}
      {status.bankImport > 0 && (
        <div className="text-sm text-ink-secondary">
          {plural(status.bankImport, "row waits", "rows wait")} in Bank Import: each may match an expense or payout that is already booked, so the link decision is made there.
        </div>
      )}
      {view === "income" && (
        <div className="text-sm text-ink-secondary">
          Receipts outside the processor. They are not in the P&amp;L or any report. Record each one as an invoice and payment, or it waits here for the return engine.
        </div>
      )}
      {notice && <div className="text-sm text-ink-secondary">{notice}</div>}
      {categoryError && (
        <ActionFeedback error onRetry={onRetryCategories}>
          Categories did not load ({categoryError}); Business needs them.
        </ActionFeedback>
      )}
      {loadError && <ActionFeedback error>{loadError}</ActionFeedback>}
    </>
  );
}

// One click follows the server's cursor for up to this many pages (a
// safety stop, not a limit: the cursor it stopped at is kept and the next
// click resumes there, so no row is ever out of reach of Apply rules now).
const MAX_ROUNDS_PER_CLICK = 400;
// Follows the server's cursor from startAfter; returns the totals and the
// cursor to resume from when the per-click stop came first (null = done).
async function runRulePass(onProgress, startAfter = null) {
  const sum = { examined: 0, suggested: 0, cleared: 0 };
  let after = startAfter;
  let rounds = 0;
  do {
    const d = await post(`${T}/ledger/rules/apply`, after ? { after } : {});
    sum.examined += d.examined || 0;
    sum.suggested += d.suggested || 0;
    sum.cleared += d.cleared || 0;
    after = d.more && d.cursor ? d.cursor : null;
    rounds += 1;
    onProgress(`Examined ${sum.examined}, suggested ${sum.suggested}, cleared ${sum.cleared}${after ? "…" : "."}`);
  } while (after && rounds < MAX_ROUNDS_PER_CLICK);
  return { sum, after };
}

export default function LedgerInboxTab() {
  const [status, setStatus] = useState(null);
  const [view, setView] = useState("open");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  const [categoryError, setCategoryError] = useState("");
  const [categoryAttempt, setCategoryAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  // one entry per row with a request in flight: acting on row B must not
  // re-enable row A while A's request is still running
  const [busyIds, setBusyIds] = useState(() => new Set());
  const setBusy = (id, on) => setBusyIds((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  const [rowErrors, setRowErrors] = useState({});
  const [notice, setNotice] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [applying, setApplying] = useState(false);
  const seq = useRef(0);
  // the view the user is looking at NOW: an action that finishes after a
  // view switch must not reload or edit the old view's rows into the new one
  const viewRef = useRef(view);
  // where the last Apply rules now stopped (null = it finished): the next
  // click continues from there instead of starting over
  const resumeRef = useRef(null);
  // rows this view settled locally: a full reload (after an Always
  // decision) may have read the list before another row's decision
  // committed, and its response must not bring that row back
  const settledRef = useRef(new Set());
  useEffect(() => { viewRef.current = view; }, [view]);

  const loadStatus = useCallback(() => {
    return adminFetch(`${T}/ledger/status`)
      .then(setStatus)
      .catch((e) => setLoadError(e.message));
  }, []);

  const loadRows = useCallback((v, offset) => {
    const my = ++seq.current;
    setLoading(true);
    setLoadError("");
    return adminFetch(`${T}/ledger/inbox?limit=${PAGE}&offset=${offset}&view=${v}`)
      .then((d) => {
        if (my !== seq.current) return;
        const fresh = (d.rows || []).filter((r) => !settledRef.current.has(r.id));
        const revived = (d.rows || []).length - fresh.length;
        setRows((prev) => (offset === 0 ? fresh : [...prev, ...fresh]));
        setTotal(Math.max(0, (d.total || 0) - revived));
      })
      .catch((e) => { if (my === seq.current) setLoadError(e.message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // the category list has its own error and retry: a row load never clears it
  useEffect(() => {
    setCategoryError("");
    adminFetch("/admin/tax/expense-categories")
      .then((d) => setCategories(d.categories || []))
      .catch((e) => setCategoryError(e.message));
  }, [categoryAttempt]);

  const enabled = status?.enabled;
  // a view change shows nothing of the previous shelf while the new one loads
  useEffect(() => {
    if (!enabled) return;
    settledRef.current = new Set();
    setRows([]);
    setTotal(0);
    loadRows(view, 0);
  }, [enabled, view, loadRows]);

  const act = async (row, decision, { categoryId, always }) => {
    if (decision === "expense" && !categoryId) {
      setRowErrors((p) => ({ ...p, [row.id]: "Choose a category first." }));
      return;
    }
    setBusy(row.id, true);
    setRowErrors((p) => ({ ...p, [row.id]: "" }));
    try {
      // the server answers propagated:false when the Always rule was saved
      // but its pass over the payee's other rows stopped short or failed
      let propagated = true;
      if (decision === "expense") {
        // decide re-checks the row is still the Inbox's to decide (the matcher
        // examined it, no existing expense or payout to link); create-expense
        // checks again inside its claim and writes the Always rule itself
        await post(`${T}/ledger/decide`, { id: row.id, decision, categoryId });
        const made = await post(`${T}/${row.id}/create-expense`, { categoryId, fromLedger: true, always: !!always });
        propagated = made?.propagated !== false;
      } else {
        const decided = await post(`${T}/ledger/decide`, { id: row.id, decision, always: !!always });
        propagated = decided?.propagated !== false;
      }
      if (always && !propagated) {
        setNotice("Decision saved, but not every open row of this payee was updated yet. Click Apply rules now to finish.");
      }
      // a decision that keeps the row on the current shelf, or an Always
      // decision (the new rule has just re-labelled every other row of that
      // payee), reloads the view instead of hiding the row
      if (viewRef.current !== view) {
        // the user moved on: the new view already loaded its own rows
      } else if (decision === view || always) {
        await loadRows(view, 0);
      } else {
        settledRef.current.add(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        setTotal((t) => Math.max(0, t - 1));
      }
      loadStatus();
    } catch (e) {
      setRowErrors((p) => ({ ...p, [row.id]: e.message }));
    } finally {
      setBusy(row.id, false);
    }
  };

  const applyRules = async () => {
    setApplying(true);
    setNotice("");
    try {
      const { sum, after } = await runRulePass(setNotice, resumeRef.current);
      resumeRef.current = after;
      setNotice(`Examined ${sum.examined}, suggested ${sum.suggested}, cleared ${sum.cleared}.${after ? " More rows remain: click Apply rules now again to continue from where this stopped." : ""}`);
      await loadStatus();
      // the view the user is on now, not the one the pass started from
      await loadRows(viewRef.current, 0);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setApplying(false);
    }
  };

  if (!status) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        {loadError ? <ActionFeedback error>{loadError}</ActionFeedback> : <div className="text-ink-secondary">Loading…</div>}
      </div>
    );
  }
  if (!status.enabled) {
    return <div className="flex flex-col gap-3 text-sm"><div>The tax ledger is off (GATE_TAX_LEDGER).</div></div>;
  }

  return (
    <div className="flex flex-col gap-3 text-sm min-w-0">
      <StatusBar status={status} applying={applying} onApply={applyRules} />
      <ViewSwitch view={view} onView={setView} />
      <InboxNotices
        status={status}
        view={view}
        notice={notice}
        loadError={loadError}
        categoryError={categoryError}
        onRetryCategories={() => setCategoryAttempt((n) => n + 1)}
      />

      {/* a page request and a decision never overlap: Load more reads from
          the current list length, and a row removed while that read runs
          would shift the next page by one (a row skipped for good) */}
      {rows.map((r) => (
        <InboxRow
          key={r.id}
          row={r}
          view={view}
          categories={categories}
          busy={loading || busyIds.has(r.id)}
          error={rowErrors[r.id]}
          onAct={act}
        />
      ))}
      {!loading && rows.length === 0 && !loadError && <div className="text-ink-secondary">{EMPTY[view]}</div>}
      {loading && <div className="text-ink-secondary">Loading…</div>}
      {!loading && rows.length < total && (
        <div>
          <Button variant="secondary" disabled={busyIds.size > 0} onClick={() => loadRows(view, rows.length)}>Load more</Button>
        </div>
      )}

      <div>
        <Button variant="secondary" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>
          {showRules ? "Hide rules" : "Rules"}
        </Button>
      </div>
      {showRules && <RulesPanel categories={categories} />}
    </div>
  );
}
