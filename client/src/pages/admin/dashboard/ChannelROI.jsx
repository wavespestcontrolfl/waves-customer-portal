import { EmptyState, fmtInt, fmtMoney } from "../../../components/dashboard/charts";
import FormulaNote from "./FormulaNote";

// Channel ROI (/admin/dashboard/channel-roi) — money in vs all-in money out
// per acquisition channel: revenue, gross profit, ad + fixed spend, CAC, cost
// per booked job, ROAS, LTV:CAC. Rows keep the server's revenue-desc order so
// the biggest money line reads first. Strict zinc throughout — a poor ratio
// is context for a budget decision, not an alert, so no alert-fg and no
// banding colors (the ad-dollars card above already carries the verdict
// treatment for the same channels).
const LOW_N = 5; // mirrors capital-allocation's MIN_CONFIDENT_CUSTOMERS

const fmtX = (v) => (v == null ? "—" : `${v}x`);
const fmtTo1 = (v) => (v == null ? "—" : `${v}:1`);
// null means spend that hasn't bought a win yet — "—", never $0 ($0 = free).
const fmtCost = (v) => (v == null ? "—" : fmtMoney(v));

const NUM_COLS = [
  "Revenue",
  "Gross profit",
  "All-in spend",
  "CAC",
  "Cost / job",
  "ROAS",
  "LTV:CAC",
];

export default function ChannelROI({ data, loading, error }) {
  if (loading && !data) return <EmptyState>Loading…</EmptyState>;
  if (error && !data) return <EmptyState>Failed to load channel ROI for this period</EmptyState>;
  const sources = data?.sources || [];
  if (!sources.length) return <EmptyState>No channel spend or attributed revenue this period</EmptyState>;

  return (
    <div>
      {/* Topline: total money in vs total all-in money out, blends visible */}
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <span className="u-nums text-22 font-medium tracking-tight">
            {fmtMoney(data.totalRevenue || 0)}
          </span>
          <span className="text-12 text-ink-secondary ml-1.5">
            revenue on {fmtMoney(data.totalAllInSpend || 0)} all-in spend
          </span>
        </div>
        <span className="u-nums text-11 text-ink-tertiary whitespace-nowrap">
          blended ROAS {fmtX(data.blendedROAS)} · LTV:CAC {fmtTo1(data.blendedLtvCac)}
        </span>
      </div>

      {/* Wide table scrolls inside the card — never the page. */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-12">
          <thead>
            <tr>
              <th className="text-left u-label text-ink-tertiary pr-3 pb-1 font-medium">
                Channel
              </th>
              {NUM_COLS.map((c) => (
                <th
                  key={c}
                  className="text-right u-label text-ink-tertiary pl-3 pb-1 font-medium whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              // A ratio off a handful of customers is noise — same visible-pill
              // rule as the sibling cards (never tooltip-only).
              const lowN = s.allInSpend > 0 && s.customers < LOW_N;
              return (
                <tr key={s.sourceKey} className="border-t border-hairline border-zinc-100 align-top">
                  <td className="pr-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-13 text-ink-primary whitespace-nowrap">{s.source}</span>
                      {lowN && (
                        <span className="inline-block text-11 px-1.5 py-0.5 rounded-sm border border-amber-300 bg-amber-50 text-amber-700 whitespace-nowrap shrink-0">
                          Low sample · n={fmtInt(s.customers)}
                        </span>
                      )}
                    </div>
                    {/* n= on the row, never tooltip-only */}
                    <div className="u-nums text-11 text-ink-tertiary whitespace-nowrap">
                      {fmtInt(s.customers)} customer{s.customers === 1 ? "" : "s"} ·{" "}
                      {fmtInt(s.jobs || 0)} job{s.jobs === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-zinc-900 font-medium whitespace-nowrap">
                    {fmtMoney(s.revenue)}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    {fmtMoney(s.grossProfit)}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    <div>{fmtMoney(s.allInSpend)}</div>
                    {/* Ad/fixed split ON the row whenever a retainer/reward is in the number */}
                    {s.fixedCost > 0 && (
                      <div className="text-11 text-ink-tertiary">
                        {fmtMoney(s.adSpend)} ad + {fmtMoney(s.fixedCost)} fixed
                      </div>
                    )}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    {fmtCost(s.cac)}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    {fmtCost(s.costPerJob)}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    {fmtX(s.roas)}
                  </td>
                  <td className="pl-3 py-1.5 text-right u-nums text-ink-secondary whitespace-nowrap">
                    {fmtTo1(s.ltvCac)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FormulaNote>
        Rows are attribution rows + job costs (completed leads the ad pipeline
        tracked, with deleted and internal leads excluded), not the raw leads
        table — totals can differ from Leads by Source above. Ad spend is true
        platform spend (ad_performance_daily); fixed cost prorates channel
        retainers + referral rewards to this window. CAC = all-in spend ÷ unique
        customers; cost / job = all-in spend ÷ completed visits credited to the
        channel (the same job-costed visits the revenue is summed from, so a
        repeat customer's fifth visit counts — booked-not-yet-done jobs don't);
        ROAS = revenue ÷ all-in spend; LTV:CAC = 12-month gross-profit LTV ÷
        all-in spend (projected for recurring, realized for one-time — same
        basis as the ad-dollars card above). "—" means spend that hasn't bought
        a win yet, not free. Shaping: server/services/channel-attribution.js.
      </FormulaNote>
    </div>
  );
}
