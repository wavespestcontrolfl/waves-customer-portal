/**
 * IB send_sms: unknown provider outcomes and refusals at the proposal.
 *
 * Two defects from the ten-workflow baseline (W7-dev-05, W7-dev-06, W6-dev-09):
 *  - A send whose provider outcome is unknown (the call timed out) was reported as
 *    a blocked send and a repeat was allowed before the row was reconciled. Now the
 *    result is outcome_unknown, the unknown outcome is held on a reservation row,
 *    and a repeat of the same text to the same number is refused.
 *  - A card was offered for a text to an opted-out number; the block came only
 *    after Confirm. Now the proposal path asks the same consent and suppression
 *    validators and refuses with the send's own wording (no card). The
 *    execution-time block stays: a customer can opt out between card and confirm.
 *
 * No text is ever sent here: the SMS layer is mocked.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({
  sendManualCustomerSms: jest.fn(),
  manualSmsDeliveryState: (value) => value?.manualSmsInterlock?.deliveryState || null,
}));
jest.mock('../services/intelligence-bar/sms-outcome-guard', () => {
  const actual = jest.requireActual('../services/intelligence-bar/sms-outcome-guard');
  const mocked = {
    findUnreconciledSend: jest.fn(async () => null),
    acquireSendReservation: jest.fn(async () => ({ id: 'reservation-1' })),
    settleSendReservation: jest.fn(async () => undefined),
    unreconciledRefusal: actual.unreconciledRefusal,
    reservationState: actual.reservationState,
    INTERLOCK_REFUSAL_CODE: actual.INTERLOCK_REFUSAL_CODE,
  };
  // The real lifecycle over the mocked acquire and settle, so the tests observe both.
  mocked.withSendReservation = async ({ phone, customerId = null, body }, send) => {
    const reservation = await mocked.acquireSendReservation({ phone, customerId, body });
    if (reservation.refused) return { refused: true };
    const settle = (state) => mocked.settleSendReservation(reservation.id, state, { phone, body });
    let result;
    try { result = await send(); } catch (err) { await settle(actual.reservationState(err, { thrown: true })); throw err; }
    await settle(actual.reservationState(result));
    return { result };
  };
  return mocked;
});
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({ prefs: null, customer: null })),
  checkConsentForPurpose: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (input, state) => state),
  checkSuppression: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');
const guard = require('../services/intelligence-bar/sms-outcome-guard');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');
const { checkSuppression } = require('../services/messaging/validators/suppression');
const { executeCommsTool, sendSmsProposalRefusal } = require('../services/intelligence-bar/comms-tools');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');

const CUSTOMER = { id: 'cust-1', first_name: 'Testa', last_name: 'Alpha', phone: '+19415550101' };
const SEND = { customer_id: CUSTOMER.id, phone: CUSTOMER.phone, message: 'We will be there Tuesday at 9.', message_type: 'manual' };
const OPTED_OUT = { ok: false, code: 'SMS_OPTED_OUT', reason: 'Recipient has opted out of SMS (sms_enabled=false on notification_prefs)' };

function customerLookup() {
  const c = {};
  for (const m of ['where', 'whereNull', 'whereRaw']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => CUSTOMER);
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => customerLookup());
  guard.findUnreconciledSend.mockResolvedValue(null);
  guard.acquireSendReservation.mockResolvedValue({ id: 'reservation-1' });
  checkSuppression.mockResolvedValue({ ok: true });
  checkConsentForPurpose.mockResolvedValue({ ok: true });
});

describe('a send whose provider outcome is unknown', () => {
  test('is recorded as unknown, not blocked, and its reservation is left held', async () => {
    sendManualCustomerSms.mockResolvedValueOnce({
      sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', reason: 'timeout',
      manualSmsInterlock: { deliveryState: 'uncertain' },
    });

    const result = await executeCommsTool('send_sms', SEND);

    expect(result).toMatchObject({ success: false, outcome_unknown: true, mayHaveSent: true, retry: false, retryable: false });
    expect(result.blocked).toBeUndefined();
    // The outcome class the confirm route and the receipt read.
    expect(executionOutcome(result)).toBe('outcome_unknown');
    expect(guard.acquireSendReservation).toHaveBeenCalledWith({ phone: CUSTOMER.phone, customerId: CUSTOMER.id, body: SEND.message });
    expect(guard.settleSendReservation).toHaveBeenCalledWith('reservation-1', 'uncertain', { phone: CUSTOMER.phone, body: SEND.message });
  });

  test('a thrown unknown outcome leaves the reservation held and is reported as unknown too', async () => {
    sendManualCustomerSms.mockRejectedValueOnce(Object.assign(new Error('receipt unavailable'), {
      code: 'SMS_DELIVERY_UNCERTAIN',
      providerOutcome: { sent: false, deliveryOutcome: 'uncertain' },
    }));

    const result = await executeCommsTool('send_sms', SEND);

    expect(executionOutcome(result)).toBe('outcome_unknown');
    expect(guard.settleSendReservation).toHaveBeenCalledWith('reservation-1', 'uncertain', expect.anything());
  });

  test('an accepted send releases the reservation', async () => {
    sendManualCustomerSms.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-test' });
    const result = await executeCommsTool('send_sms', SEND);
    expect(result).toMatchObject({ success: true, state: 'provider_accepted' });
    expect(guard.settleSendReservation).toHaveBeenCalledWith('reservation-1', 'accepted', expect.anything());
  });

  test('a definite failure or block releases the reservation so a later send works', async () => {
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', reason: 'rejected' });
    await executeCommsTool('send_sms', SEND);
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: OPTED_OUT.code, reason: OPTED_OUT.reason });
    await executeCommsTool('send_sms', SEND);
    expect(guard.settleSendReservation.mock.calls.map((c) => c[1])).toEqual(['not_sent', 'not_sent']);
  });

  test('a thrown definite failure releases the reservation; a thrown error naming no outcome holds it', async () => {
    sendManualCustomerSms.mockRejectedValueOnce(Object.assign(new Error('rejected'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } }));
    await executeCommsTool('send_sms', SEND);
    sendManualCustomerSms.mockRejectedValueOnce(new Error('something broke'));
    await executeCommsTool('send_sms', SEND);
    expect(guard.settleSendReservation.mock.calls.map((c) => c[1])).toEqual(['not_sent', 'uncertain']);
  });

  test('the wrapper interlock refusing THIS attempt is a refusal, and its reservation is released', async () => {
    sendManualCustomerSms.mockResolvedValueOnce({
      sent: false, blocked: true, code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED', manualSmsInterlock: { deliveryState: 'uncertain' },
    });

    const result = await executeCommsTool('send_sms', SEND);

    expect(executionOutcome(result)).toBe('blocked');
    expect(guard.settleSendReservation).toHaveBeenCalledWith('reservation-1', 'not_sent', expect.anything());
  });

  test('a repeat of the same text while the first is in flight or unreconciled is refused at execution, and sends nothing', async () => {
    guard.acquireSendReservation.mockResolvedValueOnce({ refused: true });

    const result = await executeCommsTool('send_sms', SEND);

    expect(result).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED', mayHaveSent: true, retry: false });
    expect(result.error).toBe('An earlier text to this customer with the same message may already have gone out: its delivery was never confirmed and is still being reconciled. Nothing was sent. Check the conversation thread before sending anything similar.');
    expect(guard.acquireSendReservation).toHaveBeenCalledWith({ phone: CUSTOMER.phone, customerId: CUSTOMER.id, body: SEND.message });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    expect(guard.settleSendReservation).not.toHaveBeenCalled();
  });
});

describe('send_sms at the proposal', () => {
  test('an unreconciled earlier text of the same words is refused with no card', async () => {
    guard.findUnreconciledSend.mockResolvedValueOnce({ id: 'held-row' });

    const refusal = await sendSmsProposalRefusal(SEND);

    expect(refusal).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED', sent_to: CUSTOMER.phone });
    expect(refusal.error).toMatch(/may already have gone out.*reconcil/i);
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('an opted-out number is refused with the same wording the execution-time block uses', async () => {
    checkConsentForPurpose.mockResolvedValue(OPTED_OUT);
    const refusal = await sendSmsProposalRefusal({ ...SEND, customer_name: 'Testa Alpha' });

    // The same send blocked at execution (the customer opted out after the card).
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: true, code: OPTED_OUT.code, reason: OPTED_OUT.reason });
    const atConfirm = await executeCommsTool('send_sms', SEND);

    expect(refusal).toMatchObject({ success: false, blocked: true, code: 'SMS_OPTED_OUT', customer: 'Testa Alpha' });
    expect(refusal.error).toBe('Recipient has opted out of SMS (sms_enabled=false on notification_prefs)');
    expect(refusal.error).toBe(atConfirm.error);
    expect(refusal.code).toBe(atConfirm.code);
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1); // only the confirm-time call; the proposal sends nothing
  });

  test('a suppressed number (STOP on file) is refused with the suppression reason', async () => {
    checkSuppression.mockResolvedValue({ ok: false, code: 'SUPPRESSED_OPT_OUT', reason: 'Recipient is suppressed (reason: opt_out_keyword, since 2026-10-01)' });

    const refusal = await sendSmsProposalRefusal(SEND);

    expect(refusal).toMatchObject({ blocked: true, code: 'SUPPRESSED_OPT_OUT' });
    expect(refusal.error).toMatch(/suppressed/);
    expect(checkConsentForPurpose).not.toHaveBeenCalled();
  });

  test('the validators see the same input the send builds (customer, number, purpose, channel)', async () => {
    await sendSmsProposalRefusal({ ...SEND, message_type: 'billing_reminder' });

    expect(checkSuppression).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'customer', channel: 'sms', purpose: 'billing', customerId: CUSTOMER.id, to: CUSTOMER.phone, hasEmailLeg: true }),
      expect.anything(), expect.anything(),
    );
  });

  test('an eligible number gets a card (no refusal)', async () => {
    expect(await sendSmsProposalRefusal(SEND)).toBeNull();
  });

  test('a transient lookup failure leaves the decision to the execution-time check', async () => {
    checkConsentForPurpose.mockResolvedValue({ ok: false, code: 'CONSENT_LOOKUP_FAILED', reason: 'retry advised' });
    expect(await sendSmsProposalRefusal(SEND)).toBeNull();
  });

  test('a validator that throws never blocks the card', async () => {
    checkSuppression.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await sendSmsProposalRefusal(SEND)).toBeNull();
  });

  test('a phone-only send (no customer) is left to the execution-time block', async () => {
    expect(await sendSmsProposalRefusal({ phone: CUSTOMER.phone, message: SEND.message })).toBeNull();
    expect(checkSuppression).not.toHaveBeenCalled();
  });
});

describe('a customer who opts out between the card and the confirm', () => {
  test('is still blocked at execution: nothing is sent and the block is reported', async () => {
    // The proposal passed (eligible then).
    expect(await sendSmsProposalRefusal(SEND)).toBeNull();
    // At confirm the send path refuses.
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: OPTED_OUT.code, reason: OPTED_OUT.reason });

    const result = await executeCommsTool('send_sms', SEND);

    expect(result).toMatchObject({ success: false, blocked: true, code: 'SMS_OPTED_OUT', error: OPTED_OUT.reason });
    expect(executionOutcome(result)).toBe('blocked');
    expect(guard.settleSendReservation).toHaveBeenCalledWith('reservation-1', 'not_sent', expect.anything());
  });
});

describe('the reservation row for an unknown outcome', () => {
  const real = jest.requireActual('../services/intelligence-bar/sms-outcome-guard');
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
  const row = (status, metadata, ageHours = 1, body = SEND.message) => ({ id: `${status}-${ageHours}`, status, metadata, message_body: body, created_at: hoursAgo(ageHours), updated_at: hoursAgo(ageHours) });

  test('carriesUnknownOutcome is the repo\'s unresolved-reservation predicate plus the prior-attempt marker family', () => {
    // isUnresolvedSendReservation: a reply reservation still sending inside its 24-hour hold.
    expect(real.carriesUnknownOutcome(row('sending', { manual_send_reservation: true, provider_outcome_uncertain: true }))).toBe(true);
    expect(real.carriesUnknownOutcome(row('sending', '{"manual_send_reservation":true,"provider_outcome_uncertain":true}'))).toBe(true);
    expect(real.carriesUnknownOutcome(row('sending', { manual_send_reservation: true, provider_outcome_uncertain: true }, 25))).toBe(false);
    expect(real.carriesUnknownOutcome(row('sent', { manual_send_reservation: true, provider_outcome: 'accepted' }))).toBe(false);
    // A review-ask reservation in any non-delivered status, bounded to the 72-hour spacing window.
    expect(real.carriesUnknownOutcome(row('failed', { review_ask_reservation: true }, 10))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { review_ask_reservation: true }, 48))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { review_ask_reservation: true, review_delivery_uncertain_exhausted: true }, 71))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { review_ask_reservation: true }, 73))).toBe(false);
    expect(real.carriesUnknownOutcome(row('sent', { review_ask_reservation: true }, 1))).toBe(false);
    expect(real.carriesUnknownOutcome(row('failed', { review_ask_reservation: true, finalize_only: true }, 1))).toBe(false);
    // A queued row a worker picked up or requeued after an attempt (PRIOR_ATTEMPT_KEY_RE), while still queued,
    // aged from the ATTEMPT (the marker time), not from the queue row's creation.
    expect(real.carriesUnknownOutcome(row('scheduled', { scheduled_sms_claimed_at: hoursAgo(10).toISOString() }, 5 * 24))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { provider_retry_at: hoursAgo(1).toISOString(), provider_retry_code: 'PROVIDER_FAILURE' }, 5 * 24))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { scheduled_sms_claimed_at: hoursAgo(30).toISOString() }, 5 * 24))).toBe(false);
    // A boolean marker (twilio-webhook's provider_retry: true) carries no time: the row's own timestamps age it.
    expect(real.carriesUnknownOutcome(row('scheduled', { provider_retry: true }, 2))).toBe(true);
    expect(real.carriesUnknownOutcome(row('scheduled', { provider_retry: true }, 30))).toBe(false);
    expect(real.carriesUnknownOutcome(row('failed', { provider_retry_at: hoursAgo(1).toISOString() }))).toBe(false);
    // A queued text no worker has picked up, and a plain sent text, are not unknown.
    expect(real.carriesUnknownOutcome(row('scheduled', {}))).toBe(false);
    expect(real.carriesUnknownOutcome(row('sent', null))).toBe(false);
  });

  test('findUnreconciledSend narrows the SQL to the number and a coarse window, then compares canonical bodies and classifies each row in JS', async () => {
    const rows = [
      row('sent', { manual_send_reservation: true, provider_outcome: 'accepted' }),
      // A queued row stores the TYPED body (curly apostrophe); the retry is typed straight. Same text to the provider.
      row('scheduled', { provider_retry_at: hoursAgo(1).toISOString() }, 1, 'We’ll be there Tuesday — see https://waves.example/portal'),
      row('sending', { manual_send_reservation: true, provider_outcome_uncertain: true }, 1, 'A different text entirely.'),
    ];
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'whereNot']) q[m] = jest.fn(() => q);
    q.select = jest.fn(async () => rows);
    db.mockImplementation(() => q);

    const found = await real.findUnreconciledSend({ phone: CUSTOMER.phone, body: "We'll be there Tuesday - see waves.example/portal" });

    expect(found).toEqual(rows[1]);
    expect(db).toHaveBeenCalledWith('sms_log');
    // No body equality and no status whitelist in SQL.
    expect(q.where).toHaveBeenCalledWith({ direction: 'outbound' });
    expect(q.where.mock.calls.some((c) => c[0] && c[0].message_body)).toBe(false);
    expect(q.whereIn).not.toHaveBeenCalled();
    const windowCall = q.whereRaw.mock.calls.find((c) => /GREATEST\(updated_at, created_at\) >= \?/.test(c[0]));
    expect(Math.abs(windowCall[1][0].getTime() - hoursAgo(72).getTime())).toBeLessThan(5000);
    expect(await real.findUnreconciledSend({ phone: CUSTOMER.phone, body: '' })).toBeNull();
    expect(await real.findUnreconciledSend({ phone: '', body: SEND.message })).toBeNull();
  });

  test('the hold horizon: a manual row 25 hours old no longer blocks; a failed or scheduled review-ask reservation inside 72 hours still does', async () => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'whereNot']) q[m] = jest.fn(() => q);
    db.mockImplementation(() => q);
    const only = async (r) => { q.select = jest.fn(async () => [r]); return real.findUnreconciledSend({ phone: CUSTOMER.phone, body: SEND.message }); };

    expect(await only(row('sending', { manual_send_reservation: true, provider_outcome_uncertain: true }, 25))).toBeNull();
    expect((await only(row('sending', { manual_send_reservation: true, provider_outcome_uncertain: true }, 23)))).toBeTruthy();
    expect((await only(row('failed', { review_ask_reservation: true }, 10)))).toBeTruthy();
    expect((await only(row('scheduled', { review_ask_reservation: true }, 48)))).toBeTruthy();
    expect(await only(row('scheduled', { review_ask_reservation: true }, 73))).toBeNull();
  });

  test('reservationState reads classifyDeliveryCertainty: the explicit deliveryOutcome wins over sent/blocked flags', () => {
    expect(real.reservationState({ sent: true, deliveryOutcome: 'accepted' })).toBe('accepted');
    // Ambiguous even though sent is true: held.
    expect(real.reservationState({ sent: true, deliveryOutcome: 'uncertain' })).toBe('uncertain');
    expect(real.reservationState({ sent: false, deliveryOutcome: 'not_sent', blocked: true })).toBe('not_sent');
    expect(real.reservationState({ sent: false, blocked: true, code: 'SMS_OPTED_OUT' })).toBe('not_sent');
    expect(real.reservationState({ sent: false, blocked: true, deliveryOutcome: 'uncertain', code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED' })).toBe('not_sent');
    expect(real.reservationState({ providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } }, { thrown: true })).toBe('not_sent');
    expect(real.reservationState({ providerOutcome: { sent: true, deliveryOutcome: 'uncertain' } }, { thrown: true })).toBe('uncertain');
    expect(real.reservationState(new Error('no outcome'), { thrown: true })).toBe('uncertain');
  });
});
