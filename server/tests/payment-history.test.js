/**
 * payment-history - the in-flight existence probe behind billing.hasProcessingPayment (PR #5331): live payer ownership,
 * fail closed. (The authoritative-history reader that grounded free-text absence claims is gone: payment status reaches a
 * customer only as a sentence rendered from the display window - tests/payment-status-contract.test.js.)
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
// the LIVE payer verdict (services/invoice-payer-ownership -> services/payer.resolveForInvoice), Codex round-41 P1
const mockResolve = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolve(...a), scheduledServicesHasSelfPay: async () => true }));
beforeEach(() => { mockResolve.mockReset(); mockResolve.mockResolvedValue({ payerId: null }); });
// The two invoices reads of services/payer-linkage.loadLivePayerLinkage: 1st = stamped payer invoices, 2nd = the remaining
// (payer_id NULL) invoices the live resolver judges.
function invoicesChains({ payerInvoices = [], linkageFails = false, liveInvoices = [], liveFails = false } = {}) {
  let n = 0;
  return () => {
    const mine = n++;
    const inv = {};
    ['where', 'select', 'whereNotNull', 'whereNull', 'orWhere', 'orderBy', 'limit'].forEach((m) => { inv[m] = jest.fn(() => inv); });
    inv.catch = (handler) => {
      if (mine === 0) return linkageFails ? Promise.resolve(handler(new Error('linkage down'))) : Promise.resolve(payerInvoices);
      return liveFails ? Promise.resolve(handler(new Error('live down'))) : Promise.resolve(liveInvoices);
    };
    return inv;
  };
}

// The batched candidate-payer reads (invoice-payer-ownership byCandidatePayer, Codex round-47 P2): no customer default payer; the
// scheduled service svc-ap bills payer-1 (the same picture the resolver mock gives).
function routeTables(invoices) {
  return jest.fn((table) => {
    if (table === 'customers') return { where: () => ({ first: async () => ({ payer_id: null }) }) };
    if (table === 'scheduled_services') {
      const q = { where: () => q, whereIn: () => q, select: async () => [{ id: 'svc-ap', payer_id: 'payer-1' }] };
      return q;
    }
    return invoices();
  });
}

describe('Codex round-12 P0: the aggregator\'s Recent payments read excludes payer-owned rows in SQL too', () => {
  test('getContextForCustomer\'s db(\'payments\') display read carries whereNull(\'payments.payer_id\') before its limit', () => {
    const src = require('fs').readFileSync(require.resolve('../services/context-aggregator'), 'utf8');
    const line = src.split('\n').find((l) => /db\('payments'\)\.where\(\{ 'payments\.customer_id': customer\.id \}\)/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/whereNull\('payments\.payer_id'\)/);
    expect(line.indexOf("whereNull('payments.payer_id')")).toBeLessThan(line.indexOf('.limit('));
  });
});


describe('hasInFlightMoney', () => {
  const { hasInFlightMoney, IN_FLIGHT_PAYMENTS_SQL, IN_FLIGHT_INVOICE_SQL } = require('../services/payment-history');
  // dbh: the shared payer-linkage lookup (invoices query chain) + two raw reads (candidate payments, processing invoice)
  function flightDb({ candidates = [], invoiceRows = [], payerInvoices = [], linkageFails = false, rawThrows = false, liveInvoices = [] } = {}) {
    const invoices = invoicesChains({ payerInvoices, linkageFails, liveInvoices });
    const dbh = routeTables(invoices);
    dbh.raw = jest.fn(async (sql) => {
      if (rawThrows) throw new Error('db down');
      return { rows: sql === IN_FLIGHT_PAYMENTS_SQL ? candidates : invoiceRows };
    });
    return dbh;
  }
  const APAY = { id: 'ap', stripe_payment_intent_id: 'pi_ap', stripe_charge_id: 'ch_ap', invoice_number: 'WPC-2026-0500' };

  test('two reads: candidate in-flight payments (payer_id NULL, capped) filtered in JS, and a processing invoice (not withdrawn)', () => {
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/FROM payments/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/payer_id IS NULL/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/IN \('pending', 'processing', 'requires_action'\)/);
    expect(IN_FLIGHT_PAYMENTS_SQL).toMatch(/LIMIT 200/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/FROM invoices/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/payer_id IS NULL AND lower\(status\) = 'processing'/);
    expect(IN_FLIGHT_INVOICE_SQL).toMatch(/scheduled_send_error NOT LIKE 'payer_billed:%'/);
  });
  test('an own in-flight payment => true; nothing => false; a processing own invoice => true', async () => {
    expect(await hasInFlightMoney('c1', flightDb({ candidates: [{ id: 'p1', metadata: null }] }))).toBe(true);
    expect(await hasInFlightMoney('c1', flightDb({}))).toBe(false);
    expect(await hasInFlightMoney('c1', flightDb({ invoiceRows: [{ id: 'inv-proc' }] }))).toBe(true);
  });
  test('payer-linked in-flight rows do NOT count, through EVERY linkage (not just metadata.invoice_id)', async () => {
    const linked = [
      { id: 'a', metadata: { invoice_id: 'ap' } }, { id: 'b', metadata: { dispute_invoice_id: 'ap' } }, { id: 'c', metadata: { waves_invoice_id: 'ap' } },
      { id: 'd', stripe_payment_intent_id: 'pi_ap' }, { id: 'e', stripe_charge_id: 'ch_ap' }, { id: 'f', description: 'Invoice WPC-2026-0500 — zelle' },
    ];
    for (const row of linked) {
      expect({ id: row.id, r: await hasInFlightMoney('c1', flightDb({ candidates: [row], payerInvoices: [APAY] })) }).toEqual({ id: row.id, r: false });
    }
    // ...while an OWN row alongside them still counts
    expect(await hasInFlightMoney('c1', flightDb({ candidates: [...linked, { id: 'own', metadata: null }], payerInvoices: [APAY] }))).toBe(true);
  });
  test('a FULL candidate read that is entirely payer-linked leaves unseen rows => unknown (null), not "clear"', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, stripe_payment_intent_id: 'pi_ap' }));
    expect(await hasInFlightMoney('c1', flightDb({ candidates: full, payerInvoices: [APAY] }))).toBeNull();
  });
  test('a failed read, a failed payer-linkage lookup, or no customer is null (unknown => the aggregator reads it as in flight)', async () => {
    expect(await hasInFlightMoney('c1', flightDb({ rawThrows: true }))).toBeNull();
    expect(await hasInFlightMoney('c1', flightDb({ linkageFails: true }))).toBeNull();
    expect(await hasInFlightMoney(null, flightDb({}))).toBeNull();
  });
});


describe('isNeverAttemptedDeferral (shared placeholder predicate, Codex round-38 P1)', () => {
  const { isNeverAttemptedDeferral } = require('../services/failed-payments');
  const base = { stripe_payment_intent_id: null, retry_count: 0, next_retry_at: new Date() };
  test('armed lock_contention and collection_hold placeholders are both never-attempted', () => {
    expect(isNeverAttemptedDeferral({ ...base, metadata: { deferred_reason: 'lock_contention' } })).toBe(true);
    expect(isNeverAttemptedDeferral({ ...base, metadata: { deferred_reason: 'collection_hold' } })).toBe(true);
  });
  test('a lock placeholder the retry sweep collected (superseded by another row) is still a placeholder', () => {
    expect(isNeverAttemptedDeferral({ ...base, id: 'a', retry_count: 1, next_retry_at: null, superseded_by_payment_id: 'b', metadata: { deferred_reason: 'lock_contention' } })).toBe(true);
    expect(isNeverAttemptedDeferral({ ...base, id: 'a', retry_count: 1, next_retry_at: null, superseded_by_payment_id: 'a', metadata: { deferred_reason: 'lock_contention' } })).toBe(false);
  });
  test('a row a real attempt touched is not a placeholder', () => {
    expect(isNeverAttemptedDeferral({ ...base, stripe_payment_intent_id: 'pi_x', metadata: { deferred_reason: 'lock_contention' } })).toBe(false);
    expect(isNeverAttemptedDeferral({ ...base, metadata: { type: 'monthly_autopay' } })).toBe(false);
  });
});

// Codex round-41 P1 (PR #5331): history + in-flight probe judge payer ownership through the LIVE verdict

// (services/invoice-payer-ownership via payer-linkage.loadLivePayerLinkage), not just the stamped payer_id.
describe('live payer ownership (round-41)', () => {
  const { hasInFlightMoney, IN_FLIGHT_PAYMENTS_SQL } = require('../services/payment-history');
  // an invoice with payer_id NULL that RESOLVES to a payer today (scheduled service svc-ap)
  const LIVE_AP = { id: '11111111-1111-4111-8111-111111111111', customer_id: 'c1', scheduled_service_id: 'svc-ap', stripe_payment_intent_id: 'pi_live', stripe_charge_id: 'ch_live', invoice_number: 'WPC-2026-0900' };
  const OWN = { id: '22222222-2222-4222-8222-222222222222', customer_id: 'c1', scheduled_service_id: 'svc-own', invoice_number: 'WPC-2026-0901' };
  beforeEach(() => {
    mockResolve.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === 'svc-ap' ? 'payer-1' : null }));
  });

  test('hasInFlightMoney: an in-flight payment against a live-resolved payer invoice is NOT the homeowner\'s money', async () => {
    const linked = { id: 'p1', metadata: { invoice_id: LIVE_AP.id } };
    expect(await hasInFlightMoney('c1', flightFor({ candidates: [linked], liveInvoices: [LIVE_AP] }))).toBe(false);
    expect(await hasInFlightMoney('c1', flightFor({ candidates: [linked, { id: 'own', metadata: null }], liveInvoices: [LIVE_AP] }))).toBe(true);
  });
  test('hasInFlightMoney: a PROCESSING invoice that resolves to a payer does not count; the homeowner\'s does; full read of payer-owned => unknown', async () => {
    expect(await hasInFlightMoney('c1', flightFor({ invoiceRows: [{ id: LIVE_AP.id }], liveInvoices: [LIVE_AP] }))).toBe(false);
    expect(await hasInFlightMoney('c1', flightFor({ invoiceRows: [{ id: LIVE_AP.id }, { id: OWN.id }], liveInvoices: [LIVE_AP, OWN] }))).toBe(true);
    const full = Array.from({ length: 200 }, () => ({ id: LIVE_AP.id }));
    expect(await hasInFlightMoney('c1', flightFor({ invoiceRows: full, liveInvoices: [LIVE_AP] }))).toBeNull();
  });
  test('hasInFlightMoney: unverifiable live ownership => null (the aggregator reads it as in flight)', async () => {
    mockResolve.mockRejectedValue(new Error('resolver down'));
    // (a service with NO candidate payer is self-pay without a resolver lookup - the batched reads decide it; one WITH a candidate
    // payer still asks the resolver, and its failure is unknown)
    expect(await hasInFlightMoney('c1', flightFor({ liveInvoices: [OWN, LIVE_AP] }))).toBeNull();
  });

  function flightFor({ candidates = [], invoiceRows = [], liveInvoices = [] }) {
    const invoices = invoicesChains({ liveInvoices });
    const dbh = routeTables(invoices);
    dbh.raw = jest.fn(async (sql) => ({ rows: sql === IN_FLIGHT_PAYMENTS_SQL ? candidates : invoiceRows }));
    return dbh;
  }
});
