// Unit tests for setup-fee-obligation — the never-minted setup-fee
// detector behind the completion parking (GATE_UNMINTED_SETUP_FEE_PARK)
// and the provenance card's "Setup fee not invoiced" warning. The
// qualification rules (solo-plan mix, existing-customer/operator waivers)
// come from the REAL estimate-converter helpers on purpose — the detector
// must never disagree with the accept path's own fee authority.

let mockTables = {};

jest.mock('../models/db', () => {
  const handler = (table) => {
    const spec = mockTables[table];
    const chain = {};
    const self = () => chain;
    ['where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNull', 'orderBy'].forEach((m) => {
      chain[m] = jest.fn(self);
    });
    const resolve = () => (typeof spec === 'function' ? spec() : spec) ?? null;
    chain.first = jest.fn(async () => {
      const v = resolve();
      return Array.isArray(v) ? (v[0] ?? null) : v;
    });
    chain.select = jest.fn(async () => {
      const v = resolve();
      if (Array.isArray(v)) return v;
      return v ? [v] : [];
    });
    chain.pluck = jest.fn(async () => []);
    return chain;
  };
  const mock = jest.fn((table) => handler(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});

const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
const EstimateConverter = require('../services/estimate-converter');

const EST_ID = 'e1000000-0000-0000-0000-000000000001';
const CUST_ID = 'c1000000-0000-0000-0000-000000000001';

function soloPestEstimateData(extra = {}) {
  return {
    recurring: { services: [{ name: 'Pest Control', frequency: 'quarterly', mo: 29.33 }] },
    ...extra,
  };
}

function acceptedEstimate(overrides = {}) {
  return {
    id: EST_ID,
    customer_id: CUST_ID,
    status: 'accepted',
    accepted_at: '2026-08-01T12:00:00Z',
    bill_by_invoice: false,
    estimate_slug: 'EST-2026-9901',
    estimate_data: JSON.stringify(soloPestEstimateData()),
    ...overrides,
  };
}

function baseTables(overrides = {}) {
  return {
    estimates: acceptedEstimate(),
    annual_prepay_terms: null,
    invoices: null,
    activity_log: { id: 'log-1' },
    scheduled_services: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockTables = baseTables();
});

test('fixture sanity: the real converter authority charges the fee for this mix', () => {
  const data = soloPestEstimateData();
  expect(EstimateConverter.shouldIncludeWaveGuardSetupFeeForRecurring({
    recurringServices: EstimateConverter.recurringServicesFromEstimateData(data),
    estimateData: data,
  })).toBe(true);
});

test('owed: accepted solo-pest estimate with no term, no stamped invoice, converter provenance', async () => {
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID, customerId: CUST_ID });
  expect(result.owed).toBe(true);
  expect(result.setupFee).toBe(EstimateConverter.WAVEGUARD_SETUP_FEE);
  expect(result.estimateSlug).toBe('EST-2026-9901');
  expect(result.firstVisitAlreadyCompleted).toBe(false);
});

test('a LIVE stamped acceptance invoice means minted — not owed', async () => {
  mockTables = baseTables({ invoices: { id: 'inv-1', status: 'sent' } });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a REFUNDED stamped invoice attached to a visit is the refunded suppressor\'s lane — not owed', async () => {
  mockTables = baseTables({
    invoices: { id: 'inv-1', status: 'refunded', scheduled_service_id: 'ss-1' },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a CANCELED attached invoice CARRYING the setup-fee line is #3474\'s parking lane — not owed', async () => {
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }]),
    },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a VOID attached invoice is invisible to every completion suppressor — obligation survives', async () => {
  // findFirstApplicationInvoiceForEstimateService excludes 'void' outright
  // and the terminal lookup handles only 'refunded' — attachment alone is
  // not proof another lane will park it.
  mockTables = baseTables({
    invoices: { id: 'inv-1', invoice_number: 'WPC-2026-0101', status: 'void', scheduled_service_id: 'ss-1' },
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.deadInvoice).toEqual({
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0101',
    status: 'void',
  });
});

test('a CANCELED attached invoice WITHOUT a setup-fee line remints normally elsewhere — obligation survives', async () => {
  mockTables = baseTables({
    invoices: {
      id: 'inv-1',
      status: 'canceled',
      scheduled_service_id: 'ss-1',
      line_items: JSON.stringify([{ description: 'First Service Application', amount: 88 }]),
    },
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(true);
});

test('a dead UNATTACHED stamped invoice leaves the fee unbilled — owed, dead invoice named', async () => {
  mockTables = baseTables({
    invoices: { id: 'inv-1', invoice_number: 'WPC-2026-0100', status: 'canceled' },
  });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.deadInvoice).toEqual({
    id: 'inv-1',
    invoiceNumber: 'WPC-2026-0100',
    status: 'canceled',
  });
});

test('an annual prepay term waives the fee — not owed', async () => {
  mockTables = baseTables({ annual_prepay_terms: { id: 'term-1' } });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('accepts before the 2026-07-10 fee rule are out of scope', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ accepted_at: '2026-06-01T12:00:00Z' }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('no estimate_converted activity row (accept never converted) — not owed', async () => {
  mockTables = baseTables({ activity_log: null });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('a prior completed PLAN visit (is_recurring) flags firstVisitAlreadyCompleted (historic leak, no parking)', async () => {
  mockTables = baseTables({ scheduled_services: { id: 'ss-prior', is_recurring: true, recurring_parent_id: null } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(true);
});

test('a prior completed recurring CHILD (recurring_parent_id) also counts as a plan visit', async () => {
  mockTables = baseTables({ scheduled_services: { id: 'ss-child', is_recurring: false, recurring_parent_id: 'ss-parent' } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(true);
});

test('a prior completed one-time add-on (non-recurring, even same category) does not release the hold', async () => {
  // Durable recurrence identity, not service-type text: a same-category
  // pest corrective (ad-hoc, is_recurring=false) must not count as the
  // first plan application.
  mockTables = baseTables({ scheduled_services: { id: 'ss-addon', is_recurring: false, recurring_parent_id: null } });
  const result = await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID });
  expect(result.owed).toBe(true);
  expect(result.firstVisitAlreadyCompleted).toBe(false);
});

test('the completing visit itself, when a non-plan row (add-on mint), never owns the obligation', async () => {
  expect((await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    visitPlanRow: { is_recurring: false, recurring_parent_id: null },
  })).owed).toBe(false);
});

test('the completing visit on a plan row keeps the obligation', async () => {
  const result = await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    visitPlanRow: { is_recurring: true, recurring_parent_id: null },
  });
  expect(result.owed).toBe(true);
});

test('non-accepted estimate — not owed', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ status: 'sent' }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('invoice-mode estimates bill through their own proposal invoice — not owed', async () => {
  mockTables = baseTables({ estimates: acceptedEstimate({ bill_by_invoice: true }) });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('existing-customer waiver flows through from the converter authority — not owed', async () => {
  mockTables = baseTables({
    estimates: acceptedEstimate({
      estimate_data: JSON.stringify(soloPestEstimateData({ membershipSnapshot: { isExistingCustomer: true } })),
    }),
  });
  expect((await findUnmintedSetupFeeObligation({ sourceEstimateId: EST_ID })).owed).toBe(false);
});

test('customer mismatch (re-linked visit) — not owed', async () => {
  expect((await findUnmintedSetupFeeObligation({
    sourceEstimateId: EST_ID,
    customerId: 'c2000000-0000-0000-0000-000000000002',
  })).owed).toBe(false);
});

test('missing sourceEstimateId — not owed, no reads', async () => {
  expect((await findUnmintedSetupFeeObligation({})).owed).toBe(false);
});
