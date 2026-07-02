// Unit tests for estimate-payment-context — the exact, ledger-backed payment
// posture the scheduling surfaces show (annual prepay paid/pending, the
// pay-per-application setup-fee invoice). Amounts must come straight from the
// persisted term/invoice rows, and every read must fail soft.

let mockDbHandler = () => { throw new Error('db handler not configured'); };

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  buildEstimatePaymentContext,
  _private: { sumMatchingLines, invoiceIsPaid, SETUP_FEE_RE, FIRST_APPLICATION_RE },
} = require('../services/estimate-payment-context');

// Chainable knex-table mock: .where().whereNotIn().orderBy().first() etc.
// resolve to whatever the per-table `first` handler returns.
function tableMock(firstResult) {
  const chain = {};
  const self = () => chain;
  ['where', 'whereNotIn', 'whereIn', 'whereNull', 'orderBy'].forEach((m) => {
    chain[m] = jest.fn(self);
  });
  chain.first = jest.fn(async () => (typeof firstResult === 'function' ? firstResult() : firstResult));
  return chain;
}

function configureDb(tables) {
  mockDbHandler = (tableName) => {
    if (!(tableName in tables)) throw new Error(`unexpected table ${tableName}`);
    const spec = tables[tableName];
    return typeof spec === 'function' ? spec() : tableMock(spec);
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbHandler = () => { throw new Error('db handler not configured'); };
});

describe('sumMatchingLines — exact cents from persisted line items', () => {
  it('sums only matching lines, quantity-aware, to the cent', () => {
    const invoice = {
      line_items: JSON.stringify([
        { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
        { description: 'First service application', quantity: 1, unit_price: 135.67 },
        { description: 'Something else', quantity: 1, unit_price: 12.34 },
      ]),
    };
    expect(sumMatchingLines(invoice, SETUP_FEE_RE)).toBe(99);
    expect(sumMatchingLines(invoice, FIRST_APPLICATION_RE)).toBe(135.67);
  });

  it('returns null (not 0) when no line matches, so absence is distinguishable', () => {
    const invoice = { line_items: [{ description: 'First service application', unit_price: 135.67 }] };
    expect(sumMatchingLines(invoice, SETUP_FEE_RE)).toBe(null);
  });

  it('tolerates unparseable line_items', () => {
    expect(sumMatchingLines({ line_items: '{nope' }, SETUP_FEE_RE)).toBe(null);
    expect(sumMatchingLines({}, SETUP_FEE_RE)).toBe(null);
  });
});

describe('invoiceIsPaid', () => {
  it('accepts paid/prepaid status or a paid_at stamp', () => {
    expect(invoiceIsPaid({ status: 'paid' })).toBe(true);
    expect(invoiceIsPaid({ status: 'prepaid' })).toBe(true);
    expect(invoiceIsPaid({ status: 'sent', paid_at: '2026-06-12T15:00:00Z' })).toBe(true);
    expect(invoiceIsPaid({ status: 'sent' })).toBe(false);
    expect(invoiceIsPaid(null)).toBe(false);
  });
});

describe('buildEstimatePaymentContext', () => {
  const estimate = { id: 'est-1', customer_id: 'cust-1', status: 'accepted' };

  it('returns the exact prepay term + paid invoice state for annual prepay', async () => {
    configureDb({
      scheduled_services: { annual_prepay_term_id: null, payment_method_preference: 'prepay_annual' },
      annual_prepay_terms: {
        id: 'term-1',
        status: 'active',
        plan_label: 'WaveGuard Bronze Annual Prepay',
        prepay_amount: '743.06',
        term_start: '2026-06-12',
        term_end: '2027-06-11',
        coverage_service_type: 'Quarterly Pest Control',
        coverage_visit_count: 4,
        prepay_invoice_id: 'inv-9',
      },
      invoices: { id: 'inv-9', status: 'paid', paid_at: '2026-06-12T15:00:00Z', total: '743.06' },
    });

    const ctx = await buildEstimatePaymentContext(estimate, { scheduledServiceId: 'ss-1' });
    expect(ctx.billingTerm).toBe('prepay_annual');
    expect(ctx.annualPrepay).toMatchObject({
      termId: 'term-1',
      paid: true,
      prepayAmount: 743.06,
      coverageVisitCount: 4,
      invoiceStatus: 'paid',
      invoiceTotal: 743.06,
    });
    expect(ctx.acceptanceInvoice).toBe(null);
  });

  it('reports a payment_pending term with an unpaid invoice as not paid', async () => {
    configureDb({
      scheduled_services: { annual_prepay_term_id: null, payment_method_preference: null },
      annual_prepay_terms: {
        id: 'term-2',
        status: 'payment_pending',
        prepay_amount: '600.00',
        prepay_invoice_id: 'inv-2',
        term_start: '2026-07-01',
        term_end: '2027-06-30',
      },
      invoices: { id: 'inv-2', status: 'sent', paid_at: null, total: '600.00' },
    });

    const ctx = await buildEstimatePaymentContext(estimate, { scheduledServiceId: 'ss-2' });
    expect(ctx.billingTerm).toBe('prepay_annual');
    expect(ctx.annualPrepay.paid).toBe(false);
    expect(ctx.annualPrepay.prepayAmount).toBe(600);
  });

  it('treats a lagging payment_pending term as paid when the invoice has settled', async () => {
    configureDb({
      scheduled_services: { annual_prepay_term_id: null, payment_method_preference: null },
      annual_prepay_terms: {
        id: 'term-3',
        status: 'payment_pending',
        prepay_amount: '500.00',
        prepay_invoice_id: 'inv-3',
      },
      invoices: { id: 'inv-3', status: 'paid', paid_at: '2026-06-20T12:00:00Z', total: '500.00' },
    });

    const ctx = await buildEstimatePaymentContext(estimate, {});
    expect(ctx.annualPrepay.paid).toBe(true);
  });

  it('resolves the pay-per-application acceptance invoice with exact line amounts', async () => {
    configureDb({
      scheduled_services: { annual_prepay_term_id: null, payment_method_preference: 'pay_at_visit' },
      annual_prepay_terms: null,
      invoices: {
        id: 'inv-5',
        title: 'WaveGuard Membership Setup + First Application',
        status: 'paid',
        paid_at: '2026-06-15T10:00:00Z',
        total: '234.67',
        notes: 'Auto-generated from accepted estimate #est-1. Customer selected pay per application — $99 setup fee plus first application.',
        line_items: JSON.stringify([
          { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
          { description: 'First service application', quantity: 1, unit_price: 135.67 },
        ]),
      },
    });

    const ctx = await buildEstimatePaymentContext(estimate, { scheduledServiceId: 'ss-5' });
    expect(ctx.billingTerm).toBe('standard');
    expect(ctx.annualPrepay).toBe(null);
    expect(ctx.acceptanceInvoice).toMatchObject({
      id: 'inv-5',
      paid: true,
      total: 234.67,
      setupFeeAmount: 99,
      firstApplicationAmount: 135.67,
    });
  });

  it('flags a chosen-but-unrecorded prepay so the card never invents an amount', async () => {
    configureDb({
      scheduled_services: { annual_prepay_term_id: null, payment_method_preference: 'prepay_annual' },
      annual_prepay_terms: null,
      invoices: null,
    });

    const ctx = await buildEstimatePaymentContext(estimate, { scheduledServiceId: 'ss-6' });
    expect(ctx.billingTerm).toBe('prepay_annual');
    expect(ctx.annualPrepay).toBe(null);
    expect(ctx.acceptanceInvoice).toBe(null);
  });

  it('fails soft to nulls when every read throws', async () => {
    mockDbHandler = () => { throw new Error('boom'); };
    const ctx = await buildEstimatePaymentContext(estimate, { scheduledServiceId: 'ss-7' });
    expect(ctx).toEqual({
      billingTerm: null,
      paymentPreference: null,
      annualPrepay: null,
      acceptanceInvoice: null,
    });
  });

  it('returns null without an estimate', async () => {
    expect(await buildEstimatePaymentContext(null)).toBe(null);
  });
});
