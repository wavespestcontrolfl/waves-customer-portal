const FLAG_TYPES = new Set([
  'untreated_condition',
  'unsupported_application',
  'preventive_application',
  'follow_up_needed',
]);

const CONFIDENCE_ORDER = {
  unknown: 0,
  low: 1,
  limited: 1,
  moderate: 2,
  medium: 2,
  high: 3,
};

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === '') return [];
  return [value];
}

function unique(values) {
  return Array.from(new Set(asArray(values).map((value) => String(value).trim()).filter(Boolean)));
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function normalizeConfidence(value) {
  const key = normalizeKey(value);
  if (key === 'medium') return 'moderate';
  if (['low', 'moderate', 'high'].includes(key)) return key;
  return 'unknown';
}

function confidenceRank(value) {
  return CONFIDENCE_ORDER[normalizeKey(value)] || 0;
}

function normalizeSeverity(value) {
  const key = normalizeKey(value);
  if (['low', 'minor', 'mild'].includes(key)) return 'mild';
  if (['medium', 'moderate'].includes(key)) return 'moderate';
  if (['high', 'severe'].includes(key)) return 'severe';
  return 'moderate';
}

function normalizeUrgency(value) {
  const key = normalizeKey(value);
  if (['monitor', 'follow_up', 'immediate_callback'].includes(key)) return key;
  return 'monitor';
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function productId(product, index) {
  return String(product.product_id || product.productId || product.id || `P${index + 1}`);
}

function findingId(finding, index) {
  return String(finding.finding_id || finding.findingId || finding.id || `F${index + 1}`);
}

function inferConfirmationStep(finding) {
  const text = `${finding.name || ''} ${finding.primary_finding || ''}`.toLowerCase();
  if (text.includes('chinch')) return 'Float test or cut-and-pull test required to confirm active chinch pressure.';
  if (text.includes('fung') || text.includes('large patch') || text.includes('gray leaf')) {
    return 'Confirm with close-up blade and patch-margin inspection before calling disease active.';
  }
  if (text.includes('drought') || text.includes('irrigation')) return 'Confirm by checking irrigation coverage and soil moisture at the patch margin.';
  return finding.confirmation_step || finding.confirmationStep || '';
}

function normalizeFindings(inputFindings = []) {
  return asArray(inputFindings).map((finding, index) => {
    const id = findingId(finding, index);
    return {
      finding_id: id,
      name: finding.name || finding.primary_finding || finding.primaryFinding || 'Unspecified lawn finding',
      confidence: normalizeConfidence(finding.confidence),
      severity: normalizeSeverity(finding.severity),
      spread_risk: normalizeKey(finding.spread_risk || finding.spreadRisk) || 'unknown',
      estimated_area_affected: finding.estimated_area_affected || finding.estimatedAreaAffected || null,
      urgency: normalizeUrgency(finding.urgency),
      observed_evidence: unique(finding.observed_evidence || finding.observedEvidence || finding.evidence),
      inferred_context: unique(finding.inferred_context || finding.inferredContext),
      negative_evidence: unique(finding.negative_evidence || finding.negativeEvidence),
      confirmation_step: finding.confirmation_step || finding.confirmationStep || inferConfirmationStep(finding),
      customer_wording: finding.customer_wording || finding.customerWording || null,
    };
  });
}

function normalizeProducts(inputProducts = []) {
  return asArray(inputProducts).map((product, index) => ({
    ...product,
    product_id: productId(product, index),
    product_name: product.product_name || product.productName || product.name || `Product ${index + 1}`,
    addresses_findings: unique(product.addresses_findings || product.addressesFindings || product.finding_ids || product.findingIds),
    role: normalizeKey(product.role || product.application_role || product.applicationRole),
  }));
}

function photoQualityRank(quality) {
  const key = normalizeKey(quality);
  if (key === 'adequate' || key === 'good') return 3;
  if (key === 'limited' || key === 'fair') return 2;
  if (key === 'poor' || key === 'bad') return 1;
  return 0;
}

function assessInputSufficiency({ photos = [], products = [], compliance = {}, findings = [] } = {}) {
  const photoRows = asArray(photos);
  const ranks = photoRows.map((photo) => photoQualityRank(photo.quality || photo.photo_quality || photo.status));
  const minRank = ranks.length ? Math.min(...ranks) : 1;
  const photoQuality = minRank >= 3 ? 'adequate' : minRank === 2 ? 'limited' : 'poor';
  const photoLimitations = unique(photoRows.flatMap((photo) => (
    photo.limitations || photo.photo_limitations || photo.missing_views || []
  )));
  const missingInputs = [];

  if (!photoRows.length) missingInputs.push('lawn photos missing');
  if (!findings.length) missingInputs.push('diagnostic findings missing');
  if (!products.length) missingInputs.push('applied products missing');

  const labelMissingProducts = products
    .map((product) => normalizeProductLabelConstraints(product))
    .filter((constraints) => constraints.requires_label_review)
    .map((constraints) => constraints.product_id);
  if (labelMissingProducts.length) {
    missingInputs.push(`product post-application irrigation directive missing for ${labelMissingProducts.join(', ')}`);
  }

  const irrigation = compliance.irrigation_compliance || compliance.irrigationCompliance || compliance.watering_restriction || compliance.wateringRestriction || {};
  if (!asArray(irrigation.assigned_days || irrigation.assignedDays).length) {
    missingInputs.push('assigned irrigation days missing');
  }

  const lowConfidence = findings.some((finding) => confidenceRank(finding.confidence) <= 1);
  const humanReviewRequired = photoQuality !== 'adequate'
    || photoLimitations.length > 0
    || missingInputs.length > 0
    || lowConfidence;
  const humanReviewReason = humanReviewRequired
    ? [
      photoQuality !== 'adequate' ? `Photo quality is ${photoQuality}.` : null,
      photoLimitations.length ? `Photo limitations: ${photoLimitations.join('; ')}.` : null,
      lowConfidence ? 'One or more findings has low diagnostic confidence.' : null,
      missingInputs.length ? `Missing inputs: ${missingInputs.join('; ')}.` : null,
    ].filter(Boolean).join(' ')
    : null;

  return {
    photo_quality: photoQuality,
    photo_limitations: photoLimitations,
    missing_inputs: unique(missingInputs),
    human_review_required: humanReviewRequired,
    human_review_reason: humanReviewReason,
  };
}

function normalizeProductLabelConstraints(product = {}, defaults = {}) {
  const raw = product.product_label_constraints || product.productLabelConstraints || product.label_constraints || product.labelConstraints || {};
  const source = raw.source || product.label_source || product.labelSource || (product.label_verified_at || product.labelVerifiedAt ? 'product_db' : 'missing');
  const postAppIrrigation = raw.post_app_irrigation
    || raw.postAppIrrigation
    || product.post_app_irrigation
    || product.postAppIrrigation
    || null;
  const rainfastHours = numberOrNull(raw.rainfast_hours || raw.rainfastHours || product.rainfast_hours || product.rainfastHours)
    ?? (numberOrNull(product.rainfast_minutes || product.rainfastMinutes) == null ? null : numberOrNull(product.rainfast_minutes || product.rainfastMinutes) / 60);
  const confidence = raw.confidence
    || (source === 'product_db' && postAppIrrigation ? 'db_authoritative' : postAppIrrigation ? 'inferred' : 'missing');
  const requiresLabelReview = raw.requires_label_review === true
    || raw.requiresLabelReview === true
    || confidence !== 'db_authoritative'
    || !postAppIrrigation;

  return {
    product_id: product.product_id || product.productId || product.id || defaults.product_id || null,
    source,
    source_version: raw.source_version || raw.sourceVersion || product.label_verified_at || product.labelVerifiedAt || defaults.source_version || null,
    post_app_irrigation: postAppIrrigation,
    rainfast_hours: rainfastHours,
    mowing_restriction: raw.mowing_restriction || raw.mowingRestriction || product.mowing_restriction || product.mowingRestriction || null,
    reentry_note: raw.reentry_note || raw.reentryNote || product.reentry_text || product.reentryText || product.reentry_note || null,
    confidence,
    requires_label_review: requiresLabelReview,
    customer_guidance: postAppIrrigation && confidence === 'db_authoritative'
      ? postAppIrrigation
      : 'Follow the technician and product label directions; do not treat inferred watering guidance as label-authoritative.',
  };
}

function parseHoldHours(directive) {
  const text = String(directive || '').toLowerCase();
  const compact = text.match(/\bhold\s+(\d+(?:\.\d+)?)\s*h\b/);
  if (compact) return Number(compact[1]);
  const hours = text.match(/\b(?:hold|dry|withhold|avoid)\D{0,24}(\d+(?:\.\d+)?)\s*(?:hour|hr|h)\b/);
  if (hours) return Number(hours[1]);
  const day = text.match(/\b(?:hold|dry|withhold|avoid)\D{0,24}(\d+(?:\.\d+)?)\s*day/);
  if (day) return Number(day[1]) * 24;
  return null;
}

function directiveRequiresWaterIn(directive) {
  return /\bwater[-\s]?in\b|\birrigat(?:e|ion).{0,20}\brequired\b/i.test(String(directive || ''));
}

function joinList(values) {
  const list = unique(values);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

function buildWateringPlan({ products = [], compliance = {} } = {}) {
  const labelConstraints = products.map((product) => normalizeProductLabelConstraints(product, { product_id: product.product_id }));
  const hasLabelReviewGap = labelConstraints.some((constraints) => constraints.requires_label_review);
  const directives = labelConstraints.filter((constraints) => (
    !hasLabelReviewGap
    && constraints.post_app_irrigation
    && constraints.confidence === 'db_authoritative'
    && constraints.requires_label_review !== true
  ));
  const holdHours = directives.map((constraints) => parseHoldHours(constraints.post_app_irrigation)).filter((value) => value != null);
  const maxHoldHours = holdHours.length ? Math.max(...holdHours) : null;
  const hasWaterIn = directives.some((constraints) => directiveRequiresWaterIn(constraints.post_app_irrigation));
  const labelConflict = maxHoldHours != null && hasWaterIn;
  const irrigation = compliance.irrigation_compliance || compliance.irrigationCompliance || compliance.watering_restriction || compliance.wateringRestriction || {};
  const assignedDays = unique(irrigation.assigned_days || irrigation.assignedDays);
  const allowedTimeWindows = unique(irrigation.allowed_time_windows || irrigation.allowedTimeWindows || irrigation.allowed_windows || irrigation.allowedWindows);
  const maxDaysPerWeek = numberOrNull(irrigation.max_days_per_week || irrigation.maxDaysPerWeek);
  const restrictionSummary = irrigation.restriction_summary_customer
    || irrigation.restrictionSummaryCustomer
    || (assignedDays.length || allowedTimeWindows.length
      ? `You may water${assignedDays.length ? ` ${joinList(assignedDays)} only` : ''}${allowedTimeWindows.length ? `, ${joinList(allowedTimeWindows)}` : ''}.`
      : null);

  let directive = 'Use only general low-risk watering guidance until product label constraints are reviewed.';
  if (maxHoldHours != null) {
    directive = `Hold irrigation for ${maxHoldHours} hours after application unless a reviewed label or technician correction says otherwise.`;
  } else if (directives.length) {
    directive = joinList(directives.map((constraints) => constraints.post_app_irrigation));
  }

  const requiresLabelReview = hasLabelReviewGap || labelConflict;
  const customerSequence = requiresLabelReview
    ? 'Return to normal irrigation only after product-specific label directions are reviewed.'
    : (maxHoldHours != null && assignedDays.length
      ? `After the ${maxHoldHours}-hour hold, water only in the assigned ${joinList(assignedDays)} windows, and skip a cycle when rainfall covers the lawn.`
      : restrictionSummary || 'Return to normal irrigation only after product-specific label directions are satisfied.');

  return {
    post_application: {
      directive,
      source_product_ids: directives.map((constraints) => constraints.product_id).filter(Boolean),
      confidence: requiresLabelReview ? 'needs_label_review' : 'db_authoritative',
      requires_label_review: requiresLabelReview,
      conflict: labelConflict,
    },
    ongoing_irrigation: {
      max_days_per_week: maxDaysPerWeek,
      assigned_days: assignedDays,
      allowed_time_windows: allowedTimeWindows,
      restriction_summary_customer: restrictionSummary,
      restriction_is_ceiling_not_target: true,
    },
    customer_sequence: customerSequence,
    product_label_constraints: labelConstraints,
  };
}

function buildDiagnosis(findings = []) {
  const normalized = normalizeFindings(findings);
  const primary = normalized
    .slice()
    .sort((a, b) => {
      const severityScore = { mild: 1, moderate: 2, severe: 3 };
      return (severityScore[b.severity] || 0) - (severityScore[a.severity] || 0)
        || confidenceRank(b.confidence) - confidenceRank(a.confidence);
    })[0] || null;

  return {
    primary_finding: primary ? primary.name : null,
    confidence: primary ? primary.confidence : 'unknown',
    severity: primary ? primary.severity : 'moderate',
    spread_risk: primary ? primary.spread_risk : 'unknown',
    estimated_area_affected: primary ? primary.estimated_area_affected : null,
    urgency: primary ? primary.urgency : 'monitor',
    confirmation_step: primary ? primary.confirmation_step : null,
    findings: normalized,
    negative_evidence: unique(normalized.flatMap((finding) => finding.negative_evidence)),
  };
}

function productRole(product) {
  const text = normalizeKey(`${product.role || ''} ${product.category || ''} ${product.product_type || ''} ${product.productName || ''} ${product.product_name || ''}`);
  if (text.includes('prevent')) return 'preventive';
  if (text.includes('curative') || text.includes('corrective') || text.includes('rescue')) return 'corrective';
  return product.addresses_findings && product.addresses_findings.length ? 'corrective' : 'unclassified';
}

function buildTreatmentRationale({ products = [], findings = [] } = {}) {
  const findingNames = new Map(findings.map((finding) => [finding.finding_id, finding.name]));
  return products.map((product) => {
    const addressesFindings = unique(product.addresses_findings).filter((id) => findingNames.has(id));
    const role = productRole(product);
    return {
      product_id: product.product_id,
      product_name: product.product_name,
      addresses_findings: addressesFindings,
      application_class: role,
      label_constraints: normalizeProductLabelConstraints(product, { product_id: product.product_id }),
      customer_explanation: addressesFindings.length
        ? `Today's lawn treatment addresses ${joinList(addressesFindings.map((id) => findingNames.get(id)))}.`
        : role === 'preventive'
          ? 'This was documented as a preventive lawn application rather than a response to a visible confirmed problem.'
          : 'This application needs technician review before it is tied to a customer-facing finding.',
    };
  });
}

function flagSeverity(finding) {
  if (finding.severity === 'severe' || finding.urgency === 'immediate_callback') return 'high';
  if (finding.severity === 'moderate' || finding.urgency === 'follow_up') return 'medium';
  return 'low';
}

function buildReconciliationFlags({ findings = [], products = [], treatmentRationale = [] } = {}) {
  const flags = [];
  const addressed = new Set(treatmentRationale.flatMap((row) => row.addresses_findings));

  for (const finding of findings) {
    if (!addressed.has(finding.finding_id)) {
      flags.push({
        type: 'untreated_condition',
        severity: flagSeverity(finding),
        finding: finding.name,
        finding_id: finding.finding_id,
        issue: 'Condition shown in the diagnostic findings is not mapped to an applied product today.',
        recommended_action: finding.urgency === 'monitor'
          ? 'Monitor and re-check if the area expands.'
          : 'Schedule follow-up inspection within 7 days.',
        customer_visible: flagSeverity(finding) !== 'low',
        customer_wording: 'We saw one area that may need a second look if it continues to spread.',
      });
    }
    if (finding.urgency === 'follow_up' || finding.urgency === 'immediate_callback') {
      flags.push({
        type: 'follow_up_needed',
        severity: finding.urgency === 'immediate_callback' ? 'high' : 'medium',
        finding: finding.name,
        finding_id: finding.finding_id,
        issue: `Finding urgency is ${finding.urgency}.`,
        recommended_action: finding.urgency === 'immediate_callback'
          ? 'Route for callback review before sending customer report.'
          : 'Create a follow-up watch item.',
        customer_visible: finding.urgency !== 'immediate_callback',
        customer_wording: 'We will keep an eye on this area at the next visit.',
      });
    }
  }

  for (const row of treatmentRationale) {
    if (row.addresses_findings.length) continue;
    const type = row.application_class === 'preventive' ? 'preventive_application' : 'unsupported_application';
    flags.push({
      type,
      severity: type === 'unsupported_application' ? 'medium' : 'low',
      finding: null,
      product_id: row.product_id,
      issue: type === 'preventive_application'
        ? 'Application is preventive and not tied to a visible finding.'
        : 'Applied product is not mapped to a diagnostic finding.',
      recommended_action: type === 'preventive_application'
        ? 'Keep customer wording preventive and do not imply a visible confirmed problem.'
        : 'Technician must connect the application to a finding or mark it internal-only.',
      customer_visible: type === 'preventive_application',
      customer_wording: type === 'preventive_application'
        ? 'Today also included preventive protection as part of the lawn program.'
        : null,
    });
  }

  return flags.filter((flag) => FLAG_TYPES.has(flag.type));
}

function productNutrients(product = {}) {
  return {
    nitrogen: numberOrNull(product.analysis_n || product.nitrogen_pct || product.nitrogenPct || product.n),
    phosphorus: numberOrNull(product.analysis_p || product.phosphorus_pct || product.phosphorusPct || product.p),
  };
}

function fertilizerBlackoutConflicts(products = [], compliance = {}) {
  const blackout = compliance.fertilizer_blackout || compliance.fertilizerBlackout || {};
  if (blackout.active !== true) return [];
  const appliesTo = unique(blackout.applies_to || blackout.appliesTo).map(normalizeKey);
  return products.filter((product) => {
    const nutrients = productNutrients(product);
    return (appliesTo.includes('nitrogen') && nutrients.nitrogen > 0)
      || (appliesTo.includes('phosphorus') && nutrients.phosphorus > 0);
  }).map((product, index) => ({
    product_id: product.product_id || product.productId || product.id || `P${index + 1}`,
    product_name: product.product_name || product.productName || product.name || `Product ${index + 1}`,
    issue: `Fertilizer blackout active for ${joinList(appliesTo)}.`,
  }));
}

function runQaSafetyCheck({ products = [], findings = [], compliance = {}, watering = {}, reconciliationFlags = [] } = {}) {
  const flags = [];
  const labelReviewProducts = products
    .map((product) => normalizeProductLabelConstraints(product, { product_id: product.product_id }))
    .filter((constraints) => constraints.requires_label_review)
    .map((constraints) => constraints.product_id);
  if (labelReviewProducts.length) {
    flags.push({
      type: 'product_label_review_required',
      severity: 'high',
      issue: `Missing or inferred label constraints for ${labelReviewProducts.join(', ')}.`,
    });
  }
  if (watering.post_application?.conflict) {
    flags.push({
      type: 'watering_label_conflict',
      severity: 'high',
      issue: 'Applied products include both hold-irrigation and water-in directives.',
    });
  }
  for (const conflict of fertilizerBlackoutConflicts(products, compliance)) {
    flags.push({
      type: 'fertilizer_blackout_conflict',
      severity: 'high',
      issue: conflict.issue,
      product_id: conflict.product_id,
    });
  }
  if (reconciliationFlags.some((flag) => flag.type === 'unsupported_application')) {
    flags.push({
      type: 'unsupported_application_review',
      severity: 'medium',
      issue: 'One or more products are not mapped to a finding.',
    });
  }
  if (findings.some((finding) => normalizeKey(finding.name).includes('chinch') && confidenceRank(finding.confidence) < 3)) {
    flags.push({
      type: 'photo_confirmation_honesty',
      severity: 'medium',
      issue: 'Chinch pressure cannot be confirmed from photos alone; customer copy must stay suggestive.',
    });
  }
  return flags;
}

function buildExpectations(findings = []) {
  const names = findings.map((finding) => normalizeKey(finding.name)).join(' ');
  return {
    weeds: names.includes('weed') ? 'Visible weed response often takes 10-14 days and may need follow-up depending on weed type.' : null,
    fungus: names.includes('fung') || names.includes('large_patch') ? 'Disease treatments are aimed at stopping spread first; browned turf must regrow over time.' : null,
    insects: names.includes('chinch') || names.includes('insect') ? 'The key sign is whether the damaged edge stops expanding over the next week.' : null,
    turf_recovery: 'Thin or brown turf recovers through new growth, not instant green-up.',
  };
}

function buildWatchItems(findings = [], flags = []) {
  return unique([
    ...findings
      .filter((finding) => finding.urgency !== 'monitor' || finding.severity !== 'mild')
      .map((finding) => `${finding.name}: ${finding.confirmation_step || 'monitor response'}`),
    ...flags
      .filter((flag) => flag.customer_visible)
      .map((flag) => flag.customer_wording),
  ]);
}

function buildCustomerSummary({ diagnosis, treatmentRationale = [] } = {}) {
  const primary = diagnosis.findings?.find((finding) => finding.name === diagnosis.primary_finding);
  if (!primary) return 'Lawn diagnostic is complete. The report needs technician review before customer wording is finalized.';
  const name = primary.name;
  const addressed = treatmentRationale.some((row) => row.addresses_findings.includes(primary.finding_id));
  const treatmentLine = addressed
    ? 'Today\'s treatment was matched to that pressure.'
    : 'We did not map a treatment to that finding today, so it should be watched or re-checked.';
  const lower = name.toLowerCase();
  if (lower.includes('chinch') && confidenceRank(primary.confidence) < 3) {
    return `The pattern is most consistent with chinch pressure, which can look very similar to drought stress. ${treatmentLine} If the patch continues expanding, re-check the margin.`;
  }
  if (confidenceRank(primary.confidence) < 3) {
    return `The photos show signs most consistent with ${name}. ${treatmentLine} We should confirm if the area spreads or the pattern changes.`;
  }
  return `The photos show ${name}. ${treatmentLine} Watch for improvement based on the expected response timeline.`;
}

function buildDiagnosticReportContract(input = {}) {
  const findings = normalizeFindings(input.findings || input.diagnosis?.findings || []);
  const products = normalizeProducts(input.products || input.applied_products || input.appliedProducts || []);
  const compliance = input.compliance || {};
  const inputAssessment = assessInputSufficiency({
    photos: input.photos || input.images || [],
    products,
    compliance,
    findings,
  });
  const diagnosis = buildDiagnosis(findings);
  const treatmentRationale = buildTreatmentRationale({ products, findings });
  const reconciliationFlags = buildReconciliationFlags({ findings, products, treatmentRationale });
  const watering = buildWateringPlan({ products, compliance });
  const internalQualityFlags = runQaSafetyCheck({
    products,
    findings,
    compliance,
    watering,
    reconciliationFlags,
  });
  const humanReviewRequired = inputAssessment.human_review_required
    || internalQualityFlags.some((flag) => ['high', 'medium'].includes(flag.severity))
    || reconciliationFlags.some((flag) => flag.type === 'untreated_condition' && flag.severity !== 'low');

  return {
    input_assessment: inputAssessment,
    diagnosis,
    treatment_rationale: treatmentRationale,
    reconciliation_flags: reconciliationFlags,
    watering,
    seasonal_context: input.seasonal_context || input.seasonalContext || '',
    expectations: buildExpectations(findings),
    watch_items: buildWatchItems(findings, reconciliationFlags),
    customer_summary: buildCustomerSummary({ diagnosis, treatmentRationale }),
    internal_quality_flags: internalQualityFlags,
    human_review_required: humanReviewRequired,
  };
}

module.exports = {
  assessInputSufficiency,
  buildDiagnosticReportContract,
  buildDiagnosis,
  buildReconciliationFlags,
  buildTreatmentRationale,
  buildWateringPlan,
  fertilizerBlackoutConflicts,
  normalizeFindings,
  normalizeProductLabelConstraints,
  normalizeProducts,
  runQaSafetyCheck,
};
