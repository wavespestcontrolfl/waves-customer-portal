const CONFIDENCE_RANK = {
  low: 1,
  medium: 2,
  high: 3,
};

const MIN_AUTOMATION_CONFIDENCE = 'medium';
const DEFAULT_HOME_SQFT = 2000;
const DEFAULT_LOT_SQFT = 8000;

const { generateEstimate } = require('./pricing-engine');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return '';
}

function confidenceMeetsMinimum(confidence, minimum = MIN_AUTOMATION_CONFIDENCE) {
  return (CONFIDENCE_RANK[confidence] || 0) >= (CONFIDENCE_RANK[minimum] || 0);
}

function hasConcreteServiceInterest(serviceInterest) {
  const text = firstNonEmpty(serviceInterest).toLowerCase();
  if (!text) return false;
  if (/\bconsultation\b/.test(text)) return false;
  if (/\bnot\s+sure\b/.test(text)) return false;
  if (/\b(other services?|something else)\b/.test(text)) return false;
  return true;
}

function numberOrNull(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(String(value).replace(/,/g, ''));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function normalizedServiceText(serviceInterest) {
  return firstNonEmpty(serviceInterest)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOneTimeServiceText(text) {
  return /\bone time\b/.test(text) || /\bone[- ]?time\b/.test(text);
}

function isRecurringServiceText(text) {
  return /\b(recurring|ongoing|monthly|bi monthly|bimonthly|quarterly|semiannual|semi annual)\b/.test(text);
}

function pestFrequencyFromText(text) {
  if (/\bmonthly\b/.test(text) && !/\bbi monthly\b|\bbimonthly\b/.test(text)) return 'monthly';
  if (/\bbi monthly\b|\bbimonthly\b/.test(text)) return 'bimonthly';
  if (/\bsemiannual\b|\bsemi annual\b/.test(text)) return 'semiannual';
  return 'quarterly';
}

function mapServiceInterestToEstimateServices(serviceInterest) {
  const text = normalizedServiceText(serviceInterest);
  const services = {};
  const review = [];

  if (!text) {
    return { services, supported: false, unsupportedReason: 'missing_service_interest', review };
  }

  const oneTime = isOneTimeServiceText(text);
  const recurring = isRecurringServiceText(text);

  if (/\baeration\b|\bplugging\b|\blawn plug\b|\bcore plug\b/.test(text)) {
    return {
      services,
      supported: false,
      unsupportedReason: 'lawn_aeration_plugging_requires_manual_scope',
      review,
    };
  }

  if (/\bpest\b/.test(text) || /\bant\b/.test(text) || /\bcockroach\b/.test(text) || /\broach\b/.test(text)) {
    if (oneTime) {
      services.oneTimePest = {};
    } else {
      services.pest = { frequency: pestFrequencyFromText(text) };
    }
  }

  if (/\blawn\b|\bfertilization\b|\bweed\b/.test(text)) {
    if (/\bpest\b/.test(text) && !/\blawn pest\b/.test(text)) {
      services.lawn = { track: 'st_augustine', tier: 'enhanced' };
    } else if (/\blawn pest\b/.test(text)) {
      services.lawnPestControl = {};
      review.push('lawn_pest_control_defaulted');
    } else if (oneTime || /\bweed\b/.test(text)) {
      services.oneTimeLawn = { treatmentType: /\bfertilization\b/.test(text) ? 'fertilizer' : 'weed' };
    } else {
      services.lawn = { track: 'st_augustine', tier: 'enhanced' };
    }
  }

  if (/\bmosquito\b/.test(text)) {
    if (oneTime) {
      services.oneTimeMosquito = {};
    } else {
      services.mosquito = { tier: 'monthly12' };
    }
  }

  if (/\btermite\b/.test(text)) {
    if (/\bmonitoring\b|\bprotection\b|\bbait\b/.test(text) || recurring) {
      services.termite = { system: 'advance', monitoringTier: 'basic' };
    } else {
      return {
        services,
        supported: false,
        unsupportedReason: 'termite_treatment_requires_manual_scope',
        review,
      };
    }
  }

  if (/\bflea\b|\btick\b/.test(text)) {
    services.flea = {};
    review.push('flea_treatment_defaulted');
  }

  if (/\bwasp\b|\bhornet\b|\bstinging\b|\bbee\b/.test(text)) {
    services.stinging = { species: 'PAPER_WASP', tier: 2, removal: 'NONE' };
    review.push('stinging_insect_defaults_used');
  }

  if (/\bbed bug\b|\bbedbug\b/.test(text)) {
    services.bedBug = {
      method: 'CHEMICAL',
      rooms: 2,
      severity: 'moderate',
      prepStatus: 'ready',
      occupancyType: 'residential',
    };
    review.push('bed_bug_defaults_used');
  }

  if (/\brodent\b|\brat\b|\bmouse\b|\bmice\b/.test(text)) {
    if (/\bbait\b|\bstation\b/.test(text)) {
      services.rodentBait = {};
    } else {
      return {
        services,
        supported: false,
        unsupportedReason: 'rodent_remediation_requires_manual_scope',
        review,
      };
    }
  }

  const supported = Object.keys(services).length > 0;
  return {
    services,
    supported,
    unsupportedReason: supported ? null : 'service_not_mapped_for_automation',
    review,
  };
}

function buildLeadEngineInput({ intake = {}, customer = {}, body = {}, services = {} } = {}) {
  const homeSqFt = numberOrNull(
    body.homeSqFt,
    body.home_sqft,
    body.squareFootage,
    body.square_footage,
    customer.property_sqft,
    customer.home_sqft
  );
  const lotSqFt = numberOrNull(
    body.lotSqFt,
    body.lot_sqft,
    body.lotSize,
    body.lot_size,
    customer.lot_sqft
  );
  const review = [];
  if (!homeSqFt || !lotSqFt) review.push('property_measurements_defaulted');

  return {
    input: {
      homeSqFt: homeSqFt || DEFAULT_HOME_SQFT,
      lotSqFt: lotSqFt || DEFAULT_LOT_SQFT,
      stories: numberOrNull(body.stories, customer.stories) || 1,
      propertyType: body.propertyType || body.property_type || customer.property_type || 'Single Family',
      category: body.category || null,
      isCommercial: false,
      features: {
        pool: body.pool === true || String(body.pool || '').toLowerCase() === 'yes',
        poolCage: body.poolCage === true || String(body.poolCage || body.pool_cage || '').toLowerCase() === 'yes',
        shrubs: firstNonEmpty(body.shrubDensity, body.shrubs).toLowerCase() || undefined,
        trees: firstNonEmpty(body.treeDensity, body.trees).toLowerCase() || undefined,
        complexity: firstNonEmpty(body.landscapeComplexity, body.complexity).toLowerCase() || undefined,
        nearWater: body.nearWater === true || String(body.nearWater || body.near_water || '').toLowerCase() === 'yes',
      },
      services,
      leadSource: 'lead_webhook',
      address: intake.fullAddress || customer.address || customer.address_line1 || null,
    },
    review,
  };
}

function compactLineItem(item = {}) {
  return {
    service: item.service,
    name: item.name || item.label || item.displayName,
    annual: item.annualAfterDiscount ?? item.annual ?? null,
    monthly: item.monthlyAfterDiscount ?? item.monthly ?? null,
    price: item.priceAfterDiscount ?? item.price ?? null,
    total: item.totalAfterDiscount ?? item.total ?? null,
    perApp: item.perApp ?? null,
    frequency: item.frequency ?? item.visitsPerYear ?? null,
    // Recurring foam carries an operator-chosen cadence + tier labor duration;
    // keep them so accept/render/booking present the sold cadence and reserve a
    // long-enough slot instead of defaulting to quarterly / the generic window.
    cadence: item.cadence ?? null,
    estimatedDurationMinutes: item.estimatedDurationMinutes ?? null,
    quoteRequired: item.quoteRequired || item.requiresManualReview || item.requiresMeasurement || false,
    reason: item.reason || item.manualReviewReason || item.manualReviewReasons?.[0] || null,
  };
}

function lineRequiresReview(line = {}) {
  return !!(
    line.quoteRequired ||
    line.requiresManualReview ||
    line.requiresMeasurement ||
    (Array.isArray(line.manualReviewReasons) && line.manualReviewReasons.length)
  );
}

function buildAutomatedLeadDraftEstimate({ intake = {}, customer = {}, body = {}, readiness = {} } = {}) {
  const serviceInterest = firstNonEmpty(readiness.serviceInterest, intake.serviceInterest, customer.service_interest);
  const mapped = mapServiceInterestToEstimateServices(serviceInterest);
  const automation = {
    status: 'not_generated',
    generated: false,
    source: 'lead_webhook_automation',
    readiness,
    serviceInterest: serviceInterest || null,
    services: mapped.services,
    review: [...(mapped.review || [])],
    unsupportedReason: mapped.unsupportedReason,
  };

  if (!readiness.ready) {
    automation.status = 'blocked';
    return { automation, estimateData: { automation: { leadEstimateAutomation: readiness, draftEstimateAutomation: automation } } };
  }

  if (!mapped.supported) {
    automation.status = 'manual_review_required';
    return { automation, estimateData: { automation: { leadEstimateAutomation: readiness, draftEstimateAutomation: automation } } };
  }

  const engineInput = buildLeadEngineInput({ intake, customer, body, services: mapped.services });
  automation.review.push(...engineInput.review);
  automation.engineInput = engineInput.input;

  try {
    const estimate = generateEstimate(engineInput.input);
    const manualQuoteLines = (estimate?.lineItems || []).filter(lineRequiresReview);
    const quoteRequired = manualQuoteLines.length > 0;
    const monthly = quoteRequired ? 0 : Number(estimate?.summary?.recurringMonthlyAfterDiscount || 0);
    const annual = quoteRequired ? 0 : Number(estimate?.summary?.recurringAnnualAfterDiscount || 0);
    const oneTimeTotal = quoteRequired ? 0 : (
      Number(estimate?.summary?.oneTimeTotal || 0) +
      Number(estimate?.summary?.specialtyTotal || 0)
    );

    automation.status = quoteRequired ? 'manual_review_required' : 'generated';
    automation.generated = !quoteRequired;
    automation.quoteRequired = quoteRequired;
    automation.quoteRequiredReason = manualQuoteLines[0]?.reason || manualQuoteLines[0]?.manualReviewReasons?.[0] || null;

    return {
      automation,
      monthly,
      annual,
      oneTimeTotal,
      quoteRequired,
      estimateData: {
        services: mapped.services,
        monthly,
        annual,
        oneTimeTotal,
        isOneTimeOnly: !monthly && !annual && oneTimeTotal > 0,
        quoteRequired,
        quoteRequiredReason: automation.quoteRequiredReason,
        manualQuoteLines: manualQuoteLines.map(compactLineItem),
        engineResult: {
          summary: estimate?.summary || {},
          lineItems: (estimate?.lineItems || []).map(compactLineItem),
          waveGuard: estimate?.waveGuard || null,
        },
        automation: {
          leadEstimateAutomation: readiness,
          draftEstimateAutomation: automation,
        },
      },
    };
  } catch (error) {
    automation.status = 'generation_failed';
    automation.error = error.message;
    return {
      automation,
      estimateData: {
        automation: {
          leadEstimateAutomation: readiness,
          draftEstimateAutomation: automation,
        },
      },
    };
  }
}

function normalizeAddressPieces({ intake = {}, customer = {} } = {}) {
  const normalizedAddress = intake.normalizedAddress || {};
  const line1 = firstNonEmpty(
    normalizedAddress.line1,
    intake.address,
    customer.address_line1,
    customer.address
  );
  const fullAddress = firstNonEmpty(
    normalizedAddress.fullAddress,
    intake.fullAddress,
    line1
  );
  const city = firstNonEmpty(normalizedAddress.city, customer.city);
  const state = firstNonEmpty(normalizedAddress.state, customer.state);
  const zip = firstNonEmpty(normalizedAddress.zip, customer.zip);
  return { line1, fullAddress, city, state, zip };
}

function evaluateLeadEstimateAutomationReadiness({
  intake = {},
  customer = {},
  phone,
  serviceInterest,
  minimumConfidence = MIN_AUTOMATION_CONFIDENCE,
} = {}) {
  const address = normalizeAddressPieces({ intake, customer });
  const resolvedPhone = firstNonEmpty(phone, intake.rawPhone, customer.phone);
  const resolvedServiceInterest = firstNonEmpty(serviceInterest, intake.serviceInterest, customer.service_interest);
  const missing = [];
  const review = [];

  if (!resolvedPhone) missing.push('phone');
  if (!address.line1 || !/\d/.test(address.line1)) missing.push('street_address');
  if (!hasConcreteServiceInterest(resolvedServiceInterest)) missing.push('specific_service');

  if (!address.city && !address.zip) review.push('city_or_zip_missing');
  if (!firstNonEmpty(intake.email, customer.email)) review.push('email_missing_sms_only');
  if (!numberOrNull(customer.property_sqft, intake.homeSqFt, intake.squareFootage)) {
    review.push('property_measurements_defaulted');
  }

  let confidence = 'high';
  if (review.length > 0) confidence = 'medium';
  if (missing.length > 0) confidence = 'low';

  const ready = missing.length === 0 && confidenceMeetsMinimum(confidence, minimumConfidence);
  const status = ready ? 'ready' : 'blocked';

  return {
    status,
    ready,
    confidence,
    minimumConfidence,
    missing,
    review,
    serviceInterest: resolvedServiceInterest || null,
    address: {
      line1: address.line1 || null,
      city: address.city || null,
      state: address.state || null,
      zip: address.zip || null,
    },
  };
}

function automationNote(readiness) {
  if (!readiness || typeof readiness !== 'object') return 'Automation gate: unavailable.';
  const bits = [
    `Automation gate: ${readiness.status}`,
    `confidence=${readiness.confidence}`,
    `minimum=${readiness.minimumConfidence}`,
  ];
  if (readiness.missing?.length) bits.push(`missing=${readiness.missing.join(',')}`);
  if (readiness.review?.length) bits.push(`review=${readiness.review.join(',')}`);
  return `${bits.join(' | ')}.`;
}

module.exports = {
  MIN_AUTOMATION_CONFIDENCE,
  buildAutomatedLeadDraftEstimate,
  confidenceMeetsMinimum,
  evaluateLeadEstimateAutomationReadiness,
  automationNote,
  hasConcreteServiceInterest,
  mapServiceInterestToEstimateServices,
};
