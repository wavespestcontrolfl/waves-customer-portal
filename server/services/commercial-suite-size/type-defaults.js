/**
 * Last-resort suite-size defaults, keyed off whatever business-type signal
 * is available (commercialRiskType, commercialSubtype, or a business type
 * string a resolver leg reported). Used only when neither the DBPR license
 * extract nor the web-search leg found a real measurement — a rough number
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

function defaultSuiteSqftFor({ commercialRiskType, commercialSubtype, businessType } = {}) {
  const text = [commercialRiskType, commercialSubtype, businessType]
    .filter(Boolean).join(' ').toLowerCase();
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
