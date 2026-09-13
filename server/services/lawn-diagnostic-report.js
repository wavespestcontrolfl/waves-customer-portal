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
// back to a generic monitored-condition label when nothing matches. Separators inside
// a multi-word condition are optional, in lockstep with SUMMARY_CAUSE_RE, so a
// spelling the cause gate recognizes ("Sod-webworm", "Large-patch") maps to its label.
const CONDITION_LABELS = [
  [/chinch/, 'chinch bug activity'],
  [/(army[\s‐‑‒–—-]*worm|sod[\s‐‑‒–—-]*webworm|caterpillar|\bworm)/, 'caterpillar activity'],
  [/grub/, 'grub activity'],
  [/(large[\s‐‑‒–—-]*patch|brown[\s‐‑‒–—-]*patch|rhizoctonia)/, 'large patch (fungal) activity'],
  [/(gray|grey)[\s‐‑‒–—-]*leaf/, 'gray leaf spot'],
  [/dollar[\s‐‑‒–—-]*spot/, 'dollar spot'],
  [/(fungus|\bfungi\b|fungal|disease|leaf[\s‐‑‒–—-]*spot|mold|mildew|take[‐‑‒–—-]all(?:[\s‐‑‒–—-]*root[\s‐‑‒–—-]*rot)?|take[\s‐‑‒–—-]*all[\s‐‑‒–—-]*root[\s‐‑‒–—-]*rot)/, 'fungal activity'],
  [/(nutsedge|sedge|crabgrass|dollarweed|clover|spurge|\bweed)/, 'weed pressure'],
  [/(overwater|too much water|excess(ive)?\s+(water|moisture)|soggy|saturat)/, 'overwatering signal'],
  [/(drought|\bdry\b|water[\s‐‑‒–—-]*stress|wilt|under[\s‐‑‒–—-]*water)/, 'drought stress'],
  [/\b(thin(?:ning|ned)?|bare|sparse|patchy)\b/, 'thinning turf'],
  [/(chlorosis|\biron\b|nitrogen|nutrient|yellow)/, 'color and nutrient stress'],
  [/(\bhealthy\b|looks good|looks healthy)/, 'no major visible stress'],
  [/(color|discolor|stress|decline)/, 'color stress'],
];

// Labels that NAME a specific pest/disease/species/deficiency. Under the v0.4 naming
// gate these may only be published for moderate+ findings; below that they downgrade
// to a generic symptom so no low/unknown finding publishes a cause.
const CAUSE_LABELS = new Set([
  'chinch bug activity', 'caterpillar activity', 'grub activity',
  'large patch (fungal) activity', 'gray leaf spot', 'dollar spot', 'fungal activity',
  // Drought is a governed cause (PHOTO_ONLY_UNCERTAIN / SUMMARY_CAUSE_RE treat it
  // as photo-unconfirmable) — a low/unknown finding must not publish "drought stress".
  'drought stress',
]);
const GENERIC_STRESS_LABEL = 'general lawn stress';
// Technician renames use exactly the labels the customer egress can publish.
const CONDITION_LABEL_VALUES = Object.freeze([
  ...new Set([...CONDITION_LABELS.map(([, label]) => label), GENERIC_STRESS_LABEL, 'a lawn condition we are monitoring']),
]);

// A finding is "clean" only when it LEADS with a negation / health phrase. This catches
// "No visible disease" / "Healthy, dense turf" without misreading a positive finding
// that carries a negated differential ("Possible fungal disease; no weed pressure").
// Clause-level lead words that mark a clause as clean. Health phrases ("healthy",
// "looks good") are NOT here: they stay positive clauses and map through the
// CONDITION_LABELS health row, so "Healthy, dense turf" still resolves clean while
// "Healthy overall, some yellowing" maps its positive clause.
const CLEAN_CLAUSE_LEAD = /^\s*(?:no|none|not|clear|nothing)\b/;

// A negation marker anywhere in a clause withdraws that clause from label mapping,
// so a negated alias ("Rhizoctonia ruled out", "Take-all was not observed",
// "Sod-webworm not present") never maps to its positive label. Clauses split on
// sentence punctuation and contrast words only: a comma or colon continues the
// clause, so one negation keeps its scope across an enumerated list ("No weeds,
// disease, or pests observed", "No chinch bugs: drought ruled out") while a
// positive finding that carries a negated differential ("Possible fungal disease;
// no weed pressure", "Chinch bugs not present, but drought stress visible") still
// maps its positive clause. Same marker set as the copy module's establishesCause.
// Every sentence terminator splits, so "No weeds! Large patch is visible" keeps
// its positive sentence.
const CLAUSE_SPLIT = /[;.!?]|\b(?:but|while|although|though|whereas|however|yet)\b/;
const NEGATION_MARKER = /\b(?:no|not|none|non|never|neither|nor|cannot|\w+n['’]t|without|ruled[\s‐‑‒–—-]+out|negative|absent|absence|lack(?:s|ed|ing)?|unlikely|unconfirmed|excluded|free)\b/;
// Negation scope inside one clause. A determiner-style marker (no / without /
// non / neither, and not / never when a cause term follows) negates what FOLLOWS
// it, so the text before it stays positive: "Large patch with no weed pressure"
// keeps large patch, "Drought stress, not chinch bugs" keeps drought. Any other
// marker (ruled out, absent, absence, unlikely, n't, none, "not present", "never observed",
// "not a factor") negates the whole clause, because it describes the subject
// that precedes it. Anything the rule cannot place is treated as negated.
const FORWARD_NEGATION = /\b(no|not|never|without|non|neither)\b/;
// A "-free" differential ("weed-free", "disease free", "free of grubs") negates
// only its own compound; the rest of the clause is judged on its own, so
// "Large patch in otherwise weed-free turf" keeps large patch while
// "Disease-free turf" stays clean.
// Built lazily: SUMMARY_CAUSE_RE is declared below. The whole governed cause
// (plus an optional spot/activity/… suffix word) is consumed with "free", so
// "Chinch bug-free turf", "Gray leaf spot-free turf" and "Iron deficiency-free
// turf" leave no positive fragment behind.
// "Nonfungal" / "non‑fungal": a non prefix attached directly to a governed cause
// is spaced out so the ordinary non handling applies. Shared with the copy module.
let joinedNon = null;
function spaceJoinedNon(text) {
  if (!joinedNon) joinedNon = new RegExp(`\\bnon(?=[‐‑‒–—-]?(?:${SUMMARY_CAUSE_RE.source.slice(2, -2)}))`, 'gi');
  return String(text || '').replace(joinedNon, 'non ');
}
// A negated recovery predicate ("is not improving", "hasn't recovered", "not
// responding to treatment") negates the recovery, not the condition, so it is
// removed before any negation check: "Large patch is not improving" keeps large
// patch on every publication path.
const NEGATED_RECOVERY = /\b(?:(?:is|are|was|were|has|have|had|does|did|do|still)\s+)?(?:not|never|\w+n['’]t)\s+(?:yet\s+|fully\s+|really\s+)?(?:improv\w*|recover\w*|respond\w*|resolv\w*|heal\w*|better|bounc\w*\s+back|green\w*(?:\s+up)?|fill\w*\s+in|clear\w*\s+up|grow\w*\s+back|com\w*\s+back|got(?:ten)?\s+better)\b/gi;
function stripNegatedRecovery(text) {
  return String(text || '').replace(NEGATED_RECOVERY, ' ').replace(/\s+/g, ' ');
}
let freeDifferential = null;
function freeDifferentialRe() {
  if (!freeDifferential) {
    const cause = SUMMARY_CAUSE_RE.source.slice(2, -2);
    // "free of/from" consumes its whole enumerated list (items joined by commas
    // or and/or/nor) but stops at a word that starts a new positive statement, so
    // "Free of chinch bugs and weeds" is clean while "Free of chinch bugs and
    // weeds, large patch present" keeps large patch.
    const state = '(?:present|visible|spreading|active|observed|seen|noted|confirmed|is|are|was|were)';
    // An item runs to a comma, a conjunction or the clause end; a state word
    // inside it means it is a new statement, not a list item. Words are joined
    // by mandatory whitespace so the repetition has one parse (no backtracking
    // blow-up when a state word makes the match fail).
    const word = `(?!\\b(?:and|or|nor|but|with)\\b|\\b${state}\\b)[\\w‐‑‒–—-]+`;
    const item = `${word}(?:\\s+${word})*\\s*(?=$|[,.;!?]|(?:and|or|nor)\\b|[&\\/])`;
    // Comma items, then at most one conjunction item, which closes the list.
    const freeList = `\\bfree\\s+(?:of|from)\\s+${item}(?:,\\s*${item})*(?:,?\\s*(?:and|or|nor|&|\\/)\\s*${item})?`;
    freeDifferential = new RegExp(`${freeList}|\\b(?:${cause})(?:[\\s‐‑‒–—-]*(?:spots?|activity|damage|pressure|stress|disease|signs?))?[\\s‐‑‒–—-]*free\\b(?!\\s+(?:of|from)\\b)|\\b\\w+[\\s‐‑‒–—-]*free\\b(?!\\s+(?:of|from)\\b)`, 'gi');
  }
  freeDifferential.lastIndex = 0;
  return freeDifferential;
}
const SEGMENT_PREDICATE = /\b(?:present|visible|spreading|active|observed|seen|noted|confirmed|is|are|was|were|has|have|had|appears?|looks?|remains?)\b/;
// A finite verb of its own, which an "and"-led segment needs before it counts
// as an independent statement rather than a conjunct sharing the predicate.
const INDEPENDENT_PREDICATE = /\b(?:is|are|was|were|has|have|had|remains?|appears?|looks?|seems?|may|might|could|can|will|should|must)\b/;
// A conjunct that carries its own content (a symptom/damage noun or a location)
// is an independent positive statement even without a verb.
const SEGMENT_CONTENT = /\b(?:damage|activity|pressure|signs?|evidence|symptoms?|lesions?|thinning|feeding|infestation|outbreak|stress|patches|at|along|near|in|on|across|around|by)\b/;
// Split a clause into predicate segments. Commas and colons always separate;
// "and"/"plus"/"&" separates too, except that a bare noun conjunct with no
// predicate or content of its own shares the predicate that follows it
// ("Chinch bugs and weeds absent" is one negated segment, while "Chinch bug
// damage at the edge, weeds absent" and "Large patch present and weeds absent"
// keep their positive segment).
function predicateSegments(text) {
  const segments = [];
  let carry = '';
  const tokens = text.split(/([,:]|\s+(?:and|plus|&)\s+)/);
  for (let i = 0; i < tokens.length; i += 2) {
    const part = tokens[i].trim();
    if (!part) continue;
    const nextSep = (tokens[i + 1] || '').trim();
    const joinsNext = /^(?:and|plus|&)$/.test(nextSep);
    const standalone = SEGMENT_PREDICATE.test(part) || NEGATION_MARKER.test(part) || SEGMENT_CONTENT.test(part);
    const joined = carry ? `${carry} and ${part}` : part;
    if (joinsNext && !standalone) { carry = joined; continue; }
    segments.push(joined);
    carry = '';
  }
  if (carry) segments.push(carry);
  return segments;
}
// A bare not / never / n't whose object is neither an absence predicate nor a
// governed cause ("is not getting better", "has not started to recover") does
// not assert that the condition is absent. Such a clause is uncertain: it never
// earns the clean label, and it never maps a cause either.
const ABSENCE_OBJECT = '(?:present|observed|seen|noted|found|detected|visible|evident|apparent|active|likely|suspected|there|any|much|significant|showing|involved|causing|responsible|to\\s+blame|the\\s+cause|an?\\s+(?:factor|issue|concern|problem|cause))';
let unrecognizedNegation = null;
function unrecognizedNegationRe() {
  if (!unrecognizedNegation) {
    const cause = SUMMARY_CAUSE_RE.source.slice(2, -2);
    unrecognizedNegation = new RegExp(`\\b(?:not|never|\\w+n['’]t)\\s+(?!(?:yet\\s+|fully\\s+|really\\s+|quite\\s+|even\\s+|currently\\s+|clearly\\s+)?(?:${ABSENCE_OBJECT}|weeds?\\b|${cause}))`, 'i');
  }
  return unrecognizedNegation;
}
// A negated absence marker ("cannot be ruled out", "has not been excluded",
// "not absent") is uncertainty, not absence.
// Lack of confirmation ("not confirmed", "unconfirmed", "cannot be verified")
// is uncertainty as well: it establishes neither presence nor absence.
const NEGATED_ABSENCE = /\b(?:not|never|cannot|\w+n['’]t)\s+(?:\w+[\s‐‑‒–—-]+){0,2}?(?:ruled[\s‐‑‒–—-]+out|absent|excluded|unlikely|negative|free|confirmed|verified|established|certain|definite)\b|\bunconfirmed\b/;
// A generic symptom noun right after a forward negation ("no signs", "no
// evidence observed", "without visible lesions") describes the cause that
// precedes it, so the whole clause is negated rather than only the object.
const SYMPTOM_OBJECT = /^\s*(?:(?:visible|active|clear|obvious|new|fresh|further|additional|significant|major|real|current)\s+)*(?:signs?|evidence|lesions?|symptoms?|damage|activity|pressure|spots?|presence|feeding|indications?|issues?|problems?)\b/;
const RECOGNIZED_MARKER = /\b(?:no|none|non|neither|nor|cannot|without|ruled[\s‐‑‒–—-]+out|negative|absent|absence|lack(?:s|ed|ing)?|unlikely|unconfirmed|excluded|free)\b/;
// "not only" / "not just" / "not merely" intensify rather than negate ("Large
// patch is not only visible but spreading"), so they are removed before any
// negation check. Shared with the copy module's establishesCause.
const INTENSIFIER_NOT = /\bnot\s+(?:only|just|merely|simply)\b/gi;
function stripIntensifierNot(text) {
  return String(text || '').replace(INTENSIFIER_NOT, ' ').replace(/\s+/g, ' ');
}
// One clause: the predicate segments that carry a negated-absence marker are
// uncertain and dropped; the rest of the clause is judged on its own, so
// "Large patch present, chinch bugs not confirmed" keeps large patch while
// "Not free of chinch bugs" leaves nothing behind.
function withoutUncertainSegments(text) {
  const segments = predicateSegments(text);
  const remaining = segments.filter((segment) => !NEGATED_ABSENCE.test(segment));
  if (remaining.length === segments.length) return { text, uncertain: false };
  return { text: remaining.join(', '), uncertain: true };
}
// One clause: its "-free" differential is removed; the remainder counts only
// when it names a condition on its own.
function withoutFreeDifferential(text) {
  const FREE_DIFFERENTIAL = freeDifferentialRe();
  const found = FREE_DIFFERENTIAL.test(text);
  FREE_DIFFERENTIAL.lastIndex = 0;
  if (!found) return { text, negated: false };
  const rest = text.replace(FREE_DIFFERENTIAL, ' ').replace(/\s+/g, ' ').trim();
  FREE_DIFFERENTIAL.lastIndex = 0;
  const named = !!rest && CONDITION_LABELS.some(([pattern]) => pattern.test(rest));
  return { text: named ? rest : '', negated: true };
}
// Positive statements of a clause whose negation scopes forward: the head
// before the marker, unless a whole-clause marker sits anywhere else in the
// clause or "no" is followed by a generic symptom noun that describes the
// cause before it ("Chinch bugs — no evidence observed", "Large patch: no
// signs present"); and any later comma/colon segment that carries its own
// predicate and names a condition ("No weeds, large patch present" keeps
// large patch, "No weeds, disease, or pests observed" stays one list).
function forwardScopedPositives(text, forward) {
  const rest = text.slice(forward.index + forward[0].length);
  if (SYMPTOM_OBJECT.test(rest)) return [];
  const positive = [];
  const head = text.slice(0, forward.index).trim();
  const wholeClauseMarker = NEGATION_MARKER.test(head) || NEGATION_MARKER.test(rest.replace(new RegExp(FORWARD_NEGATION.source, 'g'), ''));
  if (head && !wholeClauseMarker) positive.push(head);
  // A comma/colon segment needs any predicate word ("No weeds, large patch
  // present"); an "and"-led segment needs a finite verb of its own ("No weeds
  // and large patch is present"), so a shared predicate ("No chinch bugs and
  // weeds observed") stays one negated list.
  const tokens = rest.split(/([,:]|\s+and\s+)/);
  for (let i = 2; i < tokens.length; i += 2) {
    const coordinated = /^\s*and\s*$/.test(tokens[i - 1]) || /^and\b/.test(tokens[i].trim());
    const part = tokens[i].trim().replace(/^and\s+/, '');
    if (!part || /^(?:or|nor)\b/.test(part) || NEGATION_MARKER.test(part)) continue;
    const predicate = coordinated ? INDEPENDENT_PREDICATE : SEGMENT_PREDICATE;
    if (predicate.test(part) && (SUMMARY_CAUSE_RE.test(part) || /\bweeds?\b/.test(part))) positive.push(part);
  }
  return positive;
}
// Positive statements of a negated clause. A determiner-style marker scopes
// forward; any other marker is postpositive ("weeds absent", "not present",
// "ruled out") and negates only the segment that carries it: "Large patch
// present, weeds absent" and "Large patch present and weeds absent" keep large
// patch, while a conjunct with no predicate of its own shares the next one
// ("Chinch bugs and weeds absent" is all negated).
function negatedClausePositives(text, causeAhead) {
  const forward = FORWARD_NEGATION.exec(text);
  const scopesForward = !!forward && (!/^(?:not|never)$/.test(forward[1]) || causeAhead.test(text.slice(forward.index + forward[0].length)));
  if (scopesForward) return forwardScopedPositives(text, forward);
  return predicateSegments(text).filter((part) => !CLEAN_CLAUSE_LEAD.test(part) && !NEGATION_MARKER.test(part));
}
function positiveClauses(lower) {
  const positive = [];
  let negated = false;
  let uncertain = false;
  const causeAhead = new RegExp(`^\\s*(?:the\\s+|any\\s+)?(?:weeds?\\b|${SUMMARY_CAUSE_RE.source.slice(2)})`, 'i');
  for (const clause of stripIntensifierNot(stripNegatedRecovery(spaceJoinedNon(lower))).split(CLAUSE_SPLIT)) {
    // The uncertain segments go first, before the "-free" strip, so "Not free
    // of chinch bugs" / "Turf is not pest-free" stay uncertain instead of clean.
    const scoped = withoutUncertainSegments(clause.trim());
    uncertain = uncertain || scoped.uncertain;
    const stripped = withoutFreeDifferential(scoped.text);
    negated = negated || stripped.negated;
    const text = stripped.text;
    if (!text) continue;
    if (!CLEAN_CLAUSE_LEAD.test(text) && !NEGATION_MARKER.test(text)) { positive.push(text); continue; }
    if (!CLEAN_CLAUSE_LEAD.test(text) && !RECOGNIZED_MARKER.test(text) && unrecognizedNegationRe().test(text)) { uncertain = true; continue; }
    negated = true;
    positive.push(...negatedClausePositives(text, causeAhead));
  }
  return { positive, negated, uncertain };
}

// Map any stored finding name (client/LLM free text) to a fixed, allowlisted
// customer-facing condition label, gated by confidence. Single source of truth for the
// public egress route, the customer-summary builder, AND the narrative context — so no
// raw finding name, and no low/unknown cause name, ever reaches customer copy or the
// narrative LLM. Pass the finding's confidence at every customer-facing call site.
function safeConditionLabel(rawName, confidence) {
  const lower = String(rawName || '').toLowerCase();
  if (!lower) return null;
  let label = 'a lawn condition we are monitoring';
  const { positive, negated, uncertain } = positiveClauses(lower);
  // The clean label applies only when NO positive clause remains: "No weeds;
  // large patch is visible" maps its positive clause (Codex #4328 r2). An
  // uncertain negation with nothing positive beside it keeps the generic label.
  if (negated && !positive.length && !uncertain) {
    label = 'no major visible stress';
  } else if (uncertain && !positive.length) {
    return label;
  } else {
    // Only the non-negated clauses may map to a label.
    const mappable = positive.length ? positive.join('; ') : lower;
    for (const [pattern, mapped] of CONDITION_LABELS) {
      if (pattern.test(mappable)) { label = mapped; break; }
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
// Separators inside a multi-word cause are optional ("gray leaf", "gray-leaf",
// "grayleaf") so the gate accepts every spelling safeConditionLabel accepts. Take-all
// is governed only as the hyphenated shorthand or the full "take all root rot" — the
// ordinary phrase "may take all season" is not a disease — and the full phrase is
// consumed whole so a predicate after it ("… is confirmed") is still scrubbed.
const SUMMARY_CAUSE_RE = /\b(chinch(?:[\s‐‑‒–—-]*bugs?)?|large[\s‐‑‒–—-]*patch(?:es)?|brown[\s‐‑‒–—-]*patch(?:es)?|gr[ae]y[\s‐‑‒–—-]*leaf(?:[\s‐‑‒–—-]*spots?)?|dollar[\s‐‑‒–—-]*spots?|rhizoctonial?|take[‐‑‒–—-]all(?:[\s‐‑‒–—-]*root[\s‐‑‒–—-]*rot)?|take[\s‐‑‒–—-]*all[\s‐‑‒–—-]*root[\s‐‑‒–—-]*rot|fungus(?:es)?|fungi|fungal|disease[sd]?|leaf[\s‐‑‒–—-]*spots?|mold(?:s|y)?|mildew(?:s|ed|y)?|insects?|pests?|infestations?|grubs?|caterpillars?|worms?|army[\s‐‑‒–—-]*worms?|sod[\s‐‑‒–—-]*webworms?|nutsedges?|sedges?|crabgrass(?:es)?|dollarweeds?|clovers?|spurges?|drought(?:s|y)?|water[\s‐‑‒–—-]*stress|under[\s‐‑‒–—-]*water(?:ed|ing)?|wilt(?:s|ed|ing)?|chlorosis|(?:iron|nitrogen|magnesium)[\s‐‑‒–—-]*deficienc(?:y|ies))\b/i;
const GENERIC_LOW_CONFIDENCE_SUMMARY = 'Your lawn shows an area worth keeping an eye on. We did not see enough detail to call out a specific pest or disease from these photos, so the best next step is a closer look if it spreads, thins, or does not recover.';

// Public hero summary egress: scrub, then for a low/unknown-confidence report replace
// any summary that still NAMES a cause (stale stored contract, or a narrative pass that
// inferred a pest) with a generic symptom-only line. Applies the v0.4 naming gate to
// the FIRST customer-facing text, not just the findings/labels.
// Sentence-level backstop behind the scrubber's predicate grammar: a sentence
// that still asserts a governed cause as confirmed / definite / certain after
// the downgrade passes (an auxiliary chain or subject noun the grammar did not
// anticipate) is never published as-is. Shared with the copy module.
// A definitive predicate: confirmed / definite / certain, or a copula-plus-
// "active" claim whatever the subject noun ("Chinch bug colonies are active"),
// so the backstop does not depend on the grammar's finite suffix list.
// A modal-hedged form ("may have been active", "might still be active") is the
// downgrade's own output, not a definitive claim, so it is excluded here.
// "active" is a predicate only when it does not modify a following recovery /
// turf noun: "Large patch has active recovery" describes regrowth, not a
// definitive activity claim, on both the scrub and the backstop.
const PREDICATIVE_ACTIVE = '(?!\\s+(?:recovery|regrowth|growth|repair|healing|recuperation|rooting|greening|fill[\\s-]*in|turf|grass|lawn|roots?|blades?|canopy|ingredients?)\\b)';
// A finite confirmation verb ("The photos confirm chinch bug activity") is a
// claim unless it is a request to confirm ("to confirm", "should confirm",
// "cannot confirm"). An adjective-first activity claim ("Active colonies of
// chinch bugs remain") names the cause within a short noun phrase after
// "active"; function words never bridge the gap, so "may be active and large
// patch …" is not read as one claim.
// An imperative ("Confirm suspected chinch pressure") or a hedged object
// ("confirm possible …", "confirm whether …") is a request as well.
const NOT_A_CLAIM = "(?<!\\b(?:to|should|will|can|must|please|would|could|may|might|cannot|not|never|let['’]s|help|we|we['’]ve|has|have|had|having)\\s+(?:\\w+\\s+)?)(?<!(?:^|[.!?;:])\\s*)(?!confirm\\w*\\s+(?:suspected|possible|potential|likely|whether|if)\\b)";
const NOUN_WORD = '(?!(?:and|or|but|nor|while|with|in|on|at|near|along|by|from|to|for|as|than|then|so|yet|is|are|was|were|has|have|had|do|does|did|be|been|being|will|would|can|could|may|might|must|should)\\b)\\w+';
const CAUSE_AHEAD = `(?=\\s+(?:that\\s+|the\\s+|an?\\s+|some\\s+)?(?:${NOUN_WORD}\\s+){0,2}?(?:of\\s+)?(?:${SUMMARY_CAUSE_RE.source.slice(2, -2)}))`;
// verified / proven are definitive synonyms of confirmed on every rule.
const FINITE_CONFIRM = `${NOT_A_CLAIM}(?:confirm(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|prov(?:e|es|ed|en|ing))\\b${CAUSE_AHEAD}`;
const ADJECTIVE_ACTIVE = `(?<!\\b(?:may|might|could)\\s(?:\\w+\\s){0,2})active${PREDICATIVE_ACTIVE}${CAUSE_AHEAD}`;
const DEFINITIVE_PREDICATE = new RegExp(`\\b(?:confirmed|verified|proven|definite(?:ly)?|certain(?:ly)?|${FINITE_CONFIRM}|${ADJECTIVE_ACTIVE}|(?<!\\b(?:may|might|could)\\s(?:\\w+\\s){0,2})(?:is|are|was|were|has|have|had|remains?|remained|stays?|stayed|keeps?|kept|continues?|continued)\\s+(?:\\w+\\s+){0,6}?active${PREDICATIVE_ACTIVE})\\b`, 'i');
// "and" joins two independent clauses only when each side has its own finite
// verb ("The schedule was confirmed and large patch remains only a possibility");
// a compound subject ("Large patch and dollar spot are confirmed") stays whole.
// A modal ('may be present', 'could be spreading') is a finite verb too.
const FINITE_VERB = /\b(?:is|are|was|were|has|have|had|remains?|remained|appears?|appeared|looks?|looked|stays?|stayed|seems?|seemed|continues?|continued|keeps?|kept|may|might|could|can|should|would|will|must|shall|\w+ed)\b/i;
function splitIndependentAnd(clause) {
  const out = [];
  let buffer = '';
  for (const part of clause.split(/\s+and\s+/i)) {
    if (buffer && FINITE_VERB.test(buffer) && FINITE_VERB.test(part)) { out.push(buffer); buffer = part; continue; }
    buffer = buffer ? `${buffer} and ${part}` : part;
  }
  if (buffer) out.push(buffer);
  return out;
}
function residualDefinitiveClaim(text) {
  // Clause-level, so "The schedule was confirmed with the customer, while large
  // patch remains only a possibility" is not read as a confirmed cause. A comma
  // pair is a parenthetical, not a clause break: its commas are dropped but the
  // text is kept, so "Large patch, in the shaded area, is confirmed" and "Large
  // patch, which is confirmed in the shade, is spreading" both keep the cause
  // and the definitive predicate in one clause.
  // Only a relative or prepositional parenthetical is flattened; a coordinated
  // independent clause ("…, the controller was adjusted, and …") keeps its
  // commas so an unrelated "confirmed" is not attached to a tentative cause.
  // A heading-style "Confirmed:" attaches to the clause that follows it.
  const flattened = String(text || '')
    .replace(/(^|[.!?;]\s*)(confirmed|definite|certain)\s*[:—–-]\s*/gi, '$1$2 ')
    // Cause-first headings: "Large patch: confirmed", "Chinch bugs — active".
    .replace(new RegExp(`\\s*[:—–-]\\s*(?=(?:\\w+\\s+){0,2}?active\\b${PREDICATIVE_ACTIVE})`, 'gi'), ' is ')
    .replace(/\s*[:—–-]\s*(?=(?:\w+\s+){0,2}?(?:confirmed|definite(?:ly)?|certain(?:ly)?)\b)/gi, ' ')
    .replace(/,\s((?:which|that|who|where|as|especially|particularly|mostly|mainly|in|on|at|near|along|by|with|including|like|such as|now|still|again)\b[^,.!?;:]{0,80}),\s/gi, ' $1 ');
  return flattened.split(/[.!?;,:]\s*|\s+(?:while|but|although|though|whereas|however)\s+/i).flatMap(splitIndependentAnd).some((clause) => (
    DEFINITIVE_PREDICATE.test(clause) && SUMMARY_CAUSE_RE.test(clause)
  ));
}

function safeCustomerSummary(summary, confidence) {
  const scrubbed = scrubCustomerText(summary);
  if (!scrubbed) return null;
  if (confidenceRank(confidence) < CONFIDENCE_ORDER.moderate && SUMMARY_CAUSE_RE.test(scrubbed)) {
    return GENERIC_LOW_CONFIDENCE_SUMMARY;
  }
  if (residualDefinitiveClaim(scrubbed)) return GENERIC_LOW_CONFIDENCE_SUMMARY;
  return scrubbed;
}

// Safe wording used when inputs are too poor to defend any diagnosis. Names no
// pest or disease; states what was checked and what to watch.
const MINIMAL_SAFE_SUMMARY = 'This lawn check is complete. The photos provided did not show enough detail to call out a specific pest or disease, so we are not naming one from these images. The best next step is a quick on-site look; in the meantime, keep to your normal watering schedule and watch for any area that spreads, thins, or does not recover.';

// Canonical "we looked and saw no defensible issue" finding name. classifyReleaseMode
// maps it to the clean minimal/no-diagnosis path. Exported so degraded-path producers
// (e.g. the multi-model perception→symptom downgrade) name a healthy finding identically
// — single source of truth, no drift.
const NO_VISIBLE_STRESS_FINDING = 'No major visible lawn stress signal';
const NO_FINDING_KEY = normalizeKey(NO_VISIBLE_STRESS_FINDING);

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

// The summary gate and confirmation-language scrub use the same governed
// vocabulary, so a plural or deficiency cannot bypass one of the two screens.

// Downgrade any over-confident pest/disease/drought wording to suggestive form.
// Safety net for LLM-authored copy; deterministic copy never says "confirmed".
// The predicate passes allow up to three adverb/auxiliary tokens between the verb
// and "confirmed" / "active" ("has just been confirmed", "is currently confirmed",
// "are clearly active") — any -ly word or a short function-word set — rather than
// a closed adverb list.
// A historical qualifier in the adverb run ("were previously active", "had
// historically been confirmed") keeps its tense through the downgrade, so a
// resolved past claim never becomes a present possibility that contradicts the
// rest of the sentence ("…, but none are present now"). The same holds when the
// matched linker itself is past tense ("were active yesterday"). Simple aspectual
// linkers ("remain active", "stays active", "continue to be active") are
// downgraded like the copulas.
const HISTORICAL_QUALIFIER = /\b(previously|formerly|historically|initially|originally)\b/i;
const PREDICATE_LINKER = '(?<linker>is|are|was|were|has|have|had|remains?|remained|stays?|stayed|continues?\\s+(?:to\\s+be|being)|continued\\s+(?:to\\s+be|being)|keeps?\\s+being|kept\\s+being)';
const PAST_LINKER = /^(?:was|were|had|remained|stayed|continued|kept)\b/i;
const PLURAL_LINKER = /^(?:are|have|remain|stay|continue|keep)\b/i;
// The cause plus any consumed noun phrase (short parenthetical, activity/damage/…
// suffix) is kept in the rewrite so the published sentence keeps its subject:
// "Fungal activity is confirmed in the shade" → "Fungal activity appears most
// consistent with the visible pattern in the shade".
const CAUSE_PREFIX = `\\b(${SUMMARY_CAUSE_RE.source})(?<phrase>(?:\\s*\\([^()]{1,40}\\))?(?:\\s+(?:activity|damage|pressure|presence|signs?|evidence|symptoms?|feeding|population|outbreak|disease|infestation|stress|spots?))*)\\s+${PREDICATE_LINKER}`;
const CONFIRMED_PREDICATE = new RegExp(`${CAUSE_PREFIX}(?<adverbs>(?:\\s+(?:been|now|also|already|just|again|still|since|yet|only|\\w+ly)){0,6})\\s+(?:confirmed|verified|proven|proved)\\b`, 'gi');
const ACTIVE_PREDICATE = new RegExp(`${CAUSE_PREFIX}(?<adverbs>(?:\\s+(?:been|remained|stayed|kept|now|also|already|just|again|still|very|highly|only|\\w+ly)){0,6})\\s+active\\b${PREDICATIVE_ACTIVE}`, 'gi');
// Named groups survive SUMMARY_CAUSE_RE's own groups; the cause is always $1.
function predicateParts(args) {
  const groups = args[args.length - 1];
  const historical = HISTORICAL_QUALIFIER.exec(groups.adverbs || '');
  const qualifier = historical ? `${historical[1].toLowerCase()} ` : '';
  const linker = groups.linker || '';
  const past = PAST_LINKER.test(linker) || !!historical;
  const appears = past ? 'appeared' : (PLURAL_LINKER.test(linker) ? 'appear' : 'appears');
  return { subject: `${args[1]}${groups.phrase || ''}`, qualifier, past, appears };
}
function stripConfirmedLanguage(text) {
  if (!text) return text;
  return String(text).replace(/\s+/g, ' ')
    // A finite confirmation verb becomes a suggestion verb ('The photos confirm
    // chinch bug activity' → 'The photos suggest chinch bug activity'); a request
    // to confirm is left alone.
    .replace(new RegExp(`${NOT_A_CLAIM}\\b(confirm(?:s|ed|ing)?|verif(?:y|ies|ied|ying)|prov(?:e|es|ed|en|ing))\\b${CAUSE_AHEAD}`, 'gi'),
      (verb) => (/(?:ies|s)$/i.test(verb) ? 'suggests' : /(?:ied|ed|en)$/i.test(verb) ? 'suggested' : /ing$/i.test(verb) ? 'suggesting' : 'suggest'))
    // "Confirmed chinch bugs", the heading form "Confirmed: chinch bugs", and
    // the cause a short noun phrase away ("Active colonies of chinch
    // bugs remain" → "suspected colonies of chinch bugs remain").
    .replace(new RegExp(`\\b(?:confirmed|verified|proven|active${PREDICATIVE_ACTIVE}|definite(?:ly)?|certain(?:ly)?)\\s*(?:[:—–-]\\s*)?((?:${NOUN_WORD}\\s+){0,2}?(?:of\\s+)?${SUMMARY_CAUSE_RE.source})`, 'gi'),
      (match, noun) => `suspected ${noun}`)
    .replace(CONFIRMED_PREDICATE, (...args) => {
      const { subject, qualifier, appears } = predicateParts(args);
      return `${subject} ${qualifier}${appears} most consistent with the visible pattern`;
    })
    // Cause-first active predicate ("Chinch bugs are active along the edge"). Both
    // predicate passes accept a short parenthetical after the cause
    // ("Large patch (Rhizoctonia) is confirmed").
    .replace(ACTIVE_PREDICATE, (...args) => {
      const { subject, qualifier, past } = predicateParts(args);
      return past ? `${subject} may have been ${qualifier}active` : `${subject} may be active`;
    })
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
// International (+ or 00 followed by 7–15 digits with optional separators), North
// American ten-digit, and local seven-digit forms. A seven-digit "555-0100" is
// removed even though a rare size range could look like it: a leaked contact
// number is the worse failure on a customer-facing surface.
const CUSTOMER_TEXT_PHONE = /(?:\+|\b00[\s.-]?)\d(?:[\s.()-]*\d){6,14}\b|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{3}[\s.-]\d{4}\b/g;

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
  buildWatchItems,
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
  residualDefinitiveClaim,
  spaceJoinedNon,
  stripNegatedRecovery,
  stripIntensifierNot,
  CONDITION_LABEL_VALUES,
  safeCustomerSummary,
  SUMMARY_CAUSE_RE,
  lowerConfidence,
  MINIMAL_SAFE_SUMMARY,
  NO_VISIBLE_STRESS_FINDING,
};
