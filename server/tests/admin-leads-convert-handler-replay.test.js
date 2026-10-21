/**
 * The Intelligence Bar's convert_lead replays the Leads page's own Convert to Customer handler
 * (admin-leads.js convertLeadFromBar). The page route and the shim must reach the same handler with
 * the same arguments, return the same answers, and send nothing to anyone. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { first_name: 'Ava', last_name: 'Admin' }; req.technicianId = 'admin-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lead-attribution', () => ({ markConverted: jest.fn(), markLost: jest.fn() }));
// Every sender the Leads router can reach: none may run on a convert.
jest.mock('../services/messaging/send-manual-customer-sms', () => ({ sendManualCustomerSms: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadAttribution = require('../services/lead-attribution');
const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');
const leadsRouter = require('../routes/admin-leads');

const LEAD = '00000000-0000-4000-8000-0000000000b1';
const CUST = '00000000-0000-4000-8000-0000000000c1';
const SEEN = '2099-01-01T12:00:00.123Z';

let tables;
const CUSTOMER_FIELDS = {
  first_name: 'Robin', last_name: 'Sample', company_name: null, phone: '+19415550142', email: 'robin@example.test',
  address_line1: '12 Sample Way', city: 'Venice', zip: '34285', deleted_at: null,
};
function seed() {
  tables = {
    leads: { id: LEAD, status: 'contacted', updated_at: new Date(SEEN), deleted_at: null },
    customers: { id: CUST, ...CUSTOMER_FIELDS },
    estimates: [],
  };
  db.raw = jest.fn((sql) => ({ raw: sql }));
  db.mockImplementation((table) => {
    const q = { table, conds: [] };
    q.where = jest.fn((...a) => { q.conds.push(['where', ...a]); return q; });
    q.whereNull = jest.fn((k) => { q.conds.push(['whereNull', k]); return q; });
    q.whereRaw = jest.fn((sql, bindings) => { q.conds.push(['whereRaw', sql, bindings]); return q; });
    q.select = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customers' && q.conds.some((c) => c[0] === 'whereNull' && c[1] === 'deleted_at') && tables.customers?.deleted_at ? undefined : tables[table]));
    for (const write of ['insert', 'update', 'del']) q[write] = jest.fn(() => { throw new Error(`unexpected ${write} on ${table}`); });
    return q;
  });
}

async function viaPage(body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads/${LEAD}/convert`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const BODY = { customer_id: CUST, monthly_value: 49, initial_service_value: 129, waveguard_tier: 'Gold', seen_status: 'contacted', seen_updated_at: SEEN };

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  leadAttribution.markConverted.mockResolvedValue(true);
});

test('the shim and the page route run the same handler with the same arguments and answer alike', async () => {
  const page = await viaPage(BODY);
  const pageCall = leadAttribution.markConverted.mock.calls[0];
  leadAttribution.markConverted.mockClear();
  const bar = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY });
  const barCall = leadAttribution.markConverted.mock.calls[0];
  expect(bar.status).toBe(200);
  expect(page.status).toBe(200);
  expect(Object.keys(bar.json)).toEqual(Object.keys(page.json));
  expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
  expect(barCall[0]).toBe(LEAD);
  expect(barCall[1]).toMatchObject({ customerId: CUST, monthlyValue: 49, initialServiceValue: 129, waveguardTier: 'Gold' });
  expect(typeof barCall[1].onlyIfIdentity).toBe('function');
  expect({ ...barCall[1], onlyIfIdentity: 0 }).toEqual({ ...pageCall[1], onlyIfIdentity: 0 });
});

test('a body without figures leaves them out, exactly as the page does', async () => {
  await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: { customer_id: CUST, seen_status: 'contacted', seen_updated_at: SEEN } });
  const options = leadAttribution.markConverted.mock.calls[0][1];
  expect(options).toMatchObject({ customerId: CUST });
  expect(options.monthlyValue).toBeUndefined();
  expect(options.initialServiceValue).toBeUndefined();
  expect(options.waveguardTier).toBeUndefined();
});

test('the page’s own refusals reach the shim unchanged', async () => {
  expect(await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: {} })).toEqual({ status: 400, json: { error: 'customer_id is required to convert a lead' } });
  tables.customers = undefined;
  expect(await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY })).toEqual({ status: 404, json: { error: 'Customer not found' } });
  seed();
  tables.leads = undefined;
  expect(await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY })).toEqual({ status: 404, json: { error: 'Lead not found' } });
  seed();
  tables.leads.status = 'handled';
  const stale = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY });
  expect(stale.status).toBe(409);
  expect(stale.json.error).toMatch(/customer booked online/);
  seed();
  leadAttribution.markConverted.mockResolvedValueOnce(false);
  const raced = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY });
  expect(raced.status).toBe(409);
  expect(raced.json.error).toMatch(/changed since the page loaded/);
  expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
});

test('an error inside the handler rejects the shim, never resolves a success', async () => {
  leadAttribution.markConverted.mockRejectedValueOnce(new Error('db down'));
  await expect(leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY })).rejects.toThrow('db down');
});

test('a convert sends no text and writes nothing itself (the only write is the one markConverted call)', async () => {
  await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY });
  expect(sendManualCustomerSms).not.toHaveBeenCalled();
  // The db stub throws on any insert / update / delete: reaching here means the handler wrote nothing except through markConverted.
  expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
});

// ── the card's pin on the win's own UPDATE (Codex P1 on the first push) ────────────────────────
// A stand-in for markConverted's claim: it applies onlyIfIdentity to a fake query builder and answers
// whether a row in its current state would be updated.
function claimOf(row) {
  const conds = [];
  const calls = [];
  const existsSubs = [];
  const builder = (list, mode) => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'where') return (a, b) => {
        calls.push(['where', typeof a === 'function' ? 'fn' : a]);
        if (typeof a === 'function') {
          const group = [];
          a(builder(group, 'group'));
          list.push((r) => group.length === 0 || (group[0](r) || group.slice(1).some((c) => c.or && c(r))));
        } else list.push((r) => String(r[a]) === String(b));
        return builder(list, mode);
      };
      if (prop === 'whereExists') return (sub) => {
        calls.push(['whereExists', sub.table]);
        existsSubs.push(sub);
        // The carded customer: exists, not deleted, and each snapshot column equal.
        list.push(() => {
          const c = tables.customers;
          if (!c || c.deleted_at) return false;
          return sub.conds.filter((k) => k[0] === 'whereRaw').every(([, sql, [v]]) => String(c[/COALESCE\((\w+)::text/.exec(sql)[1]] ?? '') === v);
        });
        return builder(list, mode);
      };
      if (prop === 'whereNotExists') return (sub) => {
        calls.push(['whereNotExists', sub.table]);
        existsSubs.push(sub);
        // No unowned estimate tagged with the lead that is outside the approved set.
        list.push(() => {
          const like = sub.conds.find((k) => k[0] === 'whereRaw' && /LIKE/.test(k[1]));
          const approved = sub.conds.find((k) => k[0] === 'whereRaw' && /<> ALL/.test(k[1]))[2][0];
          const needle = like[2][0].replace(/%/g, '');
          return !(tables.estimates || []).some((e) => e.customer_id == null && String(e.estimate_data).includes(needle) && !approved.includes(e.id));
        });
        return builder(list, mode);
      };
      if (prop === 'whereNull') return (k) => { calls.push(['whereNull', k]); list.push((r) => r[k] == null); return builder(list, mode); };
      if (prop === 'whereNot') return (k, v) => { if (mode === 'top') calls.push(['whereNot', k]); list.push((r) => r[k] !== v); return builder(list, mode); };
      if (prop === 'orWhereRaw') return (_sql, [iso]) => { const c = (r) => new Date(r.updated_at).getTime() === new Date(iso).getTime(); c.or = true; list.push(c); return builder(list, mode); };
      if (prop === 'whereRaw') return (sql, [first, count]) => {
        if (/^\(SELECT COUNT/.test(sql)) {
          calls.push(['whereRaw', 'estimates']);
          list.push(() => (tables.estimates || []).filter((e) => e.customer_id == null && first.includes(e.id)).length === count);
        } else {
          calls.push(['whereRaw', 'updated_at']);
          list.push((r) => new Date(r.updated_at).getTime() === new Date(first).getTime());
        }
        return builder(list, mode);
      };
      return undefined;
    },
  });
  return { q: builder(conds, 'top'), calls, existsSubs, wins: () => conds.every((c) => c(row)) };
}
const convertsRow = (row) => async (_id, opts) => { const claim = claimOf(row); opts.onlyIfIdentity(claim.q); return claim.wins(); };
const EXPECTED = {
  leadId: LEAD, status: 'contacted', updatedAt: new Date(SEEN).getTime(), customerId: null,
  customer: Object.fromEntries(Object.entries(CUSTOMER_FIELDS).filter(([k]) => k !== 'deleted_at')),
  estimateIds: [], estimateLinked: true,
};
const FULL_LEAD = () => ({ id: LEAD, status: 'contacted', updated_at: new Date(SEEN), deleted_at: null, converted_at: null, customer_id: null });

test('the page path is unchanged: its claim carries only the handled rule, with or without a changed lead', async () => {
  const claim = claimOf(FULL_LEAD());
  leadAttribution.markConverted.mockImplementationOnce(async (_id, opts) => { opts.onlyIfIdentity(claim.q); return true; });
  expect((await viaPage(BODY)).status).toBe(200);
  // One grouped where (not handled, or the very close the page saw) and nothing else.
  expect(claim.calls).toEqual([['where', 'fn']]);
  // A lead edited, converted and linked elsewhere since the page loaded still converts from the page, as before.
  tables.leads = { ...FULL_LEAD(), updated_at: new Date('2099-01-01T12:09:00Z'), converted_at: new Date(), customer_id: 'other' };
  leadAttribution.markConverted.mockImplementationOnce(convertsRow(tables.leads));
  expect((await viaPage(BODY)).status).toBe(200);
});

test('the bar adds the card\u2019s version to the same UPDATE and converts when nothing changed', async () => {
  const claim = claimOf(FULL_LEAD());
  leadAttribution.markConverted.mockImplementationOnce(async (_id, opts) => { opts.onlyIfIdentity(claim.q); return claim.wins(); });
  const res = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: EXPECTED });
  expect(res.status).toBe(200);
  expect(claim.calls).toEqual([['where', 'fn'], ['whereNull', 'converted_at'], ['where', 'status'], ['whereRaw', 'updated_at'], ['whereNull', 'customer_id'], ['whereExists', 'customers'], ['whereRaw', 'estimates']]);
  // The subquery asks for the carded customer, not deleted.
  expect(claim.existsSubs[0].conds.slice(0, 2)).toEqual([['where', 'id', CUST], ['whereNull', 'deleted_at']]);
  // ...and the columns the card showed.
  expect(claim.existsSubs[0].conds.slice(2).map((c) => /COALESCE\((\w+)::text/.exec(c[1])[1]))
    .toEqual(['first_name', 'last_name', 'company_name', 'phone', 'email', 'address_line1', 'city', 'zip']);
});

test.each([
  ['edited', { updated_at: new Date('2099-01-01T12:05:00Z') }],
  ['converted by someone else', { converted_at: new Date('2099-01-01T12:00:01Z') }],
  ['moved to another status', { status: 'estimate_sent' }],
  ['linked to a customer', { customer_id: 'other-customer' }],
])('a lead %s between the card check and the write answers 409 and writes nothing', async (_name, change) => {
  // The handler's own pre-read still sees the lead as the card did; the change lands before the UPDATE.
  const row = { ...FULL_LEAD(), ...change };
  leadAttribution.markConverted.mockImplementationOnce(convertsRow(row));
  const res = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: EXPECTED });
  expect(res.status).toBe(409);
  expect(res.json.error).toMatch(/changed since the page loaded/);
  // The same change does not stop the page (no expectation): unchanged behavior.
  leadAttribution.markConverted.mockImplementationOnce(convertsRow(row));
  expect((await viaPage(BODY)).status).toBe(200);
});

test('a card for a lead that had a customer link pins that link', async () => {
  const row = { ...FULL_LEAD(), customer_id: 'linked-1' };
  leadAttribution.markConverted.mockImplementation(convertsRow(row));
  expect((await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: { ...EXPECTED, customerId: 'linked-1' } })).status).toBe(200);
  expect((await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: EXPECTED })).status).toBe(409);
});

test('a customer deleted or merged away before the bar\u2019s write converts nothing (409); the page is unaffected', async () => {
  // Deleted before the handler reads it: the bar's customer read excludes deleted rows.
  tables.customers = { id: CUST, deleted_at: new Date() };
  const early = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: EXPECTED });
  expect(early).toEqual({ status: 404, json: { error: 'Customer not found' } });
  expect(leadAttribution.markConverted).not.toHaveBeenCalled();
  // Deleted after the read, before the UPDATE: the claim's EXISTS no longer matches.
  seed();
  const row = FULL_LEAD();
  leadAttribution.markConverted.mockImplementationOnce(async (_id, opts) => {
    tables.customers = { id: CUST, deleted_at: new Date() };
    const claim = claimOf(row);
    opts.onlyIfIdentity(claim.q);
    return claim.wins();
  });
  const late = await leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected: EXPECTED });
  expect(late.status).toBe(409);
  expect(late.json.error).toMatch(/changed since the page loaded/);
  // The page reads the customer exactly as before (no deleted_at condition) and adds no EXISTS.
  seed();
  tables.customers = { id: CUST, deleted_at: new Date() };
  const customerReads = [];
  const real = db.getMockImplementation();
  db.mockImplementation((table) => { const q = real(table); if (table === 'customers') customerReads.push(q); return q; });
  leadAttribution.markConverted.mockImplementationOnce(async () => true);
  expect((await viaPage(BODY)).status).toBe(200);
  expect(customerReads[0].conds).toEqual([['where', 'id', CUST]]);
});

// ── the customer snapshot and the approved estimate set in the claim ───────────────────────────
const run = (expected) => leadsRouter.convertLeadFromBar({ leadId: LEAD, body: BODY, expected });
const winsOnRow = () => leadAttribution.markConverted.mockImplementation(convertsRow(FULL_LEAD()));

test.each([
  ['name', { last_name: 'Changed' }],
  ['phone', { phone: '+19415550999' }],
  ['email', { email: 'new@example.test' }],
  ['street', { address_line1: '99 Other Way' }],
  ['zip', { zip: '34202' }],
])('a customer %s change between the check and the write answers 409; the page ignores it', async (_name, change) => {
  winsOnRow();
  tables.customers = { ...tables.customers, ...change };
  const res = await run(EXPECTED);
  expect(res.status).toBe(409);
  expect((await viaPage(BODY)).status).toBe(200);
});

test('the bar passes the approved estimate ids to the backfill; the page passes none', async () => {
  const withIds = { ...EXPECTED, estimateIds: ['est-a'] };
  tables.estimates = [{ id: 'est-a', customer_id: null, estimate_data: '{}' }];
  leadAttribution.markConverted.mockImplementation(convertsRow(FULL_LEAD()));
  await run(withIds);
  expect(leadAttribution.markConverted.mock.calls[0][1].approvedEstimateIds).toEqual(['est-a']);
  leadAttribution.markConverted.mockClear();
  await viaPage(BODY);
  expect('approvedEstimateIds' in leadAttribution.markConverted.mock.calls[0][1]).toBe(false);
});

describe('estimates tagged with the lead (no linked estimate)', () => {
  const TAGGED = { ...EXPECTED, estimateLinked: false, estimateIds: ['est-a'] };
  const tagged = (extra = {}) => ({ id: 'est-a', customer_id: null, estimate_data: JSON.stringify({ lead_id: LEAD }), ...extra });
  beforeEach(() => { tables.estimates = [tagged()]; winsOnRow(); });

  test('the card\u2019s set converts; the claim also rejects any other unowned tagged estimate', async () => {
    expect((await run(TAGGED)).status).toBe(200);
    const claim = claimOf(FULL_LEAD());
    leadAttribution.markConverted.mockImplementationOnce(async (_id, opts) => { opts.onlyIfIdentity(claim.q); return claim.wins(); });
    await run(TAGGED);
    expect(claim.calls.slice(-2)).toEqual([['whereRaw', 'estimates'], ['whereNotExists', 'estimates']]);
  });

  test('a tagged estimate added after the card answers 409', async () => {
    tables.estimates.push(tagged({ id: 'est-b' }));
    expect((await run(TAGGED)).status).toBe(409);
  });

  test('an approved estimate that another customer took, or that went away, answers 409', async () => {
    tables.estimates = [tagged({ customer_id: 'someone-else' })];
    expect((await run(TAGGED)).status).toBe(409);
    tables.estimates = [];
    expect((await run(TAGGED)).status).toBe(409);
  });

  test('the page path has no estimate predicate and never passes an id set', async () => {
    tables.estimates.push(tagged({ id: 'est-b' }));
    const claim = claimOf(FULL_LEAD());
    leadAttribution.markConverted.mockImplementationOnce(async (_id, opts) => { opts.onlyIfIdentity(claim.q); return true; });
    expect((await viaPage(BODY)).status).toBe(200);
    expect(claim.calls).toEqual([['where', 'fn']]);
  });
});
