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

beforeEach(() => {
  jest.clearAllMocks();
  readStoredBillingReplayContext.mockReturnValue(context);
  ContactLedger.markDelivered.mockResolvedValue(true);
  ContactLedger.markSendFailed.mockResolvedValue(true);
});

test('accepted delivery stamps only the fully bound Email reservation', async () => {
  const database = jest.fn();
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'message-1', sent_at: new Date() }, database))
    .resolves.toBe(true);
  expect(ContactLedger.markDelivered).toHaveBeenCalledWith(
    { id: 'email-ledger-1' },
    { database, match: {
      customerId: 'customer-1', channel: 'email', source: 'late_payment_checker',
      notificationEventKey: 'late-payment:invoice-1:14', invoiceId: 'invoice-1',
    } },
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
  readStoredBillingReplayContext.mockReturnValueOnce(null);
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'invalid', sent_at: new Date() }))
    .resolves.toBe(false);
  ContactLedger.markDelivered.mockRejectedValueOnce(new Error('connection lost'));
  await expect(Reservation.markBillingEmailReservationDelivered({ id: 'accepted', sent_at: new Date() }))
    .resolves.toBe(false);
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
