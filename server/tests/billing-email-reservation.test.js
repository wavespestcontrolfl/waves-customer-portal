jest.mock('../services/email-template-library', () => ({
  readStoredBillingReplayContext: jest.fn(),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  markDelivered: jest.fn(),
  markSendFailed: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ContactLedger = require('../services/collections/contact-ledger');
const { readStoredBillingReplayContext } = require('../services/email-template-library');
const Reservation = require('../services/billing-email-reservation');

const context = {
  customer_id: 'customer-1', invoice_id: 'invoice-1', source_entry_point: 'late_payment_checker',
  notificationEventKey: 'late-payment:invoice-1:14', collections_ledger_id: 'email-ledger-1',
};

function acceptedDatabase(current = { id: 'message-1', send_attempt_token: null, sent_at: new Date() }) {
  const query = {};
  for (const method of ['where', 'whereNull', 'forUpdate']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => current);
  const trx = jest.fn(() => query);
  const database = { transaction: jest.fn(async (callback) => callback(trx)) };
  return { database, query, trx };
}

beforeEach(() => {
  jest.clearAllMocks();
  readStoredBillingReplayContext.mockReturnValue(context);
  ContactLedger.markDelivered.mockResolvedValue(true);
  ContactLedger.markSendFailed.mockResolvedValue(true);
});

test('accepted delivery stamps only the fully bound Email reservation', async () => {
  const { database, query, trx } = acceptedDatabase();
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'message-1', sent_at: new Date() }, database))
    .resolves.toBe(true);
  expect(query.whereNull).toHaveBeenCalledWith('send_attempt_token');
  expect(ContactLedger.markDelivered).toHaveBeenCalledWith(
    { id: 'email-ledger-1' },
    { database: trx, match: {
      customerId: 'customer-1', channel: 'email', source: 'late_payment_checker',
      notificationEventKey: 'late-payment:invoice-1:14', invoiceId: 'invoice-1',
    } },
  );
});

test('invoice follow-up replay matches the producer ledger source', async () => {
  const current = { id: 'message-1', send_attempt_token: 'attempt-1', sent_at: new Date() };
  const { database, query, trx } = acceptedDatabase(current);
  readStoredBillingReplayContext.mockReturnValueOnce({
    ...context,
    source_entry_point: 'invoice_followup_sequence',
  });
  await expect(Reservation.markBillingEmailReservationDelivered({
    id: 'message-1', send_attempt_token: 'attempt-1', sent_at: new Date(),
  }, database))
    .resolves.toBe(true);
  expect(query.where).toHaveBeenCalledWith({ send_attempt_token: 'attempt-1' });
  expect(ContactLedger.markDelivered).toHaveBeenCalledWith(
    { id: 'email-ledger-1' },
    { database: trx, match: expect.objectContaining({ source: 'invoice_followups' }) },
  );
});

test('terminal refusal resolves the Email reservation without claiming delivery', async () => {
  const database = jest.fn();
  await expect(Reservation.resolveBillingEmailReservationRefusal({ id: 'message-1' }, database))
    .resolves.toBe(true);
  expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    { id: 'email-ledger-1' },
    { resolved: true, resolution: 'email_terminal_refusal' },
    { database, match: expect.objectContaining({ channel: 'email', notificationEventKey: context.notificationEventKey }) },
  );
});

test('invalid context and writer failures stay held without throwing', async () => {
  const invalid = acceptedDatabase();
  readStoredBillingReplayContext.mockReturnValueOnce(null);
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'message-1', sent_at: new Date() }, invalid.database))
    .resolves.toBe(false);
  const failed = acceptedDatabase();
  ContactLedger.markDelivered.mockRejectedValueOnce(new Error('connection lost'));
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'message-1', sent_at: new Date() }, failed.database))
    .resolves.toBe(false);
});

test('accepted evidence without a persisted message id cannot stamp delivery', async () => {
  await expect(Reservation.markBillingEmailReservationDelivered({ sent_at: new Date() }))
    .resolves.toBe(false);
  expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
});

test('provider identity and a started phase cannot stamp delivery', async () => {
  await expect(Reservation.markBillingEmailReservationDelivered({
    id: 'unknown', provider_message_id: 'provider-1', provider_handoff_phase: 'started',
  })).resolves.toBe(false);
  expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
});

test.each([
  [{ provider_message_id: 'provider-1', provider_handoff_phase: 'started' }, false],
  [{ provider_handoff_phase: 'rejected' }, false],
  [{ sent_at: new Date() }, true],
  [{ delivered_at: new Date() }, true],
])('accepted evidence excludes provider identity and phase alone', (message, expected) => {
  expect(Reservation.hasAcceptedEvidence(message)).toBe(expected);
});

test('a repaired terminal refusal is reflected in the rows the current pass loaded', async () => {
  const row = { id: 'email-ledger-1', channel: 'email',
    metadata: JSON.stringify({ notificationEventKey: context.notificationEventKey }) };
  const refused = { id: 'message-1', status: 'blocked', provider_retry_exhausted_at: new Date(),
    error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}Suppressed: bounce` };
  const database = jest.fn(() => ({ whereIn: jest.fn(async () => [refused]) }));
  const repaired = await Reservation.repairAcceptedBillingEmailReservations([row], database);
  expect(repaired.size).toBe(0); // never counted as delivered
  expect(row.metadata).toMatchObject({ send_failed: true, resolved: true, resolution: 'email_terminal_refusal' });
});

test('an unwritten refusal repair leaves the loaded row pending', async () => {
  ContactLedger.markSendFailed.mockResolvedValueOnce(false);
  const row = { id: 'email-ledger-1', channel: 'email', metadata: { notificationEventKey: context.notificationEventKey } };
  const refused = { id: 'message-1', status: 'blocked', provider_retry_exhausted_at: new Date(),
    error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}Suppressed: bounce` };
  await Reservation.repairAcceptedBillingEmailReservations([row], jest.fn(() => ({ whereIn: jest.fn(async () => [refused]) })));
  expect(row.metadata.resolved).toBeUndefined();
});
