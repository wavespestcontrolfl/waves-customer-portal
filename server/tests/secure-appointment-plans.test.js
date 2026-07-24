// /secure plan-choice lane — context derivation (secure-appointment-plans).
// Pins the fail-toward-card-only matrix: gate off / NULL price / unknown
// cadence / non-whitelisted service / membership-or-prepay lane /
// overlapping term all yield NO planContext, and the two incentive classes
// derive their totals from the REAL shared constants (ANNUAL_PREPAY_
// DISCOUNT_PCT, the converter's exported WAVEGUARD_SETUP_FEE) — never
// literals baked into this module.

let mockTableHandlers = {};
jest.mock('../models/db', () => {
  const makeChain = (handlers) => {
    const chain = { calls: [] };
    const record = (op) => (...args) => { chain.calls.push([op, ...args]); return chain; };
    chain.where = record('where');
    chain.whereIn = record('whereIn');
    chain.whereNull = record('whereNull');
    chain.whereNot = record('whereNot');
    chain.whereNotNull = record('whereNotNull');
    chain.orderBy = record('orderBy');
    chain.select = (...args) => Promise.resolve(handlers.select ? handlers.select(chain, ...args) : []);
    chain.first = (...args) => Promise.resolve(handlers.first ? handlers.first(chain, ...args) : null);
    chain.update = (patch) => { chain.calls.push(['update', patch]); return Promise.resolve(handlers.update ? handlers.update(chain, patch) : 1); };
    chain.insert = (row) => { chain.calls.push(['insert', row]); return Promise.resolve(handlers.insert ? handlers.insert(chain, row) : [{ id: 'row' }]); };
    return chain;
  };
  const fn = jest.fn((table) => makeChain(mockTableHandlers[table] || {}));
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => (gate === 'securePlanChoice' ? mockGateOn : false)),
}));

// Light stand-in for the converter's classifier (its own tests own the real
// mapping); the FEE constant flows through so assertions prove the payload
// carries the module constant, not a literal 99 in secure-appointment-plans.
jest.mock('../services/estimate-converter', () => ({
  WAVEGUARD_SETUP_FEE: 99,
  recurringServiceKey: (svc = {}) => {
    const raw = String(svc.name || '').toLowerCase();
    if (raw.includes('commercial')) return 'commercial_pest';
    if (raw.includes('pest')) return 'pest_control';
    if (raw.includes('mosquito')) return 'mosquito';
    if (raw.includes('lawn')) return 'lawn_care';
    if (raw.includes('wdo')) return 'wdo';
    return raw.replace(/[^a-z0-9]+/g, '_');
  },
}));
jest.mock('../utils/portal-url', () => ({ portalUrl: (p) => `https://portal.test${p}` }));
jest.mock('../services/call-booking-catalog', () => ({
  callBookingDateOnly: (d) => (d ? String(d).slice(0, 10) : null),
}));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));

const { ANNUAL_PREPAY_DISCOUNT_PCT } = require('../services/pricing-engine/constants');
const {
  buildSecurePlanContext,
  prepaySelectionState,
  _test,
} = require('../services/secure-appointment-plans');

const FUTURE = '2099-05-04';

function setTables({ visit, customer, term, invoice } = {}) {
  mockTableHandlers = {
    scheduled_services: { first: () => visit || null },
    customers: { first: () => customer || null },
    annual_prepay_terms: { first: () => term || null },
    invoices: { first: () => invoice || null },
  };
}

const baseVisit = {
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
  source_estimate_id: null,
};
const baseCustomer = { id: 'c1', billing_mode: null, waveguard_tier: null, monthly_rate: null, property_type: 'single_family' };
const request = { id: 'r1', scheduled_service_id: 'v1', selected_plan: null };

beforeEach(() => {
  mockGateOn = true;
  setTables({ visit: { ...baseVisit }, customer: { ...baseCustomer } });
});

describe('buildSecurePlanContext', () => {
  test('gate off → null (page payload stays card-only)', async () => {
    mockGateOn = false;
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test('recurring pest (solo membership mix) → fee_waiver: prepay = annual base, $99 waived, no % label', async () => {
    const ctx = await buildSecurePlanContext({ request, visitId: 'v1' });
    expect(ctx).toMatchObject({
      mode: 'recurring',
      planClass: 'fee_waiver',
      perVisit: 135,
      visitsPerYear: 4,
      annualBase: 540,
      prepay: { total: 540, discount: 0, ratePctLabel: '' },
      setupFee: { amount: 99, waivedWithPrepay: true },
    });
  });

  test('recurring lawn → discount class derives from the REAL constant, to the cent', async () => {
    setTables({
      visit: { ...baseVisit, service_type: 'Lawn Care', recurring_pattern: 'bimonthly', estimated_price: '89.00' },
      customer: { ...baseCustomer },
    });
    const ctx = await buildSecurePlanContext({ request, visitId: 'v1' });
    const base = 89 * 6;
    const expected = Math.round(base * (1 - ANNUAL_PREPAY_DISCOUNT_PCT) * 100) / 100;
    expect(ctx.planClass).toBe('discount');
    expect(ctx.annualBase).toBe(534);
    expect(ctx.prepay.total).toBe(expected);
    expect(ctx.prepay.discount).toBe(Math.round((base - expected) * 100) / 100);
    expect(ctx.setupFee).toBeNull();
    expect(ctx.prepay.ratePctLabel).toBe(`${Math.round(ANNUAL_PREPAY_DISCOUNT_PCT * 1000) / 10}%`);
  });

  test('one-time visit → display-only mode, no plan choice fields', async () => {
    setTables({
      visit: { ...baseVisit, is_recurring: false, recurring_pattern: null, service_type: 'One-Time Pest Treatment', estimated_price: '189.00' },
      customer: { ...baseCustomer },
    });
    const ctx = await buildSecurePlanContext({ request, visitId: 'v1' });
    expect(ctx).toEqual({ mode: 'one_time', perVisit: 189, selected: null });
  });

  test.each([
    ['NULL estimated_price', { estimated_price: null }],
    ['zero price', { estimated_price: '0' }],
    ['unknown cadence', { recurring_pattern: 'custom', recurring_interval_days: 30 }],
    ['non-whitelisted service', { service_type: 'WDO Inspection' }],
    ['commercial service key', { service_type: 'Commercial Pest Control' }],
  ])('%s → null', async (_label, visitPatch) => {
    setTables({ visit: { ...baseVisit, ...visitPatch }, customer: { ...baseCustomer } });
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test('custom + 42-day interval normalizes to every_6_weeks (9 applications)', async () => {
    setTables({
      visit: { ...baseVisit, service_type: 'Mosquito Treatment', recurring_pattern: 'custom', recurring_interval_days: 42, estimated_price: '75.00' },
      customer: { ...baseCustomer },
    });
    const ctx = await buildSecurePlanContext({ request, visitId: 'v1' });
    expect(ctx.visitsPerYear).toBe(9);
    expect(ctx.planClass).toBe('fee_waiver');
    expect(ctx.annualBase).toBe(675);
  });

  test.each([
    ['monthly membership lane', { billing_mode: 'monthly_membership' }],
    ['inferred membership (tier + rate)', { waveguard_tier: 'Gold', monthly_rate: 120 }],
    ['annual_prepay lane', { billing_mode: 'annual_prepay' }],
    ['commercial property', { property_type: 'commercial' }],
  ])('%s → null', async (_label, customerPatch) => {
    setTables({ visit: { ...baseVisit }, customer: { ...baseCustomer, ...customerPatch } });
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test('existing overlapping annual-prepay term → null (prepay not sellable)', async () => {
    setTables({
      visit: { ...baseVisit },
      customer: { ...baseCustomer },
      term: { id: 't1', term_end: '2099-12-31' },
    });
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test('lapsed term (term_end in the past) does not block', async () => {
    setTables({
      visit: { ...baseVisit },
      customer: { ...baseCustomer },
      term: { id: 't1', term_end: '2020-01-01' },
    });
    const ctx = await buildSecurePlanContext({ request, visitId: 'v1' });
    expect(ctx?.mode).toBe('recurring');
  });
});

describe('prepaySelectionState', () => {
  const prepayRequest = { id: 'r1', selected_plan: 'prepay_annual', prepay_invoice_id: 'inv1' };

  test('gate off / no selection → null', async () => {
    mockGateOn = false;
    expect(await prepaySelectionState(prepayRequest)).toBeNull();
    mockGateOn = true;
    expect(await prepaySelectionState({ id: 'r1', selected_plan: null })).toBeNull();
  });

  test('live unpaid invoice → prepay_selected with the pay link', async () => {
    setTables({ invoice: { id: 'inv1', token: 'tok123', status: 'sent' } });
    expect(await prepaySelectionState(prepayRequest)).toEqual({
      state: 'prepay_selected',
      payUrl: 'https://portal.test/pay/tok123',
    });
  });

  test('settled invoice → secured; voided invoice → null (choice reopens)', async () => {
    setTables({ invoice: { id: 'inv1', token: 'tok123', status: 'paid' } });
    expect(await prepaySelectionState(prepayRequest)).toEqual({ state: 'secured' });
    setTables({ invoice: { id: 'inv1', token: 'tok123', status: 'void' } });
    expect(await prepaySelectionState(prepayRequest)).toBeNull();
  });
});

describe('normalizedPattern', () => {
  test('custom interval mapping', () => {
    expect(_test.normalizedPattern({ recurring_pattern: 'custom', recurring_interval_days: 42 })).toBe('every_6_weeks');
    expect(_test.normalizedPattern({ recurring_pattern: 'custom', recurring_interval_days: 30 })).toBeNull();
    expect(_test.normalizedPattern({ recurring_pattern: 'Quarterly' })).toBe('quarterly');
    expect(_test.normalizedPattern({ recurring_pattern: null })).toBeNull();
  });
});

describe('self-review exclusions (double-billing + tax guards)', () => {
  test.each([
    ['business property (InvoiceService taxes it)', {}, { property_type: 'business' }],
    ['already-per_application customer (setup fee was billed at accept)', {}, { billing_mode: 'per_application' }],
  ])('%s → null', async (_label, visitPatch, customerPatch) => {
    setTables({ visit: { ...baseVisit, ...visitPatch }, customer: { ...baseCustomer, ...customerPatch } });
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test('estimate-origin series (source_estimate_id set) → null — accept flow already owns billing', async () => {
    setTables({ visit: { ...baseVisit, source_estimate_id: 'est-1' }, customer: { ...baseCustomer } });
    expect(await buildSecurePlanContext({ request, visitId: 'v1' })).toBeNull();
  });

  test("the request's OWN pending term is excluded from the overlap probe (prepay_selected page keeps its context)", async () => {
    mockTableHandlers = {
      scheduled_services: { first: () => ({ ...baseVisit }) },
      customers: { first: () => ({ ...baseCustomer }) },
      annual_prepay_terms: {
        first: (chain) => {
          // Honor the whereNot('id', <own term>) exclusion like SQL would.
          const excluded = chain.calls.find(([op, col]) => op === 'whereNot' && col === 'id');
          const term = { id: 'term-own', term_end: '2099-12-31' };
          return excluded && excluded[2] === 'term-own' ? null : term;
        },
      },
    };
    const withOwnTerm = await buildSecurePlanContext({
      request: { ...request, annual_prepay_term_id: 'term-own' },
      visitId: 'v1',
    });
    expect(withOwnTerm?.mode).toBe('recurring');
    // A DIFFERENT customer term still hides the plan page.
    const withForeignTerm = await buildSecurePlanContext({
      request: { ...request, annual_prepay_term_id: 'term-other' },
      visitId: 'v1',
    });
    expect(withForeignTerm).toBeNull();
  });
});
