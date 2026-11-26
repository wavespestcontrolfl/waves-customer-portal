import { UiSurface } from "../../../components/ui";
import { EmptyState, fmtInt, fmtMoney } from "../../../components/dashboard/charts";
import FormulaNote from "./FormulaNote";

// Work and routes (/admin/dashboard/ops-buyer-metrics), read live. Four blocks: how much the business leans on the
// owner, revenue per route day, how full the next 28 days of routes are (planning only), and the return-visit rate.
// A block whose metric failed on the server is null there and shows "unavailable"; a ratio with no denominator is
// null and shows a dash, never a false zero.
const pct = (ratio) => (ratio == null ? "—" : `${Math.round(ratio * 100)}%`);
const hours = (value) => (value == null ? "—" : `${value.toFixed(1)} h`);
const money = (value) => (value == null ? "—" : fmtMoney(value));

const HOURS_SOURCE = {
  time_clock: "from the time clock",
  stops_standard: "estimated from completed stops (no time-clock shifts)",
};

function Block({ title, value, unit, lines = [], note, basis }) {
  return (
    <div>
      <div className="text-ui-caption font-medium text-ink-secondary">{title}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-28 font-medium u-nums text-zinc-900">{value}</span>
        {unit && <span className="text-ui-body text-ink-secondary">{unit}</span>}
      </div>
      {lines.map((line) => (
        <div key={line} className="mt-1 text-ui-caption text-ink-secondary">{line}</div>
      ))}
      {note && <div className="mt-1 text-ui-caption font-medium text-ink-secondary">{note}</div>}
      {basis && <FormulaNote summary="Basis">{basis}</FormulaNote>}
    </div>
  );
}

function Unavailable({ title, reason }) {
  return (
    <div>
      <div className="text-ui-caption font-medium text-ink-secondary">{title}</div>
      <div className="mt-1 text-ui-body text-ink-secondary">{reason ? `Unavailable. ${reason}` : "Unavailable. Try again shortly."}</div>
    </div>
  );
}

function OwnerBlock({ owner }) {
  if (!owner || !owner.ownerFieldHoursPerWeek || !owner.nonOwnerStopShare) {
    return <Unavailable title="Owner reliance" reason={owner?.unavailableReason} />;
  }
  const hoursRow = owner.ownerFieldHoursPerWeek;
  const share = owner.nonOwnerStopShare;
  return (
    <Block
      title="Owner reliance"
      value={hours(hoursRow.last4Weeks)}
      unit="per week, last 4 weeks"
      lines={[
        `Last 4 weeks ${HOURS_SOURCE[hoursRow.sources?.last4Weeks] || "source unknown"}`,
        `${hours(hoursRow.last12Weeks)} per week over the last 12 weeks · ${HOURS_SOURCE[hoursRow.sources?.last12Weeks] || "source unknown"}`,
        `${pct(share.share)} of the last 12 months' stops done by someone other than the owner`
          + (share.ownerStops != null ? ` (${fmtInt(share.otherStops)} of ${fmtInt(share.ownerStops + share.otherStops)})` : ""),
      ]}
      basis={`${hoursRow.basis || ""} ${share.basis || ""}`.trim()}
    />
  );
}

function RevenueBlock({ data }) {
  if (!data) return <Unavailable title="Revenue per route day" />;
  const year = data.last12Months || {};
  const quarter = data.last90Days || {};
  return (
    <Block
      title="Revenue per route day"
      value={money(year.revenuePerRouteDay)}
      unit="last 12 months"
      lines={[
        `${money(quarter.revenuePerRouteDay)} over the last 90 days`,
        `${fmtInt(year.routeDays || 0)} route days in 12 months, ${fmtInt(quarter.routeDays || 0)} in 90 days`,
      ]}
      basis={data.basis}
    />
  );
}

function FillBlock({ data }) {
  if (!data) return <Unavailable title="Route fill" />;
  return (
    <Block
      title="Route fill, next 28 days"
      value={pct(data.fillRatio)}
      unit="of route capacity"
      lines={[
        `${fmtInt(data.scheduledStops || 0)} scheduled stops over ${fmtInt(data.routeDaysAvailable || 0)} route days `
          + `(${data.stopsPerFullDay} stops is a full day)`,
      ]}
      note={data.label}
      basis={data.basis}
    />
  );
}

function ReturnBlock({ data }) {
  if (!data) return <Unavailable title="Return visits" />;
  return (
    <Block
      title="Return-visit rate"
      value={pct(data.rate)}
      unit="last 12 months"
      lines={[`${fmtInt(data.returnVisits || 0)} callbacks and free returns over ${fmtInt(data.completedStops || 0)} completed stops`]}
      basis={data.basis}
    />
  );
}

export default function WorkAndRoutesCard({ data }) {
  if (!data) return <EmptyState>Loading…</EmptyState>;
  return (
    <UiSurface>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <OwnerBlock owner={data.ownerReliance} />
        <RevenueBlock data={data.revenuePerRouteDay} />
        <FillBlock data={data.routeFill} />
        <ReturnBlock data={data.returnVisitRate} />
      </div>
    </UiSurface>
  );
}
