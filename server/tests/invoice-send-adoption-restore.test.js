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
const { shortenOrPassthrough } = require('../services/short-url');
const { isTemplateActive, getTemplate } = require('../routes/admin-sms-templates');
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

  test('sendViaSMS (direct caller): a no-phone failure restores the consumed queued row — same id, same scheduled_for — BEFORE releasing the invoice claim', async () => {
    const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T12:00:00.000Z');
    const restoreQueueChain = chain();
    const restoreClaimChain = chain();
    const callOrder = [];
    restoreQueueChain.update = jest.fn((v) => { callOrder.push('queue'); return restoreQueueChain._baseUpdate(v); });
    restoreQueueChain._baseUpdate = jest.fn(() => restoreQueueChain);
    restoreClaimChain.update = jest.fn((v) => { callOrder.push('claim'); return restoreClaimChain._baseUpdate(v); });
    restoreClaimChain._baseUpdate = jest.fn(() => restoreClaimChain);
    db
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [{ id: 'sms-queued-1', scheduled_for: ORIGINAL_SCHEDULED_FOR }] })) // adoption consumes the pre-existing queued row
      .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: null } })) // customer lookup — NO PHONE
      // restoreSendClaim is now the chokepoint: queue row restored FIRST,
      // invoice claim released SECOND (Codex r12 follow-on P1 #4131 round 2)
      // — a worker waking in between must never see an unclaimed invoice
      // with no queue row.
      .mockReturnValueOnce(restoreQueueChain) // restoreConsumedQueuedSend
      .mockReturnValueOnce(restoreClaimChain); // the invoice status update

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('Customer has no phone number');

    // The queued send this adoption had cancelled was restored: same row,
    // same schedule — not a fresh one, the ORIGINAL obligation.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    expect(restoreQueueChain.where.mock.calls.some((c) => c[0]?.status === 'cancelled')).toBe(true);
    const restoreUpdate = restoreQueueChain._baseUpdate.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    // scheduled_for is never touched by the restore — the row's original
    // schedule survives untouched, exactly as the fix requires.
    expect(restoreUpdate.scheduled_for).toBeUndefined();
    // ...and the invoice claim itself was restored too...
    expect(restoreClaimChain._baseUpdate.mock.calls[0][0]).toMatchObject({ status: 'draft' });
    // ...strictly AFTER the queue row, per the owner's ordering rule.
    expect(callOrder).toEqual(['queue', 'claim']);
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

  test('claimInvoiceForSend: the post-adoption re-verify lookup THROWING restores the consumed row before re-throwing — restoration is not a per-caller convention', async () => {
    const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T09:00:00.000Z');
    const restoreQueueChain = chain();
    const restoreClaimChain = chain();
    const throwingLookup = {
      where: jest.fn(() => throwingLookup),
      whereRaw: jest.fn(() => throwingLookup),
      first: jest.fn(async () => { throw new Error('sms_log lookup failed'); }),
    };
    db
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [{ id: 'sms-queued-1', scheduled_for: ORIGINAL_SCHEDULED_FOR }] })) // adoption consumes the pre-existing row
      .mockReturnValueOnce(throwingLookup) // the RE-VERIFY lookup right after consuming — THROWS
      .mockReturnValueOnce(restoreQueueChain) // restoreSendClaim: queue row restored FIRST
      .mockReturnValueOnce(restoreClaimChain); // restoreSendClaim: invoice claim released SECOND

    await expect(InvoiceService.claimInvoiceForSend('inv-1', { adoptsQueuedInvoiceSend: true }))
      .rejects.toThrow('sms_log lookup failed');

    // The row consumed just before the throw is restored — same id, same
    // schedule — not stranded cancelled forever because the throw happened
    // one line after the consume, inside the adopting step itself.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    const restoreUpdate = restoreQueueChain.update.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    expect(restoreUpdate.scheduled_for).toBeUndefined();
    // ...and the invoice claim was released too.
    expect(restoreClaimChain.update.mock.calls[0][0]).toMatchObject({ status: 'draft' });
  });

  test('a fully delivered send leaves the consumed queue row cancelled — nothing restores a row a live send actually superseded', async () => {
    const fallback = chain();
    db
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [{ id: 'sms-queued-1', scheduled_for: new Date('2026-09-11T09:00:00.000Z') }] })) // adoption consumes the pre-existing row
      .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' } })) // customer lookup
      .mockReturnValue(fallback); // finalize + every post-delivery best-effort step

    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    const result = await InvoiceService.sendViaSMS('inv-1');

    expect(result.sent).toBe(true);
    // Nothing anywhere in the flow ever set the queue row (or any row)
    // back to 'scheduled' — the consumed row stays cancelled because a
    // live send actually delivered the pay link.
    const anyRestoredToScheduled = fallback.update.mock.calls.some((c) => c[0]?.status === 'scheduled');
    expect(anyRestoredToScheduled).toBe(false);
  });
});

// Codex r12 follow-on P1 #4131 round 3: EVERY pre-delivery exit in
// sendViaSMS — after the claim returns consumedQueuedSendRows but before a
// confirmed provider accept — now sits inside the ONE try/finally guard
// (`delivered`), so the queue row this claim's adoption cancelled is
// restored regardless of WHICH exit fires, no per-branch memory required.
// Table-driven over the enumerated exits so a future one added inside the
// guard is covered automatically, and one added OUTSIDE it would need a
// new row here to prove it too.
describe('sendViaSMS: every pre-delivery exit restores the consumed queue row (table-driven)', () => {
  const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T09:00:00.000Z');
  const CONSUMED_ROW = { id: 'sms-queued-1', scheduled_for: ORIGINAL_SCHEDULED_FOR };

  const CASES = [
    {
      name: 'payer_billed: invoice carries a payer_id — SMS suppressed, no credit reversal',
      invoiceOverrides: { payer_id: 'payer-1' },
      expectRejects: null,
      expectResultCode: 'payer_billed',
      expectCreditReversalAttempted: false,
    },
    {
      name: 'no phone on file',
      invoiceOverrides: {},
      customerOverride: { id: 'cust-1', phone: null },
      expectRejects: 'Customer has no phone number',
      expectCreditReversalAttempted: true,
    },
    {
      name: 'pay-url mint failure (shortenOrPassthrough throws — never wrapped in its own try/catch)',
      invoiceOverrides: {},
      customerOverride: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' },
      beforeRun: () => shortenOrPassthrough.mockImplementationOnce(async () => { throw new Error('short-link service down'); }),
      expectRejects: 'short-link service down',
      expectCreditReversalAttempted: true,
    },
    {
      name: 'template missing/disabled',
      invoiceOverrides: {},
      customerOverride: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' },
      beforeRun: () => { isTemplateActive.mockResolvedValueOnce(false); getTemplate.mockResolvedValueOnce(null); },
      expectRejects: null,
      expectResultCode: 'INVOICE_SENT_TEMPLATE_MISSING',
      expectCreditReversalAttempted: true,
    },
    {
      name: 'provider blocks the send for a NON-hold reason (no deferred/nextAllowedAt)',
      invoiceOverrides: {},
      customerOverride: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' },
      beforeRun: () => sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'OPTED_OUT', reason: 'customer opted out' }),
      expectRejects: 'payment-link SMS blocked: OPTED_OUT',
      expectCreditReversalAttempted: true,
    },
  ];

  test.each(CASES)('$name', async ({ invoiceOverrides, customerOverride, beforeRun, expectRejects, expectResultCode, expectCreditReversalAttempted }) => {
    jest.clearAllMocks();
    const { reverseAppliedCredit, autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
    // A partial (non-full) credit application so reverseCreditOnExit's
    // effect is actually observable — fullyCovered would short-circuit
    // before any of these exits are even reachable.
    autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ applied: 25, fullyCovered: false });
    const restoreQueueChain = chain();
    const restoreClaimChain = chain();
    const invoiceRow = { ...draftInvoice, ...invoiceOverrides };
    const mocks = [
      chain({ first: invoiceRow }),
      chain({ first: undefined }),
      chain({ returning: [{ ...invoiceRow, status: 'sending' }] }),
      chain({ first: undefined }),
      chain({ returning: [CONSUMED_ROW] }),
      chain({ first: undefined }),
    ];
    if (customerOverride) mocks.push(chain({ first: customerOverride }));
    mocks.push(restoreQueueChain, restoreClaimChain);
    for (const m of mocks) db.mockReturnValueOnce(m);
    if (beforeRun) beforeRun();

    if (expectRejects) {
      await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow(expectRejects);
    } else {
      const result = await InvoiceService.sendViaSMS('inv-1');
      expect(result.sent).toBe(false);
      if (expectResultCode) expect(result.code).toBe(expectResultCode);
    }

    // THE invariant under test: the row this claim's adoption cancelled is
    // restored — same id, same schedule — no matter which exit fired.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    const restoreUpdate = restoreQueueChain.update.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    expect(restoreUpdate.scheduled_for).toBeUndefined();
    // The invoice claim was released too, in the fixed order (queue first).
    expect(restoreClaimChain.update.mock.calls[0][0]).toMatchObject({ status: 'draft' });

    if (expectCreditReversalAttempted) {
      expect(reverseAppliedCredit).toHaveBeenCalledTimes(1);
    } else {
      expect(reverseAppliedCredit).not.toHaveBeenCalled();
    }
  });
});
