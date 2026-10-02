/**
 * Codex round-48/49 P1 (PR #5331): the billing fingerprint the send paths take BEFORE their full billing recheck and re-read at the
 * provider boundary on the handoff connection.
 */
jest.mock('../models/db', () => jest.fn());
const mockLive = jest.fn(async () => ({ state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' }));
jest.mock('../services/sms-amount-recheck', () => ({
  ...jest.requireActual('../services/sms-amount-recheck'),
  liveZelleFacts: (...a) => mockLive(...a),
}));
const { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL } = require('../services/billing-fingerprint');
// billingFingerprint appends the ET calendar day (Codex round-59 P2): a SAVED fingerprint carries it, the raw row hash does not
const FP = `abc@${require('../utils/datetime-et').etDateString()}`;

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
    expect(await billingFingerprint('c1', dbh)).toBe(FP);
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, Array(12).fill('c1'));
    expect(await billingFingerprint(null, dbh)).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => { throw new Error('down'); } })).toBeNull();
    expect(await billingFingerprint('c1', { raw: async () => ({ rows: [] }) })).toBeNull();
  });
});

describe('billingUnchangedProviderPreSendCheck', () => {
  const dbiWith = (fp) => ({ raw: async () => ({ rows: [{ fingerprint: fp }] }) });
  test('unchanged => ok; changed / unreadable / never taken => retryable refusal; repeatable after the marker', async () => {
    const check = billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: FP });
    expect(check.afterMarker).toBe(check);
    await expect(check({ dbi: dbiWith('abc') })).resolves.toEqual({ ok: true });
    await expect(check({ dbi: dbiWith('xyz') })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
    await expect(check({ dbi: { raw: async () => { throw new Error('down'); } } })).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: null })({ dbi: dbiWith('abc') })).resolves.toMatchObject({ ok: false, retryable: true });
  });
});

// Owner ruling 2026-10-01: when the send-time verdict stood on live Zelle facts (a copied Zelle sentence, or a staff Zelle contact), the
// boundary re-reads them (liveZelleFacts) and refuses when the recipient, the invoice or the state moved.
describe('Zelle at the provider boundary: the live facts are re-read and must be unchanged', () => {
  const dbiWith = () => { const dbi = jest.fn(); dbi.raw = async () => ({ rows: [{ fingerprint: 'abc' }] }); return dbi; };
  const OFFER = { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' };
  const run = (zelle) => billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: FP, zelle });
  afterEach(() => { mockLive.mockReset(); mockLive.mockResolvedValue({ ...OFFER }); });
  test('unchanged facts => ok (re-read for the same invoice, through the handoff connection)', async () => {
    const dbi = dbiWith();
    await expect(run({ ...OFFER })({ dbi })).resolves.toEqual({ ok: true });
    expect(mockLive).toHaveBeenCalledWith({ customerId: 'c1', invoiceId: 'inv-1', dbh: dbi });
  });
  test.each([
    ['the state flipped (the invoice stopped taking Zelle: a deposit, a payment in flight, credit, ...)', { state: 'invoice_unavailable' }],
    ['the state became unverifiable', { state: null }],
    ['the recipient was rotated', { recipient: 'new@example.com' }],
    ['the recipient was removed', { state: 'not_offered', recipient: null }],
    ['the invoice number changed', { invoiceNumber: 'WPC-2026-0009' }],
  ])('%s => refused (retryable)', async (_name, change) => {
    mockLive.mockResolvedValue({ ...OFFER, ...change });
    await expect(run({ ...OFFER })(({ dbi: dbiWith() }))).resolves.toMatchObject({ ok: false, code: 'ZELLE_CHANGED_AT_BOUNDARY', retryable: true });
  });
  test('an unavailability / not-offered sentence is re-read too: Zelle becoming available (or set up) refuses it', async () => {
    const unavailable = { state: 'invoice_unavailable', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' };
    mockLive.mockResolvedValue({ ...unavailable });
    await expect(run(unavailable)({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    mockLive.mockResolvedValue({ ...OFFER });
    await expect(run(unavailable)({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false, code: 'ZELLE_CHANGED_AT_BOUNDARY' });
    const notOffered = { state: 'not_offered', invoiceId: null, invoiceNumber: null, recipient: null };
    mockLive.mockResolvedValue({ ...notOffered });
    await expect(run(notOffered)({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    mockLive.mockResolvedValue({ ...OFFER });
    await expect(run(notOffered)({ dbi: dbiWith() })).resolves.toMatchObject({ ok: false, code: 'ZELLE_CHANGED_AT_BOUNDARY' });
  });
  test('no Zelle facts (the verdict stood on none) => the live read never runs', async () => {
    await expect(run(null)({ dbi: dbiWith() })).resolves.toEqual({ ok: true });
    expect(mockLive).not.toHaveBeenCalled();
  });
});

// Codex round-57 P1: the fingerprint is the LAST boundary read - a payment changing during the Zelle reads is caught
test('the fingerprint is read after the Zelle checks', async () => {
  const order = [];
  mockLive.mockImplementation(async () => { order.push('zelle'); return { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' }; });
  const dbi = jest.fn();
  dbi.raw = async () => { order.push('fingerprint'); return { rows: [{ fingerprint: 'abc' }] }; };
  const check = billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: FP, zelle: { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'pay@example.com' } });
  try {
    await expect(check({ dbi })).resolves.toEqual({ ok: true });
    expect(order).toEqual(['zelle', 'fingerprint']);
  } finally { mockLive.mockReset(); }
});

// Codex round-59 P2: crossing ET midnight between the recheck and the provider call refuses (card expiry / monthly eligibility)
test('a fingerprint saved on a previous ET day is refused at the boundary', async () => {
  const dbi = jest.fn(); dbi.raw = async () => ({ rows: [{ fingerprint: 'abc' }] });
  await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: 'abc@2000-01-01' })({ dbi })).resolves.toMatchObject({ ok: false, code: 'BILLING_CHANGED_AT_BOUNDARY', retryable: true });
  await expect(billingUnchangedProviderPreSendCheck({ customerId: 'c1', fingerprint: FP })({ dbi })).resolves.toEqual({ ok: true });
});
