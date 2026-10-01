import { useState } from "react";
import { Badge, cn, Select, UiSurface } from "../../../components/ui";
import { EmptyState, fmtInt, fmtMoneyCompact } from "../../../components/dashboard/charts";
import Verdict from "./Verdict";
import FormulaNote from "./FormulaNote";
import { leadFunnelVerdict } from "./scorecard-metrics";
import SampleBadge from "./SampleBadge";

// Lead funnel by source (/admin/dashboard/lead-funnel) — small-multiples for
// the top sources: how far each channel's leads actually get. Counts and
// rates are ON the rows (n= everywhere, low-sample pills, never
// tooltip-only). Source names are plain labels, not drilldowns — attribution
// keys don't match lead_sources.name, so an exact-match drill would land on
// an empty Leads list.
const TOP_N = 5;
// The same funnel along other dimensions (server/services/lead-funnel.js
// breakdowns). "Heard about" is what the visitor said on the form, so it is
// its own view and never re-labels a source.
const VIEWS = [
  { key: "source", label: "Source" },
  { key: "page", label: "Landing page" },
  { key: "service", label: "Service" },
  { key: "city", label: "City" },
  { key: "heard", label: "Heard about (self-reported)" },
];
const viewRows = (data, view) =>
  view === "source"
    ? data?.sources || []
    : (data?.breakdowns?.[view] || []).map((g) => ({ ...g, sourceKey: g.key, source: g.label, isPaid: false }));
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
            <span className="w-20 shrink-0 text-ui-caption text-ink-secondary">{st.label}</span>
            <div className="flex-1 h-2 bg-surface-sunken rounded-sm overflow-hidden">
              <div
                className="h-full rounded-sm"
                style={{ width: `${Math.min(100, pct)}%`, background: st.key === "completed" ? "#10B981" : "#18181B" }}
              />
            </div>
            <span className="w-20 shrink-0 text-right u-nums text-ui-caption text-ink-secondary">
              {fmtInt(count)} · {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function FunnelBySource({ data, loading, error }) {
  const [view, setView] = useState("source");
  if (loading && !data) return <EmptyState>Loading…</EmptyState>;
  if (error && !data) return <EmptyState>Failed to load the lead funnel for this period</EmptyState>;
  if (!data?.sources?.length) return <EmptyState>No attributed leads this period</EmptyState>;
  const sources = viewRows(data, view);

  const top = sources.slice(0, TOP_N);
  const rest = sources.length - top.length;
  const t = data.totals || {};
  const stages = visibleStages(data.stagesPresent);

  return (
    <UiSurface>
      {/* Topline: everything in-window, with the paid/organic split visible */}
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <span className="u-nums text-22 font-medium tracking-tight">{fmtInt(t.leads || 0)}</span>
          <span className="ml-1.5 text-ui-caption text-ink-secondary">
            leads → {fmtInt(t.completed || 0)} won ({t.completeRate ?? 0}%)
          </span>
        </div>
        <span className="whitespace-nowrap text-ui-caption text-ink-secondary">
          paid {fmtInt(data.paid?.leads || 0)} · organic {fmtInt(data.organic?.leads || 0)}
        </span>
      </div>
      <label className="flex items-center gap-2 mb-3 text-ui-caption text-ink-secondary">
        View by
        <Select size="sm" className="!w-auto" value={view} onChange={(e) => setView(e.target.value)}>
          {VIEWS.map((v) => (
            <option key={v.key} value={v.key}>{v.label}</option>
          ))}
        </Select>
      </label>

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
                <span className="truncate text-ui-body font-medium text-ink-primary" title={s.source}>
                  {s.source}
                </span>
                {s.isPaid && (
                  <Badge tone="strong">paid</Badge>
                )}
                {lowN && (
                  <SampleBadge n={s.leads} />
                )}
                <span className="ml-auto whitespace-nowrap u-nums text-ui-caption text-ink-secondary">
                  {fmtInt(s.leads)} lead{s.leads === 1 ? "" : "s"}
                  {s.lost > 0 && <span className="ml-1.5">· {fmtInt(s.lost)} lost</span>}
                  {(s.completed > 0 || s.revenue > 0) && <span className="ml-1.5">· {fmtMoneyCompact(s.revenue)} won</span>}
                </span>
              </div>
              <StageBars s={s} stages={stages} />
            </div>
          );
        })}
      </div>
      {rest > 0 && (
        <div className="mt-2 text-ui-caption text-ink-secondary">
          +{rest} smaller group{rest === 1 ? "" : "s"} not shown — every lead still counts in the totals above.
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
        Won revenue is the completed revenue the attribution sync credited to
        each lead&apos;s row. Landing page is the form page the lead submitted
        from (else the customer&apos;s first landing page); calls and tools that
        record no page show as unknown. Heard about is the visitor&apos;s own
        answer on the form, shown separately from observed attribution; an
        unknown answer stays unknown. Shaping: server/services/lead-funnel.js.
      </FormulaNote>
    </UiSurface>
  );
}
