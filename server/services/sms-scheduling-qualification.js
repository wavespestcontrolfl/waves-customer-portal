'use strict';
/**
 * Pure evidence fingerprinting and operator-supplied qualification scoring.
 * Input schema v1:
 *   { schemaVersion: 1,
 *     source: { kind: 'independent_manual_review', reviewedBy, reviewedAt, reference },
 *     adjudications: [{ decisionId, evidenceFingerprint,
 *       expected: { action, outcome, offerId?, slotNumber?, move? } }] }
 * Accept slotNumber is the global 1-based number in the decide prompt, across
 * the evidence offers in order; offerId must identify the offer at that number.
 * A move outcome also requires move { scheduledServiceId, date, start,
 * arrivalEnd }; this is the independent operational verdict, not inferred.
 */

const crypto = require('node:crypto');

const REVIEW_KIND = 'independent_manual_review';
const EXPECTED_ACTIONS = new Set(['accept_slot', 'decline', 'asks_other_time', 'unclear', 'unsupported']);
const EXPECTED_OUTCOMES = new Set(['move', 'book', 'confirm_only', 'staff', 'no_action', 'unsupported']);
const PLANNED_DECISION_OUTCOMES = new Set(['would_move', 'would_book', 'confirm_only', 'staff']);
const HASH_RE = /^[0-9a-f]{64}$/;
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function fingerprintEvidence(value) {
  return sha256Text(JSON.stringify(canonical(value)));
}

function parse(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function isNonblankString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function validOffsetDate(value) {
  if (!isNonblankString(value) || !OFFSET_ISO_RE.test(value)) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number.isFinite(Date.parse(value));
}

function sourceVerdict(input) {
  const source = input?.source;
  const valid = input?.schemaVersion === 1 && source?.kind === REVIEW_KIND
    && isNonblankString(source.reviewedBy) && isNonblankString(source.reference)
    && validOffsetDate(source.reviewedAt);
  return {
    supplied: Boolean(input), valid,
    note: 'operator-supplied provenance; this report does not independently verify the reviewer or source claim',
    ...(source && typeof source === 'object' ? {
      kind: source.kind || null, reviewedBy: source.reviewedBy || null,
      reviewedAt: source.reviewedAt || null, reference: source.reference || null,
    } : {}),
  };
}

function currentBodyMatches(ref, smsBodiesById) {
  if (!ref?.smsLogId || !HASH_RE.test(String(ref.bodySha256 || ''))) return false;
  return smsBodiesById.has(String(ref.smsLogId))
    && sha256Text(smsBodiesById.get(String(ref.smsLogId))) === ref.bodySha256;
}

function decisionMatchesRow(decision, row) {
  if (!decision || decision.model !== row.model || decision.promptVersion !== row.prompt_version) return false;
  if (!isNonblankString(decision.servedModel) || decision.servedModel !== row.model) return false;
  if (decision.action !== row.action || decision.slotNumber !== row.slot_number || decision.outcome !== row.outcome) return false;
  if (fingerprintEvidence(decision.wouldHave) !== fingerprintEvidence(parse(row.would_have))) return false;
  const shouldHavePlan = decision.action === 'accept_slot' && PLANNED_DECISION_OUTCOMES.has(decision.outcome);
  return shouldHavePlan ? decision.wouldHave != null : decision.wouldHave == null;
}

function linkedOffers(evidence, row, smsBodiesById) {
  const offers = Array.isArray(evidence.offers) ? evidence.offers : [];
  if (!offers.length) return null;
  if (offers.some((offer) => !currentBodyMatches(offer?.outbound, smsBodiesById))) return null;
  if (!offers.some((offer) => String(offer.id) === String(row.sms_offer_id))) return null;
  return String(evidence.selectedOfferId || '') === String(row.sms_offer_id) ? offers : null;
}

function completeVisit(visit) {
  return visit && typeof visit === 'object' && !Array.isArray(visit)
    && ['date', 'start', 'end', 'status'].every((field) => isNonblankString(visit[field]));
}

function validSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  if (typeof snapshot.observed !== 'boolean') return false;
  if (!snapshot.observed) return snapshot.observedAt == null && snapshot.visit == null;
  return validOffsetDate(snapshot.observedAt) && (snapshot.visit == null || completeVisit(snapshot.visit));
}

function completeDecisionFacts(evidence, outcome) {
  if (!validSnapshot(evidence.before) || !validSnapshot(evidence.after) || !evidence.before.observed) return false;
  if (outcome !== 'would_move') return true;
  return evidence.after.observed && completeVisit(evidence.before.visit) && completeVisit(evidence.after.visit);
}

function evidenceFor(row, smsBodiesById) {
  const evidence = parse(row.decision_evidence);
  if (!evidence || evidence.version !== 1) return null;
  if (!HASH_RE.test(String(row.evidence_fingerprint || ''))) return null;
  if (fingerprintEvidence(evidence) !== row.evidence_fingerprint) return null;
  if (String(evidence.reply?.smsLogId || '') !== String(row.inbound_sms_log_id || '')) return null;
  if (!currentBodyMatches(evidence.reply, smsBodiesById)) return null;
  const offers = linkedOffers(evidence, row, smsBodiesById);
  if (!offers || !completeDecisionFacts(evidence, row.outcome)) return null;
  if (!decisionMatchesRow(evidence.decision, row)) return null;
  return { evidence, offers };
}

function numberedPick(expected, offers) {
  if (!isNonblankString(expected.offerId)) return null;
  if (!Number.isInteger(expected.slotNumber) || expected.slotNumber < 1) return null;
  const numbered = offers.flatMap((offer) => (Array.isArray(offer.slots) ? offer.slots : [])
    .map((slot) => ({ offer, slot })));
  const pick = numbered[expected.slotNumber - 1];
  return pick && String(pick.offer.id) === expected.offerId ? pick : null;
}

function exactExpectedMove(expected, pick) {
  const move = expected.move;
  if (!move || !isNonblankString(move.scheduledServiceId)) return null;
  if (!isNonblankString(move.date) || !isNonblankString(move.start) || !isNonblankString(move.arrivalEnd)) return null;
  if (pick.offer.kind !== 'move_visit') return null;
  if (move.scheduledServiceId !== String(pick.offer.scheduledServiceId || '')) return null;
  if (move.date !== pick.slot.date || move.start !== pick.slot.start || move.arrivalEnd !== pick.slot.end) return null;
  return move;
}

function nonMoveExpectedVerdict(expected, pick) {
  if (expected.outcome === 'book' && !['book_estimate', 'book_new'].includes(pick.offer.kind)) return null;
  if (expected.outcome === 'confirm_only' && pick.offer.kind !== 'move_visit') return null;
  return expected.move == null
    ? { action: expected.action, outcome: expected.outcome, ...pick, slotNumber: expected.slotNumber, move: null } : null;
}

function expectedVerdict(adjudication, found) {
  const expected = adjudication?.expected;
  if (!adjudication || !isNonblankString(adjudication.decisionId)) return null;
  if (!HASH_RE.test(String(adjudication.evidenceFingerprint || ''))) return null;
  if (!expected || !EXPECTED_ACTIONS.has(expected.action)) return null;
  if (!EXPECTED_OUTCOMES.has(expected.outcome)) return null;
  if (expected.action !== 'accept_slot') {
    if (expected.offerId != null || expected.slotNumber != null || expected.move != null) return null;
    if (['move', 'book', 'confirm_only'].includes(expected.outcome)) return null;
    return { action: expected.action, outcome: expected.outcome, offer: null, slot: null, move: null };
  }
  const pick = numberedPick(expected, found.offers);
  if (!pick) return null;
  if (expected.outcome !== 'move') return nonMoveExpectedVerdict(expected, pick);
  const move = exactExpectedMove(expected, pick);
  return move ? { action: expected.action, outcome: expected.outcome, ...pick, slotNumber: expected.slotNumber, move } : null;
}

function emptyEpoch(model, promptVersion) {
  return {
    model, promptVersion, actionType: 'move_visit', decisions: 0, reviewed: 0, missingReviews: 0, invalidOrConflictingReviews: 0,
    incompleteEvidence: 0, unsupported: 0, unclear: 0, distinctOffersReviewed: 0, distinctOffersScored: 0,
    proposedMoves: 0, wrongProposedMoves: 0, unknownOrMixedOfferKind: 0,
    notEvaluated: { status: 'not_evaluated', decisions: 0, distinctOffers: 0, byKind: {} },
    trueAccepts: { decisions: 0, caughtDecisions: 0, distinctOffers: 0, caughtDistinctOffers: 0, decisionRecall: null, offerRecall: null },
    status: 'inconclusive', reasons: [],
  };
}

function finishEpoch(epoch, state) {
  epoch.distinctOffersReviewed = state.reviewedOffers.size;
  epoch.distinctOffersScored = state.scoredOffers.size;
  epoch.trueAccepts.distinctOffers = state.acceptsByOffer.size;
  epoch.trueAccepts.caughtDistinctOffers = [...state.acceptsByOffer.values()].filter((hits) => hits.every(Boolean)).length;
  epoch.trueAccepts.decisionRecall = epoch.trueAccepts.decisions
    ? Number((epoch.trueAccepts.caughtDecisions / epoch.trueAccepts.decisions).toFixed(4)) : null;
  epoch.trueAccepts.offerRecall = epoch.trueAccepts.distinctOffers
    ? Number((epoch.trueAccepts.caughtDistinctOffers / epoch.trueAccepts.distinctOffers).toFixed(4)) : null;
  epoch.notEvaluated.distinctOffers = state.notEvaluatedOffers.size;
  epoch.notEvaluated.byKind = Object.fromEntries([...state.notEvaluatedByKind.entries()].sort());
  const complete = ![
    !epoch.model, !epoch.promptVersion, epoch.missingReviews, epoch.invalidOrConflictingReviews,
    epoch.incompleteEvidence, epoch.unknownOrMixedOfferKind,
  ].some(Boolean);
  if (!epoch.model || !epoch.promptVersion) epoch.reasons.push('missing_model_or_prompt_epoch');
  if (!complete) epoch.reasons.push('cohort_not_fully_reviewed_with_complete_linked_evidence');
  if (epoch.unknownOrMixedOfferKind) epoch.reasons.push('unknown_or_mixed_offer_kind_not_scored');
  if (epoch.distinctOffersScored < 40) epoch.reasons.push('fewer_than_40_distinct_scored_offers');
  if (!epoch.trueAccepts.distinctOffers) epoch.reasons.push('no_independently_adjudicated_true_accepts');
  if (epoch.wrongProposedMoves > 0) epoch.reasons.push('adjudicated_wrong_proposed_move');
  const enough = complete && epoch.distinctOffersScored >= 40 && epoch.trueAccepts.distinctOffers > 0;
  const recallPasses = epoch.trueAccepts.caughtDistinctOffers * 5 >= epoch.trueAccepts.distinctOffers * 4;
  if (enough) {
    if (!recallPasses) epoch.reasons.push('true_accept_offer_recall_below_80_percent');
    epoch.status = epoch.wrongProposedMoves > 0 || !recallPasses ? 'not_qualified' : 'qualified';
  }
  return epoch;
}

function indexAdjudications(decisions, supplied) {
  const rows = new Map(decisions.map((row) => [String(row.id), row]));
  const labels = new Map();
  const conflicts = new Set();
  let extras = 0;
  for (const item of supplied) {
    const id = String(item?.decisionId || '');
    if (!rows.has(id)) { extras += 1; continue; }
    if (labels.has(id)) conflicts.add(id); else labels.set(id, item);
  }
  return { labels, conflicts, extras };
}

function epochFor(row, groups, states) {
  const model = isNonblankString(row.model) ? row.model : null;
  const prompt = isNonblankString(row.prompt_version) ? row.prompt_version : null;
  const key = JSON.stringify([model, prompt]);
  if (!groups.has(key)) {
    groups.set(key, emptyEpoch(model, prompt));
    states.set(key, {
      reviewedOffers: new Set(), scoredOffers: new Set(), acceptsByOffer: new Map(),
      notEvaluatedOffers: new Set(), notEvaluatedByKind: new Map(),
    });
  }
  return [groups.get(key), states.get(key)];
}

function adjudicatedRow(row, sourceValid, labels, conflicts, smsBodiesById) {
  const item = labels.get(String(row.id));
  if (!sourceValid || !item) return { counter: 'missingReviews' };
  if (conflicts.has(String(row.id))) return { counter: 'invalidOrConflictingReviews' };
  const found = evidenceFor(row, smsBodiesById);
  if (!found || item.evidenceFingerprint !== row.evidence_fingerprint) return { counter: 'incompleteEvidence' };
  const expected = expectedVerdict(item, found);
  return expected ? { found, expected } : { counter: 'invalidOrConflictingReviews' };
}

function acceptIsCorrect(row, expected) {
  if (expected.action !== 'accept_slot' || row.action !== 'accept_slot') return false;
  return String(row.sms_offer_id) === String(expected.offer.id) && row.slot_number === expected.slotNumber;
}

function moveIsCorrect(found, expected, correctAccept) {
  if (!correctAccept || expected.outcome !== 'move') return false;
  const proposed = found.evidence.decision.wouldHave;
  if (proposed?.kind !== 'move_visit') return false;
  return String(proposed.scheduled_service_id || '') === expected.move.scheduledServiceId
    && proposed.date === expected.move.date && proposed.start === expected.move.start
    && proposed.arrival_end === expected.move.arrivalEnd;
}

function reviewedActionFamily(row, review) {
  const kinds = new Set(review.found.offers.map((offer) => offer?.kind));
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  if (!['move_visit', 'book_estimate', 'book_new'].includes(kind)) return null;
  const offer = review.expected.action === 'accept_slot'
    ? review.expected.offer : review.found.offers.find((candidate) => String(candidate.id) === String(row.sms_offer_id));
  return offer?.kind === kind ? { kind, offerId: String(offer.id) } : null;
}

function excludeUnevaluatedFamily(epoch, epochState, family) {
  epoch.notEvaluated.decisions += 1;
  epochState.notEvaluatedOffers.add(family.offerId);
  const count = epochState.notEvaluatedByKind.get(family.kind) || 0;
  epochState.notEvaluatedByKind.set(family.kind, count + 1);
}

function scoreReviewedRow(epoch, epochState, row, review) {
  const { found, expected } = review;
  epoch.reviewed += 1;
  const correctAccept = acceptIsCorrect(row, expected);
  if (row.outcome === 'would_move') {
    epoch.proposedMoves += 1;
    if (!moveIsCorrect(found, expected, correctAccept)) epoch.wrongProposedMoves += 1;
  }
  const family = reviewedActionFamily(row, review);
  if (!family) { epoch.unknownOrMixedOfferKind += 1; return; }
  if (family.kind !== 'move_visit') { excludeUnevaluatedFamily(epoch, epochState, family); return; }
  epochState.reviewedOffers.add(family.offerId);
  if (expected.action === 'unsupported') { epoch.unsupported += 1; return; }
  if (expected.action === 'unclear') { epoch.unclear += 1; return; }
  epochState.scoredOffers.add(family.offerId);
  if (expected.action !== 'accept_slot') return;
  epoch.trueAccepts.decisions += 1;
  if (correctAccept) epoch.trueAccepts.caughtDecisions += 1;
  const offerId = String(expected.offer.id);
  if (!epochState.acceptsByOffer.has(offerId)) epochState.acceptsByOffer.set(offerId, []);
  epochState.acceptsByOffer.get(offerId).push(correctAccept);
}

function summarizeQualification(decisions = [], input = null, smsBodiesById = new Map()) {
  const source = sourceVerdict(input);
  const supplied = Array.isArray(input?.adjudications) ? input.adjudications : [];
  const { labels, conflicts, extras } = indexAdjudications(decisions, supplied);
  const groups = new Map();
  const states = new Map();
  for (const row of decisions) {
    const [epoch, epochState] = epochFor(row, groups, states);
    epoch.decisions += 1;
    const review = adjudicatedRow(row, source.valid, labels, conflicts, smsBodiesById);
    if (review.counter) { epoch[review.counter] += 1; continue; }
    scoreReviewedRow(epoch, epochState, row, review);
  }
  const epochs = [...groups.entries()].map(([key, epoch]) => finishEpoch(epoch, states.get(key)));
  let status = epochs.length === 1 ? epochs[0].status : 'inconclusive';
  const reasons = [];
  if (!source.valid) reasons.push('missing_or_invalid_operator_adjudication_provenance');
  if (epochs.length !== 1) reasons.push(epochs.length ? 'multiple_model_or_prompt_epochs_not_pooled' : 'no_decisions');
  if (source.valid && epochs.length === 1) reasons.push(...epochs[0].reasons);
  if (!source.valid) status = 'inconclusive';
  return { status, reasons: [...new Set(reasons)], source, cohort: { decisions: decisions.length, adjudicationsProvided: supplied.length, extras, conflicts: conflicts.size }, epochs };
}

module.exports = { REVIEW_KIND, sha256Text, fingerprintEvidence, summarizeQualification };
