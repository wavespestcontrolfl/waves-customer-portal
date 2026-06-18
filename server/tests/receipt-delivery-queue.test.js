const ReceiptDeliveryQueue = require('../services/receipt-delivery-queue');

const {
  shouldRetryReceiptDelivery,
  receiptDeliveryFailureError,
} = ReceiptDeliveryQueue._internals;

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
});
