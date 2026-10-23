import React, { useState, useEffect, useCallback, useRef } from "react";

// Tax ledger Inbox: bank rows the rules could not settle on their own.
// The owner reviews on a phone: 14px minimum text, 40px minimum controls,
// no horizontal overflow.

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const PAGE = 50;
const KINDS = ["expense", "personal", "transfer", "income", "review"];

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

const post = (path, body) =>
  adminFetch(path, { method: "POST", body: JSON.stringify(body) });
const put = (path, body) =>
  adminFetch(path, { method: "PUT", body: JSON.stringify(body) });

const T = "/admin/tax/bank-import";

const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 12, fontSize: 14, color: "#18181b", minWidth: 0 },
  card: { background: "#fff", border: "1px solid #e4e4e7", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 },
  chip: { display: "inline-block", fontSize: 14, padding: "2px 8px", borderRadius: 999, background: "#f4f4f5", border: "1px solid #e4e4e7", maxWidth: "100%", overflowWrap: "anywhere" },
  small: { fontSize: 14, color: "#52525b", overflowWrap: "anywhere" },
  btn: { minHeight: 40, padding: "0 14px", fontSize: 14, fontWeight: 600, borderRadius: 6, border: "1px solid #d4d4d8", background: "#fff", color: "#18181b", cursor: "pointer" },
  btnPrimary: { background: "#18181b", color: "#fff", border: "1px solid #18181b" },
  input: { minHeight: 40, padding: "0 10px", fontSize: 14, borderRadius: 6, border: "1px solid #d4d4d8", background: "#fff", color: "#18181b", boxSizing: "border-box", minWidth: 0, maxWidth: "100%" },
  err: { color: "#b91c1c", fontSize: 14, overflowWrap: "anywhere" },
  check: { display: "flex", alignItems: "center", gap: 8, minHeight: 40, fontSize: 14 },
};

function fmtAmount(r) {
  const n = Math.abs(parseFloat(r.amount));
  const txt = Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(r.amount);
  return `${r.direction === "credit" ? "+" : "-"}$${txt}`;
}

function InboxRow({ row, categories, busy, error, onAct, view = "open" }) {
  const sug = row.suggestion || null;
  const [categoryId, setCategoryId] = useState(sug?.categoryId || "");
  const [touched, setTouched] = useState(false);
  const suggestedCategoryId = sug?.categoryId || "";
  // a rule pass can refresh the suggestion under a mounted row: an untouched
  // selection follows it, a selection the owner made stays
  useEffect(() => {
    if (!touched) setCategoryId(suggestedCategoryId);
  }, [suggestedCategoryId, touched]);
  const [always, setAlways] = useState(false);
  const off = busy;
  // the owner's decision first; a rule's label only while nothing was decided
  const kindLabel = sug
    ? sug.decision || sug.rule?.kind || (sug.income ? "income" : sug.ignore ? "transfer" : sug.personal ? "personal" : "review")
    : "";
  const chipText = sug ? [kindLabel, sug.decision ? null : sug.categoryName].filter(Boolean).join(" · ") : "";
  return (
    <div style={s.card} data-testid={`ledger-row-${row.id}`}>
      <div style={{ ...s.row, justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span style={{ ...s.small, flexShrink: 0 }}>{row.txn_date}</span>
        <strong style={{ fontSize: 16, flexShrink: 0 }}>{fmtAmount(row)}</strong>
      </div>
      <div style={{ overflowWrap: "anywhere", fontWeight: 600 }}>{row.description}</div>
      <div style={s.row}>
        <span style={s.chip}>{row.account_label}</span>
        {sug && <span style={{ ...s.chip, background: "#eff6ff", borderColor: "#bfdbfe" }}>{chipText}</span>}
      </div>
      {sug && (sug.rule?.note || sug.reason) && (
        <div style={s.small}>{sug.rule?.note || sug.reason}</div>
      )}
      {row.direction !== "credit" && (
      <div style={s.row}>
        <select
          aria-label="Category"
          style={{ ...s.input, flex: "1 1 160px" }}
          value={categoryId}
          disabled={off}
          onChange={(e) => { setTouched(true); setCategoryId(e.target.value); }}
        >
          <option value="">Choose category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          style={{ ...s.btn, ...s.btnPrimary }}
          disabled={off}
          onClick={() => onAct(row, "expense", { categoryId, always })}
        >
          Business
        </button>
      </div>
      )}
      <div style={s.row}>
        {["personal", "transfer", ...(row.direction === "credit" ? ["income"] : []), ...(always ? [] : ["later"])]
          .filter((d) => d !== view) // a row on a shelf is not offered that same shelf again; Later never makes a rule
          .map((d) => (
          <button
            key={d}
            type="button"
            style={s.btn}
            disabled={off}
            onClick={() => onAct(row, d, { always })}
          >
            {d[0].toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <label style={s.check}>
        <input
          type="checkbox"
          style={{ width: 20, height: 20 }}
          checked={always}
          disabled={off}
          onChange={(e) => setAlways(e.target.checked)}
        />
        Always treat this payee this way (not for Later)
      </label>
      {error && <div role="alert" style={s.err}>{error}</div>}
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
    setBusy(true);
    setError("");
    try {
      const body = { pattern: form.pattern.trim(), kind: form.kind, priority: Number(form.priority) || 10 };
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
    <div style={s.card}>
      {rules.length === 0 ? (
        <div style={s.small}>No rules yet.</div>
      ) : (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#52525b" }}>
                <th style={{ padding: 6 }}>Pattern</th>
                <th style={{ padding: 6 }}>Kind</th>
                <th style={{ padding: 6 }}>Category</th>
                <th style={{ padding: 6 }}>Priority</th>
                <th style={{ padding: 6 }}>Hits</th>
                <th style={{ padding: 6 }}>On</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #e4e4e7" }}>
                  <td style={{ padding: 6, overflowWrap: "anywhere" }}>{r.pattern}</td>
                  <td style={{ padding: 6 }}>{r.kind}</td>
                  <td style={{ padding: 6 }}>{r.category_name || "-"}</td>
                  <td style={{ padding: 6 }}>{r.priority}</td>
                  <td style={{ padding: 6 }}>{r.hits ?? 0}</td>
                  <td style={{ padding: 6 }}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Enable rule ${r.pattern}`}
                      style={{ width: 24, height: 24 }}
                      checked={!!r.enabled}
                      disabled={busy}
                      onChange={() => toggle(r)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <strong>Add rule</strong>
        <input
          aria-label="Pattern"
          placeholder="Pattern"
          style={s.input}
          value={form.pattern}
          onChange={set("pattern")}
        />
        <div style={s.small}>The pattern is a case-insensitive regular expression matched against the bank description.</div>
        <div style={s.row}>
          <select aria-label="Kind" style={{ ...s.input, flex: "1 1 120px" }} value={form.kind} onChange={set("kind")}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {form.kind === "expense" && (
            <select aria-label="Rule category" style={{ ...s.input, flex: "1 1 160px" }} value={form.categoryId} onChange={set("categoryId")}>
              <option value="">Choose category…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        <input aria-label="Note" placeholder="Note (optional)" style={s.input} value={form.note} onChange={set("note")} />
        <label style={s.row}>
          Priority
          <input aria-label="Priority" type="number" style={{ ...s.input, width: 90 }} value={form.priority} onChange={set("priority")} />
        </label>
        <div>
          <button type="submit" style={{ ...s.btn, ...s.btnPrimary }} disabled={busy}>Add rule</button>
        </div>
      </form>
      {error && <div role="alert" style={s.err}>{error}</div>}
    </div>
  );
}

export default function LedgerInboxTab() {
  const [status, setStatus] = useState(null);
  const [view, setView] = useState("open");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [rowErrors, setRowErrors] = useState({});
  const [notice, setNotice] = useState("");
  const [showRules, setShowRules] = useState(false);
  const [applying, setApplying] = useState(false);
  const seq = useRef(0);

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
        setRows((prev) => (offset === 0 ? d.rows || [] : [...prev, ...(d.rows || [])]));
        setTotal(d.total || 0);
      })
      .catch((e) => { if (my === seq.current) setLoadError(e.message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    adminFetch("/admin/tax/expense-categories")
      .then((d) => setCategories(d.categories || []))
      .catch((e) => setLoadError(e.message));
  }, []);

  const enabled = status?.enabled;
  useEffect(() => {
    if (enabled) loadRows(view, 0);
  }, [enabled, view, loadRows]);

  const act = async (row, decision, { categoryId, always }) => {
    if (decision === "expense" && !categoryId) {
      setRowErrors((p) => ({ ...p, [row.id]: "Choose a category first." }));
      return;
    }
    setBusyId(row.id);
    setRowErrors((p) => ({ ...p, [row.id]: "" }));
    try {
      if (decision === "expense") {
        // decide re-checks the row is still the Inbox's to decide (the matcher
        // examined it, no existing expense or payout to link); create-expense
        // checks again inside its claim
        await post(`${T}/ledger/decide`, { id: row.id, decision, categoryId });
        // the Always rule is written by create-expense itself, once the expense exists
        await post(`${T}/${row.id}/create-expense`, { categoryId, fromLedger: true, always: !!always });
      } else {
        await post(`${T}/ledger/decide`, { id: row.id, decision, always: !!always });
      }
      // a decision that keeps the row on the current shelf reloads the view
      // instead of hiding the row (an unrecorded receipt must stay visible);
      // an Always decision reloads too, because the new rule has just
      // re-labelled every other row of that payee on the server
      const stays = decision === view;
      if (stays || always) {
        await loadRows(view, 0);
      } else {
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        setTotal((t) => Math.max(0, t - 1));
      }
      loadStatus();
    } catch (e) {
      setRowErrors((p) => ({ ...p, [row.id]: e.message }));
    } finally {
      setBusyId(null);
    }
  };

  const applyRules = async () => {
    setApplying(true);
    setNotice("");
    try {
      // one pass is bounded; follow the cursor until the server says there is no more
      const sum = { examined: 0, suggested: 0, cleared: 0 };
      let after = null;
      let rounds = 0;
      do {
        const d = await post(`${T}/ledger/rules/apply`, after ? { after } : {});
        sum.examined += d.examined || 0;
        sum.suggested += d.suggested || 0;
        sum.cleared += d.cleared || 0;
        after = d.more && d.cursor ? d.cursor : null;
        rounds += 1;
        setNotice(`Examined ${sum.examined}, suggested ${sum.suggested}, cleared ${sum.cleared}${after ? "…" : "."}`);
      } while (after && rounds < 40);
      await loadStatus();
      await loadRows(view, 0);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setApplying(false);
    }
  };

  if (!status) {
    return <div style={s.wrap}>{loadError ? <div role="alert" style={s.err}>{loadError}</div> : <div style={s.small}>Loading…</div>}</div>;
  }
  if (!status.enabled) {
    return <div style={s.wrap}><div>The tax ledger is off (GATE_TAX_LEDGER).</div></div>;
  }

  return (
    <div style={s.wrap}>
      <div style={s.row}>
        <strong style={{ flex: "1 1 180px" }}>
          {status.inbox} rows to review · {status.rules} rules{status.income ? ` · ${status.income} income` : ""}
        </strong>
        <button type="button" style={s.btn} disabled={applying} onClick={applyRules}>
          {applying ? "Applying…" : "Apply rules now"}
        </button>
      </div>
      <div style={s.row} role="group" aria-label="View">
        {[["open", "Open"], ["later", "Later"], ["income", "Income"]].map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-label={`${label} view`}
            aria-pressed={view === v}
            style={{ ...s.btn, ...(view === v ? s.btnPrimary : {}) }}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </div>
      {status.unexamined > 0 && (
        <div style={s.small}>
          {status.unexamined} {status.unexamined === 1 ? "row waits" : "rows wait"} for the matcher (next sync). A row is shown here only after the matcher found nothing already booked for it.
        </div>
      )}
      {status.bankImport > 0 && (
        <div style={s.small}>
          {status.bankImport} {status.bankImport === 1 ? "row waits" : "rows wait"} in Bank Import: each may match an expense or payout that is already booked, so the link decision is made there.
        </div>
      )}
      {view === "income" && (
        <div style={s.small}>
          Receipts outside the processor. They are not in the P&amp;L or any report. Record each one as an invoice and payment, or it waits here for the return engine.
        </div>
      )}
      {notice && <div style={s.small}>{notice}</div>}
      {loadError && <div role="alert" style={s.err}>{loadError}</div>}

      {rows.map((r) => (
        <InboxRow
          key={r.id}
          row={r}
          view={view}
          categories={categories}
          busy={busyId === r.id}
          error={rowErrors[r.id]}
          onAct={act}
        />
      ))}
      {!loading && rows.length === 0 && !loadError && (
        <div style={s.small}>
          {view === "later" ? "Nothing set aside for later." : view === "income" ? "No receipts outside the processor." : "Nothing to review."}
        </div>
      )}
      {loading && <div style={s.small}>Loading…</div>}
      {!loading && rows.length < total && (
        <div>
          <button type="button" style={s.btn} onClick={() => loadRows(view, rows.length)}>
            Load more
          </button>
        </div>
      )}

      <div>
        <button
          type="button"
          style={s.btn}
          aria-expanded={showRules}
          onClick={() => setShowRules((v) => !v)}
        >
          {showRules ? "Hide rules" : "Rules"}
        </button>
      </div>
      {showRules && <RulesPanel categories={categories} />}
    </div>
  );
}
