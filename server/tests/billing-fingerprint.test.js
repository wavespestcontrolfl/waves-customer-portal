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
      'FROM payment_methods t WHERE t.customer_id = ?', 'FROM annual_prepay_terms t WHERE t.customer_id = ?',
      // the visits of a prepaid plan (the "visits left" sentence): the stamped rows and their whole series
      't.prepaid_amount > 0', 't.annual_prepay_term_id IS NOT NULL', "t.prepaid_method = 'annual_prepay_invoice'", 'COALESCE(t.recurring_parent_id, t.id) IN',
      // the customer's open estimates (the estimate price sentence)
      "FROM estimates t WHERE t.customer_id = ? AND t.status IN ('sent', 'viewed') AND t.archived_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())"]) expect(BILLING_FINGERPRINT_SQL).toContain(t);
    // every fragment hashes the row itself (md5(<alias>::text)), never a hand-picked column list
    expect(BILLING_FINGERPRINT_SQL).not.toMatch(/concat_ws\('\|'/);
    expect((BILLING_FINGERPRINT_SQL.match(/md5\((?:t|a|p|d|c|k|l|m|v)::text\)/g) || []).length).toBe(16);
    expect((BILLING_FINGERPRINT_SQL.match(/\?/g) || []).length).toBe(21);
  });
  // Owner 2026-11-26 (the texting AI answers call-drafted and new-home estimates): those estimates are on the customer's own page only while
  // the call-side verdict passes, so every row that verdict reads is hashed: a change to one refuses the send, like a change to the estimate.
  test('the rows the call-side verdict of an open estimate reads: its call, the leads its linkage resolves, its move', () => {
    const openEstimates = "FROM estimates t WHERE t.customer_id = ? AND t.status IN ('sent', 'viewed') AND t.archived_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())";
    const uuidOf = (field) => `CASE WHEN (${field}) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${field})::uuid END`;
    const calls = `SELECT ${uuidOf("t.estimate_data #>> '{estimatorEngine,callLogId}'")} ${openEstimates}`;
    for (const fragment of [
      `(SELECT string_agg(md5(k::text), ',' ORDER BY k.id) FROM call_log k WHERE k.id IN (${calls}))`,
      // each lead on the call's sid (a new or deleted one changes the set) and the lead the estimate names
      `SELECT s.id FROM call_log k JOIN leads s ON s.twilio_call_sid = k.twilio_call_sid WHERE k.id IN (${calls})`,
      `UNION SELECT ${uuidOf("t.estimate_data ->> 'lead_id'")} ${openEstimates}`,
      `(SELECT string_agg(md5(m::text), ',' ORDER BY m.id) FROM customer_moves m WHERE m.id IN (SELECT ${uuidOf("t.estimate_data #>> '{move,moveId}'")} ${openEstimates}))`,
    ]) expect(BILLING_FINGERPRINT_SQL).toContain(fragment);
    // an id that is not a uuid is never cast (a failed cast would fail the read for every send): each cast sits behind its own shape test
    expect((BILLING_FINGERPRINT_SQL.match(/::uuid/g) || []).length).toBe((BILLING_FINGERPRINT_SQL.match(/CASE WHEN \(t\.estimate_data [^)]+\) ~\* /g) || []).length);
    // no SQL comment and no named binding: the statement is sent as written, with one positional binding per ?
    expect(BILLING_FINGERPRINT_SQL).not.toMatch(/--|\/\*/);
  });
  // Owner 2026-11-26 (the setup fee and the pay-for-the-year total): an open estimate is priced against the customer's live plan (member
  // pricing), and its pay-for-the-year total is stated only to a customer with none. A plan that starts, ends or changes refuses the send.
  test('the live plan of a customer with an open estimate: the recurring visits not yet finished, by the statuses of the module that owns them', () => {
    const { TERMINAL_STATUSES } = require('../services/waveguard-existing-services');
    const openEstimates = "FROM estimates t WHERE t.customer_id = ? AND t.status IN ('sent', 'viewed') AND t.archived_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())";
    expect(TERMINAL_STATUSES.length).toBeGreaterThan(0);
    expect(BILLING_FINGERPRINT_SQL).toContain(`(SELECT string_agg(md5(v::text), ',' ORDER BY v.id) FROM scheduled_services v WHERE v.customer_id = ? AND v.is_recurring IS TRUE `
      + `AND v.status NOT IN (${TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ')}) AND EXISTS (SELECT 1 ${openEstimates}))`);
  });
  test('reads through the given connection; null on no customer, a failed read, or no row', async () => {
    const dbh = { raw: jest.fn(async () => ({ rows: [{ fingerprint: 'abc' }] })) };
    expect(await billingFingerprint('c1', dbh)).toBe(FP);
    expect(dbh.raw).toHaveBeenCalledWith(BILLING_FINGERPRINT_SQL, Array(21).fill('c1'));
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
