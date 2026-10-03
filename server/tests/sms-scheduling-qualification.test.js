'use strict';

const { fingerprintEvidence, sha256Text, summarizeQualification } = require('../services/sms-scheduling-qualification');

const MODEL = 'claude-sonnet-test';
const PROMPT = 'sms_sched_decide_v2';
const source = {
  schemaVersion: 1,
  source: { kind: 'independent_manual_review', reviewedBy: 'staff-reviewer-id', reviewedAt: '2026-10-02T12:00:00Z', reference: 'private-review-batch-1' },
};

function cohort(overrides = new Map()) {
  const rows = [];
  const adjudications = [];
  const bodies = new Map();
  for (let i = 0; i < 41; i += 1) {
    // Two independently reviewed accepts for offer 0 prove repeated replies do
    // not increase the distinct-offer denominator.
    const offerNumber = i === 40 ? 0 : i;
    const offerId = `offer-${offerNumber}`;
    const accept = i === 0 || i === 40;
    const configured = overrides.get(i) || {};
    const promptVersion = configured.promptVersion || PROMPT;
    const expectedAction = configured.expectedAction || (accept ? 'accept_slot' : 'decline');
    const kind = Object.hasOwn(configured, 'kind') ? configured.kind : 'move_visit';
    const action = configured.action || (expectedAction === 'accept_slot' ? 'accept_slot' : 'decline');
    const outcome = configured.outcome || (action === 'accept_slot' ? (kind === 'move_visit' ? 'would_move' : 'would_book') : 'no_action');
    const slotNumber = action === 'accept_slot' ? 1 : null;
    const replyId = `reply-${i}`;
    const outboundId = `outbound-${offerNumber}`;
    const replyBody = `synthetic reply ${i}`;
    const outboundBody = `synthetic offer ${offerNumber}`;
    bodies.set(replyId, replyBody);
    bodies.set(outboundId, outboundBody);
    const wouldHave = configured.wouldHave || (outcome === 'would_move'
      ? { kind: 'move_visit', scheduled_service_id: `visit-${offerNumber}`, date: '2026-10-06', start: '10:00', arrival_end: '12:00' }
      : null);
    const expectedOutcome = configured.expectedOutcome
      || (expectedAction === 'accept_slot' ? (kind === 'move_visit' ? 'move' : 'book') : 'no_action');
    const evidence = {
      version: 1,
      reply: { smsLogId: replyId, bodySha256: sha256Text(replyBody), createdAt: '2026-10-02T10:00:00Z' },
      offers: [{
        id: offerId, kind, scheduledServiceId: `visit-${offerNumber}`, slots: [{ date: '2026-10-06', start: '10:00', end: '12:00' }],
        outbound: { smsLogId: outboundId, bodySha256: sha256Text(outboundBody), createdAt: '2026-10-02T09:00:00Z' },
      }],
      selectedOfferId: offerId,
      before: { observed: true, observedAt: '2026-10-02T10:00:00Z', visit: { date: '2026-10-05', start: '08:00', status: 'confirmed' } },
      after: { observed: outcome === 'would_move', observedAt: '2026-10-02T10:00:01Z', visit: outcome === 'would_move' ? { date: '2026-10-05', start: '08:00', status: 'confirmed' } : null },
      decision: { model: configured.model || MODEL, servedModel: configured.model || MODEL, requestedModel: MODEL, promptVersion, action, slotNumber, outcome, wouldHave },
    };
    const fingerprint = fingerprintEvidence(evidence);
    rows.push({
      id: `decision-${i}`, sms_offer_id: offerId, inbound_sms_log_id: replyId,
      model: configured.model || MODEL, prompt_version: promptVersion, action, slot_number: slotNumber, outcome,
      would_have: wouldHave, decision_evidence: evidence, evidence_fingerprint: fingerprint,
    });
    adjudications.push({
      decisionId: `decision-${i}`, evidenceFingerprint: fingerprint,
      expected: expectedAction === 'accept_slot'
        ? {
          action: expectedAction, outcome: expectedOutcome, offerId, slotNumber: 1,
          ...(expectedOutcome === 'move' ? { move: { scheduledServiceId: `visit-${offerNumber}`, date: '2026-10-06', start: '10:00', arrivalEnd: '12:00' } } : {}),
        } : { action: expectedAction, outcome: expectedOutcome },
    });
  }
  return { rows, adjudications, bodies };
}

test('qualification uses the complete reviewed cohort and conservative distinct-offer recall', () => {
  const c = cohort();
  const earlierBody = 'synthetic earlier standing offer';
  c.bodies.set('outbound-earlier', earlierBody);
  c.rows[0].decision_evidence.offers.unshift({
    id: 'offer-earlier', kind: 'move_visit', scheduledServiceId: 'visit-earlier',
    slots: [{ date: '2026-10-05', start: '09:00', end: '11:00' }],
    outbound: { smsLogId: 'outbound-earlier', bodySha256: sha256Text(earlierBody), createdAt: '2026-10-02T08:00:00Z' },
  });
  c.rows[0].slot_number = 2;
  c.rows[0].decision_evidence.decision.slotNumber = 2;
  c.rows[0].evidence_fingerprint = fingerprintEvidence(c.rows[0].decision_evidence);
  c.adjudications[0].evidenceFingerprint = c.rows[0].evidence_fingerprint;
  c.adjudications[0].expected.slotNumber = 2;
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('qualified');
  expect(result.epochs).toHaveLength(1);
  expect(result.epochs[0]).toMatchObject({
    decisions: 41, reviewed: 41, distinctOffersScored: 40,
    proposedMoves: 2, wrongProposedMoves: 0,
    trueAccepts: { decisions: 2, caughtDecisions: 2, distinctOffers: 1, caughtDistinctOffers: 1, offerRecall: 1 },
  });
  expect(result.source.note).toMatch(/operator-supplied/);
});

test('booking families are reported as not evaluated and cannot qualify the move lane', () => {
  const overrides = new Map();
  for (let i = 0; i < 41; i += 1) {
    overrides.set(i, { kind: i % 2 ? 'book_estimate' : 'book_new', expectedAction: 'accept_slot' });
  }
  const c = cohort(overrides);
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.epochs[0]).toMatchObject({
    actionType: 'move_visit', reviewed: 41, distinctOffersReviewed: 0, distinctOffersScored: 0,
    notEvaluated: {
      status: 'not_evaluated', decisions: 41, distinctOffers: 40,
      byKind: { book_estimate: 20, book_new: 21 },
    },
    trueAccepts: { decisions: 0, distinctOffers: 0 },
  });
  expect(result.epochs[0].reasons).toContain('fewer_than_40_distinct_scored_offers');
});

test('move and booking offer families are reported separately without pooling', () => {
  const overrides = new Map();
  for (let i = 20; i < 40; i += 1) overrides.set(i, { kind: 'book_new', expectedAction: 'accept_slot' });
  const c = cohort(overrides);
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.epochs[0]).toMatchObject({
    distinctOffersReviewed: 20, distinctOffersScored: 20,
    notEvaluated: { status: 'not_evaluated', decisions: 20, distinctOffers: 20, byKind: { book_new: 20 } },
    trueAccepts: { decisions: 2, distinctOffers: 1, offerRecall: 1 },
  });
});

test('unknown or missing offer kinds make the reviewed cohort inconclusive', () => {
  const c = cohort(new Map([[5, { kind: 'future_action_kind' }]]));
  const missingKindBody = 'synthetic offer with missing kind';
  c.bodies.set('outbound-missing-kind', missingKindBody);
  c.rows[6].decision_evidence.offers.push({
    id: 'offer-missing-kind', slots: [{ date: '2026-10-06', start: '13:00', end: '15:00' }],
    outbound: { smsLogId: 'outbound-missing-kind', bodySha256: sha256Text(missingKindBody), createdAt: '2026-10-02T09:30:00Z' },
  });
  c.rows[6].evidence_fingerprint = fingerprintEvidence(c.rows[6].decision_evidence);
  c.adjudications[6].evidenceFingerprint = c.rows[6].evidence_fingerprint;
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.epochs[0]).toMatchObject({ unknownOrMixedOfferKind: 2, distinctOffersScored: 38 });
  expect(result.epochs[0].reasons).toContain('unknown_or_mixed_offer_kind_not_scored');
});

test('one missed repeated accept misses that offer, and any wrong would-move fails the bar', () => {
  const missed = cohort(new Map([[40, { action: 'decline', outcome: 'no_action' }]]));
  const missedResult = summarizeQualification(missed.rows, { ...source, adjudications: missed.adjudications }, missed.bodies);
  expect(missedResult.status).toBe('not_qualified');
  expect(missedResult.epochs[0].trueAccepts).toMatchObject({ decisions: 2, caughtDecisions: 1, distinctOffers: 1, caughtDistinctOffers: 0, offerRecall: 0 });

  const wrong = cohort(new Map([[5, { action: 'accept_slot', outcome: 'would_move' }]]));
  const wrongResult = summarizeQualification(wrong.rows, { ...source, adjudications: wrong.adjudications }, wrong.bodies);
  expect(wrongResult.status).toBe('not_qualified');
  expect(wrongResult.epochs[0].wrongProposedMoves).toBe(1);

  const wrongTarget = cohort(new Map([[0, { wouldHave: { kind: 'move_visit', scheduled_service_id: 'visit-0', date: '2026-10-06', start: '11:00', arrival_end: '13:00' } }]]));
  expect(summarizeQualification(wrongTarget.rows, { ...source, adjudications: wrongTarget.adjudications }, wrongTarget.bodies)
    .epochs[0].wrongProposedMoves).toBe(1);

  const staleVisit = cohort(new Map([[0, { expectedOutcome: 'no_action' }]]));
  expect(summarizeQualification(staleVisit.rows, { ...source, adjudications: staleVisit.adjudications }, staleVisit.bodies)
    .epochs[0]).toMatchObject({ wrongProposedMoves: 1, trueAccepts: { caughtDecisions: 2 } });

  // The first 40 decisions retain 40 distinct, correctly scored move offers.
  // A wrong would-move in a booking-family decision still blocks that lane.
  const wrongBooking = cohort(new Map([[40, { kind: 'book_new', expectedAction: 'accept_slot', action: 'accept_slot', outcome: 'would_move' }]]));
  const wrongBookingResult = summarizeQualification(wrongBooking.rows, { ...source, adjudications: wrongBooking.adjudications }, wrongBooking.bodies);
  expect(wrongBookingResult.status).toBe('not_qualified');
  expect(wrongBookingResult.epochs[0]).toMatchObject({
    distinctOffersScored: 40, proposedMoves: 2, wrongProposedMoves: 1,
    notEvaluated: { decisions: 1, distinctOffers: 1, byKind: { book_new: 1 } },
  });
});

test('partial review, changed source rows, and mixed epochs stay inconclusive', () => {
  const partial = cohort();
  partial.adjudications.pop();
  expect(summarizeQualification(partial.rows, { ...source, adjudications: partial.adjudications }, partial.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ missingReviews: 1 }] });

  const changed = cohort();
  changed.bodies.set('reply-0', 'edited later');
  expect(summarizeQualification(changed.rows, { ...source, adjudications: changed.adjudications }, changed.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });

  const mixed = cohort(new Map([[40, { model: 'different-model' }]]));
  const result = summarizeQualification(mixed.rows, { ...source, adjudications: mixed.adjudications }, mixed.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.reasons).toContain('multiple_model_or_prompt_epochs_not_pooled');

  const collisionOverrides = new Map();
  for (let i = 0; i < 40; i += 1) collisionOverrides.set(i, { model: 'a', promptVersion: 'b|c' });
  collisionOverrides.set(40, { model: 'a|b', promptVersion: 'c' });
  const collision = cohort(collisionOverrides);
  expect(summarizeQualification(collision.rows, { ...source, adjudications: collision.adjudications }, collision.bodies))
    .toMatchObject({ status: 'inconclusive', reasons: ['multiple_model_or_prompt_epochs_not_pooled'] });
});
