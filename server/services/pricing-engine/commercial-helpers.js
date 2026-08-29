// Commercial lawn/pest guardrails.
//
// PR 1 intentionally does not implement commercial auto-pricing. Commercial
// lawn and pest must never fall through to residential pricing; they default
// to manual quote until a small-commercial pilot pricer exists and is wired.

function normalizeCommercialString(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_');
}

function normalizePropertyType(value) {
  const normalized = normalizeCommercialString(value);
  if (!normalized) return '';

  const commercialAliases = new Set([
    'commercial',
    'commercial_property',
    'business',
    'office',
    'office_retail',
    'retail',
    'shop',
    'storefront',
    'plaza',
    'warehouse',
    'warehouse_light',
    'light_warehouse',
    'apartment',
    'apartments',
    'apartment_common',
    'multi_family',
    'multifamily',
    'multifamily_common_area_residential',
    'multifamily_common_area_commercial',
    'commercial_multifamily',
    'hoa',
    'hoa_common',
    'hoa_common_area',
    'hoa_common_area_residential',
    'hoa_common_area_commercial',
    'residential_hoa',
    'residential_common_area',
    'commercial_hoa',
    'business_park',
    'condo_association',
    'common_area',
    'restaurant',
    'restaurant_food_service',
    'food_service',
    'medical',
    'medical_office',
    'clinic',
    'industrial',
    'school',
    'daycare',
    'school_daycare',
    'government',
    'municipal',
    'government_municipal',
  ]);
  if (commercialAliases.has(normalized)) return 'commercial';
  const commercialTokens = [
    'commercial',
    'business',
    'office',
    'retail',
    'shop',
    'storefront',
    'plaza',
    'warehouse',
    'apartment',
    'apartments',
    'multifamily',
    'hoa',
    'restaurant',
    'medical',
    'clinic',
    'industrial',
    'school',
    'daycare',
    'government',
    'municipal',
  ];
  const tokens = normalized.split('_').filter(Boolean);
  if (normalized.includes('multi_family')) return 'commercial';
  if (normalized.includes('common_area')) return 'commercial';
  if (normalized.includes('food_service')) return 'commercial';
  if (commercialTokens.some((token) => tokens.includes(token))) return 'commercial';

  const residentialAliases = {
    residential: 'single_family',
    home: 'single_family',
    house: 'single_family',
    single: 'single_family',
    single_family: 'single_family',
    single_family_home: 'single_family',
    townhome: 'townhome_end',
    town_home: 'townhome_end',
    townhouse: 'townhome_end',
    townhome_end: 'townhome_end',
    townhome_interior: 'townhome_interior',
    townhome_inside: 'townhome_interior',
    interior_townhome: 'townhome_interior',
    duplex: 'duplex',
    condo: 'condo_ground',
    condominium: 'condo_ground',
    condo_ground: 'condo_ground',
    condo_upper: 'condo_upper',
    upper_condo: 'condo_upper',
  };

  if (residentialAliases[normalized]) return residentialAliases[normalized];
  if ((tokens.includes('townhome') || tokens.includes('townhouse')) && tokens.includes('interior')) {
    return 'townhome_interior';
  }
  if (tokens.includes('townhome') || tokens.includes('townhouse')) return 'townhome_end';
  if (tokens.includes('town') && tokens.includes('home') && tokens.includes('interior')) return 'townhome_interior';
  if (tokens.includes('town') && tokens.includes('home')) return 'townhome_end';
  if (tokens.includes('duplex')) return 'duplex';
  if ((tokens.includes('condo') || tokens.includes('condominium')) && tokens.includes('upper')) return 'condo_upper';
  if (tokens.includes('condo') || tokens.includes('condominium')) return 'condo_ground';
  if (tokens.includes('single') || tokens.includes('family') || tokens.includes('home') || tokens.includes('residential')) {
    return 'single_family';
  }
  return normalized;
}

const RESIDENTIAL_PROPERTY_TYPES = new Set([
  'single_family',
  'townhome_end',
  'townhome_interior',
  'duplex',
  'condo_ground',
  'condo_upper',
]);

function isSelected(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value.selected === true || value.enabled === true || value.value === true;
}

function hasExplicitCommercialFalse(value) {
  if (value === false) return true;
  const raw = normalizeCommercialString(value);
  return raw === 'false' || raw === 'no' || raw === 'residential';
}

function hasExplicitCommercialTrue(value) {
  if (value === true) return true;
  const raw = normalizeCommercialString(value);
  return raw === 'true' || raw === 'yes' || raw === 'commercial';
}

function isCommercialProperty(property = {}, options = {}) {
  const services = options.services || property.services || {};
  const hasCommercialServiceSelection = isSelected(services.commercialPest) || isSelected(services.commercialLawn);
  const propertyType = normalizePropertyType(property.propertyType);
  const optionPropertyType = normalizePropertyType(options.propertyType);
  const hasResidentialPropertyType =
    RESIDENTIAL_PROPERTY_TYPES.has(propertyType) ||
    RESIDENTIAL_PROPERTY_TYPES.has(optionPropertyType);
  const hasExplicitResidentialOverride =
    hasExplicitCommercialFalse(options.isCommercial) ||
    hasExplicitCommercialFalse(property.isCommercial);
  const hasExplicitCommercialTypeOrFlag = !!(
    hasExplicitCommercialTrue(property.isCommercial) ||
    hasExplicitCommercialTrue(options.isCommercial) ||
    propertyType === 'commercial' ||
    optionPropertyType === 'commercial' ||
    hasCommercialServiceSelection
  );

  if (hasExplicitResidentialOverride && !hasExplicitCommercialTypeOrFlag) {
    return false;
  }

  const hasExplicitCommercialSignal = !!(
    hasExplicitCommercialTypeOrFlag ||
    !!property.commercialSubtype ||
    !!options.commercialSubtype
  );
  if (hasExplicitCommercialSignal) return true;

  if (hasResidentialPropertyType) return false;
  if (hasExplicitResidentialOverride) return false;

  return !!(
    normalizePropertyType(property.category) === 'commercial' ||
    normalizePropertyType(options.category) === 'commercial'
  );
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildCommercialManualQuoteResult(service, property = {}, options = {}) {
  const serviceKey = normalizeCommercialString(service);
  const isLawn = serviceKey === 'commercial_lawn' ||
    serviceKey === 'lawn' ||
    serviceKey === 'lawn_care' ||
    serviceKey === 'commercial_lawn_treatment';
  const canonicalService = isLawn ? 'commercial_lawn' : 'commercial_pest';
  const originalRequestedService = isLawn ? 'lawn_care' : 'pest_control';
  const commercialSubtype = options.commercialSubtype || property.commercialSubtype || null;
  const manualReviewReasons = unique([
    'commercial_property_manual_quote_required',
    ...(Array.isArray(options.manualReviewReasons) ? options.manualReviewReasons : []),
  ]);

  return {
    service: canonicalService,
    originalRequestedService,
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype,
    commercialPricingMode: 'manual_quote',
    quoteRequired: true,
    requiresManualReview: true,
    autoQuoteRequiresAdminApproval: true,
    manualReviewReasons,
    reason: isLawn
      ? 'Commercial turf treatment requires manual quote or commercial pilot pricing.'
      : 'Commercial pest requires manual quote or commercial pilot pricing.',
    price: null,
    monthly: null,
    annual: null,
    taxable: isLawn ? false : true,
    taxCategory: isLawn ? 'lawn_spraying_or_treatment' : 'nonresidential_pest_control',
    pricingConfidence: 'LOW',
  };
}

// One-time services whose price is already UNIT-SCOPED (slab sqft, linear
// feet, drill points, rooms, entry points, stations, palm counts) rather than
// derived from residential home-size brackets. Behind
// GATE_COMMERCIAL_ONETIME_SCOPED these price identically on commercial
// properties — the work is the same scoped work — and carry commercial line
// marking from markCommercialOneTimeLine. Every key must match the pricer's
// own `service` value; an unlisted service stays on the manual-quote path
// (fail closed). Deliberately NOT here: home-size-bracket one-times
// (one_time_pest, one_time_lawn, german_roach*, flea, rodent_trapping family,
// dethatching/top-dressing/plugging) need commercial sizing bases and
// owner-approved numbers first; WDO is footprint-BRACKETED (resolvePestFootprint
// picks residential brackets, and the public quote route can synthesize a
// 2,000 sqft home value for an unmeasured commercial building — codex #3594
// P1); palm_injection is an annual recurring program whose legacy-mapper round
// trip drops the commercial identity and can seed the residential semiannual
// auto-schedule (codex #3594 P1) — both return only with their own commercial
// handling. exclusion V1 stays manual (minimum floors key off HOME sqft).
const COMMERCIAL_SCOPED_ONETIME_SERVICES = new Set([
  'pre_slab_termiticide',
  'trenching',
  'bora_care',
  'foam_drill',
  'termite_foam',
  'stinging_insect',
  'stinging_insect_v2',
  // The live V2 exclusion shape (services.exclusion + pricingVersion:'v2')
  // emits per-section rows keyed 'rodent_exclusion'; 'exclusion_v2' covers the
  // alternate services.exclusionV2 spelling's pricer.
  'rodent_exclusion',
  'exclusion_v2',
  'rodent_wire_mesh',
  'rodent_bird_box',
  'rodent_sanitation',
  'bed_bug',
  'rodent_inspection',
]);

// rodent_inspection follows the existing service_taxability rows (inspection
// rows carry is_taxable=false) — commercial-inspection taxability is an open
// owner/CPA ruling; until it lands the table is the authority. Everything else
// here is nonresidential pest control, which FL taxes.
const COMMERCIAL_EXEMPT_INSPECTION_ONETIME = new Set(['rodent_inspection']);

// Re-marks a residential-pricer line for a commercial property: commercial
// identity fields, FL tax family, and the flat-commercial discount rules the
// recurring commercial pricers carry (never WaveGuard/recurring-discountable).
// Scope inputs (slab sqft, linear ft, counts) are rep-entered, not
// satellite-estimated, so the line is NOT flagged estimatedPricing and keeps
// the pricer's own detail/disclaimer.
function markCommercialOneTimeLine(result, property = {}, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const isExemptInspection = COMMERCIAL_EXEMPT_INSPECTION_ONETIME.has(result.service);
  return {
    ...result,
    propertyType: 'commercial',
    isCommercial: true,
    commercialSubtype: options.commercialSubtype || property.commercialSubtype || null,
    commercialPricingMode: 'auto_estimate',
    discountable: false,
    excludeFromPctDiscount: true,
    taxable: !isExemptInspection,
    taxCategory: isExemptInspection ? (result.taxCategory || null) : 'nonresidential_pest_control',
  };
}

module.exports = {
  normalizeCommercialString,
  normalizePropertyType,
  isCommercialProperty,
  buildCommercialManualQuoteResult,
  COMMERCIAL_SCOPED_ONETIME_SERVICES,
  markCommercialOneTimeLine,
};
