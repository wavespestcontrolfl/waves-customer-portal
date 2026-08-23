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
    q.then = (onOk, onErr) => {
      if (!state.terminal) calls.push({ table, op: 'chain', args: [], ops: state.ops.slice() });
      return Promise.resolve().then(() => resolve(table, state)).then(onOk, onErr);
    };
    return q;
  };
  const knex = jest.fn(builder);
  knex.raw = jest.fn(async (sql, bindings) => {
    calls.push({ table: null, op: 'raw', args: [sql, bindings], ops: [] });
    return { rows: [{ locked: true }] };
  });
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
    if (table === 'customers' && !t && opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) {
      return emailMatch ? (Array.isArray(emailMatch) ? emailMatch : [emailMatch]) : [];
    }
    if (!t) return [];
    if (table === 'leads' && t.op === 'first') {
      if (opsOf(state, 'forUpdate').length) return lockedLead;
      return preLead;
    }
    if (table === 'leads' && t.op === 'update') return convertedRows;
    if (table === 'scheduled_services' && t.op === 'columnInfo') return { service_id: true };
    if (table === 'customers' && t.op === 'first') {
      if (opsOf(state, 'where').some((o) => o.args[0]?.id === 'cust-linked')) return existingLinked;
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

function post(baseUrl, extra = {}) {
  return fetch(`${baseUrl}/admin/leads/${LEAD_ID}/schedule-appointment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2027-01-15', time: '10:00', serviceType: 'Pest Control', ...extra }),
  });
}

function install(knex) {
  db.mockImplementation(knex);
  Object.assign(db, { raw: knex.raw, transaction: knex.transaction });
}

const CONVERTED_AT = new Date('2026-01-01T00:00:00Z');
const linkedLead = () => baseLead({ customer_id: 'cust-linked', converted_at: CONVERTED_AT });
const lockedLinked = { customer_id: 'cust-linked', converted_at: CONVERTED_AT };
const existingLinked = { id: 'cust-linked', account_id: 'acct-linked', pipeline_stage: 'won', active: true };

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

  const existingEmailCustomer = {
    id: 'cust-existing',
    account_id: 'acct-existing',
    first_name: 'Existing',
    last_name: 'Person',
    email: 'lead.example@example.com',
    phone: '5550000000',
    is_primary_profile: true,
    profile_label: 'Primary',
    address_line1: '2 Other St',
  };
  const emailKnexRoute = (calls) => makeKnex(makeResolver({
    preLead: baseLead(),
    lockedLead: { customer_id: null, converted_at: null },
    emailMatch: existingEmailCustomer,
  }), calls);

  it('email matches a live customer, no attachToAccountId → 409 EMAIL_MATCH_CONFIRM, zero writes', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.match).toEqual({
        accountId: 'acct-existing',
        customerId: 'cust-existing',
        name: 'Existing Person',
        emailMasked: 'l***@example.com',
        propertyLabel: 'Primary',
        addressLine1: '2 Other St',
      });
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
      // No comms lock taken on the create path before the 409.
      expect(calls.filter((c) => c.op === 'raw')).toHaveLength(0);
    });
  });

  it('stale/mismatched attachToAccountId → 409 EMAIL_MATCH_CONFIRM, zero writes', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-someone-else' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('EMAIL_MATCH_CONFIRM');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('createSeparateAccount: true → email matching skipped, fresh account + primary customer', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: null, createSeparateAccount: true });
      expect(res.status).toBe(200);
      expect(calls.some((c) => c.table === 'customers' && c.op === 'chain')).toBe(false);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      const custInsert = calls.filter((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert[0].args[0]).toMatchObject({ account_id: 'acct-new', is_primary_profile: true, profile_label: 'Primary' });
    });
  });

  it('email match + matching attachToAccountId → attaches as Additional property, no new account', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-existing' });
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(0);
      // Email lookup is normalized (trimmed + lowercased) and scoped to live rows.
      const emailLookup = calls.find((c) => c.table === 'customers' && c.op === 'chain' && c.ops.some((o) => o.op === 'whereRaw' && /LOWER\(TRIM/.test(o.args[0])));
      expect(emailLookup.ops.find((o) => o.op === 'whereRaw').args[1]).toEqual(['lead.example@example.com']);
      expect(emailLookup.ops.some((o) => o.op === 'whereNull' && o.args[0] === 'deleted_at')).toBe(true);
      const custInsert = calls.filter((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert).toHaveLength(1);
      expect(custInsert[0].args[0]).toMatchObject({ account_id: 'acct-existing', is_primary_profile: false, profile_label: 'Additional property' });
    });
  });
});

describe('POST /admin/leads/:id/schedule-appointment — sequential retry + rebook + lock order', () => {
  beforeEach(() => db.mockReset());

  it('retry that begins AFTER the first commit (pre-read converted, no rebook) → 409, zero inserts', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('LEAD_ALREADY_CONVERTED');
      expect(body.customer_id).toBe('cust-linked');
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
      expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
    });
  });

  it('rebook: true on a converted lead books a visit on the linked customer, no new customer', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.createdCustomer).toBe(false);
      expect(body.customerId).toBe('cust-linked');
      expect(calls.filter((c) => c.table === 'customers' && c.op === 'insert')).toHaveLength(0);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(0);
      const visit = calls.filter((c) => c.table === 'scheduled_services' && c.op === 'insert');
      expect(visit).toHaveLength(1);
      expect(visit[0].args[0].customer_id).toBe('cust-linked');
      // Already-converted lead: update is NOT gated on converted_at IS NULL.
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.ops.filter((o) => o.op === 'whereNull').map((o) => o.args[0])).toEqual(['deleted_at']);
    });
  });

  it('rebook: true is ignored for an unconverted lead (plain first conversion, still gated)', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(200);
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.ops.filter((o) => o.op === 'whereNull').map((o) => o.args[0])).toEqual(['deleted_at', 'converted_at']);
    });
  });

  it('lock order: customer known from pre-read → comms advisory lock BEFORE the lead FOR UPDATE', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(200);
      const commsIdx = calls.findIndex((c) => c.op === 'raw' && /pg_advisory_xact_lock/.test(c.args[0]) && c.args[1][0] === 'customer-comms:cust-linked');
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      expect(commsIdx).toBeGreaterThanOrEqual(0);
      expect(forUpdateIdx).toBeGreaterThan(commsIdx);
    });
  });

  it('lock order: customer discovered only under the lead lock → non-blocking try-lock, never the blocking lock first', async () => {
    const calls = [];
    // Pre-read: unconverted and unlinked; under lock: linked + converted (rebook requested).
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(200);
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      const raws = calls.map((c, i) => ({ ...c, i })).filter((c) => c.op === 'raw');
      const blockingBeforeLead = raws.filter((c) => /pg_advisory_xact_lock/.test(c.args[0]) && c.i < forUpdateIdx);
      expect(blockingBeforeLead).toHaveLength(0);
      const tryIdx = raws.find((c) => /pg_try_advisory_xact_lock/.test(c.args[0]));
      expect(tryIdx).toBeTruthy();
      expect(tryIdx.i).toBeGreaterThan(forUpdateIdx);
    });
  });

  it('try-lock refused (undo in flight) → 409 fail-closed, no visit', async () => {
    const calls = [];
    const knex = makeKnex(makeResolver({ preLead: baseLead(), lockedLead: lockedLinked }), calls);
    knex.raw = jest.fn(async (sql) => ({ rows: [{ locked: !/pg_try_advisory/.test(sql) }] }));
    install(knex);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('LEAD_ALREADY_CONVERTED');
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
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
        ? [{ id: 'c1', account_id: 'a1', email: 'someone@example.com' }]
        : null;
    }, calls);
    const unconfirmed = await findAccountByContact(knex, { phone: '5551234567', email: '  SomeOne@Example.com', matchEmail: true });
    expect(unconfirmed).toMatchObject({ accountId: null, matchType: 'email', requiresConfirmation: true, match: { accountId: 'a1', customerId: 'c1' } });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
    const out = await findAccountByContact(knex, { phone: '5551234567', email: '  SomeOne@Example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: 'a1', matchType: 'email' });
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'first')).toHaveLength(2);
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'chain')).toHaveLength(2);
  });

  it('phone match wins and attaches without confirmation (unchanged), even with matchEmail', async () => {
    const calls = [];
    const knex = makeKnex((table, state) => {
      if (table !== 'customers' || state.terminal?.op !== 'first') return null;
      return opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))
        ? { id: 'cp', account_id: 'ap', phone: '5551234567' }
        : null;
    }, calls);
    const out = await findAccountByContact(knex, { phone: '5551234567', email: 'x@example.com', matchEmail: true });
    expect(out).toMatchObject({ accountId: 'ap', matchType: 'phone' });
    expect(calls.filter((c) => c.op === 'chain')).toHaveLength(0);
  });

  function emailKnex(rows, calls) {
    return makeKnex((table, state) => {
      if (table !== 'customers') return null;
      if (opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) return rows;
      return null;
    }, calls);
  }

  it('shared email across MULTIPLE accounts → no match (fail closed, caller creates a new account)', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: 'a1', email: 'shared@example.com', is_primary_profile: true },
      { id: 'c2', account_id: 'a2', email: 'shared@example.com', is_primary_profile: true },
    ], calls);
    const out = await findAccountByContact(knex, { phone: '', email: 'shared@example.com', matchEmail: true });
    expect(out).toBeNull();
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  it('shared email across multiple rows of the SAME account → match that account', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: 'a1', email: 'shared@example.com', is_primary_profile: true },
      { id: 'c2', account_id: 'a1', email: 'shared@example.com', is_primary_profile: false },
    ], calls);
    const out = await findAccountByContact(knex, { phone: '', email: 'shared@example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: 'a1', matchType: 'email', existingCustomer: { id: 'c1' } });
  });

  it('unlinked legacy row (no account_id) alongside a linked row of another account → no match', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: null, email: 'shared@example.com' },
      { id: 'c2', account_id: 'a2', email: 'shared@example.com' },
    ], calls);
    const out = await findAccountByContact(knex, { phone: '', email: 'shared@example.com', matchEmail: true });
    expect(out).toBeNull();
  });
});

describe('POST /admin/leads/:id/schedule-appointment — customer_id linked WITHOUT converted_at (public-quote shape)', () => {
  beforeEach(() => db.mockReset());
  const quoteLead = () => baseLead({ customer_id: 'cust-linked', converted_at: null });
  const lockedQuote = { customer_id: 'cust-linked', converted_at: null };

  it('first conversion without rebook → reuses linked customer, update gated on whereNull(converted_at)', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: quoteLead(), lockedLead: lockedQuote }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.createdCustomer).toBe(false);
      expect(body.customerId).toBe('cust-linked');
      expect(calls.filter((c) => c.table === 'customers' && c.op === 'insert')).toHaveLength(0);
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.ops.filter((o) => o.op === 'whereNull').map((o) => o.args[0])).toEqual(['deleted_at', 'converted_at']);
    });
  });

  it('retry of that conversion (now converted under lock, no rebook) → 409, zero inserts', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: quoteLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('LEAD_ALREADY_CONVERTED');
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
    });
  });
});
