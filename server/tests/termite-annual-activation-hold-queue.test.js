/**
 * Round 11 P2 on #5424: an annual-plan invoice the direct sender refuses under a collections
 * DISPUTE hold (retryable COLLECTION_HOLD_DEFER) is queued on the hold-aware scheduled sender
 * (requeueHeldInvoice -> queueHeldInvoiceForSender), so it goes out on the first tick after the
 * release instead of waiting for the next ET day's reconciliation sweep (the attempt stamp written
 * before the send makes today's scan skip it). No delivery-failed bell: a hold is a WAIT.
 * Behavior of the queue itself and the sender is covered against Postgres in
 * collection-hold-invoice-sender-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice', () => ({ sendViaSMSAndEmail: jest.fn() }));
jest.mock('../services/estimate-converter', () => ({ canAutoSendDraftInvoice: jest.fn(() => true) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  requeueHeldInvoice: jest.fn(async () => true),
}));

const InvoiceService = require('../services/invoice');
const Hold = require('../services/collections/collection-hold');
const NotificationService = require('../services/notification-service');
const { _private } = require('../services/termite-annual-activation');

function fakeConn() {
  const updates = [];
  const conn = jest.fn((table) => ({
    where: jest.fn(() => ({
      update: jest.fn(async (patch) => { updates.push({ table, patch }); return 1; }),
      first: jest.fn(async () => ({ customer_id: 'cust-1' })),
    })),
  }));
  conn.updates = updates;
  return conn;
}

beforeEach(() => jest.clearAllMocks());

describe('deliverAnnualInvoiceOrBell under a dispute hold', () => {
  test('a COLLECTION_HOLD_DEFER refusal queues the invoice on the scheduled sender, reports held, and rings no bell', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: false, code: 'COLLECTION_HOLD_DEFER', retryable: true, deferred: true });
    const conn = fakeConn();
    const out = await _private.deliverAnnualInvoiceOrBell({ estimateId: 'est-1', invoiceId: 'inv-1', termId: 'term-1', conn });
    expect(out).toMatchObject({ ok: false, held: true });
    expect(Hold.requeueHeldInvoice).toHaveBeenCalledWith('inv-1', { customerId: 'cust-1' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // the attempt stamp still happens first (it is what the reconciliation scan keys on)
    expect(conn.updates.some((u) => u.table === 'invoices' && u.patch.annual_delivery_attempted_at)).toBe(true);
  });

  test('a queue failure inside requeueHeldInvoice (it raises its own durable alert) still reports held, never a failure bell', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: false, code: 'COLLECTION_HOLD_DEFER' });
    Hold.requeueHeldInvoice.mockResolvedValueOnce(false);
    const out = await _private.deliverAnnualInvoiceOrBell({ estimateId: 'est-1', invoiceId: 'inv-2', termId: 'term-1', conn: fakeConn() });
    expect(out).toMatchObject({ ok: false, held: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('an ordinary delivery never touches the queue', async () => {
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true } });
    const out = await _private.deliverAnnualInvoiceOrBell({ estimateId: 'est-1', invoiceId: 'inv-3', termId: 'term-1', conn: fakeConn() });
    expect(out).toMatchObject({ ok: true });
    expect(Hold.requeueHeldInvoice).not.toHaveBeenCalled();
  });
});
