/**
 * Public lead webhook — a current or past customer sends the quote form
 * (GATE_CURRENT_CUSTOMER_QUOTE_TEXT, owner 2026-11-02 "text and bell").
 *
 * The existing-customer branch writes a note and stops: no lead row, no text,
 * no bell. Before 2026-05-25 such a form took the new-lead path, with its
 * text and its bell. Gate on, a current or past customer gets the lead text's
 * CALL or TEXT offer (sendCurrentCustomerQuoteText, mocked here) and one Leads
 * alert; a lead row keeps the repeat-form rules; any other stage, a double
 * submit and gate off are unchanged. Drives the real POST handler with an
 * in-memory db behind a recording mock and the real alert composer (it throws
 * under NODE_ENV=test when the copy breaks docs/admin-notifications.md), with
 * notifyAdmin mocked. All names are synthetic.
 */

const mockCalls = [];
const mockTables = { customers: [], leads: [], recentFormNote: null };

jest.mock('../models/db', () => {
  const makeChain = (table) => {
    const state = { table, filters: [], op: null, payload: null };
    mockCalls.push(state);
    const chain = {};
    const passthrough = ['where', 'whereNot', 'whereIn', 'whereILike', 'whereRaw', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereILike', 'select', 'orderBy', 'limit', 'forUpdate'];
    passthrough.forEach((m) => {
      chain[m] = (...args) => { state.filters.push([m, ...args]); return chain; };
    });
    chain.first = (...cols) => {
      state.op = 'first';
      state.cols = cols;
      if (table === 'customers') {
        const phoneFilter = state.filters.find(([m, f]) => m === 'where' && f && typeof f === 'object' && f.phone);
        return Promise.resolve(mockTables.customers.find((r) => !phoneFilter || r.phone === phoneFilter[1].phone));
      }
      if (table === 'leads') return Promise.resolve(mockTables.leads[0]);
      if (table === 'customer_interactions') return Promise.resolve(mockTables.recentFormNote || undefined);
      return Promise.resolve(undefined);
    };
    chain.update = (payload) => { state.op = 'update'; state.payload = payload; return Promise.resolve(1); };
    chain.insert = (payload) => {
      state.op = 'insert';
      state.payload = payload;
      const p = Promise.resolve([{ id: 'new-row' }]);
      p.returning = () => Promise.resolve([{ id: 'new-row', ...payload }]);
      return p;
    };
    chain.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return chain;
  };
  const db = jest.fn((table) => makeChain(table));
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/turnstile', () => ({ verifyTurnstileToken: jest.fn().mockResolvedValue({ ok: true, enforced: false, reason: 'test' }) }));
jest.mock('../routes/admin-customers', () => ({
  ensureCustomerAccount: jest.fn().mockRejectedValue(new Error('STOP_AFTER_NEW_CUSTOMER_BRANCH')),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
const mockQuoteText = jest.fn(async () => ({ sent: true, providerMessageId: 'SM1' }));
jest.mock('../services/lead-auto-reply', () => ({
  sendLeadAutoReplyOnce: jest.fn(),
  sendCurrentCustomerQuoteText: (...args) => mockQuoteText(...args),
}));

// Loaded once here so the router's call-time require and every test share it.
const { notifyAdmin } = require('../services/notification-service');

const PHONE_RAW = '9415550142';
const PHONE = '+19415550142';
const GATES = ['GATE_CURRENT_CUSTOMER_QUOTE_TEXT'];
const ORIGINAL = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));

function load(gate) {
  if (gate === undefined) delete process.env.GATE_CURRENT_CUSTOMER_QUOTE_TEXT;
  else process.env.GATE_CURRENT_CUSTOMER_QUOTE_TEXT = gate;
  let router;
  jest.isolateModules(() => {
    router = require('../routes/lead-webhook');
  });
  return router;
}

afterAll(() => {
  for (const g of GATES) {
    if (ORIGINAL[g] === undefined) delete process.env[g];
    else process.env[g] = ORIGINAL[g];
  }
});

async function submit(router, extraBody = {}) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await handle({
    body: { name: 'Testy Customer', phone: PHONE_RAW, email: 'testy.customer@example.com', address: '100 Example Way, Parrish, FL 34219', ...extraBody },
    headers: {},
    ip: '203.0.113.9',
    get: () => undefined,
  }, res);
  return res;
}

const row = (extra = {}) => ({
  id: 'cust-1',
  phone: PHONE,
  deleted_at: null,
  first_name: 'Testy',
  last_name: 'Customer',
  pipeline_stage: 'active_customer',
  lead_intake_status: null,
  lead_source: 'website',
  lead_source_detail: 'gbp_parrish',
  created_at: new Date('2025-03-02T15:00:00Z'),
  ...extra,
});

const alertCalls = (prefix) => notifyAdmin.mock.calls.filter(([, , , opts]) => String(opts?.dedupeKey || '').startsWith(prefix));

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockTables.customers = [];
  mockTables.leads = [];
  mockTables.recentFormNote = null;
});

describe('gate on: a current or past customer sends the quote form', () => {
  test('a current customer gets the CALL or TEXT text and one Leads alert that opens the customer', async () => {
    const router = load('true');
    mockTables.customers = [row()];

    const res = await submit(router);

    expect(res.body).toMatchObject({ success: true, customerId: 'cust-1', existingCustomer: true, deduped: false });
    expect(mockQuoteText).toHaveBeenCalledTimes(1);
    expect(mockQuoteText.mock.calls[0][0]).toMatchObject({
      customer: expect.objectContaining({ id: 'cust-1', first_name: 'Testy', pipeline_stage: 'active_customer' }),
      phoneFormatted: PHONE,
      location: expect.objectContaining({ id: expect.any(String) }),
      leadSource: expect.objectContaining({ source: expect.any(String) }),
    });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(headline).toBe('Leads — call Testy Customer about the quote form');
    expect(why).toBe('Testy, a current customer, sent the quote form.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: 'customer-quote-form:cust-1',
      dedupeOpenOnly: true,
      // Each form is a new version: an open row rings again and its time moves
      // to this form, so contact before it never closes it.
      refreshOnDedupe: true,
      bumpOnRefresh: true,
      dedupeVersion: expect.any(String),
      link: '/admin/customers?customerId=cust-1',
      metadata: {
        customerId: 'cust-1',
        source: 'customer_quote_form',
        subject: { type: 'customer', id: 'cust-1' },
        doneWhen: 'customer_answered',
        who: 'person',
      },
    });
    // The text goes before the alert, and the form never becomes a lead.
    expect(mockQuoteText.mock.invocationCallOrder[0]).toBeLessThan(notifyAdmin.mock.invocationCallOrder[0]);
    expect(mockCalls.some((c) => c.table === 'leads' && c.op === 'insert')).toBe(false);
  });

  test('a typed name never reaches the text: the sender gets the customer row only', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    await submit(router, { name: 'Billing: https://example.invalid/x' });
    const sent = mockQuoteText.mock.calls[0][0];
    expect(sent).not.toHaveProperty('firstName');
    expect(sent.customer.first_name).toBe('Testy');
    expect(JSON.stringify(sent)).not.toContain('example.invalid');
  });

  test('the service they asked about is in the why', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    await submit(router, { service_interest: 'Mosquito Control' });
    expect(notifyAdmin.mock.calls[0][2]).toBe('Testy, a current customer, sent the quote form for “Mosquito Control”.');
  });

  test.each(['won', 'at_risk'])('a %s row is a current customer', async (stage) => {
    const router = load('true');
    mockTables.customers = [row({ pipeline_stage: stage })];
    await submit(router);
    expect(mockQuoteText).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][2]).toBe('Testy, a current customer, sent the quote form.');
  });

  test.each(['churned', 'past_customer', 'dormant'])('a %s row is a past customer', async (stage) => {
    const router = load('true');
    mockTables.customers = [row({ pipeline_stage: stage })];
    await submit(router);
    expect(mockQuoteText).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][2]).toBe('Testy, a past customer, sent the quote form.');
  });

  test('the alert key is the one the relevance sweep closes once a person reached the customer', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    await submit(router);
    const { CLASSES } = require('../services/admin-alert-relevance');
    const cls = CLASSES.find((c) => c.key === 'customer_quote_form');
    expect(cls).toMatchObject({ categories: ['lead'], contact: 'customer', contactOnly: true, rearm: false });
    expect(notifyAdmin.mock.calls[0][3].dedupeKey.startsWith(cls.prefix)).toBe(true);
  });

  test('a double submit inside the 5-minute window sends nothing and rings nothing', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    mockTables.recentFormNote = { id: 'note-1' };

    const res = await submit(router);

    expect(res.body).toMatchObject({ deduped: true, existingCustomer: true });
    expect(mockQuoteText).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a text that throws still rings the alert, and the form answers success', async () => {
    const router = load('true');
    mockQuoteText.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'CONSENT_BLOCKED' }));
    mockTables.customers = [row()];
    const res = await submit(router);
    expect(res.body).toMatchObject({ success: true, existingCustomer: true });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a failed alert is logged and the form still answers success', async () => {
    const router = load('true');
    notifyAdmin.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    mockTables.customers = [row()];
    const res = await submit(router);
    expect(res.body).toMatchObject({ success: true, existingCustomer: true });
    expect(mockQuoteText).toHaveBeenCalledTimes(1);
  });
});

describe('unchanged paths', () => {
  test('a row that is still a lead keeps the repeat-form rules: its alert, no text', async () => {
    const router = load('true');
    mockTables.customers = [row({ pipeline_stage: 'new_lead', lead_intake_status: 'awaiting_service' })];
    mockTables.leads = [{ id: 'lead-9' }];
    await submit(router);
    expect(mockQuoteText).not.toHaveBeenCalled();
    expect(alertCalls('lead-repeat-form:')).toHaveLength(1);
    expect(alertCalls('customer-quote-form:')).toHaveLength(0);
  });

  test.each(['negotiating', null])('gate on, a %s row: note only', async (stage) => {
    const router = load('true');
    mockTables.customers = [row({ pipeline_stage: stage })];
    await submit(router);
    expect(mockQuoteText).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test.each([undefined, 'false', '1', 'TRUE'])('gate %s: a current customer gets the note only', async (gate) => {
    const router = load(gate);
    mockTables.customers = [row()];
    const res = await submit(router);
    expect(res.body).toMatchObject({ success: true, customerId: 'cust-1', existingCustomer: true, deduped: false });
    expect(mockQuoteText).not.toHaveBeenCalled();
    expect(notifyAdmin).not.toHaveBeenCalled();
  });
});
