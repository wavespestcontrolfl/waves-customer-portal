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

// Conditions that cannot be confirmed from photos alone — kept in sync with the
// nouns stripConfirmedLanguage knows how to downgrade.
const PHOTO_ONLY_UNCERTAIN = /chinch|fung|large.?patch|gray.?leaf|disease|drought|grub|insect/i;

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

// Return the more conservative (lower-ranked) of two confidence values. Used at the
// public egress to gate hero copy by BOTH the diagnosis-level and the matching
// finding-level confidence, so a stale/high top-level value can't out-rank a low
// finding and publish a named pest.
function lowerConfidence(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return confidenceRank(a) <= confidenceRank(b) ? a : b;
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

  // Auto-release model: insufficient input never blocks the report. We still
  // surface photo quality, limitations, and missing inputs (they drive the
  // internal release_mode and conservative wording in classifyReleaseMode /
  // applyAutoReleaseRepair), but human_review_required is deprecated and pinned
  // false — this product has no manual-review queue.
  return {
    photo_quality: photoQuality,
    photo_limitations: photoLimitations,
    missing_inputs: unique(missingInputs),
    human_review_required: false,
    human_review_reason: '',
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
  // Clamp client-supplied schedule to known weekdays / time-window shapes so no raw
  // string reaches customer egress.
  const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
  const TIME_WINDOW_RE = /^(before|after)\s+\d{1,2}(:\d{2})?\s*(am|pm)$/i;
  const assignedDays = unique(irrigation.assigned_days || irrigation.assignedDays)
    .filter((d) => WEEKDAYS.has(String(d).trim().toLowerCase()));
  const allowedTimeWindows = unique(irrigation.allowed_time_windows || irrigation.allowedTimeWindows || irrigation.allowed_windows || irrigation.allowedWindows)
    .filter((w) => TIME_WINDOW_RE.test(String(w).trim()));
  const maxDaysPerWeek = numberOrNull(irrigation.max_days_per_week || irrigation.maxDaysPerWeek);
  // Customer-facing restriction line is built from STRUCTURED fields ONLY — never the
  // raw client restriction_summary_customer string, which would publish unscrubbed
  // tech notes / gate codes on the unauthenticated report.
  const restrictionSummary = (assignedDays.length || allowedTimeWindows.length)
    ? `You may water${assignedDays.length ? ` ${joinList(assignedDays)} only` : ''}${allowedTimeWindows.length ? `, ${joinList(allowedTimeWindows)}` : ''}.`
    : (maxDaysPerWeek ? `You may water no more than ${maxDaysPerWeek} day${maxDaysPerWeek === 1 ? '' : 's'} per week.` : null);

  let directive = 'Use only general low-risk watering guidance until product label constraints are reviewed.';
  if (maxHoldHours != null) {
    directive = `Hold irrigation for ${maxHoldHours} hours after application unless a reviewed label or technician correction says otherwise.`;
  } else if (directives.length) {
    directive = joinList(directives.map((constraints) => constraints.post_app_irrigation));
  }

  const requiresLabelReview = hasLabelReviewGap || labelConflict;
  let customerSequence;
  if (requiresLabelReview) {
    customerSequence = 'Return to normal irrigation only after product-specific label directions are reviewed.';
  } else if (maxHoldHours != null && assignedDays.length) {
    customerSequence = `After the ${maxHoldHours}-hour hold, water only in the assigned ${joinList(assignedDays)} windows, and skip a cycle when rainfall covers the lawn.`;
  } else if (hasWaterIn) {
    // A reviewed label that requires watering in must be stated before the
    // assigned schedule, otherwise the customer is told to wait for watering days.
    customerSequence = assignedDays.length
      ? `Water in today's application as the reviewed product label directs, then return to your assigned ${joinList(assignedDays)} watering windows only.`
      : 'Water in today\'s application as the reviewed product label directs, then return to your normal allowed watering schedule.';
  } else {
    customerSequence = restrictionSummary || 'Return to normal irrigation only after product-specific label directions are satisfied.';
  }

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
    // Nullish, not ||, so a catalog-authoritative 0 (product genuinely has no N/P)
    // is not overridden by a stale request-supplied analysis value.
    nitrogen: numberOrNull(product.analysis_n ?? product.nitrogen_pct ?? product.nitrogenPct ?? product.n),
    phosphorus: numberOrNull(product.analysis_p ?? product.phosphorus_pct ?? product.phosphorusPct ?? product.p),
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
  // Any photo-only pest/disease/drought call below high confidence cannot be
  // confirmed from images alone — covers everything stripConfirmedLanguage scrubs,
  // not just chinch, so applyAutoReleaseRepair can keep that copy suggestive.
  if (findings.some((finding) => PHOTO_ONLY_UNCERTAIN.test(finding.name || '') && confidenceRank(finding.confidence) < 3)) {
    flags.push({
      type: 'photo_confirmation_honesty',
      severity: 'medium',
      issue: 'Photo-only pest, disease, or drought findings below high confidence cannot be confirmed from images; customer copy must stay suggestive.',
    });
  }
  return flags;
}

function buildExpectations(findings = []) {
  // Cause-specific expectations (disease/insect/weed) may only be published for findings
  // that clear the v0.4 naming gate (moderate+). Low/unknown findings stay symptom-only,
  // so their raw names never drive a named-cause expectation line. turf_recovery is
  // generic and always safe to include.
  const names = findings
    .filter((finding) => confidenceRank(finding.confidence) >= CONFIDENCE_ORDER.moderate)
    .map((finding) => normalizeKey(finding.name))
    .join(' ');
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

// Map any stored finding name (client/LLM free text) to a fixed, allowlisted
// customer-facing condition label. The single source of truth for both the public
// egress route and the customer-summary builders — so no raw finding name (and the
// email/phone/product/tech-note it could carry) ever reaches customer copy. Falls
// back to a generic monitored-condition label when nothing matches.
const CONDITION_LABELS = [
  [/chinch/, 'chinch bug activity'],
  [/(army\s?worm|sod\s?webworm|caterpillar|\bworm)/, 'caterpillar activity'],
  [/grub/, 'grub activity'],
  [/(large patch|brown patch)/, 'large patch (fungal) activity'],
  [/(gray|grey)\s?leaf/, 'gray leaf spot'],
  [/dollar spot/, 'dollar spot'],
  [/(fungus|fungal|disease|leaf spot|mold|mildew)/, 'fungal activity'],
  [/(nutsedge|sedge|crabgrass|dollarweed|clover|spurge|\bweed)/, 'weed pressure'],
  [/(overwater|too much water|excess(ive)?\s+(water|moisture)|soggy|saturat)/, 'overwatering signal'],
  [/(drought|\bdry\b|water stress|wilt|under\s?water)/, 'drought stress'],
  [/(thin|bare|sparse|patchy)/, 'thinning turf'],
  [/(chlorosis|iron|nitrogen|nutrient|yellow)/, 'color and nutrient stress'],
  [/(\bhealthy\b|looks good|looks healthy)/, 'no major visible stress'],
  [/(color|discolor|stress|decline)/, 'color stress'],
];

// Labels that NAME a specific pest/disease/species/deficiency. Under the v0.4 naming
// gate these may only be published for moderate+ findings; below that they downgrade
// to a generic symptom so no low/unknown finding publishes a cause.
const CAUSE_LABELS = new Set([
  'chinch bug activity', 'caterpillar activity', 'grub activity',
  'large patch (fungal) activity', 'gray leaf spot', 'dollar spot', 'fungal activity',
  // Drought is a governed cause (PHOTO_ONLY_UNCERTAIN / CONFIRMABLE_CONDITION treat it
  // as photo-unconfirmable) — a low/unknown finding must not publish "drought stress".
  'drought stress',
]);
const GENERIC_STRESS_LABEL = 'general lawn stress';

// A finding is "clean" only when it LEADS with a negation / health phrase. This catches
// "No visible disease" / "Healthy, dense turf" without misreading a positive finding
// that carries a negated differential ("Possible fungal disease; no weed pressure").
const LEADING_NEGATION = /^\s*(no|none|not|clear|healthy|looks good|looks healthy|nothing)\b/;

// Map any stored finding name (client/LLM free text) to a fixed, allowlisted
// customer-facing condition label, gated by confidence. Single source of truth for the
// public egress route, the customer-summary builder, AND the narrative context — so no
// raw finding name, and no low/unknown cause name, ever reaches customer copy or the
// narrative LLM. Pass the finding's confidence at every customer-facing call site.
function safeConditionLabel(rawName, confidence) {
  const lower = String(rawName || '').toLowerCase();
  if (!lower) return null;
  let label = 'a lawn condition we are monitoring';
  if (LEADING_NEGATION.test(lower)) {
    label = 'no major visible stress';
  } else {
    for (const [pattern, mapped] of CONDITION_LABELS) {
      if (pattern.test(lower)) { label = mapped; break; }
    }
  }
  if (confidence !== undefined && CAUSE_LABELS.has(label) && confidenceRank(confidence) < CONFIDENCE_ORDER.moderate) {
    return GENERIC_STRESS_LABEL;
  }
  return label;
}

function buildCustomerSummary({ diagnosis, treatmentRationale = [] } = {}) {
  const primary = diagnosis.findings?.find((finding) => finding.name === diagnosis.primary_finding);
  if (!primary) return 'This lawn check is complete. The photos did not show enough detail to call out a specific pest or disease, so keep to your normal watering schedule and watch for any area that spreads, thins, or does not recover.';
  const addressed = treatmentRationale.some((row) => row.addresses_findings.includes(primary.finding_id));
  const treatmentLine = addressed
    ? 'Today\'s treatment was matched to that pressure.'
    : 'We did not map a treatment to that finding today, so it should be watched or re-checked.';
  // Naming gate (deterministic path): low/unknown findings stay SYMPTOM-only and never
  // publish a named pest/disease, mirroring the v0.4 prompt. Only moderate+ may name.
  const confidence = confidenceRank(primary.confidence);
  if (confidence < CONFIDENCE_ORDER.moderate) {
    return `The photos show an area of the lawn worth keeping an eye on. ${treatmentLine} We'd confirm with a closer look if it spreads, thins, or does not recover.`;
  }
  // Allowlisted label, never the raw stored name — this string is published. (Reached
  // only at moderate+; low/unknown returned the symptom-only line above.)
  const name = safeConditionLabel(primary.name, primary.confidence) || 'a lawn condition we are monitoring';
  const lower = name.toLowerCase();
  if (lower.includes('chinch') && confidence < CONFIDENCE_ORDER.high) {
    return `The pattern is most consistent with chinch pressure, which can look very similar to drought stress. ${treatmentLine} If the patch continues expanding, re-check the margin.`;
  }
  if (confidence < CONFIDENCE_ORDER.high) {
    return `The photos show signs most consistent with ${name}. ${treatmentLine} We should confirm if the area spreads or the pattern changes.`;
  }
  return `The photos show ${name}. ${treatmentLine} Watch for improvement based on the expected response timeline.`;
}

// Cause terms that must never appear in a low/unknown-confidence customer summary.
// Kept in lockstep with the cause-mapped CONDITION_LABELS entries (every term that
// resolves to a CAUSE_LABELS label), plus the GENERIC cause words (insect/pest/disease),
// so a stale/LLM summary like "most consistent with caterpillar activity" is replaced
// even though the public finding label is already downgraded to a symptom.
const SUMMARY_CAUSE_RE = /\b(chinch|large patch|brown patch|gr[ae]y leaf|dollar spot|rhizoctonia|take[-\s]?all|fungus|fungal|disease|leaf spot|mold|mildew|insect|pest|grub|caterpillars?|worms?|armyworm|sod\s?webworm|nutsedge|crabgrass|dollarweed|drought|water stress|chlorosis|iron deficiency|nitrogen deficiency|magnesium deficiency)\b/i;
const GENERIC_LOW_CONFIDENCE_SUMMARY = 'Your lawn shows an area worth keeping an eye on. We did not see enough detail to call out a specific pest or disease from these photos, so the best next step is a closer look if it spreads, thins, or does not recover.';

// Public hero summary egress: scrub, then for a low/unknown-confidence report replace
// any summary that still NAMES a cause (stale stored contract, or a narrative pass that
// inferred a pest) with a generic symptom-only line. Applies the v0.4 naming gate to
// the FIRST customer-facing text, not just the findings/labels.
function safeCustomerSummary(summary, confidence) {
  const scrubbed = scrubCustomerText(summary);
  if (!scrubbed) return null;
  if (confidenceRank(confidence) < CONFIDENCE_ORDER.moderate && SUMMARY_CAUSE_RE.test(scrubbed)) {
    return GENERIC_LOW_CONFIDENCE_SUMMARY;
  }
  return scrubbed;
}

// Safe wording used when inputs are too poor to defend any diagnosis. Names no
// pest or disease; states what was checked and what to watch.
const MINIMAL_SAFE_SUMMARY = 'This lawn check is complete. The photos provided did not show enough detail to call out a specific pest or disease, so we are not naming one from these images. The best next step is a quick on-site look; in the meantime, keep to your normal watering schedule and watch for any area that spreads, thins, or does not recover.';

const NO_FINDING_KEY = normalizeKey('No major visible lawn stress signal');

// Auto-release safety ladder. The report ALWAYS releases; this only classifies
// how conservative the customer copy must be. Precedence (most → least
// restrictive): minimal > conservative > label_limited > standard.
//   - minimal:       no usable photos, or no defensible diagnosis.
//   - conservative:  diagnosis is weak/uncertain (confidence < high, limited
//                    photos, or an untreated finding). Symptom-first wording.
//   - label_limited: diagnosis is sound but product-label/watering data is not
//                    authoritative, or a compliance conflict exists. Exact
//                    timing is omitted (also enforced independently by
//                    buildWateringPlan, so this is belt-and-suspenders).
//   - standard:      evidence and label data are sufficient.
function classifyReleaseMode(contract = {}) {
  const ia = contract.input_assessment || {};
  const diag = contract.diagnosis || {};
  const flags = contract.internal_quality_flags || [];
  const recon = contract.reconciliation_flags || [];
  const missing = ia.missing_inputs || [];

  const noUsablePhotos = ia.photo_quality === 'poor' || missing.includes('lawn photos missing');
  const noDefensibleDiagnosis = !diag.primary_finding
    || normalizeKey(diag.primary_finding) === NO_FINDING_KEY
    || confidenceRank(diag.confidence) <= 0;
  if (noUsablePhotos || noDefensibleDiagnosis) return 'minimal';

  const weakDiagnosis = confidenceRank(diag.confidence) < 3
    || ia.photo_quality !== 'adequate'
    || (ia.photo_limitations || []).length > 0
    || recon.some((flag) => flag.type === 'untreated_condition' && flag.severity !== 'low');
  if (weakDiagnosis) return 'conservative';

  const labelGap = contract.watering?.post_application?.requires_label_review === true
    || flags.some((flag) => ['product_label_review_required', 'watering_label_conflict', 'fertilizer_blackout_conflict'].includes(flag.type));
  if (labelGap) return 'label_limited';

  return 'standard';
}

// Condition nouns that must never appear as a "confirmed/active" claim in customer
// copy. Shared by the adjective-form and predicate-form passes so the two stay in
// sync — the predicate form previously omitted fungus/drought/multi-word diseases,
// letting "fungus is confirmed" / "large patch is confirmed" slip through.
const CONFIRMABLE_CONDITION = 'chinch(?:\\s*bugs?)?|fungus|fungal|disease|large patch|brown patch|gray leaf spot|grey leaf spot|dollar spot|drought|grubs?|insect|infestation';

// Downgrade any over-confident pest/disease/drought wording to suggestive form.
// Safety net for LLM-authored copy; deterministic copy never says "confirmed".
function stripConfirmedLanguage(text) {
  if (!text) return text;
  return String(text)
    .replace(new RegExp(`\\b(?:confirmed|active|definite(?:ly)?|certain(?:ly)?)\\s+(${CONFIRMABLE_CONDITION})`, 'gi'),
      (match, noun) => `suspected ${noun}`)
    .replace(new RegExp(`\\b(${CONFIRMABLE_CONDITION})\\s+(?:is|are|was|were)\\s+confirmed\\b`, 'gi'),
      '$1 most consistent with the visible pattern')
    .replace(/\bwe (?:have )?confirmed\b/gi, 'the pattern is most consistent with');
}

// Product/active-ingredient names that must never reach customer-facing copy.
const CUSTOMER_TEXT_BRANDS = /\b(?:talstar|arena|celsius|sedgehammer|prodiamine|dimension|barricade|bifenthrin|fipronil|imidacloprid|acelepryn|chlorantraniliprole|tenacity|mesotrione)\b/gi;

// Street-address pattern (leading house number + street + suffix). Customer copy
// should reference "the property", never a street line that could leak elsewhere.
const STREET_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|cir|circle|ter|terrace|pl|place|hwy|highway|pkwy|parkway|trl|trail)\b\.?/gi;

// PII that the brand/address scrubbers don't catch. Stored finding names, summaries,
// and seasonal notes can carry client/LLM free text, so strip emails, phone numbers,
// and links before any of it reaches an unauthenticated prospect report.
const CUSTOMER_TEXT_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const CUSTOMER_TEXT_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;
const CUSTOMER_TEXT_PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// Final egress sanitizer for any free-text published to a prospect. Defense in
// depth at the public boundary: even if a stale/buggy client stored unsanitized
// copy, no confirmed-pest claim, brand/active-ingredient name, or street address
// leaves the server.
function scrubCustomerText(text) {
  if (text == null) return text;
  return stripConfirmedLanguage(String(text))
    .replace(CUSTOMER_TEXT_BRANDS, 'the treatment product')
    .replace(CUSTOMER_TEXT_URL, '')
    .replace(CUSTOMER_TEXT_EMAIL, '')
    .replace(CUSTOMER_TEXT_PHONE, '')
    .replace(STREET_ADDRESS, 'the property')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Repair unsafe customer copy in place of blocking. Condition/flag-driven so
// every applicable degradation is applied regardless of the summary mode label.
function applyAutoReleaseRepair(contract = {}, mode = 'standard') {
  const repaired = { ...contract };
  const flags = contract.internal_quality_flags || [];
  const repairs = [];

  if (mode === 'minimal') {
    repaired.customer_summary = MINIMAL_SAFE_SUMMARY;
    repaired.watch_items = ['Watch for any area that spreads, thins, or does not recover, and we will take a closer look on the next visit.'];
    // Minimal means inputs are too poor to defend a diagnosis — name no pest or
    // disease anywhere downstream (the public presenter reads these fields).
    repaired.diagnosis = { ...(contract.diagnosis || {}), primary_finding: null, confidence: 'unknown', findings: [] };
    repaired.reconciliation_flags = [];
    repaired.expectations = {};
    repaired.repairs_applied = ['minimal_safe_summary'];
    return repaired;
  }

  let summary = contract.customer_summary || '';

  if (flags.some((flag) => flag.type === 'photo_confirmation_honesty')) {
    const scrubbed = stripConfirmedLanguage(summary);
    if (scrubbed !== summary) { summary = scrubbed; repairs.push('confirmed_language_downgraded'); }
  }

  const labelGap = contract.watering?.post_application?.requires_label_review === true
    || flags.some((flag) => ['product_label_review_required', 'watering_label_conflict'].includes(flag.type));
  if (labelGap && /\b\d+\s*(?:h\b|hours?|days?)/i.test(summary)) {
    summary = summary.replace(/[^.]*\b\d+\s*(?:h\b|hours?|days?)[^.]*\.\s*/gi, '').trim();
    summary = `${summary} Follow the post-service watering guidance from Waves before returning to your normal schedule.`.trim();
    repairs.push('unauthoritative_timing_stripped');
  }

  if (flags.some((flag) => flag.type === 'fertilizer_blackout_conflict')) {
    summary = summary.replace(/[^.]*\b(?:nitrogen|phosphorus|fertiliz\w*|feed\w*|\d+-\d+-\d+)\b[^.]*\.\s*/gi, '').trim();
    summary = `${summary} During the current fertilizer blackout we hold nitrogen and phosphorus and focus only on allowed services.`.trim();
    repairs.push('blackout_fertility_removed');
  }

  if (!summary || summary.trim().length < 40) {
    summary = MINIMAL_SAFE_SUMMARY;
    repairs.push('summary_fallback_minimal');
  }

  repaired.customer_summary = summary.replace(/\s{2,}/g, ' ').trim();
  if (repairs.length) repaired.repairs_applied = repairs;
  return repaired;
}

// Convenience: a full contract that diagnoses nothing, for the worst-input case.
function buildMinimalSafeReport(input = {}) {
  return applyAutoReleaseRepair(buildDiagnosticReportContract({ ...input, findings: [] }), 'minimal');
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
    // Deprecated: this system auto-releases in one of four modes (see
    // classifyReleaseMode) and never waits on manual review. Pinned false for
    // backward compatibility with the stored report_contract shape.
    human_review_required: false,
  };
}

module.exports = {
  assessInputSufficiency,
  buildDiagnosticReportContract,
  buildDiagnosis,
  buildReconciliationFlags,
  buildTreatmentRationale,
  buildWateringPlan,
  classifyReleaseMode,
  applyAutoReleaseRepair,
  buildMinimalSafeReport,
  fertilizerBlackoutConflicts,
  normalizeFindings,
  normalizeProductLabelConstraints,
  normalizeProducts,
  runQaSafetyCheck,
  scrubCustomerText,
  safeConditionLabel,
  safeCustomerSummary,
  lowerConfidence,
  MINIMAL_SAFE_SUMMARY,
};
