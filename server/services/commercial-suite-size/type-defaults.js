/**
 * Last-resort suite-size defaults, keyed OFF commercialRiskType /
 * commercialSubtype ONLY — never a model-reported businessType (AGENTS.md:
 * an LLM proposes intent, it never picks a price/size field). Used only
 * when the DBPR license extract found no real measurement — a rough number
 * beats a $0 manual quote, and the LOW confidence + yellow lane tell the
 * operator to confirm on site.
 */

const SUITE_TYPE_DEFAULT_SQFT = {
  restaurant: 1800,
  retailOffice: 1500,
  salon: 1200,
  medical: 2500,
  other: 1500,
};

// Specific categories a free-text subtype can name. A subtype that names one
// decides first: the risk-type enum only has broad buckets (a salon arrives
// as retail_standard, a daycare as healthcare_childcare), so letting the
// bucket win would make the salon / daycare defaults unreachable.
const SUBTYPE_CATEGORIES = [
  [/restaurant|food|cafe|bakery|bar\b|kitchen/, 'restaurant'],
  [/salon|spa\b|barber|nail|personal.?service/, 'salon'],
  [/daycare|child.?care|preschool|school/, 'retailOffice'],
  [/medical|clinic|dental|health.?care|healthcare|veterin/, 'medical'],
];
// Risk-type buckets, used only when the subtype names no specific category.
const RISK_TYPE_CATEGORY = {
  restaurant_food: 'restaurant',
  healthcare_childcare: 'medical',
};

// The size a type default prices at, and the ONE input that chose it (the
// evidence label names this key, so the operator is told what decided).
function defaultSuiteSizeBasis({ commercialRiskType, commercialSubtype } = {}) {
  const subtype = String(commercialSubtype || '').toLowerCase();
  if (subtype) {
    const hit = SUBTYPE_CATEGORIES.find(([re]) => re.test(subtype));
    if (hit) return { sqft: SUITE_TYPE_DEFAULT_SQFT[hit[1]], basis: commercialSubtype };
  }
  if (commercialRiskType) {
    const category = RISK_TYPE_CATEGORY[commercialRiskType] || 'retailOffice';
    return { sqft: SUITE_TYPE_DEFAULT_SQFT[category], basis: commercialRiskType };
  }
  // retail / office / warehouse / hotel / hoa / multifamily / school-daycare
  // and anything unnamed share the generic small-suite default.
  return { sqft: SUITE_TYPE_DEFAULT_SQFT.retailOffice, basis: commercialSubtype || null };
}

function defaultSuiteSqftFor(input = {}) {
  return defaultSuiteSizeBasis(input).sqft;
}

module.exports = {
  SUITE_TYPE_DEFAULT_SQFT,
  defaultSuiteSizeBasis,
  defaultSuiteSqftFor,
};
