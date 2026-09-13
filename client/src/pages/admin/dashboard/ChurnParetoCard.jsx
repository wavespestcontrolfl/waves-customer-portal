import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CHART_GRID,
  CHART_INK,
  CHART_SUCCESS,
  CHART_TICK,
  EmptyState,
  fmtInt,
  fmtMoney,
} from "../../../components/dashboard/charts";
import { churnParetoVerdict } from "./scorecard-metrics";
import Verdict from "./Verdict";
import FormulaNote from "./FormulaNote";
import { Badge, UiSurface } from "../../../components/ui";

// Churn Pareto (/admin/dashboard/churn-reasons): WHY recurring customers
// leave, as descending lost-MRR bars with a cumulative-% line — the classic
// "which two reasons are 80% of the bleed" read. The unclassified share is
// stated ON the card (the honesty metric), never hidden or tooltip'd.
const TOOLTIP_STYLE = {
  background: "#FFFFFF",
  border: "0.5px solid #E4E4E7",
  borderRadius: 6,
  color: "#18181B",
  fontSize: 14,
  padding: "6px 10px",
};

export default function ChurnParetoCard({ data }) {
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const reasons = (data.reasons || []).filter((r) => r.customers > 0 || r.code === "unclassified");
  const total = data.totals || {};
  if (!total.customers) return <EmptyState>No churned customers in this window</EmptyState>;

  return (
    <UiSurface>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <span className="u-nums text-22 font-medium tracking-tight">{fmtMoney(total.mrr || 0)}</span>
          <span className="ml-1.5 text-ui-caption text-ink-secondary">
            recurring lost · {fmtInt(total.customers)} customer{total.customers === 1 ? "" : "s"}
          </span>
        </div>
        {/* Unclassified share is the card's honesty metric — always visible. */}
        {data.unclassifiedShare > 0 && (
          <Badge tone="neutral" className="shrink-0 whitespace-nowrap">
            {data.unclassifiedShare}% unclassified
          </Badge>
        )}
      </div>

      <div style={{ width: "100%", height: 244 }}>
        <ResponsiveContainer>
          <ComposedChart data={reasons} margin={{ top: 8, right: 4, left: 0, bottom: 4 }}>
            <CartesianGrid stroke={CHART_GRID} strokeWidth={0.5} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 14, fill: CHART_TICK }}
              interval={0}
              angle={-28}
              textAnchor="end"
              height={78}
              tickLine={false}
              axisLine={{ stroke: CHART_GRID }}
            />
            <YAxis
              yAxisId="mrr"
              tick={{ fontSize: 14, fill: CHART_TICK }}
              tickFormatter={(v) => `$${v}`}
              width={62}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              yAxisId="pct"
              orientation="right"
              domain={[0, 100]}
              tick={{ fontSize: 14, fill: CHART_TICK }}
              tickFormatter={(v) => `${v}%`}
              width={50}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) =>
                name === "cumulative"
                  ? [`${value}%`, "cumulative"]
                  : [fmtMoney(value), "lost MRR"]
              }
              labelFormatter={(label, payload) => {
                const row = payload && payload[0] && payload[0].payload;
                return row ? `${label} · ${fmtInt(row.customers)} customer${row.customers === 1 ? "" : "s"}` : label;
              }}
            />
            <Bar yAxisId="mrr" dataKey="mrr" fill={CHART_INK} radius={[2, 2, 0, 0]} maxBarSize={36} />
            <Line
              yAxisId="pct"
              dataKey="cumulativePct"
              name="cumulative"
              stroke={CHART_SUCCESS}
              strokeWidth={1.5}
              dot={{ r: 2.5, fill: CHART_SUCCESS, strokeWidth: 0 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <Verdict verdict={churnParetoVerdict(data)} />

      <FormulaNote>
        Bars are lost recurring revenue per reason (each account's rate
        snapshotted AT churn; pre-taxonomy rows fall back to their last known
        rate); the line is the running share of the total. Codes are recorded
        live from July 2026 — earlier churns stay unclassified until the
        AI backfill runs (owner-authorized, dry-run first). Shaping:
        server/services/churn-pareto.js.
      </FormulaNote>
    </UiSurface>
  );
}
