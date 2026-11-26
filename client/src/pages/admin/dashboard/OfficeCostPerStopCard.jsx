import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { UiSurface } from "../../../components/ui";
import {
  CHART_GRID,
  CHART_PRIMARY,
  CHART_SUCCESS,
  CHART_TICK,
  EmptyState,
  fmtInt,
  fmtMoney,
} from "../../../components/dashboard/charts";
import FormulaNote from "./FormulaNote";

// Office cost per stop (/admin/dashboard/office-cost-per-stop), from the stored monthly
// snapshots. Headline = the last three stored months (office cost / paid stops). Two small
// line charts sit side by side: office cost per stop by month, and paid stops by month.
// A month with no paid stops has no cost per stop (null), so that line breaks instead of
// drawing a false zero.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym) => `${MONTH_ABBR[Number(String(ym).slice(5, 7)) - 1] || "?"} ’${String(ym).slice(2, 4)}`;

// "Aug ’26 – Oct ’26", or one month's label, or null with no months.
const rangeLabel = (months = []) => {
  const [first] = months;
  const last = months[months.length - 1];
  if (first === undefined) return null;
  return first === last ? monthLabel(first) : `${monthLabel(first)} – ${monthLabel(last)}`;
};

// The note under the headline, by how many of the trailing months used the owner's office-time allowance.
const OWNER_TIME_NOTE = {
  none: () => "Your own office time is not counted yet. Add your hours and rate in Settings → Financials → Costs.",
  some: (o) => `Your own office time is counted in ${o.monthsWithAllowance} of the last ${o.months} months `
    + "(it was added to Settings partway through), so this figure mixes the two.",
};

const TOOLTIP_STYLE = {
  background: "#FFFFFF",
  border: "0.5px solid #E4E4E7",
  borderRadius: 6,
  color: "#18181B",
  fontSize: 14,
  padding: "6px 10px",
};

function MiniLine({ data, dataKey, stroke, format, label, height = 140 }) {
  return (
    <div role="img" aria-label={label} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: CHART_TICK, fontSize: 14 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} interval="preserveStartEnd" />
          <YAxis tick={{ fill: CHART_TICK, fontSize: 14 }} tickFormatter={format} tickLine={false} axisLine={false} width={52} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [v == null ? "none" : format(v), label]} />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            strokeWidth={1.75}
            dot={{ r: 2, fill: stroke, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function OfficeCostPerStopCard({ data }) {
  if (!data) return <EmptyState>Loading…</EmptyState>;
  const months = Array.isArray(data.months) ? data.months : [];
  if (!months.length) {
    return <EmptyState>No monthly snapshots yet — the first one is written on the 2nd of the month</EmptyState>;
  }
  const series = months.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const trailing = data.trailing || {};
  const trailingLabel = rangeLabel(trailing.months);
  // From what each stored month used (owner_allowance), not from today's settings.
  const owner = data.ownerOfficeTime || { status: "none", monthsWithAllowance: 0, months: 0 };
  const ownerNote = OWNER_TIME_NOTE[owner.status]?.(owner);
  const pnlIncomplete = data.pnlIncompleteMonths ?? [];

  return (
    <UiSurface>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-28 font-medium u-nums text-zinc-900">
          {trailing.officeCostPerStop != null ? fmtMoney(trailing.officeCostPerStop, { cents: true }) : "—"}
        </span>
        <span className="text-ui-body text-ink-secondary">per stop, last {trailing.months?.length || 0} months</span>
      </div>
      <div className="mt-1 text-ui-caption text-ink-secondary">
        {trailingLabel ? `${trailingLabel} · ` : ""}
        {fmtMoney(trailing.officeCost || 0)} office cost over {fmtInt(trailing.paidStops || 0)} paid stops
      </div>
      {ownerNote && <div className="mt-2 text-ui-caption text-ink-secondary">{ownerNote}</div>}
      {pnlIncomplete.length > 0 && (
        <div className="mt-2 text-ui-caption text-ink-secondary">
          Cash revenue and net income for {pnlIncomplete.map(monthLabel).join(", ")} were stored before the
          Stripe ledger finished syncing, so they can still change. Office cost and paid stops are not affected.
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-ui-caption font-medium text-ink-secondary">Office cost per stop</div>
          <MiniLine
            data={series}
            dataKey="officeCostPerStop"
            stroke={CHART_PRIMARY}
            format={(v) => fmtMoney(v, { cents: true })}
            label="Office cost per stop"
          />
        </div>
        <div>
          <div className="mb-1 text-ui-caption font-medium text-ink-secondary">Paid stops</div>
          <MiniLine
            data={series}
            dataKey="paidStops"
            stroke={CHART_SUCCESS}
            format={(v) => fmtInt(v)}
            label="Paid stops"
          />
        </div>
      </div>

      <FormulaNote>
        Office cost = ledger expenses in {(data.officeCategories || []).join(", ")}
        {owner.status !== "none" ? ", plus your own office hours × your hourly rate (in the months it was set)" : ""}. Insurance, vehicle, ads, card fees,
        interest, taxes, supplies and depreciation are left out on purpose: they are field or non-office costs.
        Paid stops = completed visits in the month that are not callbacks or free returns. Each month is stored
        on the 2nd of the next month and re-written once more a month later for late entries.
        Formula: server/services/monthly-financial-snapshot.js.
      </FormulaNote>
    </UiSurface>
  );
}
