// Invoice delivery self-healing:
//  - enqueueScheduledSend() queues a failed immediate send for the cron to
//    retry (draft/scheduled, non-payer-statement only; fresh retry budget).
//  - processScheduledSends() retries up to MAX_SCHEDULED_SEND_ATTEMPTS, then on
//    the exhausting attempt clears scheduled_send_at (out of the retry queue)
//    and raises invoice_delivery_failed exactly once. A non-exhausting failure
//    does neither.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice-email', () => ({
  sendInvoiceEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: true })),
}));
jest.mock('../services/customer-credit', () => ({
  reverseAppliedCredit: jest.fn(async () => ({})),
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
}));

const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const InvoiceService = require('../services/invoice');

const updateCalls = [];

// A permissive Knex-builder stub. Chain methods return the same object;
// terminal reads (select/first/returning) resolve to whatever was configured
// for that call. Every update() payload is captured for assertions.
function chain({ select, first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereNotNull = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.orWhere = jest.fn(() => q);
  q.orderBy = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.update = jest.fn((payload) => { updateCalls.push(payload); return q; });
  q.select = jest.fn(async () => select || []);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  updateCalls.length = 0;
});
afterEach(() => jest.restoreAllMocks());

describe('InvoiceService.enqueueScheduledSend', () => {
  test('eligible draft → flips to scheduled with a fresh retry budget', async () => {
    const queued = { id: 'inv-1', status: 'scheduled' };
    db.mockReturnValueOnce(chain({ returning: [queued] }));

    const result = await InvoiceService.enqueueScheduledSend('inv-1');

    expect(result).toEqual(queued);
    const payload = updateCalls[0];
    expect(payload.status).toBe('scheduled');
    expect(payload.scheduled_send_attempts).toBe(0);
    expect(payload.scheduled_send_error).toBeNull();
    expect(payload.scheduled_send_at).toBeInstanceOf(Date);
    // Review flags are left untouched unless the caller takes a decision.
    expect(payload).not.toHaveProperty('scheduled_request_review');
  });

  test('ineligible row (paid / payer-statement) → returns null', async () => {
    db.mockReturnValueOnce(chain({ returning: [] }));
    const result = await InvoiceService.enqueueScheduledSend('inv-1');
    expect(result).toBeNull();
  });

  test('no invoiceId → no-op null, no db write', async () => {
    const result = await InvoiceService.enqueueScheduledSend(null);
    expect(result).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });
});

describe('InvoiceService.processScheduledSends — exhaustion alert + recover', () => {
  const failedSend = {
    ok: false,
    sms: { error: 'twilio down' },
    email: { error: 'ses down' },
    creditApplied: 0,
  };

  test('failure below the cap: increments attempts, KEEPS the row queued, no alert', async () => {
    jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue(failedSend);
    db
      .mockReturnValueOnce(chain())                                   // stale-sending recovery
      .mockReturnValueOnce(chain({ select: [{ id: 'inv-1', invoice_number: 'WPC-1', scheduled_send_attempts: 0 }] })) // due
      .mockReturnValueOnce(chain({ returning: [{ id: 'inv-1' }] }))  // claim
      .mockReturnValueOnce(chain());                                  // failure update

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1 });
    const failureUpdate = updateCalls[updateCalls.length - 1];
    expect(failureUpdate.scheduled_send_attempts).toBe(1);
    expect(failureUpdate.scheduled_send_error).toBe('sms: twilio down | email: ses down');
    // Still retryable — must NOT be pulled from the queue.
    expect(failureUpdate).not.toHaveProperty('scheduled_send_at');
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('failure ON the cap: clears scheduled_send_at and alerts exactly once', async () => {
    jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue(failedSend);
    db
      .mockReturnValueOnce(chain())                                   // stale-sending recovery
      .mockReturnValueOnce(chain({ select: [{ id: 'inv-9', invoice_number: 'WPC-9', scheduled_send_attempts: 4 }] })) // due (4 → 5)
      .mockReturnValueOnce(chain({ returning: [{ id: 'inv-9' }] }))  // claim
      .mockReturnValueOnce(chain())                                   // failure update
      .mockReturnValueOnce(chain({ first: { customer_id: 'cust-9' } })) // detail read
      .mockReturnValueOnce(chain({ first: { first_name: 'Jane', last_name: 'Doe' } })); // customer name

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1 });
    const failureUpdate = updateCalls[updateCalls.length - 1];
    expect(failureUpdate.scheduled_send_attempts).toBe(5);
    // Recovered out of the retry queue.
    expect(failureUpdate.scheduled_send_at).toBeNull();
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification).toHaveBeenCalledWith('invoice_delivery_failed', expect.objectContaining({
      invoiceId: 'inv-9',
      invoiceNumber: 'WPC-9',
      customerName: 'Jane Doe',
      attempts: 5,
      errorMessage: 'sms: twilio down | email: ses down',
    }));
  });

  test('successful send: no failure update, no alert', async () => {
    jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockResolvedValue({ ok: true });
    db
      .mockReturnValueOnce(chain())                                   // stale-sending recovery
      .mockReturnValueOnce(chain({ select: [{ id: 'inv-2', invoice_number: 'WPC-2', scheduled_send_attempts: 1 }] })) // due
      .mockReturnValueOnce(chain({ returning: [{ id: 'inv-2' }] })); // claim

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});
