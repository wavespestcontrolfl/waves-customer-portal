/**
 * persistProjectInvoiceLink under a transaction holds the invoice row FOR SHARE until the OUTER transaction commits (so the
 * Intelligence Bar's credit application, which holds that row FOR UPDATE, serializes with project links). A reprice of the
 * adopted WDO draft (InvoiceService.update) runs on its OWN connection and needs the row FOR UPDATE: called after the link inside the
 * same outer transaction it waits on a lock its own caller holds (a hang, not a deadlock Postgres can detect). The reprice therefore
 * runs BEFORE the link at both adoption sites. The fake database below models row locks per connection and fails the call that would wait
 * on its own transaction. NOTE: this is a model, not Postgres; two real sessions are not exercised here. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockHeld = new Set();
const mockUpdateCalls = [];
jest.mock('../models/db', () => Object.assign(jest.fn(), { fn: { now: () => 'NOW()' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/invoice', () => {
  const actual = jest.requireActual('../services/invoice');
  // The reprice's write: needs the invoice row FOR UPDATE on its own connection.
  actual.update = jest.fn(async (id, body) => {
    mockUpdateCalls.push({ id, heldAtCall: [...mockHeld] });
    if (mockHeld.has(id)) throw new Error('SELF-WAIT: InvoiceService.update needs FOR UPDATE on a row its own outer transaction holds FOR SHARE');
    return { id, status: 'draft', title: 'WDO Inspection', line_items: body.line_items, total: body.line_items[0].unit_price };
  });
  return actual;
});

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { resolveOrCreateProjectInvoice } = require('../routes/admin-projects');

const INV = 'inv-draft-1';
const STALE_DRAFT = {
  id: INV, customer_id: 'cust-1', status: 'draft', title: 'WDO Inspection', invoice_number: 'WPC-2099-0100', scheduled_service_id: 'visit-1',
  line_items: [{ description: 'WDO Inspection (FDACS-13645 Wood-Destroying Organisms Inspection Report)', quantity: 1, unit_price: 100, amount: 100 }],
};
const PROJECT = () => ({ id: 'proj-1', customer_id: 'cust-1', project_type: 'wdo_inspection', scheduled_service_id: 'visit-1', service_record_id: null, invoice_id: null, findings: { inspection_fee: '125' } });

let events;
// A connection-aware stand-in: the outer transaction's handle records the invoice rows it locks FOR SHARE (until commit) and the order of
// every statement; a savepoint (trx.transaction) stays on the same connection, as in knex.
function installDb() {
  events = [];
  mockHeld.clear();
  mockUpdateCalls.length = 0;
  db.mockImplementation(() => { throw new Error('unexpected pooled read'); });
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => {
      const q = { table, lock: null, whereArg: null };
      const b = {
        where: (arg) => { if (arg && typeof arg === 'object' && typeof arg !== 'function') q.whereArg = arg; return b; },
        whereNotIn: () => b, whereIn: () => b, orderBy: () => b, orWhere: () => b,
        forUpdate: () => { q.lock = 'update'; return b; },
        forShare: () => { q.lock = 'share'; return b; },
        first: async () => {
          events.push(`${table}:${q.lock ? `lock ${q.lock}` : 'read'}`);
          if (table === 'invoices' && q.lock === 'share') mockHeld.add(q.whereArg.id);
          if (table === 'projects') return { ...PROJECT() };
          if (table === 'invoices') return q.lock ? { id: q.whereArg.id } : { ...STALE_DRAFT };
          return undefined;
        },
        update: async (values) => { events.push(`${table}:update ${Object.keys(values).join(',')}`); return 1; },
      };
      return b;
    };
    trx.fn = { now: () => 'NOW()' };
    trx.transaction = jest.fn(async (inner) => inner(trx));
    try {
      return await fn(trx);
    } finally {
      mockHeld.clear(); // commit or rollback releases the locks
    }
  });
}

beforeEach(() => { jest.clearAllMocks(); installDb(); });

describe('adopting a draft WDO invoice does not wait on its own invoice lock', () => {
  test('the stale-priced draft adopted by the scheduled-visit reuse is repriced BEFORE the link takes the invoice FOR SHARE', async () => {
    const project = PROJECT();
    const result = await resolveOrCreateProjectInvoice({ project, customer: { id: 'cust-1' }, invoiceId: null });
    expect(InvoiceService.update).toHaveBeenCalledTimes(1);
    // No share lock was held when the reprice ran, so it cannot wait on its own transaction.
    expect(mockUpdateCalls).toEqual([{ id: INV, heldAtCall: [] }]);
    expect(result).toMatchObject({ created: false, invoice: { id: INV, total: 125 } });
    expect(project.invoice_id).toBe(INV);
    // Order inside the transaction: project lock, invoice read, THEN the link's invoice share lock and the project update.
    const order = events.filter((e) => /^(projects:lock update|invoices:lock share|projects:update)/.test(e));
    expect(order).toEqual(['projects:lock update', 'invoices:lock share', 'projects:update invoice_id,updated_at']);
  });

  test('the harness would catch the old order: a reprice issued after the link on the same outer transaction fails', async () => {
    let failure;
    await db.transaction(async (trx) => {
      await trx('invoices').where({ id: INV }).forShare().first('id');
      try { await InvoiceService.update(INV, { line_items: [{ unit_price: 125 }] }); } catch (err) { failure = err; }
    });
    expect(failure?.message).toMatch(/SELF-WAIT/);
  });

  test('an invoice that already reads the right price is adopted with no reprice at all', async () => {
    const fresh = { ...STALE_DRAFT, line_items: [{ ...STALE_DRAFT.line_items[0], unit_price: 125, amount: 125 }] };
    const project = { ...PROJECT() };
    const original = db.transaction;
    db.transaction = jest.fn(async (fn) => original(async (trx) => fn(Object.assign((table) => {
      const b = trx(table);
      const first = b.first;
      b.first = async (...a) => { const row = await first(...a); return table === 'invoices' && row && !row.lock && row.line_items ? fresh : row; };
      return b;
    }, trx))));
    await resolveOrCreateProjectInvoice({ project, customer: { id: 'cust-1' }, invoiceId: null });
    expect(InvoiceService.update).not.toHaveBeenCalled();
  });
});

describe('every persistProjectInvoiceLink(…, trx) caller is audited (source contract)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-projects.js'), 'utf8');
  const fn = source.slice(source.indexOf('async function resolveOrCreateProjectInvoice('), source.indexOf('// Normalize an invoice\'s line_items into an array for PDF rendering'));

  test('the two adoption sites reprice before they link; no site writes the linked invoice after the link call', () => {
    expect(fn.indexOf('await maybeRepriceWdoDraft(linked, project)')).toBeGreaterThan(-1);
    expect(fn.indexOf('await maybeRepriceWdoDraft(linked, project)')).toBeLessThan(fn.indexOf('await persistProjectInvoiceLink(project, linked.id, trx)'));
    expect(fn.indexOf('await maybeRepriceWdoDraft(lockedReuse, project)')).toBeGreaterThan(-1);
    expect(fn.indexOf('await maybeRepriceWdoDraft(lockedReuse, project)')).toBeLessThan(fn.indexOf('await persistProjectInvoiceLink(project, lockedReuse.id, trx)'));
    // After any trx-linked persist call, the statement that follows within the same block is a return or a throw, never a reprice or an update.
    const re = /await persistProjectInvoiceLink\(project, [\w.]+, trx\);\n([^\n]*(?:\n[^\n]*){0,6})/g;
    let m;
    let sites = 0;
    while ((m = re.exec(fn))) {
      sites += 1;
      const tail = m[1].split('}')[0];
      expect(tail).not.toMatch(/maybeRepriceWdoDraft|InvoiceService\.update|\.update\(/);
    }
    expect(sites).toBe(6);
  });

  test('the explicit-invoice path links on its own short transaction (committed) before it reprices', () => {
    const explicit = fn.slice(fn.indexOf('if (invoiceId) {'), fn.indexOf('return db.transaction'));
    expect(explicit.indexOf('await persistProjectInvoiceLink(project, explicit.id)')).toBeLessThan(explicit.indexOf('maybeRepriceWdoDraft(explicit, project)'));
    expect(explicit).not.toMatch(/persistProjectInvoiceLink\(project, explicit\.id, trx\)/);
  });
});
