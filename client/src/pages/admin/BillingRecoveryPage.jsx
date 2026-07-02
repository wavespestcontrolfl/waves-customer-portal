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
import React, { useCallback, useEffect, useState } from "react";
import { Banknote } from "lucide-react";
import {
  Button, Badge, Card, CardHeader, CardTitle, CardBody,
  Table, THead, TBody, TR, TH, TD, Select, Textarea,
  Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter, cn,
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
        <div className="text-12 uppercase tracking-label text-zinc-500">{label}</div>
        <div className={cn("text-28 font-medium mt-1 tabular-nums", alert ? "text-alert-fg" : "text-zinc-900")}>{value}</div>
        {sub != null && <div className="text-12 text-zinc-500 mt-0.5">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function VisitRow({ visit, busy, onBill, onFree, confirmBill }) {
  const ago = daysSince(visit.completed_at);
  return (
    <TR>
      <TD>{visit.customer || "—"}</TD>
      <TD className="text-zinc-500">
        {formatETDate(visit.completed_at)}
        {ago != null && <span className="text-zinc-400"> · {ago}d ago</span>}
      </TD>
      <TD>{visit.service_type || "—"}</TD>
      <TD nums>{formatMoney(visit.price)}</TD>
      <TD align="right">
        <div className="flex gap-2 justify-end">
          <Button
            size="sm"
            variant={confirmBill ? "secondary" : "primary"}
            disabled={busy || !visit.billable}
            onClick={() => onBill(visit)}
            title={!visit.billable ? "No completion record — cannot invoice" : undefined}
          >
            Bill
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onFree(visit)}>
            Mark free
          </Button>
        </div>
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
  const [freeFor, setFreeFor] = useState(null); // visit pending "mark free"
  const [freeReason, setFreeReason] = useState(FREE_REASONS[0]);
  const [freeNote, setFreeNote] = useState("");

  const load = useCallback(async () => {
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
    if (confirm && !window.confirm(
      `${visit.customer} has a monthly rate (${formatMoney(visit.monthly_rate)}). ` +
      `Confirm they are NOT billed on a recurring cadence before invoicing this visit. Continue?`,
    )) return;
    setBusyId(visit.scheduled_service_id);
    try {
      await adminFetch(`/admin/billing-recovery/${visit.scheduled_service_id}/bill`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      window.alert(e.message || "Could not create invoice");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const submitFree = useCallback(async () => {
    if (!freeFor) return;
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
      window.alert(e.message || "Could not record disposition");
    } finally {
      setBusyId(null);
    }
  }, [freeFor, freeReason, freeNote, load]);

  const summary = data?.summary;
  const agingBuckets = aging?.aging || {};

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-22 font-medium text-zinc-900 flex items-center gap-2">
            <Banknote className="w-5 h-5 text-zinc-500" /> Billing Recovery
          </h1>
          <p className="text-13 text-zinc-500 mt-1">
            Completed visits that were never invoiced, plus aging receivables. Autopay visits are excluded — they bill separately.
          </p>
        </div>
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-44">
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 365 days</option>
        </Select>
      </div>

      {error && (
        <div className="mb-4 text-13 text-alert-fg bg-alert-bg rounded px-3 py-2">{error}</div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Uninvoiced (leak)" value={formatMoney(summary?.leak_dollars)} sub={`${summary?.leak_visits || 0} visits · ${summary?.leak_customers || 0} customers`} />
        <StatCard label="Needs review" value={formatMoney(summary?.review_dollars)} sub={`${summary?.review_visits || 0} recurring visits`} />
        <StatCard label="AR outstanding" value={formatMoney(aging?.total_outstanding)} sub={`${aging?.invoice_count || 0} invoices`} />
        <StatCard label="AR overdue" value={formatMoney(aging?.total_overdue)} alert={(aging?.total_overdue || 0) > 0} />
      </div>

      {loading ? (
        <div className="text-13 text-zinc-500 py-10 text-center">Loading…</div>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader><CardTitle>Uninvoiced completed visits</CardTitle></CardHeader>
            <CardBody>
              {data?.leaks?.length ? (
                <Table>
                  <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Price</TH><TH align="right">Action</TH></TR></THead>
                  <TBody>
                    {data.leaks.map((v) => (
                      <VisitRow key={v.scheduled_service_id} visit={v} busy={busyId === v.scheduled_service_id} onBill={(x) => bill(x)} onFree={setFreeFor} />
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="text-13 text-zinc-500 py-6 text-center">No uninvoiced visits in this window. 🎉</div>
              )}
            </CardBody>
          </Card>

          {data?.needs_review?.length > 0 && (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Needs review — recurring or partially prepaid</CardTitle>
                <p className="text-12 text-zinc-500 mt-1">These have a monthly rate or a partial prepayment — confirm they aren't billed on a cadence, and bill partial-prepay visits manually so the credit is applied.</p>
              </CardHeader>
              <CardBody>
                <Table>
                  <THead><TR><TH>Customer</TH><TH>Visit</TH><TH>Service</TH><TH align="right">Price</TH><TH align="right">Action</TH></TR></THead>
                  <TBody>
                    {data.needs_review.map((v) => (
                      <VisitRow key={v.scheduled_service_id} visit={v} busy={busyId === v.scheduled_service_id} confirmBill onBill={(x) => bill(x, { confirm: true })} onFree={setFreeFor} />
                    ))}
                  </TBody>
                </Table>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Accounts receivable aging</CardTitle></CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <StatCard label="Current" value={formatMoney(agingBuckets.current)} />
                <StatCard label="1–30 days" value={formatMoney(agingBuckets.days_30)} />
                <StatCard label="31–60 days" value={formatMoney(agingBuckets.days_60)} />
                <StatCard label="61–90+ days" value={formatMoney(agingBuckets.days_90_plus)} alert={(agingBuckets.days_90_plus || 0) > 0} />
              </div>
              {aging?.top_balances?.length ? (
                <Table>
                  <THead><TR><TH>Customer</TH><TH>Status</TH><TH>Due</TH><TH align="right">Amount</TH></TR></THead>
                  <TBody>
                    {aging.top_balances.map((b) => (
                      <TR key={b.invoice_id}>
                        <TD>{b.customer}</TD>
                        <TD><Badge tone={String(b.status).toLowerCase() === "overdue" ? "alert" : "neutral"}>{b.status}</Badge></TD>
                        <TD className="text-zinc-500">{formatDateOnly(b.due_date)}</TD>
                        <TD nums>{formatMoney(b.amount)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="text-13 text-zinc-500 py-4 text-center">No outstanding balances.</div>
              )}
            </CardBody>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>At-risk MRR</CardTitle>
              <p className="text-12 text-zinc-500 mt-1">
                Recurring accounts whose next monthly charge isn't expected to land. Same definition as the dashboard's MRR tile and its "MRR at risk" action item{atRiskMrr ? ` — ${formatMoney(atRiskMrr.atRisk)} across ${atRiskMrr.count} account${atRiskMrr.count === 1 ? "" : "s"}` : ""}.
              </p>
            </CardHeader>
            <CardBody>
              {atRiskMrr?.accounts?.length ? (
                <Table>
                  <THead><TR><TH>Customer</TH><TH>Why at risk</TH><TH align="right">Monthly</TH></TR></THead>
                  <TBody>
                    {atRiskMrr.accounts.map((a) => (
                      <TR key={a.id}>
                        <TD>
                          <a
                            href={`/admin/customers?customerId=${a.id}`}
                            className="text-zinc-900 underline-offset-2 hover:underline u-focus-ring"
                          >
                            {`${a.firstName || ""} ${a.lastName || ""}`.trim() || "Unnamed account"}
                          </a>
                        </TD>
                        <TD>
                          <span className="inline-flex flex-wrap gap-1">
                            {a.causes.map((c) => (
                              <Badge key={c} tone="neutral">{AT_RISK_CAUSE_LABELS[c] || c}</Badge>
                            ))}
                          </span>
                        </TD>
                        <TD nums>{formatMoney(a.monthlyRate)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              ) : (
                <div className="text-13 text-zinc-500 py-4 text-center">
                  {atRiskMrr ? "Every recurring account is clear to bill. 🎉" : "At-risk accounts couldn't be loaded — refresh to retry."}
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      <Dialog open={!!freeFor} onClose={() => setFreeFor(null)} size="sm">
        <DialogHeader><DialogTitle>Mark visit as intentionally free</DialogTitle></DialogHeader>
        <DialogBody>
          <p className="text-13 text-zinc-600 mb-3">
            {freeFor?.customer} · {freeFor?.service_type} · {formatMoney(freeFor?.price)}. This records the visit as no-cost — no invoice is created.
          </p>
          <label className="text-12 uppercase tracking-label text-zinc-500">Reason</label>
          <Select value={freeReason} onChange={(e) => setFreeReason(e.target.value)} className="w-full mt-1 mb-3">
            {FREE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Textarea value={freeNote} onChange={(e) => setFreeNote(e.target.value)} placeholder="Optional note" rows={2} className="w-full" />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setFreeFor(null)}>Cancel</Button>
          <Button variant="primary" disabled={busyId === freeFor?.scheduled_service_id} onClick={submitFree}>Mark free</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
