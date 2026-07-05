/**
 * Channel attribution roll-up for /admin/ads/revenue-attribution.
 *
 * Spend per channel comes from TRUE platform spend (ad_performance_daily summed
 * by ad_campaigns.platform), NOT from summing per-lead ad_cost. Summed ad_cost
 * would miss a paid channel-month that had spend but zero tracked leads (the loss
 * would silently flatter ROAS) and drift by rounding cents. Revenue / gross
 * profit / customers come from the channel's completed leads.
 *
 * Pure / unit-testable.
 *
 * LTV:CAC uses LIFETIME value, not just realized-to-date: for recurring customers
 * that's projected_ltv_12mo (12-mo gross profit, written by ad-attribution-sync,
 * same basis the service-line roll-up uses), falling back to realized gross profit
 * for one-time customers (or recurring rows with no projection). Realized gross
 * profit is still reported separately.
 *
 * Jobs vs customers: `jobs` counts completed COSTED VISITS (the same job_costs ⨝
 * completed scheduled_services set the realized revenue is summed from — see
 * ad-attribution-sync's customerRealized), while `customers` de-dupes by
 * customer_id — so costPerJob and cac deliberately divide the same all-in spend
 * by different denominators (a repeat customer's 5th visit lowers costPerJob,
 * not cac). Because the sync writes a customer's whole realized total onto ONE
 * primary row (first-touch: earliest lead_date, then created_at), the visit
 * count is credited to that same row — never row-counted (a 5-visit repeat
 * customer is 5 jobs, not 1) and never double-credited when a customer has
 * several attribution rows.
 *
 * @param {Array} completedRows  ad_service_attribution rows, funnel_stage=completed
 *   (each: { lead_source, completed_revenue, gross_profit, projected_ltv_12mo, is_recurring,
 *     customer_id, lead_date, created_at })
 * @param {Object} platformSpendBySource  { '<lead_source>': spend } from ad_performance_daily
 * @param {Object} fixedCostBySource  { '<lead_source>': fixed cost over the period }
 *   (SEO retainer, ad-management fees, etc. — the non-ad-platform side of all-in CAC).
 *   adSpend stays platform-only for display; ratios (roas/cac/ltvCac) divide by the
 *   ALL-IN spend (adSpend + fixedCost).
 * @param {Object} jobsByCustomer  { '<customer_id>': completed costed visits in-window }
 *   from job_costs ⨝ completed scheduled_services (fetchChannelAttribution).
 */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

// DATE columns arrive as JS Date objects at UTC midnight; normalize to
// 'YYYY-MM-DD' so first-touch compares chronologically, not by weekday text
// (same recovery ad-attribution-sync's toDateStr does). Undated rows sort last.
function dateKey(v) {
  if (!v) return '9999-99-99';
  return v instanceof Date ? v.toISOString().split('T')[0] : String(v).split('T')[0];
}
function tsKey(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : String(v);
}
function firstTouchKey(row) {
  return `${dateKey(row.lead_date)}|${tsKey(row.created_at)}`;
}

function buildChannelAttribution(completedRows = [], platformSpendBySource = {}, fixedCostBySource = {}, jobsByCustomer = {}) {
  const bySource = {};
  const ensure = (src) => {
    if (!bySource[src]) bySource[src] = { revenue: 0, grossProfit: 0, lifetimeValue: 0, jobs: 0, customers: new Set() };
    return bySource[src];
  };

  // Each customer's completed-visit count is credited exactly once — to their
  // first-touch row (the same earliest lead_date → created_at pick as the
  // sync's pickPrimaryAttributionRow, where the realized revenue was written)
  // — so jobs and revenue always describe the same set of visits.
  const primaryRowByCustomer = new Map();
  for (const a of completedRows) {
    if (!a.customer_id) continue;
    const prev = primaryRowByCustomer.get(a.customer_id);
    if (!prev || firstTouchKey(a) < firstTouchKey(prev)) primaryRowByCustomer.set(a.customer_id, a);
  }

  for (const a of completedRows) {
    const s = ensure(a.lead_source || 'unknown');
    const gp = Number(a.gross_profit) || 0;
    const proj = Number(a.projected_ltv_12mo) || 0;
    s.revenue += Number(a.completed_revenue) || 0;
    s.grossProfit += gp;
    if (a.customer_id && primaryRowByCustomer.get(a.customer_id) === a) {
      s.jobs += Number(jobsByCustomer[a.customer_id]) || 0;
    }
    // Recurring → projected 12-mo gross profit; otherwise realized gross profit.
    s.lifetimeValue += (a.is_recurring && proj > 0) ? proj : gp;
    if (a.customer_id) s.customers.add(a.customer_id);
  }
  // Seed channels that had spend (ad OR fixed) but no completed leads, so a
  // money-losing channel shows up instead of vanishing.
  for (const src of Object.keys(platformSpendBySource)) ensure(src);
  for (const src of Object.keys(fixedCostBySource)) ensure(src);

  const sources = Object.entries(bySource).map(([sourceKey, s]) => {
    const adSpend = round2(platformSpendBySource[sourceKey] || 0); // platform ad spend (display)
    const fixedCost = round2(fixedCostBySource[sourceKey] || 0); // SEO retainer / mgmt fees etc.
    const allInSpend = round2(adSpend + fixedCost); // true cost to acquire — ratios divide by this
    const revenue = round2(s.revenue);
    const grossProfit = round2(s.grossProfit);
    const lifetimeValue = round2(s.lifetimeValue);
    const customers = s.customers.size;
    const jobs = s.jobs;
    return {
      sourceKey,
      revenue,
      grossProfit,
      lifetimeValue, // projected LTV for recurring + realized GP for one-time
      adSpend,
      fixedCost,
      allInSpend,
      customers,
      jobs, // completed costed visits credited to the channel — repeat visits count, unlike `customers`
      roas: allInSpend > 0 ? round1(revenue / allInSpend) : null,
      // Lifetime gross-profit LTV:CAC at the channel level (all-in cost).
      ltvCac: allInSpend > 0 ? round1(lifetimeValue / allInSpend) : null,
      // null (not 0) when spend bought no customers — 0 would read as "free acquisition".
      cac: customers > 0 ? Math.round(allInSpend / customers) : (allInSpend > 0 ? null : 0),
      // Same null-vs-0 rule per JOB won: spend that closed nothing is null, free is 0.
      costPerJob: jobs > 0 ? Math.round(allInSpend / jobs) : (allInSpend > 0 ? null : 0),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = round2(sources.reduce((t, r) => t + r.revenue, 0));
  const totalGrossProfit = round2(sources.reduce((t, r) => t + r.grossProfit, 0));
  const totalLifetimeValue = round2(sources.reduce((t, r) => t + r.lifetimeValue, 0));
  const totalAdSpend = round2(sources.reduce((t, r) => t + r.adSpend, 0));
  const totalFixedCost = round2(sources.reduce((t, r) => t + r.fixedCost, 0));
  const totalAllInSpend = round2(sources.reduce((t, r) => t + r.allInSpend, 0));
  const totalJobs = sources.reduce((t, r) => t + r.jobs, 0);

  return {
    sources,
    totalRevenue,
    totalGrossProfit,
    totalLifetimeValue,
    totalAdSpend,
    totalFixedCost,
    totalAllInSpend,
    totalJobs,
    blendedROAS: totalAllInSpend > 0 ? round1(totalRevenue / totalAllInSpend) : null,
    blendedLtvCac: totalAllInSpend > 0 ? round1(totalLifetimeValue / totalAllInSpend) : null,
  };
}

// Facebook is the one paid lead_source that also collects ORGANIC social: the lead
// webhook stamps lead_source='facebook' for any utm_source=facebook, paid or not.
// Paid Meta leads carry a paid signal — a click id (fbclid/_fbc) OR the explicit
// is_paid flag (call-sourced rows from the paid Facebook tracking number have no
// click cookies, so is_paid is how they're marked paid). Re-map only the rest to
// 'facebook_organic' so organic completions don't inflate the paid Meta ratio
// (matched to Meta ad spend) while staying visible as their own no-spend channel.
// Mirrors the paid signal the ad-cost allocation path uses. Pure.
function splitFacebookByPaid(rows = []) {
  return rows.map((r) => (
    r.lead_source === 'facebook' && !r.fbclid && !r.fbc && !r.is_paid
      ? { ...r, lead_source: 'facebook_organic' }
      : r
  ));
}

module.exports = { buildChannelAttribution, splitFacebookByPaid };
