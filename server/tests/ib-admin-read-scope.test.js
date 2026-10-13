/**
 * read_admin_data inside a task for one customer (Codex round 1 P1): the
 * effective scope comes from the reviewed row of the endpoint named. A customer
 * or invoice row must name the task customer's own record; a broad row is
 * refused in a customer task, as before. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
// The scope behavior is tested against a fixture catalog, so a reviewed
// endpoint that goes stale and leaves the committed catalog cannot break it.
// The last describe checks the committed catalog's own scope fields.
jest.mock('../services/intelligence-bar/admin-read-catalog.json', () => {
  const entry = (endpoint, scope, scopeParam, extra = {}) => {
    const params = (endpoint.match(/:[A-Za-z]+/g) || []).map(name => name.slice(1));
    return { endpoint, params, screens: [], handlers: [], label: endpoint, scope, ...(scopeParam ? { scopeParam } : {}),
      paramKinds: Object.fromEntries(params.map(name => [name, name === 'id' && scope === 'broad' ? 'int' : 'uuid'])), query: [], ...extra };
  };
  return {
    version: 1,
    entries: [
      entry('/admin/customers/:id/credits', 'customer', 'id'),
      entry('/admin/customers/:id/autopay-state', 'customer', 'id'),
      entry('/admin/neighborhood-access/customers/:customerId/properties', 'customer', 'customerId'),
      entry('/admin/invoices/service-records/:customerId', 'customer', 'customerId'),
      entry('/admin/schedule/next-visit', 'customer', 'customerId', { query: ['customerId'] }),
      entry('/admin/invoices/:id/credit-context', 'invoice', 'id'),
      entry('/admin/invoices/:id/receipt-address', 'invoice', 'id'),
      entry('/admin/invoices/:id/attachments', 'invoice', 'id'),
      entry('/admin/payers', 'broad'),
      entry('/admin/payers/:id', 'broad'),
      entry('/admin/invoices/customers/search', 'broad'),
      entry('/admin/discounts', 'broad'),
    ],
    blockedRoutes: [],
  };
});
const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');
const catalog = jest.requireActual('../services/intelligence-bar/admin-read-catalog.json');
const reviewed = require('../services/intelligence-bar/admin-read-reviewed.json');

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const INVOICE_A = '20000000-0000-4000-8000-00000000000a';
const INVOICE_B = '20000000-0000-4000-8000-00000000000b';
const TOOL = 'read_admin_data';
const schema = { properties: {} };

beforeEach(() => {
  const rows = {
    customers: [{ id: A }, { id: B }],
    invoices: [{ id: INVOICE_A, customer_id: A }, { id: INVOICE_B, customer_id: B }],
  };
  db.mockReset().mockImplementation((table) => {
    let ids = [];
    const q = {
      whereIn: (_key, values) => { ids = values; return q; },
      whereNull: () => q,
      select: () => q,
      then: (resolve, reject) => Promise.resolve((rows[table] || []).filter(row => ids.includes(row.id))).then(resolve, reject),
    };
    return q;
  });
  db.raw = text => ({ text });
});

const taskFor = (id, extra = {}) => ({
  targets: [{ customer_id: id, provenance: 'current_request_lookup' }], target: { customer_id: id }, ambiguous: false,
  candidates: [], page: { ids: {}, records: {} }, requestedRecords: {}, ...extra,
});
const NO_TASK = { targets: [], ambiguous: false, candidates: [], page: { ids: {}, records: {} }, requestedRecords: {} };
const prepare = (input, context) => Context.prepareReadInput(input, context, { toolName: TOOL, schema });

const CUSTOMER_ENDPOINTS = [
  ['/admin/customers/:id/credits', 'id'],
  ['/admin/customers/:id/autopay-state', 'id'],
  ['/admin/neighborhood-access/customers/:customerId/properties', 'customerId'],
  ['/admin/invoices/service-records/:customerId', 'customerId'],
];

describe('customer-scoped catalog reads inside a task for one customer', () => {
  test.each(CUSTOMER_ENDPOINTS)('%s reads the task customer and refuses another', async (endpoint, param) => {
    expect(await prepare({ endpoint, params: { [param]: A.toUpperCase() } }, taskFor(A))).toEqual({ input: { endpoint, params: { [param]: A } } });
    expect(await prepare({ endpoint, params: { [param]: B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
  });

  test('the id is required and must be an identifier', async () => {
    const endpoint = '/admin/customers/:id/credits';
    expect(await prepare({ endpoint, params: {} }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
    expect(await prepare({ endpoint }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
    expect(await prepare({ endpoint, params: { id: 'not-an-id' } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
    expect(await prepare({ endpoint, params: { id: [A] } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test('a customer id carried in the query string is checked too', async () => {
    const endpoint = '/admin/schedule/next-visit';
    expect(await prepare({ endpoint, query: { customerId: A } }, taskFor(A))).toEqual({ input: { endpoint, query: { customerId: A } } });
    expect(await prepare({ endpoint, query: { customerId: B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
    expect(await prepare({ endpoint }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
    expect(await prepare({ endpoint, query: { customer_id: A } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test('a task whose named customer did not resolve cannot read any customer record', async () => {
    const endpoint = '/admin/customers/:id/credits';
    expect(await prepare({ endpoint, params: { id: A } }, { ...NO_TASK, namesRequested: true })).toMatchObject({ code: 'target_clarification_required' });
  });

  test('owner-direct reads follow the rule every record reader has: a real record of another customer is allowed, a malformed id is not', async () => {
    const endpoint = '/admin/customers/:id/credits';
    expect(await prepare({ endpoint, params: { id: B } }, taskFor(A, { ownerDirect: true }))).toEqual({ input: { endpoint, params: { id: B } } });
    expect(await prepare({ endpoint, params: { id: 'not-an-id' } }, taskFor(A, { ownerDirect: true }))).toMatchObject({ widened: true });
  });

  test('with no customer task there is nothing to compare against and the read runs', async () => {
    const endpoint = '/admin/customers/:id/credits';
    expect(await prepare({ endpoint, params: { id: B } }, NO_TASK)).toEqual({ input: { endpoint, params: { id: B } } });
  });
});

describe('invoice-scoped catalog reads', () => {
  test.each(['credit-context', 'receipt-address', 'attachments'])('/admin/invoices/:id/%s must belong to the task customer', async (leaf) => {
    const endpoint = `/admin/invoices/:id/${leaf}`;
    expect(await prepare({ endpoint, params: { id: INVOICE_A } }, taskFor(A))).toEqual({ input: { endpoint, params: { id: INVOICE_A } } });
    expect(await prepare({ endpoint, params: { id: INVOICE_B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
    expect(await prepare({ endpoint, params: { id: 'INV-1' } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });
  test('an invoice that does not exist is unavailable', async () => {
    expect(await prepare({ endpoint: '/admin/invoices/:id/credit-context', params: { id: '20000000-0000-4000-8000-0000000000ff' } }, taskFor(A)))
      .toMatchObject({ code: 'record_unavailable' });
  });
});

describe('broad catalog reads', () => {
  test.each(['/admin/payers', '/admin/payers/:id', '/admin/invoices/customers/search', '/admin/discounts'])('%s is refused inside a customer task', async (endpoint) => {
    expect(await prepare({ endpoint, params: endpoint.includes(':id') ? { id: '4' } : {} }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });
  test('and runs when no customer task is set', async () => {
    expect(await prepare({ endpoint: '/admin/payers' }, NO_TASK)).toEqual({ input: { endpoint: '/admin/payers' } });
  });
});

describe('the reviewed rows', () => {
  test('every catalog entry states its scope, and the entry mirrors the row', () => {
    const rows = new Map(reviewed.reviewed.map(row => [row.endpoint, row]));
    for (const entry of catalog.entries) {
      const row = rows.get(entry.endpoint);
      expect({ endpoint: entry.endpoint, scope: entry.scope, scopeParam: entry.scopeParam }).toEqual({ endpoint: entry.endpoint, scope: row.scope, scopeParam: row.scopeParam });
      expect(['broad', 'customer', 'invoice']).toContain(entry.scope);
    }
  });
  test('every pattern with a customer or invoice id parameter is scoped to it', () => {
    for (const entry of catalog.entries) {
      for (const param of entry.params) {
        const customerLike = /^customer_?id$/i.test(param) || entry.endpoint.includes(`/customers/:${param}`);
        const invoiceLike = entry.endpoint.includes(`/invoices/:${param}`);
        if (customerLike) expect({ endpoint: entry.endpoint, scope: entry.scope, scopeParam: entry.scopeParam }).toEqual({ endpoint: entry.endpoint, scope: 'customer', scopeParam: param });
        if (invoiceLike) expect({ endpoint: entry.endpoint, scope: entry.scope, scopeParam: entry.scopeParam }).toEqual({ endpoint: entry.endpoint, scope: 'invoice', scopeParam: param });
      }
    }
  });
  test('a scope id carried in the query string is a declared query key of its entry', () => {
    for (const entry of catalog.entries.filter(item => item.scope !== 'broad' && !item.params.includes(item.scopeParam))) {
      expect({ endpoint: entry.endpoint, declared: entry.query.includes(entry.scopeParam) }).toEqual({ endpoint: entry.endpoint, declared: true });
    }
  });
});
