'use strict';

const { fingerprintEvidence, sha256Text, summarizeQualification } = require('../services/sms-scheduling-qualification');

const MODEL = 'claude-sonnet-test';
const PROMPT = 'sms_sched_decide_v2';
const source = {
  schemaVersion: 1,
  source: { kind: 'independent_manual_review', reviewedBy: 'staff-reviewer-id', reviewedAt: '2026-10-02T12:00:00Z', reference: 'private-review-batch-1' },
};

const VALID_EXPECTED_PAIRS = [
  ['accept_slot', 'move'], ['accept_slot', 'book'], ['accept_slot', 'confirm_only'], ['accept_slot', 'staff'],
  ['decline', 'no_action'], ['asks_other_time', 'no_action'], ['unclear', 'no_action'], ['unsupported', 'unsupported'],
];
const VALID_MODEL_PAIRS = [
  ['accept_slot', 'would_move'], ['accept_slot', 'would_book'], ['accept_slot', 'confirm_only'], ['accept_slot', 'staff'],
  ['decline', 'no_action'], ['asks_other_time', 'no_action'], ['unclear', 'no_action'], ['unsupported', 'unsupported'],
];
const VALID_COMBINED_CASES = [
  ['accepted move', { action: 'accept_slot', outcome: 'would_move', expectedAction: 'accept_slot', expectedOutcome: 'move' }],
  ['accepted booking', { kind: 'book_new', action: 'accept_slot', outcome: 'would_book', expectedAction: 'accept_slot', expectedOutcome: 'book' }],
  ['accepted confirmation', { action: 'accept_slot', outcome: 'confirm_only', expectedAction: 'accept_slot', expectedOutcome: 'confirm_only' }],
  ['accepted staff handling', { action: 'accept_slot', outcome: 'staff', expectedAction: 'accept_slot', expectedOutcome: 'staff' }],
  ['decline', { action: 'decline', outcome: 'no_action', expectedAction: 'decline', expectedOutcome: 'no_action' }],
  ['other-time request', { action: 'asks_other_time', outcome: 'no_action', expectedAction: 'asks_other_time', expectedOutcome: 'no_action' }],
  ['unclear reply', { action: 'unclear', outcome: 'no_action', expectedAction: 'unclear', expectedOutcome: 'no_action' }],
  ['unsupported reply', { action: 'unsupported', outcome: 'unsupported', expectedAction: 'unsupported', expectedOutcome: 'unsupported' }],
];
const invalidPairs = (actions, outcomes, valid) => {
  const keys = new Set(valid.map(([action, outcome]) => `${action}/${outcome}`));
  return actions.flatMap((action) => outcomes.map((outcome) => [action, outcome]))
    .filter(([action, outcome]) => !keys.has(`${action}/${outcome}`));
};
const INVALID_EXPECTED_PAIRS = invalidPairs(
  ['accept_slot', 'decline', 'asks_other_time', 'unclear', 'unsupported'],
  ['move', 'book', 'confirm_only', 'staff', 'no_action', 'unsupported'],
  VALID_EXPECTED_PAIRS,
);
const INVALID_MODEL_PAIRS = invalidPairs(
  ['accept_slot', 'decline', 'asks_other_time', 'unclear', 'unsupported'],
  ['would_move', 'would_book', 'confirm_only', 'staff', 'no_action', 'unsupported'],
  VALID_MODEL_PAIRS,
);

function cohort(overrides = new Map(), size = 41) {
  const rows = [];
  const adjudications = [];
  const bodies = new Map();
  for (let i = 0; i < size; i += 1) {
    // Two independently reviewed accepts for offer 0 prove repeated replies do
    // not increase the distinct-offer denominator.
    const offerNumber = i === size - 1 ? 0 : i;
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
    const planned = ['would_move', 'would_book', 'confirm_only', 'staff'].includes(outcome) && action === 'accept_slot';
    const wouldHave = configured.wouldHave || (planned
      ? { kind: outcome === 'would_move' ? 'move_visit' : kind, scheduled_service_id: `visit-${offerNumber}`, date: '2026-10-06', start: '10:00', arrival_end: '12:00' }
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
      before: { observed: true, observedAt: '2026-10-02T10:00:00Z', visit: { date: '2026-10-05', start: '08:00', end: '10:00', status: 'confirmed' } },
      after: { observed: outcome === 'would_move', observedAt: outcome === 'would_move' ? '2026-10-02T10:00:01Z' : null, visit: outcome === 'would_move' ? { date: '2026-10-05', start: '08:00', end: '10:00', status: 'confirmed' } : null },
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

function reseal(c, index) {
  c.rows[index].evidence_fingerprint = fingerprintEvidence(c.rows[index].decision_evidence);
  c.adjudications[index].evidenceFingerprint = c.rows[index].evidence_fingerprint;
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

test('stale plans and incomplete operational snapshots cannot complete the cohort', () => {
  const strayPlan = cohort();
  const wouldHave = { kind: 'move_visit', scheduled_service_id: 'visit-1', date: '2026-10-06', start: '10:00', arrival_end: '12:00' };
  strayPlan.rows[1].would_have = wouldHave;
  strayPlan.rows[1].decision_evidence.decision.wouldHave = wouldHave;
  strayPlan.rows[1].evidence_fingerprint = fingerprintEvidence(strayPlan.rows[1].decision_evidence);
  strayPlan.adjudications[1].evidenceFingerprint = strayPlan.rows[1].evidence_fingerprint;
  expect(summarizeQualification(strayPlan.rows, { ...source, adjudications: strayPlan.adjudications }, strayPlan.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });

  const placeholder = cohort();
  placeholder.rows[1].decision_evidence.before = {};
  placeholder.rows[1].evidence_fingerprint = fingerprintEvidence(placeholder.rows[1].decision_evidence);
  placeholder.adjudications[1].evidenceFingerprint = placeholder.rows[1].evidence_fingerprint;
  expect(summarizeQualification(placeholder.rows, { ...source, adjudications: placeholder.adjudications }, placeholder.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });

  const emptyMove = cohort();
  emptyMove.rows[0].decision_evidence.before.visit = {};
  emptyMove.rows[0].decision_evidence.after.visit = {};
  emptyMove.rows[0].evidence_fingerprint = fingerprintEvidence(emptyMove.rows[0].decision_evidence);
  emptyMove.adjudications[0].evidenceFingerprint = emptyMove.rows[0].evidence_fingerprint;
  expect(summarizeQualification(emptyMove.rows, { ...source, adjudications: emptyMove.adjudications }, emptyMove.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('every selected move offer requires a complete before-visit snapshot', () => {
  const c = cohort();
  c.rows[1].decision_evidence.before.visit = null;
  reseal(c, 1);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('an accepted move decision requires its selected slot to be complete', () => {
  const c = cohort(new Map([[5, {
    action: 'accept_slot', outcome: 'confirm_only', expectedAction: 'accept_slot', expectedOutcome: 'confirm_only',
  }]]));
  c.rows[5].decision_evidence.offers[0].slots = [
    { date: '2026-10-06', start: '10:00' },
    { date: '2026-10-06', start: '13:00', end: '15:00' },
  ];
  reseal(c, 5);
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.epochs[0]).toMatchObject({ reviewed: 40, incompleteEvidence: 1, distinctOffersScored: 39 });
});

test('malformed persisted would-have JSON cannot match a null decision plan', () => {
  const c = cohort();
  c.rows[1].would_have = '{';
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('duplicate or blank offer ids cannot identify one linked selected offer', () => {
  const duplicate = cohort();
  duplicate.rows[1].decision_evidence.offers.push({ ...duplicate.rows[1].decision_evidence.offers[0] });
  reseal(duplicate, 1);
  expect(summarizeQualification(duplicate.rows, { ...source, adjudications: duplicate.adjudications }, duplicate.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });

  const blank = cohort();
  blank.rows[1].sms_offer_id = ' ';
  blank.rows[1].decision_evidence.offers[0].id = ' ';
  blank.rows[1].decision_evidence.selectedOfferId = ' ';
  reseal(blank, 1);
  expect(summarizeQualification(blank.rows, { ...source, adjudications: blank.adjudications }, blank.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test.each([
  ['offer id', (c) => { c.rows[1].decision_evidence.offers[0].id = ['offer-1']; }],
  ['selected offer id', (c) => { c.rows[1].decision_evidence.selectedOfferId = ['offer-1']; }],
  ['persisted offer id', (c) => { c.rows[1].sms_offer_id = ['offer-1']; }],
])('an array-valued %s cannot match through string coercion', (_label, mutate) => {
  const c = cohort();
  mutate(c);
  reseal(c, 1);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('adjudications without matching decisions make the whole cohort inconclusive', () => {
  const c = cohort();
  c.rows.pop();
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result).toMatchObject({
    status: 'inconclusive',
    reasons: expect.arrayContaining(['adjudications_without_matching_decisions']),
    cohort: { decisions: 40, adjudicationsProvided: 41, extras: 1 },
    epochs: [{ status: 'qualified' }],
  });
});

test.each(VALID_COMBINED_CASES)('declared %s action/outcome evidence is accepted', (_label, configured) => {
  const c = cohort(new Map([[1, configured]]));
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies).epochs[0])
    .toMatchObject({ reviewed: 41, invalidOrConflictingReviews: 0, incompleteEvidence: 0 });
});

test.each(INVALID_EXPECTED_PAIRS)('review action/outcome pairing %s/%s is invalid', (action, outcome) => {
  const c = cohort();
  c.adjudications[1].expected = action === 'accept_slot'
    ? { action, outcome, offerId: 'offer-1', slotNumber: 1 } : { action, outcome };
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ invalidOrConflictingReviews: 1 }] });
});

test.each([
  ['missing offer id', (expected) => { delete expected.offerId; }],
  ['wrong offer id', (expected) => { expected.offerId = 'different-offer'; }],
  ['zero slot number', (expected) => { expected.slotNumber = 0; }],
  ['missing numbered slot', (expected) => { expected.slotNumber = 2; }],
  ['missing move verdict', (expected) => { delete expected.move; }],
  ['wrong scheduled service', (expected) => { expected.move.scheduledServiceId = 'different-visit'; }],
  ['wrong move date', (expected) => { expected.move.date = '2026-10-07'; }],
  ['wrong move start', (expected) => { expected.move.start = '11:00'; }],
  ['wrong move end', (expected) => { expected.move.arrivalEnd = '13:00'; }],
])('accepted review evidence rejects a %s', (_label, mutate) => {
  const c = cohort();
  mutate(c.adjudications[0].expected);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ invalidOrConflictingReviews: 1 }] });
});

test.each([
  ['offer id', (expected) => { expected.offerId = 'offer-1'; }],
  ['slot number', (expected) => { expected.slotNumber = 1; }],
  ['move verdict', (expected) => { expected.move = { scheduledServiceId: 'visit-1' }; }],
])('non-accept review evidence rejects an extraneous %s', (_label, mutate) => {
  const c = cohort();
  mutate(c.adjudications[1].expected);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ invalidOrConflictingReviews: 1 }] });
});

test.each([
  ['non-date/time strings', { date: 'x', start: 'x', end: 'x' }],
  ['impossible calendar date', { date: '2026-02-30', start: '10:00', end: '12:00' }],
  ['non-leap February 29', { date: '2026-02-29', start: '10:00', end: '12:00' }],
  ['year zero', { date: '0000-10-06', start: '10:00', end: '12:00' }],
  ['out-of-range start', { date: '2026-10-06', start: '24:00', end: '12:00' }],
  ['out-of-range end', { date: '2026-10-06', start: '10:00', end: '10:60' }],
  ['non-forward window', { date: '2026-10-06', start: '12:00', end: '10:00' }],
])('a move offer with %s is not a scored actionable offer', (_label, slot) => {
  const c = cohort();
  c.rows[1].decision_evidence.offers[0].slots = [slot];
  reseal(c, 1);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ distinctOffersScored: 39 }] });
});

test('a real leap-day move slot remains actionable', () => {
  const c = cohort();
  c.rows[1].decision_evidence.offers[0].slots = [{ date: '2028-02-29', start: '10:00', end: '12:00' }];
  reseal(c, 1);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies).epochs[0])
    .toMatchObject({ distinctOffersScored: 40 });
});

test.each(INVALID_MODEL_PAIRS)(
  'model decision action/outcome pairing %s/%s is incomplete evidence',
  (action, outcome) => {
    const c = cohort(new Map([[1, { action, outcome }]]));
    expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
      .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
  },
);

test.each([
  ['move_visit', 'would_book'],
  ['book_new', 'would_move'],
  ['book_new', 'confirm_only'],
])('model outcome %s/%s cannot contradict the selected offer family', (kind, outcome) => {
  const c = cohort(new Map([[1, {
    kind, action: 'accept_slot', outcome, expectedAction: 'decline', expectedOutcome: 'no_action',
  }]]));
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('an accepted decision plan kind must match the selected offer kind', () => {
  const c = cohort();
  c.rows[0].would_have.kind = 'book_new';
  c.rows[0].decision_evidence.decision.wouldHave.kind = 'book_new';
  reseal(c, 0);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test.each([
  ['future_action', 'no_action'],
  ['decline', 'future_outcome'],
])('unknown model decision pairing %s/%s is incomplete evidence', (action, outcome) => {
  const c = cohort(new Map([[1, { action, outcome }]]));
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test.each([
  ['accepted decision without a slot number', 0, null],
  ['non-accept decision with a slot number', 1, 1],
  ['non-accept decision without explicit null', 1, undefined],
])('%s is incomplete model evidence', (_label, index, slotNumber) => {
  const c = cohort();
  c.rows[index].slot_number = slotNumber;
  c.rows[index].decision_evidence.decision.slotNumber = slotNumber;
  reseal(c, index);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test.each([null, 'plan', 1, []])('an accepted decision plan must be a record, not %p', (plan) => {
  const c = cohort();
  c.rows[0].would_have = plan;
  c.rows[0].decision_evidence.decision.wouldHave = plan;
  reseal(c, 0);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('a null model-selected slot is incomplete evidence instead of throwing', () => {
  const c = cohort();
  c.rows[0].decision_evidence.offers[0].slots = [null];
  reseal(c, 0);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('a null independently selected move slot is an invalid review instead of throwing', () => {
  const c = cohort();
  c.rows[0].decision_evidence.offers[0].slots.push(null);
  reseal(c, 0);
  c.adjudications[0].expected.slotNumber = 2;
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ invalidOrConflictingReviews: 1 }] });
});

test.each([
  ['before visit date', 1, 'before', 'date', '2026-02-30'],
  ['before visit time', 1, 'before', 'start', '25:00'],
  ['before visit window ordering', 1, 'before', 'end', '07:00'],
  ['after visit date', 0, 'after', 'date', '2026-02-30'],
  ['after visit time', 0, 'after', 'end', '25:00'],
])('a malformed %s is incomplete operational evidence', (_label, index, phase, field, value) => {
  const c = cohort();
  c.rows[index].decision_evidence[phase].visit[field] = value;
  reseal(c, index);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test.each([
  ['before snapshot', 1, 'before'],
  ['after snapshot', 0, 'after'],
])('a year-zero %s timestamp is incomplete evidence', (_label, index, phase) => {
  const c = cohort();
  c.rows[index].decision_evidence[phase].observedAt = '0000-01-01T00:00:00Z';
  reseal(c, index);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('an after snapshot cannot predate its before snapshot', () => {
  const c = cohort();
  c.rows[0].decision_evidence.after.observedAt = '2026-10-02T09:59:59Z';
  reseal(c, 0);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
});

test('equal before and after instants remain valid at coarse timestamp precision', () => {
  const c = cohort();
  c.rows[0].decision_evidence.after.observedAt = c.rows[0].decision_evidence.before.observedAt;
  reseal(c, 0);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies).epochs[0])
    .toMatchObject({ incompleteEvidence: 0 });
});

test('duplicate decision ids cannot reuse or ambiguously bind review evidence', () => {
  const c = cohort();
  c.rows[1].id = c.rows[0].id;
  c.adjudications[1].decisionId = c.adjudications[0].decisionId;
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({
      status: 'inconclusive', cohort: { conflicts: 1 },
      epochs: [{ invalidOrConflictingReviews: 2 }],
    });
});

test('qualification compares exact recall counts instead of the rounded report value', () => {
  const overrides = new Map();
  for (let i = 0; i < 4005; i += 1) {
    const caught = i <= 3202 || i === 4004;
    overrides.set(i, { expectedAction: 'accept_slot', ...(caught ? {} : { action: 'decline', outcome: 'no_action' }) });
  }
  const c = cohort(overrides, 4005);
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('not_qualified');
  expect(result.epochs[0].trueAccepts).toMatchObject({
    distinctOffers: 4004, caughtDistinctOffers: 3203, offerRecall: 0.8,
  });
  expect(result.epochs[0].reasons).toContain('true_accept_offer_recall_below_80_percent');
});

test('one missed repeated accept misses that offer, and any wrong would-move fails the bar', () => {
  const missed = cohort(new Map([[40, { action: 'decline', outcome: 'no_action' }]]));
  const missedResult = summarizeQualification(missed.rows, { ...source, adjudications: missed.adjudications }, missed.bodies);
  expect(missedResult.status).toBe('not_qualified');
  expect(missedResult.epochs[0].trueAccepts).toMatchObject({ decisions: 2, caughtDecisions: 1, distinctOffers: 1, caughtDistinctOffers: 0, offerRecall: 0 });

  const staffedMove = cohort(new Map([[0, { action: 'accept_slot', outcome: 'staff' }]]));
  const staffedMoveResult = summarizeQualification(staffedMove.rows, { ...source, adjudications: staffedMove.adjudications }, staffedMove.bodies);
  expect(staffedMoveResult.status).toBe('not_qualified');
  expect(staffedMoveResult.epochs[0].trueAccepts)
    .toMatchObject({ decisions: 2, caughtDecisions: 1, distinctOffers: 1, caughtDistinctOffers: 0, offerRecall: 0 });

  const wrong = cohort(new Map([[5, { action: 'accept_slot', outcome: 'would_move' }]]));
  const wrongResult = summarizeQualification(wrong.rows, { ...source, adjudications: wrong.adjudications }, wrong.bodies);
  expect(wrongResult.status).toBe('not_qualified');
  expect(wrongResult.epochs[0].wrongProposedMoves).toBe(1);

  const wrongTarget = cohort(new Map([[0, { wouldHave: { kind: 'move_visit', scheduled_service_id: 'visit-0', date: '2026-10-06', start: '11:00', arrival_end: '13:00' } }]]));
  expect(summarizeQualification(wrongTarget.rows, { ...source, adjudications: wrongTarget.adjudications }, wrongTarget.bodies)
    .epochs[0].wrongProposedMoves).toBe(1);

  const unexpectedMove = cohort(new Map([[0, { expectedOutcome: 'staff' }]]));
  expect(summarizeQualification(unexpectedMove.rows, { ...source, adjudications: unexpectedMove.adjudications }, unexpectedMove.bodies)
    .epochs[0]).toMatchObject({ wrongProposedMoves: 1, trueAccepts: { caughtDecisions: 1, offerRecall: 0 } });

  // An outcome that contradicts the selected offer family is incomplete
  // evidence and cannot be used to qualify the lane.
  const wrongBooking = cohort(new Map([[40, { kind: 'book_new', expectedAction: 'accept_slot', action: 'accept_slot', outcome: 'would_move' }]]));
  const wrongBookingResult = summarizeQualification(wrongBooking.rows, { ...source, adjudications: wrongBooking.adjudications }, wrongBooking.bodies);
  expect(wrongBookingResult.status).toBe('inconclusive');
  expect(wrongBookingResult.epochs[0]).toMatchObject({
    incompleteEvidence: 1, distinctOffersScored: 40, proposedMoves: 1, wrongProposedMoves: 0,
  });
});

test('unresolved move offers do not enter the distinct scored-offer denominator', () => {
  const c = cohort();
  for (let i = 1; i < 40; i += 1) {
    if (i === 1) c.rows[i].decision_evidence.offers[0].scheduledServiceId = null;
    else c.rows[i].decision_evidence.offers[0].slots = [];
    c.rows[i].evidence_fingerprint = fingerprintEvidence(c.rows[i].decision_evidence);
    c.adjudications[i].evidenceFingerprint = c.rows[i].evidence_fingerprint;
  }
  const result = summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies);
  expect(result.status).toBe('inconclusive');
  expect(result.epochs[0]).toMatchObject({ incompleteEvidence: 1, distinctOffersReviewed: 39, distinctOffersScored: 1 });
  expect(result.epochs[0].reasons).toContain('fewer_than_40_distinct_scored_offers');
});

test.each([123, {}, []])('a non-string scheduled-service id %p is incomplete evidence', (scheduledServiceId) => {
  const c = cohort();
  c.rows[1].decision_evidence.offers[0].scheduledServiceId = scheduledServiceId;
  reseal(c, 1);
  expect(summarizeQualification(c.rows, { ...source, adjudications: c.adjudications }, c.bodies))
    .toMatchObject({ status: 'inconclusive', epochs: [{ incompleteEvidence: 1 }] });
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

  const yearZero = cohort();
  expect(summarizeQualification(yearZero.rows, {
    ...source,
    source: { ...source.source, reviewedAt: '0000-01-01T00:00:00Z' },
    adjudications: yearZero.adjudications,
  }, yearZero.bodies)).toMatchObject({
    status: 'inconclusive', reasons: expect.arrayContaining(['missing_or_invalid_operator_adjudication_provenance']),
  });
});
