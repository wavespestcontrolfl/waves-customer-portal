/**
 * Federal tax constants per tax year, for the return engine
 * (services/tax-return-engine.js). Every number below was read against the
 * IRS or SSA source named in its comment on 2026-10-24. A year that is not
 * listed here is NOT guessed: getYearConstants() answers 400 and the engine
 * refuses to compute it.
 *
 * Brackets are [upper bound of the bracket, rate]; the last bracket has no
 * upper bound (null). Filing statuses: single, mfj (married filing jointly),
 * hoh (head of household). Married filing separately is not offered.
 *
 * What is NOT modeled: the QBI wage/property limit above the QBI threshold (the
 * engine warns instead), the section 179 phase-out (the engine warns when the
 * year's pool passes the dollar limit), the $400 minimum QBI deduction that
 * starts in 2026 (section 199A(i)), and credits of any kind.
 */

// the same every year in this range
const COMMON = {
  se_factor: 0.9235,          // Schedule SE line 4a: 92.35% of net profit
  se_min_earnings: 400,       // Schedule SE line 4c: under $400 of net earnings, no SE tax
  ss_rate: 0.124,             // Social Security part of the SE tax (IRC 1401(a))
  medicare_rate: 0.029,       // Medicare part of the SE tax (IRC 1401(b))
  addl_medicare_rate: 0.009,  // Additional Medicare Tax (IRC 1401(b)(2)), Form 8959
  // IRC 1401(b)(2)(A) amounts are not indexed: https://www.irs.gov/taxtopics/tc560
  addl_medicare_threshold: { single: 200000, mfj: 250000, hoh: 200000 },
  qbi_rate: 0.20,             // IRC 199A(a)
  nol_limit_pct: 0.80,        // IRC 172(a)(2): a post-2017 NOL offsets 80% of taxable income
  estimate_safe_harbor_pct: 1.00,       // IRC 6654(d)(1)(B): 100% of last year's tax
  estimate_safe_harbor_high_pct: 1.10,  // 110% when last year's AGI was over the line below
  estimate_high_agi: 150000,
};

const YEARS = {
  // Rev. Proc. 2023-34 (https://www.irs.gov/irb/2023-48_IRB): sections 3.01 rate
  // tables, 3.15 standard deduction, 3.27 QBI threshold, 3.25 section 179.
  // SSA wage base: https://www.ssa.gov/oact/cola/cbb.html ($168,600).
  2024: {
    ...COMMON,
    source: 'Rev. Proc. 2023-34; SSA contribution and benefit base',
    standard_deduction: { single: 14600, mfj: 29200, hoh: 21900 },
    brackets: {
      single: [[11600, 0.10], [47150, 0.12], [100525, 0.22], [191950, 0.24], [243725, 0.32], [609350, 0.35], [null, 0.37]],
      mfj: [[23200, 0.10], [94300, 0.12], [201050, 0.22], [383900, 0.24], [487450, 0.32], [731200, 0.35], [null, 0.37]],
      hoh: [[16550, 0.10], [63100, 0.12], [100500, 0.22], [191950, 0.24], [243700, 0.32], [609350, 0.35], [null, 0.37]],
    },
    ss_wage_base: 168600,
    qbi_threshold: { single: 191950, mfj: 383900, hoh: 191950 },
    sec179_limit: 1220000,
  },
  // Rev. Proc. 2024-40 (https://www.irs.gov/pub/irs-drop/rp-24-40.pdf) rate tables and
  // QBI threshold; the standard deduction and section 179 limit were raised by
  // P.L. 119-21 (OBBBA) and are restated in Rev. Proc. 2025-32 section 3
  // (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf): $15,750 / $31,500 / $23,625
  // and $2,500,000. SSA wage base $176,100.
  2025: {
    ...COMMON,
    source: 'Rev. Proc. 2024-40 as amended by P.L. 119-21 and Rev. Proc. 2025-32; SSA',
    standard_deduction: { single: 15750, mfj: 31500, hoh: 23625 },
    brackets: {
      single: [[11925, 0.10], [48475, 0.12], [103350, 0.22], [197300, 0.24], [250525, 0.32], [626350, 0.35], [null, 0.37]],
      mfj: [[23850, 0.10], [96950, 0.12], [206700, 0.22], [394600, 0.24], [501050, 0.32], [751600, 0.35], [null, 0.37]],
      hoh: [[17000, 0.10], [64850, 0.12], [103350, 0.22], [197300, 0.24], [250500, 0.32], [626350, 0.35], [null, 0.37]],
    },
    ss_wage_base: 176100,
    qbi_threshold: { single: 197300, mfj: 394600, hoh: 197300 },
    sec179_limit: 2500000,
  },
  // Rev. Proc. 2025-32 (https://www.irs.gov/pub/irs-drop/rp-25-32.pdf): section 3.01
  // rate tables, 3.14 standard deduction, 3.26 QBI threshold, 3.24 section 179.
  // SSA wage base $184,500 (https://www.ssa.gov/news/en/cola/factsheets/2026.html).
  2026: {
    ...COMMON,
    source: 'Rev. Proc. 2025-32; SSA',
    standard_deduction: { single: 16100, mfj: 32200, hoh: 24150 },
    brackets: {
      single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [null, 0.37]],
      mfj: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [null, 0.37]],
      hoh: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [null, 0.37]],
    },
    ss_wage_base: 184500,
    qbi_threshold: { single: 201750, mfj: 403500, hoh: 201750 },
    sec179_limit: 2560000,
  },
};

const FILING_STATUSES = ['single', 'mfj', 'hoh'];

function hasYearConstants(year) {
  return Object.prototype.hasOwnProperty.call(YEARS, Number(year));
}

function getYearConstants(year) {
  if (!hasYearConstants(year)) {
    const e = new Error(`tax constants for ${year} are not loaded`);
    e.status = 400;
    throw e;
  }
  return YEARS[Number(year)];
}

module.exports = { YEARS, FILING_STATUSES, hasYearConstants, getYearConstants };
