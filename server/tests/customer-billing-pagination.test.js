jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = '11111111-1111-4111-8111-111111111111';
    next();
  },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const PaymentRouter = require('../services/payment-router');
const router = require('../routes/billing-v2');

let rawPayments;
let payerInvoiceIds;
let historyService;

function thenableBuilder(resolveRows, resolveFirst) {
  const builder = {};
  for (const method of ['where', 'whereNotNull', 'select', 'count', 'orderBy', 'leftJoin', 'limit', 'offset']) {
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
  historyService = {
    getPaymentHistory: jest.fn(async (_customerId, limit, offset = 0) => (
      rawPayments.slice(offset, offset + limit)
    )),
  };
  PaymentRouter.getServiceForCustomer.mockResolvedValue(historyService);
  db.mockImplementation((table) => {
    if (table === 'invoices') {
      return thenableBuilder(
        () => payerInvoiceIds.map((id) => ({ id })),
        () => null,
      );
    }
    if (table === 'payments') {
      return thenableBuilder(
        () => rawPayments.map(({ metadata }) => ({ metadata })),
        () => ({ count: String(rawPayments.length) }),
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

test('rejects unbounded page sizes', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/billing?limit=500`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'limit must be 1-100 and cursor must be a non-negative integer',
    });
  });
  expect(historyService.getPaymentHistory).not.toHaveBeenCalled();
});
