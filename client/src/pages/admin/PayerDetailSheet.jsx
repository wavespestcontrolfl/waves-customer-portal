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

import { useState, useEffect, useCallback, useId, useRef } from "react";
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
  ActionFeedback,
  Field,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";

const money = (n) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// DATE columns (period_start/end, due_date, service_date) arrive as 'YYYY-MM-DD'
// (or a midnight-UTC ISO) — render in UTC so a date never shifts a day.
const dateOnly = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "—";

// TIMESTAMP columns (paid_at, etc.) are instants — render their Eastern calendar
// date (the portal is ET end-to-end), NOT UTC, so a 10pm-ET settle doesn't show
// the next day.
const dateInET = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "America/New_York",
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
  const [statementsError, setStatementsError] = useState("");
  const [arLoading, setArLoading] = useState(true);
  const [arError, setArError] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [openStmtId, setOpenStmtId] = useState(null);

  const loadStatements = useCallback(async () => {
    setLoading(true);
    setStatementsError("");
    try {
      const r = await adminFetch(`/admin/payers/${payer.id}/statements`);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || "Could not load statements.");
      setStatements(Array.isArray(d?.statements) ? d.statements : []);
    } catch (err) {
      setStatementsError(err.message || "Could not load statements.");
    } finally {
      setLoading(false);
    }
  }, [payer.id]);

  const loadAr = useCallback(async () => {
    setArLoading(true);
    setArError("");
    try {
      const r = await adminFetch(`/admin/payers/${payer.id}/ar`);
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.summary) throw new Error(d?.error || "Could not load payer aging.");
      setAr(d);
    } catch (err) {
      setArError(err.message || "Could not load payer aging.");
    } finally {
      setArLoading(false);
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

  const onPendingChange = (value) => {
    pendingRef.current = value;
    setPending(value);
  };
  const close = () => { if (!pendingRef.current) onClose(); };

  return (
    <Sheet open onClose={close} width="lg" ariaLabel={`${payer.display_name} payer details`}>
      <SheetHeader>
        <div className="flex flex-wrap w-full items-start justify-between gap-3">
          <div className="min-w-0 flex-1 break-words">
            <h2 className="text-18 leading-[1.35] font-medium text-zinc-900">{payer.display_name}</h2>
            {payer.company_name && payer.company_name !== payer.display_name && (
              <p className="text-ui-caption text-ink-secondary">{payer.company_name}</p>
            )}
            <p className="text-ui-caption text-ink-secondary mt-1">
              {payer.ap_email || "no AP email"} · {termLabel(payer.payment_terms)}
            </p>
          </div>
          <Button variant="ghost" size="sm" disabled={pending} onClick={close} aria-label="Close">Close</Button>
          {ar?.summary && !arLoading && !arError && (
            <div className="w-full sm:w-auto sm:text-right u-nums">
              <div className="text-ui-caption text-ink-secondary font-medium">Outstanding</div>
              <div className="text-18 leading-[1.35] font-medium u-nums text-zinc-900">{money(ar.summary.outstanding_total)}</div>
              {ar.summary.past_due_total > 0 && (
                <div className="text-ui-caption text-alert-fg">{money(ar.summary.past_due_total)} past due</div>
              )}
            </div>
          )}
        </div>
      </SheetHeader>
      <SheetBody>
        <Tabs value={tab} onValueChange={setTab} variant="section">
          <TabList scrollable aria-label="Payer sections">
            <Tab value="statements" disabled={pending}>Statements</Tab>
            <Tab value="ar" disabled={pending}>AR / aging</Tab>
          </TabList>

          {/* Keep a payment draft across section navigation. The directory keys
              this sheet by payer; closing it or changing payer clears the draft. */}
          <TabPanel value="statements" keepMounted>
            {statementsError && <ActionFeedback error onRetry={loadStatements}>{statementsError}</ActionFeedback>}
            {loading && <ActionFeedback>Loading statements…</ActionFeedback>}
            {!loading && !statementsError && statements.length === 0 ? (
              <p className="text-ui-body text-ink-secondary py-4">
                No statements yet. NET-terms visits accrue here once payer statements are enabled.
              </p>
            ) : (
              <div className="divide-y divide-zinc-100 border-hairline border-zinc-200 rounded-md">
                {statements.map((s) => (
                  <StatementRow
                    key={s.id}
                    payerId={payer.id}
                    statement={s}
                    expanded={openStmtId === s.id}
                    onToggle={() => { if (!pendingRef.current) setOpenStmtId(openStmtId === s.id ? null : s.id); }}
                    pending={pending}
                    onPendingChange={onPendingChange}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </TabPanel>

          <TabPanel value="ar">
            {arLoading ? <ActionFeedback>Loading payer aging…</ActionFeedback>
              : arError ? <ActionFeedback error onRetry={loadAr}>{arError}</ActionFeedback>
              : <ArSummary summary={ar?.summary} />}
          </TabPanel>
        </Tabs>
      </SheetBody>
    </Sheet>
  );
}

function termLabel(v) {
  return { due_on_receipt: "Due on receipt", net15: "Net 15", net30: "Net 30" }[v] || v || "—";
}

function StatementRow({ payerId, statement, expanded, onToggle, onChanged, pending, onPendingChange }) {
  const detailsId = useId();
  const overdue =
    statement.overdue && OUTSTANDING.has(statement.status) && statement.status !== "paid";
  return (
    <div>
      <Button
        variant="ghost"
        onClick={onToggle}
        disabled={pending}
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        className="w-full flex-wrap justify-between px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-900 text-ui-body">S-{statement.id}</span>
            <Badge tone={STATUS_TONE[statement.status] || "neutral"}>
              {STATUS_LABEL[statement.status] || statement.status}
            </Badge>
            {overdue && (
              <Badge tone="alert">{statement.days_past_due}d past due</Badge>
            )}
          </div>
          <div className="text-ui-caption text-ink-secondary mt-1 u-nums">
            {dateOnly(statement.period_start)} – {dateOnly(statement.period_end)} ·{" "}
            {statement.invoice_count || 0} visit{(statement.invoice_count || 0) === 1 ? "" : "s"}
            {statement.due_date ? ` · due ${dateOnly(statement.due_date)}` : ""}
          </div>
        </div>
        <div className="text-right shrink-0 u-nums">
          <div className="font-medium text-zinc-900 text-ui-body">{money(statement.total)}</div>
          <div className="text-ui-caption text-ink-secondary">{expanded ? "Hide" : "Details"}</div>
        </div>
      </Button>
      {expanded && (
        <div id={detailsId}>
          <StatementDetail payerId={payerId} statement={statement} onChanged={onChanged} onPendingChange={onPendingChange} />
        </div>
      )}
    </div>
  );
}

function StatementDetail({ payerId, statement, onChanged, onPendingChange }) {
  const [lines, setLines] = useState(null);
  const [sequence, setSequence] = useState(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null); // { tone: 'ok'|'err', text }
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const busyRef = useRef(false);
  const [linesError, setLinesError] = useState("");
  const [sequenceError, setSequenceError] = useState("");

  const base = `/admin/payers/${payerId}/statements/${statement.id}`;

  const loadDetail = useCallback(async () => {
    setLinesError("");
    setSequenceError("");
    try {
      const r = await adminFetch(base);
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || "Could not load statement visits.");
      setLines(Array.isArray(d?.lines) ? d.lines : []);
    } catch (err) {
      setLinesError(err.message || "Could not load statement visits.");
    }
    try {
      const r2 = await adminFetch(`${base}/followups`);
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2?.error || "Could not load reminder status.");
      setSequence(d2?.sequence ?? null);
    } catch (err) {
      setSequenceError(err.message || "Could not load reminder status.");
    }
  }, [base]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  async function act(label, path, body) {
    if (busyRef.current) return false;
    busyRef.current = true;
    onPendingChange(true);
    setBusy(label);
    setNotice(null);
    try {
      const r = await adminFetch(path, { method: "POST", body: body || {} });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({ tone: "err", text: d?.error || "Action failed." });
        // Partial success: "Close & send" finalizes the statement, then 422s if the
        // AP delivery is blocked — the response still carries the frozen statement.
        // Refresh so the row reflects `finalized` (not stale `open`) and exposes the
        // forced "Send to AP" retry path, instead of stranding the operator on a
        // close button that can't escape the blocked first-delivery key.
        if (d?.statement) {
          await loadDetail();
          if (onChanged) await onChanged();
        }
        return false;
      } else {
        setNotice({ tone: "ok", text: `${label} ✓` });
        await loadDetail();
        if (onChanged) await onChanged();
        return true;
      }
    } catch {
      setNotice({ tone: "err", text: "Network error." });
      return false;
    } finally {
      busyRef.current = false;
      onPendingChange(false);
      setBusy("");
    }
  }

  const status = statement.status;
  const canClose = status === "open";
  const canSend = ["finalized", "sent", "viewed"].includes(status);
  const canReconcile = ["finalized", "sent", "viewed"].includes(status);
  const showDunning = DUNNABLE.has(status) || (sequence && sequence.status);

  return (
    <div className="p-4 bg-zinc-50/60">
      {/* Visit lines */}
      {linesError ? <ActionFeedback error onRetry={loadDetail}>{linesError}</ActionFeedback> : lines === null ? (
        <p className="text-ui-caption text-ink-secondary py-2">Loading visits…</p>
      ) : lines.length === 0 ? (
        <p className="text-ui-caption text-ink-secondary py-2">No visits on this statement.</p>
      ) : (
        <div className="text-ui-caption text-zinc-600 py-1">
          {lines.map((l, i) => (
            <div key={i} className="flex items-center justify-between gap-3 py-1 border-b border-zinc-100 last:border-0">
              <span className="min-w-0 break-words">
                {dateOnly(l.service_date)} · {l.service_type || "Service"}
                {l.service_address ? ` · ${l.service_address}` : ""}
              </span>
              <span className="shrink-0 text-zinc-700 u-nums">{money(l.total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="ui-record-actions mt-3">
        {canClose && (
          <>
            <Button size="sm" loading={busy === "Closed & sent"} disabled={!!busy} onClick={() => act("Closed & sent", `${base}/close`, { send: true })}>
              Close & send
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "Closed"} disabled={!!busy} onClick={() => act("Closed", `${base}/close`, {})}>
              Close only
            </Button>
          </>
        )}
        {canSend && (
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "Sent"}
            disabled={!!busy}
            // A first delivery (finalized) sends `force` so a blocked/suppressed
            // attempt can be retried after AP fixes the bounce — otherwise it
            // dedupes against the terminal-blocked row forever. `force` is safe
            // here: it resolves to the stable base key when nothing's blocked
            // (still dedupes double-clicks) and only walks to a fresh retry key to
            // escape an actual block. A sent/viewed resend stays keyless (always
            // re-sends).
            onClick={() => act("Sent", `${base}/send`, status === "finalized" ? { force: true } : {})}
          >
            {status === "finalized" ? "Send to AP" : "Resend"}
          </Button>
        )}
        {canReconcile && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setReconcileOpen((v) => !v)}>
            Record offline payment
          </Button>
        )}
        {status === "paid" && (
          <span className="text-ui-caption text-ink-secondary">Settled {statement.paid_at ? `on ${dateInET(statement.paid_at)}` : ""}.</span>
        )}
      </div>

      {reconcileOpen && canReconcile && (
        <ReconcileForm
          total={statement.total}
          busy={busy}
          onCancel={() => setReconcileOpen(false)}
          onSubmit={async (method, amount) => {
            const saved = await act("Payment recorded", `${base}/reconcile`, { method, amount });
            if (saved) setReconcileOpen(false);
          }}
        />
      )}

      {sequenceError ? <ActionFeedback error onRetry={loadDetail} className="mt-3">{sequenceError}</ActionFeedback> : showDunning && (
        <DunningControls base={base} sequence={sequence} busy={busy} act={act} />
      )}

      {notice && (
        <ActionFeedback error={notice.tone === "err"} className="mt-3">{notice.text}</ActionFeedback>
      )}
    </div>
  );
}

function ReconcileForm({ total, busy, onCancel, onSubmit }) {
  const [method, setMethod] = useState("check");
  const [amount, setAmount] = useState(total != null ? Number(total).toFixed(2) : "");
  // Validate client-side: a blank/NaN amount serializes to JSON null, which the
  // server treats as "default to the full statement total" — so an invalid entry
  // would silently record the whole balance. Block submit unless it's a positive
  // finite number (the server still re-checks it against the locked total).
  const parsed = parseFloat(amount);
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <fieldset disabled={!!busy} className="min-w-0 m-0 mt-3 p-4 border-hairline border-zinc-200 rounded-md bg-white flex flex-wrap items-end gap-3">
      <Field label="Method" className="w-full sm:w-auto">
        <Select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="check">Check</option>
          <option value="ach">ACH / bank transfer</option>
          <option value="wire">Wire</option>
          <option value="offline">Other (offline)</option>
        </Select>
      </Field>
      <Field label="Amount" error={!valid ? "Enter a positive amount to record payment." : undefined} className="w-full sm:w-40">
        <Input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="u-nums"
          aria-invalid={!valid}
        />
      </Field>
      <Button size="sm" loading={busy === "Payment recorded"} disabled={!!busy || !valid} onClick={() => valid && onSubmit(method, parsed)}>
        Record
      </Button>
      <Button size="sm" variant="ghost" disabled={!!busy} onClick={onCancel}>
        Cancel
      </Button>
    </fieldset>
  );
}

function DunningControls({ base, sequence, busy, act }) {
  const st = sequence?.status || null;
  return (
    <div className="mt-2 pt-2 border-t border-zinc-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-caption text-ink-secondary">
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
        <Button size="sm" variant="ghost" loading={busy === "Reminder sent"} disabled={!!busy} onClick={() => act("Reminder sent", `${base}/followups/send-now`, {})}>
          Send reminder now
        </Button>
        {st === "paused" ? (
          <Button size="sm" variant="ghost" loading={busy === "Reminders resumed"} disabled={!!busy} onClick={() => act("Reminders resumed", `${base}/followups/resume`, {})}>
            Resume
          </Button>
        ) : st !== "stopped" && st !== "completed" ? (
          <Button size="sm" variant="ghost" loading={busy === "Reminders paused"} disabled={!!busy} onClick={() => act("Reminders paused", `${base}/followups/pause`, {})}>
            Pause
          </Button>
        ) : null}
        {st !== "stopped" && (
          <Button size="sm" variant="ghost" loading={busy === "Reminders stopped"} disabled={!!busy} onClick={() => act("Reminders stopped", `${base}/followups/stop`, {})}>
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function ArSummary({ summary }) {
  if (!summary) return <ActionFeedback error>Payer aging is unavailable.</ActionFeedback>;
  if (summary.statement_count === 0) {
    return <p className="text-ui-body text-ink-secondary py-2">No outstanding balance.</p>;
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
      <div className="border-hairline border-zinc-200 rounded-md overflow-hidden">
        {rows.map(([label, b], i) => (
          <div
            key={label}
            className={`flex items-center justify-between gap-3 px-3 py-2 text-ui-caption u-nums ${i % 2 ? "bg-zinc-50/60" : ""}`}
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
      <div className="text-ui-caption text-ink-secondary font-medium">{label}</div>
      <div className={`text-18 leading-[1.35] font-medium u-nums ${alert ? "text-alert-fg" : "text-zinc-900"}`}>{value ?? "—"}</div>
    </div>
  );
}
