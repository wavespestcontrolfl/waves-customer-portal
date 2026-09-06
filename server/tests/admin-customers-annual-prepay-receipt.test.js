// Recorded annual prepay must commit its receipt job with the payment.
// The route and queue insert are real; database and delivery are isolated.
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: () => new Date() };
  db.schema = { hasTable: jest.fn(async () => true) };
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../routes/estimate-public', () => ({ acceptanceServiceLists: jest.fn() }));
jest.mock('../services/lead-scorer', () => ({}));
jest.mock('../services/pipeline-manager', () => ({}));
jest.mock('../services/photos', () => ({}));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/contracts', () => ({}));
jest.mock('../services/customer-credit', () => ({}));
jest.mock('../services/secure-appointment-plans', () => ({
  findDirectRodentSetupObligationForCoverage: jest.fn(async () => null),
}));
jest.mock('../services/billing-pause', () => ({ maybeResumeBillingPauseOnPayment: jest.fn(async () => {}) }));
jest.mock('../services/invoice', () => ({
  create: jest.fn(async ({ database, customerId, lineItems }) => {
    const [invoice] = await database('invoices').insert({
      id: 'invoice-1', invoice_number: 'TEST-ANNUAL', customer_id: customerId,
      total: lineItems[0].unit_price, status: 'draft',
    }).returning('*');
    return invoice;
  }),
  sendReceipt: jest.fn(),
}));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({
  createTermForAnnualPrepay: jest.fn(async ({ conn, customerId, prepayInvoiceId, prepayAmount, termStart, termEnd }) => {
    const [term] = await conn('annual_prepay_terms').insert({
      id: 'term-1', customer_id: customerId, prepay_invoice_id: prepayInvoiceId,
      prepay_amount: prepayAmount, term_start: termStart, term_end: termEnd, status: 'active',
    }).returning('*');
    return term;
  }),
}));
jest.mock('../services/receipt-delivery-queue', () => ({
  ...jest.requireActual('../services/receipt-delivery-queue'),
  scheduleReceiptDeliveryDrain: jest.fn(),
}));

const db = require('../models/db');
const { gates } = require('../config/feature-gates');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const { scheduleReceiptDeliveryDrain } = require('../services/receipt-delivery-queue');
const { maybeResumeBillingPauseOnPayment } = require('../services/billing-pause');
const { recordAuditEvent } = require('../services/audit-log');
const router = require('../routes/admin-customers');
const route = router.stack.find((layer) => layer.route?.path === '/:id/annual-prepay' && layer.route.methods.post);
const handler = route.route.stack.at(-1).handle;
const originalGate = gates.recordedAnnualPrepayReceipt;

let committed;
let transactionWrites;
let queueError;
let commitError;
let events;

// Only the columns/operations this route uses; transaction writes live in a
// separate snapshot until commit. This is not PostgreSQL verification.
function table(rows, name) {
  if (!rows[name]) throw new Error(`Unexpected table: ${name}`);
  const q = {};
  let selected = rows[name];
  let result = selected;
  q.where = (condition) => {
    if (condition && typeof condition === 'object') {
      selected = selected.filter((row) => Object.entries(condition).every(([key, value]) => row[key] === value));
    }
    return q;
  };
  q.whereNull = () => q;
  q.orderBy = () => q;
  q.first = async () => selected[0] || null;
  q.update = (values) => {
    for (const row of selected) Object.assign(row, values);
    result = selected;
    return q;
  };
  q.insert = (values) => {
    if (name === 'receipt_delivery_jobs' && queueError) throw queueError;
    const row = { id: `${name}-1`, ...values };
    rows[name].push(row);
    result = [row];
    events.push(`insert:${name}`);
    return q;
  };
  q.onConflict = () => q;
  q.ignore = () => q;
  q.returning = async () => result;
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  gates.recordedAnnualPrepayReceipt = true;
  queueError = null;
  commitError = null;
  events = [];
  committed = {
    customers: [{ id: 'customer-1', monthly_rate: null, deleted_at: null }],
    invoices: [], payments: [], annual_prepay_terms: [], activity_log: [], receipt_delivery_jobs: [],
  };
  db.mockImplementation((name) => {
    if (name === 'receipt_delivery_jobs') throw new Error('Receipt enqueue escaped the payment transaction');
    return table(committed, name);
  });
  db.transaction.mockImplementation(async (callback) => {
    transactionWrites = structuredClone(committed);
    const trx = (name) => table(transactionWrites, name);
    trx.fn = db.fn;
    trx.raw = jest.fn(async () => ({}));
    await callback(trx);
    if (commitError) throw commitError;
    committed = transactionWrites;
    events.push('commit');
  });
  scheduleReceiptDeliveryDrain.mockImplementation(() => {
    expect(committed.invoices[0].status).toBe('paid');
    expect(committed.payments).toHaveLength(1);
    expect(committed.receipt_delivery_jobs).toHaveLength(1);
    events.push('drain');
  });
});

afterAll(() => { gates.recordedAnnualPrepayReceipt = originalGate; });

async function recordPrepay(overrides = {}) {
  const req = {
    params: { id: 'customer-1' }, technicianId: 'admin-1', get: () => 'test',
    body: {
      amount: 420, visitCount: 4, serviceType: 'Quarterly Pest Control', coverageCadence: 'quarterly',
      method: 'cash', termStart: '2030-01-10', termEnd: '2031-01-10', ...overrides,
    },
  };
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler(req, res, next);
  return { res, next };
}

test.each(['cash', 'check', 'card_present', 'zelle', 'venmo', 'paypal', 'other'])(
  '%s: records payment and queues one receipt before commit; drains after commit', async (method) => {
    const { res, next } = await recordPrepay({ method });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, invoice: expect.objectContaining({ status: 'paid', total: 420, payment_method: method }),
    }));
    expect(committed.receipt_delivery_jobs).toEqual([expect.objectContaining({
      invoice_id: 'invoice-1', stripe_payment_intent_id: null, source: 'customer360_annual_prepay',
      status: 'queued', customer_initiated: true,
    })]);
    expect(events.indexOf('insert:payments')).toBeLessThan(events.indexOf('insert:receipt_delivery_jobs'));
    expect(events.indexOf('insert:receipt_delivery_jobs')).toBeLessThan(events.indexOf('commit'));
    expect(events.indexOf('commit')).toBeLessThan(events.indexOf('drain'));
    expect(scheduleReceiptDeliveryDrain).toHaveBeenCalledTimes(1);
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  },
);

test('gate off records the payment without a receipt job or delivery nudge', async () => {
  gates.recordedAnnualPrepayReceipt = false;
  const { res, next } = await recordPrepay();
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(201);
  expect(committed.payments).toHaveLength(1);
  expect(committed.receipt_delivery_jobs).toHaveLength(0);
  expect(scheduleReceiptDeliveryDrain).not.toHaveBeenCalled();
});

test.each(['queue', 'commit'])('%s failure rolls back payment, coverage and receipt; never starts delivery', async (failure) => {
  const error = new Error(`${failure} unavailable`);
  if (failure === 'queue') queueError = error;
  else commitError = error;
  const { res, next } = await recordPrepay();
  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
  for (const name of ['invoices', 'payments', 'annual_prepay_terms', 'receipt_delivery_jobs']) {
    expect(committed[name]).toHaveLength(0);
  }
  expect(scheduleReceiptDeliveryDrain).not.toHaveBeenCalled();
});

test('invalid amount never creates a payment or receipt', async () => {
  const { res } = await recordPrepay({ amount: 0 });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(scheduleReceiptDeliveryDrain).not.toHaveBeenCalled();
});

test('retrying the recorded prepay refuses overlapping coverage without a second receipt', async () => {
  await recordPrepay();
  const { res, next } = await recordPrepay();
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(409);
  expect(committed.payments).toHaveLength(1);
  expect(committed.receipt_delivery_jobs).toHaveLength(1);
  expect(scheduleReceiptDeliveryDrain).toHaveBeenCalledTimes(1);
});

test('a post-commit audit failure cannot lose the already queued receipt', async () => {
  recordAuditEvent.mockRejectedValueOnce(new Error('audit unavailable'));
  const { next } = await recordPrepay();
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'audit unavailable' }));
  expect(committed.receipt_delivery_jobs).toHaveLength(1);
  expect(scheduleReceiptDeliveryDrain).toHaveBeenCalledTimes(1);
  expect(maybeResumeBillingPauseOnPayment).toHaveBeenCalled();
});

test.each([undefined, 'false', '1', 'true'])('receipt rollout requires explicit true (value %s)', (value) => {
  const saved = process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT;
  try {
    if (value === undefined) delete process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT;
    else process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT = value;
    jest.isolateModules(() => {
      expect(require('../config/feature-gates').gates.recordedAnnualPrepayReceipt).toBe(value === 'true');
    });
  } finally {
    if (saved === undefined) delete process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT;
    else process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT = saved;
  }
});
