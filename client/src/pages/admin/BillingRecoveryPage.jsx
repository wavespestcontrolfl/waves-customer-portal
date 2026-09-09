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
 *   3. List the recurring accounts behind the dashboard's "MRR at risk" action
 *      item (service paused / autopay paused / overdue / prepay invoice unpaid)
 *      — the item deep-links here, so the number has to be actionable here.
 *
 * Autopay customers are intentionally absent from the LEAK queue — they hold no
 * per-visit price and are billed separately by billing-cron off monthly_rate.
 * The server enforces that guard too; this page never auto-bills. (Paused
 * autopay accounts DO appear in the at-risk MRR list — that's the point.)
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Banknote } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Button, Badge, Card, CardHeader, CardTitle, CardBody,
  Table, THead, TBody, TR, TH, TD, Select, Textarea,
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter,
  ActionFeedback, Field, UiSurface, buttonStyles, cn,
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

function VisitRow({ visit, busy, billing, onBill, onFree }) {
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
        </div>
      </TD>
      <TD data-label="Price" nums>{visit.price == null ? "—" : formatMoney(visit.price)}</TD>
      <TD align="right">
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

export default function BillingRecoveryPage() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null);
  const [aging, setAging] = useState(null);
  const [atRiskMrr, setAtRiskMrr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState(null);
  const [freeError, setFreeError] = useState(null);
  const [freeFor, setFreeFor] = useState(null); // visit pending "mark free"
  const [freeReason, setFreeReason] = useState(FREE_REASONS[0]);
  const [freeNote, setFreeNote] = useState("");

  const load = useCallback(async () => {
    setActionError(null);
    setLoading(true);
    setError(null);
    try {
      const [leaks, ar, riskMrr] = await Promise.all([
        adminFetch(`/admin/billing-recovery/leaks?days=${days}`),
        adminFetch(`/admin/billing-recovery/aging`),
        // Fail-soft: the at-risk list renders its own unavailable state
        // rather than blanking the leak queue + AR aging with it.
        adminFetch(`/admin/billing-recovery/at-risk-mrr`).catch(() => null),
      ]);
      setData(leaks);
      setAging(ar);
      setAtRiskMrr(riskMrr);
    } catch (e) {
      setError(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

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
    try {
      await adminFetch(`/admin/billing-recovery/${visit.scheduled_service_id}/bill`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setActionError(e.message || "Could not create invoice");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }, [load]);

  const submitFree = useCallback(async () => {
    if (!freeFor || busyRef.current) return;
    busyRef.current = true;
    setFreeError(null);
    const reason = freeReason === "Other (see note)" ? (freeNote.trim() || "Other") : `${freeReason}${freeNote.trim() ? ` — ${freeNote.trim()}` : ""}`;
    setBusyId(freeFor.scheduled_service_id);
    try {
      await adminFetch(`/admin/billing-recovery/${freeFor.scheduled_service_id}/dismiss`, {
        method: "POST", body: JSON.stringify({ reason }),
      });
      setFreeFor(null);
      setFreeNote("");
      setFreeReason(FREE_REASONS[0]);
      await load();
    } catch (e) {
      setFreeError(e.message || "Could not record disposition");
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }, [freeFor, freeReason, freeNote, load]);

  const summary = !loading && !error ? data?.summary : null;
  const visibleAging = !loading && !error ? aging : null;
  const agingBuckets = aging?.aging || {};
  const showFree = (visit) => {
    setActionError(null);
    setFreeFor(visit);
    setFreeReason(FREE_REASONS[0]);
    setFreeNote("");
    setFreeError(null);
  };
  const closeFree = () => { if (!busyRef.current) setFreeFor(null); };

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

      {error && (
        <ActionFeedback error onRetry={load} className="mb-5">{error}</ActionFeedback>
      )}
      {actionError && <ActionFeedback error className="mb-5">{actionError}</ActionFeedback>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Uninvoiced (leak)" value={summary?.leak_dollars} sub={`${summary?.leak_visits ?? "—"} visits · ${summary?.leak_customers ?? "—"} customers`} />
        <StatCard label="Needs review" value={summary?.review_dollars} sub={`${summary?.review_visits ?? "—"} recurring visits`} />
        <StatCard label="AR outstanding" value={visibleAging?.total_outstanding} sub={`${visibleAging?.invoice_count ?? "—"} invoices`} />
        <StatCard label="AR overdue" value={visibleAging?.total_overdue} alert={visibleAging?.total_overdue > 0} />
      </div>

      {loading ? (
        <div role="status" className="text-ui-body text-ink-secondary min-h-[240px] py-10 text-center">Loading…</div>
      ) : !error && (
        <>
          <Card className="mb-6">
            <CardHeader><CardTitle>Uninvoiced completed visits</CardTitle></CardHeader>
            <CardBody>
              {data?.leaks?.length ? (
                <Table layout="records">
                  <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Price</TH><TH align="right">Action</TH></TR></THead>
                  <TBody>
                    {data.leaks.map((v) => (
                      <VisitRow key={v.scheduled_service_id} visit={v} busy={!!busyId} billing={busyId === v.scheduled_service_id && !freeFor} onBill={(x) => bill(x)} onFree={showFree} />
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="text-ui-body text-ink-secondary py-6 text-center">No uninvoiced visits in this window.</div>
              )}
            </CardBody>
          </Card>

          {data?.needs_review?.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Needs review — recurring or partially prepaid</CardTitle>
                <p className="text-ui-caption text-ink-secondary mt-1">These have a monthly rate, a partial prepayment, or bill per application — confirm they aren't already billed (cadence or completion auto-charge), and bill partial-prepay visits manually so the credit is applied.</p>
              </CardHeader>
              <CardBody>
                <Table layout="records">
                  <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Price</TH><TH align="right">Action</TH></TR></THead>
                  <TBody>
                    {data.needs_review.map((v) => (
                      <VisitRow key={v.scheduled_service_id} visit={v} busy={!!busyId} billing={busyId === v.scheduled_service_id && !freeFor} onBill={(x) => bill(x, { confirm: true })} onFree={showFree} />
                    ))}
                  </TBody>
                </Table>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Accounts receivable aging</CardTitle></CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
                <StatCard label="Current" value={agingBuckets.current} />
                <StatCard label="1–30 days" value={agingBuckets.days_30} />
                <StatCard label="31–60 days" value={agingBuckets.days_60} />
                <StatCard label="61–90+ days" value={agingBuckets.days_90_plus} alert={agingBuckets.days_90_plus > 0} />
              </div>
              {aging?.top_balances?.length ? (
                <Table layout="records">
                  <THead><TR><TH>Customer</TH><TH>Status</TH><TH>Due</TH><TH align="right">Amount</TH></TR></THead>
                  <TBody>
                    {aging.top_balances.map((b) => (
                      <TR key={b.invoice_id}>
                        <TD>{b.customer}</TD>
                        <TD data-label="Status"><span><Badge tone={String(b.status).toLowerCase() === "overdue" ? "alert" : "neutral"}>{b.status}</Badge></span></TD>
                        <TD data-label="Due" className="text-ink-secondary u-nums">{formatDateOnly(b.due_date)}</TD>
                        <TD data-label="Amount" nums>{b.amount == null ? "—" : formatMoney(b.amount)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="text-ui-body text-ink-secondary py-4 text-center">No outstanding balances.</div>
              )}
            </CardBody>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>At-risk MRR</CardTitle>
              <p className="text-ui-caption text-ink-secondary mt-1">
                Recurring accounts whose next monthly charge isn't expected to land. Same definition as the dashboard's MRR tile and its "MRR at risk" action item{atRiskMrr ? ` — ${formatMoney(atRiskMrr.atRisk)} across ${atRiskMrr.count} account${atRiskMrr.count === 1 ? "" : "s"}` : ""}.
              </p>
            </CardHeader>
            <CardBody>
              {atRiskMrr?.accounts?.length ? (
                <Table layout="records">
                  <THead><TR><TH>Customer</TH><TH>Why at risk</TH><TH align="right">Monthly</TH></TR></THead>
                  <TBody>
                    {atRiskMrr.accounts.map((a) => (
                      <TR key={a.id}>
                        <TD>
                          <a
                            href={`/admin/customers?customerId=${a.id}`}
                            className="inline-flex items-center text-zinc-900 underline-offset-2 hover:underline u-focus-ring"
                            data-ui-text-action
                          >
                            {`${a.firstName || ""} ${a.lastName || ""}`.trim() || "Unnamed account"}
                          </a>
                        </TD>
                        <TD data-label="Why at risk">
                          <span className="inline-flex flex-wrap gap-1">
                            {a.causes.map((c) => (
                              <Badge key={c} tone="neutral">{AT_RISK_CAUSE_LABELS[c] || c}</Badge>
                            ))}
                          </span>
                        </TD>
                        <TD data-label="Monthly" nums>{a.monthlyRate == null ? "—" : formatMoney(a.monthlyRate)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                atRiskMrr ? <div className="text-ui-body text-ink-secondary py-4 text-center">Every recurring account is clear to bill.</div>
                  : <ActionFeedback error onRetry={load}>At-risk accounts couldn't be loaded — refresh to retry.</ActionFeedback>
              )}
            </CardBody>
          </Card>
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
    </UiSurface>
  );
}
