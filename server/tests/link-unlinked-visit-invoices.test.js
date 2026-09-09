jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded'] }));
jest.mock('../services/scheduled-invoice-mint', () => ({
  assertScheduledInvoiceNotPacketOwned: jest.fn(),
}));
const { evaluate, pairingDigest, invoiceBillsVisitApplication, isCompositeService, readPlan, formatPairing } = require('../../ops/agents/link-unlinked-visit-invoices');
const { assertScheduledInvoiceNotPacketOwned } = require('../services/scheduled-invoice-mint');
const fs = require('fs');
const os = require('os');
const path = require('path');

// In-memory query boundary; no application startup, credentials, or DB writes.
function fixture({ invoice = {}, visit = {}, customer = {}, payers = [], records = [], attempt = null } = {}) {
  const inv = { id: 'invoice', customer_id: 'customer', status: 'paid', service_date: '2020-01-01',
    line_items: [{ description: 'Pest Control', amount: 100 }], total: 100, tax_rate: 0, tax_amount: 0,
    payer_id: null, ...invoice };
  const svc = { id: 'visit', customer_id: 'customer', scheduled_date: '2020-01-01',
    status: 'completed', service_type: 'Pest Control', technician_id: 'tech-new', ...visit };
  const cust = { id: 'customer', payer_id: null, ...customer };
  const conn = jest.fn((table) => {
    let existingLink = false; let payerId;
    const chain = {
      where(clause) { if (typeof clause === 'function') existingLink = true; else if (table === 'payers') payerId = clause.id; return chain; },
      whereNull: () => chain, whereNotNull: () => chain, whereNotIn: () => chain,
      whereRaw: () => chain, whereNot: () => chain, whereIn: () => chain, orderBy: () => chain,
      modify(fn) { fn(chain); return chain; },
      first() {
        if (table === 'invoices') return Promise.resolve(existingLink ? null : inv);
        if (table === 'scheduled_services') return Promise.resolve(svc);
        if (table === 'customers') return Promise.resolve(cust);
        if (table === 'payers') return Promise.resolve(payers.find((p) => p.id === payerId));
        if (table === 'service_completion_attempts') return Promise.resolve(attempt);
        return Promise.resolve(null);
      },
      select() {
        return Promise.resolve(table === 'invoices' ? [inv] : table === 'scheduled_services' ? [svc] : table === 'service_records' ? records : []);
      },
    };
    return chain;
  });
  conn.raw = jest.fn().mockResolvedValue({});
  conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
  return { conn, inv, svc };
}
const run = (f) => evaluate(f.conn, 'invoice');

describe('historical invoice repair Bill-To and reviewed mutations', () => {
  test('refuses an invoice billed to the customer default instead of the per-job payer', async () => {
    const f = fixture({ invoice: { payer_id: 1 }, customer: { payer_id: 1 }, visit: { payer_id: 2 }, payers: [{ id: 2, active: true }] });
    expect(await run(f)).toEqual({ skip: 'billToMismatch' });
  });
  test('honors an explicit self-pay visit over the customer payer', async () => {
    const f = fixture({ invoice: { payer_id: 1 }, customer: { payer_id: 1 }, visit: { self_pay_override: true } });
    expect(await run(f)).toEqual({ skip: 'billToMismatch' });
  });
  test('refuses a missing frozen PO even when the payer matches', async () => {
    const f = fixture({ invoice: { payer_id: 2 }, visit: { payer_id: 2, po_number: 'PO-TEST' }, payers: [{ id: 2, active: true }] });
    expect(await run(f)).toEqual({ skip: 'billToMismatch' });
  });
  test('refuses tax charged to an exempt payer', async () => {
    const f = fixture({ invoice: { payer_id: 2, tax_rate: 0.07, tax_amount: 7 }, visit: { payer_id: 2 }, payers: [{ id: 2, active: true, tax_exempt: true }] });
    expect(await run(f)).toEqual({ skip: 'payerTaxMismatch' });
  });
  test('accepts matching payer/PO with exemption', async () => {
    const f = fixture({ invoice: { payer_id: 2, po_number: 'PO-TEST' }, visit: { payer_id: 2, po_number: 'PO-TEST' }, payers: [{ id: 2, active: true, tax_exempt: true }] });
    expect((await run(f)).pairing).toBeDefined();
  });
  test('payer lookup failures abort instead of falling back to homeowner billing', async () => {
    const f = fixture({ visit: { payer_id: 2 } });
    const base = f.conn.getMockImplementation();
    f.conn.mockImplementation((table) => {
      if (table === 'payers') throw new Error('payer lookup unavailable');
      return base(table);
    });
    await expect(run(f)).rejects.toThrow('payer lookup unavailable');
  });
  test.each([null, 'tech-old'])('records the previous and resulting technician (%s)', async (previous) => {
    const f = fixture({ invoice: { technician_id: previous } });
    expect((await run(f)).pairing).toMatchObject({ previousTechnicianId: previous, technicianId: 'tech-new' });
  });
  test('keeps the existing invoice technician when the visit has none', async () => {
    const f = fixture({ invoice: { technician_id: 'tech-old' }, visit: { technician_id: null } });
    expect((await run(f)).pairing).toMatchObject({ previousTechnicianId: 'tech-old', technicianId: 'tech-old' });
  });
  test('review digest changes for payer policy, PO, self-pay override, and invoice tax edits', () => {
    const { inv, svc } = fixture();
    const billTo = { payerId: 2, taxExempt: false };
    const initial = pairingDigest(inv, svc, null, billTo);
    expect(pairingDigest(inv, svc, null, { ...billTo, taxExempt: true })).not.toBe(initial);
    expect(pairingDigest({ ...inv, po_number: 'changed' }, svc, null, billTo)).not.toBe(initial);
    expect(pairingDigest(inv, { ...svc, self_pay_override: true }, null, billTo)).not.toBe(initial);
    expect(pairingDigest({ ...inv, tax_rate: 0.07 }, svc, null, billTo)).not.toBe(initial);
  });
});

describe('conservative historical repair evidence', () => {
  test.each([
    { visit: { is_callback: true } },
    { records: [{ id: 'record', is_callback: true }] },
    { records: [{ id: 'record', is_callback: false }, { id: 'recap', is_callback: true }] },
  ])('rejects callback evidence on a visit or any sibling record: %j', async (input) => {
    expect(await run(fixture(input))).toEqual({ skip: 'callback' });
  });
  test.each([
    'Quarterly Pest + Termite Bait Station Service', 'Pest & Rodent Control',
    'Lawn & Tree Shrub Combo', 'Pest Control and Mosquito Control',
    'pest_termite_bait_quarterly', 'lawn_tree_shrub_combo',
  ])('rejects a composite visit even without add-on rows: %s', async (label) => {
    expect(isCompositeService(label)).toBe(true);
    expect(await run(fixture({ visit: { service_type: label } }))).toEqual({ skip: 'compositeVisit' });
  });
  test('rejects a retired combined snapshot behind a generic label', async () => {
    expect(await run(fixture({ visit: { service_key_snapshot: 'pest_termite_bait_quarterly' } })))
      .toEqual({ skip: 'compositeVisit' });
  });
  test('keeps Tree & Shrub as one program', () => {
    expect(isCompositeService('Tree & Shrub Care')).toBe(false);
    expect(invoiceBillsVisitApplication({ line_items: [{ description: 'Tree & Shrub Care', amount: 50 }] },
      { service_type: 'Tree & Shrub Care' })).toBe(true);
  });
  test.each([
    [{ description: 'Pest Control', amount: 100 }],
    [{ description: 'Pest Control', unit_price: 50, quantity: 2 }],
    [{ description: 'Pest Control', amount: 100 }, { description: 'Discount', amount: -10 }],
  ].map((line_items) => ({ line_items })))('accepts positive application evidence: %j', ({ line_items }) => {
    expect(invoiceBillsVisitApplication({ line_items }, { service_type: 'Pest Control' })).toBe(true);
  });
  test.each([
    [{ description: 'Pest Control supplies', amount: 100 }],
    [{ description: 'Pest Control renewal', amount: 100 }],
    [{ description: 'Pest Control callback', amount: 100 }],
    [{ description: 'Pest Control', amount: 0 }],
    [{ description: 'Pest Control', amount: 100 }, { description: 'Mosquito Control', amount: 50 }],
    [{ description: 'Pest Control + Termite Bait', amount: 100 }],
  ].map((line_items) => ({ line_items })))('refuses non-application or conflicting evidence: %j', ({ line_items }) => {
    expect(invoiceBillsVisitApplication({ line_items }, { service_type: 'Pest Control' })).toBe(false);
  });
  test.each([
    ['Pest Inspection Service', 'Quarterly Pest Control Service'],
    ['Termite Inspection Service', 'Termite Bait Station Service'],
    ['Termite Foam Service', 'Termite Bait Station Service'],
    ['Pest Control Re-Service', 'Quarterly Pest Control Service'],
    ['WDO Inspection Service', 'Pest Control'],
    ['Pest Inspection Service', 'Pest Inspection Service'],
  ])('refuses %s as application evidence for %s', (description, service_type) => {
    expect(invoiceBillsVisitApplication({ line_items: [{ description, amount: 100 }] }, { service_type })).toBe(false);
  });
  test.each([false, true])('a matching line cannot hide another same-family application (reverse=%s)', (reverse) => {
    const line_items = ['Termite Bait Station Service', 'Termite Foam Service']
      .map((description) => ({ description, amount: 100 }));
    if (reverse) line_items.reverse();
    expect(invoiceBillsVisitApplication({ line_items }, { service_type: 'Termite Bait Station Service' })).toBe(false);
  });
  test('propagates closeout lookup failures rather than reporting a packet exclusion', async () => {
    assertScheduledInvoiceNotPacketOwned.mockRejectedValueOnce(new Error('lookup failed'));
    await expect(run(fixture())).rejects.toThrow('lookup failed');
  });
  test('refuses an existing packet', async () => {
    assertScheduledInvoiceNotPacketOwned.mockRejectedValueOnce(Object.assign(new Error('owned'), { code: 'VISIT_PACKET_OWNS_BILLING' }));
    expect(await run(fixture())).toEqual({ skip: 'packetOwned' });
  });
  test.each([
    { records: [{ id: 'only' }], expected: 'only' },
    { records: [{ id: 'one' }, { id: 'two' }], expected: null },
    { records: [{ id: 'one' }, { id: 'two' }], attempt: { service_record_id: 'one' }, expected: 'one' },
    { records: [{ id: 'one' }, { id: 'two' }], attempt: { service_record_id: 'foreign' }, expected: null },
  ])('uses only a canonical completion record: %j', async ({ expected, ...input }) => {
    expect((await run(fixture(input))).pairing.serviceRecordId).toBe(expected);
  });
  test('previews clearing a stale technician name on reassignment', async () => {
    const { pairing } = await run(fixture({ invoice: { technician_id: 'tech-old', tech_name: 'Test Technician' } }));
    expect(pairing).toMatchObject({ previousTechName: 'Test Technician', techName: null });
    expect(formatPairing(pairing)).toContain('tech_name "Test Technician" -> null');
  });
  test.each(['tech-old', null])('preserves the name when the visit does not reassign the invoice (%s)', async (technician_id) => {
    const { pairing } = await run(fixture({ invoice: { technician_id: 'tech-old', tech_name: 'Test Technician' }, visit: { technician_id } }));
    expect(pairing).toMatchObject({ technicianId: 'tech-old', techName: 'Test Technician' });
  });
  test('binds record evidence, callback flags, composite snapshot, and technician name to review', () => {
    const { inv, svc } = fixture();
    const digest = pairingDigest(inv, svc, null, {});
    expect(pairingDigest({ ...inv, tech_name: 'Changed' }, svc, null, {})).not.toBe(digest);
    expect(pairingDigest(inv, { ...svc, is_callback: true }, null, {})).not.toBe(digest);
    expect(pairingDigest(inv, { ...svc, service_key_snapshot: 'pest_termite_bait_quarterly' }, null, {})).not.toBe(digest);
    expect(pairingDigest(inv, svc, null, {}, [{ id: 'new', is_callback: false }])).not.toBe(digest);
  });
});

describe('reviewed plan input', () => {
  let dir; let file;
  const pair = { invoiceId: '11111111-1111-4111-8111-111111111111', visitId: '22222222-2222-4222-8222-222222222222', digest: 'a'.repeat(64) };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-plan-test-')); file = path.join(dir, 'plan.json'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  test.each([
    [{ pairings: [pair] }, /version/],
    [{ version: 1, pairings: [pair] }, /version/],
    [{ version: 2, pairings: [] }, /no pairings/],
    [{ version: 2, pairings: [null] }, /Malformed/],
    [{ version: 2, pairings: [{ ...pair, digest: undefined }] }, /Malformed/],
    [{ version: 2, pairings: [pair, pair] }, /Duplicate/],
  ])('refuses an obsolete, empty, malformed, or duplicate plan: %j', (input, error) => {
    fs.writeFileSync(file, JSON.stringify(input));
    expect(() => readPlan(file)).toThrow(error);
  });
  test('accepts a current reviewed plan', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 2, pairings: [pair] }));
    expect(readPlan(file)).toEqual([pair]);
  });
  test('the planner rejects --execute before attempting a connection', () => {
    const { spawnSync } = require('child_process');
    const result = spawnSync(process.execPath, ['ops/agents/link-unlinked-visit-invoices.js', '--execute'],
      { cwd: path.join(__dirname, '../..'), env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Read-only planner');
  });
});
