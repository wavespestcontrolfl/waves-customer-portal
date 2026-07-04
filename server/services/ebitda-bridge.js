/**
 * Adjusted-EBITDA bridge — company-level profitability waterfall for the
 * dashboard's Profit section. Gross margin answers "are jobs profitable after
 * COGS?"; this answers "is the company profitable after operating expenses?" —
 * the two live near each other on the dashboard but are never combined.
 *
 *   Revenue (completed services, window)
 *   − COGS (labor + materials + drive — already burdened into job costing)
 *   = Gross profit
 *   − Marketing (ad platforms + channel retainers + referral rewards, actuals)
 *   = Contribution
 *   − Operating overhead (vehicle / insurance / software / admin — owner-entered
 *     monthly assumptions on company_financials, prorated to the window)
 *   = Adjusted EBITDA
 *
 * "Adjusted" because the overhead block is owner-entered assumptions and the
 * result is before owner compensation, interest, taxes, and depreciation /
 * amortization — a run-rate operating view, not a books number.
 *
 * When no overhead has been entered (every component null/0) the waterfall
 * stops at Contribution — an EBITDA computed off missing costs would silently
 * overstate profit. Pure / unit-testable.
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
 * @param {Object|null} overhead monthly assumptions { vehicleMonthly,
 *   insuranceMonthly, softwareMonthly, adminMonthly } — null/all-zero ⇒ unentered
 * @param {number} monthFraction fraction of the month the window covers —
 *   prorates the MONTHLY overhead figures onto the window (marketing amounts
 *   are actuals for the window and are never prorated)
 */
function buildEbitdaBridge({ revenue, grossProfit, marketing = {}, overhead = null, monthFraction = 1 } = {}) {
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
  const ovh = overhead || {};
  const components = {
    vehicle: money((Number(ovh.vehicleMonthly) || 0) * frac),
    insurance: money((Number(ovh.insuranceMonthly) || 0) * frac),
    software: money((Number(ovh.softwareMonthly) || 0) * frac),
    admin: money((Number(ovh.adminMonthly) || 0) * frac),
  };
  // Unentered ⇒ no component is a positive number. A deliberate all-zero entry
  // is indistinguishable from "never filled in" — both stop the waterfall, and
  // the card points at Settings → Financials either way.
  const overheadEntered = Object.values(components).some((v) => v > 0);
  const overheadTotal = overheadEntered
    ? money(components.vehicle + components.insurance + components.software + components.admin)
    : null;

  const ebitda = overheadEntered ? money(contribution - overheadTotal) : null;

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
      { key: 'overhead', label: 'Overhead (vehicle · insurance · software · admin)', amount: -overheadTotal, kind: 'minus' },
      { key: 'ebitda', label: 'Adjusted EBITDA', amount: ebitda, kind: 'result', marginPct: pct(ebitda, rev) },
    );
  }

  return {
    rows,
    revenue: rev,
    cogs,
    grossProfit: gp,
    grossMarginPct: pct(gp, rev),
    marketing: { adSpend, fixedCosts, referralRewards, total: marketingTotal },
    contribution,
    contributionMarginPct: pct(contribution, rev),
    overhead: overheadEntered ? { ...components, total: overheadTotal } : null,
    overheadEntered,
    ebitda,
    ebitdaMarginPct: overheadEntered ? pct(ebitda, rev) : null,
    monthFraction: frac,
  };
}

module.exports = { buildEbitdaBridge };
