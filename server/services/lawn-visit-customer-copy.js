/** Customer publication rules for lawn visit results and repeated reviews. */
const { scrubCustomerText, SUMMARY_CAUSE_RE } = require('./lawn-diagnostic-report');
const { containsReportAccessCode } = require('./service-report/technician-report-copy');
const { findBannedCustomerCopy } = require('./service-report/activity-indicators');
const { reentrySafetyClaimFinding } = require('./content/content-guardrails');
const { GRASS_TYPE_LABELS } = require('./lawn-grass-context');
const { NO_STRESS_LABEL } = require('./lawn-visit-result');

const NO_OBSERVATIONS = 'No additional observations from the photo review.';

const ECHO_ALLOWLIST = new Set([
  ...Object.values(GRASS_TYPE_LABELS).flatMap((label) => label.toLowerCase().split(/[^\p{L}]+/u)),
  'florida', 'southwest', 'lawn', 'turf', 'grass', 'front', 'back', 'side', 'yard', 'photo', 'photos',
].filter(Boolean));
const ECHO_RUN_WORDS = 5;
// Words a sentence may open with in ordinary lawn notes ("Checked the back
// yard", "Chinch damage by the drive"): a sentence-initial capital on one of
// these is capitalisation, not a name; any OTHER sentence-initial capital
// the answer reproduces is treated as a name ("Kowalski reports thinning by
// the gate" — Codex #4149 r11: the first token was exempted outright).
const ECHO_COMMON_WORDS = new Set(('the a an and or but so if then this that these those there here it its is are was were be been has have had do does did '
  + 'not no yes we our i my you your they their he she his her him them who what when where which how also still just very some any all most more less much many '
  + 'new old big small good bad fine ok okay please note notes noted check checked checking saw seen see found find looks looked looking appears appeared seems seemed '
  + 'customer client owner homeowner tech technician crew visit visited service treated treatment applied application spray sprayed '
  + 'lawn turf grass yard front back side left right north south east west corner edge edges strip bed beds driveway walk walkway sidewalk street curb fence gate pool patio house home garage mailbox '
  + 'area areas spot spots patch patches zone zones section sections whole entire mostly some heavy light moderate mild severe minor major '
  + 'thin thinning bare sparse brown browning yellow yellowing green dry wet soggy dead dying damage damaged stress stressed weak healthy dense '
  + 'water watering irrigation sprinkler sprinklers rain mow mowed mowing cut scalped shade shaded sun sunny dog dogs pet pets kids traffic '
  + 'chinch bugs bug insect insects pest pests fungus fungal disease weeds weed sedge nutsedge crabgrass clover spurge dollarweed drought thatch grubs grub worms worm armyworms caterpillars '
  + 'photo photos photos taken took recheck follow up next last today yesterday week month').split(/\s+/));
// A word that follows a name when the name is the subject of the note
// ("Brown reports damage", "Green's dog"): an ordinary lawn word in that
// position is a surname, however common the word (Codex #4149 r12).
const NAME_SYNTAX_RE = /^(?:reports?|reported|says?|said|mentions?|mentioned|asks?|asked|calls?|called|wants?|wanted|notes?|noted|tells?|told|confirms?|confirmed|thinks?|thought|requests?|requested|complains?|complained|prefers?|preferred|texted|emailed|phoned|met|showed|pointed|agreed|declined|approved)$/i;
const echoWords = (text) => String(text || '').replace(/[‘’]/g, "'").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
function echoesTechnicianNotes(text, notes) {
  if (!text || !notes) return false;
  const words = echoWords(text);
  const wordBases = new Set(words.map((word) => word.replace(/'s$/, '')));
  const joined = ` ${words.join(' ')} `;
  const noteWords = echoWords(notes);
  for (let i = 0; i + ECHO_RUN_WORDS <= noteWords.length; i += 1) {
    if (joined.includes(` ${noteWords.slice(i, i + ECHO_RUN_WORDS).join(' ')} `)) return true;
  }
  const raw = String(notes).replace(/[‘’]/g, "'").split(/\s+/);
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i].replace(/^[^\p{L}]+|[^\p{L}']+$/gu, '');
    if (token.length < 3) continue;
    const base = token.toLowerCase().replace(/'s$/, '');
    if (ECHO_ALLOWLIST.has(base) || !wordBases.has(base)) continue;
    const next = (raw[i + 1] || '').replace(/[^\p{L}']+$/gu, '');
    const nameSyntax = /'s$/i.test(token) || NAME_SYNTAX_RE.test(next);
    const ordinary = ECHO_COMMON_WORDS.has(base) || SUMMARY_CAUSE_RE.test(token);
    const sentenceInitial = i === 0 || (/[.!?:;]$/.test(raw[i - 1]) && !/^(?:mr|mrs|ms|miss|mx|dr)\.?$/i.test(raw[i - 1]));
    // Capitals alone identify an unusual word, or a mid-sentence name.
    // Subject/possessive syntax also catches lowercase names and surnames
    // that double as lawn words ("Brown reports", "Green's dog").
    const name = /^\p{Lu}/u.test(token)
      ? nameSyntax || !sentenceInitial || !ordinary
      : nameSyntax && !ordinary;
    if (name) return true;
  }
  return false;
}
function withoutTechnicianEchoes(analysis, notes) {
  if (!notes) return analysis;
  return {
    ...analysis,
    observations: echoesTechnicianNotes(analysis.observations, notes) ? '' : analysis.observations,
    findings: (analysis.findings || []).map((finding) => (echoesTechnicianNotes(finding.confirmation_step, notes) ? { ...finding, confirmation_step: '' } : finding)),
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
  const base = String(term || '').toLowerCase().replace(/gr[ae]y/, 'gray').replace(/[\s-]+/g, ' ');
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
  echoesTechnicianNotes,
  withoutTechnicianEchoes,
  customerObservations,
  namesUnpublishedCause,
  governedTerms,
  unpublishableCustomerCopy,
  safeConfirmationStep,
  reviewedObservations,
};
