import { fmtMoney, fmtMoneyCompact } from "../../../components/dashboard/charts";
import DashboardFeed from "./DashboardFeed";
import FormulaNote from "./FormulaNote";
import { KpiGrid, KpiTile } from "./KpiTile";
import { isBuyerViewPayload } from "./buyer-view-shape";

// Buyer view (/admin/dashboard/buyer-view): the six numbers a buyer of the business asks about, over the newest 12
// stored months. A figure that is blank on the server (no data, or a part of the year not stored yet) shows a dash,
// never a zero; the sub line says how many months stand behind a partial figure.
const dash = "—";
const pct = (n) => (n == null ? dash : `${n}%`);
const signedPct = (n) => (n == null ? dash : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}%`);
const partial = (counted, wanted = 12) => (counted < wanted ? ` · ${counted} of ${wanted} months` : "");
// A count that belongs to one figure, written beside it: "SDE $31.0k (5 of 12 months)".
const coverage = (counted, wanted = 12) => (counted < wanted ? ` (${counted} of ${wanted} months)` : "");

const GROWTH_UNAVAILABLE_COPY = {
  prior_incomplete: "prior 12 months incomplete",
  needs_24_months: "growth needs 24 stored months",
};

function revenueGrowthText(revenue) {
  if (revenue.growthPct != null) return `${signedPct(revenue.growthPct)} vs the 12 months before`;
  return GROWTH_UNAVAILABLE_COPY[revenue.growthUnavailableReason] || GROWTH_UNAVAILABLE_COPY.needs_24_months;
}

function ownerFieldTimeNote(ownerPay) {
  if (!ownerPay?.months) return "";
  if (ownerPay.fieldMonths === 0) return " · owner field wage not counted";
  return ownerPay.fieldMonths < ownerPay.months
    ? ` · field wage in ${ownerPay.fieldMonths} of ${ownerPay.months} months`
    : "";
}

function tiles(data, arDays) {
  const { revenue, recurring, planRevenueKept, grossMargin, ownerProfit, officeCost, ownerFieldHoursPerWeek: hours } = data;
  const kept = planRevenueKept && !planRevenueKept.error ? planRevenueKept : null;
  const ownerTimeNote = ownerFieldTimeNote(ownerProfit.ownerPay);
  // SDE and the profit margin cover different months (the margin needs the owner's pay worked out), so each says its own count.
  const profitCoverage = ownerProfit.monthsCounted < 12 ? ` · margin from ${ownerProfit.monthsCounted} of 12 months` : "";
  const hoursText = hours?.value != null ? ` · you work ${hours.value} field hrs/week` : "";
  return [
    {
      label: "Revenue, 12 months",
      value: revenue.monthsCounted ? fmtMoneyCompact(revenue.value) : dash,
      sub: `${revenueGrowthText(revenue)}${partial(revenue.monthsCounted)}`,
    },
    {
      label: "Recurring share",
      value: pct(recurring.share),
      sub: `${recurring.matureShareOfRecurring == null ? "no plan revenue yet" : `${recurring.matureShareOfRecurring}% of it from plans over a year old`}${partial(recurring.monthsCounted)}`,
    },
    {
      label: "Plan revenue kept",
      value: kept ? pct(kept.pct) : dash,
      sub: kept
        ? (kept.pct == null ? "needs plan customers over 24 months old" : `${kept.customers} plans from 12 months ago, price rises not counted`)
        : "unavailable",
    },
    {
      label: "Gross margin",
      value: pct(grossMargin.bookPct),
      // Each margin says its own month count: the books margin and the per-job margin are stored from different columns.
      sub: `from the books${coverage(grossMargin.bookMonthsCounted)} · per job at standard minutes ${pct(grossMargin.perJobAtStandardPct)}${coverage(grossMargin.perJobMonthsCounted)}`,
    },
    {
      label: "Owner-paid profit",
      value: pct(ownerProfit.marginPct),
      sub: `SDE ${ownerProfit.sdeMonthsCounted ? fmtMoneyCompact(ownerProfit.sde) : dash}${coverage(ownerProfit.sdeMonthsCounted)}${profitCoverage}${ownerTimeNote}${hoursText}`,
    },
    {
      label: "Office cost per stop",
      value: officeCost.perStop == null ? dash : fmtMoney(officeCost.perStop, { cents: true }),
      sub: `${pct(officeCost.pctOfRevenue)} of revenue${arDays != null ? ` · AR ${arDays} days` : ""}${partial(officeCost.monthsCounted)}`,
    },
  ];
}

function BasisList({ data }) {
  const items = [
    ["Revenue", data.revenue.basis],
    ["Recurring share", data.recurring.basis],
    ["Plan revenue kept", data.planRevenueKept && data.planRevenueKept.basis],
    ["Gross margin", data.grossMargin.basis],
    ["Owner-paid profit", data.ownerProfit.basis],
    ["Office cost per stop", data.officeCost.basis],
  ].filter(([, text]) => text);
  return (
    <FormulaNote summary="How these six are calculated">
      <ul className="space-y-1.5">
        {items.map(([name, text]) => (
          <li key={name}><span className="font-medium text-zinc-900">{name}.</span> {text}</li>
        ))}
      </ul>
    </FormulaNote>
  );
}

export default function BuyerViewRow({ data, pending, onRetry, arDays = null }) {
  const ready = isBuyerViewPayload(data);
  return (
    <section aria-label="Buyer view" className="mb-6">
      <div className="flex items-baseline justify-between gap-3 pb-1.5 border-b border-hairline border-zinc-200 mb-3">
        <h2 className="text-18 font-medium leading-[1.35] text-zinc-900">Buyer view</h2>
        <span className="text-right text-ui-caption text-ink-secondary">
          {ready && data.months.count ? `${data.months.count} stored months to ${data.months.to?.slice(0, 7)}` : "The numbers a buyer asks about"}
        </span>
      </div>
      <DashboardFeed value={ready ? data : null} pending={pending} label="buyer view" onRetry={onRetry}>
        {ready && (
          <>
            <KpiGrid className="grid grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3">
              {tiles(data, arDays).map((tile) => <KpiTile key={tile.label} {...tile} />)}
            </KpiGrid>
            {data.pnlIncompleteMonths?.length > 0 && (
              <div className="mt-2 text-ui-caption text-ink-secondary">
                {data.pnlIncompleteMonths.length} stored month(s) were written before the Stripe ledger finished syncing, so their cash figures can still change.
              </div>
            )}
            <BasisList data={data} />
          </>
        )}
      </DashboardFeed>
    </section>
  );
}
