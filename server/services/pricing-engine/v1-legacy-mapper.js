// ============================================================
// v1-legacy-mapper.js
//
// Remaps v1 generateEstimate output `{summary, lineItems, waveGuard, ...}`
// to the legacy envelope that EstimatePage consumes (`R.lawn[]`,
// `R.pestTiers[]`, `recurring.services[]`, etc).
//
// Mirrors the shape emitted by v2-legacy-mapper.js, so swapping the
// engine at the `/calculate-estimate` adapter (Session 11a) doesn't
// change what the UI receives. Deletable as a unit in Session 11b
// when EstimatePage migrates off the legacy shape.
// ============================================================

const { priceTopDressing, priceTreeShrub } = require('./service-pricing');

const RECURRING_SERVICES = new Set([
  'pest_control', 'lawn_care', 'tree_shrub', 'palm_injection',
  'mosquito', 'termite_bait', 'rodent_bait',
]);

const ONE_TIME_SERVICES = new Set([
  'one_time_pest', 'one_time_lawn', 'one_time_mosquito',
  'top_dressing', 'dethatching', 'plugging', 'trenching',
  // Legacy explicit German roach initial from older direct engine callers.
  'german_roach_initial',
  // Auto-fired by estimate-engine when recurring pest carries roachType !== 'none'.
  // Surfaces in the customer-facing estimate's first-visit-fees stack.
  'pest_initial_roach',
]);

const CAP = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const roundMoney = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const finiteMoney = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const effectiveOneTimePrice = (li = {}) => {
  if (li.service === 'german_roach') {
    return (
      finiteMoney(li.totalAfterDiscount)
      ?? finiteMoney(li.total)
      ?? finiteMoney(li.priceAfterDiscount)
      ?? finiteMoney(li.price)
      ?? 0
    );
  }
  return (
    finiteMoney(li.priceAfterDiscount)
    ?? finiteMoney(li.totalAfterDiscount)
    ?? finiteMoney(li.price)
    ?? finiteMoney(li.total)
    ?? 0
  );
};

const TREE_SHRUB_LEGACY_TIERS = ['light', 'standard'];

function treeShrubTierLabel(tier) {
  return tier === 'light' ? 'Light' : 'Standard';
}

function treeShrubQuoteInput(v1Result = {}, tsLI = {}) {
  const property = v1Result.property || {};
  return {
    ...property,
    bedArea: tsLI.bedArea ?? property.bedArea ?? property.estimatedBedAreaSf,
    estimatedBedAreaSf: tsLI.bedArea ?? property.estimatedBedAreaSf ?? property.bedArea,
    features: {
      ...(property.features || {}),
      access: tsLI.access || property.features?.access || property.access || 'easy',
      treeCount: tsLI.treeCount ?? property.features?.treeCount ?? property.treeCount ?? 0,
    },
  };
}

function roundedTreeShrubTierQuote(v1Result = {}, tsLI = {}, tier = 'standard') {
  const quote = priceTreeShrub(treeShrubQuoteInput(v1Result, tsLI), {
    tier,
    access: tsLI.access || 'easy',
    treeCount: tsLI.treeCount ?? 0,
  });
  const annual = Math.round(quote.annual);
  const monthly = roundMoney(annual / 12);
  const visits = Number(quote.frequency || 0) || null;
  return {
    pa: visits ? roundMoney(annual / visits) : quote.perApp,
    v: visits,
    ann: annual,
    mo: monthly,
  };
}

function treeShrubLegacyTierRows(v1Result = {}, tsLI = {}) {
  const selectedTier = TREE_SHRUB_LEGACY_TIERS.includes(tsLI.tier) ? tsLI.tier : 'standard';
  const recommendedTier = TREE_SHRUB_LEGACY_TIERS.includes(tsLI.recommendedTier)
    ? tsLI.recommendedTier
    : (tsLI.recommended ? selectedTier : selectedTier);

  return TREE_SHRUB_LEGACY_TIERS.map((tier) => {
    const values = tier === selectedTier
      ? {
          pa: tsLI.perApp,
          v: tsLI.frequency,
          ann: tsLI.annual,
          mo: tsLI.monthly,
        }
      : roundedTreeShrubTierQuote(v1Result, tsLI, tier);
    return {
      ...values,
      name: treeShrubTierLabel(tier),
      tier,
      selected: tier === selectedTier,
      isSelected: tier === selectedTier,
      recommended: tier === recommendedTier,
      dimmed: tier !== recommendedTier,
    };
  });
}

const SERVICE_LABEL = {
  commercial_pest: 'Commercial Pest Control',
  commercial_lawn: 'Commercial Lawn Treatment',
  one_time_pest: 'One-Time Pest',
  one_time_lawn: 'One-Time Lawn',
  one_time_mosquito: 'One-Time Mosquito',
  top_dressing: 'Top Dressing',
  dethatching: 'Dethatching',
  plugging: 'Plugging',
  trenching: 'Trenching',
  bora_care: 'Bora-Care',
  pre_slab_termiticide: 'Pre-Slab Termiticide Treatment',
  pre_slab_termidor: 'Pre-Slab Termidor',
  bed_bug_chemical: 'Bed Bug (Chemical)',
  bed_bug_heat: 'Bed Bug (Heat)',
  bed_bug: 'Bed Bug',
  wdo: 'WDO Inspection',
  flea: 'Flea Treatment',
  flea_package: 'Flea Treatment Package',
  german_roach: 'German Roach',
  german_roach_initial: 'German Roach Initial (3-Visit)',
  pest_initial_roach: 'Initial Roach Knockdown',
  stinging: 'Stinging Insect',
  exclusion: 'Exclusion',
  rodent_trapping: 'Rodent Trapping',
  rodent_sanitation: 'Rodent Sanitation',
  rodent_bundle_discount: 'Rodent Bundle Discount',
  rodent_guarantee: 'Rodent Guarantee',
  trap_only_retainer: 'Trap-Only Monitoring Retainer',
  trap_only_setup: 'Trap-Only Setup / Inspection',
  trap_only_extra_callback: 'Trap-Only Extra Callback',
  rodent_wire_mesh: 'Rodent Wire Mesh Exclusion',
  rodent_bird_box: 'Roof-Entry Cover / Bird Box',
  foam_drill: 'Foam Drill',
  rodent_plugging: 'Rodent Plugging',
  termite_foam: 'Termite Foam',
  stinging_v2: 'Stinging Insect',
  exclusion_v2: 'Exclusion',
  rodent_guarantee_combo: 'Rodent Guarantee',
};

const labelFor = svc => SERVICE_LABEL[svc] || svc;

function commercialManualQuoteFields(li = {}) {
  if (!li.isCommercial && !String(li.service || '').startsWith('commercial_')) return {};
  return {
    commercialPricingMode: li.commercialPricingMode,
    isCommercial: !!li.isCommercial,
    commercialSubtype: li.commercialSubtype || null,
    originalRequestedService: li.originalRequestedService || null,
    quoteRequired: !!li.quoteRequired,
    requiresManualReview: !!li.requiresManualReview,
    autoQuoteRequiresAdminApproval: !!li.autoQuoteRequiresAdminApproval,
    manualReviewReasons: Array.isArray(li.manualReviewReasons) ? li.manualReviewReasons : [],
    taxable: li.taxable,
    taxCategory: li.taxCategory || null,
    pricingConfidence: li.pricingConfidence || null,
    reason: li.reason || null,
  };
}

function measurementMetadataFields(li = {}) {
  const fields = {};
  if (li.measurements !== undefined) fields.measurements = li.measurements;
  if (li.measurementWarnings !== undefined) fields.measurementWarnings = li.measurementWarnings;
  if (li.warnings !== undefined) fields.warnings = Array.isArray(li.warnings) ? li.warnings : [];
  if (li.footprintUsed !== undefined) fields.footprintUsed = li.footprintUsed;
  if (li.footprintSource !== undefined) fields.footprintSource = li.footprintSource;
  if (li.footprintWasDefaulted !== undefined) fields.footprintWasDefaulted = !!li.footprintWasDefaulted;
  if (li.requiresMeasurement !== undefined) fields.requiresMeasurement = !!li.requiresMeasurement;
  if (li.quoteRequired !== undefined) fields.quoteRequired = !!li.quoteRequired;
  if (li.requiresManualReview !== undefined) fields.requiresManualReview = !!li.requiresManualReview;
  if (li.manualReviewReasons !== undefined) {
    fields.manualReviewReasons = Array.isArray(li.manualReviewReasons) ? li.manualReviewReasons : [];
  }
  [
    'source',
    'standalone',
    'autoFiredFromRecurringPest',
    'requestedRoachType',
    'roachType',
    'roachTypeWasDefaulted',
    'severity',
    'severitySource',
    'pricingModel',
    'legacyPricingModel',
    'noRecurringDiscount',
    'visits',
    'setupCharge',
    'total',
    'scaleKey',
    'palmCountSource',
    'palmCountWasManualOverride',
    'palmCountWasDefaulted',
    'servicePalmCountDiffersFromPropertyPalmCount',
    'basePrice',
    'estimatedPrice',
    'baseEstimatePrice',
    'rawCost',
    'timeMin',
    'laborCost',
    'materialCost',
    'cleanupLevel',
    'requestedCleanupLevel',
    'cleanupLabel',
    'cleanupMin',
    'cleanupPriceAdder',
    'debrisRemovalIncluded',
    'access',
    'accessMin',
    'grassType',
    'requestedGrassType',
    'thatchDepthInches',
    'thatchMeasurementSource',
    'probeMeasurements',
    'dethatchingRecommended',
    'recommendationReason',
    'requiresManagerApproval',
    'managerApproved',
    'managerApprovalSatisfied',
    'managerApprovalReason',
    'managerApprovalOverrideReason',
    'equipmentMetadata',
  ].forEach((field) => {
    if (li[field] !== undefined) fields[field] = li[field];
  });
  if (li.inputSourceSummary !== undefined) fields.inputSourceSummary = li.inputSourceSummary;
  return fields;
}

const TERMITICIDE_METADATA_FIELDS = [
  'legacyService',
  'displayName',
  'productKey',
  'productLabel',
  'activeIngredient',
  'chemistryType',
  'positioning',
  'applicationRate',
  'requestedApplicationRate',
  'concentrationLabel',
  'trenchDepthFt',
  'concreteVolumePadPct',
  'productSurcharge',
  'baseInstallPrice',
  'warrantyTier',
  'requestedWarrantyTier',
  'warrantyLabel',
  'warrantyAdder',
  'warrantyAdd',
  'priceBeforeWarranty',
  'labelConfirmed',
  'requiresLabelConfirmation',
  'certificateOfTreatmentRequired',
  'slabSqFt',
  'slabSqFtSource',
  'productOzPer10SqFt',
  'productOz',
  'units',
  'containersRequired',
  'containerOz',
  'chemicalCostPerOz',
  'allocatedProductCost',
  'productCost',
  'fullContainerProductCost',
  'rawPrice',
  'jobContext',
  'preSlabJobContext',
  'requestedJobContext',
  'contextualFloor',
  'contextualMinimumBasis',
  'floorBeforeVolumeDiscount',
  'floorAfterVolumeDiscount',
  'priceBeforeVolumeDiscount',
  'volumeDiscount',
  'volumeDiscountMultiplier',
  'priceAfterVolumeDiscount',
  'warrantyExtendedSelected',
  'warrantyExtendedPrice',
  'warrantyStatus',
  'complianceAdminCost',
  'driveCost',
  'includeDriveCost',
  'certificateOfComplianceRequired',
  'addOns',
];

function termiticideMetadataFields(li = {}) {
  const fields = {};
  if (!['trenching', 'pre_slab_termiticide', 'pre_slab_termidor'].includes(li.service)) return fields;
  TERMITICIDE_METADATA_FIELDS.forEach((field) => {
    if (li[field] !== undefined) fields[field] = li[field];
  });
  if (fields.warningText === undefined && Array.isArray(li.warnings) && li.warnings.length > 0) {
    fields.warningText = li.warnings[0];
  }
  return fields;
}

function termiticideDetail(li = {}, fallback = '') {
  if (li.service === 'trenching') {
    const lfDetail = li.dirtLF !== undefined && li.concreteLF !== undefined
      ? `${li.dirtLF} LF dirt + ${li.concreteLF} LF concrete`
      : fallback;
    const productDetail = [
      li.productLabel,
      li.applicationRate,
      li.trenchDepthFt ? `${li.trenchDepthFt} ft` : null,
    ].filter(Boolean).join(' | ');
    return [lfDetail, productDetail].filter(Boolean).join(' | ') || fallback;
  }
  if (li.service === 'pre_slab_termiticide' || li.service === 'pre_slab_termidor') {
    const slabDetail = li.slabSqFt ? `${Number(li.slabSqFt).toLocaleString()} sf` : fallback;
    const productDetail = [
      li.productLabel,
      li.productOz ? `${li.productOz} oz` : null,
      li.units ? `${li.units} unit${li.units === 1 ? '' : 's'}` : null,
      li.warrantyLabel || (li.warrantyExtendedSelected ? 'Extended 5-year warranty' : 'No extended warranty'),
    ].filter(Boolean).join(' | ');
    return [slabDetail, productDetail].filter(Boolean).join(' | ') || fallback;
  }
  return fallback;
}

function describeMosquitoAddOns(addOns = {}, multiplier = 1) {
  const parts = [];
  const mult = Number.isFinite(Number(multiplier)) && Number(multiplier) > 0 ? Number(multiplier) : 1;
  const stationCount = Number(addOns.stationCount || 0);
  const dunkCount = Number(addOns.dunkCount || 0);
  const stationAddOn = Number(addOns.stationAddOn || 0) * mult;
  const dunkAddOn = Number(addOns.dunkAddOn || 0) * mult;
  if (stationCount > 0) parts.push(`${stationCount} mosquito station${stationCount === 1 ? '' : 's'} (+$${Math.round(stationAddOn)}/yr)`);
  if (dunkCount > 0) parts.push(`${dunkCount} Bti dunk tablet${dunkCount === 1 ? '' : 's'} (+$${Math.round(dunkAddOn)}/yr)`);
  return parts.join(' + ');
}

function mapV1ToLegacyShape(v1Result) {
  const R = {};
  const lineItems = v1Result.lineItems || [];
  const wg = v1Result.waveGuard || {};
  const summary = v1Result.summary || {};
  const isRecurringCustomer = !!(
    v1Result.isRecurringCustomer
    ?? v1Result.recurringCustomer
    ?? lineItems.some(li => (
      Number(li.recurringCustomerDiscountRate || 0) > 0
      || (li.discount?.appliedDiscounts || []).some(d => d.type === 'recurring_customer_one_time_perk')
    ))
  );

  const pestLI = lineItems.find(l => l.service === 'pest_control');
  const lawnLI = lineItems.find(l => l.service === 'lawn_care');
  const tsLI = lineItems.find(l => l.service === 'tree_shrub');
  const palmLI = lineItems.find(l => l.service === 'palm_injection');
  const mqLI = lineItems.find(l => l.service === 'mosquito');
  const tbLI = lineItems.find(l => l.service === 'termite_bait');
  const rbLI = lineItems.find(l => l.service === 'rodent_bait');

  // Pest → R.pest, R.pestTiers
  if (pestLI) {
    R.pestTiers = (pestLI.tiers || []).map(t => ({
      pa: t.perApp, apps: t.freq, ann: t.annual, mo: t.monthly,
      init: pestLI.initialFee || 0, rOG: pestLI.roachAddOn || 0,
      label: t.label, recommended: !!t.recommended, dimmed: !t.recommended,
    }));
    const sel = (pestLI.tiers || []).find(t => t.recommended) || (pestLI.tiers || [])[0] || {};
    R.pest = {
      pa: sel.perApp ?? pestLI.perApp,
      apps: sel.freq ?? pestLI.visitsPerYear,
      ann: sel.annual ?? pestLI.annual,
      mo: sel.monthly ?? pestLI.monthly,
      init: pestLI.initialFee || 0,
      rOG: pestLI.roachAddOn || 0,
      label: sel.label || 'Quarterly',
    };
    // Session 11a Step 2b-3: uppercase to match v2-legacy-mapper output.
    // pestLI.roachType is lowercase (german/regular/none) per service-pricing.
    R.pestRoachMod = (pestLI.roachType || 'none').toUpperCase();
  }

  // Lawn → R.lawn, R.lawnMeta
  if (lawnLI) {
    R.lawn = (lawnLI.tiers || []).map(t => ({
      pa: t.perApp, v: t.visits, ann: t.annual, mo: t.monthly,
      name: t.label || `${t.visits} Applications`,
      recommended: !!t.recommended, dimmed: !t.recommended,
      hasLandscape: t.visits >= 12,
      pricingSource: t.pricingSource,
      pricingBasis: t.pricingBasis,
      costFloorApplied: !!t.costFloorApplied,
    }));
    R.lawnMeta = {
      lsf: lawnLI.lawnSqFt || 0,
      sc: 0,
      tf: 0,
      oa: 0,
      grassType: lawnLI.track,
      grassCode: lawnLI.grassCode,
      grassName: lawnLI.grassType,
      turfEstimated: lawnLI.turfEstimated,
      turfConfidence: lawnLI.turfConfidence,
      turfBasis: lawnLI.turfBasis,
      customQuoteFlag: !!lawnLI.customQuoteFlag,
      pricingBasis: lawnLI.pricingBasis,
      pricingSource: lawnLI.pricingSource,
    };
  }

  // Tree & Shrub → R.ts, R.tsMeta
  if (tsLI) {
    R.ts = treeShrubLegacyTierRows(v1Result, tsLI);
    R.tsMeta = {
      eb: tsLI.bedArea || 0,
      et: tsLI.treeCount || 0,
      bedAreaIsEstimated: false,
    };
  }

  // Palm Injection → R.injection
  let palmAnnualBeforeCredits = 0;
  let palmAnnualAfterCredits = 0;
  let palmMonthlyAfterCredits = 0;
  let palmFlatCreditAnnual = 0;
  if (palmLI) {
    palmAnnualBeforeCredits = roundMoney(palmLI.annualBeforeCredits ?? palmLI.annualBeforeDiscount ?? palmLI.annual);
    palmAnnualAfterCredits = roundMoney(palmLI.annualAfterCredits ?? palmLI.annualAfterDiscount ?? palmLI.annual);
    palmMonthlyAfterCredits = roundMoney(palmLI.monthlyAfterCredits ?? palmLI.monthlyAfterDiscount ?? (palmAnnualAfterCredits / 12));
    palmFlatCreditAnnual = roundMoney(palmLI.flatCreditAnnual ?? palmLI.discount?.flatCreditAnnual);
    const parts = [
      palmLI.treatmentLabel || 'Palm Injection',
      palmLI.palmSize ? `${palmLI.palmSize} palms` : null,
      `$${palmLI.pricePerPalm}/palm`,
      `${palmLI.appsPerYear}/yr`,
      palmLI.minimumApplied ? `$${palmLI.perVisit} visit minimum applied` : null,
    ].filter(Boolean);
    R.injection = {
      palms: palmLI.palmCount,
      ann: palmAnnualAfterCredits,
      mo: palmMonthlyAfterCredits,
      pricePerPalm: palmLI.pricePerPalm,
      appsPerYear: palmLI.appsPerYear,
      palmSize: palmLI.palmSize,
      perVisit: palmLI.perVisit,
      annualBeforeCredits: palmAnnualBeforeCredits,
      flatCreditAnnual: palmFlatCreditAnnual,
      annualAfterCredits: palmAnnualAfterCredits,
      monthlyAfterCredits: palmMonthlyAfterCredits,
      treatmentLabel: palmLI.treatmentLabel,
      measurements: palmLI.measurements,
      palmCountSource: palmLI.palmCountSource,
      palmCountWasManualOverride: palmLI.palmCountWasManualOverride,
      palmCountWasDefaulted: palmLI.palmCountWasDefaulted,
      servicePalmCountDiffersFromPropertyPalmCount: palmLI.servicePalmCountDiffersFromPropertyPalmCount,
      measurementWarnings: palmLI.measurementWarnings || [],
      requiresMeasurement: !!palmLI.requiresMeasurement,
      requiresManualReview: !!palmLI.requiresManualReview,
      manualReviewReasons: palmLI.manualReviewReasons || [],
      detail: parts.join(' · '),
    };
  }

  // Mosquito → R.mq, R.mqMeta
  if (mqLI) {
    const selectedIndex = (mqLI.tiers || []).findIndex(t => t.tier === mqLI.tier);
    let ri = selectedIndex >= 0 ? selectedIndex : 0;
    R.mq = (mqLI.tiers || []).map((t, i) => {
      const selected = !!(t.isSelected ?? t.selected);
      const recommended = !!(t.isRecommended ?? t.recommended);
      return {
        pv: t.perVisit, v: t.visits, ann: t.annual, mo: t.monthly,
        n: t.name,
        selected,
        recommended,
        isSelected: selected,
        isRecommended: recommended,
        dimmed: !selected,
        pressureRecommended: !!t.pressureRecommended,
      };
    });
    R.mqMeta = {
      pr: mqLI.pressureMultiplier || 1,
      sz: mqLI.lotCategory || 'SMALL',
      program: mqLI.tier || 'monthly',
      selectedProgram: mqLI.selectedProgram || mqLI.tier || null,
      selectedTier: mqLI.selectedTier || mqLI.tier || null,
      recommendedProgram: mqLI.recommendedProgram || null,
      recommendedTier: mqLI.recommendedTier || mqLI.recommendedProgram || null,
      tierWasForced: !!mqLI.tierWasForced,
      recommendationReasons: Array.isArray(mqLI.recommendationReasons) ? mqLI.recommendationReasons : [],
      addOns: mqLI.addOns || null,
      ri,
    };
  }

  // Termite Bait → R.tmBait
  // v1 only emits the selected system's price (trelona OR advance), so the
  // opposite system falls back to defaults matching v2-legacy-mapper.
  if (tbLI) {
    const installPrice = tbLI.installation?.price || 0;
    const monMonthly = tbLI.monitoring?.monthly || 0;
    const selectedSystem = tbLI.selectedSystem || tbLI.system || null;
    R.tmBait = {
      selectedSystem,
      system: selectedSystem,
      selectedMonitoringTier: tbLI.selectedMonitoringTier || tbLI.monitoringTier || null,
      monitoringTier: tbLI.monitoringTier || tbLI.selectedMonitoringTier || null,
      ai: selectedSystem === 'advance' ? installPrice : null,
      ti: selectedSystem === 'trelona' ? installPrice : null,
      bmo: tbLI.monitoringTier === 'basic' ? monMonthly : 35,
      pmo: tbLI.monitoringTier === 'premier' ? monMonthly : 65,
      perim: tbLI.perimeter || 0,
      sta: tbLI.stations || 0,
      measurements: tbLI.measurements || null,
      measurementWarnings: tbLI.measurementWarnings || [],
      requiresMeasurement: !!tbLI.requiresMeasurement,
      quoteRequired: !!tbLI.quoteRequired,
      requiresManualReview: !!tbLI.requiresManualReview,
      manualReviewReasons: tbLI.manualReviewReasons || [],
    };
  }

  // Rodent Bait → R.rodBaitMo, R.rodBaitSize
  if (rbLI) {
    R.rodBaitMo = rbLI.monthly || 0;
    const sz = (rbLI.size || '').toLowerCase();
    R.rodBaitSize = sz === 'small' ? 'Small' : sz === 'large' ? 'Large' : 'Medium';
  }

  // Recurring services[] — pre-discount monthlies, matching v2-legacy-mapper
  // convention (see v2-legacy-mapper.js:159). Order matches v2's wg.services:
  // lawn → pest → tree_shrub → mosquito → termite_bait.
  // perTreatment + visitsPerYear are forwarded so the customer-facing estimate
  // can render per-application pricing per service.
  const services = [];
  const svcAdd = (name, li, extra = {}) => {
    if (!li) return;
    const mo = li.monthly || 0;
    const perTreatment = Number(li.perApp ?? li.perVisit ?? 0) || null;
    const visitsPerYear = Number(li.visitsPerYear ?? li.visits ?? li.frequency ?? 0) || null;
    services.push({ name, mo, monthly: mo, perTreatment, visitsPerYear, ...measurementMetadataFields(li), ...extra });
  };
  svcAdd('Lawn Care', lawnLI, {
    service: 'lawn_care',
    discountable: true,
    discountEligible: true,
    waveGuardDiscountEligible: true,
    waveGuardTierEligible: true,
    countsTowardWaveGuardTier: true,
    discount: {
      discountable: true,
      requestedDiscountPercent: lawnLI?.discount?.requestedDiscountPercent ?? lawnLI?.discount?.effectiveDiscount ?? 0,
      appliedDiscountPercent: lawnLI?.discount?.appliedDiscountPercent ?? lawnLI?.discount?.effectiveDiscount ?? 0,
      effectiveDiscount: lawnLI?.discount?.effectiveDiscount ?? 0,
    },
    pricingVersion: lawnLI?.pricingVersion,
    pricingSource: lawnLI?.pricingSource,
  });
  svcAdd('Pest Control', pestLI, { service: 'pest_control' });
  svcAdd('Tree & Shrub', tsLI, { service: 'tree_shrub' });
  if (mqLI) {
    const selectedTier = (mqLI.tiers || []).find(t => t.tier === mqLI.tier)
      || (mqLI.tiers || []).find(t => t.selected || t.isSelected)
      || (mqLI.tiers || []).find(t => t.recommended)
      || null;
    const visits = selectedTier?.visits || mqLI.visits || 0;
    const selectedAnnual = Number(selectedTier?.annual || 0);
    const recurringMultiplier = selectedAnnual > 0 ? Number(mqLI.annual || selectedAnnual) / selectedAnnual : 1;
    const addOnDetail = describeMosquitoAddOns(mqLI.addOns || {}, recurringMultiplier);
    const detailParts = [
      'Mosquito program',
      visits ? `${visits} visits/yr` : null,
      addOnDetail || null,
    ].filter(Boolean);
    svcAdd('Mosquito', mqLI, {
      service: 'mosquito',
      program: mqLI.tier || null,
      displayName: selectedTier?.name || 'Mosquito',
      detail: detailParts.join(' · '),
      addOns: mqLI.addOns || null,
    });
  }
  if (tbLI && !tbLI.quoteRequired && !tbLI.requiresMeasurement) {
    svcAdd('Termite Bait', tbLI, { service: 'termite_bait' });
  }

  // One-time + specialty split
  const v1OtItems = [];
  const v1SpecItems = [];
  lineItems.forEach(li => {
    if (RECURRING_SERVICES.has(li.service)) return;
    // Prefer the engine's own label when present (e.g. pest_initial_roach
    // emits 'Initial Native Roach Knockdown' vs 'Initial German Roach
    // Knockdown' — SERVICE_LABEL flattens both to a generic name and would
    // drop the species distinction). Fall back to the SERVICE_LABEL map for
    // legacy services that don't set a label themselves.
    const name = li.display?.name || li.label || labelFor(li.service);
    const quoteRequired = !!li.quoteRequired || !!li.requiresCustomQuote;
    const price = quoteRequired ? null : effectiveOneTimePrice(li);
    const detail = [
      li.detail || li.det || '',
      li.reason || '',
      li.exteriorDetail || li.display?.exteriorDetail || '',
      li.warning || '',
    ].filter(Boolean).join(' · ');
    if (ONE_TIME_SERVICES.has(li.service)) {
      const mappedDetail = termiticideDetail(li, detail);
      if (quoteRequired) {
        v1SpecItems.push({
          service: li.service,
          name,
          price: null,
          det: mappedDetail,
          quoteRequired: true,
          reason: li.reason,
          warning: li.warning || null,
          warnings: li.warnings || [],
          requiresCustomQuote: !!li.requiresCustomQuote,
          customQuoteReason: li.customQuoteReason || null,
          requiresMeasurement: !!li.requiresMeasurement,
          ...measurementMetadataFields(li),
          ...termiticideMetadataFields(li),
          ...commercialManualQuoteFields(li),
        });
        return;
      }
      // Preserve `service` on the mapped item so consumers can match by
      // canonical key (e.g. estimate-public's findInitialRoachItem) without
      // depending on display labels that may be re-translated downstream.
      const item = {
        service: li.service,
        name,
        price,
        detail: mappedDetail,
        ...measurementMetadataFields(li),
        ...termiticideMetadataFields(li),
      };
      if (li.spacing !== undefined) item.spacing = li.spacing;
      if (li.lawnType !== undefined) item.lawnType = li.lawnType;
      if (li.tierName !== undefined) item.tierName = li.tierName;
      if (li.addOns !== undefined) item.addOns = li.addOns;
      if (!quoteRequired && li.renewal !== undefined) item.renewal = li.renewal;
      if (!quoteRequired && li.renewalLabel !== undefined) item.renewalLabel = li.renewalLabel;
      if (li.serviceSpecificDiscountApplied !== undefined) item.serviceSpecificDiscountApplied = !!li.serviceSpecificDiscountApplied;
      if (li.serviceSpecificDiscounts !== undefined) item.serviceSpecificDiscounts = li.serviceSpecificDiscounts;
      v1OtItems.push(item);
      if (li.service === 'trenching' && !quoteRequired) R.trench = true;
    } else {
      const mappedDetail = termiticideDetail(li, detail);
      v1SpecItems.push({
        service: li.service, name, price, det: mappedDetail,
        onProg: !!li.includedOnProgram,
        quoteRequired,
        reason: li.reason,
        exteriorDetail: li.exteriorDetail || li.display?.exteriorDetail || '',
        warning: li.warning || null,
        warnings: li.warnings || [],
        requiresCustomQuote: !!li.requiresCustomQuote,
        customQuoteReason: li.customQuoteReason || null,
        offerKey: li.offerKey,
        billingCadence: li.billingCadence,
        visits: li.visits,
        warrantyType: li.warrantyType,
        warrantyLabel: li.warrantyLabel,
        guaranteeScope: li.guaranteeScope,
        guaranteeStatus: li.guaranteeStatus,
        guaranteeExclusions: li.guaranteeExclusions || [],
        guaranteeWindowDaysAfterFollowUp: li.guaranteeWindowDaysAfterFollowUp,
        maxIncludedRetreats: li.maxIncludedRetreats,
        prepChecklistRequired: !!li.prepChecklistRequired,
        petSourceAttestationRequired: !!li.petSourceAttestationRequired,
        exteriorStatus: li.exteriorStatus,
        fleaExteriorZones: li.fleaExteriorZones || [],
        addOns: li.addOns || [],
        serviceSpecificDiscountApplied: !!li.serviceSpecificDiscountApplied,
        serviceSpecificDiscounts: li.serviceSpecificDiscounts || [],
        warrantyExtendedSelected: li.warrantyExtendedSelected,
        warrantyExtendedPrice: li.warrantyExtendedPrice,
        warrantyAdd: li.warrantyAdd,
        ...measurementMetadataFields(li),
        ...termiticideMetadataFields(li),
        ...commercialManualQuoteFields(li),
      });
    }
  });

  // Termite installation → one-time items
  let tmInstall = 0;
  if (tbLI && (tbLI.installation?.price || 0) > 0) {
    tmInstall = tbLI.installation.price;
    v1OtItems.push({
      service: 'termite_bait_installation',
      name: `${CAP(tbLI.system)} Installation`,
      price: tmInstall,
      detail: `${tbLI.stations} stations · ${tbLI.perimeter} linear ft perimeter`,
      ...measurementMetadataFields(tbLI),
    });
  }

  // v2 convention: WaveGuard Membership ($99 initial fee) counts in
  // oneTime.total but NOT in oneTime.items[]. Match that.
  const membershipFee = pestLI?.initialFee || 0;

  const oneTimeItemsMoney = v1OtItems.reduce((s, i) => s + (i.price || 0), 0);
  const specialtyMoney = v1SpecItems
    .filter(s => !s.onProg)
    .reduce((s, i) => s + (i.price || 0), 0);
  const oneTimeTotal = oneTimeItemsMoney + specialtyMoney + membershipFee;
  const quoteRequiredItems = lineItems
    .filter(li => li && (li.quoteRequired === true || li.requiresCustomQuote === true))
    .map(li => ({
      service: li.service,
      name: li.display?.name || li.label || labelFor(li.service),
      reason: li.reason || li.customQuoteReason || null,
      ...measurementMetadataFields(li),
      ...termiticideMetadataFields(li),
      ...commercialManualQuoteFields(li),
      quoteRequired: true,
    }));
  const quoteRequired = quoteRequiredItems.length > 0;

  const topDressingLI = lineItems.find(l => l.service === 'top_dressing');
  if (topDressingLI) {
    const pricedLawnSqFt = Number(topDressingLI.lawnSqFt || 0);
    const eighth = priceTopDressing(pricedLawnSqFt, 'eighth', true);
    const quarter = priceTopDressing(pricedLawnSqFt, 'quarter', true);
    const selectedBase = finiteMoney(topDressingLI.priceBeforeDiscount)
      ?? finiteMoney(topDressingLI.price)
      ?? finiteMoney(topDressingLI.totalBeforeDiscount)
      ?? finiteMoney(topDressingLI.total);
    const selectedEffective = finiteMoney(topDressingLI.priceAfterDiscount)
      ?? finiteMoney(topDressingLI.totalAfterDiscount)
      ?? finiteMoney(topDressingLI.price)
      ?? finiteMoney(topDressingLI.total);
    const selectedMultiplier = selectedBase && selectedBase > 0 && selectedEffective !== null
      ? selectedEffective / selectedBase
      : 1;
    let eighthPrice = roundMoney(eighth.price * selectedMultiplier);
    let quarterPrice = roundMoney(quarter.price * selectedMultiplier);
    const linePrice = effectiveOneTimePrice(topDressingLI);
    if (Number.isFinite(Number(linePrice))) {
      if (topDressingLI.depth === 'quarter') quarterPrice = Number(linePrice);
      else eighthPrice = Number(linePrice);
    }
    R.td = roundMoney(eighthPrice);
    R.tdTiers = [
      { name: '1/8" Depth', price: R.td, detail: 'St. Augustine standard' },
      { name: '1/4" Depth', price: roundMoney(quarterPrice), detail: 'Bermuda / leveling — 2x material' },
    ];
  }

  const waveGuardTier = CAP(wg.tier || 'bronze');
  const rodentBaitMonthly = rbLI ? (rbLI.monthly || 0) : 0;
  const rodentBaitAnnual = rodentBaitMonthly * 12;
  const palmInjectionMonthly = palmLI ? palmMonthlyAfterCredits : 0;
  const palmInjectionAnnual = palmLI ? palmAnnualAfterCredits : 0;
  const recurringAnnualBefore = Math.max(0, Math.round(((summary.recurringAnnualBeforeDiscount || 0) - rodentBaitAnnual - palmAnnualBeforeCredits) * 100) / 100);
  const recurringAnnual = Math.max(0, Math.round(((summary.recurringAnnualAfterDiscount || 0) - rodentBaitAnnual - palmInjectionAnnual) * 100) / 100);
  const recurringMonthly = Math.round((recurringAnnual / 12) * 100) / 100;

  // year1: recurring year + one-time items + specialty + membership.
  // v1's summary.year1Total doesn't include membership — we fix it here
  // to match v2's year1 convention.
  const year1 = Math.round((recurringAnnual + rodentBaitAnnual + palmInjectionAnnual + oneTimeTotal) * 100) / 100;
  const year2 = Math.round((recurringAnnual + rodentBaitAnnual + palmInjectionAnnual) * 100) / 100;
  const year2Monthly = Math.round((year2 / 12) * 100) / 100;

  // Project v1 features back onto flat v2-shape keys so EstimatePage's
  // client-side modifiers fallback (which predates Session 11a and reads
  // `p.poolCage === 'YES'`, `p.shrubDensity`, `p.hasLargeDriveway`, etc.)
  // renders correctly without touching the engine output shape.
  const vp = v1Result.property || {};
  const vf = vp.features || {};
  const upper = v => (v ? String(v).toUpperCase() : '');
  const legacyProperty = {
    ...vp,
    pool: vf.pool ? 'YES' : 'NO',
    poolCage: vf.poolCage ? 'YES' : 'NO',
    poolCageSize: vf.poolCageSize || (vf.poolCage ? 'medium' : 'none'),
    hasLargeDriveway: !!vf.largeDriveway,
    shrubDensity: upper(vf.shrubs),
    treeDensity: upper(vf.trees),
    landscapeComplexity: upper(vf.complexity),
  };

  return {
    property: legacyProperty,
    productionDiagnostics: pestLI?.productionDiagnostics || null,
    fieldVerify: v1Result.fieldVerify || [],
    notes: v1Result.notes || [],
    pricingMetadata: v1Result.pricingMetadata || v1Result.routingMetadata || null,
    routingMetadata: v1Result.routingMetadata || v1Result.pricingMetadata || null,
    urgency: { mult: 1, label: '' },
    recurringCustomer: isRecurringCustomer,
    isRecurringCustomer,
    hasRecurring: services.length > 0 || palmInjectionMonthly > 0 || rodentBaitMonthly > 0,
    hasOneTime: v1OtItems.length > 0 || v1SpecItems.some(s => !s.onProg && (s.quoteRequired || s.price > 0)),
    quoteRequired,
    quoteRequiredReason: quoteRequiredItems[0]?.reason || null,
    quoteRequiredItems,
    recurring: {
      serviceCount: wg.qualifyingCount || 0,
      tier: waveGuardTier,
      waveGuardTier,
      discount: wg.discount || 0,
      annualBeforeDiscount: quoteRequired ? 0 : recurringAnnualBefore,
      grandTotal: quoteRequired ? 0 : year2Monthly,
      monthlyTotal: quoteRequired ? 0 : recurringMonthly,
      annualAfterDiscount: quoteRequired ? 0 : recurringAnnual,
      savings: roundMoney((summary.waveGuardSavings || 0) - palmFlatCreditAnnual),
      rodentBaitMo: rodentBaitMonthly,
      palmInjectionMo: palmInjectionMonthly,
      palmInjectionAnn: palmInjectionAnnual,
      services,
    },
    oneTime: {
      items: v1OtItems,
      specItems: v1SpecItems
        .filter(s => !s.onProg && (s.quoteRequired || s.price > 0 || s.serviceSpecificDiscountApplied))
        .map(s => ({
          service: s.service,
          name: s.name,
          price: s.quoteRequired ? null : s.price,
          detail: s.det,
          exteriorDetail: s.exteriorDetail,
          warning: s.warning,
          warnings: s.warnings,
          quoteRequired: !!s.quoteRequired,
          reason: s.reason,
          commercialPricingMode: s.commercialPricingMode,
          isCommercial: !!s.isCommercial,
          commercialSubtype: s.commercialSubtype || null,
          originalRequestedService: s.originalRequestedService || null,
          requiresManualReview: !!s.requiresManualReview,
          autoQuoteRequiresAdminApproval: !!s.autoQuoteRequiresAdminApproval,
          manualReviewReasons: Array.isArray(s.manualReviewReasons) ? s.manualReviewReasons : [],
          taxable: s.taxable,
          taxCategory: s.taxCategory || null,
          pricingConfidence: s.pricingConfidence || null,
          requiresCustomQuote: !!s.requiresCustomQuote,
          customQuoteReason: s.customQuoteReason,
          fleaExteriorZones: s.fleaExteriorZones,
          source: s.source,
          pricingModel: s.pricingModel,
          legacyPricingModel: s.legacyPricingModel,
          visits: s.visits,
          setupCharge: s.setupCharge,
          total: s.total,
          noRecurringDiscount: s.noRecurringDiscount,
          standalone: s.standalone,
          autoFiredFromRecurringPest: s.autoFiredFromRecurringPest,
          requestedRoachType: s.requestedRoachType,
          roachType: s.roachType,
          severity: s.severity,
          measurements: s.measurements,
          measurementWarnings: s.measurementWarnings,
          requiresMeasurement: !!s.requiresMeasurement,
          inputSourceSummary: s.inputSourceSummary,
          addOns: s.addOns,
          serviceSpecificDiscountApplied: !!s.serviceSpecificDiscountApplied,
          serviceSpecificDiscounts: s.serviceSpecificDiscounts || [],
          warrantyExtendedSelected: s.warrantyExtendedSelected,
          warrantyExtendedPrice: s.warrantyExtendedPrice,
          ...measurementMetadataFields(s),
          ...termiticideMetadataFields(s),
        })),
      total: oneTimeTotal,
      tmInstall,
      // Kept out of items[] by legacy v2 convention, but surfaced
      // explicitly so the customer-facing estimate can render it as
      // its own line with the "waived with annual prepay" note.
      membershipFee,
      otSubtotal: oneTimeTotal - tmInstall,
    },
    totals: {
      year1: quoteRequired ? 0 : year1,
      year2: quoteRequired ? 0 : year2,
      year2mo: quoteRequired ? 0 : year2Monthly,
      manualDiscount: summary.manualDiscount || null,
      serviceSpecificDiscounts: summary.serviceSpecificDiscounts || [],
    },
    manualDiscount: summary.manualDiscount || null,
    serviceSpecificDiscounts: summary.serviceSpecificDiscounts || [],
    results: R,
    specItems: v1SpecItems,
  };
}

module.exports = { mapV1ToLegacyShape };
