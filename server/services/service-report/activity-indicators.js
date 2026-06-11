/**
 * Activity indicators + typed-findings snapshot builder for specialty
 * service completions (the 13 project types routed through the standard
 * Service Report V1 pipeline).
 *
 * Single source of truth for:
 *   - which project types get an activity gauge and under which label
 *   - findings-select → 0-5 score derivation (prefill; tech always wins)
 *   - score → customer wording (never show a raw number)
 *   - technician field labels → customer-facing report labels/values
 *   - typed-findings validation (required flags, unknown keys, score shape)
 *   - the persisted `typedReportSnapshot` (service_data) including the
 *     generated Today's Result copy — reports render from this snapshot
 *     forever; never recompute customer copy from live templates.
 *
 * Contract: docs/design/specialty-service-completion-contract.md
 */

const { PROJECT_TYPES, isValidProjectType } = require('../project-types');

const SCHEMA_VERSION = 1;
const COPY_MAP_VERSION = 1;
const SUMMARY_TEMPLATE_VERSION = 1;

// Customer wording per score. Never expose the numeric score in customer
// copy; banned-words rule (no "clear"/"eliminated"/"no infestation") applies.
const SCORE_LEVEL_WORDS = {
  0: 'No active signs observed today',
  1: 'Very low activity',
  2: 'Low activity',
  3: 'Moderate activity',
  4: 'High activity',
  5: 'Severe activity',
};

const TECH_SCORE_LABELS = {
  0: 'None',
  1: 'Very low',
  2: 'Low',
  3: 'Moderate',
  4: 'High',
  5: 'Severe',
};

// Shared 4-level select derivation (registry option string → score).
const LEVEL_SELECT_SCORES = {
  'None observed': 0,
  Low: 1,
  Moderate: 3,
  Heavy: 4,
  Severe: 5,
};

/**
 * Per-project-type indicator config.
 *   indicatorKey  — service_activity_scores key; shared across related types
 *                   so trends accrue per program (rodent trap + exclusion,
 *                   termite inspection + treatment).
 *   label         — customer-facing gauge label.
 *   pestNoun      — noun for Today's Result copy ("Cockroach activity was…").
 *   derive        — { field, scores } findings-select prefill, or null
 *                   (tech-set only).
 * Types without an entry get no gauge (one-shot treatments + inspections
 * per the contract).
 */
const ACTIVITY_INDICATORS = {
  rodent_trapping: {
    indicatorKey: 'rodent_activity',
    label: 'Rodent Activity',
    pestNoun: 'Rodent',
    derive: null,
  },
  rodent_exclusion: {
    indicatorKey: 'rodent_activity',
    label: 'Rodent Activity',
    pestNoun: 'Rodent',
    derive: null,
  },
  wildlife_trapping: {
    indicatorKey: 'wildlife_activity',
    label: 'Wildlife Activity',
    pestNoun: 'Wildlife',
    derive: null,
  },
  bed_bug: {
    indicatorKey: 'bed_bug_activity',
    label: 'Bed Bug Activity',
    pestNoun: 'Bed bug',
    derive: {
      field: 'evidence_level',
      scores: {
        'No active signs observed': 0,
        'Low (few bugs)': 1,
        Moderate: 3,
        Heavy: 4,
        'Severe infestation': 5,
      },
    },
  },
  cockroach: {
    indicatorKey: 'roach_activity',
    label: 'Roach Activity',
    pestNoun: 'Cockroach',
    derive: { field: 'activity_level', scores: LEVEL_SELECT_SCORES },
  },
  flea: {
    indicatorKey: 'flea_activity',
    label: 'Flea Activity',
    pestNoun: 'Flea',
    derive: { field: 'evidence_level', scores: LEVEL_SELECT_SCORES },
  },
  termite_inspection: {
    indicatorKey: 'termite_activity',
    label: 'Termite Activity',
    pestNoun: 'Termite',
    derive: {
      field: 'activity_status',
      scores: {
        'No activity': 0,
        'Old / inactive damage': 1,
        'Active infestation': 4,
      },
    },
  },
  termite_treatment: {
    indicatorKey: 'termite_activity',
    label: 'Termite Activity',
    pestNoun: 'Termite',
    derive: null,
  },
};

// Technician registry label → customer report label. Fields not listed fall
// back to a humanized registry label (flagged in golden-fixture review).
const CUSTOMER_FIELD_LABELS = {
  activity_level: 'Activity observed',
  evidence_level: 'Activity observed',
  severity: 'Activity observed',
  activity_status: 'Activity observed',
  activity_found: 'Activity observed',
  areas_inspected: 'Areas we checked',
  inspection_scope: 'Areas we checked',
  areas_treated: 'Areas we treated',
  treatment_areas: 'Areas we treated',
  rooms_treated: 'Areas we treated',
  harborage_locations: 'Where activity was concentrated',
  conducive_conditions: 'Conditions to address',
  treatment_performed: 'What we did',
  treatment_method: 'Treatment method',
  products_used: 'Products applied',
  bait_or_products_used: 'Products applied',
  prep_for_customer: 'What you can do',
  customer_instructions: 'What you can do',
  followup_plan: 'Next steps',
  daily_check_plan: 'Next steps',
  entry_points_found: 'Entry points we found',
  entry_points_observed: 'Entry points we found',
  traps_set: 'Traps in place',
  species: 'What we found',
  target_animal: 'What we found',
  target_pest: 'What we found',
  termite_type: 'What we found',
  target_termite: 'Target organism',
  pests_identified: 'What we found',
  sanitation_or_damage_notes: 'Damage & conditions noted',
  property_damage: 'Damage & conditions noted',
  infestation_extent: 'Extent of activity',
  treatment_recommendation: 'Recommended treatment',
  recommendation: 'Recommended next step',
  exclusion_completed: 'Sealing work completed',
  exclusion_pending: 'Sealing work still scheduled',
  standing_water_sources: 'Mosquito breeding sources found',
  condition_found: 'What we observed',
  turf_type: 'Lawn type',
  irrigation_or_cultural_notes: 'Watering & care notes',
  host_activity: 'Activity notes',
  event_context: 'Service context',
  weather_notes: 'Weather notes',
  palm_species: 'What we treated',
  palm_count: 'Palms treated',
  linear_feet_or_stations: 'Linear feet / stations',
  gallons_or_amount: 'Amount applied',
};

// Registry select value → customer wording, keyed per field family. Values
// not listed pass through verbatim.
const CUSTOMER_VALUE_LABELS = {
  species: {
    German: 'German cockroaches',
    American: 'American cockroaches (palmetto bugs)',
    'Smoky brown': 'Smoky brown cockroaches',
    'Roof rat': 'Roof rats',
    'Norway rat': 'Norway rats',
    'House mouse': 'House mice',
    Mixed: 'Mixed species',
    Unknown: 'Species not yet confirmed',
  },
  activity_level: {
    'None observed': 'No active signs observed today',
    Low: 'Low activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
  },
  evidence_level: {
    'None observed': 'No active signs observed today',
    'No active signs observed': 'No active signs observed today',
    'Low (few bugs)': 'Low activity',
    Low: 'Low activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
    'Severe infestation': 'Severe activity',
  },
  severity: {
    'None observed': 'No active signs observed today',
    Low: 'Low activity',
    Moderate: 'Moderate activity',
    Heavy: 'High activity',
    Severe: 'Severe activity',
  },
  activity_status: {
    'No activity': 'No active signs observed today',
    'Old / inactive damage': 'Older, inactive damage only',
    'Active infestation': 'Active termite activity found',
  },
  treatment_method: {
    'Chemical only': 'Chemical treatment',
    'Heat only': 'Heat treatment',
    'Chemical + heat': 'Combined chemical and heat treatment',
    'Steam + chemical': 'Combined steam and chemical treatment',
  },
};

// Required service-specific fields per type (contract §4; budget ≤4 except
// the Tier-3 compliance type). Enforcement is keyed to the profile cutover
// state by the caller — the registry itself stays permissive.
const REQUIRED_FINDINGS_FIELDS = {
  pest_inspection: ['severity'],
  one_time_pest_treatment: ['activity_level'],
  mosquito_event: [],
  palm_injection: [],
  one_time_lawn_treatment: [],
  cockroach: ['species', 'activity_level'],
  flea: ['evidence_level'],
  rodent_trapping: ['species'],
  rodent_exclusion: ['species'],
  wildlife_trapping: [],
  bed_bug: ['evidence_level', 'treatment_method'],
  termite_inspection: ['termite_type', 'activity_status'],
  termite_treatment: [
    'target_termite',
    'treatment_method',
    'products_used',
    'linear_feet_or_stations',
    'gallons_or_amount',
  ],
};

// Next-step chips per type (contract §7). Each chip maps to the
// deterministic next-step sentence used in Today's Result.
const NEXT_STEP_CHIPS = {
  'No action needed': 'No further action is needed right now.',
  'Monitor activity': 'Monitor for activity and contact us if anything returns.',
  'Sanitation recommended': 'Improving sanitation in the noted areas will help keep activity down.',
  'Reduce moisture': 'Reducing moisture in the noted areas will help keep activity down.',
  'Seal entry gaps': 'Sealing the noted entry gaps will help prevent re-entry.',
  'Remove cardboard/clutter': 'Removing cardboard and clutter will remove harborage for pests.',
  'Keep treated areas undisturbed': 'Please keep treated areas undisturbed so the treatment can work.',
  'Follow-up recommended': 'A follow-up visit is recommended — we will help you get it scheduled.',
  'Vacuum daily for 2 weeks': 'Vacuum daily for the next two weeks to remove emerging fleas.',
  'Wash pet bedding': 'Wash pet bedding on high heat.',
  'Coordinate vet flea control': 'Coordinate flea prevention for pets with your veterinarian.',
  'Stay off treated areas until dry': 'Stay off treated areas until they are fully dry.',
  'Trap check scheduled': 'We will return for the scheduled trap check.',
  'Seal entry points': 'Sealing the identified entry points is the key next step.',
  'Monitor for new activity': 'Monitor for new activity and let us know if anything changes.',
  'Exclusion work scheduled': 'The entry-point sealing work is scheduled.',
  'Daily trap checks underway': 'Daily trap checks are underway as required.',
  'Avoid trap area': 'Please avoid the trap area so the trap can do its job.',
  'Secure trash/food sources': 'Securing trash and outdoor food sources will reduce wildlife pressure.',
  'Follow prep sheet': 'Please follow the prep sheet before the next visit.',
  'Wash/dry bedding on high heat': 'Wash and dry bedding on high heat.',
  '14-day follow-up scheduled': 'Your 14-day follow-up visit will confirm the treatment is working.',
  'Continue monitoring': 'Continue monitoring and contact us if activity returns.',
  'Dump standing water weekly': 'Dump standing water around the property weekly.',
  'Avoid treated foliage until dry': 'Avoid treated foliage until it is fully dry.',
  'Follow watering guidance': 'Follow the watering guidance in this report.',
  'Mow guidance provided': 'Follow the mowing guidance in this report.',
  'Re-check scheduled': 'We will re-check the treated areas on the scheduled visit.',
  'Retreatment scheduled': 'Retreatment is scheduled to keep protection current.',
  'Monitor fronds for change': 'Monitor the fronds for change and let us know what you see.',
};

const MAX_NEXT_STEP_CHIPS = 4;

// Per-type chip allowlists (contract §7) — the global map alone would let a
// cockroach completion persist lawn/mosquito guidance into the immutable
// snapshot. Schema serving and validation both use the type's list.
const PEST_FAMILY_CHIPS = [
  'No action needed', 'Monitor activity', 'Sanitation recommended',
  'Reduce moisture', 'Seal entry gaps', 'Remove cardboard/clutter',
  'Keep treated areas undisturbed', 'Follow-up recommended',
];
const RODENT_FAMILY_CHIPS = [
  'No action needed', 'Trap check scheduled', 'Seal entry points',
  'Sanitation recommended', 'Monitor for new activity', 'Exclusion work scheduled',
  'Follow-up recommended',
];
const TYPE_NEXT_STEP_CHIPS = {
  pest_inspection: PEST_FAMILY_CHIPS,
  one_time_pest_treatment: PEST_FAMILY_CHIPS,
  cockroach: PEST_FAMILY_CHIPS,
  flea: [
    'No action needed', 'Vacuum daily for 2 weeks', 'Wash pet bedding',
    'Coordinate vet flea control', 'Stay off treated areas until dry',
    'Follow-up recommended', 'Monitor activity',
  ],
  rodent_trapping: RODENT_FAMILY_CHIPS,
  rodent_exclusion: RODENT_FAMILY_CHIPS,
  wildlife_trapping: [
    'No action needed', 'Daily trap checks underway', 'Avoid trap area',
    'Secure trash/food sources', 'Monitor for new activity',
  ],
  bed_bug: [
    'Follow prep sheet', 'Wash/dry bedding on high heat',
    '14-day follow-up scheduled', 'Continue monitoring',
  ],
  mosquito_event: [
    'No action needed', 'Dump standing water weekly', 'Avoid treated foliage until dry',
  ],
  one_time_lawn_treatment: [
    'No action needed', 'Follow watering guidance', 'Mow guidance provided', 'Re-check scheduled',
  ],
  palm_injection: [
    'No action needed', 'Retreatment scheduled', 'Monitor fronds for change',
  ],
  termite_inspection: ['No action needed', 'Monitor activity', 'Follow-up recommended'],
  termite_treatment: ['No action needed', 'Monitor activity', 'Follow-up recommended'],
};

function chipsForType(projectType) {
  return TYPE_NEXT_STEP_CHIPS[projectType] || [];
}

function getActivityIndicator(projectType) {
  return ACTIVITY_INDICATORS[projectType] || null;
}

function isTypedFindingsType(projectType) {
  return isValidProjectType(projectType);
}

function scoreLevelWord(score) {
  return SCORE_LEVEL_WORDS[score] ?? null;
}

/**
 * Findings-derived prefill score for a type, or null when the type has no
 * derivation (tech-set only) or the source field has no recognized value.
 */
function deriveActivityScore(projectType, values = {}) {
  const indicator = ACTIVITY_INDICATORS[projectType];
  if (!indicator || !indicator.derive) return null;
  const raw = values[indicator.derive.field];
  if (raw == null || raw === '') return null;
  const score = indicator.derive.scores[String(raw)];
  if (score == null) return null;
  return {
    score,
    field: indicator.derive.field,
    value: String(raw),
  };
}

function humanizeFieldKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function customerLabelForField(fieldKey, technicianLabel) {
  return CUSTOMER_FIELD_LABELS[fieldKey] || technicianLabel || humanizeFieldKey(fieldKey);
}

function customerLabelForValue(fieldKey, value) {
  const map = CUSTOMER_VALUE_LABELS[fieldKey];
  if (map && Object.prototype.hasOwnProperty.call(map, String(value))) {
    return map[String(value)];
  }
  return String(value);
}

/**
 * Validate a typed-findings submission against the registry.
 *
 * @param {object} opts
 * @param {string} opts.type            submitted structuredFindings.type
 * @param {object} opts.values          submitted field values
 * @param {string} opts.expectedType    profile.findingsType for the job
 * @param {boolean} opts.enforceRequired whether required-field gating applies
 *                                      (true once the type is cut over AND the
 *                                      client submitted typed findings)
 * @returns {{ ok: boolean, errors: string[], missing: string[] }}
 */
function validateTypedFindings({ type, values, expectedType, enforceRequired = false } = {}) {
  const errors = [];
  const missing = [];

  if (!type || !isValidProjectType(type)) {
    return { ok: false, errors: [`Unknown findings type: ${type}`], missing };
  }
  if (expectedType && type !== expectedType) {
    return {
      ok: false,
      errors: [`Findings type ${type} does not match this service's expected type ${expectedType}`],
      missing,
    };
  }
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, errors: ['structuredFindings.values must be an object'], missing };
  }

  const fields = PROJECT_TYPES[type].findingsFields || [];
  const knownKeys = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!knownKeys.has(key)) errors.push(`Unknown findings field: ${key}`);
  }
  for (const field of fields) {
    const value = values[field.key];
    if (value == null || value === '') continue;
    if (field.type === 'select' && Array.isArray(field.options) && field.options.length) {
      if (!field.options.includes(String(value))) {
        errors.push(`Invalid value for ${field.key}: ${value}`);
      }
    }
    if (typeof value === 'string' && value.length > 4000) {
      errors.push(`Value for ${field.key} exceeds 4000 characters`);
    }
  }

  if (enforceRequired) {
    for (const key of REQUIRED_FINDINGS_FIELDS[type] || []) {
      const value = values[key];
      if (value == null || String(value).trim() === '') missing.push(key);
    }
  }

  return { ok: errors.length === 0 && missing.length === 0, errors, missing };
}

function validateNextStepChips(chips, projectType = null) {
  if (chips == null) return { ok: true, chips: [] };
  if (!Array.isArray(chips)) return { ok: false, error: 'nextStepChips must be an array' };
  if (chips.length > MAX_NEXT_STEP_CHIPS) {
    return { ok: false, error: `At most ${MAX_NEXT_STEP_CHIPS} next-step chips allowed` };
  }
  const allowed = projectType ? chipsForType(projectType) : Object.keys(NEXT_STEP_CHIPS);
  const normalized = [];
  for (const chip of chips) {
    const key = String(chip || '').trim();
    if (!key) continue;
    if (!allowed.includes(key)) {
      return { ok: false, error: `Next-step chip not available for this service: ${key}` };
    }
    if (!normalized.includes(key)) normalized.push(key);
  }
  return { ok: true, chips: normalized };
}

function trendWordForScores(score, priorScore) {
  if (priorScore == null) return null;
  if (score < priorScore) return 'decreased since the last visit';
  if (score > priorScore) return 'increased since the last visit';
  return 'about the same as the last visit';
}

function trendDirection(score, priorScore) {
  if (priorScore == null) return null;
  if (score < priorScore) return 'improving';
  if (score > priorScore) return 'worsening';
  return 'stable';
}

function firstSentenceFrom(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const period = text.endsWith('.') ? '' : '.';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${period}`;
}

function nextStepSentence(chips = []) {
  const sentences = chips
    .map((chip) => NEXT_STEP_CHIPS[chip])
    .filter(Boolean);
  if (!sentences.length) return 'Contact us if you have any questions.';
  return sentences.join(' ');
}

/**
 * Deterministic Today's Result copy (contract §6). AI may later polish the
 * recommendations field, but this template output always exists and always
 * sends — AI is never in the critical path.
 */
function buildTodaysResult({
  projectType,
  reportTypeLabel,
  values = {},
  chips = [],
  activity = null,
  visitSequence = 1,
}) {
  const indicator = ACTIVITY_INDICATORS[projectType];
  const whatWeDid = firstSentenceFrom(
    values.treatment_performed || values.exclusion_completed || values.areas_treated || values.traps_set,
    'We completed the scheduled service.'
  );
  const nextStep = nextStepSentence(chips);

  // Bed bug zero state uses fixed, approved copy (contract §6).
  if (projectType === 'bed_bug' && activity && activity.score === 0) {
    return {
      headline: "No active signs observed during today's service.",
      body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
      nextStep,
    };
  }

  if (indicator && activity && activity.score != null) {
    const noun = indicator.pestNoun;
    if (visitSequence > 1 && activity.trendWord) {
      // Stable needs its own sentence shape — "has about the same as the
      // last visit since our last visit" is not English (Codex P2).
      const headline = activity.trend === 'stable'
        ? `${noun} activity is about the same as our last visit.`
        : `${noun} activity has ${activity.trend === 'worsening' ? 'increased' : 'decreased'} since our last visit.`;
      return {
        headline,
        body: `${whatWeDid} ${nextStep}`,
        nextStep,
      };
    }
    if (activity.score === 0) {
      return {
        headline: `No active signs of ${noun.toLowerCase()} activity observed today.`,
        body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
        nextStep,
      };
    }
    const levelWord = SCORE_LEVEL_WORDS[activity.score] || 'activity';
    return {
      headline: `${noun} activity was ${levelWord.replace(' activity', '').toLowerCase()} today.`,
      body: `${whatWeDid} ${nextStep}`,
      nextStep,
    };
  }

  // Non-gauge types (one-shot treatments + pest inspection).
  const zeroSeverity = ['None observed', 'No activity'].includes(
    String(values.severity || values.activity_level || '')
  );
  if (zeroSeverity) {
    return {
      headline: 'No active signs of pest activity observed today.',
      body: `${whatWeDid} Continue monitoring and contact us if activity returns.`,
      nextStep,
    };
  }
  return {
    headline: `${reportTypeLabel} completed today.`,
    body: `${whatWeDid} ${nextStep}`,
    nextStep,
  };
}

/**
 * Build the persisted typedReportSnapshot. The report renders from this
 * forever — every customer-facing label/value is resolved HERE, at
 * completion time, and versioned.
 *
 * Zero-state rule: only null/undefined/'' are skipped when building items.
 * 0, false, and "none"-class select values are results and are included.
 */
function buildTypedReportSnapshot({
  projectType,
  values = {},
  nextStepChips = [],
  serviceKey = null,
  serviceLabel = null,
  visitSequence = 1,
  activity = null,
}) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;

  const reportTypeLabel = serviceLabel
    ? `${serviceLabel} Summary`
    : `${config.label} Summary`;
  const resolvedReportTypeLabel = visitSequence > 1 && ACTIVITY_INDICATORS[projectType]
    ? `${ACTIVITY_INDICATORS[projectType].pestNoun} Program — Progress Visit`
    : reportTypeLabel;

  const items = [];
  for (const field of config.findingsFields || []) {
    const value = values[field.key];
    if (value == null || value === '') continue;
    items.push({
      fieldKey: field.key,
      technicianLabel: field.label,
      customerLabel: customerLabelForField(field.key, field.label),
      value,
      customerValueLabel: customerLabelForValue(field.key, value),
    });
  }

  const todaysResult = buildTodaysResult({
    projectType,
    reportTypeLabel: resolvedReportTypeLabel,
    values,
    chips: nextStepChips,
    activity,
    visitSequence,
  });

  return {
    type: projectType,
    typeLabel: config.label,
    schemaVersion: SCHEMA_VERSION,
    copyMapVersion: COPY_MAP_VERSION,
    summaryTemplateVersion: SUMMARY_TEMPLATE_VERSION,
    serviceKey,
    serviceLabel,
    reportTypeLabel: resolvedReportTypeLabel,
    visitSequence,
    values,
    nextStepChips,
    todaysResult,
    findings: items,
    activity: activity
      ? {
        indicatorKey: activity.indicatorKey,
        label: activity.label,
        score: activity.score,
        levelWord: SCORE_LEVEL_WORDS[activity.score] ?? null,
        source: activity.source,
        derivedFrom: activity.derivedFrom || null,
        trend: activity.trend || null,
        trendWord: activity.trendWord || null,
      }
      : null,
  };
}

/**
 * Findings-schema slice served to completion clients (embedded in the
 * dispatch jobs payload so mobile completion never blocks on a registry
 * fetch).
 */
function findingsSchemaForType(projectType) {
  const config = PROJECT_TYPES[projectType];
  if (!config) return null;
  const indicator = ACTIVITY_INDICATORS[projectType] || null;
  return {
    type: projectType,
    label: config.label,
    schemaVersion: SCHEMA_VERSION,
    copyMapVersion: COPY_MAP_VERSION,
    fields: (config.findingsFields || []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      options: f.options || null,
      placeholder: f.placeholder || null,
      required: (REQUIRED_FINDINGS_FIELDS[projectType] || []).includes(f.key),
    })),
    photoCategories: config.photoCategories || [],
    requiredFields: REQUIRED_FINDINGS_FIELDS[projectType] || [],
    nextStepChips: chipsForType(projectType),
    activity: indicator
      ? {
        indicatorKey: indicator.indicatorKey,
        label: indicator.label,
        deriveField: indicator.derive?.field || null,
        deriveScores: indicator.derive?.scores || null,
        techScoreLabels: TECH_SCORE_LABELS,
      }
      : null,
  };
}

// Customer-copy claims the business never makes (contract §6/§9): absence
// wording must stay observational ("no active signs observed today"), never
// absolute or promissory. Used to validate AI-drafted recommendations before
// they can reach a customer-facing report. Bare "clear" is deliberately NOT
// matched — "clear food debris" is legitimate sanitation advice.
const BANNED_CUSTOMER_COPY = [
  /\beliminated\b/i,
  /\beradicated\b/i,
  /\bexterminated\b/i,
  /\bguarantee[ds]?\b/i,
  /\bno infestation\b/i,
  /\bpest[- ]free\b/i,
  /\ball clear\b/i,
  /\bcleared up\b/i,
  /\bresolved\b/i,
  /\bgone\b/i,
];

function findBannedCustomerCopy(text) {
  const str = String(text || '');
  return BANNED_CUSTOMER_COPY
    .map((rx) => str.match(rx)?.[0] || null)
    .filter(Boolean);
}

module.exports = {
  SCHEMA_VERSION,
  BANNED_CUSTOMER_COPY,
  findBannedCustomerCopy,
  COPY_MAP_VERSION,
  SUMMARY_TEMPLATE_VERSION,
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  NEXT_STEP_CHIPS,
  TYPE_NEXT_STEP_CHIPS,
  chipsForType,
  SCORE_LEVEL_WORDS,
  TECH_SCORE_LABELS,
  getActivityIndicator,
  isTypedFindingsType,
  scoreLevelWord,
  deriveActivityScore,
  customerLabelForField,
  customerLabelForValue,
  validateTypedFindings,
  validateNextStepChips,
  trendWordForScores,
  trendDirection,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
};
