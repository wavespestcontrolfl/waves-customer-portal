/**
 * Codex round-48/49 P1 (PR #5331): the billing fingerprint the send paths take BEFORE their full billing recheck and re-read at the
 * provider boundary on the handoff connection.
 */
jest.mock('../models/db', () => jest.fn());
const mockEligible = jest.fn(async () => ({ eligible: true }));
jest.mock('../services/sms-amount-recheck', () => ({
  ...jest.requireActual('../services/sms-amount-recheck'),
  zelleInvoiceStillEligible: (...a) => mockEligible(...a),
}));
const { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL } = require('../services/billing-fingerprint');

describe('billingFingerprint', () => {
  test('one content hash over every row the recheck reads: payments, invoices, plans, payer assignments', () => {
    expect(BILLING_FINGERPRINT_SQL).toMatch(/md5\(concat_ws/);
    for (const t of ['FROM payments WHERE customer_id = ?', 'FROM invoices WHERE customer_id = ?', 'FROM payment_plans WHERE customer_id = ?',
      'FROM payers p', 'FROM customers WHERE id = ?']) expect(BILLING_FINGERPRINT_SQL).toContain(t);
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
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, Array(10).fill('c1'));
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

// Owner ruling 2026-10-01 ("rerun full check"): a Zelle offer / denial reruns the SAME eligibility the full recheck ran, at the boundary
describe('Zelle at the provider boundary: the full recheck\'s own checks run again', () => {
  const dbiWith = () => { const dbi = jest.fn(); dbi.raw = async () => ({ rows: [{ fingerprint: 'abc' }] }); return dbi; };
  const run = (over) => billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc', ...over });
  beforeEach(() => { process.env.ZELLE_RECIPIENT = 'pay@example.com'; });
  afterEach(() => { mockEligible.mockReset(); mockEligible.mockResolvedValue({ eligible: true }); delete process.env.ZELLE_RECIPIENT; });
  test('an offer: still eligible => ok (on the invoice the recheck resolved, through the handoff connection)', async () => {
    const dbi = dbiWith();
    await expect(run({ zelleInvoiceId: 'inv-1', getBody: () => 'You can Zelle us at pay@example.com.' })({ dbi })).resolves.toEqual({ ok: true });
    expect(mockEligible).toHaveBeenCalledWith({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbi });
  });
  test.each(['payment_in_flight', 'zelle_invoice_ineligible', 'credit_unverifiable', 'zelle_invoice_unresolved'])(
    'an offer whose invoice became ineligible after the recheck (%s: a deposit, a payment in flight, credit, ...) is refused', async (reason) => {
      mockEligible.mockResolvedValue({ eligible: false, reason });
      await expect(run({ zelleInvoiceId: 'inv-1', getBody: () => 'You can Zelle us at pay@example.com.' })({ dbi: dbiWith() }))
        .resolves.toMatchObject({ ok: false, code: 'ZELLE_OFFER_UNSENDABLE_AT_BOUNDARY', retryable: true });
    },
  );
  test('an offer whose recipient was removed or rotated is refused without the eligibility read', async () => {
    process.env.ZELLE_RECIPIENT = 'new@example.com';
    await expect(run({ zelleInvoiceId: 'inv-1', getBody: () => 'You can Zelle us at old@example.com.' })({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false });
    delete process.env.ZELLE_RECIPIENT;
    await expect(run({ zelleInvoiceId: 'inv-1', getBody: () => 'You can Zelle us at old@example.com.' })({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false });
    expect(mockEligible).not.toHaveBeenCalled();
  });
  test('a denial stands while its invoice is still confirmed ineligible; Zelle available now or unverifiable => refused', async () => {
    const denial = run({ zelleDenial: { invoiceId: 'inv-1' }, getBody: () => "Zelle isn't available for your invoice right now." });
    mockEligible.mockResolvedValue({ eligible: false, reason: 'zelle_invoice_ineligible' });
    await expect(denial({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    mockEligible.mockResolvedValue({ eligible: true });
    await expect(denial({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', retryable: true });
    mockEligible.mockResolvedValue({ eligible: false, reason: 'zelle_recheck_failed' });
    await expect(denial({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false, retryable: true });
  });
  test('a body with no Zelle claim never runs the eligibility read', async () => {
    await expect(run({ zelleInvoiceId: 'inv-1', getBody: () => 'Your account balance is $95.00.' })({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    expect(mockEligible).not.toHaveBeenCalled();
  });
});

// Codex round-51 P1: account credit that would cover the invoice is billing state too
test('the fingerprint hashes the customer\'s account credit and auto-apply setting', () => {
  expect(BILLING_FINGERPRINT_SQL).toContain("concat_ws('|', 'c', payer_id, account_credits, auto_apply_account_credit) FROM customers WHERE id = ?");
});

// Local Codex review pass 1: payer activation, self-pay overrides and the estimate-deposit ledger are billing state too
test('the fingerprint hashes payer activation, self-pay overrides and estimate deposits', () => {
  expect(BILLING_FINGERPRINT_SQL).toContain("concat_ws('|', p.id, p.active)");
  expect(BILLING_FINGERPRINT_SQL).toContain('self_pay_override IS TRUE');
  expect(BILLING_FINGERPRINT_SQL).toContain('FROM estimate_deposits d');
  expect((BILLING_FINGERPRINT_SQL.match(/\?/g) || []).length).toBe(10);
});
