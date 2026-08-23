// Lead → customer conversion must not duplicate customers:
//  (a) a second/concurrent convert of an already-converted lead → 409
//      LEAD_ALREADY_CONVERTED and NO customers insert (row-locked re-read);
//  (b) a lead whose email matches a live customer attaches to that account
//      as an additional property (no new customer_accounts row);
//  (c) the happy path still provisions account + customer + visit.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  // admin-leads.js transitively loads admin-customers.js, whose route
  // registration references requireAdmin at import time — mock it so the
  // suite can load.
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/inspection-credit', () => ({
  markBookingForInspectionCredit: jest.fn(async () => {}),
  redeemInspectionCreditForBooking: jest.fn(async () => {}),
}));
jest.mock('../services/lead-estimate-link', () => ({ linkLeadEstimatesToCustomer: jest.fn(async () => {}) }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn(async () => {}) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

function baseLead(extra = {}) {
  return {
    id: LEAD_ID,
    first_name: 'Test',
    last_name: 'Lead',
    phone: '',
    email: 'Lead.Example@Example.com ',
    address: '1 Test St',
    city: 'Testville',
    zip: '00000',
    customer_id: null,
    converted_at: null,
    deleted_at: null,
    ...extra,
  };
}

// Minimal chainable knex stand-in. Every call is recorded as
// { table, op, args }; terminal ops resolve through `resolve(table, op, state)`.
function makeKnex(resolve, calls) {
  const builder = (table) => {
    const state = { table, ops: [], terminal: null };
    const q = {};
    const chain = ['where', 'whereNull', 'whereRaw', 'orderBy', 'forUpdate', 'onConflict', 'ignore', 'returning', 'select'];
    for (const m of chain) {
      q[m] = jest.fn((...args) => { state.ops.push({ op: m, args }); return q; });
    }
    for (const m of ['first', 'update', 'insert', 'columnInfo']) {
      q[m] = jest.fn((...args) => {
        state.terminal = { op: m, args };
        calls.push({ table, op: m, args, ops: state.ops.slice() });
        return q;
      });
    }
    q.then = (onOk, onErr) => Promise.resolve().then(() => resolve(table, state)).then(onOk, onErr);
    return q;
  };
  const knex = jest.fn(builder);
  knex.raw = jest.fn(async () => ({ rows: [] }));
  knex.transaction = jest.fn(async (fn) => {
    const trx = jest.fn(builder);
    trx.raw = knex.raw;
    return fn(trx);
  });
  return knex;
}

function opsOf(state, name) {
  return state.ops.filter((o) => o.op === name);
}

// Shared resolver: the lead the route pre-reads vs the row it sees under lock.
function makeResolver({ preLead, lockedLead, emailMatch = null, convertedRows = 1 }) {
  return (table, state) => {
    const t = state.terminal;
    if (table === 'leads' && t.op === 'first') {
      if (opsOf(state, 'forUpdate').length) return lockedLead;
      return preLead;
    }
    if (table === 'leads' && t.op === 'update') return convertedRows;
    if (table === 'scheduled_services' && t.op === 'columnInfo') return { service_id: true };
    if (table === 'customers' && t.op === 'first') {
      if (opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) return emailMatch;
      return null;
    }
    if (table === 'customer_accounts' && t.op === 'insert') return [{ id: 'acct-new', ...t.args[0] }];
    if (table === 'customers' && t.op === 'insert') return [{ id: 'cust-new', ...t.args[0] }];
    if (table === 'scheduled_services' && t.op === 'insert') return [{ id: 'appt-1', ...t.args[0] }];
    if (t.op === 'insert') return [t.args[0]];
    if (t.op === 'update') return 1;
    return null;
  };
}

function post(baseUrl) {
  return fetch(`${baseUrl}/admin/leads/${LEAD_ID}/schedule-appointment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2027-01-15', time: '10:00', serviceType: 'Pest Control' }),
  });
}

describe('POST /admin/leads/:id/schedule-appointment — no duplicate customers', () => {
  beforeEach(() => db.mockReset());

  it('happy path: provisions account + customer + visit and converts the lead once', async () => {
    const calls = [];
    const knex = makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), calls);
    db.mockImplementation(knex);
    Object.assign(db, { raw: knex.raw, transaction: knex.transaction });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.createdCustomer).toBe(true);
      expect(body.customerId).toBe('cust-new');
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      const custInsert = calls.filter((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert).toHaveLength(1);
      expect(custInsert[0].args[0]).toMatchObject({ is_primary_profile: true, profile_label: 'Primary', account_id: 'acct-new' });
      // The lead update is gated on converted_at being NULL (first conversion).
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.ops.filter((o) => o.op === 'whereNull').map((o) => o.args[0])).toEqual(['deleted_at', 'converted_at']);
    });
  });

  it('second/concurrent convert: locked re-read shows converted → 409, no customer insert', async () => {
    const calls = [];
    const knex = makeKnex(makeResolver({
      preLead: baseLead(),
      lockedLead: { customer_id: 'cust-winner', converted_at: new Date('2026-01-01T00:00:00Z') },
    }), calls);
    db.mockImplementation(knex);
    Object.assign(db, { raw: knex.raw, transaction: knex.transaction });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('LEAD_ALREADY_CONVERTED');
      expect(body.customer_id).toBe('cust-winner');
      // The locked read used FOR UPDATE.
      const locked = calls.find((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      expect(locked).toBeTruthy();
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
      expect(calls.filter((c) => c.table === 'leads' && c.op === 'update')).toHaveLength(0);
    });
  });

  it('final lead update touching 0 rows (converted between lock and update) → 409, rolled back', async () => {
    const calls = [];
    const knex = makeKnex(makeResolver({
      preLead: baseLead(),
      lockedLead: { customer_id: null, converted_at: null },
      convertedRows: 0,
    }), calls);
    db.mockImplementation(knex);
    Object.assign(db, { raw: knex.raw, transaction: knex.transaction });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('LEAD_ALREADY_CONVERTED');
    });
  });

  it('email matching a live customer (no phone): attaches as Additional property, no new account', async () => {
    const calls = [];
    const existing = {
      id: 'cust-existing',
      account_id: 'acct-existing',
      first_name: 'Existing',
      last_name: 'Person',
      email: 'lead.example@example.com',
      phone: '5550000000',
      is_primary_profile: true,
    };
    const knex = makeKnex(makeResolver({
      preLead: baseLead(),
      lockedLead: { customer_id: null, converted_at: null },
      emailMatch: existing,
    }), calls);
    db.mockImplementation(knex);
    Object.assign(db, { raw: knex.raw, transaction: knex.transaction });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(0);
      // Email lookup is normalized (trimmed + lowercased) and scoped to live rows.
      const emailLookup = calls.find((c) => c.table === 'customers' && c.op === 'first' && c.ops.some((o) => o.op === 'whereRaw' && /LOWER\(TRIM/.test(o.args[0])));
      expect(emailLookup.ops.find((o) => o.op === 'whereRaw').args[1]).toEqual(['lead.example@example.com']);
      expect(emailLookup.ops.some((o) => o.op === 'whereNull' && o.args[0] === 'deleted_at')).toBe(true);
      const custInsert = calls.filter((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert).toHaveLength(1);
      expect(custInsert[0].args[0]).toMatchObject({ account_id: 'acct-existing', is_primary_profile: false, profile_label: 'Additional property' });
    });
  });
});

describe('findAccountByContact email opt-in', () => {
  const { findAccountByContact } = require('../routes/admin-customers');

  it('stays phone-only by default (quick-add / webhooks semantics unchanged)', async () => {
    const calls = [];
    const knex = makeKnex(() => null, calls);
    const out = await findAccountByContact(knex, { phone: '', email: 'someone@example.com' });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('matches email only when matchEmail is set and phone found nothing', async () => {
    const calls = [];
    const knex = makeKnex((table, state) => {
      if (table !== 'customers') return null;
      return opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))
        ? { id: 'c1', account_id: 'a1', email: 'someone@example.com' }
        : null;
    }, calls);
    const out = await findAccountByContact(knex, { phone: '5551234567', email: '  SomeOne@Example.com', matchEmail: true });
    expect(out).toMatchObject({ accountId: 'a1', matchType: 'email' });
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'first')).toHaveLength(2);
  });
});
