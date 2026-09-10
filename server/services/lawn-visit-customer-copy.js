/** Customer publication rules for lawn visit results and repeated reviews. */
const { scrubCustomerText, SUMMARY_CAUSE_RE } = require('./lawn-diagnostic-report');
const { containsReportAccessCode } = require('./service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('./service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('./content/content-guardrails');
const { NO_STRESS_LABEL } = require('./lawn-visit-result');

const NO_OBSERVATIONS = 'No additional observations from the photo review.';

// Free-form notes can contain private phrases and names that no name heuristic
// can enumerate. When notes informed the model, keep all generated prose in
// raw_response for staff and publish only the reviewed labels/fallback copy.
function withoutNoteInfluencedProse(analysis, notes) {
  if (!notes) return analysis;
  return {
    ...analysis,
    observations: '',
    findings: (analysis.findings || []).map((finding) => ({ ...finding, confirmation_step: '' })),
  };
}

function customerObservations(text, findings = []) {
  if (unpublishableCustomerCopy(text)) return NO_OBSERVATIONS;
  const scrubbed = scrubCustomerText(text || '');
  if (!scrubbed || unpublishableCustomerCopy(scrubbed)) return NO_OBSERVATIONS;
  if (namesUnpublishedCause(scrubbed, findings)) return NO_OBSERVATIONS;
  return publishableSlice(scrubbed, 600, findings) ?? NO_OBSERVATIONS;
}

// Display limits are applied AFTER the screens, so the cut must never manufacture
// prohibited copy: a re-entry idiom that is legal whole ("safe once dry; your
// technician confirms the timing") becomes an unconditional claim if the tail is
// cut. Cut at a sentence boundary (else a word boundary), then re-screen the
// returned value; a slice that fails falls back whole (Codex #4328 r2).
function publishableSlice(text, limit, findings) {
  const whole = String(text || '').trim();
  if (whole.length <= limit) return whole;
  let cut = whole.slice(0, limit);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence > 0) cut = cut.slice(0, sentence + 1);
  else if (cut.lastIndexOf(' ') > 0) cut = cut.slice(0, cut.lastIndexOf(' '));
  cut = cut.trim();
  if (!cut || unpublishableCustomerCopy(cut) || namesUnpublishedCause(cut, findings)) return null;
  return cut;
}

// True when the text names a governed cause (the report lane's
// SUMMARY_CAUSE_RE, kept in lockstep with the cause-mapped labels) that no
// finding publishes AT MODERATE OR BETTER. Each term is resolved through the
// same allowlist the labels came from, so "chinch pressure" is published by
// a "chinch bug activity" label and by nothing else; a term the allowlist
// does not map (insects, pests, disease as a class) is never published by
// prose. The confidence travels with the label: a weed species collapses to
// the generic "weed pressure" label the gate lets a low finding keep, so the
// label alone would authorise "nutsedge" at low confidence — the prompt's
// rule is no species below moderate, and that is applied here (Codex #4149
// r10).
// Terms are compared at their OWN specificity, never through the collapsed
// label: "nutsedge" and "clover" both collapse to "weed pressure", "iron
// deficiency" to "color and nutrient stress", so a moderate generic finding
// would otherwise authorise any species or deficiency the prose names (Codex
// #4149 r13). A prose term is published only when a moderate+ finding's own
// NAME or label carries that same governed term.
const CONFIDENCE_RANK = { unknown: 0, low: 1, moderate: 2, high: 3 };
// Generic cause words never authorize prose on their own.
const GENERIC_CAUSE_TERMS = ['insect', 'pest', 'disease', 'infestation'];
// Distinct-cause counting for a finding name. Synonyms of one cause fold together
// ("Drought stress (water stress)"), and a family's generic word is absorbed by a
// specific member ("Large patch (fungal) activity", "Armyworm caterpillars",
// "Chlorosis (iron deficiency)") — so those stay one cause, while two specific
// causes ("Large patch and dollar spot", "Chinch bugs, drought stress") are two.
const CAUSE_SYNONYMS = { 'water stress': 'drought', underwater: 'drought', wilt: 'drought', 'brown patch': 'large patch', rhizoctonia: 'large patch', mold: 'fungal', mildew: 'fungal' };
const GENERIC_FAMILY_WORDS = { fungal: 'fungal', caterpillar: 'caterpillar', worm: 'caterpillar', chlorosis: 'nutrient', sedge: 'weed', weed: 'weed' };
const SPECIFIC_FAMILY = {
  'large patch': 'fungal', 'gray leaf': 'fungal', 'dollar spot': 'fungal', 'leaf spot': 'fungal', rhizoctonia: 'fungal', 'take all': 'fungal',
  armyworm: 'caterpillar', 'sod webworm': 'caterpillar',
  'iron deficiency': 'nutrient', 'nitrogen deficiency': 'nutrient', 'magnesium deficiency': 'nutrient',
  nutsedge: 'weed', crabgrass: 'weed', dollarweed: 'weed', clover: 'weed', spurge: 'weed',
};
function distinctCauseCount(name) {
  const terms = new Set([...governedTerms(name)].filter((term) => !GENERIC_CAUSE_TERMS.includes(term)).map((term) => CAUSE_SYNONYMS[term] || term));
  const specifics = [...terms].filter((term) => !GENERIC_FAMILY_WORDS[term]);
  const coveredFamilies = new Set(specifics.map((term) => SPECIFIC_FAMILY[term]).filter(Boolean));
  const generics = [...terms].filter((term) => GENERIC_FAMILY_WORDS[term] && !coveredFamilies.has(GENERIC_FAMILY_WORDS[term]));
  return specifics.length + generics.length;
}
const CAUSE_TERM_SYNONYMS = { fungus: 'fungal', fungi: 'fungal', disease: 'disease', mold: 'fungal', mildew: 'fungal' };
const causeTerm = (term) => {
  const base = String(term || '').toLowerCase().replace(/gr[ae]y/, 'gray').replace(/[\s‐‑‒–—-]+/g, ' ').replace(/\b(gray|large|brown|dollar|leaf|water|iron|nitrogen|magnesium|take)\s*(leaf|patch|spots?|stress|deficiency|all)\b/g, '$1 $2').replace(/\bpatches\b/g, 'patch').replace(/deficiencies\b/, 'deficiency').replace(/\btake all root rot\b/, 'take all').replace(/\bunder ?water(?:ed|ing)?\b/, 'underwater').replace(/\bwilt(?:ed|ing)?\b/, 'wilt').replace(/\bsod ?webworms?\b/g, 'sod webworm').replace(/\barmy ?worms?\b/g, 'armyworm').replace(/\bchinch ?bugs?\b/g, 'chinch');
  // Singularize before the synonym lookup so "molds" folds like "mold".
  const singular = /(?:ss|us|is)$/.test(base) ? base : base.replace(/(?<=[a-z])s$/, '');
  return CAUSE_TERM_SYNONYMS[singular] || CAUSE_TERM_SYNONYMS[base] || singular;
};
function governedTerms(text) {
  const terms = new Set();
  const re = new RegExp(SUMMARY_CAUSE_RE.source, 'gi');
  let match;
  while ((match = re.exec(String(text || ''))) !== null) terms.add(causeTerm(match[1]));
  return terms;
}
// True when a reviewed finding is positive, unambiguous evidence for the causes
// its name and label carry. A negated name ("Chinch bugs weren't observed",
// "Chinch bug activity — unconfirmed", "Non-fungal stress", "Chinch bugs never observed",
// "Neither chinch bugs nor drought stress"), an unresolved differential ("Chinch
// bugs or drought stress", "chinch vs. drought", "chinch/drought", "Chinch bugs?")
// and any name carrying more than one distinct governed cause ("Chinch bugs and
// drought stress", "Chinch bugs & drought stress", "Chinch bugs, drought stress")
// established no single cause; the prompt keeps inseparable causes together, so
// such a name authorizes nothing until review picks one. One cause plus a symptom
// ("Chinch bug damage and thinning") is still a single cause.
function establishesCause(finding) {
  if (!finding || !finding.label || (CONFIDENCE_RANK[String(finding.confidence || '').toLowerCase()] ?? 0) < CONFIDENCE_RANK.moderate) return false;
  if (finding.negated || finding.label === NO_STRESS_LABEL) return false;
  const name = finding.name || '';
  if (/\b(?:no|not|none|non|never|neither|nor|cannot|\w+n['’]t|without|ruled[\s‐‑‒–—-]+out|negative|absent|unlikely|unconfirmed|excluded|free)\b/i.test(name)) return false;
  if (/\b(?:or|vs\.?|versus|either|alternatively)\b|\w\s*\/\s*\w|\?/i.test(name)) return false;
  return distinctCauseCount(name) <= 1;
}

function namesUnpublishedCause(text, findings) {
  const published = new Set();
  for (const finding of findings || []) {
    if (!establishesCause(finding)) continue;
    for (const term of governedTerms(`${finding.name || ''} ${finding.label}`)) {
      if (!GENERIC_CAUSE_TERMS.includes(term)) published.add(term);
    }
  }
  for (const term of governedTerms(text)) if (!published.has(term)) return true;
  return false;
}

// The customer-copy compliance screen every other customer surface applies,
// on top of the egress scrub: a schema-valid observation can still carry a
// banned claim the prompt only asks the model to avoid ("pet-safe",
// "EPA-approved", a fixed drying / re-entry figure — the report lane's
// re-entry predicate; "eliminated", "guaranteed", "is clear" — the report
// lane's banned-copy list). Rejected copy falls back whole: the neutral
// sentence, never a rewrite (Codex #4149 r7). An access code is rejected
// the same way.
function unpublishableCustomerCopy(text) {
  return containsReportAccessCode(text) || findBannedCustomerCopy(text).length > 0 || !!reentrySafetyClaimFinding(text);
}

function safeConfirmationStep(text, finding = null) {
  if (unpublishableCustomerCopy(text)) return '';
  const scrubbed = scrubCustomerText(text || '');
  if (!scrubbed || unpublishableCustomerCopy(scrubbed)) return '';
  if (namesUnpublishedCause(scrubbed, [finding])) return '';
  return publishableSlice(scrubbed, 200, [finding]) ?? '';
}

// lastPublished is the persisted value this module last wrote, including
// values published by an earlier technician review. The caller writes every
// non-null result to BOTH assessment.observations and the run's publication
// marker in one transaction. Missing provenance or a manual edit withdraws
// module ownership; never infer it by comparing against the initial model copy.
function reviewedObservations({ current, lastPublished, observations, findings = [] }) {
  if (typeof lastPublished !== 'string' || current !== lastPublished) return null;
  return customerObservations(observations, findings.filter((finding) => finding && finding.keep !== false));
}

module.exports = {
  NO_OBSERVATIONS,
  withoutNoteInfluencedProse,
  customerObservations,
  namesUnpublishedCause,
  governedTerms,
  unpublishableCustomerCopy,
  safeConfirmationStep,
  reviewedObservations,
};
