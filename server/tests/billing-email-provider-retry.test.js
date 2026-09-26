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
jest.mock('../services/messaging/billing-email-replay-eligibility', () => ({ billingEmailReplayEligible: jest.fn() }));
jest.mock('../services/billing-email-reservation', () => ({
  BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX: 'Billing email terminal refusal: ',
  markBillingEmailReservationDelivered: jest.fn(async () => true),
  resolveBillingEmailReservationRefusal: jest.fn(async () => true),
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
  query.first = jest.fn(async () => ({ id: 'existing-alert' }));
  query.whereRaw = jest.fn(() => query);
  query.returning = jest.fn(async () => [storedMessage({ status: 'sent', sent_at: new Date() })]);
  query.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
  db.mockReturnValue(query);
  db.raw = jest.fn((sql) => sql);
  db.transaction = jest.fn(async (callback) => callback(db));
  heldDatabase = jest.fn();
  templates.loadTemplateByKey.mockResolvedValue({ template: { template_key: 'billing.notice' } });
  templates.activeSuppressionFor.mockResolvedValue(null);
  sendgrid.clearBlockedAddress.mockResolvedValue({ cleared: true });
  sendgrid.sendOne.mockResolvedValue({ messageId: 'provider-2' });
  sendgrid.isDefiniteRejection.mockReturnValue(false);
  billingEmailReplayEligible.mockResolvedValue({ eligible: true });
  authority.dispatchUnderBillingEmailAuthority.mockImplementation(async (options) => {
    const checked = await options.preSendCheck({ database: heldDatabase });
    if (!checked.ok) { options.state.boundaryBlock = checked; return { ok: false }; }
    options.state.handoffStarted = true;
    await options.dispatch(heldDatabase);
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
    to: stored.recipient_email_snapshot, html: stored.html_snapshot, text: stored.text_snapshot, database: heldDatabase,
  }));
  expect(billingEmailReplayEligible.mock.invocationCallOrder[0]).toBeLessThan(sendgrid.clearBlockedAddress.mock.invocationCallOrder[0]);
  expect(reservation.markBillingEmailReservationDelivered).toHaveBeenCalledWith(result.message);
});

test.each([
  { payload_snapshot: '{}' },
  { recipient_id: 'another-customer' },
  { trigger_event_id: 'another-event' },
  { categories: JSON.stringify(['payment_receipt']) },
])('a missing or mismatched replay context stops before authority or provider work: %j', async (override) => {
  await expect(retryOne(storedMessage(override))).resolves.toMatchObject({ sent: false, stopped: true });
  expect(authority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', provider_retry_next_at: null }));
});

test('a stale producer reason terminates its Email without clearing provider blocks or contacting the provider', async () => {
  billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason: 'charge-date-passed', retryable: false });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true, reason: 'charge-date-passed' });
  expect(sendgrid.clearBlockedAddress).not.toHaveBeenCalled();
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).toHaveBeenCalledTimes(1);
});

test('a temporary eligibility failure stays on the bounded retry schedule without dispatching', async () => {
  billingEmailReplayEligible.mockResolvedValue({ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, error: expect.any(Error) });
  expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', provider_retry_next_at: expect.any(Date) }));
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
  expect(reservation.resolveBillingEmailReservationRefusal).not.toHaveBeenCalled();
});

test('revoking Email at the authority boundary terminally stops the stored Email', async () => {
  authority.dispatchUnderBillingEmailAuthority.mockImplementation(async (options) => {
    options.state.boundaryBlock = { code: 'BILLING_EMAIL_NOT_SELECTED', reason: 'Email is no longer selected' };
    return { ok: false };
  });
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
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

test('a reclaimed billing retry claim stops before its provider request', async () => {
  query.then = (resolve, reject) => Promise.resolve(0).then(resolve, reject);
  await expect(retryOne(storedMessage())).resolves.toMatchObject({ sent: false, stopped: true, reason: 'claim_lost' });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
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
    status: 'blocked', provider_retry_exhausted_at: expect.any(Date),
    error_message: `${reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}charge-date-passed`,
  }));
});
