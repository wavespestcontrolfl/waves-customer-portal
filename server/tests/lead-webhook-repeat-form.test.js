/**
 * Public lead webhook — a repeat form from a row that is still a lead
 * (GATE_LEAD_REPEAT_FORM, owner 2026-10-24 "A: both parts").
 *
 * A form whose phone matches a live customers row takes the existing-customer
 * branch: a note, no lead row, no text, no new-lead bell. That branch also
 * cleared lead_intake_status, so a lead who sent the form again lost the
 * CALL / TEXT note and the draft quote for its next text (prod 2026-10-15: a
 * lead re-sent the form 29 s before replying TEXT), and nobody was told about
 * the form (five leads Aug 17 - Oct 18, none called).
 *
 * Gate on, a row that is still a lead keeps an open intake state and rings one
 * Leads alert; a customer row is unchanged. Gate off, both are as before.
 * Drives the real POST handler with an in-memory db behind a recording mock and
 * the real alert composer (it throws under NODE_ENV=test when the copy breaks
 * docs/admin-notifications.md), with notifyAdmin mocked. All names are synthetic.
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

// Loaded once here so the router's call-time require and every test share it.
const { notifyAdmin } = require('../services/notification-service');

const PHONE_RAW = '9415550142';
const PHONE = '+19415550142';
const ORIGINAL = process.env.GATE_LEAD_REPEAT_FORM;

function load(gate) {
  if (gate === undefined) delete process.env.GATE_LEAD_REPEAT_FORM;
  else process.env.GATE_LEAD_REPEAT_FORM = gate;
  let router;
  jest.isolateModules(() => {
    router = require('../routes/lead-webhook');
  });
  return router;
}

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.GATE_LEAD_REPEAT_FORM;
  else process.env.GATE_LEAD_REPEAT_FORM = ORIGINAL;
});

async function submit(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await handle({
    body: { name: 'Testy Leadperson', phone: PHONE_RAW, email: 'testy.lead@example.com', address: '100 Example Way, Parrish, FL 34219' },
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
  last_name: 'Leadperson',
  pipeline_stage: 'new_lead',
  lead_intake_status: 'awaiting_service',
  lead_source: 'website',
  lead_source_detail: 'gbp_parrish',
  created_at: new Date('2026-10-16T18:47:01Z'),
  ...extra,
});

const customerUpdate = () => mockCalls.find((c) => c.table === 'customers' && c.op === 'update');
// The alert's own lookup: the newest live lead of this customer.
const newestLeadLookups = () => mockCalls.filter((c) => c.table === 'leads'
  && c.filters.some(([m, f]) => m === 'where' && f && f.customer_id === 'cust-1'));

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockTables.customers = [];
  mockTables.leads = [{ id: 'lead-9' }];
  mockTables.recentFormNote = null;
});

describe('gate on: a repeat form from a row that is still a lead', () => {
  test('keeps the open intake state and rings one Leads alert that opens the lead', async () => {
    const router = load('true');
    mockTables.customers = [row()];

    const res = await submit(router);

    expect(res.body).toMatchObject({ success: true, customerId: 'cust-1', existingCustomer: true, deduped: false });
    expect(res.body).not.toHaveProperty('attachedLeadId');
    expect(customerUpdate().payload).not.toHaveProperty('lead_intake_status');
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(headline).toBe('Leads — call Testy Leadperson about the quote form');
    expect(why).toBe('Testy sent the quote form; on file as a lead since Oct 16.');
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: 'lead-repeat-form:cust-1',
      dedupeOpenOnly: true,
      // Each form is a new version: an open row rings again and its time moves
      // to this form, so contact before it never closes it.
      refreshOnDedupe: true,
      bumpOnRefresh: true,
      dedupeVersion: expect.any(String),
      link: '/admin/leads?lead=lead-9',
      metadata: { customerId: 'cust-1', leadId: 'lead-9', subject: { type: 'lead', id: 'lead-9' }, doneWhen: 'lead_contacted', who: 'person' },
    });
  });

  test('the alert key is the one the relevance sweep closes once the lead is contacted', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    await submit(router);
    const { CLASSES } = require('../services/admin-alert-relevance');
    const cls = CLASSES.find((c) => c.key === 'lead_repeat_form');
    expect(cls).toMatchObject({ categories: ['lead'], rearm: false });
    expect(notifyAdmin.mock.calls[0][0]).toBe('lead');
    expect(notifyAdmin.mock.calls[0][3].dedupeKey.startsWith(cls.prefix)).toBe(true);
  });

  test('an address ask in progress (awaiting_address) is kept too', async () => {
    const router = load('true');
    mockTables.customers = [row({ lead_intake_status: 'awaiting_address' })];
    await submit(router);
    expect(customerUpdate().payload).not.toHaveProperty('lead_intake_status');
  });

  test('a closed intake state is still cleared, and the lead still gets the alert', async () => {
    const router = load('true');
    mockTables.customers = [row({ pipeline_stage: 'estimate_sent', lead_intake_status: 'estimate_drafted' })];
    await submit(router);
    expect(customerUpdate().payload.lead_intake_status).toBeNull();
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a double submit inside the 5-minute window keeps the state and rings nothing', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    mockTables.recentFormNote = { id: 'note-1' };

    const res = await submit(router);

    expect(res.body).toMatchObject({ deduped: true, existingCustomer: true });
    expect(customerUpdate().payload).not.toHaveProperty('lead_intake_status');
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('no live lead row: the alert opens the customer instead', async () => {
    const router = load('true');
    mockTables.customers = [row()];
    mockTables.leads = [];
    await submit(router);
    const opts = notifyAdmin.mock.calls[0][3];
    expect(opts.link).toBe('/admin/customers?customerId=cust-1');
    expect(opts.metadata.subject).toEqual({ type: 'customer', id: 'cust-1' });
  });

  test('a failed alert is logged and the form still answers success', async () => {
    const router = load('true');
    notifyAdmin.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    mockTables.customers = [row()];
    const res = await submit(router);
    expect(res.body).toMatchObject({ success: true, existingCustomer: true });
  });
});

describe('the alert opens the lead the form attached to', () => {
  test('an attached call lead wins over the newest-lead lookup', async () => {
    load('true');
    let helper;
    jest.isolateModules(() => { helper = require('../routes/lead-webhook')._test.ringRepeatFormAlert; });
    await helper(row(), 'lead-attached');
    expect(newestLeadLookups()).toHaveLength(0);
    expect(notifyAdmin.mock.calls[0][3]).toMatchObject({ link: '/admin/leads?lead=lead-attached', metadata: { leadId: 'lead-attached' } });
  });
});

describe('unchanged paths', () => {
  test.each(['active_customer', 'won', 'at_risk', 'dormant', 'churned', null])(
    'gate on, a %s row: intake cleared, note only, no alert',
    async (stage) => {
      const router = load('true');
      mockTables.customers = [row({ pipeline_stage: stage })];
      await submit(router);
      expect(customerUpdate().payload.lead_intake_status).toBeNull();
      expect(notifyAdmin).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, 'false', '1', 'TRUE'])('gate %s: a lead row is cleared and no alert rings', async (gate) => {
    const router = load(gate);
    mockTables.customers = [row()];
    await submit(router);
    expect(customerUpdate().payload.lead_intake_status).toBeNull();
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(newestLeadLookups()).toHaveLength(0);
  });
});
