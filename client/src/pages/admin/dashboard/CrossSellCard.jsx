import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UiSurface } from "../../../components/ui";
import {
  CHART_GRID,
  CHART_PRIMARY,
  CHART_TICK,
  EmptyState,
  fmtInt,
} from "../../../components/dashboard/charts";

// Customers with 2+ services (/admin/dashboard/cross-sell, services/cross-sell-rate.js): the share of recurring
// customers who have two or more kinds of recurring service. The big number is today's live value; the small trend is
// the stored months (one per month, written on the 2nd). Read-only: the card sends nothing.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTH_ABBR[Number(String(ym).slice(5, 7)) - 1] || "?"} ’${String(ym).slice(2, 4)}`;
const dayLabel = (ymd) => `${MONTH_ABBR[Number(String(ymd).slice(5, 7)) - 1] || "?"} ${Number(String(ymd).slice(8, 10))}`;
const pct = (share) => (share == null ? "—" : `${(share * 100).toFixed(1)}%`);

// How the added service came in (multi_service_sources buckets), in plain words.
const SOURCE_LABELS = {
  app: "Bought in the Waves app",
  service_report_card: "From the service report card",
  website_quote: "Website quote",
  estimate: "Estimate sent by the office",
  phone_call: "Phone call",
  imported: "Imported before the portal",
  office: "Added by the office",
};

const TOOLTIP_STYLE = {
  background: "#FFFFFF",
  border: "0.5px solid #E4E4E7",
  borderRadius: 6,
  color: "#18181B",
  fontSize: 14,
  padding: "6px 10px",
};

function ShareTrend({ series }) {
  const data = series.map((m) => ({ label: monthLabel(m.month), percent: m.share == null ? null : Math.round(m.share * 1000) / 10 }));
  const format = (v) => `${v}%`;
  return (
    <div role="img" aria-label="Customers with 2+ services by month" style={{ height: 140 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: CHART_TICK, fontSize: 14 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} interval="preserveStartEnd" />
          <YAxis tick={{ fill: CHART_TICK, fontSize: 14 }} tickFormatter={format} tickLine={false} axisLine={false} width={52} domain={[0, "auto"]} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [v == null ? "none" : format(v), "With 2+ services"]} />
          <Line
            type="monotone"
            dataKey="percent"
            stroke={CHART_PRIMARY}
            strokeWidth={1.75}
            dot={{ r: 2, fill: CHART_PRIMARY, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SourceList({ sources }) {
  const rows = Object.entries(sources || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <div className="mb-1 text-ui-caption font-medium text-ink-secondary">How the second service came in</div>
      <ul className="m-0 list-none space-y-1 p-0">
        {rows.map(([key, count]) => (
          <li key={key} className="flex items-baseline justify-between gap-3 text-ui-body text-zinc-900">
            <span>{SOURCE_LABELS[key] || key}</span>
            <span className="u-nums text-ink-secondary">{fmtInt(count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PestOnlyList({ rows, total }) {
  const count = Number.isFinite(total) && total > rows.length ? total : rows.length;
  return (
    <details className="mt-4">
      <summary className="min-h-11 cursor-pointer list-none select-none py-2.5 text-ui-body font-medium text-zinc-900 underline decoration-dotted underline-offset-2 u-focus-ring">
        Pest-only customers ({fmtInt(count)})
      </summary>
      {count > rows.length ? (
        <div className="mt-1 text-ui-caption text-ink-secondary">Showing the first {fmtInt(rows.length)} by last name.</div>
      ) : null}
      {rows.length === 0 ? (
        <div className="mt-1 text-ui-caption text-ink-secondary">Every recurring customer has more than pest control.</div>
      ) : (
        <ul className="m-0 mt-1 max-h-72 list-none space-y-1 overflow-y-auto p-0">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-3 text-ui-body text-zinc-900">
              <span>{[r.firstName, r.lastName].filter(Boolean).join(" ") || "Unnamed"}</span>
              <span className="text-ink-secondary">{r.city || ""}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

export default function CrossSellCard({ data }) {
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const now = data.now || {};
  const series = Array.isArray(data.series) ? data.series : [];
  const pestOnly = Array.isArray(data.pestOnly) ? data.pestOnly : [];

  return (
    <UiSurface>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-28 font-medium u-nums text-zinc-900">{pct(now.share)}</span>
        <span className="text-ui-body text-ink-secondary">of recurring customers have 2+ services</span>
      </div>
      <div className="mt-1 text-ui-caption text-ink-secondary">
        {fmtInt(now.multiServiceCustomers || 0)} of {fmtInt(now.recurringCustomers || 0)}
        {now.asOf ? ` · as of ${dayLabel(now.asOf)}` : ""}
      </div>

      <div className="mt-4">
        <div className="mb-1 text-ui-caption font-medium text-ink-secondary">By month</div>
        {series.length ? (
          <ShareTrend series={series} />
        ) : (
          <div className="text-ui-caption text-ink-secondary">No stored months yet. The first one is written on the 2nd of the month.</div>
        )}
      </div>

      <SourceList sources={data.sources} />
      <PestOnlyList rows={pestOnly} total={Number(data.pestOnlyTotal)} />

      <div className="mt-3 text-ui-caption text-ink-secondary">Counts recurring visits on the schedule. Sends nothing.</div>
    </UiSurface>
  );
}
