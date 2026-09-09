jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice', () => ({ CANCELLED_SERVICE_RESOLVED_STATUSES: ['void', 'refunded'] }));
jest.mock('../services/recurring-appointment-seeder', () => ({ serviceKeyFor: () => 'pest_control' }));
jest.mock('../services/scheduled-invoice-mint', () => ({
  acquireScheduledMintLockChain: jest.fn(),
  assertScheduledInvoiceNotPacketOwned: jest.fn(),
}));
const { evaluate, pairingDigest } = require('../../ops/agents/link-unlinked-visit-invoices');
const { acquireScheduledMintLockChain } = require('../services/scheduled-invoice-mint');

// In-memory query boundary; no application startup, credentials, or DB writes.
function fixture({ invoice = {}, visit = {}, customer = {}, payers = [] } = {}) {
  const inv = { id: 'invoice', customer_id: 'customer', status: 'paid', service_date: '2020-01-01',
    line_items: [{ description: 'Pest Control', amount: 100 }], total: 100, tax_rate: 0, tax_amount: 0,
    payer_id: null, ...invoice };
  const svc = { id: 'visit', customer_id: 'customer', scheduled_date: '2020-01-01',
    status: 'completed', service_type: 'Pest Control', technician_id: 'tech-new', ...visit };
  const cust = { id: 'customer', payer_id: null, ...customer };
  const locks = [];
  const conn = jest.fn((table) => {
    let existingLink = false; let payerId;
    const chain = {
      where(clause) { if (typeof clause === 'function') existingLink = true; else if (table === 'payers') payerId = clause.id; return chain; },
      whereNull: () => chain, whereNotNull: () => chain, whereNotIn: () => chain,
      whereRaw: () => chain, whereNot: () => chain, whereIn: () => chain, orderBy: () => chain,
      modify(fn) { fn(chain); return chain; },
      forUpdate() { locks.push(table); return chain; },
      first() {
        if (table === 'invoices') return Promise.resolve(existingLink ? null : inv);
        if (table === 'scheduled_services') return Promise.resolve(svc);
        if (table === 'customers') return Promise.resolve(cust);
        if (table === 'payers') return Promise.resolve(payers.find((p) => p.id === payerId));
        return Promise.resolve(null);
      },
      select() {
        return Promise.resolve(table === 'invoices' ? [inv] : table === 'scheduled_services' ? [svc] : []);
      },
    };
    return chain;
  });
  conn.raw = jest.fn().mockResolvedValue({});
  conn.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
  acquireScheduledMintLockChain.mockResolvedValue(svc);
  return { conn, locks, inv, svc };
}
const run = (f, lock = false) => evaluate(f.conn, 'invoice', new Set(), { lock });

describe('historical invoice repair Bill-To and reviewed mutations', () => {
  test.each([false, true])('refuses an invoice billed to the customer default instead of the per-job payer (lock=%s)', async (lock) => {
    const f = fixture({ invoice: { payer_id: 1 }, customer: { payer_id: 1 }, visit: { payer_id: 2 }, payers: [{ id: 2, active: true }] });
    expect(await run(f, lock)).toEqual({ skip: 'billToMismatch' });
    if (lock) expect(f.locks).toContain('payers');
  });
  test('honors an explicit self-pay visit over the customer payer', async () => {
    const f = fixture({ invoice: { payer_id: 1 }, customer: { payer_id: 1 }, visit: { self_pay_override: true } });
    expect(await run(f, true)).toEqual({ skip: 'billToMismatch' });
  });
  test('refuses a missing frozen PO even when the payer matches', async () => {
    const f = fixture({ invoice: { payer_id: 2 }, visit: { payer_id: 2, po_number: 'PO-TEST' }, payers: [{ id: 2, active: true }] });
    expect(await run(f)).toEqual({ skip: 'billToMismatch' });
  });
  test('refuses tax charged to an exempt payer', async () => {
    const f = fixture({ invoice: { payer_id: 2, tax_rate: 0.07, tax_amount: 7 }, visit: { payer_id: 2 }, payers: [{ id: 2, active: true, tax_exempt: true }] });
    expect(await run(f, true)).toEqual({ skip: 'payerTaxMismatch' });
  });
  test('accepts matching payer/PO with exemption and locks the payer', async () => {
    const f = fixture({ invoice: { payer_id: 2, po_number: 'PO-TEST' }, visit: { payer_id: 2, po_number: 'PO-TEST' }, payers: [{ id: 2, active: true, tax_exempt: true }] });
    expect((await run(f, true)).pairing).toBeDefined();
    expect(f.locks).toContain('payers');
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
