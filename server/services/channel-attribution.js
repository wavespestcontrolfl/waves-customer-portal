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
 * @param {Array} completedRows  ad_service_attribution rows, funnel_stage=completed
 *   (each: { lead_source, completed_revenue, gross_profit, projected_ltv_12mo, is_recurring, customer_id })
 * @param {Object} platformSpendBySource  { '<lead_source>': spend } from ad_performance_daily
 */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function buildChannelAttribution(completedRows = [], platformSpendBySource = {}) {
  const bySource = {};
  const ensure = (src) => {
    if (!bySource[src]) bySource[src] = { revenue: 0, grossProfit: 0, lifetimeValue: 0, customers: new Set() };
    return bySource[src];
  };

  for (const a of completedRows) {
    const s = ensure(a.lead_source || 'unknown');
    const gp = Number(a.gross_profit) || 0;
    const proj = Number(a.projected_ltv_12mo) || 0;
    s.revenue += Number(a.completed_revenue) || 0;
    s.grossProfit += gp;
    // Recurring → projected 12-mo gross profit; otherwise realized gross profit.
    s.lifetimeValue += (a.is_recurring && proj > 0) ? proj : gp;
    if (a.customer_id) s.customers.add(a.customer_id);
  }
  // Seed channels that had spend but no completed leads, so a money-losing month
  // (spend, no acquisitions) shows up instead of vanishing.
  for (const src of Object.keys(platformSpendBySource)) ensure(src);

  const sources = Object.entries(bySource).map(([sourceKey, s]) => {
    const adSpend = round2(platformSpendBySource[sourceKey] || 0);
    const revenue = round2(s.revenue);
    const grossProfit = round2(s.grossProfit);
    const lifetimeValue = round2(s.lifetimeValue);
    const customers = s.customers.size;
    return {
      sourceKey,
      revenue,
      grossProfit,
      lifetimeValue, // projected LTV for recurring + realized GP for one-time
      adSpend,
      customers,
      roas: adSpend > 0 ? round1(revenue / adSpend) : null,
      // Lifetime gross-profit LTV:CAC at the channel level.
      ltvCac: adSpend > 0 ? round1(lifetimeValue / adSpend) : null,
      // null (not 0) when spend bought no customers — 0 would read as "free acquisition".
      cac: customers > 0 ? Math.round(adSpend / customers) : (adSpend > 0 ? null : 0),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = round2(sources.reduce((t, r) => t + r.revenue, 0));
  const totalGrossProfit = round2(sources.reduce((t, r) => t + r.grossProfit, 0));
  const totalLifetimeValue = round2(sources.reduce((t, r) => t + r.lifetimeValue, 0));
  const totalAdSpend = round2(sources.reduce((t, r) => t + r.adSpend, 0));

  return {
    sources,
    totalRevenue,
    totalGrossProfit,
    totalLifetimeValue,
    totalAdSpend,
    blendedROAS: totalAdSpend > 0 ? round1(totalRevenue / totalAdSpend) : null,
    blendedLtvCac: totalAdSpend > 0 ? round1(totalLifetimeValue / totalAdSpend) : null,
  };
}

// Facebook is the one paid lead_source that also collects ORGANIC social: the lead
// webhook stamps lead_source='facebook' for any utm_source=facebook, paid or not.
// Paid Meta clicks carry fbclid/_fbc; re-map the rest to 'facebook_organic' so
// organic completions don't inflate the paid Meta ratio (matched to Meta ad spend)
// while staying visible as their own no-spend channel. Mirrors the fbclid/_fbc
// paid signal the ad-cost allocation path uses. Pure.
function splitFacebookByPaid(rows = []) {
  return rows.map((r) => (
    r.lead_source === 'facebook' && !r.fbclid && !r.fbc
      ? { ...r, lead_source: 'facebook_organic' }
      : r
  ));
}

module.exports = { buildChannelAttribution, splitFacebookByPaid };
