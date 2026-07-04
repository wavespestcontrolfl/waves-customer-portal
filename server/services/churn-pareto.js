/**
 * Churn Pareto — shape churned-customer rows grouped by churn_reason_code
 * into descending-MRR Pareto rows with a cumulative-% line (Growth Command
 * Center Phase 7). 'unclassified' is ALWAYS present (NULL codes coalesce into
 * it, and a zero row is injected if absent) — hiding the unknown share is how
 * churn dashboards lie. Pure / unit-testable.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct1 = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

const CODE_LABELS = {
  price: 'Price',
  moving: 'Moving away',
  service_quality: 'Service quality',
  results: 'Results',
  competitor: 'Competitor',
  seasonal_pause: 'Seasonal pause',
  financial: 'Financial hardship',
  no_longer_needed: 'No longer needed',
  other: 'Other',
  unclassified: 'Unclassified',
};

/**
 * buildChurnPareto(rows) — rows: [{ code, customers, mrr }] (code may be null).
 */
function buildChurnPareto(rows = []) {
  const byCode = new Map();
  for (const r of rows) {
    const code = CODE_LABELS[r.code] ? r.code : 'unclassified';
    if (!byCode.has(code)) byCode.set(code, { code, customers: 0, mrr: 0 });
    const e = byCode.get(code);
    e.customers += parseInt(r.customers, 10) || 0;
    e.mrr += parseFloat(r.mrr) || 0;
  }
  if (!byCode.has('unclassified')) byCode.set('unclassified', { code: 'unclassified', customers: 0, mrr: 0 });

  const totalMrr = round2([...byCode.values()].reduce((t, e) => t + e.mrr, 0));
  const totalCustomers = [...byCode.values()].reduce((t, e) => t + e.customers, 0);

  // Pareto order: descending lost MRR (ties by customers). Cumulative % runs
  // over this order — "the first two bars are 80% of the bleed".
  let running = 0;
  const reasons = [...byCode.values()]
    .sort((a, b) => b.mrr - a.mrr || b.customers - a.customers)
    .map((e) => {
      running += e.mrr;
      return {
        code: e.code,
        label: CODE_LABELS[e.code],
        customers: e.customers,
        mrr: round2(e.mrr),
        mrrShare: pct1(e.mrr, totalMrr),
        cumulativePct: pct1(running, totalMrr),
      };
    });

  return {
    reasons,
    totals: { customers: totalCustomers, mrr: totalMrr },
    // Customers-basis: what share of churned accounts we can't explain yet —
    // the honesty metric the card must show.
    unclassifiedShare: pct1(byCode.get('unclassified').customers, totalCustomers),
  };
}

module.exports = { buildChurnPareto, CODE_LABELS };
