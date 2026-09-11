/** Resolve technician evidence and treatment reconciliation from validated review inputs. */
const { SUMMARY_CAUSE_RE, safeConditionLabel, normalizeProducts, buildTreatmentRationale, buildReconciliationFlags, buildWatchItems } = require('./lawn-diagnostic-report');
const { NO_STRESS_LABEL } = require('./lawn-visit-result');
const { safeConfirmationStep } = require('./lawn-visit-customer-copy');
const { mergedReviewInputs, technicianFindingIds, storedTechnicianHighWater, parseJsonArray, parseJsonObject } = require('./lawn-visit-review-input');

// A technician-added detail becomes a finding of its own: moderate at most
// (the diagnostic tool's evidence rule — no cause above moderate without a
// structured field check), evidence = the note itself. A NEGATED detail
// ("Checked for chinch bugs; none found") is the technician ruling a cause
// OUT: it keeps its text in the review but carries the clean-lawn label, so
// it never reconciles as the positive condition or raises a "chinch bug
// activity: monitor response" watch item (Codex #4149 r11). The label
// mapper handles a LEADING negation only.
const NEGATED_DETAIL_RE = /\b(?:none|nothing|no|without|not\s+(?:found|seen|present|observed|detected|evident|visible|active|confirmed)|absent|negative|unlikely|excluded|ruled\s+out|did\s*n[o']t\s+(?:find|see|observe|detect|notice)|couldn['’]?t\s+(?:find|see|confirm)|clear\s+of|free\s+of)\b/i;
// Negation is scoped to the CLAUSE it sits in ("No signs of drought; chinch
// bugs confirmed by float test" rules drought out and confirms chinch): the
// detail is negated only when every cause-bearing clause is, and a positive
// clause names the finding (Codex #4149 r12).
const CLAUSE_SPLIT_RE = /[;.!?]|\b(?:but|while|though|although|however)\b/i;
// An answer to the clause before it, as opposed to any clause that merely
// contains a negation word. Anchored: the clause must OPEN with the answer.
const NEGATIVE_ANSWER_RE = /^(?:and\s+|but\s+)?(?:none|nothing|neither|negative|absent|all\s+clear|clear)\b|^(?:not|no)\s+(?:found|seen|present|observed|detected|evident|visible|active|confirmed|signs?)\b|^(?:ruled\s+out|excluded|did\s*n[o']t\s+(?:find|see|observe|detect|notice)|couldn['’]?t\s+(?:find|see|confirm))\b/i;
function detailClauses(text) {
  return String(text || '').split(CLAUSE_SPLIT_RE).map((clause) => clause.trim()).filter(Boolean);
}
// Cause clauses with their negation resolved: a negation in the clause
// itself, or a negation-only clause right after it ("Checked for chinch
// bugs; none found") — that clause answers the one before. A clause that
// names MORE THAN ONE cause is split on commas / and / or into one part per cause
// ("Drought ruled out and chinch bugs confirmed by float test"), and a part
// with neither a negation nor a positive marker takes the polarity of the
// nearest part that has one — the following part first ("chinch and grubs
// ruled out"), then the preceding ("no signs of chinch or grubs") — so a
// negation binds to the mentions it governs, not the whole clause (Codex
// #4149 r13).
const POSITIVE_MARKER_RE = /\b(?:confirmed|confirms?|active|present|found|seen|observed|visible|spreading|heavy|evident|positive|detected|noted)\b/i;
// A clause carries a condition when it names a governed cause OR maps to any
// other allowlisted label. SUMMARY_CAUSE_RE deliberately excludes generic class
// words such as "weeds", so testing it alone dropped "No chinch bugs but weeds
// present" down to a clean lawn: ruling one cause out must never erase another
// condition the technician actually observed.
// Tested with the negation words removed, so "no weeds present" still counts as
// naming a condition — the polarity is resolved separately, per segment. Only a
// SPECIFIC label counts: safeConditionLabel falls back to a generic label for
// any text it cannot place, so testing "!== NO_STRESS_LABEL" would make bare
// words like "found" read as conditions.
const NEGATION_WORDS_RE = new RegExp(NEGATED_DETAIL_RE.source, 'gi');
const UNSPECIFIC_LABELS = new Set([NO_STRESS_LABEL, 'general lawn stress', 'a lawn condition we are monitoring']);
const namesCondition = (text) => {
  if (SUMMARY_CAUSE_RE.test(text)) return true;
  // Stripping the negation can empty the text ("not confirmed"), and
  // safeConditionLabel answers null for that — no label names no condition.
  const label = safeConditionLabel(String(text || '').replace(NEGATION_WORDS_RE, ' ').trim(), 'moderate');
  return !!label && !UNSPECIFIC_LABELS.has(label);
};
function causePartsOf(clause) {
  // Split whenever more than one SEGMENT names a condition, not just when more
  // than one governed cause is mentioned: SUMMARY_CAUSE_RE excludes generic
  // class words, so "No chinch bugs, weeds present" counted one mention, stayed
  // whole, and the negation swallowed the weed observation.
  // Adjacent separators ("…, and …" — an Oxford comma) leave an empty segment
  // between them. Drop it and fold its separators into the joiner that reaches
  // the next real segment, so the clause still splits and the comma is still
  // seen: discarding the empty segment instead used to disable splitting and
  // let one segment's "ruled out" negate the confirmed cause beside it.
  const pieces = clause.split(/\s*(,|\band\b|\bor\b|\bnor\b)\s*/i);
  const segments = [];
  const joiners = [];
  let pending = [];
  pieces.forEach((piece, index) => {
    if (index % 2 === 1) { pending.push(piece.trim().toLowerCase()); return; }
    const text = piece.trim();
    if (!text) return;
    if (segments.length) joiners.push(pending.join(' '));
    segments.push(text);
    pending = [];
  });
  const split = segments.filter((part) => namesCondition(part)).length > 1;
  const parts = split ? segments : [clause];
  const entries = parts.map((part) => ({ clause: part, cause: namesCondition(part), negation: NEGATED_DETAIL_RE.test(part), positive: POSITIVE_MARKER_RE.test(part) }));
  // "No chinch bugs or weeds present" is one negative statement: a leading
  // negation carries across or/nor, where "present" belongs to the negated
  // predicate rather than asserting weeds. A comma or "and" introduces an
  // independent observation ("No chinch bugs, weeds present"), so the scope
  // stops there.
  if (split) {
    entries.forEach((entry, index) => {
      if (index === 0 || !/^(?:or|nor)$/.test(joiners[index - 1] || '')) return;
      if (entries[index - 1].negation && !entry.negation) entry.negation = true;
    });
  }
  entries.forEach((entry, index) => {
    if (!entry.cause || entry.negation || entry.positive) return;
    const marked = entries.slice(index + 1).find((other) => other.negation || other.positive) || [...entries.slice(0, index)].reverse().find((other) => other.negation || other.positive);
    if (marked) entry.negation = marked.negation;
  });
  return entries;
}
function causeClausesOf(text) {
  const clauses = [];
  for (const clause of detailClauses(text)) {
    // Attach an answer such as "none found" before splitting a compound
    // subject, so it also answers "checked for chinch bugs and grubs". Only a
    // clause that OPENS with an answer attaches, and only that leading segment:
    // NEGATED_DETAIL_RE matches any stray "no", so an unrelated observation
    // ("…confirmed by float test; no irrigation today") used to be folded into
    // the confirmed clause and negate it, while anything the answer is followed
    // by ("none found, weeds present") must stay a clause of its own rather
    // than ride along as part of the negated subject.
    const boundary = /\s*(?:,|\band\b|\bor\b)\s*/i.exec(clause);
    const head = boundary ? clause.slice(0, boundary.index) : clause;
    const rest = boundary ? [clause.slice(boundary.index + boundary[0].length)] : [];
    // …and only when the answer segment names no condition of its own: "no
    // signs of drought" opens like an answer but rules out a second cause, so
    // attaching it would let that negation swallow the confirmed clause.
    if (clauses.length && NEGATIVE_ANSWER_RE.test(clause) && !namesCondition(head)) {
      clauses[clauses.length - 1] += ` ${head.trim()}`;
      const remainder = rest.join('').trim();
      if (remainder) clauses.push(remainder);
    } else clauses.push(clause);
  }
  return clauses.flatMap(causePartsOf).filter((entry) => entry.cause);
}
function technicianFinding(detail, findingId) {
  const causeClauses = causeClausesOf(detail.text);
  const positive = causeClauses.filter((entry) => !entry.negation).map((entry) => entry.clause);
  const negatedCause = causeClauses.length > 0 && positive.length === 0;
  const label = negatedCause ? NO_STRESS_LABEL : safeConditionLabel(positive.length ? positive.join('; ') : detail.text, 'moderate');
  const negated = negatedCause || label === NO_STRESS_LABEL; // a leading "No …" the mapper already reads as clean
  return {
    finding_id: findingId,
    name: detail.text,
    confidence: 'moderate',
    severity: 'moderate',
    spread_risk: 'unknown',
    estimated_area_affected: null,
    urgency: 'monitor',
    observed_evidence: [detail.text],
    inferred_context: [],
    negative_evidence: [],
    confirmation_step: '',
    customer_wording: null,
    photo_refs: [],
    zone: detail.zone || 'unknown',
    can_determine: true,
    cannot_determine_reason: '',
    label,
    negated,
    source: 'technician',
    keep: true,
    tech_note: null,
  };
}

/**
 * Apply the review to the run's findings and reconcile the kept ones against
 * the products the technician confirmed — deterministic, from the diagnostic
 * tool's own builders. Products absent → every finding reads untreated, which
 * is the honest state until the completion records what was applied.
 */
function buildReview(run, rawReview = {}) {
  const review = mergedReviewInputs(run, rawReview);
  const byId = new Map(review.reviewedFindings.map((entry) => [entry.finding_id, entry]));
  const reviewed = parseJsonArray(run?.findings).map((finding) => {
    const entry = byId.get(String(finding.finding_id));
    // A technician rename is already a canonical allowlisted label
    // (validateReview) — it IS the label; re-mapping it through the pattern
    // list would turn "general lawn stress" into "color stress". The
    // confidence behind it is the technician's, not the model's: moderate,
    // the same ceiling a technician-added finding gets (no cause above
    // moderate without a structured field check) — a rename never publishes
    // a cause on a low / unknown-confidence read, and never inherits the
    // model's high confidence for a cause the model did not name (Codex
    // #4149 r6).
    const name = entry?.name || finding.name;
    return {
      ...finding,
      name,
      confidence: entry?.name ? 'moderate' : finding.confidence,
      // An unrenamed finding keeps the label the run stored at assessment
      // time (provenance) — never re-mapped by whatever the pattern list says
      // at confirmation; a stored run without one (never the case for a run
      // this module wrote) is mapped once here.
      label: entry?.name ? entry.name : (finding.label || safeConditionLabel(finding.name, finding.confidence)),
      keep: entry ? entry.keep !== false : true,
      tech_note: entry?.tech_note || null,
      // Rename intent, persisted: a follow-up that omits reviewedFindings
      // restores the rename (and its technician confidence) only where one
      // happened.
      renamed: !!entry?.name,
      source: finding.source || 'model',
    };
  });
  const storedReconciliation = parseJsonObject(run?.reconciliation);
  const { ids, highWater } = technicianFindingIds(review.addedDetails, parseJsonArray(run?.added_details), storedTechnicianHighWater(storedReconciliation));
  const added = review.addedDetails.map((detail, index) => technicianFinding(detail, ids[index]));
  // The reconciliation builders interpolate finding NAMES into customer-facing
  // copy (customer_explanation, watch items, flag wording), so they only ever
  // see the allowlisted label — never the model's or the technician's raw
  // text. A clean-lawn finding ("No major visible stress") is not a condition
  // a product treats — it stays in the review, out of the reconciliation.
  const reconcilable = [...reviewed.filter((finding) => finding.keep), ...added]
    .filter((finding) => finding.label !== NO_STRESS_LABEL)
    .map((finding) => ({ ...finding, name: finding.label, confirmation_step: safeConfirmationStep(finding.confirmation_step, finding) }));
  const products = normalizeProducts(review.appliedProducts);
  const treatmentRationale = buildTreatmentRationale({ products, findings: reconcilable });
  const flags = buildReconciliationFlags({ findings: reconcilable, products, treatmentRationale });
  return {
    reviewed_findings: reviewed,
    added_details: added,
    reconciliation: {
      products,
      treatment_rationale: treatmentRationale,
      flags,
      watch_items: buildWatchItems(reconcilable, flags),
      // The highest technician finding number ever assigned on this run —
      // read back by the next follow-up so a number is never reused.
      technician_finding_high_water: highWater,
      computed_at: new Date().toISOString(),
    },
  };
}

module.exports = { buildReview };
