// GATE_SETUP_FEE_SETTLED_ANYWHERE — the unminted-setup-fee alert, its
// completion hold and the alert reconcile all ask ONE predicate
// (setup-fee-obligation.setupFeeSettledElsewhere). Before it, a fee that was
// paid, waived or prepaid on an invoice that never cited the accepted
// estimate read as "never billed": the alert said "bill $99 + the visit
// again" and its hold stopped the visit's normal invoice (prod audit
// 2026-10-24: 4 of 4 alerts since 08-25 were false).
//
// The mock db tells three invoice reads apart: the estimate-stamped scan
// (notes ilike), the customer-wide settled scan (line_items::text whereRaw)
// and every other visit-linked read.

let mockTables = {};
let mockUpdates = [];
let mockCounters = {};

jest.mock('../models/db', () => {
  const handler = (table) => {
    mockCounters[table] = (mockCounters[table] || 0) + 1;
    const spec = mockTables[table];
    const state = { stamped: false, customerScan: false };
    const resolve = () => {
      let val = spec;
      if (table === 'invoices' && spec && !Array.isArray(spec) && typeof spec === 'object' && ('stamped' in spec || 'customer' in spec || 'other' in spec)) {
        if (state.customerScan) val = spec.customer;
        else if (state.stamped) val = spec.stamped;
        else val = spec.other;
      }
      return typeof val === 'function' ? val(mockCounters[table]) : val;
    };
    const chain = {};
    ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereRaw', 'orWhereIn', 'orderBy', 'forUpdate', 'leftJoin', 'andWhere', 'orWhereNotNull', 'whereNotIn', 'whereExists'].forEach((m) => {
      chain[m] = jest.fn((...args) => {
        if (table === 'invoices' && m === 'where' && args[0] === 'notes') state.stamped = true;
        if (table === 'invoices' && m === 'whereRaw' && String(args[0]).includes('line_items::text')) state.customerScan = true;
        if (table === 'annual_prepay_terms as t') mockTermCalls.push([m, ...args]);
        if (m !== 'whereExists' && typeof args[0] === 'function') args[0].call(chain, chain);
        return chain;
      });
    });
    chain.first = jest.fn(async () => { const v = resolve(); return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); });
    chain.select = jest.fn(async () => { const v = resolve(); return Array.isArray(v) ? v : (v ? [v] : []); });
    chain.pluck = jest.fn(async () => []);
    chain.update = jest.fn(async (payload) => { mockUpdates.push({ table, payload }); return 1; });
    return chain;
  };
  const mock = jest.fn((table) => handler(table));
  mock.transaction = jest.fn(async (fn) => {
    const trx = (table) => handler(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = { now: jest.fn(() => 'NOW') };
    return fn(trx);
  });
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});

let mockTermCalls = [];

const db = require('../models/db');
const { findUnmintedSetupFeeObligation, setupFeeSettledElsewhere } = require('../services/setup-fee-obligation');
const { reconcileSetupFeeAlert } = require('../services/setup-fee-alert-reconcile');

const EST = 'e1000000-0000-0000-0000-000000000001';
const CUST = 'c1000000-0000-0000-0000-000000000001';
const GATE = 'GATE_SETUP_FEE_SETTLED_ANYWHERE';

const recent = new Date().toISOString();
// Case A / B: the fee paid on an ordinary visit invoice, named only
// "WaveGuard Membership", no estimate stamp in the notes.
const PAID_MEMBERSHIP = [{
  id: 'inv-visit-a', status: 'paid', created_at: recent, notes: null,
  line_items: [
    { description: 'Pest Control Service', category: 'Pest Control Service', amount: 97, quantity: 1, unit_price: 97 },
    { description: 'WaveGuard Membership', category: 'WaveGuard Membership', amount: 99, quantity: 1, unit_price: 99 },
  ],
}];
// Case C: a live invoice with an explicit $0 setup-fee line.
const WAIVED_LINE = [{
  id: 'inv-waived', status: 'viewed', created_at: recent,
  line_items: [
    { description: 'Quarterly Pest Control Service — 4 prepaid applications', amount: 432, quantity: 4, unit_price: 108 },
    { description: 'WaveGuard setup fee (waived)', amount: 0, quantity: 1, unit_price: 0 },
  ],
}];
// Case C': an annual prepay paid on a bundle invoice with no fee line at all.
const PAID_ANNUAL_PREPAY = [{
  id: 'inv-prepay', status: 'paid', created_at: recent,
  line_items: [{ description: 'Quarterly Pest Control - 4 prepaid applications', category: 'Annual prepay', amount: 495.96, quantity: 1, unit_price: 495.96 }],
}];

function estimateRow() {
  return {
    id: EST,
    customer_id: CUST,
    status: 'accepted',
    accepted_at: '2026-08-01T12:00:00Z',
    bill_by_invoice: false,
    estimate_slug: 'EST-2026-9901',
    estimate_data: JSON.stringify({ recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 29.33 }] } }),
  };
}

function obligationTables(invoices) {
  return {
    estimates: estimateRow(),
    'annual_prepay_terms as t': null,
    invoices: { stamped: [], customer: invoices, other: [] },
    activity_log: { id: 'log-1' },
    scheduled_services: null,
  };
}

let savedGate;
beforeEach(() => {
  savedGate = process.env[GATE];
  mockTables = {};
  mockUpdates = [];
  mockCounters = {};
  mockTermCalls = [];
});
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
});

describe('the detector behind the alert and the completion hold', () => {
  test.each([
    ['A/B: fee paid as a "WaveGuard Membership" line on another invoice', PAID_MEMBERSHIP, 'paid_fee'],
    ['C: live invoice with a waived $0 setup-fee line', WAIVED_LINE, 'waived'],
    ['C: annual prepay paid on a bundle invoice', PAID_ANNUAL_PREPAY, 'annual_prepay'],
  ])('gate ON, %s -> not owed (no alert, no hold)', async (_name, invoices, reason) => {
    process.env[GATE] = 'true';
    mockTables = obligationTables(invoices);
    const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
    expect(result.owed).toBe(false);
    expect(result.settledElsewhere.reason).toBe(reason);
  });

  test.each([
    ['A/B', PAID_MEMBERSHIP],
    ['C waived', WAIVED_LINE],
    ['C prepay', PAID_ANNUAL_PREPAY],
  ])('gate OFF, %s -> exactly the old behavior: still owed', async (_name, invoices) => {
    delete process.env[GATE];
    mockTables = obligationTables(invoices);
    const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
    expect(result.owed).toBe(true);
    expect(db).toHaveBeenCalledWith('estimates');
    // No customer-wide invoice scan runs with the gate off.
    expect(mockCounters.invoices).toBe(1);
  });

  test('gate ON, nothing settled elsewhere -> still owed (the alert still fires for a real miss)', async () => {
    process.env[GATE] = 'true';
    mockTables = obligationTables([]);
    expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST })).owed).toBe(true);
  });

  test.each([
    ['a partial $50 line never settles a $99 fee', [{ id: 'i', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 50 }] }]],
    ['an unpaid (sent) membership line is not collected money', [{ id: 'i', status: 'sent', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 99 }] }]],
    ['a void invoice settles nothing', [{ id: 'i', status: 'void', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 99 }] }]],
    ['a voided annual-prepay bundle ("setup fee waived") settles nothing', [{ id: 'i', status: 'void', created_at: recent, line_items: [{ description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)', amount: 388 }] }]],
    ['an annual prepay paid long ago is stale', [{ id: 'i', status: 'paid', created_at: '2024-01-01T00:00:00Z', line_items: [{ description: 'Prepaid', category: 'Annual prepay', amount: 400 }] }]],
    ['a paid rodent bait-station setup fee is not the WaveGuard fee', [{ id: 'i', status: 'paid', created_at: recent, line_items: [{ description: 'Bait Station Setup — one-time setup fee', amount: 150 }] }]],
    ['a $0 bait-station setup line is not a waived WaveGuard fee', [{ id: 'i', status: 'sent', created_at: recent, line_items: [{ description: 'Bait Station Setup — one-time setup fee (waived)', amount: 0 }] }]],
    ['a paid termite annual prepay is not a WaveGuard prepay', [{ id: 'i', status: 'paid', created_at: recent, line_items: [{ description: 'Termite Bait Monitoring — 12 months prepaid', category: 'Annual prepay', amount: 300 }] }]],
    ['a monthly membership-named line is not the one-time fee', [{ id: 'i', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership — Gold monthly', amount: 120 }] }]],
  ])('gate ON, %s', async (_name, invoices) => {
    process.env[GATE] = 'true';
    mockTables = obligationTables(invoices);
    expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST })).owed).toBe(true);
  });

  test('a covered annual-prepay TERM on the customer settles the fee, but never a termite annual plan', async () => {
    process.env[GATE] = 'true';
    mockTables = { 'annual_prepay_terms as t': { id: 'term-1' }, invoices: { stamped: [], customer: [], other: [] } };
    const result = await setupFeeSettledElsewhere(db, { customerId: CUST, expectedFeeCents: 9900 });
    expect(result).toMatchObject({ settled: true, reason: 'annual_prepay_term' });
    expect(mockTermCalls).toContainEqual(['where', 't.customer_id', CUST]);
    expect(mockTermCalls).toContainEqual(['whereNull', 't.annual_plan_version']);
  });

  test('gate ON, a paid fee that was later REFUNDED stays settled (never re-instruct); a refunded prepay bundle does not', async () => {
    process.env[GATE] = 'true';
    mockTables = obligationTables([{ ...PAID_MEMBERSHIP[0], status: 'refunded' }]);
    expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST })).owed).toBe(false);
    mockTables = obligationTables([{ id: 'i', status: 'refunded', created_at: recent, line_items: [{ description: 'WaveGuard Membership — 12 months prepaid (setup fee waived)', category: 'Annual prepay', amount: 388 }] }]);
    expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST })).owed).toBe(true);
  });

  test('the term check is bounded to the visit date (completion) and to a real date when none is known', async () => {
    process.env[GATE] = 'true';
    mockTables = { 'annual_prepay_terms as t': null, invoices: { stamped: [], customer: [], other: [] }, scheduled_services: { scheduled_date: '2026-10-23' } };
    await setupFeeSettledElsewhere(db, { customerId: CUST, expectedFeeCents: 9900, visitDate: '2026-10-23' });
    expect(mockTermCalls).toContainEqual(['where', 't.term_start', '<=', '2026-10-23']);
    mockTermCalls = [];
    await setupFeeSettledElsewhere(db, { customerId: CUST, expectedFeeCents: 9900 });
    expect(mockTermCalls.find((c) => c[1] === 't.term_start')[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe('partial fee money paid elsewhere reduces the remainder (completion alert + hold)', () => {
    const PARTIAL = { id: 'inv-part', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 50 }] };

    test('gate ON: $50 paid elsewhere against $99 -> still owed, $49 remains, partial carried for the caller', async () => {
      process.env[GATE] = 'true';
      mockTables = obligationTables([PARTIAL]);
      const r = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
      expect(r.owed).toBe(true);
      expect(r.setupFeeRemainingCents).toBe(4900);
      expect(r.settledElsewherePartial).toEqual([{ id: 'inv-part', cents: 5000 }]);
    });

    test('gate OFF: byte-identical -> full $99 remains and no partial key', async () => {
      delete process.env[GATE];
      mockTables = obligationTables([PARTIAL]);
      const r = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
      expect(r.setupFeeRemainingCents).toBe(9900);
      expect(r).not.toHaveProperty('settledElsewherePartial');
    });

    test('no double count: the same invoice already counted by the stamped scan is not subtracted twice', async () => {
      process.env[GATE] = 'true';
      const stampedPartial = { ...PARTIAL, notes: `accepted estimate #${EST}`, line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 50 }] };
      mockTables = { ...obligationTables([PARTIAL]), invoices: { stamped: [stampedPartial], customer: [PARTIAL], other: [] } };
      const r = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
      expect(r.owed).toBe(true);
      expect(r.setupFeeRemainingCents).toBe(4900); // 9900 - 5000, not 9900 - 10000
    });

    test('stamped partial + a DIFFERENT partial elsewhere that together cover the fee -> not owed', async () => {
      process.env[GATE] = 'true';
      const stamped = { id: 'inv-stamped', status: 'sent', notes: `accepted estimate #${EST}`, line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 50 }] };
      const other = { id: 'inv-other', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 49 }] };
      mockTables = { ...obligationTables([other]), invoices: { stamped: [stamped], customer: [other], other: [] } };
      const r = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST, customerId: CUST });
      expect(r.owed).toBe(false);
    });

    test('the completion path subtracts the carried partial at both its sites, deduped by invoice id', () => {
      const fs = require('fs');
      const src = fs.readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
      expect(src).toContain('partialElsewhereCents(unmintedSetupFeeObligation?.settledElsewherePartial, termFeeRows)');
      expect(src).toContain('partialElsewhereCents(unmintedSetupFeeObligation.settledElsewherePartial, [...liveStampedRows');
      const { partialElsewhereCents } = require('../services/setup-fee-obligation');
      const partial = [{ id: 'a', cents: 5000 }, { id: 'b', cents: 300 }];
      const counted = { id: 'a', line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 50 }] };
      expect(partialElsewhereCents(partial, [counted])).toBe(300);
      expect(partialElsewhereCents(partial, [{ id: 'a', line_items: [] }])).toBe(5300); // row counted none of it
      expect(partialElsewhereCents(partial, [])).toBe(5300);
      expect(partialElsewhereCents(undefined, [])).toBe(0);
    });
  });

  test('gate off returns before any read', async () => {
    delete process.env[GATE];
    expect(await setupFeeSettledElsewhere(db, { customerId: CUST, expectedFeeCents: 9900 })).toEqual({ settled: false });
    expect(mockCounters).toEqual({});
  });
});

describe('the reconcile reopen trap: billing the visit must not re-demand a settled fee', () => {
  const FEE_ONLY_ALERT_META = {
    dedupeKey: `unminted_setup_fee_manual_billing:${EST}`,
    customerId: CUST,
    scheduledServiceId: 'ss-1',
    resolvedCovered: false,
    expectedSetupFeeCents: 9900,
  };
  const alert = { id: 'alert-1', metadata: FEE_ONLY_ALERT_META };
  const APP_INVOICE = {
    id: 'inv-app', status: 'paid', scheduled_service_id: 'ss-1', notes: null,
    line_items: [{ client_id: 'scheduled_ss-1_primary', description: 'Quarterly Pest Control', amount: 97 }],
  };

  function reconcileTables(customerInvoices) {
    return {
      notifications: (n) => (n === 1 ? [alert] : (n === 2 || n === 3 ? alert : [])),
      invoices: { stamped: [], customer: customerInvoices, other: [APP_INVOICE] },
      scheduled_services: [],
    };
  }

  test('gate ON: the visit is billed and the fee is paid elsewhere -> the alert RESOLVES', async () => {
    process.env[GATE] = 'true';
    mockTables = reconcileTables(PAID_MEMBERSHIP);
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    expect(mockUpdates).toHaveLength(1);
    const text = mockUpdates[0].payload.detail || mockUpdates[0].payload.body;
    expect(text).toContain('RESOLVED');
    expect(text).not.toContain('Still owed');
  });

  test('gate OFF: the same state reopens the fee instruction (old behavior, the bug)', async () => {
    delete process.env[GATE];
    mockTables = reconcileTables(PAID_MEMBERSHIP);
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    expect(mockUpdates).toHaveLength(1);
    const text = mockUpdates[0].payload.detail || mockUpdates[0].payload.body;
    expect(text).toContain('Still owed');
    expect(text).toContain('one-time WaveGuard setup fee');
  });

  test('gate ON: $50 paid elsewhere against $99 -> the reopened instruction names only the $49.00 remainder', async () => {
    process.env[GATE] = 'true';
    const partial = { id: 'inv-part', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 50 }] };
    mockTables = reconcileTables([partial]);
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    expect(mockUpdates).toHaveLength(1);
    const text = mockUpdates[0].payload.detail || mockUpdates[0].payload.body;
    expect(text).toContain('$49.00 remaining');
    expect(mockUpdates[0].payload.metadata).toBeDefined();
  });

  test('gate ON: a partial already counted by the stamped scan is not subtracted twice', async () => {
    process.env[GATE] = 'true';
    const partial = { id: 'inv-part', status: 'paid', created_at: recent, notes: `accepted estimate #${EST}`, line_items: [{ description: 'WaveGuard Membership — one-time setup fee', amount: 50 }] };
    mockTables = { ...reconcileTables([partial]), invoices: { stamped: [partial], customer: [partial], other: [APP_INVOICE] } };
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    const text = mockUpdates[0].payload.detail || mockUpdates[0].payload.body;
    expect(text).toContain('$49.00 remaining');
  });

  test('gate OFF: the same partial leaves the full-fee instruction (unchanged)', async () => {
    delete process.env[GATE];
    const partial = { id: 'inv-part', status: 'paid', created_at: recent, line_items: [{ description: 'WaveGuard Membership', amount: 50 }] };
    mockTables = reconcileTables([partial]);
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    const text = mockUpdates[0].payload.detail || mockUpdates[0].payload.body;
    expect(text).not.toContain('remaining');
  });

  test('gate ON: reconcile bounds the term check to the alert visit date', async () => {
    process.env[GATE] = 'true';
    mockTables = { ...reconcileTables([]), scheduled_services: [{ scheduled_date: '2026-10-23' }] };
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    expect(mockTermCalls).toContainEqual(['where', 't.term_start', '<=', '2026-10-23']);
  });

  test('gate ON but the fee is NOT settled elsewhere -> the fee instruction still stands', async () => {
    process.env[GATE] = 'true';
    mockTables = reconcileTables([]);
    await reconcileSetupFeeAlert({ customerId: CUST, sourceEstimateId: EST });
    expect(mockUpdates).toHaveLength(1);
    expect((mockUpdates[0].payload.detail || mockUpdates[0].payload.body)).toContain('Still owed');
  });
});
