jest.mock('../models/db', () => jest.fn());
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: jest.fn(() => 222), clearBlockedAddress: jest.fn(), sendOne: jest.fn(),
  isDefiniteRejection: jest.fn(() => false),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  loadTemplateByKey: jest.fn(), activeSuppressionFor: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/billing-channel-email-authority', () => ({ dispatchUnderBillingEmailAuthority: jest.fn() }));
jest.mock('../services/messaging/billing-email-replay-eligibility', () => ({ billingEmailReplayEligible: jest.fn(), replayHoldRefusal: jest.fn(async () => null) }));
jest.mock('../services/billing-email-reservation', () => ({
  BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX: 'Billing email terminal refusal: ',
  BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX: 'Billing email re-quote required: ',
  markBillingEmailReservationDelivered: jest.fn(async () => true),
  resolveBillingEmailReservationRefusal: jest.fn(async () => true),
  releaseBillingEmailReservationForRequote: jest.fn(async () => true),
  isPrevisitReissue: jest.fn(() => false),
  reopenBillingEmailReservationForReissue: jest.fn(async () => true),
}));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const templates = require('../services/email-template-library');
const authority = require('../services/billing-channel-email-authority');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
const { retryOne } = require('../services/transactional-email-provider-retry');
const reservation = require('../services/billing-email-reservation');

const event = 'precharge:customer-1:2030-06-10';
function storedMessage(overrides = {}) {
  return {
    id: 'message-1', template_key: 'billing.notice', recipient_type: 'customer', recipient_id: 'customer-1',
    recipient_email_snapshot: 'customer@example.com', subject_snapshot: 'Upcoming payment',
    trigger_event_id: event, idempotency_key: `billing_channel_email:${event}:email`,
    categories: JSON.stringify(['email_template', 'billing']),
    payload_snapshot: JSON.stringify({ __billing_replay_context: {
      schema_version: 1, customer_id: 'customer-1', category: 'billing',
      source_entry_point: 'autopay_pre_charge_reminder', notificationEventKey: event, charge_date: '2030-06-10',
    } }),
    suppression_group_key_snapshot: 'transactional_required',
    html_snapshot: '<p>Your upcoming payment</p>', text_snapshot: 'Your upcoming payment',
    send_attempt_token: 'attempt-2', provider_handoff_attempt_token: 'attempt-2',
    status: 'queued', provider_retry_count: 1, provider_handoff_phase: 'pending',
    ...overrides,
  };
}

let query;
let heldDatabase;
beforeEach(() => {
  jest.clearAllMocks();
  query = {};
  query.where = jest.fn(() => query);
  query.update = jest.fn(() => query);
  query.first = jest.fn(async () => storedMessage({ status: 'sent', sent_at: new Date() }));
  query.whereNotNull = jest.fn(() => query);
  query.whereRaw = jest.fn(() => query);
  query.whereIn = jest.fn(() => query);
  query.forUpdate = jest.fn(() => query);
  query.returning = jest.fn(async () => [storedMessage({ status: 'sent', sent_at: new Date() })]);
  query.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
  db.mockReturnValue(query);
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (callback) => callback(db));
  heldDatabase = jest.fn();
  // The autopay notice's receipt switch is read on the held transaction
  // (left on); every other read keeps the shared query double.
  heldDatabase.mockImplementation((table) => (table === 'notification_prefs'
    ? { where: () => ({ first: async () => ({ payment_receipt: null }) }) } : query));
  heldDatabase.raw = db.raw;
  templates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'billing.notice' } });
  templates.activeSuppressionFor.mockResolvedValue(null);
  sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
  sendgrid.sendOne.mockImplementation(async (options) => {
    if (typeof options.providerBoundaryCheck === 'function') {
      await options.providerBoundaryCheck({ database: options.database });
    }
    return { messageId: 'provider-2' };
  });
  sendgrid.isDefiniteRejection.mockReturnValue(false);
  billingEmailReplayEligible.mockResolvedValue({ eligible: true });
  authority.dispatchUnderBillingEmailAuthority.mockImplementation(async (options) => {
    const initial = await options.preSendCheck({ database: heldDatabase, providerBoundary: false });
    if (!initial.ok) {
      options.state.boundaryBlock = initial;
      return { ok: false };
    }
    const providerBoundaryCheck = async ({ database }) => {
      let checked;
      try {
        checked = await options.preSendCheck({ database, providerBoundary: true });
      } catch (err) {
        checked = { ok: false, code: err.code, reason: err.message, retryable: err.retryable };
      }
      if (!checked.ok) {
        options.state.boundaryBlock = checked;
        throw Object.assign(new Error(checked.reason), {
          code: checked.code, retryable: checked.retryable, providerBoundaryBlocked: true,
        });
      }
      options.state.handoffStarted = true;
      return { ok: true };
    };
    await options.dispatch(heldDatabase, providerBoundaryCheck);
    if (options.state.boundaryBlock) return { ok: false };
    options.state.providerAccepted = true;
    return { ok: true };
  });
});

test('replays a no-phone billing Email only after locked eligibility and reuses that database for provider preparation', async () => {
  const stored = storedMessage();
  const result = await retryOne(stored);
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ sent: true });
  expect(billingEmailReplayEligible).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer-1' }), heldDatabase);
  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
    to: stored.recipient_email_snapshot, html: stored.html_snapshot, text: stored.text_snapshot,
    database: heldDatabase, providerBoundaryCheck: expect.any(Function),
  }));
  expect(billingEmailReplayEligible.mock.invocationCallOrder[0]).toBeLessThan(sendgrid.clearBlockedAddress.mock.invocationCallOrder[0]);
  expect(billingEmailReplayEligible).toHaveBeenCalledTimes(2);
  expect(reservation.markBillingEmailReservationDelivered).toHaveBeenCalledWith(result.message);
});

test.each([
  { payload_snapshot: '{"__billing_replay_context":null}' },
  { recipient_id: 'another-customer' },
  { trigger_event_id: 'another-event' },
  { categories: JSON.stringify(['payment_receipt']) },
])('a present invalid or mismatched replay context stops before authority or provider work: %j', async (override) => {
  await expect(retryOne(storedMessage(override))).resolves.toMatchObject({ sent: false, stopped: true });
  expect(authority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', provider_retry_next_at: null }));
});

// #4843 gate checklist: a billing row whose producer stored no replay
// contract used to retry on the generic path (suppression only). It now
// re-authorizes its own customer notice through the Email authority.
test('a billing row with no stored contract retries only through the Email authority', async () => {
  const unregistered = storedMessage({ payload_snapshot: JSON.stringify({ notification_body: 'Your upcoming payment' }) });
  const accepted = { ...unregistered, status: 'sent', sent_at: new Date() };
  query.first = jest.fn(async () => accepted);
  query.returning = jest.fn(async () => [accepted]);
  const result = await retryOne(unregistered);
  expect(result).toMatchObject({ sent: true });
  expect(authority.dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({ customerId: 'customer-1', invoiceId: null,
      metadata: { billingDeliveryCategory: 'billing', notificationEventKey: event } }),
  }));
  expect(billingEmailReplayEligible).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ database: heldDatabase }));
  // No reservation backs an unregistered notice.
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
});

test('an authority refusal stops an unregistered billing retry before any provider work', async () => {
  authority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    options.state.boundaryBlock = { code: 'BILLING_PREFERENCES_CHANGED', reason: 'Email is not selected for this billing category' };
    return { ok: false };
  });
  const unregistered = storedMessage({ payload_snapshot: JSON.stringify({ notification_body: 'Your upcoming payment' }) });
  await expect(retryOne(unregistered)).resolves.toMatchObject({ sent: false, stopped: true });
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', provider_retry_next_at: null }));
});

test('an unregistered row that does not carry its notice identity is refused, never resent', async () => {
  const unregistered = storedMessage({
    payload_snapshot: JSON.stringify({ notification_body: 'Your upcoming payment' }),
    idempotency_key: 'billing_channel_email:another-event:email',
  });
  await expect(retryOne(unregistered)).resolves.toMatchObject({ sent: false, stopped: true });
  expect(authority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
});

test('a stale producer reason terminates before provider preparation or a provider request', async () => {
  billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason: 'charge-date-passed', retryable: false });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true, reason: 'charge-date-passed' });
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ provider_handoff_phase: 'pending' }));
  expect(reservation.resolveBillingEmailReservationRefusal).toHaveBeenCalledTimes(1);
});

test('a resendable refusal settles as a definitely-unsent failure, never a block, so the next send re-delivers', async () => {
  billingEmailReplayEligible.mockResolvedValue({
    eligible: false, reason: 'invoice-send-not-finalized', retryable: false, resendable: true,
  });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true, reason: 'invoice-send-not-finalized' });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: null, provider_handoff_phase: 'pending',
  }));
  expect(query.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('a final-boundary resendable refusal settles the started attempt as rejected without delivering its reservation', async () => {
  billingEmailReplayEligible.mockResolvedValueOnce({ eligible: true }).mockResolvedValueOnce({
    eligible: false, reason: 'invoice-send-not-finalized', retryable: false, resendable: true,
  });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: null, provider_handoff_phase: 'rejected',
  }));
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('a temporary eligibility failure stays on the bounded retry schedule without a provider request', async () => {
  billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, error: expect.any(Error) });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', provider_retry_next_at: expect.any(Date) }));
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ provider_handoff_phase: 'pending' }));
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('a collections dispute hold waits on the retry rail WITHOUT spending an attempt (refunded), never exhausted or blocked', async () => {
  billingEmailReplayEligible.mockResolvedValue({
    eligible: false, reason: 'collection-hold', retryable: true, holdDefer: true, held: { held: true, reason: 'hold' },
  });
  const before = Date.now();
  await expect(retryOne(storedMessage({ provider_retry_count: 3 }))).resolves.toMatchObject({ sent: false, held: true });
  const patch = query.update.mock.calls.find(([arg]) => arg.provider_retry_next_at)[0];
  expect(patch).toMatchObject({ status: 'failed', provider_retry_exhausted_at: null, provider_handoff_phase: 'pending' });
  expect(patch.provider_retry_count).toBe('GREATEST(provider_retry_count - 1, 0)');
  expect(patch.provider_retry_next_at.getTime()).toBeGreaterThan(before + 3 * 60 * 1000);
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test.each(['previsit-quote-changed', 'balance-reminder-copy-stale', 'balance-reminder-visit-changed']
  .flatMap((reason) => [[reason, false], [reason, true]]))(
  '%s retires the frozen Email for fresh rendering (provider boundary: %s)', async (reason, finalBoundary) => {
    const stored = storedMessage();
    const notificationEventKey = 'previsit-balance:visit-1';
    stored.trigger_event_id = notificationEventKey;
    stored.idempotency_key = `billing_channel_email:${notificationEventKey}:email`;
    stored.payload_snapshot = JSON.stringify({ __billing_replay_context: {
      schema_version: 1, customer_id: 'customer-1', category: 'billing',
      source_entry_point: 'previsit_balance_reminder', notificationEventKey,
      collections_ledger_id: 'ledger-1', appointment_id: 'visit-1', appointment_date: '2030-06-10',
      appointment_rendered_on: '2030-06-09', appointment_service_type: 'Pest Control',
      rendered_amount: '100.00', invoice_ids: ['invoice-1', 'invoice-2'],
      invoice_quotes: [{ id: 'invoice-1', dueCents: 4000 }, { id: 'invoice-2', dueCents: 6000 }],
      dues_cents: 0, selected_channels: ['email'],
    } });
    billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason, retryable: true });
    if (finalBoundary) billingEmailReplayEligible.mockResolvedValueOnce({ eligible: true });
    // The worker reads the row returned by its conditional stop update.
    query.returning.mockResolvedValueOnce([{ ...stored, status: 'failed' }]);
    await expect(retryOne(stored)).resolves.toMatchObject({ sent: false, stopped: true, reason });
    if (finalBoundary) {
      expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ providerBoundaryCheck: expect.any(Function) }));
    } else expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
    expect(reservation.releaseBillingEmailReservationForRequote).toHaveBeenCalledTimes(1);
    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', provider_retry_next_at: null, provider_retry_exhausted_at: expect.any(Date),
      provider_handoff_phase: finalBoundary ? 'rejected' : 'pending',
      error_message: `${reservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}${reason}`,
    }));
  },
);

test('changing the selected billing channel defers the stored Email for retry', async () => {
  authority.dispatchUnderBillingEmailAuthority.mockImplementation(async (options) => {
    options.state.boundaryBlock = {
      code: 'BILLING_PREFERENCES_CHANGED', reason: 'Email is not selected for this billing category',
      deferred: true, retryable: true,
    };
    return { ok: false };
  });
  const outcome = await retryOne(storedMessage());
  expect(outcome).toMatchObject({ sent: false, error: { code: 'BILLING_PREFERENCES_CHANGED' } });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: expect.any(Date), provider_retry_exhausted_at: null,
  }));
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('billing templates lacking a supported receipt source cannot use generic replay', async () => {
  await expect(retryOne(storedMessage({ template_key: 'billing.receipt_notice' })))
    .resolves.toMatchObject({ sent: false, stopped: true });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
});

test('an ambiguous billing provider request is held without scheduling another send', async () => {
  sendgrid.sendOne.mockRejectedValueOnce(new Error('socket disconnected'));
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, uncertain: true });
  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(query.update.mock.calls.some(([patch]) => patch.provider_retry_next_at instanceof Date)).toBe(false);
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ provider_handoff_phase: 'started', provider_retry_next_at: null }));
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
});

test('proven provider rejection stays eligible for the next bounded retry', async () => {
  sendgrid.isDefiniteRejection.mockReturnValueOnce(true);
  sendgrid.sendOne.mockRejectedValueOnce(new Error('provider rejected request'));
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, error: expect.any(Error) });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ provider_handoff_phase: 'rejected', provider_retry_next_at: expect.any(Date) }));
});

test('failure saving accepted billing Email does not schedule a second provider request', async () => {
  query.returning.mockRejectedValueOnce(new Error('acceptance write unavailable'));
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, uncertain: true });
  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(query.update.mock.calls.some(([patch]) => patch.provider_retry_next_at instanceof Date)).toBe(false);
});

test('a rolled-back acceptance stamp cannot report sent or deliver the reservation', async () => {
  query.first.mockResolvedValueOnce({ id: 'message-1' }).mockResolvedValueOnce(null);
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, uncertain: true });
  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
  expect(query.update.mock.calls.some(([patch]) => patch.provider_retry_next_at instanceof Date)).toBe(false);
});

test('a reclaimed billing retry claim stops before its provider request', async () => {
  query.then = (resolve, reject) => Promise.resolve(0).then(resolve, reject);
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true, reason: 'claim_lost' });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
});

test('a claim reclaimed during the final producer check cannot reach the provider', async () => {
  query.first.mockResolvedValueOnce(null);

  await expect(retryOne(storedMessage())).resolves.toEqual({
    sent: false, stopped: true, reason: 'claim_lost',
  });

  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(query.forUpdate).toHaveBeenCalledTimes(1);
  expect(query.where).toHaveBeenCalledWith(expect.objectContaining({
    id: 'message-1', status: 'queued', provider_handoff_phase: 'started',
    send_attempt_token: 'attempt-2', provider_handoff_attempt_token: 'attempt-2',
  }));
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
});

test('an unreadable final claim fence remains a definite retryable pre-provider failure', async () => {
  const databaseError = new Error('claim lookup unavailable');
  query.first.mockRejectedValueOnce(databaseError);

  await expect(retryOne(storedMessage())).resolves.toMatchObject({
    sent: false, error: { message: databaseError.message },
  });

  expect(databaseError).toMatchObject({ retryable: true });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: expect.any(Date), provider_handoff_phase: 'rejected',
  }));
  expect(reservation.markBillingEmailReservationDelivered).not.toHaveBeenCalled();
});

test('a lost marker acknowledgement before the final check restores a known-unsent retry', async () => {
  const markerError = Object.assign(new Error('marker acknowledgement lost'), { code: 'ECONNRESET' });
  query.update.mockRejectedValueOnce(markerError);

  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, error: markerError });

  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(billingEmailReplayEligible).toHaveBeenCalledTimes(1);
  expect(query.whereIn).toHaveBeenCalledWith('provider_handoff_phase', ['pending', 'started']);
  expect(query.update).toHaveBeenLastCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: expect.any(Date), provider_handoff_phase: 'pending',
  }));
});

test('a missed accepted-reservation stamp never requeues the provider send', async () => {
  reservation.markBillingEmailReservationDelivered.mockRejectedValueOnce(new Error('ledger unavailable'));
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: true });
  expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  expect(query.update.mock.calls.some(([patch]) => patch.provider_retry_next_at instanceof Date)).toBe(false);
});

test('a failed terminal-reservation stamp does not put the email back on the schedule', async () => {
  billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason: 'charge-date-passed' });
  reservation.resolveBillingEmailReservationRefusal.mockRejectedValueOnce(new Error('ledger unavailable'));
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ stopped: true });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update.mock.calls.some(([patch]) => patch.provider_retry_next_at instanceof Date)).toBe(false);
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'blocked', provider_retry_exhausted_at: expect.any(Date), provider_handoff_phase: 'pending',
    error_message: `${reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}charge-date-passed`,
  }));
});

test('a billing replay stopped by a corrected customer email reopens its reservation instead of resolving it', async () => {
  const { stopRetriesForReplacedEmail } = require('../services/transactional-email-provider-retry');
  const row = storedMessage({ status: 'failed', provider_retry_next_at: new Date(), provider_handoff_phase: 'rejected' });
  const stopped = storedMessage({ status: 'failed' });
  query.select = jest.fn(async (column) => (column === '*' ? [row] : []));
  query.returning = jest.fn(async () => [stopped]);

  await expect(stopRetriesForReplacedEmail(heldDatabase, { customerId: 'customer-1', oldEmail: 'customer@example.com' }))
    .resolves.toBe(1);

  // `failed` keeps the idempotency key reclaimable; `blocked` would dedupe the owner's re-issue.
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed', provider_retry_next_at: null, provider_retry_exhausted_at: expect.any(Date),
    error_message: 'Customer email was corrected; retry to the replaced address stopped.',
  }));
  // A resolved leg is never claimed again (claimVerdict), so the stop must not resolve it: it
  // reopens the leg on the caller's transaction, where it commits with the correction.
  expect(reservation.reopenBillingEmailReservationForReissue).toHaveBeenCalledWith(stopped, heldDatabase);
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
});

test('a previsit reminder stopped by a corrected customer email goes through the re-quote release', async () => {
  const { stopRetriesForReplacedEmail } = require('../services/transactional-email-provider-retry');
  reservation.isPrevisitReissue.mockReturnValueOnce(true);
  const row = storedMessage({ status: 'failed', provider_retry_next_at: new Date(), provider_handoff_phase: 'rejected' });
  const stopped = storedMessage({ status: 'failed' });
  query.select = jest.fn(async (column) => (column === '*' ? [row] : []));
  query.returning = jest.fn(async () => [stopped]);

  await stopRetriesForReplacedEmail(heldDatabase, { customerId: 'customer-1', oldEmail: 'customer@example.com' });

  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'failed',
    error_message: `${reservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}Customer email was corrected; retry to the replaced address stopped.`,
  }));
  expect(reservation.releaseBillingEmailReservationForRequote).toHaveBeenCalledWith(stopped, heldDatabase, { propagateErrors: true });
  expect(reservation.reopenBillingEmailReservationForReissue).not.toHaveBeenCalled();
});

test('a stamped billing replay that was scheduled anyway is stopped before the provider and reopens its reservation', async () => {
  const stamped = storedMessage({ categories: JSON.stringify(['email_template', 'billing', 'recipient_replaced']) });
  query.returning = jest.fn(async () => [storedMessage({ status: 'failed' })]);

  await expect(retryOne(stamped)).resolves.toMatchObject({ sent: false, stopped: true });

  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(reservation.reopenBillingEmailReservationForReissue).toHaveBeenCalledTimes(1);
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('a billing notice without the replay contract stops without touching a reservation', async () => {
  const { stopRetriesForReplacedEmail } = require('../services/transactional-email-provider-retry');
  const row = storedMessage({ status: 'failed', provider_retry_next_at: new Date(), payload_snapshot: JSON.stringify({}) });
  query.select = jest.fn(async (column) => (column === '*' ? [row] : []));
  query.returning = jest.fn(async () => [storedMessage({ status: 'failed' })]);

  await expect(stopRetriesForReplacedEmail(heldDatabase, { customerId: 'customer-1', oldEmail: 'customer@example.com' }))
    .resolves.toBe(1);

  expect(reservation.reopenBillingEmailReservationForReissue).not.toHaveBeenCalled();
  expect(reservation.releaseBillingEmailReservationForRequote).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

// The row's terminalization and its reservation settle commit or fail together: a failed write must
// reach the enclosing transaction. "Nothing to settle" (false) is a normal outcome.
describe('a replaced-address stop whose reservation settle fails', () => {
  const stopOne = async (prevsit = false) => {
    const { stopRetriesForReplacedEmail } = require('../services/transactional-email-provider-retry');
    reservation.isPrevisitReissue.mockReturnValueOnce(prevsit);
    const row = storedMessage({ status: 'failed', provider_retry_next_at: new Date(), provider_handoff_phase: 'rejected' });
    query.select = jest.fn(async (column) => (column === '*' ? [row] : []));
    query.returning = jest.fn(async () => [storedMessage({ status: 'failed' })]);
    return stopRetriesForReplacedEmail(heldDatabase, { customerId: 'customer-1', oldEmail: 'customer@example.com' });
  };

  test('a failed reopen propagates so the correction rolls back', async () => {
    reservation.reopenBillingEmailReservationForReissue.mockRejectedValueOnce(new Error('ledger write failed'));
    await expect(stopOne()).rejects.toThrow('ledger write failed');
  });

  test('a failed previsit release propagates; a deferred or refused one (false) does not', async () => {
    reservation.releaseBillingEmailReservationForRequote.mockRejectedValueOnce(new Error('claim write failed'));
    await expect(stopOne(true)).rejects.toThrow('claim write failed');
    reservation.releaseBillingEmailReservationForRequote.mockResolvedValueOnce(false);
    await expect(stopOne(true)).resolves.toBe(1);
  });

  test('nothing to reopen is a normal outcome and the stop still commits', async () => {
    reservation.reopenBillingEmailReservationForReissue.mockResolvedValueOnce(false);
    await expect(stopOne()).resolves.toBe(1);
  });

  test('the claim-time stop commits with its reopen and surfaces a failed one so the claimed row is rescheduled', async () => {
    const stamped = storedMessage({ categories: JSON.stringify(['email_template', 'billing', 'recipient_replaced']) });
    query.returning = jest.fn(async () => [storedMessage({ status: 'failed' })]);
    reservation.reopenBillingEmailReservationForReissue.mockRejectedValueOnce(new Error('ledger write failed'));
    await expect(retryOne(stamped)).rejects.toThrow('ledger write failed');
    expect(db.transaction).toHaveBeenCalled();
    expect(reservation.reopenBillingEmailReservationForReissue).toHaveBeenCalledWith(expect.anything(), db);
  });
});
