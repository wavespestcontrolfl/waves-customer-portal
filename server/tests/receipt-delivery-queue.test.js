jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.fn = { now: jest.fn(() => 'NOW') };
  dbMock.raw = jest.fn((sql) => sql);
  dbMock.transaction = jest.fn();
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ sendReceipt: jest.fn() }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn() }));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');

const {
  shouldRetryReceiptDelivery,
  receiptDeliveryFailureError,
} = ReceiptDeliveryQueue._internals;

// Chainable knex-table stub: every builder method returns the stub, first()
// resolves `firstResult`, update() resolves 1 and is spyable.
function tableStub(firstResult) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereNull = jest.fn(() => q);
  q.first = jest.fn(() => Promise.resolve(firstResult));
  q.update = jest.fn(() => Promise.resolve(1));
  return q;
}

describe('receipt delivery queue retry policy', () => {
  test('retries when email fails even if SMS succeeded', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: true },
      emailResult: { ok: false, error: 'SendGrid unavailable' },
    })).toBe(true);

    expect(receiptDeliveryFailureError({
      smsResult: { sent: true },
      emailResult: { ok: false, error: 'SendGrid unavailable' },
    }).message).toBe('receipt channel failed: sms=ok email=SendGrid unavailable');
  });

  test('retries when SMS fails even if email succeeded', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'Twilio unavailable' },
      emailResult: { ok: true },
    })).toBe(true);
  });

  test('retries failed email when SMS was already sent on an earlier attempt', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'already-sent' },
      emailResult: { ok: false, error: 'SendGrid unavailable' },
    })).toBe(true);
  });

  test('completes when only expected skips remain', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'no-phone' },
      emailResult: { ok: false, error: 'No receipt recipient email' },
    })).toBe(false);
  });

  test('does not retry a payer-billed receipt — the homeowner SMS is intentionally suppressed', () => {
    // Third-party Bill-To: the receipt email goes to the payer AP inbox and the
    // homeowner SMS is suppressed ('payer_billed'). That suppression must not be
    // treated as an actionable failure or the job retries/fails forever.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'payer_billed' },
      emailResult: { ok: true },
    })).toBe(false);

    // Misconfigured payer (no AP email): email skips with the standard
    // no-recipient reason; still no retry storm.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'payer_billed' },
      emailResult: { ok: false, error: 'No receipt recipient email' },
    })).toBe(false);
  });

  test('does not retry an email-only receipt preference — the email leg IS the receipt', () => {
    // payment_receipt_channel='email' makes InvoiceService.sendReceipt skip
    // the SMS leg with 'channel_email_only'. With the email delivered the job
    // must complete (and stamp receipt_sent_at), not spin the retry ladder.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'channel_email_only' },
      emailResult: { ok: true },
    })).toBe(false);

    // But an email-preferring customer whose email leg FAILED is actionable —
    // nothing was delivered.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'channel_email_only' },
      emailResult: { ok: false, error: 'SendGrid unavailable' },
    })).toBe(true);
  });

  test('does not retry a receipt-texts opt-out — the suppression is the customer\'s own choice', () => {
    // payment_receipt=false or the portal "Payment confirmation texts" toggle
    // off makes InvoiceService.sendReceipt skip with 'receipt_texts_opted_out'
    // (PURPOSE_OPTED_OUT at the consent gate). Not a delivery failure.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'receipt_texts_opted_out' },
      emailResult: { ok: true },
    })).toBe(false);

    // Opted out of texts AND no receipt email recipient: both skips are
    // expected — complete without a retry storm.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'receipt_texts_opted_out' },
      emailResult: { ok: false, error: 'No receipt recipient email' },
    })).toBe(false);
  });

  test('does not retry the payment_receipt kill switch — BOTH legs are intentional skips', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'receipt_texts_opted_out' },
      emailResult: { ok: false, error: 'receipt_opted_out' },
    })).toBe(false);
  });

  test('does not retry a STOP-suppressed SMS leg — permanent until the customer texts START', () => {
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'sms_suppressed' },
      emailResult: { ok: true },
    })).toBe(false);

    // But a STOP customer whose email leg FAILED is actionable — nothing
    // was delivered and the email CAN succeed on retry.
    expect(shouldRetryReceiptDelivery({
      smsResult: { sent: false, reason: 'sms_suppressed' },
      emailResult: { ok: false, error: 'SendGrid unavailable' },
    })).toBe(true);
  });
});

describe('processReceiptDeliveryJob email-leg gating (payment_receipt kill switch)', () => {
  const job = { id: 'job1', invoice_id: 'inv1', attempts: 1, max_attempts: 5 };

  let invoicesTable;
  let prefsTable;
  let jobsTable;

  function primeDb({ invoice, prefs }) {
    invoicesTable = tableStub(invoice);
    prefsTable = tableStub(prefs);
    jobsTable = tableStub(null);
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoicesTable;
      if (table === 'notification_prefs') return prefsTable;
      if (table === 'receipt_delivery_jobs') return jobsTable;
      throw new Error(`unexpected table ${table}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('payment_receipt=false skips the email leg entirely — no email, no receipt_sent_at stamp', async () => {
    // The kill-switch customer opted out of payment receipts on EVERY
    // channel. Before this gate the SMS leg skipped as expected while
    // sendReceiptEmail still delivered (Codex P2 on 8bcfd5c).
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: null, invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: { payment_receipt: false },
    });
    InvoiceService.sendReceipt.mockResolvedValue({ sent: false, reason: 'receipt_texts_opted_out' });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(true);
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    // Job completed, invoice NOT stamped (nothing was sent).
    expect(jobsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(invoicesTable.update).not.toHaveBeenCalled();
  });

  test('the text-only toggle still emails — payment_confirmation_sms=false is not the kill switch', async () => {
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: null, invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: { payment_receipt: true, payment_confirmation_sms: false },
    });
    InvoiceService.sendReceipt.mockResolvedValue({ sent: false, reason: 'receipt_texts_opted_out' });
    sendReceiptEmail.mockResolvedValue({ ok: true });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(true);
    expect(sendReceiptEmail).toHaveBeenCalledWith('inv1', { idempotencyKey: 'receipt_email_auto:inv1' });
    // The delivered email IS the receipt — stamped so the needs_receipt
    // filter/batch resend can't double-send.
    expect(invoicesTable.update).toHaveBeenCalledWith({ receipt_sent_at: 'NOW' });
  });

  test('a prefs lookup failure retries the job instead of emailing a possibly opted-out customer', async () => {
    // .catch(() => null) on the kill-switch lookup would read a DB blip as
    // "no opt-out" and email a payment_receipt=false customer anyway
    // (Codex P2 on d07235e9). The failure must ride the retry ladder.
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: null, invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: null,
    });
    prefsTable.first.mockRejectedValue(new Error('connection reset'));
    InvoiceService.sendReceipt.mockResolvedValue({ sent: false, reason: 'receipt_texts_opted_out' });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(false);
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(jobsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'retry_scheduled' }));
  });

  test('a STOP-suppressed SMS leg completes off the delivered email — and stamps receipt_sent_at', async () => {
    // STOP writes a suppression row checked BEFORE consent, so the SMS leg
    // returns 'sms_suppressed' (not channel_email_only) even for an
    // email-only customer. The delivered email IS the receipt.
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: null, invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: { payment_receipt: true, payment_receipt_channel: 'email' },
    });
    InvoiceService.sendReceipt.mockResolvedValue({ sent: false, reason: 'sms_suppressed' });
    sendReceiptEmail.mockResolvedValue({ ok: true });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(true);
    expect(jobsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(invoicesTable.update).toHaveBeenCalledWith({ receipt_sent_at: 'NOW' });
  });

  test("the migration-default payment_receipt_channel='sms' does NOT gate the email leg", async () => {
    // Migration 104 seeded 'sms' as the column DEFAULT on every existing
    // prefs row, so channel==='sms' cannot distinguish an explicit Text
    // choice from a never-touched default — gating the email on it would
    // silently stop the receipt/PDF email for every default customer's paid
    // invoice (Codex P1 on 4263af95). The email is the durable payment
    // record; only the payment_receipt kill switch stops it.
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: null, invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: { payment_receipt: true, payment_receipt_channel: 'sms' },
    });
    InvoiceService.sendReceipt.mockResolvedValue({ sent: true });
    sendReceiptEmail.mockResolvedValue({ ok: true });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(true);
    expect(sendReceiptEmail).toHaveBeenCalledWith('inv1', { idempotencyKey: 'receipt_email_auto:inv1' });
    // The queue is a paired-legs caller — it must declare the email sidecar
    // so email-only customers get the channel_email_only SMS skip (the flag
    // is caller-declared now; codex round 5).
    expect(InvoiceService.sendReceipt).toHaveBeenCalledWith('inv1', { hasEmailLeg: true });
    expect(jobsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  test('payer-billed receipts are exempt — homeowner prefs never gate the payer AP email', async () => {
    primeDb({
      invoice: { id: 'inv1', customer_id: 'c1', payer_id: 'p1', invoice_number: 'WPC-1', receipt_sent_at: null },
      prefs: { payment_receipt: false },
    });
    InvoiceService.sendReceipt.mockResolvedValue({ sent: false, reason: 'payer_billed' });
    sendReceiptEmail.mockResolvedValue({ ok: true });

    const result = await ReceiptDeliveryQueue.processReceiptDeliveryJob(job);

    expect(result.ok).toBe(true);
    expect(sendReceiptEmail).toHaveBeenCalled();
    // The homeowner's prefs are never even read on the payer path.
    expect(prefsTable.first).not.toHaveBeenCalled();
  });
});
