jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = '11111111-1111-4111-8111-111111111111';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/stripe', () => ({ getPaymentHistory: jest.fn() }));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const StripeService = require('../services/stripe');
const router = require('../routes/billing-v2');

let rawPayments;
let payerInvoiceIds;

function thenableBuilder(resolveRows, resolveFirst) {
  const builder = {};
  for (const method of ['where', 'whereNull', 'whereNotNull', 'whereRaw', 'select', 'count', 'orderBy', 'leftJoin', 'limit', 'offset']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => resolveFirst());
  builder.then = (resolve, reject) => Promise.resolve(resolveRows()).then(resolve, reject);
  builder.catch = (reject) => Promise.resolve(resolveRows()).catch(reject);
  return builder;
}

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/billing', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  payerInvoiceIds = [];
  rawPayments = Array.from({ length: 125 }, (_, index) => ({
    id: `payment-${index + 1}`,
    payment_date: `2026-${String(12 - Math.floor(index / 28)).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
    amount: '50.00',
    status: 'paid',
    description: index % 2 ? 'One-time service' : 'Gold WaveGuard Monthly',
    metadata: index % 2 ? {} : { billed_month: '2026-01' },
    card_brand: 'visa',
    last_four: '4242',
    method_type: 'card',
    refund_amount: index === 0 ? '10.00' : null,
    refund_status: index === 0 ? 'partial' : null,
  }));
  StripeService.getPaymentHistory.mockImplementation(async (_customerId, limit, offset = 0) => (
    rawPayments.slice(offset, offset + limit)
  ));
  db.mockImplementation((table) => {
    if (table === 'invoices') {
      return thenableBuilder(
        () => payerInvoiceIds.map((id) => ({ id })),
        () => null,
      );
    }
    if (table === 'payments') {
      return thenableBuilder(
        () => rawPayments.map(({ metadata, payer_id }) => ({ metadata, payer_id })),
        // The COUNT path's SQL excludes direct payer stamps; mirror that here.
        () => ({ count: String(rawPayments.filter((p) => p.payer_id == null && !(p.metadata && p.metadata.payer_id != null)).length) }),
      );
    }
    throw new Error(`Unexpected table ${table}`);
  });
});

afterEach(() => jest.clearAllMocks());

test('pages every payment without losing the look-ahead row', async () => {
  const collected = [];
  let cursor = 0;
  let lastPage;

  await withServer(async (baseUrl) => {
    do {
      const response = await fetch(`${baseUrl}/billing?limit=50&cursor=${cursor}`);
      expect(response.status).toBe(200);
      lastPage = await response.json();
      collected.push(...lastPage.payments);
      if (lastPage.hasMore) {
        expect(lastPage.nextCursor).toBeGreaterThan(cursor);
        cursor = lastPage.nextCursor;
      }
    } while (lastPage.hasMore);
  });

  expect(collected).toHaveLength(125);
  expect(new Set(collected.map((payment) => payment.id)).size).toBe(125);
  expect(lastPage).toMatchObject({ total: 125, hasMore: false, nextCursor: null });
  expect(collected[0]).toMatchObject({ refundAmount: 10, refundStatus: 'partial' });
});

test('filters third-party payer rows while keeping visible cursor pagination complete', async () => {
  payerInvoiceIds = ['payer-invoice'];
  rawPayments[1].metadata = { invoice_id: 'payer-invoice' };

  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/billing?limit=2&cursor=0`).then((response) => response.json());
    expect(first.payments.map((payment) => payment.id)).toEqual(['payment-1', 'payment-3']);
    expect(first).toMatchObject({ total: 124, hasMore: true });

    const second = await fetch(`${baseUrl}/billing?limit=2&cursor=${first.nextCursor}`)
      .then((response) => response.json());
    expect(second.payments[0].id).toBe('payment-4');
  });
});

// A row the ledger stamps as the payer's directly (payments.payer_id, or
// metadata.payer_id on statement refunds/disputes) is excluded whatever it
// links to — the chat payment card reads this same list.
test('filters rows stamped payer-owned directly, by column or metadata, with no payer invoice on file', async () => {
  payerInvoiceIds = [];
  rawPayments[1].payer_id = 7;
  rawPayments[2].metadata = { payer_id: 7, source: 'statement_refund' };

  await withServer(async (baseUrl) => {
    const first = await fetch(`${baseUrl}/billing?limit=3&cursor=0`).then((response) => response.json());
    expect(first.payments.map((payment) => payment.id)).toEqual(['payment-1', 'payment-4', 'payment-5']);
    expect(first.payments.some((payment) => payment.payerLookupFailed !== undefined)).toBe(false);
    expect(first).toMatchObject({ total: 123 });
  });
});

// B10: the collections-hold deferral row (armed, or left 'failed' after the retry sweep
// collected it through its own paid row) is a placeholder, not a payment. The history query (stripe.getPaymentHistory) and BOTH total-count queries apply
// the shared predicate, so the customer never sees a FAILED row for a charge that was never
// attempted and `total` still matches what pagination serves.
describe('hold-deferral placeholders (armed or collected) stay out of the customer payment history', () => {
  const predicateCalls = (builder) => builder.whereRaw.mock.calls.filter(([sql]) => /deferred_reason/.test(sql));

  test('the count query (no payer invoices) excludes them', async () => {
    const builders = [];
    const base = db.getMockImplementation();
    db.mockImplementation((table) => { const b = base(table); if (table === 'payments') builders.push(b); return b; });
    await withServer((baseUrl) => fetch(`${baseUrl}/billing?limit=50&cursor=0`).then((r) => r.json()));
    expect(builders).toHaveLength(1);
    const calls = predicateCalls(builders[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(['collection_hold', 'absorbed_annual_prepay']);
  });

  test('the payer-filtered count query excludes them too', async () => {
    payerInvoiceIds = ['payer-invoice'];
    const builders = [];
    const base = db.getMockImplementation();
    db.mockImplementation((table) => { const b = base(table); if (table === 'payments') builders.push(b); return b; });
    await withServer((baseUrl) => fetch(`${baseUrl}/billing?limit=50&cursor=0`).then((r) => r.json()));
    expect(builders).toHaveLength(1);
    expect(predicateCalls(builders[0])).toHaveLength(1);
  });

  test('the history query in stripe.js applies the shared predicate', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/stripe.js'), 'utf8');
    const body = src.slice(src.indexOf('async getPaymentHistory('), src.indexOf('// REFUND'));
    expect(body).toContain("excludeHoldDeferralPlaceholders(q, 'payments')");
    // Same-day rows (a failed attempt and its retry) order by creation, newest
    // first, so the first row is the latest outcome.
    expect(body).toContain(".orderBy('payments.created_at', 'desc')");
    expect(body).toContain(".orderBy('payments.id', 'desc')");
  });
});

test('rejects unbounded page sizes', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing?limit=500`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'limit must be 1-100 and cursor must be a non-negative integer',
    });
  });
  expect(StripeService.getPaymentHistory).not.toHaveBeenCalled();
});
