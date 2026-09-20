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
  for (const m of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'update', 'insert']) {
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
      db
        .mockReturnValueOnce(chain({ first: { payer_statement_id: null } })) // accrual pre-check
        .mockReturnValueOnce(chain({ first: sendingInvoice })); // claimInvoiceForSend read

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
    db.mockReturnValueOnce(chain({ first: { payer_statement_id: null } }))
      .mockReturnValueOnce(chain({ first: draftInvoice }))
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }));
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
    db.mockReturnValueOnce(chain({ first: { payer_statement_id: null } }))
      .mockReturnValueOnce(chain({ first: draftInvoice }))
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }));
    try {
      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN' });
      expect(voidSpy).not.toHaveBeenCalled();
      expect(db).toHaveBeenCalledTimes(3);
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
    db.mockReturnValueOnce(chain({ first: { payer_statement_id: null } }))
      .mockReturnValueOnce(chain({ first: draftInvoice }))
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] }));
    try {
      await expect(InvoiceService.sendViaSMSAndEmail('inv-1')).resolves.toMatchObject({
        ok: false, code: 'INVOICE_DELIVERY_OUTCOME_UNCERTAIN',
      });
      expect(db).toHaveBeenCalledTimes(3);
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
    db.mockReturnValueOnce(chain({ first: { payer_statement_id: null } }))
      .mockReturnValueOnce(chain({ first: draftInvoice }))
      .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending', scheduled_service_id: 'svc-1' }] }))
      .mockReturnValueOnce(chain({ first: { id: 'queued-sms-1' } }));
    try {
      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, code: 'INVOICE_VISIT_TERMINAL_OUTCOME_UNCERTAIN',
        sms: { scheduled: true } });
      expect(voidSpy).not.toHaveBeenCalled();
      expect(db).toHaveBeenCalledTimes(4);
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
      db
        .mockReturnValueOnce(chain({ first: { payer_statement_id: null } })) // accrual pre-check
        .mockReturnValueOnce(chain({ first: draftInvoice })) // claim read
        .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim update
        .mockReturnValueOnce(chain({ first: undefined })) // requeue idempotency check (no prior row)
        .mockReturnValueOnce(requeueInsert) // held-SMS scheduled-rail insert
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
        .mockReturnValueOnce(chain({ returning: [{ ...draftInvoice, status: 'sending' }] })) // claim update
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
});
