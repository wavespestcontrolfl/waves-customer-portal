/**
 * Cross-payer AR aging ("AR by terms" + collections worklist) — Phase 2 P5 UI.
 *
 * Reads GET /admin/payers/ar-aging (the same `computePayerArAging` the IB tool
 * uses, so the numbers match). Org-wide outstanding NET-terms statement balance,
 * bucketed by days past due, split by terms, plus the per-payer worklist sorted
 * oldest-past-due first. Gate-dark safe — zeros until statements exist.
 */

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Button,
  Badge,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  ActionFeedback,
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";

const money = (n) =>
  n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const termLabel = (v) => ({ net15: "Net 15", net30: "Net 30" }[v] || v);

export default function PayerArAgingDialog({ onClose, onSelectPayer }) {
  const [ar, setAr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const r = await adminFetch("/admin/payers/ar-aging");
        const d = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(d?.payers)) throw new Error(d?.error || "Could not load payer AR aging.");
        if (alive) setAr(d || null);
      } catch (err) {
        if (alive) setError(err.message || "Could not load payer AR aging.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const buckets = ar?.buckets || {};
  const bucketRows = [
    ["Current", buckets.current],
    ["1–15 days", buckets.b1_15],
    ["16–30 days", buckets.b16_30],
    ["31–45 days", buckets.b31_45],
    ["45+ days", buckets.b45_plus],
  ];
  const terms = ar?.by_terms || {};

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Payer AR aging</DialogTitle>
      </DialogHeader>
      <DialogBody className="space-y-4">
        {loading ? (
          <div className="min-h-[160px]"><ActionFeedback>Loading…</ActionFeedback></div>
        ) : error ? <ActionFeedback error onRetry={() => setAttempt((value) => value + 1)}>{error}</ActionFeedback>
        : ar?.statement_count === 0 ? (
          <p className="text-ui-body text-ink-secondary py-4">
            No outstanding payer statements. Balances appear here once NET-terms
            statements are sent.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-5">
              <Stat label="Outstanding" value={money(ar.outstanding_total)} />
              <Stat label="Past due" value={money(ar.past_due_total)} alert={ar.past_due_total > 0} />
              <Stat label="Statements" value={ar.statement_count} />
              {ar.oldest_days_past_due > 0 && (
                <Stat label="Oldest" value={`${ar.oldest_days_past_due}d`} alert />
              )}
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-ui-label font-medium text-ink-secondary mb-2">By age</h3>
                <div className="border-hairline border-zinc-200 rounded-md overflow-hidden">
                  {bucketRows.map(([label, b], i) => (
                    <div
                      key={label}
                      className={`flex items-center justify-between gap-3 px-3 py-2 text-ui-caption u-nums ${i % 2 ? "bg-zinc-50/60" : ""}`}
                    >
                      <span className="text-zinc-600">{label}</span>
                      <span className={i >= 2 && b?.total > 0 ? "text-alert-fg" : "text-zinc-700"}>
                        {money(b?.total)} {b?.count ? `(${b.count})` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-ui-label font-medium text-ink-secondary mb-2">By terms</h3>
                <div className="border-hairline border-zinc-200 rounded-md overflow-hidden">
                  {Object.keys(terms).length === 0 ? (
                    <div className="px-3 py-2 text-ui-caption u-nums text-ink-secondary">—</div>
                  ) : (
                    Object.entries(terms).map(([t, v], i) => (
                      <div
                        key={t}
                        className={`flex items-center justify-between gap-3 px-3 py-2 text-ui-caption u-nums ${i % 2 ? "bg-zinc-50/60" : ""}`}
                      >
                        <span className="text-zinc-600">{termLabel(t)}</span>
                        <span className="text-zinc-700">
                          {money(v?.total)} {v?.count ? `(${v.count})` : ""}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-ui-label font-medium text-ink-secondary mb-2">
                Collections worklist (oldest first)
              </h3>
              <Table layout="records" aria-label="Payer collections worklist">
                <THead>
                  <TR>
                    <TH>Payer</TH>
                    <TH className="text-right">Outstanding</TH>
                    <TH className="text-right">Past due</TH>
                    <TH className="text-right">Oldest</TH>
                  </TR>
                </THead>
                <TBody>
                  {ar.payers.map((p) => (
                    <TR key={p.payer_id}>
                      <TD>
                        <Button
                          variant="ghost"
                          className="max-w-full justify-start text-left"
                          onClick={(event) => {
                            event.currentTarget.focus({ preventScroll: true });
                            onSelectPayer?.(p.payer_id);
                          }}
                        >
                          {p.payer_name}
                        </Button>
                      </TD>
                      <TD data-label="Outstanding" nums align="right" className="whitespace-nowrap text-zinc-700">{money(p.outstanding_total)}</TD>
                      <TD data-label="Past due" nums align="right" className="whitespace-nowrap">
                        {p.past_due_total > 0 ? (
                          <span className="text-alert-fg">{money(p.past_due_total)}</span>
                        ) : (
                          <span className="text-ink-secondary">—</span>
                        )}
                      </TD>
                      <TD data-label="Oldest" nums align="right" className="whitespace-nowrap">
                        {p.oldest_days_past_due > 0 ? (
                          <span><Badge tone="alert">{p.oldest_days_past_due}d</Badge></span>
                        ) : (
                          <span className="text-ink-secondary">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
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
