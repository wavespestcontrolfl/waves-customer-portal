// processScheduledSends vs the 8AM-8PM ET send window (codex r2 P1): a
// scheduled invoice due outside the window must move to the window open
// WITHOUT burning one of its five scheduled_send_attempts, and without
// letting the email leg go out alone (which would finalize the invoice and
// strand the SMS pay link with no retry rail). Two layers under test:
//   1. the pre-claim guard — outside the window the row is deferred before
//      sendViaSMSAndEmail is ever called;
//   2. the hold-aware failure branch — a QUIET_HOURS_HOLD that slipped past
//      the guard (19:59→20:01 race) reschedules at nextAllowedAt instead of
//      incrementing the attempt counter.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  fn.transaction = jest.fn(async (callback) => callback(fn));
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(),
}));
jest.mock('../services/messaging/send-window', () => ({
  isWithinSendWindowET: jest.fn(),
  nextSendWindowOpenET: jest.fn(),
}));
jest.mock('../services/invoice-email', () => ({
  sendInvoiceEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19413180000'),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const {
  isWithinSendWindowET,
  nextSendWindowOpenET,
} = require('../services/messaging/send-window');
const InvoiceService = require('../services/invoice');

const WINDOW_OPEN = new Date('2026-08-07T12:00:00.000Z'); // 8:00 AM ET

function chain({ rows, returning, first, updateCount = 1 } = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'forUpdate', 'update', 'insert']) {
    q[m] = jest.fn(() => q);
  }
  q.select = jest.fn(async () => rows || []);
  q.returning = jest.fn(async () => returning || []);
  q.first = jest.fn(async () => first);
  // Awaiting the chain itself resolves like knex: an update chain resolves
  // its affected-row count, anything else the row set.
  q.then = (resolve) => Promise.resolve(q.update.mock.calls.length ? updateCount : (rows || [])).then(resolve);
  return q;
}

// The queue-adoption reconcile (reconcileQueuedSendUnderClaim) runs on
// every claim with adoptsQueuedInvoiceSend: true — every fresh claim, and
// every allowClaimed one sendViaSMSAndEmail takes — right after the claim
// itself (the status flip for a fresh claim; the current-row read for an
// allowClaimed one). With no queued invoice_send_deferred row in these
// fixtures, it touches sms_log twice (its own live-queue check, then the
// strict re-check after consuming) and takes one 'invoices' row-lock in
// between (the adoption transaction's owned-row check) — always in this
// order, always resolving to "nothing queued, nothing to consume". Spread
// this directly after the claim in every test below that now exercises
// the real claimInvoiceForSend/sendViaSMSAndEmail path.
const adoptionNoOp = () => [
  chain({ first: undefined }), // reconcileQueuedSendUnderClaim's own live-queue check
  chain({ first: { id: 'inv-1' } }), // adoption transaction: owned-row check
  chain({ returning: [] }), // consumeQueuedInvoiceSend: nothing to consume
  chain({ first: undefined }), // strict re-check after consuming
];
// A FRESH (non-preclaimed) claim additionally runs queuedPayLinkText as a
// pre-claim courtesy check, BEFORE the status flip.
const preClaimQueueCheck = () => chain({ first: undefined });
// Queues each chain in order via mockReturnValueOnce — flattens any nested
// arrays (e.g. the spread of adoptionNoOp()) so callers can mix single
// chains and helper arrays freely.
function queueMocks(mockFn, chains) {
  for (const c of chains.flat()) mockFn.mockReturnValueOnce(c);
  return mockFn;
}

const dueRow = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-1042',
  scheduled_send_attempts: 2,
  scheduled_request_review: false,
  scheduled_review_delay_minutes: null,
  payer_id: null,
  customer_id: 'cust-1',
};

const claimedRow = (overrides = {}) => ({
  id: 'inv-1',
  scheduled_request_review: false,
  scheduled_review_delay_minutes: null,
  send_claim_token: 'claim-1',
  ...overrides,
});

describe('processScheduledSends send-window handling', () => {
  let sendSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation((gate) => gate === 'smsSendWindow');
    nextSendWindowOpenET.mockReturnValue(WINDOW_OPEN);
    sendSpy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail');
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  test('outside the window: due row defers to the window open without claiming or burning an attempt', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const phoneLookup = chain({ first: { phone: '+19415550123' } });
    const prefsLookup = chain({ first: { sms_enabled: true } });
    const deferUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(prefsLookup)
      .mockReturnValueOnce(deferUpdate);

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 1 });
    const updateArgs = deferUpdate.update.mock.calls[0][0];
    expect(updateArgs.scheduled_send_at).toEqual(WINDOW_OPEN);
    expect(updateArgs.scheduled_send_attempts).toBeUndefined();
    expect(String(updateArgs.scheduled_send_error)).toContain('QUIET_HOURS_HOLD');
    // The deferral must mirror the claim predicates so a concurrent admin
    // reschedule (new scheduled_send_at) is never overwritten.
    expect(deferUpdate.whereNotNull).toHaveBeenCalledWith('scheduled_send_at');
    expect(deferUpdate.where).toHaveBeenCalledWith('scheduled_send_at', '<=', expect.any(Date));
  });

  test('a concurrent reschedule (0 rows affected) is not counted as deferred', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const phoneLookup = chain({ first: { phone: '+19415550123' } });
    const prefsLookup = chain({ first: { sms_enabled: true } });
    const deferUpdate = chain({ updateCount: 0 });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(prefsLookup)
      .mockReturnValueOnce(deferUpdate);

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
  });

  test('outside the window: an SMS-opted-out customer is emailed at the requested time, not deferred', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const phoneLookup = chain({ first: { phone: '+19415550123' } });
    const prefsLookup = chain({ first: { sms_enabled: false } });
    const claim = chain({ returning: [claimedRow()] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(prefsLookup)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'SMS_OPTED_OUT' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('outside the window: an email-only invoice (third-party payer) sends at its requested time', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [{ ...dueRow, payer_id: 'payer-9' }] });
    const claim = chain({ returning: [claimedRow()] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'payer_billed' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('outside the window: a customer with no phone is emailed at the requested time, not deferred', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const phoneLookup = chain({ first: { phone: null } });
    const claim = chain({ returning: [claimedRow()] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'no_phone' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('inside the window: the send proceeds', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [claimedRow()] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('a queued-text refusal for one preclaimed invoice defers its exact claim and the batch continues', async () => {
    // reconcileQueuedSendUnderClaim throws queued_pay_link for a preclaimed
    // invoice when a deferred text still owns the pay link — the worker
    // must give that EXACT claim back to the queue (scheduled, past the
    // text's own slot) and keep processing the rest of the batch, not let
    // the refusal escape and abort every invoice behind it.
    isWithinSendWindowET.mockReturnValue(true);
    const dueRowB = { ...dueRow, id: 'inv-2', invoice_number: 'WPC-2026-1043' };
    const scheduledFor = new Date('2026-08-07T13:00:00.000Z'); // later than now + 10min
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow, dueRowB] });
    const claimA = chain({ returning: [claimedRow()] });
    const deferralUpdate = chain();
    const claimB = chain({ returning: [claimedRow({ id: 'inv-2', send_claim_token: 'claim-2' })] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claimA)
      .mockReturnValueOnce(deferralUpdate)
      .mockReturnValueOnce(claimB);
    sendSpy
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window'), {
          code: 'queued_pay_link', scheduledFor,
        });
      })
      .mockImplementationOnce(async () => ({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 }));

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(sendSpy).toHaveBeenCalledWith('inv-2', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-2' }));
    // The exact claim (matched by ITS OWN token) went back to 'scheduled',
    // deferred past the queued text's slot, never finalized or failed.
    expect(deferralUpdate.where).toHaveBeenCalledWith({ id: 'inv-1', status: 'sending', send_claim_token: 'claim-1' });
    const deferralPayload = deferralUpdate.update.mock.calls[0][0];
    expect(deferralPayload.status).toBe('scheduled');
    expect(deferralPayload.send_claim_token).toBeNull();
    expect(deferralPayload.scheduled_send_at.getTime()).toBeGreaterThanOrEqual(scheduledFor.getTime());
    // The second invoice, behind the refused one in the batch, still sent.
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 1 });
  });

  test('a send held after an unrestorable adopted text is neither restored nor requeued, and the batch continues', async () => {
    // sendViaSMSAndEmail reports ADOPTED_QUEUE_RESTORE_FAILED (ok: false,
    // deliveryHeld: true) when no channel delivered and the adopted queued
    // text could not be given back — the worker must retain that exact
    // claim for review (like an unverified outcome), never restore it to
    // 'scheduled' (which would requeue a send over an unrestored text) nor
    // let the hold abort the rest of the batch.
    isWithinSendWindowET.mockReturnValue(true);
    const dueRowB = { ...dueRow, id: 'inv-2', invoice_number: 'WPC-2026-1043' };
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow, dueRowB] });
    const claimA = chain({ returning: [claimedRow()] });
    const claimB = chain({ returning: [claimedRow({ id: 'inv-2', send_claim_token: 'claim-2' })] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claimA)
      .mockReturnValueOnce(claimB);
    sendSpy
      .mockResolvedValueOnce({
        ok: false, code: 'ADOPTED_QUEUE_RESTORE_FAILED', deliveryHeld: true,
        sms: { ok: false }, email: { ok: false }, creditApplied: 0,
      })
      .mockResolvedValueOnce({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-1' }));
    expect(sendSpy).toHaveBeenCalledWith('inv-2', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-2' }));
    // The held invoice's claim flip is the ONLY 'invoices' write for it —
    // no requeue/restore update follows. Only 4 db() calls total (stale
    // recovery, due query, and one claim flip per invoice); a 5th
    // (unqueued) call would throw and fail this test outright.
    expect(db).toHaveBeenCalledTimes(4);
    expect(claimA.update).toHaveBeenCalledTimes(1);
    // The second invoice, behind the held one, still sent — held invoices
    // are not counted in the {sent, failed, deferred} tuple this returns.
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('a non-queue error from the preclaimed send still propagates', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [claimedRow()] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('synthetic failure'), { code: 'boom' });
    });

    await expect(InvoiceService.processScheduledSends()).rejects.toMatchObject({ code: 'boom' });
  });

  test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD'])('%s reschedules at nextAllowedAt without spending an attempt', async (code) => {
    isWithinSendWindowET.mockReturnValue(true); // guard passed at 19:59...
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [claimedRow()] });
    const holdUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(holdUpdate);
    // ...but the validator saw 20:01 (window closed mid-flight).
    sendSpy.mockResolvedValue({
      ok: false,
      sms: {
        ok: false,
        code,
        error: `payment-link delivery blocked: ${code}`,
        deferred: true,
        nextAllowedAt: WINDOW_OPEN.toISOString(),
      },
      email: { ok: false, error: 'no email on file' },
      creditApplied: 0,
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 1 });
    const updateArgs = holdUpdate.update.mock.calls[0][0];
    expect(updateArgs.status).toBe('scheduled');
    expect(updateArgs.scheduled_send_at).toEqual(WINDOW_OPEN);
    expect(updateArgs.scheduled_send_attempts).toBeUndefined();
  });

  test.each([0, 2, 4])('a temporary App failure after %s attempts spends an attempt and applies backoff', async (attempts) => {
    isWithinSendWindowET.mockReturnValue(true);
    const update = chain();
    db.mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [{ ...dueRow, scheduled_send_attempts: attempts }] }))
      .mockReturnValueOnce(chain({ returning: [claimedRow()] }))
      .mockReturnValueOnce(update);
    sendSpy.mockResolvedValue({ ok: false, creditApplied: 0,
      sms: { code: 'APP_PROVIDER_RETRY', deferred: true, retryAfterMs: 900000, nextAllowedAt: new Date(Date.now() + 900000).toISOString() },
    });
    const jitter = jest.spyOn(Math, 'random').mockReturnValue(0);
    const startedAt = Date.now();
    try {
      expect(await InvoiceService.processScheduledSends()).toEqual({ sent: 0, failed: 1, deferred: 0 });
      expect(update.update.mock.calls[0][0]).toMatchObject({ status: 'scheduled', scheduled_send_attempts: attempts + 1 });
      expect(update.update.mock.calls[0][0].scheduled_send_at.getTime()).toBeGreaterThanOrEqual(startedAt + 900000 * (2 ** attempts));
    } finally { jitter.mockRestore(); }
  });

  test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY'])('scheduled delivery held by %s skips email so the invoice cannot finalize', async (code) => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockImplementation(async () => {
      const err = new Error('payment-link SMS blocked: QUIET_HOURS_HOLD');
      err.code = code;
      err.deferred = true;
      err.nextAllowedAt = WINDOW_OPEN.toISOString();
      if (code === 'APP_PROVIDER_RETRY') err.retryAfterMs = 900000;
      throw err;
    });
    try {
      const sendingInvoice = {
        id: 'inv-1',
        status: 'sending',
        send_claim_token: 'claim-1',
        customer_id: 'cust-1',
        payer_id: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      };
      queueMocks(db, [
        chain({ first: { payer_statement_id: null } }), // accrual pre-check
        chain({ first: sendingInvoice }), // claimInvoiceForSend read
        adoptionNoOp(),
        chain({ first: { id: 'inv-1' } }), // restoreSendClaim's owned-row check
      ]);

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', { allowClaimed: true, claimToken: 'claim-1' });

      expect(sendInvoiceEmail).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.sms.code).toBe(code);
      expect(result.sms.nextAllowedAt).toBe(WINDOW_OPEN.toISOString());
      if (code === 'APP_PROVIDER_RETRY') expect(result.sms.retryAfterMs).toBe(900000);
      expect(result.email.code).toBe(code);
    } finally {
      smsSpy.mockRestore();
    }
  });

  test('combined terminal refusal skips email and delegates exact-token cleanup to its claim owner', async () => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const terminal = Object.assign(new Error('linked visit cancelled'), {
      code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent',
    });
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockRejectedValue(terminal);
    const voidSpy = jest.spyOn(InvoiceService, 'voidOpenInvoicesForCancelledService').mockResolvedValue(['inv-1']);
    const draftInvoice = { ...dueRow, status: 'draft' };
    queueMocks(db, [
      chain({ first: { payer_statement_id: null } }),
      chain({ first: draftInvoice }),
      preClaimQueueCheck(),
      chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }),
      adoptionNoOp(),
    ]);
    try {
      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL' });
      expect(sendInvoiceEmail).not.toHaveBeenCalled();
      expect(voidSpy).toHaveBeenCalledWith('svc-1', {
        invoiceId: 'inv-1', refusedClaimToken: expect.any(String),
      });
    } finally {
      smsSpy.mockRestore();
      voidSpy.mockRestore();
    }
  });

  test('terminal email refusal after an uncertain SMS keeps the claim for review', async () => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const uncertain = Object.assign(new Error('provider outcome unknown'), {
      code: 'INVOICE_PROVIDER_OUTCOME_UNCERTAIN', deliveryOutcome: 'uncertain',
    });
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockRejectedValue(uncertain);
    sendInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'visit cancelled',
      code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' });
    const voidSpy = jest.spyOn(InvoiceService, 'voidOpenInvoicesForCancelledService');
    const draftInvoice = { ...dueRow, status: 'draft' };
    queueMocks(db, [
      chain({ first: { payer_statement_id: null } }),
      chain({ first: draftInvoice }),
      preClaimQueueCheck(),
      chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }),
      adoptionNoOp(),
    ]);
    try {
      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN' });
      expect(voidSpy).not.toHaveBeenCalled();
      expect(db).toHaveBeenCalledTimes(8);
    } finally {
      smsSpy.mockRestore();
      voidSpy.mockRestore();
    }
  });

  test('an uncertain held SMS is not queued and a definite email failure retains the claim', async () => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const uncertain = Object.assign(new Error('provider outcome unknown'), {
      code: 'PUSH_IN_FLIGHT', deliveryOutcome: 'uncertain', deferred: true,
      nextAllowedAt: WINDOW_OPEN.toISOString(), smsBody: 'Pay at https://pay.example/abc',
      toPhone: '+19415550123',
    });
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockRejectedValue(uncertain);
    sendInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'SMTP rejected', deliveryOutcome: 'not_sent' });
    const draftInvoice = { ...dueRow, status: 'draft' };
    queueMocks(db, [
      chain({ first: { payer_statement_id: null } }),
      chain({ first: draftInvoice }),
      preClaimQueueCheck(),
      chain({ returning: [{ ...draftInvoice, status: 'sending' }] }),
      adoptionNoOp(),
    ]);
    try {
      await expect(InvoiceService.sendViaSMSAndEmail('inv-1')).resolves.toMatchObject({
        ok: false, code: 'INVOICE_DELIVERY_OUTCOME_UNCERTAIN',
      });
      expect(db).toHaveBeenCalledTimes(8);
    } finally {
      smsSpy.mockRestore();
    }
  });

  test('terminal email refusal keeps a claim when the held SMS adopted a live queued delivery', async () => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const held = Object.assign(new Error('payment-link SMS held'), {
      code: 'QUIET_HOURS_HOLD', deliveryOutcome: 'not_sent', deferred: true,
      nextAllowedAt: WINDOW_OPEN.toISOString(), smsBody: 'Pay at https://pay.example/abc',
      toPhone: '+19415550123',
    });
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockRejectedValue(held);
    sendInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'visit cancelled',
      code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' });
    const voidSpy = jest.spyOn(InvoiceService, 'voidOpenInvoicesForCancelledService');
    const draftInvoice = { ...dueRow, status: 'draft' };
    queueMocks(db, [
      chain({ first: { payer_statement_id: null } }),
      chain({ first: draftInvoice }),
      preClaimQueueCheck(),
      chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }),
      adoptionNoOp(),
      chain({ first: { id: 'queued-sms-1' } }),
    ]);
    try {
      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN',
        sms: { scheduled: true } });
      expect(voidSpy).not.toHaveBeenCalled();
      expect(db).toHaveBeenCalledTimes(9);
    } finally {
      smsSpy.mockRestore();
      voidSpy.mockRestore();
    }
  });

  test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD', 'APP_PROVIDER_RETRY'])('direct delivery held by %s is queued before the email sends', async (code) => {
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockImplementation(async () => {
      const err = new Error('payment-link SMS blocked: QUIET_HOURS_HOLD');
      err.code = code;
      err.deferred = true;
      err.nextAllowedAt = WINDOW_OPEN.toISOString();
      err.smsBody = 'Hi Pat, your invoice is ready: https://pay.example/abc';
      err.toPhone = '+19415550123';
      throw err;
    });
    try {
      const draftInvoice = {
        id: 'inv-1',
        status: 'draft',
        customer_id: 'cust-1',
        payer_id: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      };
      const requeueInsert = chain();
      queueMocks(db, [
        chain({ first: { payer_statement_id: null } }), // accrual pre-check
        chain({ first: draftInvoice }), // claim read
        preClaimQueueCheck(),
        chain({ returning: [{ ...draftInvoice, status: 'sending' }] }), // claim update
        adoptionNoOp(),
        chain({ first: undefined }), // requeue idempotency check (no prior row)
        requeueInsert, // held-SMS scheduled-rail insert
        chain(), // finalize update
        chain({ first: null }), // lead-conversion read (permissive)
      ]);

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

      expect(sendInvoiceEmail).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.sms.scheduled).toBe(true);
      const queuedRow = requeueInsert.insert.mock.calls[0][0];
      expect(queuedRow.status).toBe('scheduled');
      expect(queuedRow.scheduled_for).toEqual(WINDOW_OPEN);
      expect(queuedRow.message_body).toContain('https://pay.example/abc');
    } finally {
      smsSpy.mockRestore();
    }
  });

  test('sendViaSMSAndEmail (direct caller): a FAILED held-SMS requeue skips the email leg so the claim stays retryable (r16)', async () => {
    // If the scheduled rail never took ownership of the held text, an
    // email-alone success would finalize the invoice and clear the send
    // claim — permanently losing the requested SMS pay-link leg. The whole
    // send must fail (claim restored) so the caller's retry re-queues.
    const { sendInvoiceEmail } = require('../services/invoice-email');
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS').mockImplementation(async () => {
      const err = new Error('payment-link SMS blocked: QUIET_HOURS_HOLD');
      err.code = 'QUIET_HOURS_HOLD';
      err.deferred = true;
      err.nextAllowedAt = WINDOW_OPEN.toISOString();
      err.smsBody = 'Hi Pat, your invoice is ready: https://pay.example/abc';
      err.toPhone = '+19415550123';
      throw err;
    });
    try {
      const draftInvoice = {
        id: 'inv-1',
        status: 'draft',
        customer_id: 'cust-1',
        payer_id: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      };
      const failingInsert = chain();
      failingInsert.insert = jest.fn(() => { throw new Error('sms_log insert failed'); });
      const restoreChain = chain();
      restoreChain.catch = jest.fn(() => Promise.resolve());
      queueMocks(db, [
        chain({ first: { payer_statement_id: null } }), // accrual pre-check
        chain({ first: draftInvoice }), // claim read
        preClaimQueueCheck(),
        chain({ returning: [{ ...draftInvoice, status: 'sending' }] }), // claim update
        adoptionNoOp(),
        chain({ first: undefined }), // requeue idempotency check (no prior row)
        failingInsert, // held-SMS scheduled-rail insert THROWS
      ]);
      db.mockReturnValue(restoreChain); // restoreSendClaim + anything after

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

      expect(sendInvoiceEmail).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.email.code).toBe('QUIET_HOURS_HOLD');
      expect(result.sms.scheduled).toBeUndefined();
    } finally {
      smsSpy.mockRestore();
      db.mockReset();
    }
  });

  test('an ordinary failure still increments the attempt counter', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [claimedRow()] });
    const failUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(failUpdate);
    sendSpy.mockResolvedValue({
      ok: false,
      sms: { ok: false, error: 'Customer has no phone number' },
      email: { ok: false, error: 'no email on file' },
      creditApplied: 0,
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const updateArgs = failUpdate.update.mock.calls[0][0];
    expect(updateArgs.scheduled_send_attempts).toBe(3);
  });

  test('scheduled terminal refusal neither restores the queue nor spends an attempt', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const terminalDue = { ...dueRow, scheduled_service_id: 'svc-1' };
    db.mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [terminalDue] }))
      .mockReturnValueOnce(chain({ returning: [claimedRow()] }));
    sendSpy.mockResolvedValue({ ok: false, code: 'INVOICE_VISIT_TERMINAL',
      sms: { code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' },
      email: { code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' } });
    const voidSpy = jest.spyOn(InvoiceService, 'voidOpenInvoicesForCancelledService').mockResolvedValue(['inv-1']);
    try {
      expect(await InvoiceService.processScheduledSends()).toEqual({ sent: 0, failed: 0, deferred: 0 });
      expect(voidSpy).toHaveBeenCalledWith('svc-1', {
        invoiceId: 'inv-1', refusedClaimToken: 'claim-1',
      });
      expect(db).toHaveBeenCalledTimes(3);
    } finally { voidSpy.mockRestore(); }
  });

  test('scheduled delivery uncertainty retains the claim without spending an attempt', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    db.mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [dueRow] }))
      .mockReturnValueOnce(chain({ returning: [claimedRow()] }));
    sendSpy.mockResolvedValue({ ok: false, code: 'INVOICE_DELIVERY_OUTCOME_UNCERTAIN',
      sms: { error: 'provider outcome unknown', deliveryOutcome: 'uncertain' },
      email: { error: 'SMTP rejected', deliveryOutcome: 'not_sent' }, creditApplied: 25 });

    expect(await InvoiceService.processScheduledSends()).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(db).toHaveBeenCalledTimes(3);
  });

  // #4131 slice 4: zero-due visit invoices are settled or deferred BEFORE
  // the worker ever claims them — neither outcome may burn one of the five
  // scheduled_send_attempts (retry fairness).
  describe('zero-due visit invoice pre-claim check (#4131 slice 4)', () => {
    let settleSpy;

    beforeEach(() => {
      settleSpy = jest.spyOn(InvoiceService, 'settleZeroBalance');
    });

    afterEach(() => settleSpy.mockRestore());

    function zeroDueDueRow(overrides = {}) {
      return { ...dueRow, scheduled_service_id: 'svc-1', status: 'scheduled', total: 100, credit_applied: 100, ...overrides };
    }

    test('settles and skips the row without ever claiming or sending', async () => {
      const staleRecovery = chain();
      const dueQuery = chain({ rows: [zeroDueDueRow()] });
      db.mockReturnValueOnce(staleRecovery).mockReturnValueOnce(dueQuery);
      settleSpy.mockResolvedValue({ settled: true, invoice: { ...zeroDueDueRow(), status: 'prepaid' } });

      const result = await InvoiceService.processScheduledSends();

      expect(settleSpy).toHaveBeenCalledWith('inv-1', expect.anything());
      expect(sendSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
      // Only the stale-recovery sweep and the due read — no claim flip.
      expect(db).toHaveBeenCalledTimes(2);
    });

    // Pre-push audit P1: this pre-claim path used to name its success
    // settled_by_deposit while the throw-shaped under-claim path (and
    // firstDeliveryOutcome, and the client) all used settled_zero_due —
    // and this pre-claim path is the COMMON case, so an admin using
    // sendViaSMSAndEmail directly (POST /:id/send with no prior claim)
    // would see the mismatched name.
    test('sendViaSMSAndEmail\'s own pre-claim settle resolves settled_zero_due: true, not the old settled_by_deposit name', async () => {
      const zeroDueAccrual = {
        payer_statement_id: null, visit_completion_packet_id: null, payer_id: null,
        status: 'draft', scheduled_service_id: 'svc-1', total: 100, credit_applied: 100,
      };
      db.mockReturnValueOnce(chain({ first: zeroDueAccrual }));
      settleSpy.mockResolvedValue({ settled: true, invoice: { id: 'inv-1', status: 'prepaid' } });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {});

      expect(result).toMatchObject({ ok: true, settled_zero_due: true });
      expect(result.settled_by_deposit).toBeUndefined();
    });

    test('a settlement refused right now consumes an attempt AS AN ORDINARY FAILURE, and the batch continues', async () => {
      // Ruling (pre-push audit P1, #4131 slice 4): a settlement refusal is
      // a failure to settle, not a window hold — it rides the same
      // five-attempt cap and terminal-failure reporting as any other send
      // failure, or a permanently unsettleable invoice loops forever.
      isWithinSendWindowET.mockReturnValue(true);
      const dueRowB = { ...dueRow, id: 'inv-2', invoice_number: 'WPC-2026-1043' };
      const staleRecovery = chain();
      const dueQuery = chain({ rows: [zeroDueDueRow({ scheduled_send_attempts: 1 }), dueRowB] });
      const failUpdate = chain();
      const claimB = chain({ returning: [claimedRow({ id: 'inv-2', send_claim_token: 'claim-2' })] });
      db
        .mockReturnValueOnce(staleRecovery)
        .mockReturnValueOnce(dueQuery)
        .mockReturnValueOnce(failUpdate)
        .mockReturnValueOnce(claimB);
      settleSpy.mockResolvedValue({ settled: false, reason: 'invoice_delivery_in_flight', invoice: null });
      sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

      const result = await InvoiceService.processScheduledSends();

      expect(sendSpy).not.toHaveBeenCalledWith('inv-1', expect.anything());
      expect(sendSpy).toHaveBeenCalledWith('inv-2', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-2' }));
      const updateArgs = failUpdate.update.mock.calls[0][0];
      // Atomic SQL increment (pre-push audit P1) — computed server-side,
      // not from this closure's stale in-memory count. db.raw is mocked
      // to return its SQL text verbatim in this suite.
      expect(updateArgs.scheduled_send_attempts).toBe('COALESCE(scheduled_send_attempts, 0) + 1');
      expect(updateArgs.scheduled_send_error).toMatch(/could not be settled yet/);
      expect(result).toEqual({ sent: 1, failed: 1, deferred: 0 });
    });

    test('a race-window zero-due refusal surfacing through a PRECLAIMED send is treated as an ordinary retryable failure, not a crash', async () => {
      // Models the rare race the pre-claim check above cannot close: the
      // retotal lands strictly between that read and claimDueScheduledInvoiceForSend's
      // own flip. sendViaSMSAndEmail's nested claim re-check throws this
      // marked deliveryNeverAttempted; the worker must not let it propagate
      // and abort the whole batch (matches the existing "a non-queue error
      // still propagates" contract for anything NOT marked this way).
      isWithinSendWindowET.mockReturnValue(true);
      const staleRecovery = chain();
      const dueQuery = chain({ rows: [dueRow] });
      const claim = chain({ returning: [claimedRow()] });
      const failUpdate = chain();
      db
        .mockReturnValueOnce(staleRecovery)
        .mockReturnValueOnce(dueQuery)
        .mockReturnValueOnce(claim)
        .mockReturnValueOnce(failUpdate);
      sendSpy.mockImplementationOnce(async () => {
        throw Object.assign(new Error('Nothing is due on this invoice'), {
          code: 'zero_due', deliveryNeverAttempted: true,
        });
      });

      const result = await InvoiceService.processScheduledSends();

      expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
      const updateArgs = failUpdate.update.mock.calls[0][0];
      expect(updateArgs.status).toBe('scheduled');
      expect(updateArgs.scheduled_send_attempts).toBe(dueRow.scheduled_send_attempts + 1);
    });

    test('an UNEXPECTED error from the preclaimed zero-due re-check (not tagged deliveryNeverAttempted) propagates instead of retrying silently', async () => {
      // Pre-push audit P1: refuseZeroDuePreclaimedInvoice only tags a
      // RECOGNIZED outcome (zero_due / deposit_settlement_pending) —
      // anything else (a bug, a DB error inside settleZeroBalance) reaches
      // here unmarked and must hit the SAME "still propagates" contract as
      // any other unexpected preclaimed-send throw.
      isWithinSendWindowET.mockReturnValue(true);
      const staleRecovery = chain();
      const dueQuery = chain({ rows: [dueRow] });
      const claim = chain({ returning: [claimedRow()] });
      db
        .mockReturnValueOnce(staleRecovery)
        .mockReturnValueOnce(dueQuery)
        .mockReturnValueOnce(claim);
      sendSpy.mockImplementationOnce(async () => {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'unexpected_db_error' });
      });

      await expect(InvoiceService.processScheduledSends()).rejects.toMatchObject({ code: 'unexpected_db_error' });
    });

    test('an unexpected error in the zero-due pre-check fails only that row and the batch continues', async () => {
      // Round-0 audit P1 (f8f60207ec): the pre-claim zero-due check (BEFORE
      // any claim is ever taken) now runs inside a per-row try/catch — an
      // unexpected error (a DB fault, a bug in settleZeroBalance) must
      // isolate ONLY the row it happened on: an attempt is spent
      // best-effort so a persistent fault still meets the five-attempt
      // cap, and the loop moves on to the invoices behind it instead of
      // aborting (and thus delaying) the whole batch.
      isWithinSendWindowET.mockReturnValue(true);
      const dueRowB = { ...dueRow, id: 'inv-2', invoice_number: 'WPC-2026-1043' };
      const staleRecovery = chain();
      const dueQuery = chain({ rows: [zeroDueDueRow({ scheduled_send_attempts: 1 }), dueRowB] });
      const failUpdate = chain();
      const claimB = chain({ returning: [claimedRow({ id: 'inv-2', send_claim_token: 'claim-2' })] });
      db
        .mockReturnValueOnce(staleRecovery)
        .mockReturnValueOnce(dueQuery)
        .mockReturnValueOnce(failUpdate)
        .mockReturnValueOnce(claimB);
      const boom = new Error('connection terminated unexpectedly');
      settleSpy.mockRejectedValueOnce(boom);
      sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

      const result = await InvoiceService.processScheduledSends();

      // The batch RESOLVED — it never rejected over inv-1's failure.
      expect(sendSpy).not.toHaveBeenCalledWith('inv-1', expect.anything());
      // The second invoice, behind the failed one, still sent.
      expect(sendSpy).toHaveBeenCalledWith('inv-2', expect.objectContaining({ allowClaimed: true, claimToken: 'claim-2' }));
      const updateArgs = failUpdate.update.mock.calls[0][0];
      expect(updateArgs.scheduled_send_attempts).toBe('COALESCE(scheduled_send_attempts, 0) + 1');
      expect(updateArgs.scheduled_send_error).toMatch(/Zero-due check failed.*connection terminated unexpectedly/);
      expect(result).toEqual({ sent: 1, failed: 1, deferred: 0 });
    });
  });
});
