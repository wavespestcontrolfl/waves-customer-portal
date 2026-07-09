/**
 * Adjusted-EBITDA bridge — company-level profitability waterfall for the
 * dashboard's Profit section. Gross margin answers "are jobs profitable after
 * COGS?"; this answers "is the company profitable after operating expenses?" —
 * the two live near each other on the dashboard but are never combined.
 *
 *   Revenue (completed services, window)
 *   − COGS (labor + materials + drive — already burdened into job costing;
 *     optionally split into those components from job_costs actuals)
 *   = Gross profit
 *   − Marketing (ad platforms + channel retainers + referral rewards, actuals)
 *   = Contribution
 *   − Operating overhead (prorated monthly figures — see basis below)
 *   = Adjusted EBITDA
 *
 * Overhead basis (Phase 5):
 *   'entered'          — the owner-typed ovh_* operating costs on
 *                        company_financials (Settings → Financials →
 *                        Operating Costs). Deliberate figures: the waterfall
 *                        ALWAYS completes, even at a legitimate $0.
 *   'pricing_defaults' — approximation from the pricing-settings columns
 *                        (vehicle/insurance/software per month + admin per
 *                        customer-year). Completes only when something is
 *                        > 0; all-zero/absent stops at Contribution rather
 *                        than implying a zero-overhead company.
 * The card labels the basis so an approximated EBITDA is never mistaken for
 * an entered one.
 *
 * "Adjusted" because the overhead block is owner-entered assumptions and the
 * result is before owner compensation, interest, taxes, and depreciation /
 * amortization — a run-rate operating view, not a books number.
 * Pure / unit-testable.
 */

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pct(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/**
 * buildEbitdaBridge(inputs)
 * @param {number} revenue      completed-service revenue in the window
 * @param {number} grossProfit  fully-burdened gross profit in the window
 * @param {Object} marketing    { adSpend, fixedCosts, referralRewards } window actuals
 * @param {Object|null} overhead either the general shape
 *   { basis: 'entered'|'pricing_defaults', components: {key: monthlyAmount}, enteredAt? }
 *   or the legacy pre-Phase-5 shape { vehicleMonthly, insuranceMonthly,
 *   softwareMonthly, adminMonthly } (treated as pricing_defaults)
 * @param {Object|null} cogsSplit optional window actuals { labor, materials,
 *   drive } from job_costs — rendered as indented COGS detail; any gap vs the
 *   headline COGS (revenue − GP from service_records, which stays
 *   authoritative) surfaces as an "unsplit" line so the detail reconciles
 * @param {number} monthFraction fraction of the month the window covers —
 *   prorates the MONTHLY overhead figures onto the window (marketing and
 *   cogsSplit amounts are actuals for the window and are never prorated)
 */
function buildEbitdaBridge({ revenue, grossProfit, marketing = {}, overhead = null, cogsSplit = null, monthFraction = 1 } = {}) {
  const rev = money(revenue);
  const gp = money(grossProfit);
  const cogs = money(rev - gp);

  const adSpend = money(marketing.adSpend);
  const fixedCosts = money(marketing.fixedCosts);
  const referralRewards = money(marketing.referralRewards);
  const marketingTotal = money(adSpend + fixedCosts + referralRewards);
  const contribution = money(gp - marketingTotal);

  const frac = Number.isFinite(Number(monthFraction)) && Number(monthFraction) > 0
    ? Math.min(Number(monthFraction), 1)
    : 1;
  // Normalize the two accepted overhead shapes into (basis, monthly components).
  const ovh = overhead || {};
  const overheadBasis = ovh.components && ovh.basis === 'entered' ? 'entered' : 'pricing_defaults';
  const rawComponents = ovh.components || {
    vehicle: ovh.vehicleMonthly,
    insurance: ovh.insuranceMonthly,
    software: ovh.softwareMonthly,
    admin: ovh.adminMonthly,
  };
  const components = {};
  for (const [k, v] of Object.entries(rawComponents)) components[k] = money((Number(v) || 0) * frac);
  const componentSum = money(Object.values(components).reduce((t, v) => t + v, 0));
  const overheadEntered = overheadBasis === 'entered' ? true : componentSum > 0;
  const overheadTotal = overheadEntered ? componentSum : null;

  // COGS detail (job-costing actuals). The headline COGS row stays revenue −
  // GP; the detail's gap vs that headline shows as "unsplit" so the sub-rows
  // always reconcile to the row above them.
  let cogsDetail = null;
  if (cogsSplit && (Number(cogsSplit.labor) > 0 || Number(cogsSplit.materials) > 0 || Number(cogsSplit.drive) > 0)) {
    const labor = money(cogsSplit.labor);
    const materials = money(cogsSplit.materials);
    const drive = money(cogsSplit.drive);
    const unsplit = money(cogs - labor - materials - drive);
    cogsDetail = [
      { key: 'labor', label: 'Labor', amount: labor },
      { key: 'materials', label: 'Materials', amount: materials },
      { key: 'drive', label: 'Drive & equipment', amount: drive },
    ];
    if (Math.abs(unsplit) >= 0.01) cogsDetail.push({ key: 'unsplit', label: 'Unsplit', amount: unsplit });
  }

  const ebitda = overheadEntered ? money(contribution - overheadTotal) : null;

  const overheadLabel = overheadBasis === 'entered'
    ? 'Overhead (entered operating costs)'
    : 'Overhead (pricing-settings assumptions)';
  const rows = [
    { key: 'revenue', label: 'Revenue', amount: rev, kind: 'start' },
    { key: 'cogs', label: 'COGS (labor · materials · drive)', amount: -cogs, kind: 'minus' },
    { key: 'gross_profit', label: 'Gross profit', amount: gp, kind: 'subtotal', marginPct: pct(gp, rev) },
    { key: 'marketing', label: 'Marketing (ads · retainers · referral rewards)', amount: -marketingTotal, kind: 'minus' },
    {
      key: 'contribution',
      label: 'Contribution',
      amount: contribution,
      // Contribution is the terminal row until overhead is entered.
      kind: overheadEntered ? 'subtotal' : 'result',
      marginPct: pct(contribution, rev),
    },
  ];
  if (overheadEntered) {
    rows.push(
      { key: 'overhead', label: overheadLabel, amount: -overheadTotal, kind: 'minus' },
      { key: 'ebitda', label: 'Adjusted EBITDA', amount: ebitda, kind: 'result', marginPct: pct(ebitda, rev) },
    );
  }

  return {
    rows,
    cogsDetail,
    revenue: rev,
    cogs,
    grossProfit: gp,
    grossMarginPct: pct(gp, rev),
    marketing: { adSpend, fixedCosts, referralRewards, total: marketingTotal },
    contribution,
    contributionMarginPct: pct(contribution, rev),
    overhead: overheadEntered ? { ...components, total: overheadTotal } : null,
    overheadEntered,
    overheadBasis,
    overheadEnteredAt: overheadBasis === 'entered' ? (ovh.enteredAt || null) : null,
    ebitda,
    ebitdaMarginPct: overheadEntered ? pct(ebitda, rev) : null,
    monthFraction: frac,
  };
}

module.exports = { buildEbitdaBridge };
