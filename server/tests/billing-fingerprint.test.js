/**
 * Codex round-48/49 P1 (PR #5331): the billing fingerprint the send paths take BEFORE their full billing recheck and re-read at the
 * provider boundary on the handoff connection.
 */
jest.mock('../models/db', () => jest.fn());
const mockGuard = jest.fn(async () => ({ ok: true }));
jest.mock('../services/prepaid-pi-guard', () => ({ guardOpenPaymentIntentForPrepaid: (...a) => mockGuard(...a) }));
const { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL } = require('../services/billing-fingerprint');

describe('billingFingerprint', () => {
  test('one content hash over every row the recheck reads: payments, invoices, plans, payer assignments', () => {
    expect(BILLING_FINGERPRINT_SQL).toMatch(/md5\(concat_ws/);
    for (const t of ['FROM payments WHERE customer_id = ?', 'FROM invoices WHERE customer_id = ?', 'FROM payment_plans WHERE customer_id = ?',
      'FROM scheduled_services WHERE customer_id = ? AND payer_id IS NOT NULL', 'FROM customers WHERE id = ?']) expect(BILLING_FINGERPRINT_SQL).toContain(t);
    // the columns a status / amount / ownership / Zelle answer depends on
    // Codex round-50 P1: an invoice's attached PaymentIntent and its saved-card charge attempts are billing state too
    expect(BILLING_FINGERPRINT_SQL).toContain('FROM stripe_invoice_charge_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE i.customer_id = ?');
    for (const c of ['status', 'amount', 'refund_status', 'refund_amount', 'superseded_by_payment_id', 'metadata', 'credit_applied', 'payer_statement_id', 'scheduled_send_error', 'stripe_payment_intent_id', 'resolved_at']) {
      expect(BILLING_FINGERPRINT_SQL).toContain(c);
    }
  });
  test('reads through the given connection; null on no customer, a failed read, or no row', async () => {
    const dbh = { raw: jest.fn(async () => ({ rows: [{ fingerprint: 'abc' }] })) };
    expect(await billingFingerprint('c1', dbh)).toBe('abc');
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, ['c1', 'c1', 'c1', 'c1', 'c1', 'c1']);
    expect(await billingFingerprint(null, dbh)).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => { throw new Error('down'); } })).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => ({ rows: [] }) })).toBeNull();
  });
});

describe('billingUnchangedProviderPreSendCheck', () => {
  const dbiWith = (fp) => ({ raw: async () => ({ rows: [{ fingerprint: fp }] }) });
  test('unchanged => ok; changed / unreadable / never taken => retryable refusal; repeatable after the marker', async () => {
    const check = billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc' });
    expect(check.afterMarker).toBe(check);
    await expect(check({ dbi: dbiWith('abc') })).resolves.toEqual({ ok: true });
    await expect(check({ dbi: dbiWith('xyz') })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
    await expect(check({ dbi: { raw: async () => { throw new Error('down'); } } })).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: null })({ dbi: dbiWith('abc') })).resolves.toMatchObject({ ok: false, retryable: true });
  });
});

// Codex round-50 P1: a Zelle OFFER also depends on live Stripe state no row records
describe('a Zelle offer at the provider boundary: the invoice\'s PaymentIntent is inspected live', () => {
  const dbiWith = (fp, invoice) => {
    const dbi = jest.fn(() => ({ where: () => ({ first: async () => invoice }) }));
    dbi.raw = async () => ({ rows: [{ fingerprint: fp }] });
    return dbi;
  };
  const INV = { id: 'inv-1', customer_id: 'c1', stripe_payment_intent_id: 'pi_1' };
  const offer = (over = {}) => billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc', zelleInvoiceId: 'inv-1', getBody: () => 'You can Zelle us at pay@example.com.', ...over });
  afterEach(() => { mockGuard.mockReset(); mockGuard.mockResolvedValue({ ok: true }); });
  test('no payment in flight => ok (inspect-only, on the invoice the recheck checked)', async () => {
    await expect(offer()({ dbi: dbiWith('abc', INV) })).resolves.toEqual({ ok: true });
    expect(mockGuard).toHaveBeenCalledWith(INV, { inspectOnly: true });
  });
  test('the customer advanced the PaymentIntent (processing / succeeded / unreadable) after the recheck => refused, retryable', async () => {
    mockGuard.mockResolvedValue({ ok: false, reason: 'payment_in_flight' });
    await expect(offer()({ dbi: dbiWith('abc', INV) })).resolves.toMatchObject({ ok: false, code: 'ZELLE_OFFER_UNSENDABLE_AT_BOUNDARY', retryable: true });
    mockGuard.mockRejectedValue(new Error('stripe down'));
    await expect(offer()({ dbi: dbiWith('abc', INV) })).resolves.toMatchObject({ ok: false, retryable: true });
  });
  test('no known invoice, or another customer\'s, is refused; a body without a Zelle offer never calls Stripe', async () => {
    await expect(offer({ zelleInvoiceId: null })({ dbi: dbiWith('abc', INV) })).resolves.toMatchObject({ ok: false });
    await expect(offer()({ dbi: dbiWith('abc', { ...INV, customer_id: 'c2' }) })).resolves.toMatchObject({ ok: false });
    await expect(offer({ getBody: () => 'Your account balance is $95.00.' })({ dbi: dbiWith('abc', INV) })).resolves.toEqual({ ok: true });
    expect(mockGuard).toHaveBeenCalledTimes(0);
  });
});
