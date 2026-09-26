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

function defaultSuiteSqftFor({ commercialRiskType, commercialSubtype } = {}) {
  // ONE authoritative key: the risk type when present, else the subtype —
  // the same precedence the evidence label uses, so the operator is told
  // the key that actually chose the priced area (never regex order across
  // two disagreeing fields).
  const text = String(commercialRiskType || commercialSubtype || '').toLowerCase();
  if (/restaurant|food/.test(text)) return SUITE_TYPE_DEFAULT_SQFT.restaurant;
  if (/salon|spa|barber|personal.?service/.test(text)) return SUITE_TYPE_DEFAULT_SQFT.salon;
  if (/medical|clinic|health.?care|healthcare/.test(text)) return SUITE_TYPE_DEFAULT_SQFT.medical;
  // retail / office / warehouse / hotel / hoa / multifamily / government /
  // school-daycare all share the 1,500 sqft "generic small commercial
  // suite" default — same number as the catch-all bucket below.
  return SUITE_TYPE_DEFAULT_SQFT.retailOffice;
}

module.exports = {
  SUITE_TYPE_DEFAULT_SQFT,
  defaultSuiteSqftFor,
};
