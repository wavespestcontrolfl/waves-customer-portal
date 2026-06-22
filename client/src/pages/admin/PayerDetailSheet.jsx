/**
 * Payer detail — statements, AR/aging, and operator actions (Phase 2 — P5 UI).
 *
 * Opened from the Payers list. Surfaces the NET-terms statement lane the P1–P4
 * backend already supports but nothing rendered yet: per-payer statements (with
 * aging), the close → send → reconcile lifecycle, statement-level dunning
 * controls, and the payer's AR aging.
 *
 * Read paths are gate-dark safe (return empty until GATE_PAYER_STATEMENTS is on);
 * the mutating actions surface the server's 403 ("not enabled") rather than
 * pretending to work. Tier 1 V2 — components/ui + Tailwind zinc; `alert-fg` only
 * for genuinely overdue/past-due amounts.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetHeader,
  SheetBody,
  Button,
  Badge,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Select,
  Input,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";

const money = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// DATE columns arrive as 'YYYY-MM-DD' (or a midnight-UTC ISO) — render in UTC so
// a date never shifts a day in the browser's local zone.
const dateOnly = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "—";

const STATUS_TONE = {
  open: "neutral",
  finalized: "neutral",
  sent: "strong",
  viewed: "strong",
  processing: "neutral",
  paid: "strong",
  void: "neutral",
};
const STATUS_LABEL = {
  open: "Open (accruing)",
  finalized: "Closed",
  sent: "Sent",
  viewed: "Viewed",
  processing: "Payment processing",
  paid: "Paid",
  void: "Void",
};

const OUTSTANDING = new Set(["finalized", "sent", "viewed", "processing"]);
const DUNNABLE = new Set(["sent", "viewed"]);

export default function PayerDetailSheet({ payer, onClose, onChanged }) {
  const [tab, setTab] = useState("statements");
  const [statements, setStatements] = useState([]);
  const [ar, setAr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openStmtId, setOpenStmtId] = useState(null);

  const loadStatements = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminFetch(`/admin/payers/${payer.id}/statements`);
      const d = await r.json();
      setStatements(Array.isArray(d?.statements) ? d.statements : []);
    } catch {
      setStatements([]);
    } finally {
      setLoading(false);
    }
  }, [payer.id]);

  const loadAr = useCallback(async () => {
    try {
      const r = await adminFetch(`/admin/payers/${payer.id}/ar`);
      setAr(await r.json());
    } catch {
      setAr(null);
    }
  }, [payer.id]);

  useEffect(() => {
    loadStatements();
    loadAr();
  }, [loadStatements, loadAr]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStatements(), loadAr()]);
    if (onChanged) onChanged();
  }, [loadStatements, loadAr, onChanged]);

  return (
    <Sheet open onClose={onClose} width="lg">
      <SheetHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-16 font-medium text-zinc-900">{payer.display_name}</h2>
            {payer.company_name && payer.company_name !== payer.display_name && (
              <p className="text-12 text-zinc-500">{payer.company_name}</p>
            )}
            <p className="text-12 text-zinc-500 mt-0.5">
              {payer.ap_email || "no AP email"} · {termLabel(payer.payment_terms)}
            </p>
          </div>
          {ar?.summary && (
            <div className="text-right shrink-0">
              <div className="text-11 text-zinc-500 uppercase tracking-label">Outstanding</div>
              <div className="text-16 font-medium text-zinc-900">{money(ar.summary.outstanding_total)}</div>
              {ar.summary.past_due_total > 0 && (
                <div className="text-12 text-alert-fg">{money(ar.summary.past_due_total)} past due</div>
              )}
            </div>
          )}
        </div>
      </SheetHeader>
      <SheetBody>
        <Tabs value={tab} onValueChange={setTab}>
          <TabList>
            <Tab value="statements">Statements</Tab>
            <Tab value="ar">AR / aging</Tab>
          </TabList>

          <TabPanel value="statements" className="pt-3">
            {loading ? (
              <p className="text-13 text-zinc-400 py-4">Loading statements…</p>
            ) : statements.length === 0 ? (
              <p className="text-13 text-zinc-400 py-4">
                No statements yet. NET-terms visits accrue here once payer statements are enabled.
              </p>
            ) : (
              <div className="divide-y divide-zinc-100 border-hairline rounded-sm">
                {statements.map((s) => (
                  <StatementRow
                    key={s.id}
                    payerId={payer.id}
                    statement={s}
                    expanded={openStmtId === s.id}
                    onToggle={() => setOpenStmtId(openStmtId === s.id ? null : s.id)}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </TabPanel>

          <TabPanel value="ar" className="pt-3">
            <ArSummary summary={ar?.summary} />
          </TabPanel>
        </Tabs>
      </SheetBody>
    </Sheet>
  );
}

function termLabel(v) {
  return { due_on_receipt: "Due on receipt", net15: "Net 15", net30: "Net 30" }[v] || v || "—";
}

function StatementRow({ payerId, statement, expanded, onToggle, onChanged }) {
  const overdue =
    statement.overdue && OUTSTANDING.has(statement.status) && statement.status !== "paid";
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-zinc-50"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-zinc-900 text-13">S-{statement.id}</span>
            <Badge tone={STATUS_TONE[statement.status] || "neutral"}>
              {STATUS_LABEL[statement.status] || statement.status}
            </Badge>
            {overdue && (
              <Badge tone="alert">{statement.days_past_due}d past due</Badge>
            )}
          </div>
          <div className="text-12 text-zinc-500 mt-0.5">
            {dateOnly(statement.period_start)} – {dateOnly(statement.period_end)} ·{" "}
            {statement.invoice_count || 0} visit{(statement.invoice_count || 0) === 1 ? "" : "s"}
            {statement.due_date ? ` · due ${dateOnly(statement.due_date)}` : ""}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-medium text-zinc-900 text-13">{money(statement.total)}</div>
          <div className="text-11 text-zinc-400">{expanded ? "Hide" : "Details"}</div>
        </div>
      </button>
      {expanded && (
        <StatementDetail payerId={payerId} statement={statement} onChanged={onChanged} />
      )}
    </div>
  );
}

function StatementDetail({ payerId, statement, onChanged }) {
  const [lines, setLines] = useState(null);
  const [sequence, setSequence] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null); // { tone: 'ok'|'err', text }
  const [reconcileOpen, setReconcileOpen] = useState(false);

  const base = `/admin/payers/${payerId}/statements/${statement.id}`;

  const loadDetail = useCallback(async () => {
    try {
      const r = await adminFetch(base);
      const d = await r.json();
      setLines(Array.isArray(d?.lines) ? d.lines : []);
    } catch {
      setLines([]);
    }
    try {
      const r2 = await adminFetch(`${base}/followups`);
      const d2 = await r2.json();
      setSequence(d2?.sequence ?? null);
    } catch {
      setSequence(null);
    }
  }, [base]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  async function act(label, path, body) {
    setBusy(label);
    setNotice(null);
    try {
      const r = await adminFetch(path, { method: "POST", body: body || {} });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({ tone: "err", text: d?.error || "Action failed." });
      } else {
        setNotice({ tone: "ok", text: `${label} ✓` });
        await loadDetail();
        if (onChanged) onChanged();
      }
    } catch {
      setNotice({ tone: "err", text: "Network error." });
    } finally {
      setBusy("");
    }
  }

  const status = statement.status;
  const canClose = status === "open";
  const canSend = ["finalized", "sent", "viewed"].includes(status);
  const canReconcile = ["finalized", "sent", "viewed"].includes(status);
  const showDunning = DUNNABLE.has(status) || (sequence && sequence.status);

  return (
    <div className="px-3 pb-3 pt-1 bg-zinc-50/60">
      {/* Visit lines */}
      {lines === null ? (
        <p className="text-12 text-zinc-400 py-2">Loading visits…</p>
      ) : lines.length === 0 ? (
        <p className="text-12 text-zinc-400 py-2">No visits on this statement.</p>
      ) : (
        <div className="text-12 text-zinc-600 py-1">
          {lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 py-1 border-b border-zinc-100 last:border-0">
              <span className="min-w-0 truncate">
                {dateOnly(l.service_date)} · {l.service_type || "Service"}
                {l.service_address ? ` · ${l.service_address}` : ""}
              </span>
              <span className="shrink-0 text-zinc-700">{money(l.total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {canClose && (
          <>
            <Button size="sm" disabled={!!busy} onClick={() => act("Closed & sent", `${base}/close`, { send: true })}>
              {busy === "Closed & sent" ? "Working…" : "Close & send"}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Closed", `${base}/close`, {})}>
              Close only
            </Button>
          </>
        )}
        {canSend && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Sent", `${base}/send`, {})}>
            {status === "finalized" ? "Send to AP" : "Resend"}
          </Button>
        )}
        {canReconcile && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setReconcileOpen((v) => !v)}>
            Record offline payment
          </Button>
        )}
        {status === "paid" && (
          <span className="text-12 text-zinc-500">Settled {statement.paid_at ? `on ${dateOnly(statement.paid_at)}` : ""}.</span>
        )}
      </div>

      {reconcileOpen && canReconcile && (
        <ReconcileForm
          total={statement.total}
          busy={busy}
          onCancel={() => setReconcileOpen(false)}
          onSubmit={(method, amount) =>
            act("Payment recorded", `${base}/reconcile`, { method, amount }).then(() => setReconcileOpen(false))
          }
        />
      )}

      {showDunning && (
        <DunningControls base={base} sequence={sequence} busy={busy} act={act} />
      )}

      {notice && (
        <p className={`text-12 mt-2 ${notice.tone === "err" ? "text-alert-fg" : "text-zinc-500"}`}>{notice.text}</p>
      )}
    </div>
  );
}

function ReconcileForm({ total, busy, onCancel, onSubmit }) {
  const [method, setMethod] = useState("check");
  const [amount, setAmount] = useState(total != null ? Number(total).toFixed(2) : "");
  return (
    <div className="mt-2 p-2 border-hairline rounded-sm bg-white flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="block text-11 text-zinc-500 mb-1">Method</span>
        <Select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="check">Check</option>
          <option value="ach">ACH / bank transfer</option>
          <option value="wire">Wire</option>
          <option value="offline">Other (offline)</option>
        </Select>
      </label>
      <label className="block">
        <span className="block text-11 text-zinc-500 mb-1">Amount</span>
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="w-28"
        />
      </label>
      <Button size="sm" disabled={!!busy} onClick={() => onSubmit(method, parseFloat(amount))}>
        {busy === "Payment recorded" ? "Recording…" : "Record"}
      </Button>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function DunningControls({ base, sequence, busy, act }) {
  const st = sequence?.status || null;
  return (
    <div className="mt-2 pt-2 border-t border-zinc-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-12 text-zinc-500">
          Reminders:{" "}
          {st === "paused"
            ? "paused"
            : st === "stopped"
            ? "stopped"
            : st === "completed"
            ? "complete"
            : st === "active"
            ? `active${sequence?.next_step_label ? ` · next: ${sequence.next_step_label}` : ""}`
            : "not started"}
        </span>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Reminder sent", `${base}/followups/send-now`, {})}>
          Send reminder now
        </Button>
        {st === "paused" ? (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Reminders resumed", `${base}/followups/resume`, {})}>
            Resume
          </Button>
        ) : st !== "stopped" && st !== "completed" ? (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Reminders paused", `${base}/followups/pause`, {})}>
            Pause
          </Button>
        ) : null}
        {st !== "stopped" && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("Reminders stopped", `${base}/followups/stop`, {})}>
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function ArSummary({ summary }) {
  if (!summary || summary.statement_count === 0) {
    return <p className="text-13 text-zinc-400 py-2">No outstanding balance.</p>;
  }
  const buckets = summary.buckets || {};
  const rows = [
    ["Current", buckets.current],
    ["1–15 days", buckets.b1_15],
    ["16–30 days", buckets.b16_30],
    ["31–45 days", buckets.b31_45],
    ["45+ days", buckets.b45_plus],
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4">
        <Stat label="Outstanding" value={money(summary.outstanding_total)} />
        <Stat label="Past due" value={money(summary.past_due_total)} alert={summary.past_due_total > 0} />
        <Stat label="Statements" value={summary.statement_count} />
        {summary.oldest_days_past_due != null && summary.oldest_days_past_due > 0 && (
          <Stat label="Oldest past due" value={`${summary.oldest_days_past_due}d`} alert />
        )}
      </div>
      <div className="border-hairline rounded-sm overflow-hidden">
        {rows.map(([label, b], i) => (
          <div
            key={label}
            className={`flex items-center justify-between gap-3 px-3 py-1.5 text-12 ${i % 2 ? "bg-zinc-50/60" : ""}`}
          >
            <span className="text-zinc-600">{label}</span>
            <span className={`${i >= 2 && b?.total > 0 ? "text-alert-fg" : "text-zinc-700"}`}>
              {money(b?.total)} {b?.count ? `(${b.count})` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, alert }) {
  return (
    <div>
      <div className="text-11 text-zinc-500 uppercase tracking-label">{label}</div>
      <div className={`text-16 font-medium ${alert ? "text-alert-fg" : "text-zinc-900"}`}>{value}</div>
    </div>
  );
}
