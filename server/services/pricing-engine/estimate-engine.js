// ============================================================
// estimate-engine.js — Waves Estimate Engine (Orchestrator)
// Combines property calculation, service pricing, and discounts
// into a complete customer estimate
// ============================================================
const { GLOBAL, WAVEGUARD, URGENCY, TREE_SHRUB } = require('./constants');

// All-in annual cost (direct + admin) + margin floor for the guarded services,
// mirroring discount-engine.applyMarginGuard's per-service cost shapes. Returns
// null for services that don't expose a cost basis.
function guardedLineCost(item) {
  if (item.service === 'pest_control') {
    const cost = Number(item.costs?.annualCost);
    return Number.isFinite(cost) ? { cost, floor: Number(GLOBAL.MARGIN_FLOOR) } : null;
  }
  if (item.service === 'tree_shrub') {
    const direct = Number(item.costs?.directCost);
    const admin = Number(item.costs?.adminCost ?? GLOBAL.ADMIN_ANNUAL);
    return Number.isFinite(direct)
      ? { cost: direct + admin, floor: Number(TREE_SHRUB.marginFloor || GLOBAL.MARGIN_FLOOR) }
      : null;
  }
  return null;
}
const { calculatePropertyProfile } = require('./property-calculator');
const { deriveModifiers, deriveNotes } = require('./modifiers');
const {
  pricePestControl, priceCommercialPestPilot, pricePestInitialRoach, priceLawnCare, priceTreeShrub, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceRodentTrappingFollowups, priceSanitation, priceBaitSetup,
  priceRodentInspection, priceTrapOnlyRetainer, priceRodentWireMesh, priceRodentBirdBoxes,
  selectRodentBundle, applyRodentBundle,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermiticide, pricePreSlabTermidor,
  priceGermanRoach, priceGermanRoachInitial, priceBedBugTreatment, priceWDO, priceFlea,
  priceTopDressing, priceDethatching,
  pricePlugging, priceFoamDrill, priceRecurringFoam, priceStingingInsect, priceExclusion, priceRodentExclusionV2, priceRodentGuarantee,
  calculatePluggingPrice, calculateFoamPrice, calculateStingingPrice,
  calculateExclusionPrice, calculateRodentGuaranteeCombo,
  resolvePalmCount,
  normalizeRoachType,
} = require('./service-pricing');
const {
  determineWaveGuardTier, getEffectiveDiscount, applyDiscount, applyMarginGuard, validateEstimateDiscounts,
} = require('./discount-engine');
const {
  isCommercialProperty,
  buildCommercialManualQuoteResult,
} = require('./commercial-helpers');

function serviceSelected(value) {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  return value.selected === true || value.enabled === true || value.value === true;
}

function serviceOptions(value) {
  return value && typeof value === 'object' ? value : {};
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).filter(Boolean))];
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function buildPalmCountError(resolution) {
  const err = new Error('Palm count is required for palm injection pricing.');
  err.name = 'PricingError';
  err.status = 400;
  err.statusCode = 400;
  err.code = 'PALM_COUNT_REQUIRED';
  err.isOperational = true;
  err.metadata = resolution;
  return err;
}

function attachPalmCountMetadata(result, resolution) {
  result.measurements = {
    ...(result.measurements || {}),
    palmCount: {
      value: resolution.palmCount,
      source: resolution.source,
    },
  };
  result.palmCountSource = resolution.source;
  result.palmCountWasManualOverride = !!resolution.wasManualOverride;
  result.palmCountWasDefaulted = !!resolution.wasDefaulted;
  result.servicePalmCountDiffersFromPropertyPalmCount = !!resolution.servicePalmCountDiffersFromPropertyPalmCount;
  result.measurementWarnings = uniqueStrings([
    ...(result.measurementWarnings || []),
    ...(resolution.warnings || []),
  ]);
  result.requiresMeasurement = !!result.requiresMeasurement || !!resolution.requiresMeasurement;
  result.requiresManualReview = !!result.requiresManualReview || !!resolution.requiresManualReview;
  result.manualReviewReasons = uniqueStrings([
    ...(result.manualReviewReasons || []),
    ...(resolution.manualReviewReasons || []),
  ]);
  return result;
}

const MANUAL_RECURRING_DISCOUNT_ELIGIBLE = new Set([
  'pest_control',
  'lawn_care',
  'lawn_care_enhanced',
  'lawn_care_premium',
  'mosquito',
  'tree_shrub',
]);

function isManualRecurringDiscountEligible(item) {
  return MANUAL_RECURRING_DISCOUNT_ELIGIBLE.has(resolveDiscountKey(item));
}

// Effective (post-WaveGuard, post-service-credit) price of a one-time or
// specialty line, used as the base for the one-time slice of a manual discount.
function manualOneTimeLinePrice(item = {}) {
  const value = item.priceAfterDiscount ?? item.totalAfterDiscount ?? item.price ?? item.total ?? 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

// One-time / specialty lines a manual or custom discount may reduce. Honors the
// full set of line-level discount-exclusion flags (e.g. the trap-only retainer
// is priced as a one-time line but is explicitly discountEligible:false /
// excludedFromCoupons:true) and skips quote-required / measurement-pending /
// zero-price lines (no firm price to discount yet).
function isManualOneTimeDiscountEligible(item) {
  if (!item) return false;
  if (item.discountable === false || item.discount?.discountable === false) return false;
  if (item.discountEligible === false) return false;
  if (item.excludedFromCoupons === true || item.excludedFromBundleDiscounts === true) return false;
  if (item.quoteRequired || item.requiresCustomQuote || item.requiresMeasurement) return false;
  return manualOneTimeLinePrice(item) > 0;
}

function normalizedDiscountText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeServiceCreditServiceKey(value) {
  return normalizedDiscountText(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function serviceCreditTargetsLine(credit = {}, item = {}) {
  const targetKeys = [
    credit.service,
    credit.serviceKey,
    credit.service_key,
    credit.serviceKeyFilter,
    credit.service_key_filter,
    credit.eligibility?.serviceKeyFilter,
  ].map(normalizeServiceCreditServiceKey).filter(Boolean);
  const itemService = normalizeServiceCreditServiceKey(item.service);
  const itemName = normalizedDiscountText(item.displayName || item.label || item.name || item.service);
  if (targetKeys.length > 0) {
    if (targetKeys.includes(itemService)) return true;
    if (targetKeys.includes('termite_inspection') && itemService === 'wdo_inspection') return true;
    if (targetKeys.includes('wdo_inspection') && itemService === 'termite_inspection') return true;
    return false;
  }
  const creditName = normalizedDiscountText(credit.catalogName || credit.label || credit.name);
  return (creditName.includes('termite inspection') || creditName.includes('wdo'))
    && (itemService === 'wdo_inspection' || itemService === 'termite_inspection' || itemName.includes('termite inspection') || itemName.includes('wdo'));
}

function serviceCreditLinePrice(item = {}) {
  const value = item.priceAfterDiscount ?? item.totalAfterDiscount ?? item.price ?? item.total;
  const amount = Number(value);
  return Number.isFinite(amount) ? roundMoney(amount) : 0;
}

function applyServiceSpecificCredits(lineItems = [], serviceSpecificDiscounts = []) {
  const credits = Array.isArray(serviceSpecificDiscounts)
    ? serviceSpecificDiscounts.filter(Boolean)
    : [];
  if (!credits.length) return [];

  const appliedByService = new Set();
  const applied = [];

  for (const credit of credits) {
    const warnings = uniqueStrings(credit.warnings || []);
    const target = lineItems.find((item) => serviceCreditTargetsLine(credit, item));
    const targetService = target?.service || credit.service || credit.serviceKey || credit.service_key || null;

    if (!target) {
      applied.push({
        source: credit.source || 'catalog_preset',
        presetId: credit.presetId || null,
        presetKey: credit.presetKey || null,
        catalogName: credit.catalogName || credit.name || null,
        catalogCategory: 'service_specific_credit',
        discountType: credit.discountType || credit.discount_type || 'free_service',
        service: targetService,
        serviceLineId: null,
        requestedAmount: 0,
        amount: 0,
        label: credit.label || credit.catalogName || credit.name || 'Service credit',
        eligibility: credit.eligibility || null,
        capped: true,
        capReason: 'service_line_not_present',
        warnings: uniqueStrings([...warnings, 'service_specific_discount_service_not_present']),
      });
      continue;
    }

    if (appliedByService.has(target.service)) {
      applied.push({
        source: credit.source || 'catalog_preset',
        presetId: credit.presetId || null,
        presetKey: credit.presetKey || null,
        catalogName: credit.catalogName || credit.name || null,
        catalogCategory: 'service_specific_credit',
        discountType: credit.discountType || credit.discount_type || 'free_service',
        service: target.service,
        serviceLineId: target.id || target.service,
        requestedAmount: 0,
        amount: 0,
        label: credit.label || credit.catalogName || credit.name || 'Service credit',
        eligibility: credit.eligibility || null,
        capped: true,
        capReason: 'duplicate_service_line_credit',
        warnings: uniqueStrings([...warnings, 'service_specific_discount_duplicate_skipped']),
      });
      continue;
    }

    if (target.discountable === false || target.discount?.discountable === false) {
      applied.push({
        source: credit.source || 'catalog_preset',
        presetId: credit.presetId || null,
        presetKey: credit.presetKey || null,
        catalogName: credit.catalogName || credit.name || null,
        catalogCategory: 'service_specific_credit',
        discountType: credit.discountType || credit.discount_type || 'free_service',
        service: target.service,
        serviceLineId: target.id || target.service,
        requestedAmount: roundMoney(credit.requestedAmount ?? 0),
        amount: 0,
        label: credit.label || credit.catalogName || credit.name || 'Service credit',
        eligibility: credit.eligibility || null,
        capped: true,
        capReason: 'non_discountable_service',
        warnings: uniqueStrings([...warnings, 'service_specific_discount_service_not_discountable']),
      });
      continue;
    }

    const currentPrice = serviceCreditLinePrice(target);
    const requestedAmount = roundMoney(credit.requestedAmount ?? currentPrice);
    const amount = Math.min(requestedAmount, currentPrice);
    if (target.price !== undefined || target.priceAfterDiscount !== undefined) {
      target.priceBeforeServiceSpecificDiscount = target.priceBeforeServiceSpecificDiscount ?? (target.priceAfterDiscount ?? target.price ?? 0);
      target.priceAfterDiscount = roundMoney(currentPrice - amount);
    } else if (target.total !== undefined || target.totalAfterDiscount !== undefined) {
      target.totalBeforeServiceSpecificDiscount = target.totalBeforeServiceSpecificDiscount ?? (target.totalAfterDiscount ?? target.total ?? 0);
      target.totalAfterDiscount = roundMoney(currentPrice - amount);
    }
    target.serviceSpecificDiscountApplied = true;
    target.serviceSpecificDiscounts = [
      ...(target.serviceSpecificDiscounts || []),
      {
        presetId: credit.presetId || null,
        presetKey: credit.presetKey || null,
        catalogName: credit.catalogName || credit.name || null,
        amount,
      },
    ];

    appliedByService.add(target.service);
    applied.push({
      source: credit.source || 'catalog_preset',
      presetId: credit.presetId || null,
      presetKey: credit.presetKey || null,
      catalogName: credit.catalogName || credit.name || null,
      catalogCategory: 'service_specific_credit',
      discountType: credit.discountType || credit.discount_type || 'free_service',
      service: target.service,
      serviceLineId: target.id || target.service,
      requestedAmount,
      amount,
      label: credit.label || credit.catalogName || credit.name || 'Service credit',
      eligibility: credit.eligibility || null,
      capped: true,
      capReason: 'service_line_price',
      warnings,
    });
  }

  return applied;
}

function isAnnualPrepayBilling(input = {}) {
  const candidates = [
    input.billingMode,
    input.billingTerm,
    input.paymentPreference,
    input.paymentMethodPreference,
    input.billing_mode,
    input.billing_term,
    input.payment_preference,
    input.payment_method_preference,
  ].map(normalizedDiscountText);
  return candidates.some((value) => value === 'prepay_annual' || value === 'annual' || value === 'prepay' || value === 'annual_prepay');
}

function manualDiscountEligibilityWarnings(md = {}, input = {}) {
  const eligibility = md.eligibility || {};
  const warnings = [...(md.warnings || [])];
  const confirmed = md.eligibilityConfirmed === true;
  const annualPrepay = isAnnualPrepayBilling(input);
  const add = (warning) => warnings.push(warning);

  const requiresPrepay = !!eligibility.requiresPrepayment;
  const requiresReferral = !!eligibility.requiresReferral;
  const requiresMultiHome = !!eligibility.requiresMultiHome;
  const requiresWaveGuardTier = !!eligibility.requiresWaveGuardTier;
  const requiresCustomerStatus = !!(
    eligibility.requiresMilitary ||
    eligibility.requiresSenior ||
    eligibility.requiresNewCustomer
  );
  const requiresAny = requiresPrepay || requiresReferral || requiresMultiHome
    || requiresCustomerStatus || requiresWaveGuardTier;

  if (requiresPrepay && !annualPrepay) add('manual_discount_requires_prepay');
  if (requiresReferral) add('manual_discount_requires_referral');
  if (requiresMultiHome) add('manual_discount_requires_multi_home');
  if (requiresCustomerStatus) add('manual_discount_requires_customer_status');
  if (requiresWaveGuardTier) add('manual_discount_requires_waveguard_tier');
  if (requiresAny && !confirmed) add('manual_discount_eligibility_not_confirmed');

  return uniqueStrings(warnings);
}

function assertManualDiscountEligibility(md = {}, input = {}) {
  const warnings = manualDiscountEligibilityWarnings(md, input);
  const requiresConfirmation = warnings.includes('manual_discount_eligibility_not_confirmed');
  if (requiresConfirmation) {
    const err = new Error('Manual discount eligibility must be confirmed before applying this discount');
    err.code = 'MANUAL_DISCOUNT_ELIGIBILITY_REQUIRED';
    err.warnings = warnings;
    throw err;
  }
  return warnings;
}

function normalizeCommercialFlag(value) {
  if (value === true) return true;
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'true' || raw === 'yes' || raw === 'commercial';
}

function hasCommercialFlagInput(value) {
  if (value === true || value === false) return true;
  return String(value ?? '').trim() !== '';
}

function commercialSubtypeFromInput(input = {}, services = {}) {
  return input.commercialSubtype ||
    input.commercial_subtype ||
    services.commercialPest?.commercialSubtype ||
    services.commercialLawn?.commercialSubtype ||
    services.pest?.commercialSubtype ||
    services.lawn?.commercialSubtype ||
    null;
}

function normalizeMosquitoProgram(value) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'seasonal9' || raw === 'monthly12') return raw;
  if (raw === 'seasonal') return 'seasonal9';
  if (raw === 'monthly') return 'monthly12';
  if (raw === 'residual_seasonal' || raw === 'scion_seasonal' || raw === 'upgraded_seasonal' || raw === 'upgrade_seasonal') return 'seasonal9';
  if (raw === 'residual_monthly' || raw === 'scion_monthly' || raw === 'scion' || raw === 'upgraded' || raw === 'upgrade') return 'monthly12';
  // Migration shim only: older saved estimate inputs may still contain the
  // retired mosquito tier names. Do not expose these as product options.
  if (raw === 'bronze') return 'seasonal9';
  if (raw === 'silver' || raw === 'gold' || raw === 'platinum') return 'monthly12';
  return raw;
}

function shouldIncludeInternalPricing(input = {}, serviceOptions = {}) {
  return !!(
    input.includeInternalPricing ||
    input.debugPricing ||
    serviceOptions.includeInternalPricing ||
    serviceOptions.debug ||
    serviceOptions.isInternal ||
    serviceOptions.admin ||
    serviceOptions.isAdmin
  );
}

function stripBedBugInternalPricing(result) {
  if (!result || result.service !== 'bed_bug') return result;
  const clean = { ...result };
  delete clean.directCostEstimate;
  delete clean.costRatio;
  delete clean.actualCostRatio;
  delete clean.estimatedGrossMargin;
  delete clean.pricingModel;
  delete clean.targetCostRatio;
  delete clean.internalCostBasis;

  clean.treatmentLines = (result.treatmentLines || []).map((line) => {
    const {
      directCostEstimate,
      costRatio,
      actualCostRatio,
      estimatedGrossMargin,
      ...publicLine
    } = line;
    return publicLine;
  });

  return clean;
}

// ── Generate Complete Estimate ────────────────────────────────
function generateEstimate(input) {
  const services = input.services || {};
  const commercialSubtype = commercialSubtypeFromInput(input, services);
  const hasExplicitCommercialFlag = hasCommercialFlagInput(input.isCommercial);
  const inputIsCommercial = normalizeCommercialFlag(input.isCommercial);
  const commercialContext = {
    services,
    isCommercial: hasExplicitCommercialFlag ? inputIsCommercial : undefined,
    propertyType: input.propertyType,
    category: input.category,
    commercialSubtype,
  };
  const profileCommercialDetectionProperty = {
    propertyType: input.propertyType,
    category: input.category,
    isCommercial: hasExplicitCommercialFlag ? inputIsCommercial : input.isCommercial,
    commercialSubtype,
  };
  const profileIsCommercial = isCommercialProperty(profileCommercialDetectionProperty, commercialContext);

  // ── 1. Calculate property profile ──────────────────────────
  const propertyTypeForProfile = profileIsCommercial ? 'commercial' : input.propertyType;
  const property = calculatePropertyProfile({
    homeSqFt: input.homeSqFt,
    stories: input.stories,
    storiesSource: input.storiesSource,
    lotSqFt: input.lotSqFt,
    footprintSqFt: input.footprintSqFt ?? input.footprint,
    perimeterLF: input.perimeterLF ?? input.perimeterLf ?? input.perimeter,
    buildingSqFt: input.buildingSqFt,
    livingAreaSqFt: input.livingAreaSqFt,
    lawnSqFt: input.lawnSqFt,
    measuredTurfSf: input.measuredTurfSf,
    estimatedTurfSf: input.estimatedTurfSf,
    imperviousSurfacePercent: input.imperviousSurfacePercent,
    imperviosSurfacePercent: input.imperviosSurfacePercent,
    estimatedBedAreaSf: input.estimatedBedAreaSf,
    estimatedBedArea: input.estimatedBedArea,
    estimatedBedAreaPercent: input.estimatedBedAreaPercent,
    bedArea: input.bedArea,
    bedAreaSource: input.bedAreaSource,
    palmCount: input.palmCount,
    palmInventory: input.palmInventory,
    propertyType: propertyTypeForProfile,
    pool: input.pool,
    hasPool: input.hasPool,
    poolCage: input.poolCage,
    hasPoolCage: input.hasPoolCage,
    poolCageSize: input.poolCageSize,
    hasLargeDriveway: input.hasLargeDriveway,
    largeDriveway: input.largeDriveway,
    shrubDensity: input.shrubDensity,
    treeDensity: input.treeDensity,
    landscapeComplexity: input.landscapeComplexity,
    features: input.features || {},
    // v2 enriched fields (optional — null-safe)
    yearBuilt: input.yearBuilt,
    constructionMaterial: input.constructionMaterial,
    foundationType: input.foundationType,
    roofType: input.roofType,
    nearWater: input.nearWater,
    waterDistance: input.waterDistance,
    isHOA: input.isHOA,
    hoaFee: input.hoaFee,
    isRental: input.isRental,
    isNewHomeowner: input.isNewHomeowner,
    fenceType: input.fenceType,
    outbuildingCount: input.outbuildingCount,
    attachedGarage: input.attachedGarage,
    maintenanceCondition: input.maintenanceCondition,
    overallPestPressure: input.overallPestPressure,
    atticSqFt: input.atticSqFt,
    atticAreaSqFt: input.atticAreaSqFt,
    rawWoodSqFt: input.rawWoodSqFt,
    woodTreatmentSqFt: input.woodTreatmentSqFt,
    slabSqFt: input.slabSqFt,
    foundationSqFt: input.foundationSqFt,
    buildingSlabSqFt: input.buildingSlabSqFt,
    newConstructionSlabSqFt: input.newConstructionSlabSqFt,
  });

  // ── 2. Derive property-driven pricing modifiers (v2 port) ─
  const modifiers = deriveModifiers(property);
  const structuralNotes = deriveNotes(property);

  // ── 3. Price each requested service ────────────────────────
  const lineItems = [];
  const activeServiceKeys = [];
  const inputPricingMetadata = input.pricingMetadata || {};
  const pricingMetadata = {
    warnings: uniqueStrings(inputPricingMetadata.warnings),
    manualReviewReasons: uniqueStrings(inputPricingMetadata.manualReviewReasons),
    skippedServices: Array.isArray(inputPricingMetadata.skippedServices)
      ? [...inputPricingMetadata.skippedServices]
      : [],
    ...(inputPricingMetadata.skippedDuplicateRoachLine
      ? {
          skippedDuplicateRoachLine: true,
          skippedService: inputPricingMetadata.skippedService,
          skippedReason: inputPricingMetadata.skippedReason,
        }
      : {}),
  };
  const addManualReviewReason = (reason) => {
    pricingMetadata.manualReviewReasons = uniqueStrings([...pricingMetadata.manualReviewReasons, reason]);
  };
  const addRoutingWarning = (warning) => {
    pricingMetadata.warnings = uniqueStrings([...pricingMetadata.warnings, warning]);
  };
  const addSkippedService = (skipped) => {
    if (!skipped) return;
    const exists = pricingMetadata.skippedServices.some((item) => (
      item.skippedService === skipped.skippedService &&
      item.skippedReason === skipped.skippedReason
    ));
    if (!exists) pricingMetadata.skippedServices.push(skipped);
    if (skipped.skippedDuplicateRoachLine) {
      pricingMetadata.skippedDuplicateRoachLine = true;
      pricingMetadata.skippedService = skipped.skippedService;
      pricingMetadata.skippedReason = skipped.skippedReason;
    }
  };
  let recurringPestRoachType = 'none';
  if (profileIsCommercial) property.isCommercial = true;
  else if (hasExplicitCommercialFlag) property.isCommercial = inputIsCommercial;
  if (commercialSubtype) property.commercialSubtype = commercialSubtype;
  const propertyForCommercialDetection = { ...property };
  if (input.propertyType === undefined || input.propertyType === null || input.propertyType === '') {
    delete propertyForCommercialDetection.propertyType;
  }
  const propertyIsCommercial = profileIsCommercial || isCommercialProperty(propertyForCommercialDetection, commercialContext);
  const addCommercialManualQuote = (service) => {
    const result = buildCommercialManualQuoteResult(service, property, { commercialSubtype });
    if (!lineItems.some((line) => line.service === result.service)) {
      lineItems.push(result);
    }
  };
  const useCommercialManualQuote = (selected, service = 'pest_control') => {
    if (!selected) return false;
    if (!propertyIsCommercial) return false;
    addCommercialManualQuote(service);
    return true;
  };

  // Pest Control
  if (services.pest || serviceSelected(services.commercialPest)) {
    if (propertyIsCommercial) {
      // Commercial pest has no residential fallback. The small-commercial pilot
      // pricer auto-prices quarterly GPC off building sqft when the service opts
      // in via `commercialPricingMode: 'small_commercial_pilot'`; otherwise (or
      // when the pilot declines — disabled, no sqft, or above its ceiling) the
      // line falls back to the manual-quote safety gate. The pilot never reaches
      // a customer unreviewed: every pilot line is autoQuoteRequiresAdminApproval.
      const pestOpts = serviceOptions(services.pest);
      const commercialPestOpts = serviceOptions(services.commercialPest);
      const pilotRequested =
        pestOpts.commercialPricingMode === 'small_commercial_pilot' ||
        commercialPestOpts.commercialPricingMode === 'small_commercial_pilot';
      const pilotResult = pilotRequested
        ? priceCommercialPestPilot(property, {
            frequency: pestOpts.frequency || commercialPestOpts.frequency || 'quarterly',
            commercialSubtype,
            // Multi-family / mixed-complex inputs: an explicit per-building list
            // (each { sqft, stories, units }) wins; otherwise the single-building
            // fallback derives from the property profile + these top-level values.
            buildings: pestOpts.buildings || commercialPestOpts.buildings || input.commercialBuildings,
            units: pestOpts.units ?? commercialPestOpts.units ?? input.units,
            stories: pestOpts.stories ?? commercialPestOpts.stories ?? input.stories ?? property.stories,
          })
        : null;
      if (pilotResult) {
        lineItems.push(pilotResult);
      } else {
        addCommercialManualQuote('pest_control');
      }
    } else {
      const result = pricePestControl(property, {
        frequency: services.pest.frequency || 'quarterly',
        pricingVersion: services.pest.version || 'v1',
        roachType: services.pest.roachType || 'none',
        modifiers,
      });
      result.annual = Math.round(result.annual * 100) / 100;
      result.monthly = Math.round(result.annual / 12 * 100) / 100;
      result.perApp = Math.round(result.annual / result.visitsPerYear * 100) / 100;
      if (Array.isArray(result.tiers)) {
        result.tiers = result.tiers.map(t => {
          const annual = Math.round(t.annual * 100) / 100;
          return {
            ...t,
            perApp: Math.round(t.perApp * 100) / 100,
            annual,
            monthly: Math.round(annual / 12 * 100) / 100,
          };
        });
      }
      lineItems.push(result);
      activeServiceKeys.push('pest_control');
      recurringPestRoachType = result.roachType || 'none';

      // Auto-add the one-time Initial Roach Knockdown when recurring pest is
      // booked with a non-none roach type. Recovers the heavier visit-1 cost
      // upfront — replaces the old multiplicative roachModifier (now zeroed)
      // which only paid back if the customer stayed past visit ~3.
      if (result.roachType && result.roachType !== 'none') {
        const pestOptions = serviceOptions(services.pest);
        const initialRoach = pricePestInitialRoach(property, {
          roachType: result.roachType,
          standalone: false,
          autoFiredFromRecurringPest: true,
          source: 'recurring_pest_roach_activity',
          severity: pestOptions.roachSeverity || pestOptions.severity,
          severitySource: pestOptions.roachSeverity || pestOptions.severity ? 'admin' : undefined,
        });
        if (initialRoach) lineItems.push(initialRoach);
      }
    }
  }

  // Lawn Care
  if (services.lawn || serviceSelected(services.commercialLawn)) {
    if (propertyIsCommercial) {
      // PR 1 safety gate: commercial lawn treatment has no residential
      // fallback until the small-commercial pilot pricer is implemented.
      addCommercialManualQuote('lawn_care');
    } else {
      const result = priceLawnCare(property, {
        track: services.lawn.track || 'st_augustine',
        tier: services.lawn.tier || 'enhanced',
        lawnFreq: services.lawn.lawnFreq || input.lawnFreq,
        useLawnCostFloor: services.lawn.useLawnCostFloor ?? input.useLawnCostFloor ?? true,
        targetLawnGrossMargin: services.lawn.targetLawnGrossMargin ?? input.targetLawnGrossMargin,
        routeDriveMinutes: services.lawn.routeDriveMinutes ?? input.routeDriveMinutes,
        lawnMaterialCostPerK: services.lawn.lawnMaterialCostPerK ?? input.lawnMaterialCostPerK,
        lawnLaborMinutesBase: services.lawn.lawnLaborMinutesBase ?? input.lawnLaborMinutesBase,
        lawnLaborMinutesPerK: services.lawn.lawnLaborMinutesPerK ?? input.lawnLaborMinutesPerK,
      });
      lineItems.push(result);
      activeServiceKeys.push('lawn_care');
    }
  }

  // Tree & Shrub
  if (services.treeShrub && !useCommercialManualQuote(services.treeShrub, 'lawn_care')) {
    const result = priceTreeShrub(property, {
      tier: services.treeShrub.tier,
      access: services.treeShrub.access || 'easy',
      // No synthetic 0 here: pass the service-line override through and let
      // priceTreeShrub resolve property.treeCount / features.treeCount, then
      // fall back to the treeDensity estimate when no count exists at all
      // (v4.6 — a fabricated 0 would price the per-tree material term away).
      treeCount: services.treeShrub.treeCount,
    });
    result.annual = Math.round(result.annual);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    result.internalPerVisitRevenue = Math.round(result.annual / result.frequency * 100) / 100;
    result.perApp = result.internalPerVisitRevenue;
    lineItems.push(result);
    activeServiceKeys.push('tree_shrub');
  }

  // Palm Injection
  const palmService = services.palmInjection || services.palm;
  if (palmService && !useCommercialManualQuote(palmService, 'lawn_care')) {
    const palmOptions = serviceOptions(palmService);
    const palmCountResolution = resolvePalmCount(property, palmOptions);
    if (!Number.isInteger(palmCountResolution.palmCount) || palmCountResolution.palmCount <= 0) {
      throw buildPalmCountError(palmCountResolution);
    }
    const result = pricePalmInjection(property, {
      ...palmOptions,
      // Do not default palmCount to 1. Service-level count prices the number of
      // palms treated for this line; property-level count is only a resolver fallback.
      palmCount: palmCountResolution.palmCount,
    });
    attachPalmCountMetadata(result, palmCountResolution);
    result.annual = Math.round(result.annual);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    result.annualBeforeCredits = result.annual;
    result.monthlyBeforeCredits = result.monthly;
    lineItems.push(result);
    // Palm does NOT add to activeServiceKeys for tier determination
  }

  // Mosquito
  if (services.mosquito && !useCommercialManualQuote(services.mosquito, 'pest_control')) {
    const result = priceMosquito(property, {
      tier: normalizeMosquitoProgram(services.mosquito.tier || services.mosquito.program),
      modifiers,
      stationCount: services.mosquito.stationCount,
      dunkCount: services.mosquito.dunkCount,
    });
    result.annual = Math.round(result.annual);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    activeServiceKeys.push('mosquito');
  }

  // Termite Bait
  const termiteBaitService = services.termite || services.termiteBait || services.termite_bait;
  if (termiteBaitService && !useCommercialManualQuote(termiteBaitService, 'pest_control')) {
    const termiteOptions = serviceOptions(termiteBaitService);
    const result = priceTermiteBait(property, {
      ...termiteOptions,
      system: termiteOptions.system || 'advance',
      monitoringTier: termiteOptions.monitoringTier || 'basic',
      modifiers,
    });
    result.annual = Math.round(result.annual);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    if (!result.quoteRequired && !result.requiresMeasurement) {
      activeServiceKeys.push('termite_bait');
    }
  }

  // Rodent Bait
  if (services.rodentBait && !useCommercialManualQuote(services.rodentBait, 'pest_control')) {
    const result = priceRodentBait(property, { modifiers });
    result.annual = Math.round(result.annual);
    result.monthly = Math.round(result.annual / 12 * 100) / 100;
    lineItems.push(result);
    // Rodent does NOT add to activeServiceKeys for tier determination
  }

  // ── One-Time Services ──────────────────────────────────────
  // Explicit input.recurringCustomer (v2 vocab) or input.isRecurringCustomer
  // (v1 test vocab) overrides auto-derivation — matches v2 which takes the
  // flag straight from the UI toggle rather than inferring from cart contents.
  // priorQualifyingServices: WaveGuard-qualifying recurring services the
  // customer ALREADY has (passed when an estimate is priced for an existing
  // linked customer). They combine with this estimate's services to determine
  // the WaveGuard tier, and they make the customer a recurring customer for
  // the one-time perk even if this estimate has no recurring line.
  const priorQualifyingServices = Array.isArray(input.priorQualifyingServices)
    ? input.priorQualifyingServices
    : [];
  // A customer with prior qualifying recurring services IS a recurring customer,
  // so prior services force this true even when the form serialized an explicit
  // recurringCustomer:false (e.g. a one-time-only estimate for an existing
  // member still earns the recurring-customer one-time perk). With no prior
  // services, the explicit flag / auto-derivation behave exactly as before.
  const isRecurringCustomer = priorQualifyingServices.length > 0
    ? true
    : input.recurringCustomer !== undefined
      ? !!input.recurringCustomer
      : input.isRecurringCustomer !== undefined
        ? !!input.isRecurringCustomer
        : activeServiceKeys.length > 0;

  // One-time and specialty services are zone-agnostic.
  if (services.oneTimePest) {
    if (propertyIsCommercial) {
      addCommercialManualQuote('pest_control');
    } else {
      const result = priceOneTimePest(property, {
        urgency: services.oneTimePest.urgency || 'NONE',
        afterHours: services.oneTimePest.afterHours || false,
        isRecurringCustomer,
        // Anchor on the QUARTERLY rate (basePrice), never the selected-frequency
        // perApp — a monthly/bimonthly perApp is discounted and would understate
        // the one-time price.
        recurringPestPerApp: services.pest ? lineItems.find(l => l.service === 'pest_control')?.basePrice : null,
        roachType: services.oneTimePest.roachType || 'none',
      });
      lineItems.push(result);
    }
  }

  if (services.oneTimeLawn) {
    if (propertyIsCommercial) {
      addCommercialManualQuote('lawn_care');
    } else {
      const result = priceOneTimeLawn(property, {
        treatmentType: services.oneTimeLawn.treatmentType || 'weed',
        urgency: services.oneTimeLawn.urgency || 'NONE',
        afterHours: services.oneTimeLawn.afterHours || false,
        isRecurringCustomer,
        track: services.oneTimeLawn.track || services.lawn?.track || 'st_augustine',
        tier: services.oneTimeLawn.tier || services.lawn?.tier || 'enhanced',
        lawnFreq: services.oneTimeLawn.lawnFreq || services.lawn?.lawnFreq || input.lawnFreq,
      });
      lineItems.push(result);
    }
  }

  if (services.oneTimeMosquito && !useCommercialManualQuote(services.oneTimeMosquito, 'pest_control')) {
    const result = priceOneTimeMosquito(property, {
      stationCount: services.oneTimeMosquito.stationCount,
      dunkCount: services.oneTimeMosquito.dunkCount,
      isRecurringCustomer,
    });
    lineItems.push(result);
  }

  // Specialty services
  if (services.rodentTrapping && !useCommercialManualQuote(services.rodentTrapping, 'pest_control')) {
    const opts = typeof services.rodentTrapping === 'object' ? services.rodentTrapping : {};
    const result = priceRodentTrapping(property, {
      plan: opts.plan || opts.rodentTrappingPlan,
      pressure: opts.pressure,
      emergency: !!opts.emergency,
      callbacksUsed: opts.callbacksUsed,
      extraCallbackCount: opts.extraCallbackCount,
      upgradeToUnlimited: !!opts.upgradeToUnlimited,
    });
    lineItems.push(result);
  }
  if (services.trenching && !useCommercialManualQuote(services.trenching, 'pest_control')) {
    const result = priceTrenching(property, serviceOptions(services.trenching));
    lineItems.push(result);
  }
  if (services.germanRoach && !useCommercialManualQuote(services.germanRoach, 'pest_control')) {
    const result = priceGermanRoach(property, {
      ...serviceOptions(services.germanRoach),
      source: 'german_roach_cleanout_selected',
    });
    if (recurringPestRoachType === 'german') {
      const reason = 'german_roach_initial_and_cleanout_both_selected';
      const warning = 'German initial knockdown and German Roach Cleanout are both selected. Verify this is intentional.';
      result.requiresManualReview = true;
      result.manualReviewReasons = uniqueStrings([...(result.manualReviewReasons || []), reason]);
      result.warnings = uniqueStrings([...(result.warnings || []), warning]);
      addManualReviewReason(reason);
      addRoutingWarning(warning);
    }
    lineItems.push(result);
  }
  // Standalone Initial Roach Knockdown — fires when the customer wants the
  // single-visit knockdown without recurring pest. Priced higher than the
  // recurring auto-fire above (no future visits to amortize visit-1 burden
  // across) via the regular_standalone scale in constants.PEST.pestInitialRoach.
  // Translator skips this when recurring pest already auto-fires the same
  // knockdown via roachModifier, so no double-charge.
  if (services.pestInitialRoach && !useCommercialManualQuote(services.pestInitialRoach, 'pest_control')) {
    const pestInitialRoachOptions = serviceOptions(services.pestInitialRoach);
    const standaloneRoachMeta = normalizeRoachType(pestInitialRoachOptions.roachType || 'regular');
    if (recurringPestRoachType === 'regular' && standaloneRoachMeta.roachType === 'regular') {
      addSkippedService({
        skippedDuplicateRoachLine: true,
        skippedService: 'standalone_native_cockroach_treatment',
        skippedReason: 'recurring_pest_initial_roach_already_covers_regular_roach',
      });
    } else {
      const result = pricePestInitialRoach(property, {
        ...pestInitialRoachOptions,
        roachType: standaloneRoachMeta.roachType,
        standalone: true,
        source: pestInitialRoachOptions.source || 'standalone_native_cockroach_treatment',
      });
      if (result) lineItems.push(result);
    }
  }
  // Legacy explicit service for old callers. The current v2 adapter relies on
  // the recurring pest auto-fire above (`pest_initial_roach`) and does not
  // inject this line, which prevents duplicate German roach first-visit fees.
  if (services.germanRoachInitial && !useCommercialManualQuote(services.germanRoachInitial, 'pest_control')) {
    const opts = typeof services.germanRoachInitial === 'object'
      ? services.germanRoachInitial
      : {};
    const result = priceGermanRoachInitial({
      urgency: opts.urgency || 'NONE',
      afterHours: !!opts.afterHours,
      isRecurringCustomer: !!opts.isRecurringCustomer,
    });
    lineItems.push(result);
  }
  const boraCareService = services.boraCare || services.bora_care;
  if (boraCareService && !useCommercialManualQuote(boraCareService, 'pest_control')) {
    const boraCareOptions = serviceOptions(boraCareService);
    // Surface-treatment measurements may arrive via service options (route path)
    // or at the top level of the estimate input (direct generateEstimate
    // callers). The property profile does not carry them, so merge the top-level
    // fields into the options the engine reads. Legacy wall* keys still accepted.
    const result = priceBoraCare(property, {
      ...boraCareOptions,
      surfaceLinearFt: boraCareOptions.surfaceLinearFt ?? boraCareOptions.wallLinearFt
        ?? input.boraCareSurfaceLinearFt ?? input.boraCareWallLinearFt,
      surfaceHeightFt: boraCareOptions.surfaceHeightFt ?? boraCareOptions.wallHeightFt
        ?? input.boraCareSurfaceHeightFt ?? input.boraCareWallHeightFt,
    });
    lineItems.push(result);
  }
  const canonicalPreSlabService = services.preSlabTermiticide || services.pre_slab_termiticide || services.preSlab;
  const legacyPreSlabService = services.preSlabTermidor || services.pre_slab_termidor;
  const preSlabService = canonicalPreSlabService || legacyPreSlabService;
  if (preSlabService && !useCommercialManualQuote(preSlabService, 'pest_control')) {
    const preSlabOptions = serviceOptions(preSlabService);
    const result = legacyPreSlabService && !canonicalPreSlabService
      ? pricePreSlabTermidor(property, preSlabOptions)
      : pricePreSlabTermiticide(property, preSlabOptions);
    lineItems.push(result);
  }
  if (services.bedBug && !useCommercialManualQuote(services.bedBug, 'pest_control')) {
    const bedBugOptions = typeof services.bedBug === 'object' ? services.bedBug : {};
    const includeInternalPricing = shouldIncludeInternalPricing(input, bedBugOptions);
    const result = priceBedBugTreatment(property, {
      ...bedBugOptions,
      urgency: bedBugOptions.urgency ?? input.urgency ?? 'standard',
      afterHours: bedBugOptions.afterHours ?? input.afterHours ?? false,
      includeInternalCostBasis: includeInternalPricing && bedBugOptions.includeInternalCostBasis === true,
      isInternal: includeInternalPricing,
    });
    lineItems.push(includeInternalPricing ? result : stripBedBugInternalPricing(result));
  }
  if (services.wdo && !useCommercialManualQuote(services.wdo, 'pest_control')) {
    const result = priceWDO(property);
    lineItems.push(result);
  }
  if ((services.flea || services.fleaExterior) && !useCommercialManualQuote(services.flea || services.fleaExterior, 'pest_control')) {
    const fleaOptions = typeof services.flea === 'object' && services.flea !== null ? services.flea : {};
    const result = priceFlea({
      ...property,
      services: {
        ...(property.services || {}),
        flea: {
          offerKey: fleaOptions.offerKey ?? fleaOptions.fleaOfferKey ?? services.fleaOfferKey ?? input.fleaOfferKey,
          fleaExterior: fleaOptions.fleaExterior ?? services.fleaExterior ?? input.fleaExterior,
          fleaComplexity: fleaOptions.fleaComplexity ?? services.fleaComplexity ?? input.fleaComplexity,
          exteriorSourceSuspected: fleaOptions.exteriorSourceSuspected ?? services.fleaExteriorSourceSuspected ?? input.fleaExteriorSourceSuspected,
        },
        fleaExterior: fleaOptions.fleaExterior ?? services.fleaExterior ?? input.fleaExterior,
      },
      fleaOfferKey: fleaOptions.offerKey ?? fleaOptions.fleaOfferKey ?? services.fleaOfferKey ?? input.fleaOfferKey,
      fleaComplexity: fleaOptions.fleaComplexity ?? services.fleaComplexity ?? input.fleaComplexity,
      fleaExteriorSourceSuspected: fleaOptions.exteriorSourceSuspected ?? services.fleaExteriorSourceSuspected ?? input.fleaExteriorSourceSuspected,
      fleaExteriorAreaSqFt: fleaOptions.fleaExteriorAreaSqFt ?? services.fleaExteriorAreaSqFt ?? input.fleaExteriorAreaSqFt,
      fleaExteriorAreaSource: fleaOptions.fleaExteriorAreaSource ?? services.fleaExteriorAreaSource ?? input.fleaExteriorAreaSource,
      fleaExteriorZones: fleaOptions.fleaExteriorZones ?? services.fleaExteriorZones ?? input.fleaExteriorZones,
      urgency: fleaOptions.urgency ?? input.urgency ?? 'STANDARD',
      afterHours: fleaOptions.afterHours ?? input.afterHours ?? false,
      isRecurringCustomer,
    });
    lineItems.push(result);
  }
  if (services.topDressing && !useCommercialManualQuote(services.topDressing, 'lawn_care')) {
    const topDressingOptions = serviceOptions(services.topDressing);
    const explicitArea = Math.max(0, Number(topDressingOptions.lawnSqFt) || 0);
    const result = priceTopDressing(
      explicitArea || property.lawnSqFt,
      services.topDressing.depth || 'eighth',
      // An explicit top-dress area (e.g. just the front or back yard) is the
      // exact area to price — pass hasRecurringLawn=true so priceTopDressing
      // skips its 0.65 non-recurring reduction and uses the entered area as-is.
      explicitArea > 0 ? true : !!services.lawn
    );
    // Surface the scoped area on the customer-visible row so a partial quote
    // (front/back yard only) reads as such instead of a bare "Top Dressing".
    if (explicitArea > 0) {
      result.detail = `Covers ${Math.round(explicitArea).toLocaleString()} sq ft`;
    }
    lineItems.push(result);
  }
  if (services.dethatching && !useCommercialManualQuote(services.dethatching, 'lawn_care')) {
    const dethatchingOptions = serviceOptions(services.dethatching);
    const result = priceDethatching(
      dethatchingOptions.lawnSqFt || property.lawnSqFt,
      {
        ...dethatchingOptions,
        grassType: dethatchingOptions.grassType
          ?? dethatchingOptions.track
          ?? services.lawn?.track
          ?? input.grassType
          ?? input.track
          ?? property.grassType,
        track: dethatchingOptions.track ?? services.lawn?.track ?? input.track,
        manuallyEnteredLawnSqFt: dethatchingOptions.manuallyEnteredLawnSqFt
          ?? input.measuredTurfSf
          ?? input.lawnSqFt
          ?? null,
      }
    );
    (result.manualReviewReasons || []).forEach(addManualReviewReason);
    (result.warnings || []).forEach(addRoutingWarning);
    lineItems.push(result);
  }
  if (services.plugging && !useCommercialManualQuote(services.plugging, 'lawn_care')) {
    const result = pricePlugging(
      services.plugging.area || property.lawnSqFt,
      services.plugging.spacing || 12,
      {
        urgency: services.plugging.urgency || 'ROUTINE',
        afterHours: services.plugging.afterHours || false,
      }
    );
    lineItems.push(result);
  }
  if (services.foam && !useCommercialManualQuote(services.foam, 'pest_control')) {
    const foamOptions = typeof services.foam === 'object' && services.foam !== null
      ? services.foam
      : {};
    const result = priceFoamDrill(Object.prototype.hasOwnProperty.call(foamOptions, 'points') ? foamOptions.points : undefined, {
      urgency: foamOptions.urgency || 'ROUTINE',
      afterHours: foamOptions.afterHours || false,
    });
    lineItems.push(result);
  }
  // Recurring spot-foam termite program. Standalone recurring line: priced by
  // cadence multiplier, NOT added to activeServiceKeys (no WaveGuard tier) and
  // excluded from the bundle % discount via WAVEGUARD.excludedFromPercentDiscount.
  // Owner directive (2026-06-25): unlike other commercial services (which route
  // to a manual quote via the safety gate), recurring foam is auto-priced at the
  // cadence rate for commercial too — the feature was requested by commercial
  // clients, so it bypasses useCommercialManualQuote intentionally.
  const foamRecurringService = services.foamRecurring || services.foam_recurring;
  if (foamRecurringService) {
    const foamRecOptions = serviceOptions(foamRecurringService);
    const result = priceRecurringFoam(
      Object.prototype.hasOwnProperty.call(foamRecOptions, 'points') ? foamRecOptions.points : undefined,
      { cadence: foamRecOptions.cadence || foamRecOptions.frequency },
    );
    lineItems.push(result);
    // foam_recurring does NOT add to activeServiceKeys for tier determination
  }
  if (services.stinging && !useCommercialManualQuote(services.stinging, 'pest_control')) {
    const result = priceStingingInsect({
      species: services.stinging.species || 'PAPER_WASP',
      tier: services.stinging.tier || 2,
      removal: services.stinging.removal || 'NONE',
      aggressive: services.stinging.aggressive || 'NO',
      height: services.stinging.height || 'GROUND',
      confined: services.stinging.confined || 'NO',
      urgency: services.stinging.urgency || 'ROUTINE',
      afterHours: services.stinging.afterHours || false,
      hasRecurringPest: activeServiceKeys.includes('pest_control'),
    });
    lineItems.push(result);
  }
  if (services.exclusion && !useCommercialManualQuote(services.exclusion, 'pest_control')) {
    const hasRodentServiceOptIn = !!(
      services.rodentTrapping || services.sanitation
    );
    const isV2 = services.exclusion.pricingVersion === 'v2';
    if (isV2) {
      const result = priceRodentExclusionV2({
        standardWireMeshPoints: services.exclusion.standardWireMeshPoints || 0,
        advancedWireMeshPoints: services.exclusion.advancedWireMeshPoints || 0,
        standardBirdBoxes: services.exclusion.standardBirdBoxes || 0,
        tileHighBirdBoxes: services.exclusion.tileHighBirdBoxes || 0,
        customBirdBoxes: services.exclusion.customBirdBoxes || 0,
        meshSoftLF: services.exclusion.meshSoftLF || 0,
        meshConcreteLF: services.exclusion.meshConcreteLF || 0,
        waiveInspection: services.exclusion.waiveInspection || false,
        hasServiceOptIn: hasRodentServiceOptIn,
        approvedTotalForWaiver: services.exclusion.approvedTotal || 0,
        urgency: services.exclusion.urgency || 'ROUTINE',
        afterHours: services.exclusion.afterHours || false,
      });
      lineItems.push(result);
    } else {
      const result = priceExclusion({
        simple: services.exclusion.simple || 0,
        moderate: services.exclusion.moderate || 0,
        advanced: services.exclusion.advanced || 0,
        specialty: services.exclusion.specialty || 0,
        specialtyCustomTotal: services.exclusion.specialtyCustomTotal || 0,
        homeSqFt: services.exclusion.homeSqFt || property.footprint || 2000,
        stories: services.exclusion.stories || property.stories || 1,
        roofType: services.exclusion.roofType || property.roofType || 'shingle',
        constructionType: services.exclusion.constructionType
          || property.constructionMaterial || 'block',
        waiveInspection: services.exclusion.waiveInspection || false,
        hasServiceOptIn: hasRodentServiceOptIn,
        approvedTotalForWaiver: services.exclusion.approvedTotal || 0,
        urgency: services.exclusion.urgency || 'ROUTINE',
        afterHours: services.exclusion.afterHours || false,
      });
      lineItems.push(result);
    }
  }

  // Legacy separate wire mesh / bird box line items — skipped when V2
  // exclusion is active (V2 folds these into the unified calculation).
  const exclusionIsV2 = services.exclusion?.pricingVersion === 'v2';

  if (services.rodentWireMesh && !exclusionIsV2 && !useCommercialManualQuote(services.rodentWireMesh, 'pest_control')) {
    const opts = typeof services.rodentWireMesh === 'object' ? services.rodentWireMesh : {};
    lineItems.push(priceRodentWireMesh({
      meshLinearFeet: opts.meshLinearFeet,
      meshSubstrate: opts.meshSubstrate,
      measuredOrEstimated: opts.measuredOrEstimated || opts.meshMeasuredOrEstimated,
      storyMult: opts.storyMult,
      roofMult: opts.roofMult,
      constructionMult: opts.constructionMult,
    }));
  }

  if (services.rodentBirdBoxes && !exclusionIsV2 && !useCommercialManualQuote(services.rodentBirdBoxes, 'pest_control')) {
    const opts = typeof services.rodentBirdBoxes === 'object' ? services.rodentBirdBoxes : {};
    const result = priceRodentBirdBoxes({
      birdBoxType: opts.birdBoxType,
      birdBoxQuantity: opts.birdBoxQuantity,
    });
    if (result) lineItems.push(result);
  }

  // Rodent sanitation (bleach + wipe; tier = light/standard/heavy)
  // Legacy 'medium' resolves to 'standard' inside priceSanitation.
  if (services.sanitation && !useCommercialManualQuote(services.sanitation, 'pest_control')) {
    const result = priceSanitation({
      tier: services.sanitation.tier || 'standard',
      affectedSqFt: services.sanitation.affectedSqFt
        || services.sanitation.atticSqFt
        || property.footprint || 0,
      insulationRemovalCuFt: services.sanitation.insulationRemovalCuFt || 0,
      accessType: services.sanitation.accessType || 'normal',
    });
    lineItems.push(result);
  }

  // Legacy explicit trap-check rows are included during the active window.
  if (services.rodentTrappingFollowups && !useCommercialManualQuote(services.rodentTrappingFollowups, 'pest_control')) {
    const followupOptions = typeof services.rodentTrappingFollowups === 'object'
      ? services.rodentTrappingFollowups
      : {};
    const count = typeof services.rodentTrappingFollowups === 'number'
      ? services.rodentTrappingFollowups
      : (followupOptions.count || 0);
    const result = priceRodentTrappingFollowups(count, followupOptions);
    if (result) lineItems.push(result);
  }

  // Standalone rodent inspection (paid diagnostic, creditable)
  if (services.rodentInspection && !useCommercialManualQuote(services.rodentInspection, 'pest_control')) {
    lineItems.push(priceRodentInspection());
  }

  if (services.trapOnlyRetainer && !useCommercialManualQuote(services.trapOnlyRetainer, 'pest_control')) {
    const opts = typeof services.trapOnlyRetainer === 'object' ? services.trapOnlyRetainer : {};
    lineItems.push(priceTrapOnlyRetainer(opts));
  }

  // Bait station setup fee — waived when any recurring plan is on the
  // estimate; only fires if explicitly forced or no recurring services.
  if (services.rodentBait && !propertyIsCommercial) {
    const hasAnyRecurring = !!(
      services.pest || services.lawn || services.treeShrub ||
      services.mosquito || services.termiteBait || services.rodentBait ||
      palmService
    );
    const setup = priceBaitSetup({
      waived: hasAnyRecurring && !services.rodentBaitSetupForce,
    });
    if (setup.price > 0) lineItems.push(setup);
  }

  // ── Rodent bundle discount ──────────────────────────────────
  // Apply bundle discount when 2+ rodent service categories are present.
  // Replaces the old "auto-fire $199 guarantee on any trap+exclusion" behavior.
  // Adjusts the trap/exclusion/sanitation line item prices in-place to reflect
  // the bundled total, with savings tracked in the bundle line item.
  if (!propertyIsCommercial) {
    const trapItem = lineItems.find(i => i.service === 'rodent_trapping');
    const exclItem = lineItems.find(i => i.service === 'exclusion');
    const sanItem = lineItems.find(i => i.service === 'rodent_sanitation');
    const bundle = selectRodentBundle({
      hasTrapping: !!trapItem,
      hasExclusion: !!exclItem,
      hasSanitation: !!sanItem,
      sanitationTier: sanItem?.tier,
    });
    if (bundle) {
      const componentTotal = (trapItem?.price || 0) + (exclItem?.price || 0) + (sanItem?.price || 0);
      const { discounted, savings } = applyRodentBundle(componentTotal, bundle);
      if (savings > 0) {
        lineItems.push({
          service: 'rodent_bundle_discount',
          name: `Rodent ${bundle.kind} bundle`,
          price: -savings,
          bundleKind: bundle.kind,
          discount: bundle.discount,
          floor: bundle.floor,
          bundledTotal: discounted,
          componentTotal,
          detail: `${bundle.kind} bundle: $${componentTotal} → $${discounted} (saves $${savings})`,
        });
      }
    }
  }

  // Rodent guarantee — gated. Caller must pass eligibility flags explicitly;
  // we no longer auto-fire on any trap + exclusion presence. Caller signals
  // intent by setting services.rodentGuarantee = { eligibility: {...} }.
  if (services.rodentGuarantee && !useCommercialManualQuote(services.rodentGuarantee, 'pest_control')) {
    const opts = typeof services.rodentGuarantee === 'object' ? services.rodentGuarantee : {};
    const exclusionResult = lineItems.find(li => li.service === 'rodent_exclusion' || li.service === 'exclusion');
    const guaranteeOpts = {
      homeSqFt: opts.homeSqFt || property.footprint || 2000,
      stories: opts.stories || property.stories || 1,
      roofType: opts.roofType || property.roofType || 'shingle',
      eligibility: opts.eligibility || {},
    };
    if (exclusionResult?.pricingVersion === 'RODENT_EXCLUSION_V2_MESH_BIRD_BOX') {
      guaranteeOpts.equivalentExclusionPoints = exclusionResult.equivalentExclusionPoints || 0;
      guaranteeOpts.totalLinearMeshLF = exclusionResult.quantities?.totalLinearMeshLF || 0;
    } else {
      guaranteeOpts.sealedPoints = opts.sealedPoints || (
        (services.exclusion?.simple || 0)
        + (services.exclusion?.moderate || 0)
        + (services.exclusion?.advanced || 0)
        + (services.exclusion?.specialty || 0)
      );
    }
    const result = priceRodentGuarantee(guaranteeOpts);
    if (result.eligible) lineItems.push(result);
  }

  // ── Spec-version services (v2 missing-services spec, Apr 2026) ──
  if (services.rodentPlugging && !useCommercialManualQuote(services.rodentPlugging, 'pest_control')) {
    const result = calculatePluggingPrice(services.rodentPlugging);
    lineItems.push(result);
  }
  if (services.termiteFoam && !useCommercialManualQuote(services.termiteFoam, 'pest_control')) {
    const result = calculateFoamPrice(services.termiteFoam);
    lineItems.push(result);
  }
  if (services.stingingV2 && !useCommercialManualQuote(services.stingingV2, 'pest_control')) {
    const result = calculateStingingPrice(services.stingingV2);
    lineItems.push(result);
  }
  if (services.exclusionV2 && !useCommercialManualQuote(services.exclusionV2, 'pest_control')) {
    const result = calculateExclusionPrice({
      sqft: services.exclusionV2.sqft || property.footprint,
      stories: services.exclusionV2.stories || property.stories,
      roofType: services.exclusionV2.roofType || property.roofType,
      entryPointsFound: services.exclusionV2.entryPointsFound,
      includesScreening: services.exclusionV2.includesScreening,
      constructionType: services.exclusionV2.constructionType || property.constructionMaterial,
    });
    lineItems.push(result);
  }
  if (services.rodentGuaranteeCombo && !useCommercialManualQuote(services.rodentGuaranteeCombo, 'pest_control')) {
    const result = calculateRodentGuaranteeCombo({
      sqft: services.rodentGuaranteeCombo.sqft || property.footprint,
      stories: services.rodentGuaranteeCombo.stories || property.stories,
      roofType: services.rodentGuaranteeCombo.roofType || property.roofType,
      entryPointsFound: services.rodentGuaranteeCombo.entryPointsFound,
      includesScreening: services.rodentGuaranteeCombo.includesScreening,
      constructionType: services.rodentGuaranteeCombo.constructionType || property.constructionMaterial,
      baitStationTier: services.rodentGuaranteeCombo.baitStationTier,
      stationCount: services.rodentGuaranteeCombo.stationCount,
      guaranteeTerm: services.rodentGuaranteeCombo.guaranteeTerm || 12,
    });
    lineItems.push(result);
  }

  // ── 4. Determine WaveGuard tier ────────────────────────────
  // Combine this estimate's services with any prior qualifying services the
  // existing customer already holds, deduped by key so a re-quote of a service
  // they already have can't double-count toward the tier. determineWaveGuardTier
  // filters to qualifying services internally, so non-qualifying prior keys are
  // ignored in the count. When there are no prior services the original
  // activeServiceKeys is passed through unchanged, preserving legacy behavior.
  const tierServiceKeys = priorQualifyingServices.length
    ? [...new Set([...activeServiceKeys, ...priorQualifyingServices])]
    : activeServiceKeys;
  const waveGuardTier = determineWaveGuardTier(tierServiceKeys);

  // ── 5. Apply discounts to each line item ───────────────────
  // paymentMethod is no longer a pricing input (ACH discount retired in an
  // earlier session) but is still echoed in the output payload below for
  // downstream card-processing-fee display.
  const paymentMethod = input.paymentMethod || 'card';

  for (const item of lineItems) {
    const serviceKey = resolveDiscountKey(item);
    const isOneTime = !item.annual; // One-time services have .price, not .annual

    if (item.discountHandledByPricingFunction) {
      const rate = Number(item.recurringCustomerDiscountRate || 0);
      item.discount = {
        serviceKey,
        waveGuardTier: waveGuardTier.tier,
        appliedDiscounts: rate > 0 ? [{
          type: 'recurring_customer_one_time_perk',
          amount: rate,
        }] : [],
        effectiveDiscount: rate,
        totalDiscount: rate,
      };
      if (item.price) {
        item.priceBeforeDiscount = item.subtotalBeforeRecurringCustomerDiscount ?? item.price;
        item.priceAfterDiscount = item.price;
      }
      if (item.total) {
        item.totalBeforeDiscount = item.subtotalBeforeRecurringCustomerDiscount ?? item.total;
        item.totalAfterDiscount = item.total;
      }
      continue;
    }

    const discount = getEffectiveDiscount(serviceKey, waveGuardTier, {
      isRecurringCustomer,
      isOneTimeService: isOneTime,
      palmCount: item.palmCount,
      annualBeforeCredits: item.annualBeforeCredits ?? item.annual,
    });

    item.discount = discount;

    if (item.annual) {
      item.annualBeforeDiscount = item.annual;
      const discountedAnnual = applyDiscount(item.annual, discount);
      // AUTO (WaveGuard) discounts are capped at the margin floor for the
      // services that expose a cost basis: Tree & Shrub and Pest Control.
      if (item.service === 'tree_shrub' || item.service === 'pest_control') {
        const guarded = applyMarginGuard(item, discountedAnnual, discount.effectiveDiscount || 0);
        item.preDiscountAnnual = item.annualBeforeDiscount;
        item.requestedDiscountPct = discount.effectiveDiscount || 0;
        item.actualDiscountPct = guarded.actualDiscountPct ?? (
          item.annualBeforeDiscount > 0
            ? Math.round((1 - guarded.finalAnnual / item.annualBeforeDiscount) * 1000) / 1000
            : 0
        );
        item.finalAnnual = guarded.finalAnnual;
        item.finalMonthly = Math.round(guarded.finalAnnual / 12 * 100) / 100;
        item.finalMargin = guarded.finalMargin;
        item.marginGuardApplied = guarded.marginGuardApplied;
        item.discountCapped = guarded.discountCapped;
        if (guarded.minAnnualForMargin !== undefined) {
          item.minAnnualForMargin = guarded.minAnnualForMargin;
        }
        item.annualAfterDiscount = guarded.finalAnnual;
      } else {
        item.annualAfterDiscount = discountedAnnual;
      }
      item.monthlyAfterDiscount = Math.round(item.annualAfterDiscount / 12 * 100) / 100;
      if (serviceKey === 'palm_injection') {
        item.annualBeforeCredits = item.annualBeforeCredits ?? item.annualBeforeDiscount;
        item.flatCreditAnnual = discount.flatCreditAnnual || 0;
        item.annualAfterCredits = item.annualAfterDiscount;
        item.monthlyAfterCredits = Math.round(item.annualAfterCredits / 12 * 100) / 100;
      }
    } else if (item.price) {
      item.priceBeforeDiscount = item.price;
      item.priceAfterDiscount = applyDiscount(item.price, discount);
    } else if (item.total) {
      item.totalBeforeDiscount = item.total;
      item.totalAfterDiscount = applyDiscount(item.total, discount);
    }
  }

  // ── 6. Calculate totals ────────────────────────────────────
  const recurringItems = lineItems.filter(i => i.annual);
  const oneTimeItems = lineItems.filter(i => i.price && !i.annual && !i.total);
  const specialtyItems = lineItems.filter(i => i.total && !i.annual);
  const serviceSpecificDiscounts = applyServiceSpecificCredits(
    lineItems,
    input.serviceSpecificDiscounts || input.serviceSpecificCredits || [],
  );

  const recurringAnnualBefore = recurringItems.reduce((sum, i) => sum + (i.annualBeforeDiscount || 0), 0);
  const recurringAnnualAfterWG = recurringItems.reduce((sum, i) => sum + (i.annualAfterDiscount || i.annual || 0), 0);

  // Manual / custom estimate discount. Applies after WaveGuard to discountable
  // recurring annual services AND to one-time + specialty work (owner directive
  // 2026-06: a manual discount reduces the whole estimate, not just recurring).
  // It still skips palm flat-credit, termite/rodent recurring add-ons, and
  // quote-required / free-service-credit lines.
  let manualDiscountAmount = 0;          // recurring slice (margin logic + recurringAnnualAfter use this)
  let manualDiscountOneTimeAmount = 0;   // one-time slice
  let manualDiscountSpecialtyAmount = 0; // specialty slice
  let manualDiscountInfo = null;
  const manualEligibleItems = recurringItems.filter(isManualRecurringDiscountEligible);
  const manualExcludedItems = recurringItems.filter(i => !isManualRecurringDiscountEligible(i));
  const manualDiscountableRecurringAnnual = manualEligibleItems
    .reduce((sum, i) => sum + (i.annualAfterDiscount || i.annual || 0), 0);
  const manualOneTimeEligibleItems = oneTimeItems.filter(isManualOneTimeDiscountEligible);
  const manualSpecialtyEligibleItems = specialtyItems.filter(isManualOneTimeDiscountEligible);
  const manualDiscountableOneTime = manualOneTimeEligibleItems
    .reduce((sum, i) => sum + manualOneTimeLinePrice(i), 0);
  const manualDiscountableSpecialty = manualSpecialtyEligibleItems
    .reduce((sum, i) => sum + manualOneTimeLinePrice(i), 0);
  const manualDiscountableTotal = roundMoney(
    manualDiscountableRecurringAnnual + manualDiscountableOneTime + manualDiscountableSpecialty,
  );
  const md = input.manualDiscount;
  if (md && Number(md.value) > 0) {
    const v = Number(md.value);
    const manualWarnings = assertManualDiscountEligibility(md, input);
    let requestedAmount;
    if (md.type === 'PERCENT') {
      if (v > 100) throw new Error('Manual percentage discount cannot exceed 100');
      manualDiscountAmount = roundMoney(manualDiscountableRecurringAnnual * (v / 100));
      manualDiscountOneTimeAmount = roundMoney(manualDiscountableOneTime * (v / 100));
      manualDiscountSpecialtyAmount = roundMoney(manualDiscountableSpecialty * (v / 100));
      requestedAmount = roundMoney(manualDiscountableTotal * (v / 100));
    } else {
      // FIXED: one dollar amount spread across the discountable estimate, capped
      // at the discountable total and allocated proportionally so each bucket
      // absorbs its fair share. Specialty takes the rounding remainder.
      requestedAmount = roundMoney(v);
      const applied = Math.min(requestedAmount, manualDiscountableTotal);
      if (manualDiscountableTotal > 0) {
        manualDiscountAmount = roundMoney(applied * (manualDiscountableRecurringAnnual / manualDiscountableTotal));
        manualDiscountOneTimeAmount = roundMoney(applied * (manualDiscountableOneTime / manualDiscountableTotal));
        manualDiscountSpecialtyAmount = roundMoney(applied - manualDiscountAmount - manualDiscountOneTimeAmount);
      }
    }
    const appliedTotal = roundMoney(
      manualDiscountAmount + manualDiscountOneTimeAmount + manualDiscountSpecialtyAmount,
    );
    const nonRecurringAmount = roundMoney(manualDiscountOneTimeAmount + manualDiscountSpecialtyAmount);
    manualDiscountInfo = {
      source: md.source || 'legacy_custom',
      presetId: md.presetId || null,
      presetKey: md.presetKey || null,
      catalogName: md.catalogName || null,
      catalogCategory: md.catalogCategory || null,
      type: md.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      value: v,
      requestedAmount,
      amount: appliedTotal,
      recurringAmount: manualDiscountAmount,
      oneTimeAmount: nonRecurringAmount,
      label: md.label || (md.type === 'PERCENT' ? `Discount (${v}%)` : `Discount -$${v.toFixed(2)}`),
      internalReason: md.internalReason || null,
      eligibility: md.eligibility || null,
      eligibilityConfirmed: md.eligibilityConfirmed === true,
      eligibilityOverrideReason: md.eligibilityOverrideReason || null,
      stack: md.stack || null,
      discountableBase: manualDiscountableTotal,
      recurringDiscountableBase: manualDiscountableRecurringAnnual,
      oneTimeDiscountableBase: roundMoney(manualDiscountableOneTime + manualDiscountableSpecialty),
      capped: requestedAmount > appliedTotal,
      capReason: requestedAmount > appliedTotal ? 'discountable_base' : null,
      scope: nonRecurringAmount > 0 ? 'recurring_and_one_time_after_waveguard' : 'recurring_annual_after_waveguard',
      stackingOrder: 'after_waveguard',
      eligibleServices: [
        ...manualEligibleItems.map(i => resolveDiscountKey(i)),
        ...manualOneTimeEligibleItems.map(i => resolveDiscountKey(i)),
        ...manualSpecialtyEligibleItems.map(i => resolveDiscountKey(i)),
      ],
      excludedServices: manualExcludedItems.map(i => resolveDiscountKey(i)),
      warnings: manualWarnings,
    };
  }

  // Warn-only margin check on the manual discount stack. Manual owner discounts
  // are intentionally NOT capped (loss-leader / goodwill pricing is allowed),
  // but we surface a hard warning + per-line audit when a manual discount drops
  // a guarded service below the margin floor. The manual discount is a single
  // pooled amount, so each line's share is distributed proportionally to its
  // post-WaveGuard annual.
  const manualMarginWarnings = [];
  if (manualDiscountAmount > 0 && manualDiscountableRecurringAnnual > 0) {
    for (const item of manualEligibleItems) {
      const guard = guardedLineCost(item);
      if (!guard || guard.cost < 0) continue;
      const { cost: allInCost, floor: marginFloor } = guard;
      const lineAnnualAfterWG = item.annualAfterDiscount || item.annual || 0;
      if (lineAnnualAfterWG <= 0) continue;
      const lineManualCut = manualDiscountAmount * (lineAnnualAfterWG / manualDiscountableRecurringAnnual);
      const lineFinalAnnual = Math.round((lineAnnualAfterWG - lineManualCut) * 100) / 100;
      const lineMargin = lineFinalAnnual > 0 ? (lineFinalAnnual - allInCost) / lineFinalAnnual : -1;
      if (lineMargin < marginFloor) {
        item.manualMarginWarning = true;
        item.manualFinalAnnual = lineFinalAnnual;
        item.manualFinalMargin = Math.round(lineMargin * 1000) / 1000;
        manualMarginWarnings.push({
          service: item.service,
          type: 'manual_discount_below_margin_floor',
          margin: Math.round(lineMargin * 1000) / 1000,
          marginFloor,
          finalAnnual: lineFinalAnnual,
          annualCost: Math.round(allInCost * 100) / 100,
          manualDiscountShare: Math.round(lineManualCut * 100) / 100,
          message: `${item.service} manual discount drops margin to ${(lineMargin * 100).toFixed(1)}% (below ${(marginFloor * 100).toFixed(0)}% floor)`,
        });
      }
    }
  }

  const recurringAnnualAfter = Math.round((recurringAnnualAfterWG - manualDiscountAmount) * 100) / 100;
  const recurringMonthlyAfter = Math.round(recurringAnnualAfter / 12 * 100) / 100;

  const oneTimeTotalGross = oneTimeItems.reduce((sum, i) => sum + (i.priceAfterDiscount ?? i.price ?? 0), 0);
  const specialtyTotalGross = specialtyItems.reduce((sum, i) => sum + (i.totalAfterDiscount ?? i.total ?? 0), 0);
  const oneTimeTotal = Math.max(0, roundMoney(oneTimeTotalGross - manualDiscountOneTimeAmount));
  const specialtyTotal = Math.max(0, roundMoney(specialtyTotalGross - manualDiscountSpecialtyAmount));

  // Installation costs (termite)
  const installationTotal = recurringItems
    .filter(i => i.installation)
    .reduce((sum, i) => sum + i.installation.price, 0);

  const year1Total = recurringAnnualAfter + oneTimeTotal + specialtyTotal + installationTotal;
  const year2Total = recurringAnnualAfter; // + trenching renewal if applicable
  const trenchingRenewal = lineItems.find(i => (
    i.service === 'trenching' &&
    !i.quoteRequired &&
    !i.requiresMeasurement &&
    Number.isFinite(i.renewal)
  ))?.renewal || 0;
  const year2WithRenewal = year2Total + trenchingRenewal;

  // ── 7. Validate margins ────────────────────────────────────
  const marginWarnings = [
    ...validateEstimateDiscounts(lineItems, waveGuardTier),
    ...manualMarginWarnings,
  ];
  const notes = [];
  const lawnCustomQuoteLine = lineItems.find(i => i.customQuoteFlag);
  if (lawnCustomQuoteLine) {
    notes.push({
      type: 'LAWN_CUSTOM_QUOTE',
      text: 'Turf area exceeds 20,000 sq ft. Pricing was extrapolated and requires field verification/custom quote.',
      priority: 'HIGH',
    });
  }
  const turfPricedServicesSelected = !!(
    services.lawn ||
    services.oneTimeLawn ||
    services.topDressing ||
    services.dethatching ||
    services.plugging
  );

  // ── 8. Build estimate output ───────────────────────────────
  return {
    // Property
    property,

    // WaveGuard
    waveGuard: {
      ...waveGuardTier,
      activeServices: activeServiceKeys,
    },

    // Line items
    lineItems,

    // Summary
    summary: {
      recurringAnnualBeforeDiscount: recurringAnnualBefore,
      recurringAnnualAfterDiscount: recurringAnnualAfter,
      recurringMonthlyAfterDiscount: recurringMonthlyAfter,
      // waveGuardSavings tracks tier-discount only (matches v2 wg.savings).
      // Manual discount surfaced separately via summary.manualDiscount.
      waveGuardSavings: recurringAnnualBefore - recurringAnnualAfterWG,
      manualDiscount: manualDiscountInfo,
      serviceSpecificDiscounts,
      oneTimeTotal,
      specialtyTotal,
      installationTotal,
      year1Total: Math.round(year1Total),
      year2Annual: Math.round(year2WithRenewal),
      year2Monthly: Math.round(year2WithRenewal / 12 * 100) / 100,
    },

    // Payment — a credit card surcharge (up to 2.9%) is added at checkout for credit cards.
    // Debit/prepaid/ACH pay the quoted price with no surcharge.
    paymentMethod,
    cardProcessingFeeRate: 0.029,
    cardProcessingFeeEstimate: Math.round(year1Total * 0.029),
    achSavings: 0,

    // Warnings
    marginWarnings,
    pricingMetadata,
    routingMetadata: pricingMetadata,
    fieldVerify: turfPricedServicesSelected ? Array.from(new Set(property.turfFlags || [])) : [],

    // Property-driven modifiers & structural notes (v2 port)
    modifiers,
    structuralNotes,

    // Metadata
    generatedAt: new Date().toISOString(),
    pricingVersion: 'v4.2',
    notes,
  };
}

// ── Resolve discount key from service result ──────────────────
function resolveDiscountKey(item) {
  if (item.service === 'lawn_care') {
    const tier = item.tier || 'enhanced';
    if (tier === 'enhanced' || tier === 'premium') return `lawn_care_${tier}`;
    return 'lawn_care';
  }
  return item.service;
}

// ── Quick Quote (simplified for common scenarios) ─────────────
function quickQuote(input) {
  const estimate = generateEstimate(input);
  return {
    monthly: estimate.summary.recurringMonthlyAfterDiscount,
    annual: estimate.summary.recurringAnnualAfterDiscount,
    year1: estimate.summary.year1Total,
    tier: estimate.waveGuard.tier,
    savings: estimate.summary.waveGuardSavings,
    services: estimate.lineItems.map(i => ({
      name: i.service,
      monthly: i.monthlyAfterDiscount ?? null,
      price: i.totalAfterDiscount ?? i.total ?? i.priceAfterDiscount ?? i.price ?? null,
    })),
  };
}

module.exports = { generateEstimate, quickQuote };
