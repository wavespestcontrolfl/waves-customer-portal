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

describe('customer-level dunning email reservations', () => {
  const eventKey = 'customer-dunning:sched-1:2:d60_reminder';
  const ledgerRow = () => ({ id: 'ledger-9', customer_id: 'customer-1', channel: 'email', source: 'invoice_followups_customer',
    metadata: JSON.stringify({ notificationEventKey: eventKey }) });
  const stored = (over = {}) => ({
    id: 'message-9', idempotency_key: 'customer_dunning_email:sched-1:2:d60_reminder', trigger_event_id: 'customer_dunning:sched-1:2:d60_reminder',
    recipient_type: 'customer', recipient_id: 'customer-1', template_key: 'invoice.followup_combined_60_day',
    payload_snapshot: JSON.stringify({ collections_ledger_id: 'ledger-9' }), send_attempt_token: null, sent_at: new Date('2026-10-06T14:00:00Z'), ...over,
  });
  // one handle serving the whereIn scan and the locked re-read
  const handle = (message) => {
    const locked = { where: jest.fn(() => locked), whereNull: jest.fn(() => locked), forUpdate: jest.fn(() => locked), first: jest.fn(async () => message) };
    const trx = jest.fn(() => locked);
    const database = jest.fn(() => ({ whereIn: jest.fn(async () => [message]) }));
    database.transaction = jest.fn(async (callback) => callback(trx));
    return { database, trx };
  };

  test('an accepted email bound to this reservation stamps exactly that ledger row, with the original acceptance time', async () => {
    const { database, trx } = handle(stored());
    const repaired = await Reservation.repairAcceptedBillingEmailReservations([ledgerRow()], database);
    expect([...repaired]).toEqual(['ledger-9']);
    expect(ContactLedger.markDelivered).toHaveBeenCalledWith({ id: 'ledger-9' }, {
      database: trx,
      match: { customerId: 'customer-1', channel: 'email', source: 'invoice_followups_customer', notificationEventKey: eventKey },
      occurredAt: new Date('2026-10-06T14:00:00Z'),
    });
  });

  test.each([
    ['names another ledger row', { payload_snapshot: JSON.stringify({ collections_ledger_id: 'ledger-other' }) }],
    ['carries no ledger binding', { payload_snapshot: '{}' }],
    ['was sent to another customer', { recipient_id: 'customer-2' }],
    ['has a different touch key', { idempotency_key: 'customer_dunning_email:sched-1:2:d90_final_notice' }],
    ['has a different trigger id', { trigger_event_id: 'customer_dunning:sched-9:2:d60_reminder' }],
    ['is not a follow-up template', { template_key: 'billing.notice' }],
    ['was not accepted yet', { sent_at: null }],
  ])('a stored email that %s is left held', async (_name, over) => {
    const { database } = handle(stored(over));
    const repaired = await Reservation.repairAcceptedBillingEmailReservations([ledgerRow()], database);
    expect(repaired.size).toBe(0);
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
  });

  test('a delivered, resolved, or non-dunning row is never scanned; a failed stamp reports nothing repaired', async () => {
    const database = jest.fn();
    const none = await Reservation.repairAcceptedBillingEmailReservations([
      { ...ledgerRow(), metadata: JSON.stringify({ notificationEventKey: eventKey, delivered: true }) },
      { ...ledgerRow(), metadata: JSON.stringify({ notificationEventKey: eventKey, resolved: true }) },
      { ...ledgerRow(), source: 'invoice_followups' },
    ], database);
    expect(none.size).toBe(0);
    const failing = handle(stored());
    ContactLedger.markDelivered.mockResolvedValueOnce(false);
    expect((await Reservation.repairAcceptedBillingEmailReservations([ledgerRow()], failing.database)).size).toBe(0);
  });
});

describe('readOnly view (the customer-dunning shadow run): accepted evidence counts, nothing is written', () => {
  const dunningRow = () => ({ id: 'ledger-9', customer_id: 'customer-1', channel: 'email', source: 'invoice_followups_customer',
    metadata: JSON.stringify({ notificationEventKey: 'customer-dunning:sched-1:2:d60_reminder' }) });
  const dunningMessage = () => ({
    id: 'message-9', idempotency_key: 'customer_dunning_email:sched-1:2:d60_reminder', trigger_event_id: 'customer_dunning:sched-1:2:d60_reminder',
    recipient_type: 'customer', recipient_id: 'customer-1', template_key: 'invoice.followup_combined_60_day',
    payload_snapshot: JSON.stringify({ collections_ledger_id: 'ledger-9' }), sent_at: new Date(),
  });
  const handle = (messages) => {
    const database = jest.fn(() => ({ whereIn: jest.fn(async () => messages) }));
    database.transaction = jest.fn();
    return database;
  };
  const untouched = (database) => {
    expect(database.transaction).not.toHaveBeenCalled();
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  };

  test('a customer-dunning email bound to its reservation is reported delivered with no transaction and no stamp', async () => {
    const database = handle([dunningMessage()]);
    const repaired = await Reservation.repairAcceptedBillingEmailReservations([dunningRow()], database, { readOnly: true });
    expect([...repaired]).toEqual(['ledger-9']);
    untouched(database);
    // the default still repairs
    database.transaction.mockImplementation(async (callback) => callback(jest.fn(() => ({
      where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), forUpdate: jest.fn().mockReturnThis(), first: jest.fn(async () => dunningMessage()),
    }))));
    ContactLedger.markDelivered.mockResolvedValue(true);
    expect([...await Reservation.repairAcceptedBillingEmailReservations([dunningRow()], database)]).toEqual(['ledger-9']);
    expect(ContactLedger.markDelivered).toHaveBeenCalledTimes(1);
  });

  test('a billing_channel_email acceptance is reported delivered without a stamp; a terminal refusal or re-quote is NOT acted on', async () => {
    const row = { id: 'email-ledger-1', customer_id: 'customer-1', channel: 'email', source: 'late_payment_checker',
      invoice_ids: ['invoice-1'], metadata: JSON.stringify({ notificationEventKey: context.notificationEventKey }) };
    const database = handle([{ id: 'message-1', sent_at: new Date() }]);
    const repaired = await Reservation.repairAcceptedBillingEmailReservations([row], database, { readOnly: true });
    expect([...repaired]).toEqual(['email-ledger-1']);
    untouched(database);
    // bound to a different customer: not delivered for this row
    readStoredBillingReplayContext.mockReturnValueOnce({ ...context, customer_id: 'someone-else' });
    expect((await Reservation.repairAcceptedBillingEmailReservations([row], handle([{ id: 'message-1', sent_at: new Date() }]), { readOnly: true })).size).toBe(0);
    // a terminal refusal is a write (resolves the reservation): left alone in the read-only view
    const refused = { id: 'message-2', status: 'blocked', provider_retry_exhausted_at: new Date(),
      error_message: `${Reservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}Suppressed: bounce` };
    const refusedDb = handle([refused]);
    const before = JSON.stringify(row);
    await Reservation.repairAcceptedBillingEmailReservations([row], refusedDb, { readOnly: true });
    untouched(refusedDb);
    expect(JSON.stringify(row)).toBe(before);
  });
});
