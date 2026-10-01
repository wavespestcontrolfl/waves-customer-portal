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
  // Codex round-55 P1: WHOLE ROWS, not column lists - every billing table the recheck can read is hashed row by row in full, so a
  // column (dues eligibility, pause, ACH health, card expiry, retry state, credit, ...) can never be left out
  test('one content hash over the WHOLE rows of every billing table the recheck reads', () => {
    expect(BILLING_FINGERPRINT_SQL).toMatch(/md5\(concat_ws/);
    for (const t of ['FROM payments t WHERE t.customer_id = ?', 'FROM invoices t WHERE t.customer_id = ?',
      'FROM stripe_invoice_charge_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE i.customer_id = ?', 'FROM payment_plans t WHERE t.customer_id = ?',
      'FROM scheduled_services t', 'self_pay_override IS TRUE', 'FROM payers p', 'FROM estimate_deposits d', 'FROM customers c WHERE c.id = ?',
      'FROM payment_methods t WHERE t.customer_id = ?', 'FROM annual_prepay_terms t WHERE t.customer_id = ?']) expect(BILLING_FINGERPRINT_SQL).toContain(t);
    // every fragment hashes the row itself (md5(<alias>::text)), never a hand-picked column list
    expect(BILLING_FINGERPRINT_SQL).not.toMatch(/concat_ws\('\|'/);
    expect((BILLING_FINGERPRINT_SQL.match(/md5\((?:t|a|p|d|c)::text\)/g) || []).length).toBe(10);
    expect((BILLING_FINGERPRINT_SQL.match(/\?/g) || []).length).toBe(12);
  });
  test('reads through the given connection; null on no customer, a failed read, or no row', async () => {
    const dbh = { raw: jest.fn(async () => ({ rows: [{ fingerprint: 'abc' }] })) };
    expect(await billingFingerprint('c1', dbh)).toBe('abc');
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, Array(12).fill('c1'));
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



// Codex round-53: retry fields drive the failed-payment balance; a denial approved with Zelle off is rechecked when it is set up
describe('a denial that stood because Zelle was not set up', () => {
  const dbiWith = () => { const dbi = jest.fn(); dbi.raw = async () => ({ rows: [{ fingerprint: 'abc' }] }); return dbi; };
  const denial = (zelleDenial) => billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc', zelleDenial, getBody: () => "We don't accept Zelle." });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; mockEligible.mockReset(); mockEligible.mockResolvedValue({ eligible: true }); });
  test('still not set up => ok; set up during the send => refused (retryable)', async () => {
    delete process.env.ZELLE_RECIPIENT;
    await expect(denial({ invoiceId: null, recipientConfigured: false })({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    await expect(denial({ invoiceId: null, recipientConfigured: false })({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', retryable: true });
  });
  test('a no-open-invoice denial (recipient set) stands while the recipient stays set', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    await expect(denial({ invoiceId: null, recipientConfigured: true })({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    delete process.env.ZELLE_RECIPIENT;
    await expect(denial({ invoiceId: null, recipientConfigured: true })({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false });
  });
});

