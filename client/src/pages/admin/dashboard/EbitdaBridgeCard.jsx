import { cn } from "../../../components/ui";
import { EmptyState, fmtMoney } from "../../../components/dashboard/charts";
import { ebitdaVerdict } from "./scorecard-metrics";
import Verdict from "./Verdict";
import FormulaNote from "./FormulaNote";

// Company-level adjusted-EBITDA waterfall (/admin/dashboard/ebitda-bridge).
// Lives NEXT TO the gross-margin tiles in Profit but never mixes with them:
// gross margin judges jobs after COGS; this judges the company after marketing
// and overhead. When overhead assumptions are unentered the waterfall stops at
// Contribution rather than faking an EBITDA (see services/ebitda-bridge.js).
export default function EbitdaBridgeCard({ bridge }) {
  if (!bridge) return <EmptyState>Loading…</EmptyState>;
  if (!Array.isArray(bridge.rows) || !bridge.rows.length || !(bridge.revenue > 0)) {
    return <EmptyState>No completed revenue yet this month</EmptyState>;
  }

  // Bar widths are |amount| relative to revenue (the widest bar by
  // construction); a negative EBITDA can exceed nothing, so clamp anyway.
  const scale = (amount) =>
    `${Math.min(100, (Math.abs(amount) / bridge.revenue) * 100)}%`;

  const rowTone = (r) => {
    if (r.kind === "minus") return { bar: "#D4D4D8", text: "text-ink-secondary" }; // zinc-300
    if (r.kind === "result") {
      return r.amount < 0
        ? { bar: "#C8312F", text: "text-alert-fg" }
        : { bar: "#10B981", text: "text-emerald-700" };
    }
    return { bar: "#18181B", text: "text-zinc-900" }; // start / subtotal
  };

  return (
    <div>
      <div className="space-y-2">
        {bridge.rows.map((r) => {
          const tone = rowTone(r);
          const emphasized = r.kind !== "minus";
          return (
            <div key={r.key}>
              <div className="flex items-baseline justify-between gap-3 text-12 mb-0.5">
                <span className={cn("min-w-0 truncate", emphasized ? "u-label text-ink-secondary" : "text-ink-tertiary")}>
                  {r.label}
                </span>
                <span className={cn("u-nums whitespace-nowrap", emphasized ? "font-medium" : "", tone.text, r.kind === "result" && "text-14")}>
                  {r.kind === "minus" ? `−${fmtMoney(Math.abs(r.amount))}` : fmtMoney(r.amount)}
                  {r.marginPct != null && (
                    <span className="text-ink-tertiary font-normal text-11 ml-1.5">{r.marginPct}%</span>
                  )}
                </span>
              </div>
              <div className="h-2 bg-surface-sunken rounded-sm overflow-hidden">
                <div className="h-full rounded-sm" style={{ width: scale(r.amount), background: tone.bar }} />
              </div>
              {/* Job-costing component detail under the headline COGS row —
                  indented, barless, reconciles via the "Unsplit" line. */}
              {r.key === "cogs" && Array.isArray(bridge.cogsDetail) && bridge.cogsDetail.length > 0 && (
                <div className="mt-1 pl-3 border-l border-hairline border-zinc-200 space-y-0.5">
                  {bridge.cogsDetail.map((d) => (
                    <div key={d.key} className="flex items-baseline justify-between gap-3 text-11 text-ink-tertiary">
                      <span className="truncate">{d.label}</span>
                      <span className="u-nums whitespace-nowrap">
                        {d.amount < 0 ? `+${fmtMoney(Math.abs(d.amount))}` : `−${fmtMoney(d.amount)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!bridge.overheadEntered && (
        <div className="mt-3 text-12 text-ink-tertiary border border-dashed border-zinc-300 rounded-sm px-2.5 py-2">
          Overhead not entered — the bridge stops at Contribution. Add monthly
          operating costs in Settings → Financials → Operating Costs to see
          adjusted EBITDA.
        </div>
      )}

      {/* Basis is stated ON the card, not in a tooltip: an approximated
          EBITDA must never read as an entered one. */}
      {bridge.overheadEntered && bridge.overheadBasis === "pricing_defaults" && (
        <div className="mt-3 text-12 text-amber-700 border border-amber-300 bg-amber-50 rounded-sm px-2.5 py-2">
          Overhead is approximated from pricing-settings assumptions. Enter
          real monthly operating costs (Settings → Financials → Operating
          Costs) for a true adjusted EBITDA.
        </div>
      )}
      {bridge.overheadEntered && bridge.overheadBasis === "entered" && bridge.overheadEnteredAt && (
        <div className="mt-3 text-11 text-ink-tertiary">
          Operating costs entered {String(bridge.overheadEnteredAt).slice(0, 10)}.
        </div>
      )}

      <Verdict verdict={ebitdaVerdict(bridge)} />

      <FormulaNote>
        Revenue − COGS (labor, materials, drive — from job costing) = gross
        profit; − marketing actuals (ad platforms, retainers, referral rewards)
        = contribution; − operating overhead (owner-entered monthly operating
        costs when present, else pricing-settings assumptions
        {bridge.period?.elapsedDays != null && bridge.monthFraction < 1
          ? `; prorated to ${bridge.period.elapsedDays} of ${bridge.period.daysInMonth} days`
          : ""}
        ) = adjusted EBITDA. Adjusted: before owner pay, interest, taxes, and
        depreciation. Formula: server/services/ebitda-bridge.js.
      </FormulaNote>
    </div>
  );
}
