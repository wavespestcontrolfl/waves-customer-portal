/**
 * agent-decision-send-checks — the one send-time verdict over an Agent
 * Review decision's content (PR #5119 follow-up #6): open-times plan +
 * recheck, follow-up promise, billing amounts. The route only orchestrates.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-shadow-drafter', () => ({
  planOpenTimesRecheck: jest.fn(),
  openTimesStillOffered: jest.fn(),
  // the amount pattern sms-amount-recheck reads off the drafter (bodyAmountCents); without it the pattern is
  // undefined and every body looks like it carries an amount
  AMOUNT_MASK_RE: /\$\s?\d[\d,]*(?:\.\d{1,2})?/g,
  reservicePromiseStillEligible: jest.fn(),
}));
// slaDraftedAt is kept REAL (only followupPromiseBlockReason is mocked) so
// this suite proves the actual facts_generated_at → created_at fallback the
// seam relies on (Codex #5194 P2), not a stand-in.
jest.mock('../services/sms-followup-sla', () => ({
  ...jest.requireActual('../services/sms-followup-sla'),
  followupPromiseBlockReason: jest.fn(() => null),
}));
// hasAffirmativeZelleMention is kept REAL (only outgoingAmountsStale is
// mocked) so this suite exercises the actual Zelle-offer detection that now
// gates whether the amounts/Zelle recheck runs at all (independent-review
// P1, round 6, PR #5331), not a stand-in.
jest.mock('../services/sms-amount-recheck', () => ({
  ...jest.requireActual('../services/sms-amount-recheck'),
  outgoingAmountsStale: jest.fn(async () => ({ stale: false })),
}));
// bodyNeedsPaymentRecheck (the scheduler's gate, now this seam's too) asks the real sms-suggest-mode for price grammar;
// that module cannot load under this file's stubbed drafter (it fails closed => "needs recheck"), so give it a stand-in.
jest.mock('../services/sms-suggest-mode', () => ({
  hasPriceQuote: jest.fn((text) => /\$\s*\d|\b\d[\d,]*(?:\.\d+)?\s*dollars?\b/i.test(String(text || ''))),
}));
jest.mock('../services/sms-eta-freshness', () => ({
  etaClaimBlockReason: jest.fn(async () => null),
  // The ONE shared infrastructure-failure set (round-42 P2) is consulted by the wrappers.
  isEtaInfrastructureFailure: (reason) => jest.requireActual('../services/sms-eta-freshness').isEtaInfrastructureFailure(reason),
}));
jest.mock('../models/db', () => jest.fn());
const db = require('../models/db');
const drafter = require('../services/sms-shadow-drafter');
const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
const { etaClaimBlockReason } = require('../services/sms-eta-freshness');
const { agentDecisionSendBlockReason, parseInputSnapshot, scheduledEtaBlockReason, etaProviderPreSendCheck, etaSnapshotProviderPreSendCheck, composeProviderPreSendChecks } = require('../services/agent-decision-send-checks');

const SNAP = { open_times_snapshot: { lookup: { city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Lawn Care' }, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] } };
const decision = (over = {}) => ({ id: 'd1', customer_id: 'c1', suggested_message: 'How about Tuesday 9:00 AM - 11:00 AM?', input_snapshot: JSON.stringify(SNAP), prompt_version: 'house_voice_v12_real_answers', ...over });

beforeEach(() => {
  drafter.planOpenTimesRecheck.mockReset().mockReturnValue({ action: 'recheck', quotedWindows: SNAP.open_times_snapshot.quotedWindows });
  drafter.openTimesStillOffered.mockReset().mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReset().mockReturnValue(null);
  outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
  drafter.reservicePromiseStillEligible.mockReset().mockResolvedValue(null);
  etaClaimBlockReason.mockReset().mockResolvedValue(null);
});

test('parseInputSnapshot: string, object, malformed, absent', () => {
  expect(parseInputSnapshot(JSON.stringify({ a: 1 }))).toEqual({ a: 1 });
  expect(parseInputSnapshot({ a: 1 })).toEqual({ a: 1 });
  expect(parseInputSnapshot('{nope')).toBeNull();
  expect(parseInputSnapshot(null)).toBeNull();
});

test('everything passes → null; the recheck carries the snapshot lookup including serviceType', async () => {
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' })).resolves.toBeNull();
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ city: 'Venice', customerId: 'c1', serviceType: 'Lawn Care' }));
  expect(outgoingAmountsStale).toHaveBeenCalledWith({ customerId: 'c1', body: 'How about Tuesday 9:00 AM - 11:00 AM?', promptVersion: 'house_voice_v12_real_answers', zelleInvoiceId: null, inboundMessage: null, paymentStatusSnapshot: null, humanEditedBody: false, trustOwedAmounts: false });
});

// Pre-push audit P1 (finding 2): the invoice the drafter's Zelle fact was
// built for rides the same input_snapshot as facts_generated_at, and this
// seam must read it back and thread it into the recheck.
test('a decision carrying zelle_invoice_id threads it into the amount recheck', async () => {
  await agentDecisionSendBlockReason({
    decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, zelle_invoice_id: 'inv-42' }) }),
    outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?',
  });
  expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ zelleInvoiceId: 'inv-42' }));
});

test('a scheduler-minted snapshot forwards its scheduledServiceId to the recheck (GATE_SMS_OFFERS_SCHEDULER)', async () => {
  const snap = { open_times_snapshot: { ...SNAP.open_times_snapshot, lookup: { ...SNAP.open_times_snapshot.lookup, scheduledServiceId: 'ss-1', source: 'scheduler' } } };
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify(snap) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ city: 'Venice', scheduledServiceId: 'ss-1' }));
  // a legacy snapshot carries no such key at all
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('scheduledServiceId');
});

test('a /book or estimate snapshot forwards its source (+ serviceKey) to the recheck; a legacy snapshot carries neither', async () => {
  const withLookup = (extra) => JSON.stringify({ open_times_snapshot: { ...SNAP.open_times_snapshot, lookup: { ...SNAP.open_times_snapshot.lookup, ...extra } } });
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: withLookup({ source: 'book', serviceKey: 'lawn_care' }) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ source: 'book', serviceKey: 'lawn_care' }));
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: withLookup({ estimateId: 'est-1', source: 'estimate' }) }), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered).toHaveBeenCalledWith(expect.objectContaining({ source: 'estimate', estimateId: 'est-1' }));
  drafter.openTimesStillOffered.mockClear();
  await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('source');
  expect(drafter.openTimesStillOffered.mock.calls[0][0]).not.toHaveProperty('serviceKey');
});

test('an unverifiable edit refuses before any availability call', async () => {
  drafter.planOpenTimesRecheck.mockReturnValue({ action: 'refuse', reason: 'edited_offer_text' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('open-times unverifiable after edit (edited_offer_text)');
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
});

test('the follow-up check receives the decision\'s draft time so a passed deadline can refuse', async () => {
  await agentDecisionSendBlockReason({ decision: decision({ created_at: '2026-09-28T14:00:00Z' }), outgoingBody: 'x' });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(expect.objectContaining({ draftedAt: '2026-09-28T14:00:00Z' }));
});

// Codex #5194 P2: the SLA phrase is rendered off the drafter's OWN
// facts-generated instant, which can predate created_at (the row lands only
// after the full draft→verify→revise loop) — slaDraftedAt prefers it.
test('a decision carrying facts_generated_at anchors the follow-up check on it, not on created_at', async () => {
  await agentDecisionSendBlockReason({
    decision: decision({
      created_at: '2026-09-28T14:00:00Z',
      input_snapshot: JSON.stringify({ ...SNAP, facts_generated_at: '2026-09-28T13:45:00.000Z' }),
    }),
    outgoingBody: 'x',
  });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(
    expect.objectContaining({ draftedAt: new Date('2026-09-28T13:45:00.000Z') })
  );
});

// A legacy row (drafted before this change) or one whose caller predates the
// field carries no facts_generated_at at all — the check still runs off
// created_at exactly as before.
test('a decision with no facts_generated_at (legacy row) falls back to created_at', async () => {
  await agentDecisionSendBlockReason({
    decision: decision({ created_at: '2026-09-28T14:00:00Z', input_snapshot: JSON.stringify(SNAP) }),
    outgoingBody: 'x',
  });
  expect(followupPromiseBlockReason).toHaveBeenCalledWith(expect.objectContaining({ draftedAt: '2026-09-28T14:00:00Z' }));
});

test('a gone slot, a stale/edited follow-up promise, or a stale amount each refuse with its reason', async () => {
  drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_no_longer_offered' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('open-times stale (open_times_no_longer_offered)');
  drafter.openTimesStillOffered.mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReturnValue('sla_phrase_edited');
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('follow-up promise unsendable (sla_phrase_edited)');
  followupPromiseBlockReason.mockReturnValue(null);
  outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('amount no longer authorized (amount_no_longer_authorized)');
});

test('no snapshot → no availability call; an older-prompt decision skips the recheck for a body that needs none', async () => {
  await expect(agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }), outgoingBody: 'See you Tuesday, thanks!' })).resolves.toBeNull();
  expect(drafter.openTimesStillOffered).not.toHaveBeenCalled();
  expect(outgoingAmountsStale).not.toHaveBeenCalled();
});

// A Zelle OFFER or DENIAL is rechecked for every decision (an edited pre-v12 body too); a payment-status assertion or a figure
// is rechecked only for a real-answers (v12) decision - an older-prompt decision keeps main's behavior (gate off byte-identical).
describe('the recheck gate (PR #5331)', () => {
  const v11 = (over = {}) => decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11', ...over });
  test.each(["Zelle isn't available right now.", "We don't take Zelle.", 'Zelle is not available for this account right now, so use your pay link.'])(
    'a pre-v12 edited Zelle DENIAL runs the recheck: %s', async (body) => {
      outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_now_available' });
      await expect(agentDecisionSendBlockReason({ decision: v11(), outgoingBody: body })).resolves.toBe('amount no longer authorized (zelle_now_available)');
      expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', body, promptVersion: 'house_voice_v11', trustOwedAmounts: true }));
    },
  );
  test('a still-true denial goes out; a denial on a decision with no customer cannot be verified and FAILS CLOSED (round 28)', async () => {
    await expect(agentDecisionSendBlockReason({ decision: v11(), outgoingBody: "Zelle isn't available right now." })).resolves.toBeNull();
    await expect(agentDecisionSendBlockReason({ decision: v11({ customer_id: null }), outgoingBody: "Zelle isn't available right now." })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
  });
  test('a pre-v12 body that names a figure or a payment status is NOT rechecked (main\'s behavior); a Zelle offer is', async () => {
    for (const body of ['You owe $5.', 'Your payment was received.']) {
      outgoingAmountsStale.mockClear();
      await expect(agentDecisionSendBlockReason({ decision: v11(), outgoingBody: body })).resolves.toBeNull();
      expect(outgoingAmountsStale).not.toHaveBeenCalled();
    }
    await agentDecisionSendBlockReason({ decision: v11(), outgoingBody: 'You can Zelle us.' });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ body: 'You can Zelle us.', trustOwedAmounts: true }));
  });
  test('a v12 decision always runs the recheck and carries its payment_status_snapshot to it', async () => {
    const snap = { customer_id: 'c1', sentences: ['Your account has no balance due.'] };
    await agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ payment_status_snapshot: snap }) }),
      outgoingBody: 'Your account has no balance due.',
    });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ paymentStatusSnapshot: snap, trustOwedAmounts: false }));
  });
});

// Independent-review P1 (round 6, PR #5331): the Zelle recipient-plus-
// eligibility recheck must run for ANY outgoing body with an affirmative
// Zelle offer, whatever prompt version drafted it, and fail CLOSED when the
// decision carries no customer_id — an unverifiable Zelle offer must never
// go out unchecked.
describe('Zelle offers recheck regardless of prompt version (round 6)', () => {
  test('an older-prompt decision with a Zelle offer still runs the recheck', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }),
      outgoingBody: 'Yes, you can use Zelle for that.',
    });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', promptVersion: 'house_voice_v11',
    }));
  });

  test('an older-prompt decision never widens to the pooled amount rule (only its Zelle offer is rechecked)', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }),
      outgoingBody: 'Yes, you can use Zelle for that.',
    });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ trustOwedAmounts: true }));
  });

  test('a Zelle offer with NO customer_id on the decision fails closed without calling the recheck (unverifiable)', async () => {
    await expect(agentDecisionSendBlockReason({
      decision: decision({ customer_id: null, input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }),
      outgoingBody: 'Yes, you can use Zelle for that.',
    })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
    expect(outgoingAmountsStale).not.toHaveBeenCalled();
  });

  test('an older-prompt decision with NO Zelle offer and NO customer_id still skips the recheck entirely (unchanged scope)', async () => {
    await expect(agentDecisionSendBlockReason({
      decision: decision({ customer_id: null, input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11' }),
      outgoingBody: 'See you Tuesday!',
    })).resolves.toBeNull();
    expect(outgoingAmountsStale).not.toHaveBeenCalled();
  });
});

// Independent-review P1 (round 6, PR #5331): the customer's own inbound
// wording threads through to the amount/tender binder — from the joined
// sms_log row (decision.inbound_message) or, failing that, the drafted
// input_snapshot's own sms.body.
describe('inbound message threading (round 6)', () => {
  test('decision.inbound_message (the joined sms_log body) is passed through', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({ inbound_message: 'Did you get my $120 Zelle payment?' }),
      outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?',
    });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'Did you get my $120 Zelle payment?' }));
  });

  test('falls back to input_snapshot.sms.body when the decision carries no inbound_message', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, sms: { body: 'Did you get my $120 Zelle payment?' } }) }),
      outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?',
    });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: 'Did you get my $120 Zelle payment?' }));
  });

  test('neither present → inboundMessage is null', async () => {
    await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'How about Tuesday 9:00 AM - 11:00 AM?' });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ inboundMessage: null }));
  });
});

// A customerless decision cannot be verified against billing: it fails CLOSED for every body the recheck would judge - a Zelle
// claim for any decision, a figure / payment-status assertion for a real-answers one.
describe('customerless decisions (round 28)', () => {
  const noCustomer = (over = {}) => decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11', customer_id: null, ...over });
  const v12 = (over = {}) => noCustomer({ prompt_version: 'house_voice_v12_real_answers5_cf_pf', ...over });
  test.each(["Zelle isn't available right now.", 'You can use Zelle.'])('pre-v12 blocked: %s', async (body) => {
    await expect(agentDecisionSendBlockReason({ decision: noCustomer(), outgoingBody: body })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
    expect(outgoingAmountsStale).not.toHaveBeenCalled();
  });
  test.each([
    'Your payment was received.', "Zelle isn't available right now.", 'You can use Zelle.', 'You owe $95.', 'Your balance is zero.', 'Your payment settled.',
    'Your invoice is settled.', 'Your card was declined.',
  ])('v12 blocked: %s', async (body) => {
    await expect(agentDecisionSendBlockReason({ decision: v12({ suggested_message: body }), outgoingBody: body })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
    expect(outgoingAmountsStale).not.toHaveBeenCalled();
  });
  test.each([
    'Your invoice is attached.', 'We updated your account details.', 'Your invoice is ready below.', 'See you Tuesday!', 'Your card on file is a Visa ending 4242.', 'You can pay online with the link.',
  ])('v12 benign copy is NOT blocked: %s', async (body) => {
    await expect(agentDecisionSendBlockReason({ decision: v12(), outgoingBody: body })).resolves.toBeNull();
  });
  test('a pre-v12 customerless status / figure body is not selected (main\'s behavior)', async () => {
    await expect(agentDecisionSendBlockReason({ decision: noCustomer(), outgoingBody: 'See you Tuesday, thanks!' })).resolves.toBeNull();
    await expect(agentDecisionSendBlockReason({ decision: noCustomer(), outgoingBody: 'Your payment was received.' })).resolves.toBeNull();
  });
});

// The decision's own inbound scopes the detector: a bare pronoun clause is a payment status only in a payment conversation.
describe('customerless decisions carry their inbound into the detector', () => {
  const withInbound = (inbound, over = {}) => decision({
    input_snapshot: JSON.stringify({ sms: { body: inbound } }), prompt_version: 'house_voice_v12_real_answers5_cf_pf', customer_id: null, ...over,
  });
  test.each(['It settled.', 'It failed.', 'That cleared out.', "They're sorted."])('%s after a payment question is blocked (cannot verify, no customer)', async (body) => {
    await expect(agentDecisionSendBlockReason({ decision: withInbound('Did my payment go through?', { suggested_message: body }), outgoingBody: body })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
  });
  test('...but "It settled." after an unrelated inbound is not a payment status', async () => {
    await expect(agentDecisionSendBlockReason({ decision: withInbound('What time is my visit Tuesday?'), outgoingBody: 'It settled.' })).resolves.toBeNull();
  });
});

// Codex round-3 P2: a reviewed card can promise a free re-service and then
// sit long enough for the customer's eligibility to change before it fires
// — reservicePromiseStillEligible revalidates against LIVE eligibility,
// keyed on the lane(s) recorded at draft time.
describe('re-service promise revalidation (Codex round-3 P2)', () => {
  const reserviceSnapshot = { reservice_lanes_snapshot: ['pest'] };

  test('a reservice-eligible send passes the recorded lane(s) + customer through to the live check', async () => {
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: "Good news — we'll send your free re-service link now.",
    })).resolves.toBeNull();
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalledWith({
      outgoingBody: "Good news — we'll send your free re-service link now.",
      customerId: 'c1',
      promisedLanes: ['pest'],
      decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: null, intendedActions: null, bookedCallbacks: null, inboundMessage: null },
    });
  });

  test('no longer eligible → refuses with the reason', async () => {
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: "Good news — we'll send your free re-service link now.",
    })).resolves.toBe('re-service promise unsendable (no longer eligible for a free pest re-service)');
  });

  test('runs only after open-times/follow-up/amounts already passed (fail-fast ordering)', async () => {
    drafter.openTimesStillOffered.mockResolvedValue({ ok: false, reason: 'open_times_no_longer_offered' });
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({
      decision: decision({ input_snapshot: JSON.stringify({ ...SNAP, ...reserviceSnapshot }) }),
      outgoingBody: 'x',
    })).resolves.toBe('open-times stale (open_times_no_longer_offered)');
    expect(drafter.reservicePromiseStillEligible).not.toHaveBeenCalled();
  });

  test('an ordinary body with no re-service promise and no snapshot still resolves the live check (no-op) with promisedLanes null', async () => {
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'You owe $5.' })).resolves.toBeNull();
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalledWith({
      outgoingBody: 'You owe $5.',
      customerId: 'c1',
      promisedLanes: null,
      decisionMeta: { promptVersion: 'house_voice_v12_real_answers', draftId: null, intendedActions: null, bookedCallbacks: null, inboundMessage: null },
    });
  });
});

// Re-service runs BEFORE the ETA recheck (main's order, ETA appended): a failing re-service
// recheck short-circuits, and both checks run on a clean pass.
describe('re-service + LIVE ETA ordering on the same send path', () => {
  test('a re-service refusal short-circuits before the ETA recheck', async () => {
    drafter.reservicePromiseStillEligible.mockResolvedValue('no longer eligible for a free pest re-service');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('re-service promise unsendable (no longer eligible for a free pest re-service)');
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });

  test('a clean re-service recheck still reaches the ETA recheck', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' })).resolves.toBe('live ETA unsendable (eta_claim_no_longer_en_route)');
    expect(drafter.reservicePromiseStillEligible).toHaveBeenCalled();
  });
});

// LIVE ETA (independent review + Codex round-1 finding, PR #5334): checked
// last, after open times/follow-up/amounts all pass, and fed the decision's
// own live_eta_snapshot + facts_generated_at straight from its snapshot.
describe('LIVE ETA send-time recheck', () => {
  test('a stale/blocked LIVE ETA refuses the send with its reason', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'The tech is 12 minutes away.' }))
      .resolves.toBe('live ETA unsendable (eta_claim_no_longer_en_route)');
  });

  test('a clean LIVE ETA recheck falls through to null like every other passing check', async () => {
    await expect(agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'The tech is 12 minutes away.' })).resolves.toBeNull();
  });

  test('the recheck receives the decision\'s own live_eta_snapshot and facts_generated_at', async () => {
    await agentDecisionSendBlockReason({
      decision: decision({
        input_snapshot: JSON.stringify({ ...SNAP, live_eta_snapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, facts_generated_at: '2026-09-29T14:00:00.000Z' }),
      }),
      outgoingBody: 'The tech is 12 minutes away.',
    });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: '2026-09-29T14:00:00.000Z',
      outgoingBody: 'The tech is 12 minutes away.',
    }));
  });

  test('an earlier failing check (open times) short-circuits before the ETA recheck ever runs', async () => {
    drafter.planOpenTimesRecheck.mockReturnValue({ action: 'refuse', reason: 'edited_offer_text' });
    await agentDecisionSendBlockReason({ decision: decision(), outgoingBody: 'x' });
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });
});

// The scheduler's queued-send path (Codex round-10 P2, PR #5334): one flat
// call into this same ETA check, reading the claimed decision row itself.
describe('scheduledEtaBlockReason — the scheduler seam over the same ETA check', () => {
  const rowFor = (row) => { db.mockImplementation(() => ({ where: () => ({ first: async () => row }) })); };

  test('reads the decision row and hands its live_eta_snapshot + facts_generated_at to the shared check', async () => {
    rowFor({ input_snapshot: { live_eta_snapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] }, facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    etaClaimBlockReason.mockResolvedValue('eta_claim_stale_facts');
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'The tech is 12 minutes away.' })).resolves.toBe('eta_claim_stale_facts');
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({
      liveEtaSnapshot: { entries: [{ minutes: 12, scheduledServiceIds: ['svc-1'] }] },
      factsGeneratedAt: '2026-09-29T14:00:00.000Z',
    }));
  });

  test('a JSON-string snapshot is parsed; a clean recheck returns null', async () => {
    rowFor({ input_snapshot: JSON.stringify({ facts_generated_at: '2026-09-29T14:00:00.000Z' }) });
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'Thanks!' })).resolves.toBeNull();
  });

  test('skip: an earlier revalidation already blocked — no read, no recheck', async () => {
    db.mockClear();
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'x', skip: true })).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(etaClaimBlockReason).not.toHaveBeenCalled();
  });

  test('fails CLOSED when the row read throws', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(scheduledEtaBlockReason({ decisionId: 'd1', outgoingBody: 'x' })).resolves.toBe('eta_recheck_failed');
  });
});

// Codex round-40 P2 (PR #5334): the same ETA check at the TRUE provider boundary.
describe('etaProviderPreSendCheck / composeProviderPreSendChecks — the provider-boundary predicate', () => {
  const rowFor = (row) => { db.mockImplementation(() => ({ where: () => ({ first: async () => row }) })); };

  test('a clean recheck lets the send through; the body is read lazily at call time', async () => {
    rowFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    let body = 'Thanks!';
    const check = etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => body });
    body = 'The tech is 9 minutes away.'; // rewritten after the check was built (spacing guard)
    await expect(check({ channel: 'sms' })).resolves.toEqual({ ok: true });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ outgoingBody: 'The tech is 9 minutes away.' }));
  });

  test('a stale ETA at the boundary is a TERMINAL refusal', async () => {
    rowFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    const verdict = await etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'The tech is 9 minutes away.' })();
    expect(verdict).toEqual({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY', reason: 'live ETA unsendable (eta_claim_no_longer_en_route)' });
  });

  test('an unreadable recheck is RETRYABLE (never sent unverified, never terminal)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const verdict = await etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })();
    expect(verdict).toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('compose: undefined entries are skipped; nothing to run -> undefined; the first refusal wins and later checks do not run', async () => {
    expect(composeProviderPreSendChecks(undefined, undefined)).toBeUndefined();
    const only = jest.fn(async () => ({ ok: true }));
    expect(composeProviderPreSendChecks(undefined, only)).toBe(only);
    const first = jest.fn(async () => ({ ok: false, code: 'FIRST' }));
    const second = jest.fn(async () => ({ ok: true }));
    const both = composeProviderPreSendChecks(first, second);
    await expect(both({ dbi: 'trx' })).resolves.toEqual({ ok: false, code: 'FIRST' });
    expect(second).not.toHaveBeenCalled();
    const ok1 = jest.fn(async () => ({ ok: true }));
    const bad2 = jest.fn(async () => ({ ok: false, code: 'SECOND', retryable: true }));
    await expect(composeProviderPreSendChecks(ok1, bad2)({ dbi: 'trx' })).resolves.toEqual({ ok: false, code: 'SECOND', retryable: true });
    expect(ok1).toHaveBeenCalledWith({ dbi: 'trx' });
  });

  test('the scheduler composes it AFTER the entry point\'s own predicate, for decision-linked sends only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain('if (claimMeta.agent_decision_id) {\n            const { etaProviderPreSendCheck, composeProviderPreSendChecks }');
    expect(src).toContain('replayInput.providerPreSendCheck,\n              etaProviderPreSendCheck({ decisionId: claimMeta.agent_decision_id, getBody: () => replayInput.body }),');
  });
});

// Codex round-41 P2: the in-memory-snapshot variant (auto-send executor).
describe('etaSnapshotProviderPreSendCheck', () => {
  test('hands the held snapshot + facts time to the shared check, body read lazily', async () => {
    let body = 'Thanks!';
    const snap = { entries: [{ minutes: 9, scheduledServiceIds: ['s1'] }] };
    const check = etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: snap, factsGeneratedAt: '2026-09-29T14:00:00.000Z', getBody: () => body });
    body = 'The tech is 9 minutes away.';
    await expect(check()).resolves.toEqual({ ok: true });
    expect(etaClaimBlockReason).toHaveBeenCalledWith({ liveEtaSnapshot: snap, factsGeneratedAt: '2026-09-29T14:00:00.000Z', techNames: [], promptVersion: null, outgoingBody: 'The tech is 9 minutes away.' });
  });
  test('stale -> terminal refusal; a throwing recheck -> retryable', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_stale_facts');
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
    etaClaimBlockReason.mockRejectedValue(new Error('db down'));
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });
});

// Codex round-42 P2 (PR #5334): ONE shared set of infrastructure-failure reasons.
describe('infrastructure failures are retryable at every wrapper, never permanently stale', () => {
  const { ETA_INFRASTRUCTURE_FAILURE_REASONS, isEtaInfrastructureFailure } = jest.requireActual('../services/sms-eta-freshness');
  const { blockReasonIsEtaInfrastructure } = require('../services/agent-decision-send-checks');

  test('the exported set names both codes; verdicts about the message are not in it', () => {
    expect([...ETA_INFRASTRUCTURE_FAILURE_REASONS].sort()).toEqual(['eta_claim_recheck_failed', 'eta_claim_recompute_unavailable', 'eta_recheck_failed']);
    for (const verdict of ['eta_claim_stale_facts', 'eta_claim_no_longer_en_route', 'eta_claim_no_snapshot', 'eta_claim_superseded_fix', 'eta_claim_visit_not_today']) {
      expect(isEtaInfrastructureFailure(verdict)).toBe(false);
    }
    expect(Object.isFrozen(ETA_INFRASTRUCTURE_FAILURE_REASONS)).toBe(true);
  });

  test.each(['eta_claim_recheck_failed', 'eta_recheck_failed'])('the provider-boundary predicate (row-reading variant) treats %p as RETRYABLE', async (reason) => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ input_snapshot: {} }) }) }));
    etaClaimBlockReason.mockResolvedValue(reason);
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test.each(['eta_claim_recheck_failed', 'eta_recheck_failed'])('the provider-boundary predicate (in-memory snapshot variant) treats %p as RETRYABLE', async (reason) => {
    etaClaimBlockReason.mockResolvedValue(reason);
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_CHECK_FAILED_AT_BOUNDARY', retryable: true });
  });

  test('a real verdict stays terminal in both variants', async () => {
    db.mockImplementation(() => ({ where: () => ({ first: async () => ({ input_snapshot: {} }) }) }));
    etaClaimBlockReason.mockResolvedValue('eta_claim_no_longer_en_route');
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
    await expect(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })()).resolves.toMatchObject({ ok: false, code: 'LIVE_ETA_STALE_AT_BOUNDARY' });
  });

  test('the immediate Agent Review seam can tell an unreadable recheck from a stale verdict', async () => {
    etaClaimBlockReason.mockResolvedValue('eta_claim_recheck_failed');
    const unreadable = await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}) }), outgoingBody: 'The tech is on the way.' });
    expect(unreadable).toBe('live ETA unsendable (eta_claim_recheck_failed)');
    expect(blockReasonIsEtaInfrastructure(unreadable)).toBe(true);
    expect(blockReasonIsEtaInfrastructure('live ETA unsendable (eta_claim_stale_facts)')).toBe(false);
    expect(blockReasonIsEtaInfrastructure('amount no longer authorized (x)')).toBe(false);
    expect(blockReasonIsEtaInfrastructure(null)).toBe(false);
  });

  test('the persisted tech_names ride into the shared check; older decisions send an empty list', async () => {
    etaClaimBlockReason.mockResolvedValue(null);
    await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({ tech_names: ['Sam'] }) }), outgoingBody: 'x' });
    expect(etaClaimBlockReason).toHaveBeenLastCalledWith(expect.objectContaining({ techNames: ['Sam'] }));
    await agentDecisionSendBlockReason({ decision: decision({ input_snapshot: JSON.stringify({}) }), outgoingBody: 'x' });
    expect(etaClaimBlockReason).toHaveBeenLastCalledWith(expect.objectContaining({ techNames: [] }));
  });

  test('the scheduler defers an unreadable early recheck to the provider-boundary check (source pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain("isEtaInfrastructureFailure(rawEtaReason) ? null : rawEtaReason");
  });
  test('the Agent Review route does not retire a card over an unreadable recheck (source pin)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-communications.js'), 'utf8');
    expect(src).toContain('blockReasonIsEtaInfrastructure(blockReason)');
  });
});

// Codex #5334 P1 (round after b8809beece): the boundary ETA predicates read through the HANDOFF's own connection (`dbi`).
describe('provider-boundary ETA predicates use the handoff connection (dbi)', () => {
  const trxFor = (row) => {
    const trx = jest.fn(() => ({ where: () => ({ first: async () => row }) }));
    return trx;
  };
  test('etaProviderPreSendCheck reads the decision row AND the freshness recheck through dbi, never the root pool', async () => {
    db.mockReset().mockImplementation(() => { throw new Error('root pool must not be touched'); });
    const trx = trxFor({ input_snapshot: { facts_generated_at: '2026-09-29T14:00:00.000Z' } });
    await expect(etaProviderPreSendCheck({ decisionId: 'd1', getBody: () => 'x' })({ channel: 'sms', dbi: trx })).resolves.toEqual({ ok: true });
    expect(trx).toHaveBeenCalledWith('agent_decisions');
    expect(db).not.toHaveBeenCalled();
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('etaSnapshotProviderPreSendCheck hands dbi to the shared freshness check as dbh', async () => {
    const trx = jest.fn();
    await etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' })({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('the repeatable afterMarker re-run also gets the connection', async () => {
    const trx = jest.fn();
    const check = etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' });
    await check.afterMarker({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
  });
  test('composed: the context reaches every component', async () => {
    const trx = jest.fn();
    const lane = jest.fn(async () => ({ ok: true }));
    const composed = composeProviderPreSendChecks(etaSnapshotProviderPreSendCheck({ liveEtaSnapshot: null, factsGeneratedAt: null, getBody: () => 'x' }), lane);
    await composed({ dbi: trx });
    expect(etaClaimBlockReason).toHaveBeenCalledWith(expect.objectContaining({ dbh: trx }));
    expect(lane).toHaveBeenCalledWith({ dbi: trx });
  });
});


// Owner ruling 2026-10-01: STAFF EDITS. A body that differs from the AI draft stored on the decision is the staff member's own wording; the
// payment-status contract does not judge it. Unedited AI bodies keep the full contract; Zelle and amount rules apply to both.
describe('staff-edited bodies (owner ruling 2026-10-01)', () => {
  const { bodyIsStaffEdited } = require('../services/agent-decision-send-checks');
  const AI = 'Your account has no balance due.';
  const v12 = (over = {}) => decision({ prompt_version: 'house_voice_v12_real_answers5_cf_pf', suggested_message: AI, input_snapshot: JSON.stringify({ payment_status_snapshot: { customer_id: 'c1', sentences: [AI] } }), ...over });

  test('bodyIsStaffEdited: whitespace-normalized compare; a missing stored draft is NOT an edit (strict)', () => {
    expect(bodyIsStaffEdited(AI, `  ${AI.replace(' ', '   ')}\n`)).toBe(false);
    expect(bodyIsStaffEdited(AI, 'We got your payment, thanks!')).toBe(true);
    expect(bodyIsStaffEdited(null, 'We got your payment, thanks!')).toBe(false);
    expect(bodyIsStaffEdited('', 'We got your payment, thanks!')).toBe(false);
    expect(bodyIsStaffEdited(undefined, AI)).toBe(false);
  });
  test('an edited v12 body tells the recheck it is a staff edit; an unedited one does not', async () => {
    await agentDecisionSendBlockReason({ decision: v12(), outgoingBody: 'Yes - we got your payment, thanks Dana!' });
    expect(outgoingAmountsStale).toHaveBeenLastCalledWith(expect.objectContaining({ humanEditedBody: true }));
    await agentDecisionSendBlockReason({ decision: v12(), outgoingBody: `  ${AI} ` });
    expect(outgoingAmountsStale).toHaveBeenLastCalledWith(expect.objectContaining({ humanEditedBody: false }));
    await agentDecisionSendBlockReason({ decision: v12({ suggested_message: null }), outgoingBody: 'Yes - we got your payment, thanks Dana!' });
    expect(outgoingAmountsStale).toHaveBeenLastCalledWith(expect.objectContaining({ humanEditedBody: false })); // no stored draft => strict
  });
  test('a customerless v12 decision: an edited status body is not blocked for lack of billing; the unedited one still is', async () => {
    const noCust = (over = {}) => v12({ customer_id: null, input_snapshot: JSON.stringify({}), ...over });
    await expect(agentDecisionSendBlockReason({ decision: noCust(), outgoingBody: 'Yes - we got your payment, thanks Dana!' })).resolves.toBeNull();
    await expect(agentDecisionSendBlockReason({ decision: noCust(), outgoingBody: AI })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
    // ...but an edited body with a Zelle claim or a figure still needs the customer (main's rules are not loosened)
    await expect(agentDecisionSendBlockReason({ decision: noCust(), outgoingBody: 'You can use Zelle.' })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
    await expect(agentDecisionSendBlockReason({ decision: noCust(), outgoingBody: 'You owe $95.' })).resolves.toBe('amount no longer authorized (amount_recheck_no_customer)');
  });
});

// Codex round-48 P1: the billing recheck repeats at the TRUE provider boundary of the immediate Agent Review send
describe('amountsProviderPreSendCheck - billing facts at the provider boundary', () => {
  const { amountsProviderPreSendCheck } = require('../services/agent-decision-send-checks');
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const decision = { id: 'd1', customer_id: 'c1', prompt_version: 'house_voice_v12_real_answers5_cf_pf', suggested_message: 'Your account balance is $100.00.', input_snapshot: null, inbound_message: 'what do I owe?' };
  afterEach(() => { outgoingAmountsStale.mockReset(); outgoingAmountsStale.mockResolvedValue({ stale: false }); });
  test('a body the recheck cannot judge registers nothing (no extra billing read on ordinary sends)', () => {
    expect(amountsProviderPreSendCheck({ decision, getBody: () => 'See you Tuesday!' })).toBeUndefined();
    expect(amountsProviderPreSendCheck({ decision: null, getBody: () => 'Your account balance is $100.00.' })).toBeUndefined();
  });
  test('a payment that lands before the provider call refuses the now-false balance (final, not retryable), and repeats after the marker', async () => {
    const check = amountsProviderPreSendCheck({ decision, getBody: () => decision.suggested_message });
    expect(typeof check.afterMarker).toBe('function');
    await expect(check({ dbi: 'trx' })).resolves.toEqual({ ok: true });
    expect(outgoingAmountsStale).toHaveBeenLastCalledWith(expect.objectContaining({ customerId: 'c1', body: decision.suggested_message, dbh: 'trx' }));
    outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'payment_status_changed' });
    const verdict = await check.afterMarker({ dbi: 'trx' });
    expect(verdict).toMatchObject({ ok: false, code: 'BILLING_FACTS_STALE_AT_BOUNDARY' });
    expect(verdict.retryable).toBeUndefined();
  });
  test('a read failure (or a throw) at the boundary is retryable, never sent', async () => {
    const check = amountsProviderPreSendCheck({ decision, getBody: () => decision.suggested_message });
    outgoingAmountsStale.mockResolvedValueOnce({ stale: true, reason: 'payment_status_recheck_failed' });
    await expect(check()).resolves.toMatchObject({ ok: false, code: 'BILLING_FACTS_CHECK_FAILED_AT_BOUNDARY', retryable: true });
    outgoingAmountsStale.mockRejectedValueOnce(new Error('db down'));
    await expect(check()).resolves.toMatchObject({ ok: false, retryable: true });
  });
  test('a Zelle offer on a pre-v12 decision is rechecked at the boundary too', async () => {
    const check = amountsProviderPreSendCheck({ decision: { ...decision, prompt_version: 'house_voice_v11' }, getBody: () => 'You can Zelle us at pay@example.com.' });
    expect(typeof check).toBe('function');
    outgoingAmountsStale.mockResolvedValueOnce({ stale: true, reason: 'zelle_invoice_ineligible' });
    await expect(check()).resolves.toMatchObject({ ok: false, code: 'BILLING_FACTS_STALE_AT_BOUNDARY' });
  });
  test('the Agent Review route composes it with the ETA check on the decision-linked send', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-communications'), 'utf8');
    expect(src).toContain('checks.amountsProviderPreSendCheck({ decision: verifiedAgentDecision, getBody: () => cleanBody })');
  });
});
