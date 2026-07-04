import { cn } from "../../../components/ui";
import { EmptyState, fmtInt } from "../../../components/dashboard/charts";
import Verdict from "./Verdict";
import FormulaNote from "./FormulaNote";
import { leadFunnelVerdict } from "./scorecard-metrics";

// Lead funnel by source (/admin/dashboard/lead-funnel) — small-multiples for
// the top sources: how far each channel's leads actually get. Counts and
// rates are ON the rows (n= everywhere, low-sample pills, never
// tooltip-only). Source names are plain labels, not drilldowns — attribution
// keys don't match lead_sources.name, so an exact-match drill would land on
// an empty Leads list.
const TOP_N = 5;
const ALL_STAGES = [
  { key: "contacted", label: "Contacted" },
  { key: "estimate", label: "Estimate" },
  { key: "booked", label: "Booked" },
  { key: "completed", label: "Won" },
];

// Only rungs the pipeline actually recorded in this window render — today
// rows move lead → won directly (intermediate stages are schema, not data),
// and showing "0% contacted" for contacts that were simply never written
// would be a lie. Won always renders. stagesPresent comes from the server.
function visibleStages(stagesPresent) {
  const p = stagesPresent || {};
  return ALL_STAGES.filter((st) => st.key === "completed" || p[st.key]);
}

function StageBars({ s, stages }) {
  return (
    <div className="space-y-1">
      {stages.map((st) => {
        const count = s[st.key] || 0;
        const pct = s.leads > 0 ? Math.round((count / s.leads) * 100) : 0;
        return (
          <div key={st.key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-11 text-ink-tertiary">{st.label}</span>
            <div className="flex-1 h-2 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{ width: `${Math.min(100, pct)}%`, background: st.key === "completed" ? "#10B981" : "#18181B" }}
              />
            </div>
            <span className="w-16 shrink-0 text-right u-nums text-11 text-ink-secondary">
              {fmtInt(count)} · {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function FunnelBySource({ data, loading, error }) {
  if (loading && !data) return <EmptyState>Loading…</EmptyState>;
  if (error && !data) return <EmptyState>Failed to load the lead funnel for this period</EmptyState>;
  const sources = data?.sources || [];
  if (!sources.length) return <EmptyState>No attributed leads this period</EmptyState>;

  const top = sources.slice(0, TOP_N);
  const rest = sources.length - top.length;
  const t = data.totals || {};
  const stages = visibleStages(data.stagesPresent);

  return (
    <div>
      {/* Topline: everything in-window, with the paid/organic split visible */}
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <span className="u-nums text-22 font-medium tracking-tight">{fmtInt(t.leads || 0)}</span>
          <span className="text-12 text-ink-secondary ml-1.5">
            leads → {fmtInt(t.completed || 0)} won ({t.completeRate ?? 0}%)
          </span>
        </div>
        <span className="text-11 text-ink-tertiary whitespace-nowrap">
          paid {fmtInt(data.paid?.leads || 0)} · organic {fmtInt(data.organic?.leads || 0)}
        </span>
      </div>

      <div className="space-y-4">
        {top.map((s) => {
          const lowN = s.leads < 5;
          return (
            <div key={s.sourceKey} className={cn(lowN && "opacity-80")}>
              <div className="flex items-center gap-2 mb-1">
                {/* Plain label, deliberately NOT a drilldown: these are
                    attribution keys, and the Leads page filters by exact
                    lead_sources.name — the labels don't match, so a drill
                    would land on an empty list. */}
                <span className="text-13 text-ink-primary font-medium truncate">
                  {s.source}
                </span>
                {s.isPaid && (
                  <span className="inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-label rounded-xs bg-zinc-900 text-white shrink-0">
                    paid
                  </span>
                )}
                {lowN && (
                  <span className="inline-block text-11 px-1.5 py-0.5 rounded-sm border border-amber-300 bg-amber-50 text-amber-700 whitespace-nowrap shrink-0">
                    Low sample · n={fmtInt(s.leads)}
                  </span>
                )}
                <span className="ml-auto u-nums text-11 text-ink-tertiary whitespace-nowrap">
                  {fmtInt(s.leads)} lead{s.leads === 1 ? "" : "s"}
                  {s.lost > 0 && <span className="ml-1.5">· {fmtInt(s.lost)} lost</span>}
                </span>
              </div>
              <StageBars s={s} stages={stages} />
            </div>
          );
        })}
      </div>
      {rest > 0 && (
        <div className="mt-2 text-11 text-ink-tertiary">
          +{rest} smaller source{rest === 1 ? "" : "s"} not shown — every source still counts in the totals above.
        </div>
      )}

      <Verdict verdict={leadFunnelVerdict(data)} />

      <FormulaNote>
        Counts are attribution rows (one per lead the ad pipeline tracked, with
        deleted and internal leads excluded), not the raw leads table — totals
        can differ from Leads by Source above. Stages are cumulative (a booked
        lead counts in every earlier rung) and only rungs the pipeline actually
        recorded render — today most rows move lead → won directly, and the
        middle rungs light up as stage tracking starts writing them. Lost leads
        count only as leads + lost. Call↔lead linkage is call-SID based.
        Shaping: server/services/lead-funnel.js.
      </FormulaNote>
    </div>
  );
}
