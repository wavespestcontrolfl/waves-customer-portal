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
jest.mock('../services/invoice-email', () => ({
  sendInvoiceEmail: jest.fn(),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { shortenOrPassthrough } = require('../services/short-url');
const { isTemplateActive, getTemplate } = require('../routes/admin-sms-templates');
const { sendInvoiceEmail } = require('../services/invoice-email');
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

function throwingChain(err) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'update', 'insert']) {
    q[m] = jest.fn(() => q);
  }
  q.then = (resolve, reject) => Promise.reject(err).then(resolve, reject);
  q.catch = jest.fn((fn) => Promise.reject(err).catch(fn));
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
      .mockReturnValueOnce(chain({ first: { visit_completion_packet_id: null, payer_id: null } })) // direct-send Bill-To precheck
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

  test('a transient queue-restore failure keeps the invoice send claim held for recovery', async () => {
    const restoreErr = new Error('transient sms_log restore failure');
    db.mockReturnValueOnce(throwingChain(restoreErr));

    await expect(InvoiceService.restoreSendClaim(
      'inv-1',
      'draft',
      true,
      [{ id: 'sms-queued-1' }],
    )).rejects.toMatchObject({ code: 'queued_sms_restore_failed' });

    // No invoices query follows the failed sms_log update: the claim remains
    // 'sending', which is the durable recovery marker for the lost hand-off.
    expect(db.mock.calls.map(([table]) => table)).toEqual(['sms_log']);
  });

  test('sendViaSMS (direct caller) held by a quiet-hours-style provider hold requeues the text instead of losing it', async () => {
    const requeueInsertChain = chain();
    db
      .mockReturnValueOnce(chain({ first: { visit_completion_packet_id: null, payer_id: null } })) // direct-send Bill-To precheck
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
      .mockReturnValueOnce(chain({ first: { visit_completion_packet_id: null, payer_id: null } })) // direct-send Bill-To precheck
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

  test('the provider ACCEPTS the replacement SMS but the post-send audit-row write then throws (providerOutcome.sent === true): the consumed queue row stays cancelled and the claim is never released back to draft (pre-push Codex P1 #4131, fourth instance of the send-then-bookkeeping-throw shape)', async () => {
    const fallback = chain();
    db
      .mockReturnValueOnce(chain({ first: { visit_completion_packet_id: null, payer_id: null } })) // direct-send Bill-To precheck
      .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: undefined })) // pre-claim queued check (none)
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // reconcile: queued-under-claim check (none)
      .mockReturnValueOnce(chain({ returning: [{ id: 'sms-queued-1', scheduled_for: new Date('2026-09-11T09:00:00.000Z') }] })) // adoption consumes the pre-existing row
      .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' } })) // customer lookup
      .mockReturnValue(fallback); // finalize retry + every post-delivery best-effort step

    // sendCustomerMessage attaches providerOutcome to the error it throws
    // when the provider ACCEPTED the message but the post-send audit write
    // failed — smsDelivered is never assigned true on this path (it is only
    // set after sendCustomerMessage RETURNS), so without the fix the catch
    // falls into the "NOT delivered" branch and the outer finally restores
    // the queue row this claim's adoption cancelled — even though the
    // replacement text it cancelled that row FOR was already accepted by
    // the provider, so the "restored" row would go on to deliver a SECOND
    // pay-link SMS for the same invoice.
    const acceptedErr = Object.assign(new Error('audit row insert failed (injected)'), {
      providerOutcome: { sent: true, providerMessageId: 'SM_injected' },
    });
    sendCustomerMessage.mockRejectedValueOnce(acceptedErr);

    const result = await InvoiceService.sendViaSMS('inv-1');

    // Recorded as delivered (recoverPostDeliverySmsBookkeeping's shape),
    // not thrown as a failed send.
    expect(result).toMatchObject({ sent: true, finalizeError: expect.stringContaining('audit row insert failed') });

    // THE bug: nothing anywhere in the flow may restore the queue row this
    // claim's adoption cancelled — a live send actually superseded it.
    const anyRestoredToScheduled = fallback.update.mock.calls.some((c) => c[0]?.status === 'scheduled');
    expect(anyRestoredToScheduled).toBe(false);
    // ...and the invoice claim itself was never released back to 'draft' —
    // it finalizes 'sent' through the retried finalize instead (or, if that
    // retry also fails, stays parked under its claim for stale-claim review
    // — never reopened for an automatic resend that would duplicate the
    // delivered text).
    const anyReleasedToDraft = fallback.update.mock.calls.some((c) => c[0]?.status === 'draft');
    expect(anyReleasedToDraft).toBe(false);
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
      chain({ first: { visit_completion_packet_id: null, payer_id: invoiceRow.payer_id } }), // direct-send Bill-To precheck
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

// Codex round 14 P1 #4131 (2nd P1): processScheduledSends preclaims the
// invoice (flips it to 'sending' itself) and calls in with
// allowClaimed:true — that branch used to return before ANY queue check,
// so a live invoice_send_deferred row from an earlier held DIRECT send
// stayed live and could still deliver the SAME frozen pay link a second
// time. claimInvoiceForSend's allowClaimed branch now runs the SAME
// reconcileQueuedSendUnderClaim chokepoint the ordinary claim path does.
describe('claimInvoiceForSend (allowClaimed): the preclaimed branch still reconciles a queued pay link', () => {
  test('a live invoice_send_deferred row (this send\'s own earlier held leg) is CONSUMED — the claim succeeds, one delivery owns it', async () => {
    const preclaimedInvoice = { ...draftInvoice, status: 'sending' };
    const consumeChain = chain({ returning: [{ id: 'sms-deferred-1', scheduled_for: new Date('2026-09-11T12:00:00.000Z') }] });
    db
      .mockReturnValueOnce(chain({ first: preclaimedInvoice })) // claim read — already 'sending' (preclaimed by processScheduledSends)
      .mockReturnValueOnce(chain({ first: undefined })) // adopter's view: the still-scheduled invoice_send_deferred row is its own, not a blocker
      .mockReturnValueOnce(consumeChain) // consumeQueuedInvoiceSend — the row IS consumed here
      .mockReturnValueOnce(chain({ first: undefined })); // strict re-check after the consume — nothing else live

    const claim = await InvoiceService.claimInvoiceForSend('inv-1', { allowClaimed: true, adoptsQueuedInvoiceSend: true });

    expect(claim).toMatchObject({ claimed: false, previousStatus: 'sending' });
    expect(claim.consumedQueuedSendRows).toEqual([{ id: 'sms-deferred-1', scheduled_for: new Date('2026-09-11T12:00:00.000Z') }]);
    // The consume update actually ran (row cancelled) — the earlier held
    // leg no longer owns a delivery, so only THIS send's own delivery goes
    // out, not both.
    expect(consumeChain.update).toHaveBeenCalledTimes(1);
    expect(consumeChain.update.mock.calls[0][0].status).toBe('cancelled');
  });

  test('a DIFFERENT live queue (e.g. a completion-deferred text) still refuses the preclaimed branch — it does not own that delivery', async () => {
    const preclaimedInvoice = { ...draftInvoice, status: 'sending' };
    const before = db.mock.calls.length;
    db
      .mockReturnValueOnce(chain({ first: preclaimedInvoice })) // claim read
      .mockReturnValueOnce(chain({ first: { id: 'sms-completion-1', scheduled_for: new Date('2026-09-11T12:00:00.000Z') } })); // a LIVE completion-deferred row blocks even the adopter's view

    await expect(InvoiceService.claimInvoiceForSend('inv-1', { allowClaimed: true, adoptsQueuedInvoiceSend: true }))
      .rejects.toMatchObject({ code: 'queued_pay_link' });
    // The refusal's claim give-back never touches the preclaimed row (Codex
    // round 16 P1 #4131): its previousStatus IS 'sending', so there is
    // nothing to restore, and a re-stamp of updated_at would invalidate the
    // caller's claim token — exactly two db calls, no invoices UPDATE.
    expect(db.mock.calls.slice(before).map(([table]) => table)).toEqual(['invoices', 'sms_log']);
  });

  test('a transient lookup throw under the preclaimed branch rethrows WITHOUT re-stamping the row — processScheduledSends restores with its own token (Codex round 16 P1 #4131)', async () => {
    const preclaimedInvoice = { ...draftInvoice, status: 'sending' };
    const failingLookup = chain();
    failingLookup.first = jest.fn(async () => { throw new Error('transient lookup failure'); });
    const before = db.mock.calls.length;
    db
      .mockReturnValueOnce(chain({ first: preclaimedInvoice })) // claim read
      .mockReturnValueOnce(failingLookup); // queuedPayLinkText throws

    await expect(InvoiceService.claimInvoiceForSend('inv-1', { allowClaimed: true, adoptsQueuedInvoiceSend: true }))
      .rejects.toThrow('transient lookup failure');
    // The claim read, the failed lookup, nothing else — in particular no
    // second 'invoices' chain for a status re-stamp.
    expect(db.mock.calls.slice(before).map(([table]) => table)).toEqual(['invoices', 'sms_log']);
  });
});

// Codex round 15 P1 #4131: sendViaSMSAndEmail's restore decision keyed on
// the OVERALL `ok` (sms.ok || email.ok) — when email alone succeeded, the
// SMS-specific queue row this claim's adoption cancelled was never
// restored, even though the SMS leg itself never reached provider accept.
// The queue-restore decision must be per-channel, independent of the
// invoice claim release (which stays keyed on the overall `ok`).
describe('sendViaSMSAndEmail: the SMS queue restore decision is per-channel, not per-overall-ok', () => {
  const draftWithCustomer = { ...draftInvoice, customer_id: 'cust-1', scheduled_service_id: null };
  const accrualRow = { payer_statement_id: null, status: 'draft', total: 117, credit_applied: 0, scheduled_service_id: null };
  const CONSUMED_ROW = { id: 'sms-queued-1', scheduled_for: new Date('2026-09-11T09:00:00.000Z') };

  test('email ok + SMS fails (no phone on file): the consumed SMS queue row IS restored even though the send overall succeeds', async () => {
    jest.clearAllMocks();
    const sendingInvoice = { ...draftWithCustomer, status: 'sending' };
    const restoreQueueChain = chain();
    const fallback = chain();
    db
      .mockReturnValueOnce(chain({ first: accrualRow })) // accrual pre-check
      .mockReturnValueOnce(chain({ first: draftWithCustomer })) // outer claim read
      .mockReturnValueOnce(chain({ first: undefined })) // outer pre-claim queued check
      .mockReturnValueOnce(chain({ returning: [sendingInvoice] })) // outer claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // outer reconcile pre-consume check
      .mockReturnValueOnce(chain({ returning: [CONSUMED_ROW] })) // outer adoption consumes the pre-existing row
      .mockReturnValueOnce(chain({ first: undefined })) // outer strict re-check
      .mockReturnValueOnce(chain({ first: sendingInvoice })) // inner sendViaSMS's own claim read (allowClaimed)
      .mockReturnValueOnce(chain({ first: undefined })) // inner pre-check
      .mockReturnValueOnce(chain({ returning: [] })) // inner consume — nothing left, outer already took it
      .mockReturnValueOnce(chain({ first: undefined })) // inner strict re-check
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: null } })) // customer lookup — NO PHONE, the SMS leg fails
      .mockReturnValueOnce(chain({ first: sendingInvoice })) // second-channel collectibility recheck
      .mockReturnValueOnce(restoreQueueChain) // THE TARGET: restore before releasing/finalizing the invoice claim
      .mockReturnValueOnce(chain()) // outer finalize update (email succeeded)
      .mockReturnValue(fallback); // lead conversion / follow-ups / anything else

    sendInvoiceEmail.mockResolvedValueOnce({ ok: true, payUrl: 'https://pay.example/xyz' });

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(result.email.ok).toBe(true);
    expect(result.sms.ok).toBe(false);
    // The invoice claim released normally (finalized 'sent') — unchanged.
    // The SMS-specific queue obligation was restored despite that.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    const restoreUpdate = restoreQueueChain.update.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    expect(restoreUpdate.scheduled_for).toBeUndefined();
  });

  test('email ok + SMS fails: a transient queue-restore failure does not finalize/release the invoice claim', async () => {
    jest.clearAllMocks();
    const sendingInvoice = { ...draftWithCustomer, status: 'sending' };
    const restoreErr = new Error('transient queue restore failure');
    db
      .mockReturnValueOnce(chain({ first: accrualRow }))
      .mockReturnValueOnce(chain({ first: draftWithCustomer }))
      .mockReturnValueOnce(chain({ first: undefined }))
      .mockReturnValueOnce(chain({ returning: [sendingInvoice] }))
      .mockReturnValueOnce(chain({ first: undefined }))
      .mockReturnValueOnce(chain({ returning: [CONSUMED_ROW] }))
      .mockReturnValueOnce(chain({ first: undefined }))
      .mockReturnValueOnce(chain({ first: sendingInvoice }))
      .mockReturnValueOnce(chain({ first: undefined }))
      .mockReturnValueOnce(chain({ returning: [] }))
      .mockReturnValueOnce(chain({ first: undefined }))
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: null } }))
      .mockReturnValueOnce(chain({ first: sendingInvoice }))
      .mockReturnValueOnce(throwingChain(restoreErr));

    sendInvoiceEmail.mockResolvedValueOnce({ ok: true, payUrl: 'https://pay.example/xyz' });

    await expect(InvoiceService.sendViaSMSAndEmail('inv-1', {}))
      .rejects.toMatchObject({ code: 'queued_sms_restore_failed' });
    expect(sendInvoiceEmail).toHaveBeenCalledTimes(1);
    // The failed queue update is the final DB operation. In particular, no
    // invoices finalize follows it and the durable 'sending' marker remains.
    expect(db.mock.calls.at(-1)[0]).toBe('sms_log');
    expect(db).toHaveBeenCalledTimes(14);
  });

  test('email ok + SMS accepted by the provider: the consumed SMS queue row stays cancelled', async () => {
    jest.clearAllMocks();
    const sendingInvoice = { ...draftWithCustomer, status: 'sending' };
    const fallback = chain({ first: { ...sendingInvoice, status: 'sent' } });
    db
      .mockReturnValueOnce(chain({ first: accrualRow })) // accrual pre-check
      .mockReturnValueOnce(chain({ first: draftWithCustomer })) // outer claim read
      .mockReturnValueOnce(chain({ first: undefined })) // outer pre-claim queued check
      .mockReturnValueOnce(chain({ returning: [sendingInvoice] })) // outer claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // outer reconcile pre-consume check
      .mockReturnValueOnce(chain({ returning: [CONSUMED_ROW] })) // outer adoption consumes the pre-existing row
      .mockReturnValueOnce(chain({ first: undefined })) // outer strict re-check
      .mockReturnValueOnce(chain({ first: sendingInvoice })) // inner sendViaSMS's own claim read
      .mockReturnValueOnce(chain({ first: undefined })) // inner pre-check
      .mockReturnValueOnce(chain({ returning: [] })) // inner consume — nothing left
      .mockReturnValueOnce(chain({ first: undefined })) // inner strict re-check
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: '+19415550123', first_name: 'Pat' } })) // customer lookup — has a phone
      .mockReturnValue(fallback); // provider-accepted send's own finalize, activity_log, follow-ups, the outer finalize, lead conversion — none of them matter here

    sendCustomerMessage.mockResolvedValueOnce({ sent: true });
    sendInvoiceEmail.mockResolvedValueOnce({ ok: true, payUrl: 'https://pay.example/xyz' });

    const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

    expect(result.ok).toBe(true);
    expect(result.sms.ok).toBe(true);
    expect(result.email.ok).toBe(true);
    // Nothing anywhere in the flow ever restored the consumed row to
    // 'scheduled' — the SMS leg itself delivered, so the row correctly
    // stays cancelled regardless of the email leg's own outcome.
    const anyRestoredToScheduled = fallback.update.mock.calls.some((c) => c[0]?.status === 'scheduled');
    expect(anyRestoredToScheduled).toBe(false);
  });

  test('round-17 P1 (#4131 finding 2): SMS fails, email is provider-accepted, and the invoice finalize update THROWS — the consumed SMS queue row was restored first, and the throw still propagates', async () => {
    jest.clearAllMocks();
    const sendingInvoice = { ...draftWithCustomer, status: 'sending' };
    const restoreQueueChain = chain();
    const fallback = chain();
    const finalizeErr = new Error('synthetic finalize DB failure (post-provider-accept)');
    db
      .mockReturnValueOnce(chain({ first: accrualRow })) // accrual pre-check
      .mockReturnValueOnce(chain({ first: draftWithCustomer })) // outer claim read
      .mockReturnValueOnce(chain({ first: undefined })) // outer pre-claim queued check
      .mockReturnValueOnce(chain({ returning: [sendingInvoice] })) // outer claim flip
      .mockReturnValueOnce(chain({ first: undefined })) // outer reconcile pre-consume check
      .mockReturnValueOnce(chain({ returning: [CONSUMED_ROW] })) // outer adoption consumes the pre-existing row
      .mockReturnValueOnce(chain({ first: undefined })) // outer strict re-check
      .mockReturnValueOnce(chain({ first: sendingInvoice })) // inner sendViaSMS's own claim read (allowClaimed)
      .mockReturnValueOnce(chain({ first: undefined })) // inner pre-check
      .mockReturnValueOnce(chain({ returning: [] })) // inner consume — nothing left, outer already took it
      .mockReturnValueOnce(chain({ first: undefined })) // inner strict re-check
      .mockReturnValueOnce(chain({ first: { id: 'cust-1', phone: null } })) // customer lookup — NO PHONE, the SMS leg fails
      .mockReturnValueOnce(chain({ first: sendingInvoice })) // second-channel collectibility recheck
      .mockReturnValueOnce(restoreQueueChain) // queue obligation is durable before claim release/finalize
      .mockReturnValueOnce(throwingChain(finalizeErr)) // outer finalize update throws AFTER email already delivered
      .mockReturnValue(fallback);

    sendInvoiceEmail.mockResolvedValueOnce({ ok: true, payUrl: 'https://pay.example/xyz' });

    await expect(InvoiceService.sendViaSMSAndEmail('inv-1', {})).rejects.toThrow(finalizeErr);

    // The promised SMS delivery was recovered before the finalize that
    // would have flipped the invoice to 'sent' never completed — a stale
    // 'sending' invoice is a separate, already-owned problem (stale-claim
    // recovery); losing the customer's queued pay-link text is not.
    expect(restoreQueueChain.whereIn.mock.calls[0]).toEqual(['id', ['sms-queued-1']]);
    const restoreUpdate = restoreQueueChain.update.mock.calls[0][0];
    expect(restoreUpdate.status).toBe('scheduled');
    expect(restoreUpdate.scheduled_for).toBeUndefined();
  });
});
