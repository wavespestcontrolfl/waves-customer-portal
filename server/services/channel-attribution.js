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
 * @param {Array} completedRows  ad_service_attribution rows, funnel_stage=completed
 *   (each: { lead_source, completed_revenue, gross_profit, customer_id })
 * @param {Object} platformSpendBySource  { '<lead_source>': spend } from ad_performance_daily
 */
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function buildChannelAttribution(completedRows = [], platformSpendBySource = {}) {
  const bySource = {};
  const ensure = (src) => {
    if (!bySource[src]) bySource[src] = { revenue: 0, grossProfit: 0, customers: new Set() };
    return bySource[src];
  };

  for (const a of completedRows) {
    const s = ensure(a.lead_source || 'unknown');
    s.revenue += Number(a.completed_revenue) || 0;
    s.grossProfit += Number(a.gross_profit) || 0;
    if (a.customer_id) s.customers.add(a.customer_id);
  }
  // Seed channels that had spend but no completed leads, so a money-losing month
  // (spend, no acquisitions) shows up instead of vanishing.
  for (const src of Object.keys(platformSpendBySource)) ensure(src);

  const sources = Object.entries(bySource).map(([sourceKey, s]) => {
    const adSpend = round2(platformSpendBySource[sourceKey] || 0);
    const revenue = round2(s.revenue);
    const grossProfit = round2(s.grossProfit);
    const customers = s.customers.size;
    return {
      sourceKey,
      revenue,
      grossProfit,
      adSpend,
      customers,
      roas: adSpend > 0 ? round1(revenue / adSpend) : null,
      // Gross-profit LTV:CAC at the channel level (per-customer normalization cancels).
      ltvCac: adSpend > 0 ? round1(grossProfit / adSpend) : null,
      // null (not 0) when spend bought no customers — 0 would read as "free acquisition".
      cac: customers > 0 ? Math.round(adSpend / customers) : (adSpend > 0 ? null : 0),
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = round2(sources.reduce((t, r) => t + r.revenue, 0));
  const totalGrossProfit = round2(sources.reduce((t, r) => t + r.grossProfit, 0));
  const totalAdSpend = round2(sources.reduce((t, r) => t + r.adSpend, 0));

  return {
    sources,
    totalRevenue,
    totalGrossProfit,
    totalAdSpend,
    blendedROAS: totalAdSpend > 0 ? round1(totalRevenue / totalAdSpend) : null,
    blendedLtvCac: totalAdSpend > 0 ? round1(totalGrossProfit / totalAdSpend) : null,
  };
}

module.exports = { buildChannelAttribution };
