import { useMemo, useState } from "react";
import { Badge, Button, UiSurface, cn } from "../../../components/ui";
import { EmptyState, fmtMoney } from "../../../components/dashboard/charts";
import { mrrBridgeVerdict } from "./scorecard-metrics";
import Verdict from "./Verdict";
import FormulaNote from "./FormulaNote";

// Net-MRR bridge (/admin/dashboard/mrr-bridge): WHY recurring revenue moved —
// start → +new → +reactivated → +expansion → −contraction → −churned → end,
// from consecutive per-customer snapshot months. A month strip picks which
// month's bridge is shown. Pre-snapshot months degrade (dashed, approximate,
// customers-table two-bar) rather than hide; the in-progress month is labeled
// and keeps moving until the month-end freeze.
const TONE = {
  add: "#10B981", // new / reactivated / expansion
  contraction: "#F59E0B",
  churn: "#C8312F",
  anchor: "#18181B", // start / end bars
};

export default function MrrBridgeCard({ bridge }) {
  const months = bridge?.months || [];
  // Default to the latest month — usually the in-progress one; the strip
  // switches back through history.
  const [selectedMonth, setSelectedMonth] = useState(null);
  const selected = useMemo(() => {
    if (!months.length) return null;
    return months.find((m) => m.month === selectedMonth) || months[months.length - 1];
  }, [months, selectedMonth]);

  if (!bridge) return <EmptyState>Loading…</EmptyState>;
  if (!selected) return <EmptyState>No recurring-revenue history yet</EmptyState>;

  // Bars scale against the month's biggest absolute figure so the anchors
  // (start/end) fill the track and the movement rows read proportionally.
  const scaleMax = Math.max(
    selected.startMrr || 0,
    selected.endMrr || 0,
    selected.new.mrr,
    selected.churned.mrr,
    1,
  );
  const width = (amount) => `${Math.min(100, (Math.abs(amount) / scaleMax) * 100)}%`;

  const bar = (label, amount, count, color, opts = {}) => (
    <div key={label} className={opts.dim ? "opacity-60" : undefined}>
      <div className="mb-0.5 flex items-baseline justify-between gap-3 text-ui-caption">
        <span className={cn("min-w-0 truncate", opts.big ? "font-medium text-ink-secondary" : "text-ink-secondary")}>
          {label}
          {count > 0 && (
            <span className="ml-1.5 text-ui-caption text-ink-secondary">
              {count} customer{count === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <span className={cn("u-nums whitespace-nowrap", opts.big && "font-medium text-14")} style={{ color: opts.big ? undefined : color }}>
          {amount < 0 ? `−${fmtMoney(Math.abs(amount))}` : fmtMoney(amount)}
        </span>
      </div>
      <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
        <div className="h-full rounded-sm" style={{ width: width(amount), background: color }} />
      </div>
    </div>
  );

  return (
    <UiSurface>
      {/* Month strip */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-2">
        {months.map((m) => (
          <Button
            key={m.month}
            type="button"
            onClick={() => setSelectedMonth(m.month)}
            aria-current={m.month === selected.month ? "true" : undefined}
            variant={m.month === selected.month ? "primary" : "secondary"}
            className={cn("shrink-0 whitespace-nowrap px-3", m.degraded && "border-dashed")}
          >
            {m.label}
          </Button>
        ))}
      </div>

      {/* Inside the card body, not the scrolling strip — the strip overflows
          on phones and would push this off-screen. */}
      {selected.inProgress && (
        <div className="flex justify-end mb-1.5">
          <Badge tone="neutral">in progress</Badge>
        </div>
      )}

      {selected.degraded ? (
        <div className="border border-dashed border-zinc-300 rounded-sm p-2.5">
          <div className="space-y-2">
            {bar("Added (approx.)", selected.new.mrr, selected.new.count, TONE.add)}
            {bar("Lost (approx.)", -selected.churned.mrr, selected.churned.count, TONE.churn)}
            <div className="flex items-baseline justify-between border-t border-hairline border-zinc-100 pt-1 text-ui-caption">
              <span className="font-medium text-ink-secondary">Net (approx.)</span>
              <span className={cn("u-nums font-medium text-14", selected.net < 0 ? "text-alert-fg" : "text-zinc-900")}>
                {selected.net < 0 ? `−${fmtMoney(Math.abs(selected.net))}` : `+${fmtMoney(selected.net)}`}
              </span>
            </div>
          </div>
          <p className="mt-2 text-ui-caption text-ink-secondary">
            Approximate — per-customer snapshots don't cover both this month
            and the one before it
            {bridge.snapshotStart ? ` (snapshots began ${bridge.snapshotStart.slice(0, 7)})` : ""}, so
            it's rebuilt from customer records at today's rates and can't split
            expansion, contraction, or reactivations.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {bar("Start", selected.startMrr, 0, TONE.anchor, { big: true })}
          {bar("New customers", selected.new.mrr, selected.new.count, TONE.add, { dim: selected.new.mrr === 0 })}
          {bar("Reactivated", selected.reactivated.mrr, selected.reactivated.count, TONE.add, { dim: selected.reactivated.mrr === 0 })}
          {bar("Expansion", selected.expansion.mrr, selected.expansion.count, TONE.add, { dim: selected.expansion.mrr === 0 })}
          {bar("Contraction", -selected.contraction.mrr, selected.contraction.count, TONE.contraction, { dim: selected.contraction.mrr === 0 })}
          {bar("Churned", -selected.churned.mrr, selected.churned.count, TONE.churn, { dim: selected.churned.mrr === 0 })}
          {bar("End", selected.endMrr, 0, selected.net < 0 ? TONE.churn : TONE.anchor, { big: true })}
          <div className="flex items-baseline justify-between text-ui-caption">
            <span className="font-medium text-ink-secondary">Net</span>
            <span className={cn("u-nums font-medium text-14", selected.net < 0 ? "text-alert-fg" : "text-zinc-900")}>
              {selected.net < 0 ? `−${fmtMoney(Math.abs(selected.net))}` : `+${fmtMoney(selected.net)}`}
            </span>
          </div>
          {selected.inProgress && (
            <p className="text-ui-caption text-ink-secondary">
              Updates daily until the month-end freeze — churn often lands late
              in the month.
            </p>
          )}
        </div>
      )}

      <Verdict verdict={mrrBridgeVerdict(selected)} />

      <FormulaNote>
        Diffs consecutive months of per-customer rate snapshots (captured daily,
        frozen at month-end): a customer only in this month is new (converted
        this month) or reactivated; only in the prior month is churned at their
        old rate; in both months, the rate delta is expansion or contraction.
        Start + movements = end to the cent. Formula:
        server/services/mrr-bridge.js.
      </FormulaNote>
    </UiSurface>
  );
}
