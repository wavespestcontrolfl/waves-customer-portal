// Codex r12 follow-on P1 #4131: claimInvoiceForSend's adoption
// (adoptsQueuedInvoiceSend) CANCELS any pre-existing queued pay-link SMS
// BEFORE the replacement delivery is even attempted, so the worker can
// never double-send while it's in flight. If that replacement delivery
// then fails, the cancellation must be undone (or a fresh replacement must
// already own the delivery) — otherwise the customer's already-scheduled
// text is silently lost. Two behaviors under test:
//   1. sendViaSMS (direct caller): an adopting send that fails for an
//      unrelated reason (no phone on file) restores the queued row exactly
//      as it was — same id, same scheduled_for.
//   2. sendViaSMS (direct caller) hit by a quiet-hours-style provider hold
//      requeues the held text onto the scheduled rail instead of just
//      throwing it away — the behavior sendViaSMSAndEmail already had, now
//      shared rather than sendViaSMS lacking it entirely.

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
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => null),
  reverseAppliedCredit: jest.fn(async () => {}),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/invoice-prepay', () => ({
  loadInvoiceAnnualPrepay: jest.fn(async () => null),
  buildPrepayCoverageSummary: jest.fn(() => null),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
  getTemplate: jest.fn(async () => 'Hi there, pay your invoice here: https://pay.example/abc'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19410000000'),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const InvoiceService = require('../services/invoice');

const NEXT_WINDOW_OPEN = '2026-09-12T12:00:00.000Z'; // 8:00 AM ET

function chain({ rows, returning, first, updateCount = 1 } = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'update', 'insert']) {
    q[m] = jest.fn(() => q);
  }
  q.select = jest.fn(async () => rows || []);
  q.returning = jest.fn(async () => returning || []);
  q.first = jest.fn(async () => first);
  // Awaiting the chain itself resolves like knex: an update/insert chain
  // resolves its affected-row count, anything else the row set.
  q.then = (resolve) => Promise.resolve((q.update.mock.calls.length || q.insert.mock.calls.length) ? updateCount : (rows || [])).then(resolve);
  // restoreSendClaim chains a bare .catch() straight off .update() (no
  // await in between) — every chain supports it so nothing throws on a
  // path this suite doesn't otherwise care about.
  q.catch = jest.fn(() => Promise.resolve());
  return q;
}

const draftInvoice = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-2001',
  status: 'draft',
  customer_id: 'cust-1',
  payer_id: null,
  token: 'tok-1',
};

describe('claimInvoiceForSend adoption survives a failed replacement delivery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sendViaSMS (direct caller): a no-phone failure restores the consumed queued row — same id, same scheduled_for', async () => {
    const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T12:00:00.000Z');
    const restoreClaimChain = chain();
    const restoreQueueChain = chain();
    db
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [{ id: 'sms-queued-1', scheduled_for: ORIGINAL_SCHEDULED_FOR }] })) // adoption consumes the pre-existing queued row
      .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: null } })) // customer lookup — NO PHONE
      .mockReturnValueOnce(restoreClaimChain) // restoreSendClaim
      .mockReturnValueOnce(restoreQueueChain); // restoreConsumedQueuedSend

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('Customer has no phone number');

    // The invoice claim itself was restored...
    expect(restoreClaimChain.update.mock.calls[0][0]).toMatchObject({ status: 'draft' });
    // ...and so was the queued send this adoption had cancelled: same row,
    // same schedule — not a fresh one, the ORIGINAL obligation.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    expect(restoreQueueChain.where.mock.calls.some((c) => c[0]?.status === 'cancelled')).toBe(true);
    const restoreUpdate = restoreQueueChain.update.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    // scheduled_for is never touched by the restore — the row's original
    // schedule survives untouched, exactly as the fix requires.
    expect(restoreUpdate.scheduled_for).toBeUndefined();
  });

  test('sendViaSMS (direct caller) held by a quiet-hours-style provider hold requeues the text instead of losing it', async () => {
    const requeueInsertChain = chain();
    db
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [] })) // adoption: nothing pre-existing to consume
      .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' } })) // customer lookup
      .mockReturnValueOnce(chain({ first: undefined })) // requeue idempotency check (no prior row)
      .mockReturnValueOnce(requeueInsertChain) // held-SMS scheduled-rail insert
      .mockReturnValueOnce(chain()); // restoreSendClaim

    sendCustomerMessage.mockResolvedValueOnce({
      sent: false,
      code: 'QUIET_HOURS_HOLD',
      reason: 'outside send window',
      deferred: true,
      nextAllowedAt: NEXT_WINDOW_OPEN,
    });

    // sendViaSMS keeps its existing throw-on-failure contract (direct
    // callers already handle that) — the fix is that the pay link is no
    // longer LOST, it is requeued before the throw.
    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ code: 'QUIET_HOURS_HOLD' });

    expect(requeueInsertChain.insert).toHaveBeenCalledTimes(1);
    const queuedRow = requeueInsertChain.insert.mock.calls[0][0];
    expect(queuedRow.status).toBe('scheduled');
    expect(queuedRow.scheduled_for).toEqual(new Date(NEXT_WINDOW_OPEN));
    expect(queuedRow.to_phone).toBe('+19415550123');
    expect(queuedRow.message_body).toContain('https://pay.example/abc');
    const metadata = JSON.parse(queuedRow.metadata);
    expect(metadata.entry_point).toBe('invoice_send_deferred');
    expect(metadata.invoice_id).toBe('inv-1');
  });
});
