// Fail-closed completion-billing coverage gate. annualPrepayCoversVisit decides
// whether a completing visit is covered by an annual prepay — by a still-LIVE
// term (coveredTermsAsOf: in-window + paid status + prepay invoice/payment not
// void/refunded), NOT the per-visit amount. A discounted plan stamps each visit
// BELOW its undiscounted estimated_price, so the legacy `prepaid_amount >= price`
// gate would re-bill an already-prepaid visit (the double-bill this closes).
// The covered-term SQL is exercised via getActivelyCoveredCustomerIds' own tests;
// here we pin annualPrepayCoversVisit's contract: short-circuits, delegation to
// the covered-term query, and fail-closed behaviour.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const db = require('../models/db');
const { annualPrepayCoversVisit, _private } = require('../services/annual-prepay-renewals');

// Chainable knex stub whose terminal .first() resolves `firstResult`. Every
// query-builder method returns the stub so the coveredTermsAsOf chain
// (leftJoin/where/whereRaw/.where('t.id')/first) resolves regardless of shape.
function chainable(firstResult) {
  const stub = {};
  ['leftJoin', 'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereRaw', 'orWhere', 'andWhere',
    'orderBy', 'select', 'distinct', 'whereBetween', 'whereNull', 'whereNotNull'].forEach((m) => {
    stub[m] = jest.fn(() => stub);
  });
  stub.modify = jest.fn((fn) => { if (typeof fn === 'function') fn(stub); return stub; });
  stub.first = jest.fn(() => Promise.resolve(firstResult));
  return stub;
}

// db(table) → the covered-term query stub, or throws if a term lookup should NOT
// happen (used to assert the cheap short-circuits never touch the DB).
function coveredQuery({ liveTerm = undefined, rejectWith = null, forbidQuery = false } = {}) {
  db.mockImplementation((table) => {
    if (forbidQuery) throw new Error(`should not query (${table})`);
    if (table !== 'annual_prepay_terms as t') throw new Error(`Unexpected db table ${table}`);
    if (rejectWith) {
      const stub = chainable(undefined);
      stub.first = jest.fn(() => Promise.reject(rejectWith));
      return stub;
    }
    return chainable(liveTerm);
  });
}

// A visit stamped by annual-prepay coverage. Default amount is a DISCOUNTED slice
// ($52.25) that is LESS than a $55 undiscounted visit price — the case the
// amount-only gate got wrong.
const stampedVisit = (over = {}) => ({
  id: 'ss-1',
  customer_id: 'cust-1',
  service_type: 'Lawn Care',
  scheduled_date: '2026-07-15',
  prepaid_method: 'annual_prepay_invoice',
  prepaid_amount: 52.25,
  annual_prepay_term_id: 'term-1',
  ...over,
});

describe('annualPrepayCoversVisit — fail-closed completion coverage gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
    _private.resetCachesForTests();
  });

  test('discounted stamp backed by a live covered term: COVERED (ignores slice < price)', async () => {
    coveredQuery({ liveTerm: { id: 'term-1' } });
    await expect(annualPrepayCoversVisit(stampedVisit())).resolves.toBe(true);
  });

  test('0% WaveGuard stamp (slice == price) backed by a live term: COVERED', async () => {
    coveredQuery({ liveTerm: { id: 'term-1' } });
    await expect(annualPrepayCoversVisit(stampedVisit({ prepaid_amount: 55 }))).resolves.toBe(true);
  });

  test('no live covered term (cancelled / refunded / void-invoice / out-of-window / other customer): NOT covered', async () => {
    // coveredTermsAsOf + the customer_id guard filter all of those out → no row.
    coveredQuery({ liveTerm: undefined });
    await expect(annualPrepayCoversVisit(stampedVisit())).resolves.toBe(false);
  });

  test('live term whose coverage service still matches the visit: COVERED', async () => {
    coveredQuery({ liveTerm: { id: 'term-1', coverage_service_type: 'Lawn Care' } });
    await expect(annualPrepayCoversVisit(stampedVisit({ service_type: 'Lawn Care' }))).resolves.toBe(true);
  });

  test('stale stamp on a dropped/re-typed service (coverage service no longer matches): NOT covered', async () => {
    // Term is live, but its coverage service is Pest Control while the visit is now
    // Lawn Care — the stamp lingered on a service that left the term's coverage set.
    coveredQuery({ liveTerm: { id: 'term-1', coverage_service_type: 'Pest Control' } });
    await expect(annualPrepayCoversVisit(stampedVisit({ service_type: 'Lawn Care' }))).resolves.toBe(false);
  });

  test('covered-term query throws: fail-closed → NOT covered (never suppress on error)', async () => {
    coveredQuery({ rejectWith: new Error('db unreachable') });
    await expect(annualPrepayCoversVisit(stampedVisit())).resolves.toBe(false);
  });

  test('prepay table absent (pre-migration env): NOT covered', async () => {
    db.schema = { hasTable: jest.fn().mockResolvedValue(false) };
    _private.resetCachesForTests();
    coveredQuery({ forbidQuery: true });
    await expect(annualPrepayCoversVisit(stampedVisit())).resolves.toBe(false);
  });

  test('other prepaid method (cash/Zelle): NOT covered here — short-circuits before any query', async () => {
    coveredQuery({ forbidQuery: true });
    await expect(annualPrepayCoversVisit(stampedVisit({ prepaid_method: 'cash' }))).resolves.toBe(false);
  });

  test('no-config / no-stamp visit: NOT covered (short-circuit, no query)', async () => {
    coveredQuery({ forbidQuery: true });
    await expect(annualPrepayCoversVisit(
      stampedVisit({ prepaid_method: null, prepaid_amount: null, annual_prepay_term_id: null }),
    )).resolves.toBe(false);
  });

  test('annual_prepay stamp but no linked term id: NOT covered (short-circuit)', async () => {
    coveredQuery({ forbidQuery: true });
    await expect(annualPrepayCoversVisit(stampedVisit({ annual_prepay_term_id: null }))).resolves.toBe(false);
  });

  test('zero / negative stamped amount: NOT covered (short-circuit)', async () => {
    coveredQuery({ forbidQuery: true });
    await expect(annualPrepayCoversVisit(stampedVisit({ prepaid_amount: 0 }))).resolves.toBe(false);
  });

  test('null scheduledService: NOT covered', async () => {
    await expect(annualPrepayCoversVisit(null)).resolves.toBe(false);
  });
});
