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
function seed() {
  tables = {
    leads: { id: LEAD, status: 'contacted', updated_at: new Date(SEEN), deleted_at: null },
    customers: { id: CUST },
  };
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.first = jest.fn(async () => tables[table]);
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
      if (prop === 'whereNull') return (k) => { calls.push(['whereNull', k]); list.push((r) => r[k] == null); return builder(list, mode); };
      if (prop === 'whereNot') return (k, v) => { if (mode === 'top') calls.push(['whereNot', k]); list.push((r) => r[k] !== v); return builder(list, mode); };
      if (prop === 'orWhereRaw') return (_sql, [iso]) => { const c = (r) => new Date(r.updated_at).getTime() === new Date(iso).getTime(); c.or = true; list.push(c); return builder(list, mode); };
      if (prop === 'whereRaw') return (_sql, [iso]) => { calls.push(['whereRaw', 'updated_at']); list.push((r) => new Date(r.updated_at).getTime() === new Date(iso).getTime()); return builder(list, mode); };
      return undefined;
    },
  });
  return { q: builder(conds, 'top'), calls, wins: () => conds.every((c) => c(row)) };
}
const convertsRow = (row) => async (_id, opts) => { const claim = claimOf(row); opts.onlyIfIdentity(claim.q); return claim.wins(); };
const EXPECTED = { status: 'contacted', updatedAt: new Date(SEEN).getTime(), customerId: null };
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
  expect(claim.calls).toEqual([['where', 'fn'], ['whereNull', 'converted_at'], ['where', 'status'], ['whereRaw', 'updated_at'], ['whereNull', 'customer_id']]);
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
