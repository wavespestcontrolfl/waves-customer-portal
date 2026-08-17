// Commercial RISK-TYPE cadence (owner-locked risk-type lane, decision 2).
//
// "Commercial" spans office → restaurant → marina, and a single default cadence
// under/over-services: an office serviced monthly is over-served, a restaurant
// serviced quarterly is under-served. A business-type bucket drives how many
// PEST and RODENT visits/yr a commercial program gets. The commercial cost
// buildup scales linearly with visit count. (Floors are disarmed — owner
// 2026-08-17 — so low-cadence buckets price at the raw buildup, not a minimum.)
//
// Mosquito (9 seasonal) and termite (4 quarterly monitoring) are NOT risk-typed.
// riskType defaults NULL (admin must classify — a defaulted-required field gets
// missed, so restaurants/hotels would silently under-cadence). NULL or an
// unrecognized value → the pricers keep their cfg.programVisits defaults
// (pest 12 / rodent 4), i.e. today's behavior — fully backward compatible.

const COMMERCIAL_RISK_TYPES = [
  { value: 'office_low', label: 'Office / low-traffic' },
  { value: 'retail_standard', label: 'Retail / standard' },
  { value: 'hoa_common_area', label: 'HOA / common area' },
  { value: 'warehouse_distribution', label: 'Warehouse / distribution' },
  { value: 'restaurant_food', label: 'Restaurant / food service' },
  { value: 'healthcare_childcare', label: 'Healthcare / childcare' },
  { value: 'hotel_resort', label: 'Hotel / resort' },
  { value: 'multifamily', label: 'Multifamily' },
];

// Pest / rodent visits per year per bucket (owner-locked). Warehouse rodent is
// MONTHLY (12) — roll-up doors / docks / dumpsters under-service on quarterly.
const COMMERCIAL_RISK_TYPE_CADENCE = {
  office_low: { pestVisits: 4, rodentVisits: 4 },
  retail_standard: { pestVisits: 4, rodentVisits: 4 },
  hoa_common_area: { pestVisits: 6, rodentVisits: 4 },
  warehouse_distribution: { pestVisits: 6, rodentVisits: 12 },
  restaurant_food: { pestVisits: 12, rodentVisits: 12 },
  healthcare_childcare: { pestVisits: 12, rodentVisits: 12 },
  hotel_resort: { pestVisits: 12, rodentVisits: 12 },
  multifamily: { pestVisits: 12, rodentVisits: 12 },
};

const COMMERCIAL_RISK_TYPE_VALUES = new Set(COMMERCIAL_RISK_TYPES.map((r) => r.value));

function isCommercialRiskType(riskType) {
  return COMMERCIAL_RISK_TYPE_VALUES.has(String(riskType || '').trim().toLowerCase());
}

// Returns { pestVisits, rodentVisits } for a recognized bucket, else nulls so the
// callers keep the pricers' cfg.programVisits defaults (backward compatible).
function resolveCommercialCadence(riskType) {
  const key = String(riskType || '').trim().toLowerCase();
  const cadence = COMMERCIAL_RISK_TYPE_CADENCE[key];
  return cadence
    ? { pestVisits: cadence.pestVisits, rodentVisits: cadence.rodentVisits }
    : { pestVisits: null, rodentVisits: null };
}

// Admin PEST-cadence override (owner request 2026-08-06): the estimator's
// "Pest cadence override" select sells a commercial pest program at a direct
// quarterly/bi-monthly/monthly cadence when the risk-type bucket's cadence
// isn't what the deal needs. PEST only — rodent cadence stays owner-locked to
// the bucket (a warehouse rodent program must stay monthly regardless of the
// pest cadence sold). Unset/unrecognized → null, so callers fall back to the
// risk-type bucket, then the pricer's program default.
const COMMERCIAL_PEST_CADENCE_VISITS = {
  quarterly: 4,
  bimonthly: 6,
  bi_monthly: 6, // billing/estimate-stack alias for the two-month cadence
  monthly: 12,
};

function resolveCommercialPestCadenceOverride(cadence) {
  const key = String(cadence || '').trim().toLowerCase();
  return COMMERCIAL_PEST_CADENCE_VISITS[key] || null;
}

// Admin LAWN apps/year override (owner request 2026-08-15): the estimator's
// "Lawn cadence override" select sells the commercial turf program at a direct
// applications-per-year count when the 8-visit default isn't what the deal
// needs. LAWN only, and a whitelist like the pest map — commercial lawn bills
// MONTHLY regardless (annual/12), so this changes the priced visit count, not
// the billing cadence. Unset/unrecognized → null, so callers keep
// COMMERCIAL_LAWN.programVisits.
const COMMERCIAL_LAWN_CADENCE_APPS = [4, 6, 8, 10, 12];
const COMMERCIAL_LAWN_CADENCE_SET = new Set(COMMERCIAL_LAWN_CADENCE_APPS);

function resolveCommercialLawnCadenceOverride(cadence) {
  if (cadence === null || cadence === undefined || cadence === '') return null;
  const n = Number(cadence);
  return COMMERCIAL_LAWN_CADENCE_SET.has(n) ? n : null;
}

module.exports = {
  COMMERCIAL_RISK_TYPES,
  COMMERCIAL_RISK_TYPE_CADENCE,
  COMMERCIAL_RISK_TYPE_VALUES,
  COMMERCIAL_PEST_CADENCE_VISITS,
  isCommercialRiskType,
  resolveCommercialCadence,
  resolveCommercialPestCadenceOverride,
  COMMERCIAL_LAWN_CADENCE_APPS,
  resolveCommercialLawnCadenceOverride,
};
