/**
 * <BillingRecoveryPage> — /admin/billing-recovery (Tier 1 V2 styling).
 *
 * Three jobs:
 *   1. Surface completed visits that were never invoiced (the silent leak:
 *      priced, non-autopay, per-visit-billed customers whose completion missed
 *      the invoice gate). One-click "Bill" cuts a DRAFT invoice; "Mark free"
 *      records an intentionally-$0 visit (callback, in-window rodent trap check,
 *      waived inspection, follow-up, appointment service) so it leaves the queue
 *      and starts labeling the data.
 *   2. Show AR aging (30/60/90+) for invoiced-but-unpaid invoices so receivables
 *      get chased.
 *   3. List draft invoices for finished visits that nobody ever sent ("Bill made,
 *      never sent"). The leak queue counts any non-void invoice as billed, so a
 *      forgotten draft is on no other list. Read-only: Send and Charge live on
 *      the invoice page.
 *   4. List the recurring accounts behind the dashboard's "MRR at risk" action
 *      item (service paused / autopay paused / overdue / prepay invoice unpaid)
 *      — the item deep-links here, so the number has to be actionable here.
 *
 * Autopay customers are intentionally absent from the LEAK queue — they hold no
 * per-visit price and are billed separately by billing-cron off monthly_rate.
 * The server enforces that guard too; this page never auto-bills. (Paused
 * autopay accounts DO appear in the at-risk MRR list — that's the point.)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Button, Badge, Card, CardHeader, CardTitle, CardBody,
  Table, THead, TBody, TR, TH, TD, Select, Textarea,
  TablePagination, TableToolbar, Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  ActionFeedback, Field, Input, UiSurface, buttonStyles, cn,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Preset reasons for an intentionally-$0 visit (Adam-locked no-cost taxonomy).
export const FREE_REASONS = [
  "Warranty callback / re-treat",
  "In-window rodent trap check",
  "Inspection (waived/credited)",
  "Follow-up re-visit",
  "Appointment service (no-cost)",
  "Other (see note)",
];

export function formatMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Cause codes from /billing-recovery/at-risk-mrr (services/mrr-breakdown.js).
export const AT_RISK_CAUSE_LABELS = {
  service_paused: "Service paused",
  autopay_paused: "Autopay paused",
  overdue: "Overdue invoice",
  prepay_payment_pending: "Prepay invoice unpaid",
};

export function daysSince(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

// Date-only billing fields (e.g. invoice due_date 'YYYY-MM-DD') must NOT go
// through new Date(), which parses as midnight UTC and renders the prior day
// in ET. Format the calendar components directly.
export function formatDateOnly(d) {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return String(d);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`; // M/D/YYYY
}

// Timestamptz fields (e.g. completed_at) — the portal is Eastern Time, so render
// the ET calendar date rather than the operator's browser timezone.
export function formatETDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

async function adminFetch(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  });
  if (!r.ok) {
    let message = `HTTP ${r.status}`;
    try { const d = await r.clone().json(); message = d.error || d.message || message; } catch { /* noop */ }
    const err = new Error(message);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function StatCard({ label, value, sub, alert }) {
  return (
    <Card>
      <CardBody>
        <div className="text-ui-label font-medium text-ink-secondary">{label}</div>
        <div className={cn("text-22 sm:text-28 font-medium mt-1 u-nums break-words", alert ? "text-alert-fg" : "text-zinc-900")}>{value == null ? "—" : formatMoney(value)}</div>
        {sub != null && <div className="text-ui-caption text-ink-secondary mt-1">{sub}</div>}
      </CardBody>
    </Card>
  );
}

// Status-only completions (no service_records row) can't be billed here —
// the completion flow must mint the record first. Same deep link the tech
// home uses: DispatchPageV2 consumes ?completeService= once and opens
// CompletionPanel on that visit (its predicate admits completed visits whose
// day payload says has_service_record === false).
export function completionDeepLink(visit) {
  if (!visit?.scheduled_service_id) return null;
  const params = new URLSearchParams({ tab: "schedule" });
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(visit.scheduled_date || ""))) params.set("date", visit.scheduled_date);
  params.set("completeService", String(visit.scheduled_service_id));
  return `/admin/dispatch?${params.toString()}`;
}

const VISIT_PAGE_SIZE = 25;

function visitSearchText(visit) {
  return [
    visit.customer,
    visit.service_type,
    visit.voided_invoice_number,
    visit.billed_elsewhere_invoice_number,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function VisitRow({ visit, busy, billing, onBill, onFree, onElsewhere }) {
  const statusOnly = visit.leak_kind === "completed_no_service_record";
  const ago = daysSince(visit.completed_at);
  return (
    <TR>
      <TD>{visit.customer || "—"}</TD>
      <TD data-label="Visit" className="text-ink-secondary u-nums">
        <span>
        {formatETDate(visit.completed_at)}
        {ago != null && <span> · {ago}d ago</span>}
        </span>
      </TD>
      <TD data-label="Service">
        <div>
        {visit.service_type || "—"}
        {statusOnly && (
          <div className="text-ui-caption text-alert-fg mt-1">Completed by status only — no service record yet</div>
        )}
        {visit.voided_invoice_number && (
          <div className="text-ui-caption text-ink-secondary mt-1">
            Invoice {visit.voided_invoice_number} was voided — check for a replacement invoice before billing
          </div>
        )}
        {visit.billed_elsewhere_invoice_number && (
          <div className="text-ui-caption text-alert-fg mt-1">
            Marked as billed on {visit.billed_elsewhere_invoice_number}, which is now {visit.billed_elsewhere_invoice_status || "no longer live"} — bill this visit or mark it free
          </div>
        )}
        </div>
      </TD>
      <TD data-label="Price" nums>{visit.price == null ? "—" : formatMoney(visit.price)}</TD>
      <TD data-label="Actions" align="right">
        <div className="ui-record-actions justify-end">
          {statusOnly ? (
            <a
              href={completionDeepLink(visit)}
              className={buttonStyles({ variant: "secondary", density: "comfortable" })}
              title="Opens this visit's completion on the dispatch day — completing it mints the service record and invoice"
            >
              Open completion
            </a>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={billing}
              disabled={busy || !visit.billable}
              onClick={() => onBill(visit)}
              title={!visit.billable ? "No completion record — cannot invoice" : undefined}
            >
              Bill
            </Button>
          )}
          {/* A status-only visit must finish its closeout first (the server refuses). */}
          {!statusOnly && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              onElsewhere(visit);
            }}>
              Billed elsewhere
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onFree(visit);
          }}>
            Mark free
          </Button>
        </div>
        {!statusOnly && !visit.billable && <p className="text-ui-caption text-ink-secondary">No completion record — cannot invoice</p>}
      </TD>
    </TR>
  );
}

function VisitTable({ label, visits, controlsEnabled, busyId, freeFor, elsewhereFor, confirmBill, onBill, onFree, onElsewhere }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const shown = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? visits.filter((visit) => visitSearchText(visit).includes(query)) : visits;
  }, [search, visits]);
  const totalPages = Math.max(1, Math.ceil(shown.length / VISIT_PAGE_SIZE));
  const displayed = controlsEnabled
    ? shown.slice((page - 1) * VISIT_PAGE_SIZE, page * VISIT_PAGE_SIZE)
    : visits;

  useEffect(() => {
    if (!controlsEnabled) return;
    setPage((current) => Math.min(Math.max(1, current), totalPages));
  }, [controlsEnabled, totalPages]);

  return (
    <>
      {controlsEnabled && (
        <div className="mb-3 grid gap-2">
          <TableToolbar label={label} search={search}
            onSearchChange={(value) => { setSearch(value); setPage(1); }}
            searchPlaceholder="Search customer, service, or invoice"
            onReset={() => { setSearch(""); setPage(1); }} canReset={Boolean(search)} />
          <p className="text-ui-caption text-ink-secondary">Search and page counts apply only to this queue.</p>
        </div>
      )}
      {displayed.length ? (
        <Table layout="records" aria-label={controlsEnabled ? label : undefined}>
          <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Price</TH><TH align="right">Action</TH></TR></THead>
          <TBody>{displayed.map((visit) => (
            <VisitRow key={visit.scheduled_service_id} visit={visit} busy={!!busyId}
              billing={busyId === visit.scheduled_service_id && !freeFor && !elsewhereFor}
              onBill={(selected) => onBill(selected, confirmBill ? { confirm: true } : undefined)}
              onFree={onFree} onElsewhere={onElsewhere} />
          ))}</TBody>
        </Table>
      ) : <ActionFeedback className="justify-center py-6 text-center">No visits match these controls.</ActionFeedback>}
      {controlsEnabled && <TablePagination label={label} page={page} totalPages={totalPages}
        total={shown.length} pageSize={VISIT_PAGE_SIZE} onPageChange={setPage} itemLabel="visits" />}
    </>
  );
}

function EmptyFeedback({ feedbackEnabled, children, className }) {
  return feedbackEnabled
    ? <ActionFeedback className={className}>{children}</ActionFeedback>
    : <div className={cn("text-ui-body text-ink-secondary", className)}>{children}</div>;
}

function VisitQueues({ feedbackEnabled, controlsEnabled, loading, error, onRetry, data, busyId, freeFor, elsewhereFor, onBill, onFree, onElsewhere }) {
  return (
    <>
      {feedbackEnabled && loading && <ActionFeedback className="mb-5 min-h-20">Loading uninvoiced visits and review queue…</ActionFeedback>}
      {feedbackEnabled && error && (
        <ActionFeedback error onRetry={onRetry} className="mb-5">
          Uninvoiced visits and Needs review couldn't be loaded. Other billing recovery sections are still available.
        </ActionFeedback>
      )}
      {data && (
        <>
          <Card className="mb-6">
            <CardHeader><CardTitle>Uninvoiced completed visits</CardTitle></CardHeader>
            <CardBody>
              {data.leaks?.length ? (
                <VisitTable label="Uninvoiced visits" visits={data.leaks} controlsEnabled={controlsEnabled}
                  busyId={busyId} freeFor={freeFor} elsewhereFor={elsewhereFor}
                  onBill={onBill} onFree={onFree} onElsewhere={onElsewhere} />
              ) : (
                <EmptyFeedback feedbackEnabled={feedbackEnabled} className="justify-center py-6 text-center">No uninvoiced visits in this window.</EmptyFeedback>
              )}
            </CardBody>
          </Card>
          {data.needs_review?.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Needs review — recurring or partially prepaid</CardTitle>
                <p className="text-ui-caption text-ink-secondary mt-1">These have a monthly rate, a partial prepayment, or bill per application — confirm they aren't already billed (cadence or completion auto-charge), and bill partial-prepay visits manually so the credit is applied.</p>
              </CardHeader>
              <CardBody>
                <VisitTable label="Needs review visits" visits={data.needs_review} controlsEnabled={controlsEnabled}
                  busyId={busyId} freeFor={freeFor} elsewhereFor={elsewhereFor} confirmBill
                  onBill={onBill} onFree={onFree} onElsewhere={onElsewhere} />
              </CardBody>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function UnsentDraftsSection({ feedbackEnabled, loading, error, onRetry, unsentDrafts }) {
  const drafts = unsentDrafts?.drafts || [];
  let body;
  if (loading) body = feedbackEnabled
    ? <ActionFeedback className="min-h-20">Loading unsent draft invoices…</ActionFeedback>
    : <div role="status" className="text-ui-body text-ink-secondary py-4 text-center">Loading…</div>;
  else if (error) body = (
    <ActionFeedback error onRetry={onRetry}>Unsent draft invoices couldn't be loaded. Other billing recovery sections are still available.</ActionFeedback>
  );
  else if (drafts.length) body = (
    <>
      <p className="text-ui-label font-medium text-ink-secondary mb-3 u-nums">
        {drafts.length} draft{drafts.length === 1 ? "" : "s"} · {formatMoney(unsentDrafts.summary?.total)}
      </p>
      <Table layout="records">
        <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Amount</TH><TH align="right">Invoice</TH></TR></THead>
        <TBody>{drafts.map((draft) => (
          <TR key={draft.invoice_id}>
            <TD>{`${draft.first_name || ""} ${draft.last_name || ""}`.trim() || "—"}</TD>
            <TD data-label="Visit" className="text-ink-secondary u-nums">{draft.scheduled_date ? formatDateOnly(draft.scheduled_date) : formatETDate(draft.completed_at)}</TD>
            <TD data-label="Service">
              <div>
                {draft.service_type || "—"}
                {draft.visit_marked_free && <div className="mt-1"><Badge tone="neutral">visit marked free</Badge></div>}
              </div>
            </TD>
            <TD data-label="Amount" nums>{formatMoney(draft.total)}</TD>
            <TD data-label="Invoice" align="right">
              <a href={`/admin/invoices?invoice=${encodeURIComponent(draft.invoice_id)}`} className="inline-flex items-center text-zinc-900 underline-offset-2 hover:underline u-focus-ring" data-ui-text-action>
                {draft.invoice_number}
              </a>
            </TD>
          </TR>
        ))}</TBody>
      </Table>
    </>
  );
  else body = <EmptyFeedback feedbackEnabled={feedbackEnabled} className="justify-center py-4 text-center">No unsent drafts.</EmptyFeedback>;

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Bill made, never sent</CardTitle>
        <p className="text-ui-caption text-ink-secondary mt-1">The portal made these invoices as drafts. Nobody sent them, so the customer never got a bill.</p>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}

function AgingSection({ feedbackEnabled, loading, error, onRetry, aging }) {
  const buckets = aging?.aging || {};
  let body;
  if (feedbackEnabled && loading) body = <ActionFeedback className="min-h-20">Loading accounts receivable aging…</ActionFeedback>;
  else if (feedbackEnabled && error) body = (
    <ActionFeedback error onRetry={onRetry}>Accounts receivable aging couldn't be loaded. Visit recovery and at-risk MRR are still available.</ActionFeedback>
  );
  else body = (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Current" value={buckets.current} />
        <StatCard label="1–30 days" value={buckets.days_30} />
        <StatCard label="31–60 days" value={buckets.days_60} />
        <StatCard label="61–90+ days" value={buckets.days_90_plus} alert={buckets.days_90_plus > 0} />
      </div>
      {aging?.top_balances?.length ? (
        <Table layout="records">
          <THead><TR><TH>Customer</TH><TH>Status</TH><TH>Due</TH><TH align="right">Amount</TH></TR></THead>
          <TBody>{aging.top_balances.map((balance) => (
            <TR key={balance.invoice_id}>
              <TD>{balance.customer}</TD>
              <TD data-label="Status"><span><Badge tone={String(balance.status).toLowerCase() === "overdue" ? "alert" : "neutral"}>{balance.status}</Badge></span></TD>
              <TD data-label="Due" className="text-ink-secondary u-nums">{formatDateOnly(balance.due_date)}</TD>
              <TD data-label="Amount" nums>{balance.amount == null ? "—" : formatMoney(balance.amount)}</TD>
            </TR>
          ))}</TBody>
        </Table>
      ) : <EmptyFeedback feedbackEnabled={feedbackEnabled} className="justify-center py-4 text-center">No outstanding balances.</EmptyFeedback>}
    </>
  );
  return <Card><CardHeader><CardTitle>Accounts receivable aging</CardTitle></CardHeader><CardBody>{body}</CardBody></Card>;
}

function AtRiskSection({ feedbackEnabled, loading, error, onRetry, atRiskMrr }) {
  let body;
  if (feedbackEnabled && loading) body = <ActionFeedback className="min-h-20">Loading at-risk MRR accounts…</ActionFeedback>;
  else if (feedbackEnabled && error) body = (
    <ActionFeedback error onRetry={onRetry}>At-risk MRR accounts couldn't be loaded. Visit recovery and AR aging are still available.</ActionFeedback>
  );
  else if (atRiskMrr?.accounts?.length) body = (
    <Table layout="records">
      <THead><TR><TH>Customer</TH><TH>Why at risk</TH><TH align="right">Monthly</TH></TR></THead>
      <TBody>{atRiskMrr.accounts.map((account) => (
        <TR key={account.id}>
          <TD><a href={`/admin/customers?customerId=${account.id}`} className="inline-flex items-center text-zinc-900 underline-offset-2 hover:underline u-focus-ring" data-ui-text-action>
            {`${account.firstName || ""} ${account.lastName || ""}`.trim() || "Unnamed account"}
          </a></TD>
          <TD data-label="Why at risk"><span className="inline-flex flex-wrap gap-1">
            {account.causes.map((cause) => <Badge key={cause} tone="neutral">{AT_RISK_CAUSE_LABELS[cause] || cause}</Badge>)}
          </span></TD>
          <TD data-label="Monthly" nums>{account.monthlyRate == null ? "—" : formatMoney(account.monthlyRate)}</TD>
        </TR>
      ))}</TBody>
    </Table>
  );
  else if (atRiskMrr) body = <EmptyFeedback feedbackEnabled={feedbackEnabled} className="justify-center py-4 text-center">Every recurring account is clear to bill.</EmptyFeedback>;
  else body = <ActionFeedback error onRetry={onRetry}>At-risk accounts couldn't be loaded — refresh to retry.</ActionFeedback>;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>At-risk MRR</CardTitle>
        <p className="text-ui-caption text-ink-secondary mt-1">
          Recurring accounts whose next monthly charge isn't expected to land. Same definition as the dashboard's MRR tile and its "MRR at risk" action item{atRiskMrr ? ` — ${formatMoney(atRiskMrr.atRisk)} across ${atRiskMrr.count} account${atRiskMrr.count === 1 ? "" : "s"}` : ""}.
        </p>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}

export default function BillingRecoveryPage() {
  const [searchParams] = useSearchParams();
  const feedbackEnabled = searchParams.get("feedback") === "1";
  const tableControlsEnabled = searchParams.get("tableControls") === "1";
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [aging, setAging] = useState(null);
  const [atRiskMrr, setAtRiskMrr] = useState(null);
  const [unsentDrafts, setUnsentDrafts] = useState(null);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftsError, setDraftsError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [leaksLoading, setLeaksLoading] = useState(true);
  const [agingLoading, setAgingLoading] = useState(true);
  const [atRiskLoading, setAtRiskLoading] = useState(true);
  const [leaksError, setLeaksError] = useState(null);
  const [agingError, setAgingError] = useState(null);
  const [atRiskError, setAtRiskError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const [freeError, setFreeError] = useState(null);
  const [freeFor, setFreeFor] = useState(null); // visit pending "mark free"
  const [freeReason, setFreeReason] = useState(FREE_REASONS[0]);
  const [freeNote, setFreeNote] = useState("");
  const [elsewhereFor, setElsewhereFor] = useState(null); // visit pending "billed elsewhere"
  const [elsewhereInvoice, setElsewhereInvoice] = useState("");
  const [elsewhereNote, setElsewhereNote] = useState("");
  const [elsewhereError, setElsewhereError] = useState(null);
  const readScopeRef = useRef({ days, feedbackEnabled, version: 0 });
  const priorScope = readScopeRef.current;
  if (priorScope.days !== days || priorScope.feedbackEnabled !== feedbackEnabled) {
    readScopeRef.current = { days, feedbackEnabled, version: priorScope.version + 1 };
  }
  const readRequestsRef = useRef({ legacy: 0, leaks: 0, aging: 0, atRisk: 0, drafts: 0 });
  const isCurrentRead = useCallback((source, requestId, scopeVersion) => (
    readRequestsRef.current[source] === requestId && readScopeRef.current.version === scopeVersion
  ), []);

  const loadLegacy = useCallback(async () => {
    const scope = readScopeRef.current;
    if (scope.feedbackEnabled) return;
    const requestId = ++readRequestsRef.current.legacy;
    setActionError(null);
    setLoading(true);
    setError(null);
    try {
      const [leaks, ar, riskMrr] = await Promise.all([
        adminFetch(`/admin/billing-recovery/leaks?days=${scope.days}`),
        adminFetch(`/admin/billing-recovery/aging`),
        adminFetch(`/admin/billing-recovery/at-risk-mrr`).catch(() => null),
      ]);
      if (!isCurrentRead("legacy", requestId, scope.version)) return;
      setData(leaks);
      setAging(ar);
      setAtRiskMrr(riskMrr);
    } catch (e) {
      if (!isCurrentRead("legacy", requestId, scope.version)) return;
      setError(e.message || "Failed to load");
    } finally {
      if (isCurrentRead("legacy", requestId, scope.version)) setLoading(false);
    }
  }, [isCurrentRead]);

  const loadLeaks = useCallback(async () => {
    const scope = readScopeRef.current;
    if (!scope.feedbackEnabled) return;
    const requestId = ++readRequestsRef.current.leaks;
    setLeaksLoading(true);
    setLeaksError(null);
    setData(null);
    try {
      const result = await adminFetch(`/admin/billing-recovery/leaks?days=${scope.days}`);
      if (isCurrentRead("leaks", requestId, scope.version)) setData(result);
    } catch (e) {
      if (isCurrentRead("leaks", requestId, scope.version)) setLeaksError(e.message || "Failed to load uninvoiced visits");
    } finally {
      if (isCurrentRead("leaks", requestId, scope.version)) setLeaksLoading(false);
    }
  }, [isCurrentRead]);

  const loadAging = useCallback(async () => {
    const scope = readScopeRef.current;
    if (!scope.feedbackEnabled) return;
    const requestId = ++readRequestsRef.current.aging;
    setAgingLoading(true);
    setAgingError(null);
    setAging(null);
    try {
      const result = await adminFetch(`/admin/billing-recovery/aging`);
      if (isCurrentRead("aging", requestId, scope.version)) setAging(result);
    } catch (e) {
      if (isCurrentRead("aging", requestId, scope.version)) setAgingError(e.message || "Failed to load AR aging");
    } finally {
      if (isCurrentRead("aging", requestId, scope.version)) setAgingLoading(false);
    }
  }, [isCurrentRead]);

  const loadAtRisk = useCallback(async () => {
    const scope = readScopeRef.current;
    if (!scope.feedbackEnabled) return;
    const requestId = ++readRequestsRef.current.atRisk;
    setAtRiskLoading(true);
    setAtRiskError(null);
    setAtRiskMrr(null);
    try {
      const result = await adminFetch(`/admin/billing-recovery/at-risk-mrr`);
      if (isCurrentRead("atRisk", requestId, scope.version)) setAtRiskMrr(result);
    } catch (e) {
      if (isCurrentRead("atRisk", requestId, scope.version)) setAtRiskError(e.message || "Failed to load at-risk MRR accounts");
    } finally {
      if (isCurrentRead("atRisk", requestId, scope.version)) setAtRiskLoading(false);
    }
  }, [isCurrentRead]);

  // Read-only and independent of the visit queues in both modes, so a failed
  // draft read never blanks the leak list.
  const loadDrafts = useCallback(async () => {
    const scope = readScopeRef.current;
    const requestId = ++readRequestsRef.current.drafts;
    setDraftsLoading(true);
    setDraftsError(null);
    setUnsentDrafts(null);
    try {
      const result = await adminFetch(`/admin/billing-recovery/unsent-drafts?days=${scope.days}`);
      if (isCurrentRead("drafts", requestId, scope.version)) setUnsentDrafts(result);
    } catch (e) {
      if (isCurrentRead("drafts", requestId, scope.version)) setDraftsError(e.message || "Failed to load unsent draft invoices");
    } finally {
      if (isCurrentRead("drafts", requestId, scope.version)) setDraftsLoading(false);
    }
  }, [isCurrentRead]);

  const refreshAll = useCallback(async () => {
    if (!readScopeRef.current.feedbackEnabled) return loadLegacy();
    await Promise.all([loadLeaks(), loadAging(), loadAtRisk()]);
  }, [loadAging, loadAtRisk, loadLeaks, loadLegacy]);

  useEffect(() => { void loadDrafts(); }, [days, feedbackEnabled, loadDrafts]);

  useEffect(() => {
    if (feedbackEnabled) {
      void loadLeaks();
      void loadAging();
      void loadAtRisk();
    } else {
      void loadLegacy();
    }
  }, [days, feedbackEnabled, loadAging, loadAtRisk, loadLeaks, loadLegacy]);

  const bill = useCallback(async (visit, { confirm } = {}) => {
    if (busyRef.current) return;
    const confirmMsg = visit.billing_mode === "per_application"
      ? `${visit.customer} is billed per application (${formatMoney(visit.price)}/visit, auto-charged at completion). `
        + `Confirm completion billing really did miss this visit before invoicing it. Continue?`
      : `${visit.customer} has a monthly rate (${formatMoney(visit.monthly_rate)}). `
        + `Confirm they are NOT billed on a recurring cadence before invoicing this visit. Continue?`;
    if (confirm && !window.confirm(confirmMsg)) return;
    busyRef.current = true;
    setBusyId(visit.scheduled_service_id);
    setActionError(null);
    setActionNotice(null);
    try {
      await adminFetch(`/admin/billing-recovery/${visit.scheduled_service_id}/bill`, { method: "POST", body: "{}" });
      if (readScopeRef.current.feedbackEnabled) setActionNotice("Draft invoice created. Review and send it from Invoices.");
      await refreshAll();
    } catch (e) {
      setActionError(e.message || "Could not create invoice");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }, [refreshAll]);

  const submitFree = useCallback(async () => {
    if (!freeFor || busyRef.current) return;
    busyRef.current = true;
    setFreeError(null);
    setActionNotice(null);
    const reason = freeReason === "Other (see note)" ? (freeNote.trim() || "Other") : `${freeReason}${freeNote.trim() ? ` — ${freeNote.trim()}` : ""}`;
    setBusyId(freeFor.scheduled_service_id);
    try {
      await adminFetch(`/admin/billing-recovery/${freeFor.scheduled_service_id}/dismiss`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      setFreeFor(null);
      setFreeNote("");
      setFreeReason(FREE_REASONS[0]);
      if (readScopeRef.current.feedbackEnabled) setActionNotice("Visit marked intentionally free. No invoice was created.");
      await refreshAll();
    } catch (e) {
      setFreeError(e.message || "Could not record disposition");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }, [freeFor, freeReason, freeNote, refreshAll]);

  const submitElsewhere = useCallback(async () => {
    if (!elsewhereFor || busyRef.current) return;
    const invoiceNumber = elsewhereInvoice.trim();
    if (!invoiceNumber) { setElsewhereError("Enter the invoice number that bills this visit."); return; }
    busyRef.current = true;
    setElsewhereError(null);
    setActionNotice(null);
    setBusyId(elsewhereFor.scheduled_service_id);
    try {
      await adminFetch(`/admin/billing-recovery/${elsewhereFor.scheduled_service_id}/billed-elsewhere`, {
        method: "POST", body: JSON.stringify({ invoiceNumber, note: elsewhereNote.trim() || null }),
      });
      setElsewhereFor(null);
      setElsewhereInvoice("");
      setElsewhereNote("");
      if (readScopeRef.current.feedbackEnabled) setActionNotice("Covering invoice recorded. The visit was removed from recovery.");
      await refreshAll();
    } catch (e) {
      setElsewhereError(e.message || "Could not record the covering invoice");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }, [elsewhereFor, elsewhereInvoice, elsewhereNote, refreshAll]);

  const summary = feedbackEnabled || (!loading && !error) ? data?.summary : null;
  const visibleAging = feedbackEnabled || (!loading && !error) ? aging : null;
  const showFree = (visit) => {
    setActionError(null);
    setActionNotice(null);
    setFreeFor(visit);
    setFreeReason(FREE_REASONS[0]);
    setFreeNote("");
    setFreeError(null);
  };
  const closeFree = () => { if (!busyRef.current) setFreeFor(null); };
  const showElsewhere = (visit) => {
    setActionError(null);
    setActionNotice(null);
    setElsewhereFor(visit);
    setElsewhereInvoice("");
    setElsewhereNote("");
    setElsewhereError(null);
  };
  const closeElsewhere = () => { if (!busyRef.current) setElsewhereFor(null); };

  return (
    <UiSurface density="comfortable" className="max-w-[1300px] mx-auto">
      <AdminCommandHeader title="Billing recovery" icon={Banknote} variant="workspace" />
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-ui-body text-ink-secondary">
            Completed visits that were never invoiced, plus aging receivables. Monthly-autopay visits are excluded — they bill separately; per-application visits surface under Needs review.
          </p>
        </div>
        <Field label="Visit window" className="w-full sm:w-48 shrink-0">
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </Select>
        </Field>
      </div>

      {!feedbackEnabled && error && (
        <ActionFeedback error onRetry={loadLegacy} className="mb-5">{error}</ActionFeedback>
      )}
      {actionError && <ActionFeedback error className="mb-5">{actionError}</ActionFeedback>}
      {feedbackEnabled && actionNotice && <ActionFeedback className="mb-5">{actionNotice}</ActionFeedback>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Uninvoiced (leak)" value={summary?.leak_dollars} sub={`${summary?.leak_visits ?? "—"} visits · ${summary?.leak_customers ?? "—"} customers`} />
        <StatCard label="Needs review" value={summary?.review_dollars} sub={`${summary?.review_visits ?? "—"} recurring visits`} />
        <StatCard label="AR outstanding" value={visibleAging?.total_outstanding} sub={`${visibleAging?.invoice_count ?? "—"} invoices`} />
        <StatCard label="AR overdue" value={visibleAging?.total_overdue} alert={visibleAging?.total_overdue > 0} />
      </div>

      {!feedbackEnabled && loading ? (
        <div role="status" className="text-ui-body text-ink-secondary min-h-[240px] py-10 text-center">Loading…</div>
      ) : !feedbackEnabled && error ? null : (
        <>
          <VisitQueues feedbackEnabled={feedbackEnabled} loading={leaksLoading} error={leaksError}
            controlsEnabled={tableControlsEnabled} onRetry={loadLeaks} data={data}
            busyId={busyId} freeFor={freeFor} elsewhereFor={elsewhereFor}
            onBill={bill} onFree={showFree} onElsewhere={showElsewhere} />
          <UnsentDraftsSection feedbackEnabled={feedbackEnabled} loading={draftsLoading} error={draftsError}
            onRetry={loadDrafts} unsentDrafts={unsentDrafts} />
          <AgingSection feedbackEnabled={feedbackEnabled} loading={agingLoading} error={agingError}
            onRetry={loadAging} aging={aging} />
          <AtRiskSection feedbackEnabled={feedbackEnabled} loading={atRiskLoading} error={atRiskError}
            onRetry={feedbackEnabled ? loadAtRisk : loadLegacy} atRiskMrr={atRiskMrr} />
        </>
      )}

      <Dialog open={!!freeFor} onClose={closeFree} size="sm">
        <DialogHeader><DialogTitle>Mark visit as intentionally free</DialogTitle></DialogHeader>
        <DialogBody>
          <p className="text-ui-body text-zinc-600 mb-3">
            {freeFor?.customer} · {freeFor?.service_type} · {formatMoney(freeFor?.price)}. This records the visit as no-cost — no invoice is created.
          </p>
          <fieldset disabled={!!busyId} className="min-w-0 m-0 p-0 border-0 space-y-3">
          <Field label="Reason">
          <Select value={freeReason} onChange={(e) => setFreeReason(e.target.value)}>
            {FREE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          </Field>
          <Field label="Optional note">
            <Textarea value={freeNote} onChange={(e) => setFreeNote(e.target.value)} placeholder="Optional note" rows={2} />
          </Field>
          </fieldset>
          {freeError && <ActionFeedback error className="mt-3">{freeError}</ActionFeedback>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={!!busyId} onClick={closeFree}>Cancel</Button>
          <Button variant="primary" loading={!!busyId} onClick={submitFree}>Mark free</Button>
        </DialogFooter>
      </Dialog>
      <Dialog open={!!elsewhereFor} onClose={closeElsewhere} size="sm">
        <DialogHeader><DialogTitle>Billed on another invoice</DialogTitle></DialogHeader>
        <DialogBody>
          <p className="text-ui-body text-zinc-600 mb-3">
            {elsewhereFor?.customer} · {elsewhereFor?.service_type} · {formatMoney(elsewhereFor?.price)}. Name the invoice that already bills this visit. The visit leaves this list and keeps its revenue. If that invoice is voided later, the visit comes back here. For a duplicate row or a visit that never happened, use Mark free instead.
          </p>
          <fieldset disabled={!!busyId} className="min-w-0 m-0 p-0 border-0 space-y-3">
          <Field label="Invoice number">
            <Input value={elsewhereInvoice} onChange={(e) => setElsewhereInvoice(e.target.value)} placeholder="WPC-2026-0000" autoComplete="off" />
          </Field>
          <Field label="Optional note">
            <Textarea value={elsewhereNote} onChange={(e) => setElsewhereNote(e.target.value)} placeholder="Optional note" rows={2} />
          </Field>
          </fieldset>
          {elsewhereError && <ActionFeedback error className="mt-3">{elsewhereError}</ActionFeedback>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={!!busyId} onClick={closeElsewhere}>Cancel</Button>
          <Button variant="primary" loading={!!busyId} onClick={submitElsewhere}>Save</Button>
        </DialogFooter>
      </Dialog>
    </UiSurface>
  );
}
