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
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => true),
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
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'update', 'insert', 'forUpdate', 'noWait']) {
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

const dueRow = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-1042',
  scheduled_send_attempts: 2,
  scheduled_request_review: false,
  scheduled_review_delay_minutes: null,
  payer_id: null,
  customer_id: 'cust-1',
};

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
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(prefsLookup)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'SMS_OPTED_OUT' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('outside the window: an email-only invoice (third-party payer) sends at its requested time', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [{ ...dueRow, payer_id: 'payer-9' }] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'payer_billed' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('outside the window: a customer with no phone is emailed at the requested time, not deferred', async () => {
    isWithinSendWindowET.mockReturnValue(false);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const phoneLookup = chain({ first: { phone: null } });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(phoneLookup)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: false, code: 'no_phone' }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('inside the window: the send proceeds', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

    const result = await InvoiceService.processScheduledSends();

    expect(sendSpy).toHaveBeenCalledWith('inv-1', expect.objectContaining({ allowClaimed: true }));
    expect(result).toEqual({ sent: 1, failed: 0, deferred: 0 });
  });

  test('a failed packet Bill-To recheck restores this worker\'s token-owned claim without spending an attempt', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const claimToken = 'ca2fdf33-5baa-4490-b24a-a4f1b6918234';
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null, send_claim_token: claimToken }] });
    const restore = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(restore);
    sendSpy.mockResolvedValue({
      ok: false,
      code: 'bill_to_fence_failed',
      sms: { ok: false, code: 'bill_to_fence_failed' },
      email: { ok: false, code: 'bill_to_fence_failed' },
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(restore.where).toHaveBeenCalledWith({ id: 'inv-1', status: 'sending', send_claim_token: claimToken });
    expect(restore.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled', send_claim_token: null }));
    expect(restore.update.mock.calls[0][0].scheduled_send_attempts).toBeUndefined();
    expect(restore.update.mock.calls[0][0].scheduled_send_at).toBeUndefined();
  });

  test.each(['QUIET_HOURS_HOLD', 'PUSH_IN_FLIGHT', 'APP_DELIVERY_HOLD'])('%s reschedules at nextAllowedAt without spending an attempt', async (code) => {
    isWithinSendWindowET.mockReturnValue(true); // guard passed at 19:59...
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
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
      .mockReturnValueOnce(chain({ returning: [{ id: 'inv-1' }] }))
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
        customer_id: 'cust-1',
        payer_id: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      };
      db
        .mockReturnValueOnce(chain({ first: { payer_statement_id: null } })) // accrual pre-check
        .mockReturnValueOnce(chain({ first: sendingInvoice })) // claimInvoiceForSend read
        // The preclaimed allowClaimed branch now reconciles the queue too
        // (Codex round 14 P1 #4131): pre-check (none live), consume
        // (nothing pre-existing to adopt), strict re-check (none live).
        .mockReturnValueOnce(chain({ first: undefined }))
        .mockReturnValueOnce(chain({ returning: [] }))
        .mockReturnValueOnce(chain({ first: undefined }));

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', { allowClaimed: true });

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
      db
        .mockReturnValueOnce(chain({ first: { payer_statement_id: null } })) // accrual pre-check
        .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
        .mockReturnValueOnce(chain({ first: undefined })) // completion pay-link replay check (none queued)
        .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim update
        .mockReturnValueOnce(chain({ first: undefined })) // replay re-check under the claim (none)
        .mockReturnValueOnce(chain({ returning: [] })) // adoption: consume the send's own scheduled held leg (none to cancel)
        .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
        .mockReturnValueOnce(chain({ first: undefined })) // requeue idempotency check (no prior row)
        .mockReturnValueOnce(requeueInsert) // held-SMS scheduled-rail insert
        .mockReturnValueOnce(chain({ first: { ...draftInvoice, status: 'sending' } })) // second-channel collectibility recheck
        .mockReturnValueOnce(chain()) // finalize update
        .mockReturnValueOnce(chain({ first: null })); // lead-conversion read (permissive)

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
      db
        .mockReturnValueOnce(chain({ first: { payer_statement_id: null } })) // accrual pre-check
        .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
        .mockReturnValueOnce(chain({ first: undefined })) // completion pay-link replay check (none queued)
        .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim update
        .mockReturnValueOnce(chain({ first: undefined })) // replay re-check under the claim (none)
        .mockReturnValueOnce(chain({ returning: [] })) // adoption: consume the send's own scheduled held leg (none to cancel)
        .mockReturnValueOnce(chain({ first: undefined })) // strict re-check after the consume (none live)
        .mockReturnValueOnce(chain({ first: undefined })) // requeue idempotency check (no prior row)
        .mockReturnValueOnce(failingInsert) // held-SMS scheduled-rail insert THROWS
        .mockReturnValue(restoreChain); // restoreSendClaim + anything after

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
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
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

  test.each([0, 100])('scheduled zero due (total %s) settles before delivery ownership and stays settled on later ticks', async (total) => {
    isWithinSendWindowET.mockReturnValue(true);
    const row = {
      ...dueRow, status: 'scheduled', total, credit_applied: total,
      scheduled_service_id: 'visit-1', scheduled_send_at: new Date('2026-08-06T12:00:00Z'),
    };
    let deliveryClaims = 0;
    const invoiceLocks = [];
    const previousTransaction = db.transaction;
    const stripeFence = jest.spyOn(require('../services/stripe'), 'assertNoInvoiceChargeReconciliationPending')
      .mockResolvedValue(undefined);
    const audit = jest.spyOn(require('../services/audit-log'), 'recordAuditEvent')
      .mockResolvedValue(undefined);
    db.mockReset();
    db.transaction = jest.fn(async (callback) => callback(db));
    db.mockImplementation((table) => {
      const q = chain();
      if (table !== 'invoices') {
        q.first.mockResolvedValue(table === 'scheduled_services'
          ? { id: 'visit-1', status: 'confirmed' }
          : table === 'customers' ? { id: 'cust-1' } : undefined);
        return q;
      }
      const filters = [];
      q.where.mockImplementation((field, value) => {
        if (typeof field === 'object') filters.push(...Object.entries(field));
        else if (field === 'status') filters.push([field, value]);
        return q;
      });
      const matches = () => filters.every(([key, value]) => row[key] === value);
      q.first.mockImplementation(async () => matches() ? { ...row } : undefined);
      q.select.mockImplementation(async () => matches() && row.scheduled_send_attempts < 5 ? [{ ...row }] : []);
      q.update.mockImplementation((payload) => {
        if (matches()) {
          if (payload.status === 'sending') deliveryClaims += 1;
          Object.assign(row, payload);
        }
        return q;
      });
      q.returning.mockImplementation(async () => [{ ...row }]);
      q.forUpdate.mockImplementation(() => { invoiceLocks.push(q); return q; });
      return q;
    });
    try {
      for (let tick = 0; tick < 6; tick += 1) {
        await expect(InvoiceService.processScheduledSends())
          .resolves.toEqual({ sent: 0, failed: 0, deferred: 0 });
      }
      expect(row).toMatchObject({
        status: 'prepaid', prepaid_prev_status: 'scheduled',
        prepaid_by: 'system:zero_balance', scheduled_send_attempts: 2,
      });
      expect(deliveryClaims).toBe(0);
      expect(invoiceLocks).toHaveLength(1);
      expect(stripeFence).toHaveBeenCalledTimes(1);
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.zero_balance_settled' }));
      expect(sendSpy).not.toHaveBeenCalled();
      expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
    } finally {
      db.mockReset();
      if (previousTransaction) db.transaction = previousTransaction;
      else delete db.transaction;
      stripeFence.mockRestore();
      audit.mockRestore();
    }
  });

  test('a refused oldest zero-due row is deferred so a later payable row sends on the next limit-1 tick', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const originalDueAt = new Date('2026-08-06T12:00:00Z');
    const zeroDueRow = {
      ...dueRow,
      id: 'zero-due',
      status: 'scheduled',
      total: 100,
      credit_applied: 100,
      scheduled_service_id: 'visit-1',
      scheduled_send_at: originalDueAt,
    };
    const payableRow = {
      ...dueRow,
      id: 'payable',
      status: 'scheduled',
      total: 100,
      credit_applied: 0,
      scheduled_service_id: 'visit-2',
      scheduled_send_at: new Date('2026-08-06T12:01:00Z'),
    };
    const refusalUpdate = chain();
    const claim = chain({ returning: [{
      id: 'payable', scheduled_request_review: false,
      scheduled_review_delay_minutes: null, send_claim_token: 'payable-claim',
    }] });
    const settlement = jest.spyOn(InvoiceService, 'settleZeroBalance')
      .mockResolvedValue({ settled: false, reason: 'existing_payment_work', invoice: zeroDueRow });
    const startedAt = Date.now();
    db
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [zeroDueRow] }))
      .mockReturnValueOnce(refusalUpdate)
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [payableRow] }))
      .mockReturnValueOnce(claim);
    sendSpy.mockResolvedValue({ ok: true, sms: { ok: true }, email: { ok: true }, creditApplied: 0 });

    try {
      await expect(InvoiceService.processScheduledSends({ limit: 1 }))
        .resolves.toEqual({ sent: 0, failed: 1, deferred: 0 });
      await expect(InvoiceService.processScheduledSends({ limit: 1 }))
        .resolves.toEqual({ sent: 1, failed: 0, deferred: 0 });

      expect(refusalUpdate.where).toHaveBeenCalledWith({
        id: 'zero-due', status: 'scheduled', scheduled_send_at: originalDueAt,
      });
      const deferred = refusalUpdate.update.mock.calls[0][0];
      expect(deferred.scheduled_send_at.getTime()).toBeGreaterThanOrEqual(startedAt + 5 * 60 * 1000);
      expect(deferred.scheduled_send_attempts).toBeUndefined();
      expect(deferred.scheduled_send_error).toContain('existing_payment_work');
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith('payable', expect.objectContaining({ allowClaimed: true }));
      expect(settlement).toHaveBeenCalledTimes(1);
    } finally {
      settlement.mockRestore();
    }
  });

  test('a concurrent reschedule wins the zero-due refusal deferral CAS', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const originalDueAt = new Date('2026-08-06T12:00:00Z');
    const row = {
      ...dueRow,
      status: 'scheduled',
      total: 100,
      credit_applied: 100,
      scheduled_service_id: 'visit-1',
      scheduled_send_at: originalDueAt,
    };
    const refusalUpdate = chain({ updateCount: 0 });
    const settlement = jest.spyOn(InvoiceService, 'settleZeroBalance')
      .mockResolvedValue({ settled: false, reason: 'collection_stopped', invoice: row });
    db
      .mockReturnValueOnce(chain())
      .mockReturnValueOnce(chain({ rows: [row] }))
      .mockReturnValueOnce(refusalUpdate);

    try {
      await expect(InvoiceService.processScheduledSends({ limit: 1 }))
        .resolves.toEqual({ sent: 0, failed: 1, deferred: 0 });
      expect(refusalUpdate.where).toHaveBeenCalledWith({
        id: 'inv-1', status: 'scheduled', scheduled_send_at: originalDueAt,
      });
      expect(refusalUpdate.update).toHaveBeenCalledTimes(1);
      expect(refusalUpdate.update.mock.calls[0][0].scheduled_send_attempts).toBeUndefined();
    } finally {
      settlement.mockRestore();
    }
  });

  test('an initial deposit readiness refusal keeps the scheduled retry slot instead of parking an ambiguous delivery', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const sendingInvoice = { ...dueRow, status: 'sending', total: 100 };
    const claimToken = 'deposit-retry-claim';
    const failUpdate = chain();
    const refusal = new Error('A received deposit is awaiting invoice reconciliation');
    refusal.code = 'DEPOSIT_RECONCILIATION_REQUIRED';
    require('../services/estimate-deposits').assertInvoiceDepositSettlementReady
      .mockRejectedValueOnce(refusal);
    const smsSpy = jest.spyOn(InvoiceService, 'sendViaSMS');
    try {
      db
        .mockReturnValueOnce(chain()) // stale recovery
        .mockReturnValueOnce(chain({ rows: [dueRow] }))
        .mockReturnValueOnce(chain({ returning: [{ ...sendingInvoice, send_claim_token: claimToken }] }))
        .mockReturnValueOnce(chain({ first: sendingInvoice })) // wrapper precheck
        .mockReturnValueOnce(chain({ first: sendingInvoice })) // initial claim readiness
        .mockReturnValueOnce(failUpdate);

      await expect(InvoiceService.processScheduledSends())
        .resolves.toEqual({ sent: 0, failed: 1, deferred: 0 });

      expect(smsSpy).not.toHaveBeenCalled();
      expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
      expect(failUpdate.where).toHaveBeenCalledWith({
        id: 'inv-1', status: 'sending', send_claim_token: claimToken,
      });
      expect(failUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'scheduled', scheduled_send_attempts: 3, send_claim_token: null,
      }));
      const restored = failUpdate.update.mock.calls[0][0];
      expect(restored.scheduled_send_at).toBeUndefined();
      expect(restored.scheduled_send_error).toContain('awaiting invoice reconciliation');
      expect(restored.scheduled_send_error).not.toMatch(/^Recovered from stale sending claim/);
    } finally {
      smsSpy.mockRestore();
    }
  });

  test.each(['DEPOSIT_RECONCILIATION_REQUIRED', 'synthetic_deposit_lookup_failure'])(
    'nested SMS claim readiness refusal %s suppresses the email leg too',
    async (code) => {
      const sendingInvoice = { ...dueRow, status: 'sending', total: 100 };
      const refusal = new Error('Deposit readiness could not be confirmed');
      refusal.code = code;
      require('../services/estimate-deposits').assertInvoiceDepositSettlementReady
        .mockResolvedValueOnce(true) // wrapper owns the send claim
        .mockRejectedValueOnce(refusal); // deposit changes before nested SMS
      db
        .mockReturnValueOnce(chain({ first: sendingInvoice })) // wrapper precheck
        .mockReturnValueOnce(chain({ first: sendingInvoice })) // outer claim read
        .mockReturnValueOnce(chain({ first: undefined })) // queued-obligation precheck
        .mockReturnValueOnce(chain({ returning: [] })) // no previous queued obligation
        .mockReturnValueOnce(chain({ first: undefined })) // strict queue recheck
        .mockReturnValueOnce(chain({ first: sendingInvoice })); // nested SMS claim read

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', { allowClaimed: true });

      expect(result.ok).toBe(false);
      expect(result.sms.code).toBe(code);
      expect(result.sms.invoiceWideRefusal).toBe(true);
      expect(result.email.code).toBe(code);
      expect(require('../services/invoice-email').sendInvoiceEmail).not.toHaveBeenCalled();
      // Only the scheduled worker owns the token and may release its preclaim.
      expect(db).toHaveBeenCalledTimes(6);
      expect(refusal.deliveryNeverAttempted).toBe(true);
    },
  );

  // Codex round 14 P1 #4131: claimInvoiceForSend's allowClaimed branch now
  // runs the queued-obligation check too, which can THROW (a live queue
  // this preclaimed send does not own) instead of only ever resolving —
  // one row's refusal must not abort the whole batch (the remaining due
  // invoices, and the batch counters, must survive it).
  test('sendViaSMSAndEmail throwing (the new preclaimed queue-check refusal) is treated as an ordinary failure — the batch survives', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    const failUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(failUpdate);
    const thrown = new Error('Invoice send already in progress — a text carrying this pay link is queued for the send window');
    thrown.code = 'queued_pay_link';
    // Set by claimInvoiceForSend's allowClaimed branch itself (pre-push
    // audit P1 #4131 finding 2) — every exit in that branch runs BEFORE any
    // provider is contacted, so this is the ONE marker that tells
    // processScheduledSends' catch it is safe to retry.
    thrown.deliveryNeverAttempted = true;
    sendSpy.mockRejectedValue(thrown);

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const updateArgs = failUpdate.update.mock.calls[0][0];
    expect(updateArgs.scheduled_send_attempts).toBe(3);
    expect(updateArgs.scheduled_send_error).toContain('queued for the send window');
  });

  // Pre-push audit P1 (#4131 finding 2): a throw reaching this catch WITHOUT
  // the deliveryNeverAttempted marker — sendViaSMSAndEmail's own post-
  // delivery finalize UPDATE can throw AFTER the email (and/or SMS) already
  // reached a provider (round-17 P1, invoice-send-adoption-restore.test.js)
  // — used to hit the exact same synthesis as the queued_pay_link refusal
  // above and get restored to 'scheduled' with the attempt counter bumped,
  // so the NEXT tick emailed/texted the customer the SAME invoice again. A
  // delivered (or merely ambiguous) failure must instead be parked under
  // the same review hold the stale-claim recovery uses — never retried.
  test('sendViaSMSAndEmail throwing WITHOUT deliveryNeverAttempted (a post-delivery finalize failure, or any other unverified throw) parks the row for review instead of retrying it', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null }] });
    const holdUpdate = chain();
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(holdUpdate);
    const finalizeErr = new Error('synthetic finalize DB failure (post-provider-accept)');
    sendSpy.mockRejectedValue(finalizeErr);

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    const updateArgs = holdUpdate.update.mock.calls[0][0];
    // Parked exactly like the stale-claim recovery block: back to
    // 'scheduled' but with scheduled_send_at cleared (out of the due
    // query) and NO attempt burned — this is a hold, not a retry.
    expect(updateArgs.status).toBe('scheduled');
    expect(updateArgs.scheduled_send_at).toBeNull();
    expect(updateArgs.scheduled_send_attempts).toBeUndefined();
    expect(updateArgs.scheduled_send_error).toMatch(/^Recovered from stale sending claim/);
    expect(updateArgs.scheduled_send_error).toContain('synthetic finalize DB failure');

    // Next tick: with scheduled_send_at cleared, the real due query's
    // whereNotNull('scheduled_send_at') excludes this row — simulate that
    // by returning nothing due, and confirm sendViaSMSAndEmail is never
    // called on it again. The customer never gets a duplicate email/SMS.
    sendSpy.mockClear();
    const staleRecovery2 = chain();
    const dueQueryNextTick = chain({ rows: [] });
    db.mockReturnValueOnce(staleRecovery2).mockReturnValueOnce(dueQueryNextTick);
    const secondResult = await InvoiceService.processScheduledSends();
    expect(secondResult).toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // Codex round 16 P1 #4131: the generic failure branch's restore used to be
  // an unconditional UPDATE keyed only on id — a worker (or the void sweep,
  // which takes a 'sending' row out from under a live claim by design) that
  // moved the row to 'sent' (or 'void') between the send attempt and this
  // restore would get clobbered back to 'scheduled' with a stale due time,
  // double-sending on the next tick. Reworked round 18 (#4131): the restore
  // is conditioned on status='sending' AND a dedicated send_claim_token —
  // NOT updated_at, which round 18 found an unrelated intra-claim writer
  // (a partial account-credit apply) can silently re-stamp, matching zero
  // rows and stranding the invoice under 'sending' even though nothing else
  // actually moved the row.
  test('a worker finalizes the invoice to sent between the send attempt and the restore — the restore is a no-op, the row stays sent', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const CLAIM_TOKEN = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const staleRecovery = chain();
    const dueQuery = chain({ rows: [dueRow] });
    const claim = chain({ returning: [{ id: 'inv-1', scheduled_request_review: false, scheduled_review_delay_minutes: null, send_claim_token: CLAIM_TOKEN }] });
    // 0 rows affected: some other process already moved the row to 'sent'
    // (or anything else) before this exact token could match.
    const restoreAttempt = chain({ updateCount: 0 });
    db
      .mockReturnValueOnce(staleRecovery)
      .mockReturnValueOnce(dueQuery)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(restoreAttempt);
    sendSpy.mockResolvedValue({
      ok: false,
      sms: { ok: false, error: 'Customer has no phone number' },
      email: { ok: false, error: 'no email on file' },
      creditApplied: 0,
    });

    const result = await InvoiceService.processScheduledSends();

    expect(result).toEqual({ sent: 0, failed: 1, deferred: 0 });
    // The restore matched on this claim's own dedicated token — an identity
    // no other writer touches — that proves nobody else has claimed the row
    // since, regardless of what else it may have written on the row.
    expect(restoreAttempt.where.mock.calls[0][0]).toEqual({ id: 'inv-1', status: 'sending', send_claim_token: CLAIM_TOKEN });
    // 0 rows affected is logged, not thrown — the batch keeps going.
    const logger = require('../services/logger');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('moved out from under this claim'));
  });

  test('stale parking ends the old token episode, so an operator replacement claim survives the old worker restore', async () => {
    isWithinSendWindowET.mockReturnValue(true);
    const invoice = {
      ...dueRow,
      status: 'scheduled',
      total: 117,
      credit_applied: 0,
      scheduled_service_id: null,
      scheduled_send_at: new Date(Date.now() - 60_000),
      scheduled_send_error: null,
      send_claim_token: null,
      updated_at: new Date(),
    };
    let forceStale = false;

    const statefulQuery = (table) => {
      if (table === 'sms_log') {
        const empty = {};
        for (const method of ['where', 'whereRaw', 'whereIn', 'whereNotNull']) empty[method] = jest.fn(() => empty);
        empty.first = jest.fn(async () => undefined);
        return empty;
      }
      expect(table).toBe('invoices');
      const predicates = [];
      let updateCount = null;
      const q = {};
      q.where = jest.fn((field, operator, value) => {
        if (typeof field === 'function') return q; // attempt-cap disjunction
        if (field && typeof field === 'object') {
          for (const [key, expected] of Object.entries(field)) predicates.push(() => invoice[key] === expected);
          return q;
        }
        if (field === 'updated_at' && operator === '<') predicates.push(() => forceStale);
        else if (operator === '<=') predicates.push(() => invoice[field] != null && new Date(invoice[field]) <= new Date(value));
        else predicates.push(() => invoice[field] === operator);
        return q;
      });
      q.whereNotNull = jest.fn((field) => { predicates.push(() => invoice[field] != null); return q; });
      q.whereNull = jest.fn((field) => { predicates.push(() => invoice[field] == null); return q; });
      q.orWhere = jest.fn(() => q);
      q.whereIn = jest.fn((field, values) => { predicates.push(() => values.includes(invoice[field])); return q; });
      q.whereRaw = jest.fn(() => q);
      q.orderBy = jest.fn(() => q);
      q.limit = jest.fn(() => q);
      const matches = () => predicates.every((predicate) => predicate());
      q.update = jest.fn((payload) => {
        updateCount = matches() ? 1 : 0;
        if (updateCount) Object.assign(invoice, payload);
        return q;
      });
      q.returning = jest.fn(async () => (updateCount ? [{ ...invoice }] : []));
      q.select = jest.fn(async () => (matches() ? [{ ...invoice }] : []));
      q.first = jest.fn(async () => (matches() ? { ...invoice } : undefined));
      q.then = (resolve) => Promise.resolve(updateCount ?? (matches() ? [{ ...invoice }] : [])).then(resolve);
      return q;
    };
    db.mockImplementation(statefulQuery);

    let finishOldSend;
    sendSpy.mockImplementation(() => new Promise((resolve) => { finishOldSend = resolve; }));
    const oldWorker = InvoiceService.processScheduledSends({ limit: 1 });
    for (let i = 0; i < 20 && !finishOldSend; i += 1) await Promise.resolve();
    expect(finishOldSend).toBeDefined();
    const oldToken = invoice.send_claim_token;
    expect(oldToken).toEqual(expect.any(String));

    forceStale = true;
    await expect(InvoiceService.processScheduledSends({ limit: 1 }))
      .resolves.toEqual({ sent: 0, failed: 0, deferred: 0 });
    expect(invoice).toMatchObject({
      status: 'scheduled', scheduled_send_at: null, send_claim_token: null,
    });

    const replacement = await InvoiceService.claimInvoiceForSend(invoice.id, { operatorInitiated: true });
    expect(replacement).toMatchObject({ claimed: true, previousStatus: 'scheduled' });
    expect(invoice).toMatchObject({ status: 'sending', send_claim_token: null });

    finishOldSend({
      ok: false,
      sms: { ok: false, error: 'old worker failed after replacement began' },
      email: { ok: false, error: 'old worker failed after replacement began' },
      creditApplied: 0,
    });
    await expect(oldWorker).resolves.toEqual({ sent: 0, failed: 1, deferred: 0 });
    expect(invoice).toMatchObject({ status: 'sending', send_claim_token: null });
    expect(invoice.scheduled_send_error).toMatch(/^Recovered from stale sending claim/);
    expect(require('../services/logger').warn)
      .toHaveBeenCalledWith(expect.stringContaining('restore skipped'));

    // Legacy rows may already be parked with the old token retained (or
    // return to a claimable status through another lifecycle transition).
    // The ordinary operator claim is itself a universal episode boundary.
    Object.assign(invoice, {
      status: 'scheduled',
      scheduled_send_at: null,
      scheduled_send_error: 'Recovered from stale sending claim — legacy row',
      send_claim_token: oldToken,
    });
    const legacyReplacement = await InvoiceService.claimInvoiceForSend(invoice.id, { operatorInitiated: true });
    expect(legacyReplacement).toMatchObject({ claimed: true, previousStatus: 'scheduled' });
    expect(invoice).toMatchObject({ status: 'sending', send_claim_token: null });
    const lateOldRestore = await db('invoices')
      .where({ id: invoice.id, status: 'sending', send_claim_token: oldToken })
      .update({ status: 'scheduled', send_claim_token: null });
    expect(lateOldRestore).toBe(0);
    expect(invoice.status).toBe('sending');
  });
});
