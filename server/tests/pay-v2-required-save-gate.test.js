jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { invoiceRequiresSavedMethod, invoiceCaptureNeeded } = require('../routes/pay-v2');

// Chainable query mock: builder methods return `this`; `.first()` resolves
// (or rejects) the configured value.
function qb({ first = null, firstError = null } = {}) {
  const q = {};
  ['where', 'whereNot', 'whereNotNull', 'whereIn'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => {
    if (firstError) throw firstError;
    return first;
  });
  return q;
}

function setQueues(queues) {
  const tables = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tables.get(table);
    if (!queue || !queue.length) throw new Error(`unexpected db('${table}') call`);
    return queue.shift();
  });
}

const INVOICE = { customer_id: 'cust-1', scheduled_service_id: 'ss-1' };

describe('invoiceRequiresSavedMethod fail-closed error handling (Codex #2507 round-6 P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('billing_mode customer requires save (baseline)', async () => {
    setQueues({ customers: [qb({ first: { billing_mode: 'per_application', monthly_rate: 55.3 } })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).resolves.toBe(true);
  });

  test('expected pre-migration shape (undefined column 42703) relaxes to false', async () => {
    const err = new Error('column "billing_mode" does not exist');
    err.code = '42703';
    setQueues({ customers: [qb({ firstError: err })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).resolves.toBe(false);
  });

  test('any OTHER lookup error surfaces — a transient prod read failure must fail the request, never silently drop the requirement', async () => {
    const err = new Error('connection reset');
    setQueues({ customers: [qb({ firstError: err })] });
    await expect(invoiceRequiresSavedMethod(INVOICE)).rejects.toThrow('connection reset');
  });

  test('scheduled-service lookup error surfaces the same way', async () => {
    const err = new Error('timeout');
    setQueues({
      customers: [qb({ first: { billing_mode: null, monthly_rate: 89 } })],
      scheduled_services: [qb({ firstError: err })],
    });
    await expect(invoiceRequiresSavedMethod(INVOICE)).rejects.toThrow('timeout');
  });

  test('payer-billed invoices never require save (no lookup at all)', async () => {
    setQueues({});
    await expect(invoiceRequiresSavedMethod({ ...INVOICE, payer_id: 'payer-1' })).resolves.toBe(false);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('invoiceCaptureNeeded fail-closed error handling (Codex #2507 round-6 P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('unknown autopay state reads as CAPTURE NEEDED — this is the only gate on the covered-by-credit capture step and there is no PI/webhook fallback', async () => {
    setQueues({ customers: [qb({ firstError: new Error('connection reset') })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(true);
  });

  test('missing customer row is a data answer, not an error — no capture surface to offer', async () => {
    setQueues({ customers: [qb({ first: null })] });
    await expect(invoiceCaptureNeeded(INVOICE)).resolves.toBe(false);
  });
});
