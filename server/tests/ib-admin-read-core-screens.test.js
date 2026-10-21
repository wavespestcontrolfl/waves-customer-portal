/**
 * The core record screens admitted to the general read (owner: "I want the
 * intelligence bar to have access to everything"): the customer list and the
 * per-customer reads, the schedule list, the dispatch board and visit, the
 * estimate list and the invoice reads. Tests here use the COMMITTED catalog:
 * the finder finds them from plain asks, every customer- or invoice-scoped row
 * checks the record against the task customer, a long list is cut with a note
 * that names its own filters, and the row's projection removes what must never
 * reach the model. Synthetic ids only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const Context = require('../services/intelligence-bar/task-context');
const catalog = require('../services/intelligence-bar/admin-read-catalog.json');
const { executeAdminReadTool } = require('../services/intelligence-bar/admin-read-tools');
const { omitPaths, omitProblem, omittedKeyNames, keepPaths, keepProblem } = require('../utils/response-projection');
const { isFreeTextName } = require('../utils/signed-link-redaction');

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const INVOICE_A = '20000000-0000-4000-8000-00000000000a';
const INVOICE_B = '20000000-0000-4000-8000-00000000000b';
const VISIT = '30000000-0000-4000-8000-00000000000a';
const AUTH = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidG9rZW4ifQ.c2lnbmF0dXJl';
const READER = { fullAccess: true, isAdmin: true, staffAuthorization: AUTH };
const TOOL = 'read_admin_data';
const schema = { properties: {} };

const CUSTOMER_PATH = [
  '/admin/customers/:id/timeline', '/admin/customers/:id/comms', '/admin/customers/:id/estimates-summary', '/admin/customers/:id/cards',
  '/admin/customers/:id/latest-scheduled-service', '/admin/customers/:id/collection-holds', '/admin/customers/:id/deposit-credit',
];
const INVOICE_PATH = ['/admin/invoices/:id', '/admin/invoices/:id/recipients'];
const BROAD = [
  '/admin/customers', '/admin/schedule/list', '/admin/dispatch/board', '/admin/dispatch/jobs/:id', '/admin/dispatch/techs/:id',
  '/admin/dispatch/alerts', '/admin/estimates',
  '/admin/leads', '/admin/leads/:id', '/admin/leads/analytics/overview', '/admin/leads/analytics/by-source',
];
const NEW_ENDPOINTS = [...CUSTOMER_PATH, ...INVOICE_PATH, '/admin/invoices', ...BROAD];
const entryOf = endpoint => catalog.entries.find(entry => entry.endpoint === endpoint);

describe('the core screens are in the catalog with the right scope', () => {
  test('every new endpoint is admitted', () => {
    for (const endpoint of NEW_ENDPOINTS) expect({ endpoint, admitted: Boolean(entryOf(endpoint)) }).toEqual({ endpoint, admitted: true });
    expect(catalog.entries.length).toBeGreaterThanOrEqual(50);
  });
  test('scopes: customer, invoice and broad', () => {
    for (const endpoint of CUSTOMER_PATH) expect(entryOf(endpoint)).toMatchObject({ scope: 'customer', scopeParam: 'id' });
    for (const endpoint of INVOICE_PATH) expect(entryOf(endpoint)).toMatchObject({ scope: 'invoice', scopeParam: 'id' });
    expect(entryOf('/admin/invoices')).toMatchObject({ scope: 'customer', scopeParam: 'customer_id' });
    for (const endpoint of BROAD) expect(entryOf(endpoint).scope).toBe('broad');
  });
  test('the invoice list offers only customer_id, never the customerId alias the handler reads second', () => {
    const query = entryOf('/admin/invoices').query;
    expect(query).toContain('customer_id');
    expect(query).not.toContain('customerId');
  });
  test('list endpoints are bounded by the handler (a limit key) or are a single day', () => {
    for (const endpoint of ['/admin/customers', '/admin/schedule/list', '/admin/estimates', '/admin/dispatch/alerts', '/admin/leads']) {
      expect(entryOf(endpoint).query).toContain('limit');
    }
    // Invoices: the handler's default page (50, capped at 100) bounds it; a raw limit is not offered (Codex #6366 r3).
    expect(entryOf('/admin/invoices').query).not.toContain('limit');
    expect(entryOf('/admin/invoices').query).toContain('page');
  });
});

describe('find_admin_reads finds the core screens from plain asks', () => {
  beforeEach(() => { process.env.GATE_IB_GENERAL_READ = 'true'; process.env.GATE_IB_PLATFORM = 'true'; });
  const find = async query => (await executeAdminReadTool('find_admin_reads', { query }, READER)).matches.map(match => match.endpoint);

  test.each([
    ['customer profile', '/admin/customers'],
    ['find a customer by phone', '/admin/customers'],
    ['what is on the schedule tomorrow', '/admin/schedule/list'],
    ['appointments this week', '/admin/schedule/list'],
    ['open invoices for this customer', '/admin/invoices'],
    ['unpaid invoices', '/admin/invoices'],
    ['texts with this customer', '/admin/customers/:id/comms'],
    ['customer sms messages', '/admin/customers/:id/comms'],
    ['estimate status', '/admin/estimates'],
    ['estimate status for this customer', '/admin/customers/:id/estimates-summary'],
    ['invoice detail', '/admin/invoices/:id'],
    ['customer timeline', '/admin/customers/:id/timeline'],
    ['cards on file', '/admin/customers/:id/cards'],
    ['dispatch board', '/admin/dispatch/board'],
    ['visit detail', '/admin/dispatch/jobs/:id'],
    ['lead details', '/admin/leads/:id'],
    ['new leads this week', '/admin/leads'],
    ['leads from a source', '/admin/leads'],
    ['lead conversion rate', '/admin/leads/analytics/overview'],
    ['lead source performance', '/admin/leads/analytics/by-source'],
  ])('"%s" finds %s first', async (phrase, endpoint) => {
    expect((await find(phrase))[0]).toBe(endpoint);
  });
});

describe('the response projection', () => {
  test('a path removes a key, through arrays, with a wildcard, or at any depth', () => {
    const value = { customer: { a: 1, stripe_customer_id: 'x' }, estimates: [{ token: 't', id: 1 }, { id: 2 }], payments: { p1: { card_token: 'c', n: 1 } }, deep: { list: [{ stripe_charge_id: 's', ok: true }] } };
    omitPaths(value, ['customer.stripe_customer_id', 'estimates.token', 'payments.*.card_token', '**.stripe_charge_id']);
    expect(value).toEqual({ customer: { a: 1 }, estimates: [{ id: 1 }, { id: 2 }], payments: { p1: { n: 1 } }, deep: { list: [{ ok: true }] } });
  });
  test('a path that matches nothing changes nothing, and the list is validated', () => {
    const value = { a: { b: 1 } };
    expect(omitPaths(value, ['x.y', 'a.c', '**.zzz'])).toEqual({ a: { b: 1 } });
    expect(omitProblem(['a.b', '**.c'])).toBeNull();
    expect(omitProblem(['a.*', 'a b', '**'])).toMatch(/omit/);
    expect(omittedKeyNames(['a.token', 'b.token', '**.stripe_charge_id'])).toEqual(['token', 'stripe_charge_id']);
  });
  test('every committed omit path is well formed', () => {
    for (const entry of catalog.entries.filter(item => item.omit)) expect({ endpoint: entry.endpoint, problem: omitProblem(entry.omit) }).toEqual({ endpoint: entry.endpoint, problem: null });
  });
  test('the invoice reads omit the pay token, the claim token, the Stripe ids and the receipt link', () => {
    for (const endpoint of ['/admin/invoices', '/admin/invoices/:id']) {
      const keys = omittedKeyNames(entryOf(endpoint).omit);
      expect(keys).toEqual(expect.arrayContaining(['token', 'send_claim_token', 'stripe_payment_intent_id', 'stripe_charge_id', 'receipt_url']));
    }
    expect(omittedKeyNames(entryOf('/admin/customers/:id/estimates-summary').omit)).toContain('token');
    expect(omittedKeyNames(entryOf('/admin/dispatch/board').omit)).toContain('avatar_url');
    for (const endpoint of ['/admin/leads', '/admin/leads/:id']) expect(omittedKeyNames(entryOf(endpoint).omit)).toEqual(expect.arrayContaining(['call_recording_url', 'anon_id', 'gclid']));
  });
});

describe('keep mode (an allow-list) in the response projection', () => {
  test('only the listed paths survive; a new key at any depth is dropped', () => {
    const value = {
      invoices: [{ id: 1, status: 'sent', payment_reference: 'x', future_column: 'y', card_on_file: { brand: 'visa', last_four: '4242', future_nested: 'z' } }, { id: 2 }],
      total: 2, brand_new_top: 'q', counts: { a: 1, b: 2 }, areas: ['one', 'two'],
    };
    expect(keepPaths(value, ['invoices.*.id', 'invoices.*.status', 'invoices.*.card_on_file.brand', 'invoices.*.card_on_file.last_four', 'total', 'counts', 'areas'])).toEqual({
      invoices: [{ id: 1, status: 'sent', card_on_file: { brand: 'visa', last_four: '4242' } }, { id: 2 }], total: 2, counts: { a: 1, b: 2 }, areas: ['one', 'two'],
    });
  });
  test('a path to an object or a list of objects keeps nothing inside it by itself', () => {
    expect(keepPaths({ a: { x: 'text' }, list: [{ x: 1 }], total: 3 }, ['a', 'list', 'total'])).toEqual({ total: 3 });
  });
  test('a map that holds anything but numbers is dropped whole, and an array is not transparent', () => {
    expect(keepPaths({ counts: { a: 1, b: 'free text' }, rows: [{ id: 1 }] }, ['counts', 'rows.id'])).toEqual({});
  });
  test('a record with nothing listed stays as an empty item so counts of items are right; plain values not listed go', () => {
    expect(keepPaths({ rows: [{ x: 1 }, { x: 2 }], names: ['a', 'b'] }, ['rows.*.id', 'names.*.id'])).toEqual({ rows: [{}, {}], names: [] });
  });
  test('a top-level list works', () => {
    expect(keepPaths([{ id: 1, junk: 2 }], ['*.id'])).toEqual([{ id: 1 }]);
  });
  test('the list is validated: key names and "*" only, no free-text or operator-entered key, none repeated', () => {
    const opts = { isFreeText: isFreeTextName, content: [] };
    expect(keepProblem(['a.*.b', 'c'], opts)).toBeNull();
    for (const bad of [[], 'a', ['a b'], ['a', 'a'], ['**.a'], ['a.*'], ['a..b'], [3], ['notes'], ['a.*.description'], ['x.title'], ['profileLabel'], ['payment_reference'], ['customers.*.tags'], ['est.competitorName'], ['lead.extracted_data'], ['metadata']]) {
      expect({ bad, problem: keepProblem(bad, opts) === null }).toEqual({ bad, problem: false });
    }
    // a name that looks like free text may be kept only when the row declares it business reference text
    expect(keepProblem(['calls.*.transcription_status'], opts)).toMatch(/free text/);
    expect(keepProblem(['calls.*.transcription_status'], { ...opts, content: ['transcription_status'] })).toBeNull();
  });
  test('every new row is in keep mode, with a valid list that names no operator-entered field', () => {
    for (const endpoint of NEW_ENDPOINTS) {
      const entry = entryOf(endpoint);
      expect({ endpoint, keep: Array.isArray(entry.keep) && entry.keep.length > 0 }).toEqual({ endpoint, keep: true });
      const content = Object.entries(entry.freeText || {}).filter(([, kind]) => kind === 'content').map(([key]) => key);
      expect({ endpoint, problem: keepProblem(entry.keep, { isFreeText: isFreeTextName, content }) }).toEqual({ endpoint, problem: null });
      // no note declaration survives on a keep row: what is not listed is dropped, not withheld
      expect({ endpoint, notes: Object.values(entry.freeText || {}).filter(kind => kind === 'note') }).toEqual({ endpoint, notes: [] });
    }
  });
  test('the 35 rows that were on main are unchanged: none is in keep mode', () => {
    expect(catalog.entries.filter(entry => entry.keep).length).toBe(NEW_ENDPOINTS.length);
  });
  test('a row that is not in keep mode does not carry the reviewed-list note', async () => {
    process.env.GATE_IB_GENERAL_READ = 'true'; process.env.GATE_IB_PLATFORM = 'true';
    global.fetch = jest.fn(async () => ({ status: 200, headers: { get: key => ({ 'content-type': 'application/json' })[String(key).toLowerCase()] ?? null }, text: async () => JSON.stringify({ enabled: true }) }));
    const result = await executeAdminReadTool(TOOL, { endpoint: '/admin/estimates/source-performance' }, READER);
    expect(result.note).not.toMatch(/reviewed list of fields/);
  });
});

describe('answers from the core screens', () => {
  beforeEach(() => { process.env.GATE_IB_GENERAL_READ = 'true'; process.env.GATE_IB_PLATFORM = 'true'; });
  const reply = body => ({ status: 200, headers: { get: key => ({ 'content-type': 'application/json' })[String(key).toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });

  test('a long customer list is cut and the note names the filters of this endpoint', async () => {
    const customers = Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, firstName: `First${i}`, lastName: `Last${i}`, email: `person${i}@example.test`, city: 'Sampletown', tier: 'Gold' }));
    global.fetch = jest.fn(async () => reply({ customers, total: 400, page: 1, limit: 400, totalPages: 1 }));
    const result = await executeAdminReadTool(TOOL, { endpoint: '/admin/customers' }, READER);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('Narrow with these "query" filters to see the rest: area, cards, city, hasBalance, lastVisited, limit, order, page, search, sort, source, stage, tag, tier.');
  });
  test('an endpoint that takes no filters says so instead of naming filters', async () => {
    const jobs = Array.from({ length: 1500 }, (_, i) => ({ id: `j${i}`, status: 'confirmed', service_type: 'Pest Control', address: `${i} Example Way, Sampletown` }));
    global.fetch = jest.fn(async () => reply({ techs: [], jobs }));
    const result = await executeAdminReadTool(TOOL, { endpoint: '/admin/dispatch/board' }, READER);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/To narrow it: this read takes no query filters/);
  });
  test('the answer says which keys are left out of the read by design', async () => {
    global.fetch = jest.fn(async () => reply({ invoices: [{ id: INVOICE_A, token: 'TOKEN-PLACEHOLDER', stripe_charge_id: 'ch_PLACEHOLDER', status: 'sent' }], total: 1, page: 1 }));
    const result = await executeAdminReadTool(TOOL, { endpoint: '/admin/invoices', query: { customer_id: A } }, READER);
    expect(result.data.invoices[0]).toEqual({ id: INVOICE_A, status: 'sent' });
    expect(result.note).toContain('Left out of this read by design, never shown: token, send_claim_token, stripe_payment_intent_id, stripe_charge_id, receipt_url.');
  });
  test('the invoice list refuses the customerId alias', async () => {
    global.fetch = jest.fn(async () => reply({ invoices: [], total: 0, page: 1 }));
    const result = await executeAdminReadTool(TOOL, { endpoint: '/admin/invoices', query: { customerId: A } }, READER);
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('a pagination cursor is not offered (a query value is cut at 200 characters)', () => {
    for (const endpoint of ['/admin/customers/:id/timeline', '/admin/customers/:id/comms']) expect(entryOf(endpoint).query).not.toContain('cursor');
  });
});

describe('scope inside a task for one customer', () => {
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
  const taskFor = id => ({
    targets: [{ customer_id: id, provenance: 'current_request_lookup' }], target: { customer_id: id }, ambiguous: false,
    candidates: [], page: { ids: {}, records: {} }, requestedRecords: {},
  });
  const prepare = (input, context) => Context.prepareReadInput(input, context, { toolName: TOOL, schema });

  test.each(CUSTOMER_PATH)('%s reads the task customer and refuses another', async (endpoint) => {
    expect(await prepare({ endpoint, params: { id: A.toUpperCase() } }, taskFor(A))).toEqual({ input: { endpoint, params: { id: A } } });
    expect(await prepare({ endpoint, params: { id: B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
    expect(await prepare({ endpoint, params: {} }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test.each(INVOICE_PATH)('%s must belong to the task customer', async (endpoint) => {
    expect(await prepare({ endpoint, params: { id: INVOICE_A } }, taskFor(A))).toEqual({ input: { endpoint, params: { id: INVOICE_A } } });
    expect(await prepare({ endpoint, params: { id: INVOICE_B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
    expect(await prepare({ endpoint, params: { id: 'INV-1' } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test('the invoice list names the task customer in customer_id, or it is refused', async () => {
    const endpoint = '/admin/invoices';
    expect(await prepare({ endpoint, query: { customer_id: A } }, taskFor(A))).toEqual({ input: { endpoint, query: { customer_id: A } } });
    expect(await prepare({ endpoint, query: { customer_id: B } }, taskFor(A))).toMatchObject({ code: 'target_clarification_required' });
    expect(await prepare({ endpoint }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
    // the other alias does not satisfy the scope check
    expect(await prepare({ endpoint, query: { customerId: A } }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test.each(BROAD)('%s is refused inside a customer task', async (endpoint) => {
    const params = endpoint.includes(':id') ? { id: VISIT } : {};
    expect(await prepare({ endpoint, params }, taskFor(A))).toMatchObject({ code: 'customer_scope_required' });
  });

  test('with no customer task the broad reads run', async () => {
    const NO_TASK = { targets: [], ambiguous: false, candidates: [], page: { ids: {}, records: {} }, requestedRecords: {} };
    expect(await prepare({ endpoint: '/admin/customers' }, NO_TASK)).toEqual({ input: { endpoint: '/admin/customers' } });
  });
});
