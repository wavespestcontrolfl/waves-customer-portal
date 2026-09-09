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
  const scrubbed = scrubCustomerText(text || '').slice(0, 600).trim();
  if (!scrubbed || unpublishableCustomerCopy(scrubbed)) return NO_OBSERVATIONS;
  if (namesUnpublishedCause(scrubbed, findings)) return NO_OBSERVATIONS;
  return scrubbed;
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
const CAUSE_TERM_SYNONYMS = { fungus: 'fungal', fungi: 'fungal', disease: 'disease', mold: 'fungal', mildew: 'fungal' };
const causeTerm = (term) => {
  const base = String(term || '').toLowerCase().replace(/gr[ae]y/, 'gray').replace(/[\s‐‑‒–—-]+/g, ' ').replace(/\bpatches\b/g, 'patch').replace(/\bsod ?webworms?\b/g, 'sod webworm').replace(/\barmy ?worms?\b/g, 'armyworm').replace(/\bchinch ?bugs?\b/g, 'chinch');
  if (CAUSE_TERM_SYNONYMS[base]) return CAUSE_TERM_SYNONYMS[base];
  return /(?:ss|us|is)$/.test(base) ? base : base.replace(/(?<=[a-z])s$/, '');
};
function governedTerms(text) {
  const terms = new Set();
  const re = new RegExp(SUMMARY_CAUSE_RE.source, 'gi');
  let match;
  while ((match = re.exec(String(text || ''))) !== null) terms.add(causeTerm(match[1]));
  return terms;
}
function namesUnpublishedCause(text, findings) {
  const published = new Set();
  for (const finding of findings || []) {
    if (!finding || !finding.label || (CONFIDENCE_RANK[String(finding.confidence || '').toLowerCase()] ?? 0) < CONFIDENCE_RANK.moderate) continue;
    // A negated technician detail names the cause it ruled OUT — it publishes nothing.
    if (finding.negated || finding.label === NO_STRESS_LABEL) continue;
    // A mixed/negated name cannot establish positive evidence for prose.
    // Keep it internal until review supplies an unambiguous finding.
    if (/\b(?:no|not|none|cannot|\w+n['’]t|without|ruled out|negative|absent|unlikely|excluded|free)\b/i.test(finding.name || '')) continue;
    for (const term of governedTerms(`${finding.name || ''} ${finding.label}`)) published.add(term);
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
  const scrubbed = scrubCustomerText(text || '').slice(0, 200).trim();
  if (!scrubbed || unpublishableCustomerCopy(scrubbed)) return '';
  return namesUnpublishedCause(scrubbed, [finding]) ? '' : scrubbed;
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
