// /secure plan-choice lane — selection endpoint semantics
// (secure-appointment-plans.selectSecurePlan). Pins the money invariants:
// the minted prepay invoice line equals the displayed total to the cent (a
// drifted invoice total aborts the mint), the request row is the
// idempotency anchor (double-submit → one invoice, same pay link), the
// overlap lock runs inside the transaction, per-application stamps the
// selection + the series parent's pending_setup_fee, and every dead-state
// input fails closed with a typed code. The client can never supply an
// amount — the API takes only { token, plan }.

let mockTableHandlers = {};
let mockDbCalls = [];
jest.mock('../models/db', () => {
  const makeChain = (table, handlers) => {
    const chain = { table, calls: [] };
    const record = (op) => (...args) => { chain.calls.push([op, ...args]); return chain; };
    chain.where = record('where');
    chain.whereIn = record('whereIn');
    chain.whereNull = record('whereNull');
    chain.whereNotNull = record('whereNotNull');
    chain.orderBy = record('orderBy');
    chain.select = (...args) => Promise.resolve(handlers.select ? handlers.select(chain, ...args) : []);
    chain.first = (...args) => Promise.resolve(handlers.first ? handlers.first(chain, ...args) : null);
    chain.update = (patch) => { chain.calls.push(['update', patch]); return Promise.resolve(handlers.update ? handlers.update(chain, patch) : 1); };
    chain.insert = (row) => { chain.calls.push(['insert', row]); return Promise.resolve(handlers.insert ? handlers.insert(chain, row) : [{ id: 'row' }]); };
    return chain;
  };
  const fn = jest.fn((table) => {
    const chain = makeChain(table, mockTableHandlers[table] || {});
    mockDbCalls.push(chain);
    return chain;
  });
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'securePlanChoice' ? mockGateOn : false)),
}));
jest.mock('../services/estimate-converter', () => ({
  WAVEGUARD_SETUP_FEE: 99,
  recurringServiceKey: (svc = {}) => {
    const raw = String(svc.name || '').toLowerCase();
    if (raw.includes('pest')) return 'pest_control';
    if (raw.includes('lawn')) return 'lawn_care';
    return raw.replace(/[^a-z0-9]+/g, '_');
  },
}));
jest.mock('../utils/portal-url', () => ({ portalUrl: (p) => `https://portal.test${p}` }));
jest.mock('../services/call-booking-catalog', () => ({
  callBookingDateOnly: (d) => (d ? String(d).slice(0, 10) : null),
}));
const mockResolveForInvoice = jest.fn(async () => null);
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));

const mockInvoiceCreate = jest.fn();
jest.mock('../services/invoice', () => ({ create: (...a) => mockInvoiceCreate(...a) }));
const mockCreateTerm = jest.fn(async () => ({ id: 'term-1' }));
jest.mock('../services/annual-prepay-renewals', () => ({
  createTermForAnnualPrepay: (...a) => mockCreateTerm(...a),
}));
const mockOverlapLock = jest.fn(async () => {});
jest.mock('../routes/admin-customers', () => ({
  _private: { lockAndAssertNoAnnualPrepayOverlap: (...a) => mockOverlapLock(...a) },
}));

const { selectSecurePlan } = require('../services/secure-appointment-plans');

const FUTURE = '2099-05-04';
const pestVisit = {
  id: 'v1',
  customer_id: 'c1',
  status: 'confirmed',
  scheduled_date: FUTURE,
  service_type: 'Quarterly Pest Control',
  estimated_price: '135.00',
  is_recurring: true,
  recurring_pattern: 'quarterly',
  recurring_interval_days: null,
  recurring_parent_id: null,
  pending_setup_fee: null,
};
const customer = { id: 'c1', billing_mode: null, waveguard_tier: null, monthly_rate: null, property_type: 'single_family' };
const pendingRequest = { id: 'r1', scheduled_service_id: 'v1', customer_id: 'c1', status: 'pending', token: 'tok', selected_plan: null, prepay_invoice_id: null };

function setTables(overrides = {}) {
  mockTableHandlers = {
    appointment_card_requests: { first: () => ({ ...pendingRequest }) },
    scheduled_services: {
      first: () => ({ ...pestVisit }),
      select: () => [{ scheduled_date: FUTURE }, { scheduled_date: '2099-08-04' }],
    },
    customers: { first: () => ({ ...customer }) },
    annual_prepay_terms: { first: () => null },
    invoices: { first: () => null },
    activity_log: {},
    ...overrides,
  };
}

function updatesFor(table) {
  return mockDbCalls
    .filter((c) => c.table === table)
    .flatMap((c) => c.calls.filter(([op]) => op === 'update').map(([, patch]) => patch));
}

beforeEach(() => {
  mockGateOn = true;
  mockDbCalls = [];
  mockResolveForInvoice.mockReset().mockResolvedValue(null);
  mockOverlapLock.mockReset().mockResolvedValue(undefined);
  mockCreateTerm.mockReset().mockResolvedValue({ id: 'term-1' });
  mockInvoiceCreate.mockReset().mockImplementation(async ({ lineItems }) => ({
    id: 'inv-1',
    token: 'invtok',
    invoice_number: 'INV-100',
    total: lineItems[0].unit_price, // residential, untaxed — total === line
  }));
  setTables();
});

describe('selectSecurePlan — per_application', () => {
  test('stamps the selection and the series parent setup fee (fee-waiver mix)', async () => {
    const result = await selectSecurePlan({ token: 'tok', plan: 'per_application' });
    expect(result).toEqual({ ok: true, plan: 'per_application' });
    expect(updatesFor('appointment_card_requests')[0]).toMatchObject({ selected_plan: 'per_application' });
    // The $99 stamp: value from the converter constant, on scheduled_services.
    expect(updatesFor('scheduled_services')[0]).toMatchObject({ pending_setup_fee: 99 });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  test('discount-class mix stamps NO setup fee', async () => {
    setTables({
      scheduled_services: {
        first: () => ({ ...pestVisit, service_type: 'Lawn Care', recurring_pattern: 'bimonthly', estimated_price: '89.00' }),
        select: () => [{ scheduled_date: FUTURE }],
      },
    });
    await selectSecurePlan({ token: 'tok', plan: 'per_application' });
    expect(updatesFor('scheduled_services')).toHaveLength(0);
  });
});

describe('selectSecurePlan — prepay_annual', () => {
  test('mints the invoice at the displayed total (cent agreement), creates the term, returns the pay link', async () => {
    const result = await selectSecurePlan({ token: 'tok', plan: 'prepay_annual' });
    expect(result).toEqual({ ok: true, plan: 'prepay_annual', payUrl: 'https://portal.test/pay/invtok' });
    // Pest quarterly $135 → fee_waiver → prepay total = 4 × $135 = $540.00.
    const createArgs = mockInvoiceCreate.mock.calls[0][0];
    expect(createArgs.lineItems).toEqual([expect.objectContaining({ unit_price: 540, quantity: 1 })]);
    expect(createArgs.customerId).toBe('c1');
    // Overlap lock ran inside the transaction, before the mint.
    expect(mockOverlapLock).toHaveBeenCalled();
    expect(mockOverlapLock.mock.invocationCallOrder[0]).toBeLessThan(mockInvoiceCreate.mock.invocationCallOrder[0]);
    // Term is series-anchored: coverage from the booked cadence, term start
    // at the first upcoming visit, amount = the invoice total.
    expect(mockCreateTerm.mock.calls[0][0]).toMatchObject({
      customerId: 'c1',
      prepayInvoiceId: 'inv-1',
      coverageServiceType: 'Quarterly Pest Control',
      coverageVisitCount: 4,
      coverageCadence: 'quarterly',
      termStart: FUTURE,
      prepayAmount: 540,
      monthlyRate: 45,
    });
    // The request row is stamped with both anchors.
    expect(updatesFor('appointment_card_requests')[0]).toMatchObject({
      selected_plan: 'prepay_annual',
      prepay_invoice_id: 'inv-1',
      annual_prepay_term_id: 'term-1',
    });
  });

  test('invoice total drifting from the displayed total aborts the mint (no pay link at a surprise price)', async () => {
    mockInvoiceCreate.mockImplementation(async () => ({ id: 'inv-1', token: 'invtok', invoice_number: 'INV-100', total: 577.8 }));
    await expect(selectSecurePlan({ token: 'tok', plan: 'prepay_annual' })).rejects.toMatchObject({ code: 'plan_unavailable' });
  });

  test('double-submit is idempotent: an existing live prepay invoice returns the SAME link, no second mint', async () => {
    setTables({
      appointment_card_requests: { first: () => ({ ...pendingRequest, prepay_invoice_id: 'inv-1' }) },
      invoices: { first: () => ({ id: 'inv-1', token: 'invtok', status: 'sent' }) },
    });
    const result = await selectSecurePlan({ token: 'tok', plan: 'prepay_annual' });
    expect(result.payUrl).toBe('https://portal.test/pay/invtok');
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockCreateTerm).not.toHaveBeenCalled();
  });

  test('concurrent overlap → prepay_overlap, and the tagged lock error never mints', async () => {
    mockOverlapLock.mockImplementation(async () => {
      const err = new Error('Customer already has an annual prepay term through 2099-12-31');
      err.annualPrepayOverlap = { activeTermId: 't9' };
      throw err;
    });
    await expect(selectSecurePlan({ token: 'tok', plan: 'prepay_annual' })).rejects.toMatchObject({ code: 'prepay_overlap' });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  test('concurrent request-stamp loser rolls back and returns the winner’s link', async () => {
    let stampAttempts = 0;
    setTables({
      appointment_card_requests: {
        first: (chain) => {
          // First read: the pending request; the post-conflict re-read
          // carries the winner's invoice id.
          const reads = mockDbCalls.filter((c) => c.table === 'appointment_card_requests');
          return reads.length <= 1
            ? { ...pendingRequest }
            : { ...pendingRequest, prepay_invoice_id: 'inv-winner' };
        },
        update: () => { stampAttempts += 1; return 0; }, // loser: 0 rows
      },
      invoices: { first: () => ({ id: 'inv-winner', token: 'winnertok', status: 'sent' }) },
    });
    const result = await selectSecurePlan({ token: 'tok', plan: 'prepay_annual' });
    expect(stampAttempts).toBe(1);
    expect(result.payUrl).toBe('https://portal.test/pay/winnertok');
  });
});

describe('selectSecurePlan — fail-closed states', () => {
  test('gate off → gate_off (route maps to 404)', async () => {
    mockGateOn = false;
    await expect(selectSecurePlan({ token: 'tok', plan: 'per_application' })).rejects.toMatchObject({ code: 'gate_off' });
  });

  test('unknown plan / unknown token', async () => {
    await expect(selectSecurePlan({ token: 'tok', plan: 'weekly_gold' })).rejects.toMatchObject({ code: 'invalid_plan' });
    setTables({ appointment_card_requests: { first: () => null } });
    await expect(selectSecurePlan({ token: 'tok', plan: 'per_application' })).rejects.toMatchObject({ code: 'not_found' });
  });

  test('terminal request → already_secured', async () => {
    setTables({ appointment_card_requests: { first: () => ({ ...pendingRequest, status: 'completed' }) } });
    await expect(selectSecurePlan({ token: 'tok', plan: 'per_application' })).rejects.toMatchObject({ code: 'already_secured' });
  });

  test('cancelled visit → no_longer_needed', async () => {
    setTables({
      scheduled_services: { first: () => ({ ...pestVisit, status: 'cancelled' }), select: () => [] },
    });
    await expect(selectSecurePlan({ token: 'tok', plan: 'per_application' })).rejects.toMatchObject({ code: 'no_longer_needed' });
  });

  test('payer-billed visit → no_longer_needed (never bill the homeowner for a third-party invoice)', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'p1' });
    await expect(selectSecurePlan({ token: 'tok', plan: 'prepay_annual' })).rejects.toMatchObject({ code: 'no_longer_needed' });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  test('context gone unsound (price cleared) → plan_unavailable', async () => {
    setTables({
      scheduled_services: { first: () => ({ ...pestVisit, estimated_price: null }), select: () => [] },
    });
    await expect(selectSecurePlan({ token: 'tok', plan: 'prepay_annual' })).rejects.toMatchObject({ code: 'plan_unavailable' });
  });
});
