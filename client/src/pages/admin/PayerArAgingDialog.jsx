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
} from "../../components/ui";
import { adminFetch } from "../../lib/adminFetch";

const money = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const termLabel = (v) => ({ net15: "Net 15", net30: "Net 30" }[v] || v);

export default function PayerArAgingDialog({ onClose, onSelectPayer }) {
  const [ar, setAr] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await adminFetch("/admin/payers/ar-aging");
        const d = await r.json();
        if (alive) setAr(d || null);
      } catch {
        if (alive) setAr(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
          <p className="text-13 text-zinc-400 py-4">Loading…</p>
        ) : !ar || ar.statement_count === 0 ? (
          <p className="text-13 text-zinc-400 py-4">
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
                <div className="text-11 text-zinc-500 uppercase tracking-label mb-1">By age</div>
                <div className="border-hairline rounded-sm overflow-hidden">
                  {bucketRows.map(([label, b], i) => (
                    <div
                      key={label}
                      className={`flex items-center justify-between gap-3 px-3 py-1.5 text-12 ${i % 2 ? "bg-zinc-50/60" : ""}`}
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
                <div className="text-11 text-zinc-500 uppercase tracking-label mb-1">By terms</div>
                <div className="border-hairline rounded-sm overflow-hidden">
                  {Object.keys(terms).length === 0 ? (
                    <div className="px-3 py-1.5 text-12 text-zinc-400">—</div>
                  ) : (
                    Object.entries(terms).map(([t, v], i) => (
                      <div
                        key={t}
                        className={`flex items-center justify-between gap-3 px-3 py-1.5 text-12 ${i % 2 ? "bg-zinc-50/60" : ""}`}
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
              <div className="text-11 text-zinc-500 uppercase tracking-label mb-1">
                Collections worklist (oldest first)
              </div>
              <Table>
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
                        <button
                          type="button"
                          className="text-zinc-900 hover:underline text-left"
                          onClick={() => onSelectPayer && onSelectPayer(p.payer_id)}
                        >
                          {p.payer_name}
                        </button>
                      </TD>
                      <TD className="text-right text-zinc-700">{money(p.outstanding_total)}</TD>
                      <TD className="text-right">
                        {p.past_due_total > 0 ? (
                          <span className="text-alert-fg">{money(p.past_due_total)}</span>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                      </TD>
                      <TD className="text-right">
                        {p.oldest_days_past_due > 0 ? (
                          <Badge tone="alert">{p.oldest_days_past_due}d</Badge>
                        ) : (
                          <span className="text-zinc-400">—</span>
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
      <div className="text-11 text-zinc-500 uppercase tracking-label">{label}</div>
      <div className={`text-16 font-medium ${alert ? "text-alert-fg" : "text-zinc-900"}`}>{value}</div>
    </div>
  );
}
