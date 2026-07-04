import { cn } from "../../../components/ui";
import { EmptyState, fmtMoney } from "../../../components/dashboard/charts";

// Gross margin by service line (/admin/revenue/overview byServiceLine —
// job-costed revenue vs cost per line, zero new SQL). Horizontal bars with a
// target tick at the company target margin; per-line tone reuses the
// dashboard's documented triage palette. Small lines (<5 services) get a
// visible low-sample note, matching the scorecard's no-tooltip-warnings rule.
const TONE = { good: "#10B981", warn: "#F59E0B", bad: "#C8312F" };

export default function MarginByLineBars({ byServiceLine, targetPct = 55 }) {
  const lines = (byServiceLine || []).filter((l) => l.revenue > 0);
  if (!lines.length) return <EmptyState>No job-costed revenue this period</EmptyState>;
  const max = Math.max(...lines.map((l) => l.margin), targetPct, 1);
  const scale = (v) => `${Math.min(100, (Math.max(v, 0) / max) * 100)}%`;

  return (
    <div>
      <div className="space-y-2.5">
        {lines.map((l) => {
          const lowN = (l.services || 0) < 5;
          // Small samples stay neutral — noise isn't a verdict (KpiTile rule).
          const color = lowN
            ? "#9CA3AF"
            : l.margin >= targetPct
              ? TONE.good
              : l.margin >= 45
                ? TONE.warn
                : TONE.bad;
          return (
            <div key={l.serviceLine} className={cn(lowN && "opacity-75")}>
              <div className="flex items-baseline justify-between gap-3 text-12 mb-0.5">
                <span className="min-w-0 truncate text-ink-primary">
                  {l.serviceLine}
                  {lowN && (
                    <span className="ml-1.5 inline-block text-11 px-1.5 py-0.5 rounded-sm border border-amber-300 bg-amber-50 text-amber-700 whitespace-nowrap">
                      Low sample · n={l.services}
                    </span>
                  )}
                </span>
                <span className="u-nums whitespace-nowrap">
                  <span className="font-medium" style={{ color: lowN ? undefined : color }}>
                    {l.margin}%
                  </span>
                  <span className="text-ink-tertiary text-11 ml-2">
                    {fmtMoney(l.revenue)} · {l.services} job{l.services === 1 ? "" : "s"}
                  </span>
                </span>
              </div>
              <div className="relative h-2 bg-surface-sunken rounded-sm overflow-hidden">
                <div className="h-full rounded-sm" style={{ width: scale(l.margin), background: color }} />
                {/* Company target tick */}
                <div
                  className="absolute top-0 bottom-0 w-px bg-zinc-900"
                  style={{ left: scale(targetPct) }}
                  aria-hidden="true"
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 pt-2 border-t border-hairline border-zinc-100 text-11 text-ink-tertiary">
        Fully-burdened margin per line (labor · materials · drive from job
        costing). Tick = {targetPct}% company target; under 45% is the floor.
      </div>
    </div>
  );
}
