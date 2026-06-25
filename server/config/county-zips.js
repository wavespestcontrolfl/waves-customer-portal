// FL county → ZIP sets for SALES-TAX / COMPLIANCE county inference.
//
// These five arrays were byte-identical copy-pastes in services/tax-calculator.js
// and services/compliance.js — drift between them would make the two disagree on
// a customer's county (and therefore the tax rate). Centralized here so there's
// one place to edit.
//
// SCOPE — this is the TAX/COMPLIANCE county map, NOT a general "service area"
// source of truth. It is deliberately DIFFERENT from the other geo lists, which
// are intentionally separate by purpose and must not be merged into this:
//   - utils/zip-to-city.js — ZIP → USPS city for lead routing/display; covers
//     only the Waves operating area (+ south Hillsborough), not Lee/Collier.
//   - config/locations.js CITY_TO_LOCATION — city → lead office (one routing
//     opinion); routes/satisfaction.js + the review maps encode a DIFFERENT
//     office-routing opinion (e.g. osprey→venice, palmetto→bradenton) under a
//     different office-id namespace.
//   - services/property-lookup/ai-property-lookup.js — county ZIP sets for
//     property-record matching; a FULLER set than these (e.g. Manatee adds
//     34215–34218, 34220, 34228, 34264, 34270). Using these tax sets there, or
//     vice-versa, would change tax inference.
//
// So: tax & compliance share THESE; everyone else stays separate on purpose.
// Consumers keep their own return-value format (tax → 'Manatee'; compliance →
// 'manatee_county') and county coverage (only tax uses LEE_ZIPS / COLLIER_ZIPS).

const MANATEE_ZIPS = ['34201', '34202', '34203', '34204', '34205', '34206', '34207', '34208', '34209', '34210',
  '34211', '34212', '34219', '34221', '34222', '34243', '34250', '34251', '34280', '34281', '34282'];

const SARASOTA_ZIPS = ['34228', '34229', '34230', '34231', '34232', '34233', '34234', '34235', '34236', '34237',
  '34238', '34239', '34240', '34241', '34242', '34260', '34275', '34276', '34277', '34278', '34286', '34287', '34288', '34289', '34292', '34293'];

const CHARLOTTE_ZIPS = ['33947', '33948', '33949', '33950', '33952', '33953', '33954', '33955', '33980', '33981', '33982', '33983'];

const LEE_ZIPS = ['33901', '33903', '33904', '33905', '33907', '33908', '33909', '33912', '33913', '33914',
  '33916', '33917', '33919', '33920', '33921', '33922', '33924', '33928', '33931', '33936',
  '33956', '33957', '33965', '33966', '33967', '33971', '33972', '33973', '33974', '33976',
  '33990', '33991', '33993', '34134', '34135'];

const COLLIER_ZIPS = ['34102', '34103', '34104', '34105', '34108', '34109', '34110', '34112', '34113', '34114',
  '34116', '34117', '34119', '34120', '34140', '34141', '34142', '34145'];

module.exports = { MANATEE_ZIPS, SARASOTA_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS };
