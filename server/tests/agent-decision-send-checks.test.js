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
const drafter = require('../services/sms-shadow-drafter');
const { followupPromiseBlockReason } = require('../services/sms-followup-sla');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
const { agentDecisionSendBlockReason, parseInputSnapshot } = require('../services/agent-decision-send-checks');

const SNAP = { open_times_snapshot: { lookup: { city: 'Venice', customerId: 'c1', estimateId: null, serviceType: 'Lawn Care' }, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] } };
const decision = (over = {}) => ({ id: 'd1', customer_id: 'c1', suggested_message: 'How about Tuesday 9:00 AM - 11:00 AM?', input_snapshot: JSON.stringify(SNAP), prompt_version: 'house_voice_v12_real_answers', ...over });

beforeEach(() => {
  drafter.planOpenTimesRecheck.mockReset().mockReturnValue({ action: 'recheck', quotedWindows: SNAP.open_times_snapshot.quotedWindows });
  drafter.openTimesStillOffered.mockReset().mockResolvedValue({ ok: true });
  followupPromiseBlockReason.mockReset().mockReturnValue(null);
  outgoingAmountsStale.mockReset().mockResolvedValue({ stale: false });
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
  expect(outgoingAmountsStale).toHaveBeenCalledWith({ customerId: 'c1', body: 'How about Tuesday 9:00 AM - 11:00 AM?', promptVersion: 'house_voice_v12_real_answers', zelleInvoiceId: null, inboundMessage: null, trustOwedAmounts: false });
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

// Codex round-23 P2: the immediate Agent Review seam gates the recheck EXACTLY like the scheduler's fire-time seam
// (bodyNeedsPaymentRecheck: an amount, an affirmative Zelle offer, a payment-status claim, price grammar, or a
// NEGATIVE Zelle availability claim) — so an edited pre-v12 body carrying a Zelle DENIAL is rechecked too.
describe('the recheck gate matches the scheduler (round 23)', () => {
  const v11 = (over = {}) => decision({ input_snapshot: JSON.stringify({}), prompt_version: 'house_voice_v11', ...over });
  test.each(["Zelle isn't available right now.", "We don't take Zelle.", 'Zelle is not available for this account right now, so use your pay link.'])(
    'a pre-v12 edited Zelle DENIAL runs the recheck: %s', async (body) => {
      outgoingAmountsStale.mockResolvedValue({ stale: true, reason: 'zelle_now_available' });
      await expect(agentDecisionSendBlockReason({ decision: v11(), outgoingBody: body })).resolves.toBe('amount no longer authorized (zelle_now_available)');
      expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1', body, promptVersion: 'house_voice_v11', trustOwedAmounts: true }));
    },
  );
  test('a still-true denial goes out; a denial on a decision with no customer cannot be verified and is not silently blocked as an offer', async () => {
    await expect(agentDecisionSendBlockReason({ decision: v11(), outgoingBody: "Zelle isn't available right now." })).resolves.toBeNull();
    await expect(agentDecisionSendBlockReason({ decision: v11({ customer_id: null }), outgoingBody: "Zelle isn't available right now." })).resolves.toBeNull();
  });
  test.each(['You owe $5.', 'Your payment was received.', 'You can Zelle us.'])('a pre-v12 body that names a figure / payment status / Zelle offer is rechecked like the scheduler does: %s', async (body) => {
    await agentDecisionSendBlockReason({ decision: v11(), outgoingBody: body });
    expect(outgoingAmountsStale).toHaveBeenCalledWith(expect.objectContaining({ body, trustOwedAmounts: true }));
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
