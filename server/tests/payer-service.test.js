jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const PayerService = require('../services/payer');

// Minimal knex-ish chain: where(...).first(...) resolves to the table's result.
function makeDb(tables) {
  return jest.fn((table) => {
    const result = Object.prototype.hasOwnProperty.call(tables, table) ? tables[table] : null;
    const chain = {
      where: () => chain,
      first: () => Promise.resolve(result),
    };
    return chain;
  });
}

describe('PayerService.resolveForInvoice precedence', () => {
  test('per-job payer on the scheduled service wins over the customer default', async () => {
    const database = makeDb({
      scheduled_services: { payer_id: 10, po_number: 'PO-1' },
      customers: { payer_id: 20 },
      payers: { id: 10, active: true },
    });
    const out = await PayerService.resolveForInvoice({
      database, customerId: 'c1', scheduledServiceId: 's1',
    });
    expect(out).toEqual({ payerId: 10, poNumber: 'PO-1' });
  });

  test('falls back to the customer default payer when the job has none', async () => {
    const database = makeDb({
      scheduled_services: { payer_id: null, po_number: null },
      customers: { payer_id: 20 },
      payers: { id: 20, active: true },
    });
    const out = await PayerService.resolveForInvoice({
      database, customerId: 'c1', scheduledServiceId: 's1',
    });
    expect(out).toEqual({ payerId: 20, poNumber: null });
  });

  test('an inactive payer link resolves to self-pay (null), not a dead AP inbox', async () => {
    const database = makeDb({
      customers: { payer_id: 20 },
      payers: { id: 20, active: false },
    });
    const out = await PayerService.resolveForInvoice({ database, customer: { payer_id: 20 } });
    expect(out).toEqual({ payerId: null, poNumber: null });
  });

  test('no payer anywhere → self-pay', async () => {
    const database = makeDb({ customers: { payer_id: null }, payers: null });
    const out = await PayerService.resolveForInvoice({ database, customer: { payer_id: null } });
    expect(out).toEqual({ payerId: null, poNumber: null });
  });

  test('never throws — a DB failure fails soft to self-pay', async () => {
    const database = jest.fn(() => { throw new Error('boom'); });
    const out = await PayerService.resolveForInvoice({
      database, customerId: 'c1', scheduledServiceId: 's1',
    });
    expect(out).toEqual({ payerId: null, poNumber: null });
  });
});
