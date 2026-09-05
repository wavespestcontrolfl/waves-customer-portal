import { cn } from "../../../components/ui";
import { TrendingUp } from "lucide-react";
import { Tag, formatDate, KpiRow, Kpi, ListHeader, Empty } from "./shared";

function verdictTone(verdict, measured) {
  if (!measured) return "neutral";
  if (verdict === "improved") return "green";
  if (verdict === "regressed") return "alert";
  return "neutral";
}

function QueryImpact({ tq }) {
  return (
    <div key={tq.query} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-13 text-zinc-600">
      <span className="truncate font-medium text-zinc-800">“{tq.query}”</span>
      {tq.after_position != null || tq.before_position != null ? (
        <span className="tabular-nums">
          {tq.before_position != null ? `#${Math.round(tq.before_position)}` : "not ranking"}
          {" → "}
          {tq.after_position != null ? `#${Math.round(tq.after_position)}` : "not ranking"}
        </span>
      ) : (
        <span className="text-zinc-400">no query data yet</span>
      )}
      {tq.position_delta != null && tq.position_delta !== 0 && (
        <span className={cn("tabular-nums", tq.position_delta > 0 ? "text-[#2E7D20]" : "text-[#B42318]")}>
          {tq.position_delta > 0 ? `↑${tq.position_delta}` : `↓${Math.abs(tq.position_delta)}`}
        </span>
      )}
      {tq.clicks != null && (
        <span className="text-12 text-zinc-500">
          {tq.clicks} clicks · {tq.impressions} impr
        </span>
      )}
    </div>
  );
}

function ImpactArticle({ it }) {
  return (
    <div key={it.id} className="rounded-2xl border border-zinc-200 bg-white p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-14 font-medium text-zinc-900">{it.title || it.page_url}</div>
          <a
            href={it.page_url}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block truncate text-12 text-zinc-500 hover:text-zinc-700"
          >
            {it.page_url}
          </a>
        </div>
        <Tag tone={verdictTone(it.verdict, !!it.latest_window)} className="shrink-0">
          {it.latest_window ? it.verdict || "measuring" : "awaiting data"}
        </Tag>
      </div>

      {(it.target_queries?.length ? it.target_queries : it.target_query ? [{ query: it.target_query }] : []).map(
        (tq) => (
          <QueryImpact key={tq.query} tq={tq} />
        ),
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-zinc-500">
        {it.bucket && <Tag>{it.bucket}</Tag>}
        <span>Live {formatDate(it.deployed_at)}</span>
        {it.latest_window && (
          <span className="tabular-nums">
            Page: {it.baseline.position != null ? `#${Math.round(it.baseline.position)}` : "—"} →{" "}
            {it.latest_window.position != null ? `#${Math.round(it.latest_window.position)}` : "—"} ·{" "}
            {it.latest_window.clicks} clicks / {it.latest_window.impressions} impr in {it.latest_window.days}d
          </span>
        )}
        {it.estimated_lift_position != null && (
          <span className="tabular-nums">
            Control-adjusted lift: {it.estimated_lift_position > 0 ? "+" : ""}
            {it.estimated_lift_position} pos · {it.estimated_lift_clicks_pct > 0 ? "+" : ""}
            {it.estimated_lift_clicks_pct}% clicks
          </span>
        )}
      </div>
    </div>
  );
}

export default function ImpactTab({ impactData, impactLoading }) {
  const impactItems = impactData?.items || [];
  const impactTotals = impactData?.totals || {};
  return (
    <div className="pt-4">
      <KpiRow>
        <Kpi label="Articles tracked" value={impactTotals.tracked || 0} />
        <Kpi
          label="Improved"
          value={impactTotals.verdicts?.improved || 0}
          emphasize={(impactTotals.verdicts?.improved || 0) > 0}
        />
        <Kpi label="Regressed" value={impactTotals.verdicts?.regressed || 0} />
        <Kpi label="Clicks (measured windows)" value={impactTotals.window_clicks || 0} />
      </KpiRow>

      <ListHeader icon={TrendingUp} title="Proof of ranking" count={impactItems.length} />
      {impactLoading ? (
        <Empty>Loading…</Empty>
      ) : impactItems.length === 0 ? (
        <Empty>
          No published optimizations tracked yet. A row appears when an engine publish goes live; positions are measured
          14 and 21 days after Google recrawls it.
        </Empty>
      ) : (
        <div className="flex flex-col gap-2.5">
          {impactItems.map((it) => (
            <ImpactArticle key={it.id} it={it} />
          ))}
        </div>
      )}
      <p className="mt-3 text-12 leading-relaxed text-zinc-500">
        Position before → after is the article’s target query in Search Console (impressions-weighted).
        “Control-adjusted lift” subtracts the movement of similar unoptimized pages, so it credits the article only with
        movement the publish caused — stricter than a raw before/after.
      </p>
    </div>
  );
}
