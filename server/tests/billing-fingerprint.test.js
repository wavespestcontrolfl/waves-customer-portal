/**
 * Codex round-48/49 P1 (PR #5331): the billing fingerprint the send paths take BEFORE their full billing recheck and re-read at the
 * provider boundary on the handoff connection.
 */
jest.mock('../models/db', () => jest.fn());
const mockGuard = jest.fn(async () => ({ ok: true }));
jest.mock('../services/prepaid-pi-guard', () => ({ guardOpenPaymentIntentForPrepaid: (...a) => mockGuard(...a) }));
const { billingFingerprint, billingUnchangedProviderPreSendCheck, paymentIntentStateOf, BILLING_FINGERPRINT_SQL } = require('../services/billing-fingerprint');

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

// Codex round-51 P1: account credit that would cover the invoice changes Zelle visibility - it is billing state too
test('the fingerprint hashes the customer\'s account credit and auto-apply setting', () => {
  expect(BILLING_FINGERPRINT_SQL).toContain("concat_ws('|', 'c', payer_id, account_credits, auto_apply_account_credit) FROM customers WHERE id = ?");
});

// Codex round-51 P2: a scoped Zelle DENIAL can stand on a payment in flight; its PaymentIntent state is re-read at the boundary
describe('a Zelle denial at the provider boundary: the PaymentIntent baseline must still hold', () => {
  const INV = { id: 'inv-1', customer_id: 'c1', stripe_payment_intent_id: 'pi_1' };
  const dbiWith = (invoice) => {
    const dbi = jest.fn(() => ({ where: () => ({ first: async () => invoice }) }));
    dbi.raw = async () => ({ rows: [{ fingerprint: 'abc' }] });
    return dbi;
  };
  const denial = (piState, body = "Zelle isn't available for your invoice right now.") => billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc', zelleDenial: { invoiceId: 'inv-1', piState }, getBody: () => body });
  afterEach(() => { mockGuard.mockReset(); mockGuard.mockResolvedValue({ ok: true }); });
  test('the payment was in flight at the recheck and still is => ok; it was canceled since (now open) => refused, retryable', async () => {
    mockGuard.mockResolvedValue({ ok: false });
    await expect(denial('blocked')({ dbi: dbiWith(INV) })).resolves.toEqual({ ok: true });
    mockGuard.mockResolvedValue({ ok: true });
    await expect(denial('blocked')({ dbi: dbiWith(INV) })).resolves.toMatchObject({ ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', retryable: true });
  });
  test('an intent attached since the recheck, or an unreadable invoice, refuses; a body with no denial never re-reads', async () => {
    await expect(denial('none')({ dbi: dbiWith(INV) })).resolves.toMatchObject({ ok: false });
    await expect(denial('none')({ dbi: dbiWith(null) })).resolves.toMatchObject({ ok: false });
    await expect(denial('blocked', 'Your account balance is $95.00.')({ dbi: dbiWith(INV) })).resolves.toEqual({ ok: true });
  });
  test('paymentIntentStateOf: none / open / blocked / unreadable', async () => {
    await expect(paymentIntentStateOf({ invoiceId: 'inv-1', customerId: 'c1', dbh: dbiWith({ ...INV, stripe_payment_intent_id: null }) })).resolves.toBe('none');
    await expect(paymentIntentStateOf({ invoiceId: 'inv-1', customerId: 'c1', dbh: dbiWith(INV) })).resolves.toBe('open');
    mockGuard.mockResolvedValue({ ok: false });
    await expect(paymentIntentStateOf({ invoiceId: 'inv-1', customerId: 'c1', dbh: dbiWith(INV) })).resolves.toBe('blocked');
    await expect(paymentIntentStateOf({ invoiceId: 'inv-1', customerId: 'c2', dbh: dbiWith(INV) })).resolves.toBe('unreadable');
  });
});
