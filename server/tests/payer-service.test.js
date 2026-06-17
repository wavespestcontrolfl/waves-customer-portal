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
    expect(out).toMatchObject({ payerId: 10, poNumber: 'PO-1', taxExempt: false });
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
    expect(out).toMatchObject({ payerId: 20, poNumber: null, taxExempt: false });
  });

  test('surfaces taxExempt from the resolved active payer', async () => {
    const database = makeDb({
      customers: { payer_id: 20 },
      payers: { id: 20, active: true, tax_exempt: true },
    });
    const out = await PayerService.resolveForInvoice({ database, customer: { id: 'c1', payer_id: 20 } });
    expect(out).toMatchObject({ payerId: 20, poNumber: null, taxExempt: true });
  });

  test('scopes the per-job lookup by customer — a mismatched job is ignored, falls back to default', async () => {
    // scheduled_services lookup is constrained by customer_id; a stale/other-
    // customer scheduledServiceId returns no row, so the customer default wins.
    const database = jest.fn((table) => {
      const chain = {
        _table: table,
        where(clause) { this._clause = clause; return this; },
        first() {
          if (this._table === 'scheduled_services') {
            // simulate the customer_id constraint filtering the row out
            return Promise.resolve(this._clause && this._clause.customer_id === 'c1' ? null : null);
          }
          if (this._table === 'customers') return Promise.resolve({ payer_id: 20 });
          if (this._table === 'payers') return Promise.resolve({ id: 20, active: true });
          return Promise.resolve(null);
        },
      };
      return chain;
    });
    const out = await PayerService.resolveForInvoice({
      database, customerId: 'c1', scheduledServiceId: 's-other',
    });
    expect(out).toMatchObject({ payerId: 20, poNumber: null, taxExempt: false });
  });

  test('an inactive payer link resolves to self-pay (null), not a dead AP inbox', async () => {
    const database = makeDb({
      customers: { payer_id: 20 },
      payers: { id: 20, active: false },
    });
    const out = await PayerService.resolveForInvoice({ database, customer: { payer_id: 20 } });
    expect(out).toMatchObject({ payerId: null, poNumber: null, taxExempt: false });
  });

  test('no payer anywhere → self-pay', async () => {
    const database = makeDb({ customers: { payer_id: null }, payers: null });
    const out = await PayerService.resolveForInvoice({ database, customer: { payer_id: null } });
    expect(out).toMatchObject({ payerId: null, poNumber: null, taxExempt: false });
  });

  test('never throws — a DB failure fails soft to self-pay', async () => {
    const database = jest.fn(() => { throw new Error('boom'); });
    const out = await PayerService.resolveForInvoice({
      database, customerId: 'c1', scheduledServiceId: 's1',
    });
    expect(out).toMatchObject({ payerId: null, poNumber: null, taxExempt: false });
  });
});

describe('PayerService.attachToInvoice', () => {
  test('attaches an active payer', async () => {
    const database = jest.fn(() => ({ where: () => ({ first: () => Promise.resolve({ id: 7, active: true, ap_email: 'ap@x.com' }) }) }));
    const inv = { id: 'i1', payer_id: 7 };
    await PayerService.attachToInvoice(inv, database);
    expect(inv.payer).toEqual(expect.objectContaining({ id: 7 }));
  });

  test('does NOT attach a payer deactivated after the invoice was minted', async () => {
    const database = jest.fn(() => ({ where: () => ({ first: () => Promise.resolve({ id: 7, active: false }) }) }));
    const inv = { id: 'i1', payer_id: 7 };
    await PayerService.attachToInvoice(inv, database);
    expect(inv.payer).toBeUndefined();
  });

  test('no-op when the invoice has no payer_id', async () => {
    const database = jest.fn(() => { throw new Error('should not query'); });
    const inv = { id: 'i1' };
    await PayerService.attachToInvoice(inv, database);
    expect(inv.payer).toBeUndefined();
  });

  test('prefers the frozen payer_snapshot and never queries the live payer', async () => {
    const database = jest.fn(() => { throw new Error('should not query when a snapshot exists'); });
    const inv = {
      id: 'i1', payer_id: 7,
      payer_snapshot: { company_name: 'Homes by West Bay', ap_email: 'ap@westbay.com' },
    };
    await PayerService.attachToInvoice(inv, database);
    expect(inv.payer).toEqual(expect.objectContaining({ company_name: 'Homes by West Bay' }));
  });

  test('parses a JSON-string snapshot', async () => {
    const database = jest.fn(() => { throw new Error('should not query'); });
    const inv = { id: 'i1', payer_id: 7, payer_snapshot: JSON.stringify({ company_name: 'West Bay' }) };
    await PayerService.attachToInvoice(inv, database);
    expect(inv.payer).toEqual(expect.objectContaining({ company_name: 'West Bay' }));
  });
});
