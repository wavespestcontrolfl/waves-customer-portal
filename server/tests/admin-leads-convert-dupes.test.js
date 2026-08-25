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
    // Role comes from the (mocked) auth layer exactly as admin-auth.js sets
    // req.techRole; tests pick a technician via the x-test-role header.
    req.techRole = req.headers['x-test-role'] === 'technician' ? 'technician' : 'admin';
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
    const chain = ['where', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereRaw', 'orWhereRaw', 'orWhereNot', 'orderBy', 'forUpdate', 'onConflict', 'ignore', 'returning', 'select'];
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
  knex.isTransaction = false;
  knex.raw = jest.fn(async (sql, bindings) => {
    calls.push({ table: null, op: 'raw', args: [sql, bindings], ops: [] });
    return { rows: [{ locked: true }] };
  });
  knex.transaction = jest.fn(async (fn) => {
    calls.push({ table: null, op: 'trx-begin', args: [], ops: [] });
    const trx = jest.fn(builder);
    trx.isTransaction = true;
    trx.raw = knex.raw;
    return fn(trx);
  });
  return knex;
}

function opsOf(state, name) {
  return state.ops.filter((o) => o.op === name);
}

// Shared resolver: the lead the route pre-reads vs the row it sees under lock.
const isOccupancyProbe = (state) => opsOf(state, 'whereRaw').some((o) => /window_start < \?::time/.test(o.args[0]));

// Occupancy conflicts are derived from the SAME existingVisits fixture the
// DUPLICATE_VISIT dedupe reads: date match + active status + window overlap
// (bindings of the probe's whereRaw are [windowEnd, defaultMinutes, windowStart]).
function occupancyConflicts(state, existingVisits) {
  const date = opsOf(state, 'where').find((o) => o.args[0] === 'scheduled_date')?.args[1];
  const probe = opsOf(state, 'whereRaw').find((o) => /window_start < \?::time/.test(o.args[0]));
  const [windowEnd, , windowStart] = probe.args[1];
  return existingVisits.filter((v) => v.scheduled_date === date
    && v.status !== 'cancelled'
    && v.window_start < windowEnd && (v.window_end || '23:59') > windowStart);
}

function makeResolver({ preLead, lockedLead, emailMatch = null, convertedRows = 1, existingVisits = [] }) {
  return (table, state) => {
    const t = state.terminal;
    if (table === 'scheduled_services' && !t && isOccupancyProbe(state)) return occupancyConflicts(state, existingVisits);
    if (table === 'customers' && !t && opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) {
      return emailMatch ? (Array.isArray(emailMatch) ? emailMatch : [emailMatch]) : [];
    }
    if (!t) return [];
    if (table === 'leads' && t.op === 'first') {
      // The locked read now selects the contact fields too; fixtures give the
      // locked row only the fields that differ from the pre-read.
      if (opsOf(state, 'forUpdate').length) return lockedLead ? { ...preLead, ...lockedLead } : lockedLead;
      return preLead;
    }
    if (table === 'leads' && t.op === 'update') return convertedRows;
    if (table === 'scheduled_services' && t.op === 'columnInfo') return { service_id: true };
    if (table === 'scheduled_services' && t.op === 'first') {
      const w = opsOf(state, 'where')[0]?.args[0] || {};
      return existingVisits.find((v) => v.customer_id === w.customer_id && v.scheduled_date === w.scheduled_date && v.window_start === w.window_start) || null;
    }
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

function post(baseUrl, extra = {}, { role = 'admin' } = {}) {
  return fetch(`${baseUrl}/admin/leads/${LEAD_ID}/schedule-appointment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
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
        name: 'Existing Person',
        emailMasked: 'l***@example.com',
      });
      expect(body.match).not.toHaveProperty('customerId');
      expect(body.match).not.toHaveProperty('propertyLabel');
      expect(body.match).not.toHaveProperty('addressLine1');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
      // No comms lock taken on the create path before the 409.
      expect(calls.filter((c) => c.op === 'raw' && /customer-comms/.test(String(c.args[1]?.[0])))).toHaveLength(0);
    });
  });

  it('technician role: email match → 409 EMAIL_MATCH_ADMIN_REQUIRED, no match object, zero writes', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {}, { role: 'technician' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({ error: "An existing customer matches this lead's email — an admin must book it.", code: 'EMAIL_MATCH_ADMIN_REQUIRED' });
      expect(body).not.toHaveProperty('match');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it.each([
    ['attachToAccountId', { attachToAccountId: 'acct-existing' }],
    ['createSeparateAccount', { attachToAccountId: null, createSeparateAccount: true }],
  ])('technician role: %s is ignored → still 409 EMAIL_MATCH_ADMIN_REQUIRED, zero writes', async (_label, body) => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, body, { role: 'technician' });
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.code).toBe('EMAIL_MATCH_ADMIN_REQUIRED');
      expect(json).not.toHaveProperty('match');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('technician role: no email match → books normally (role gate only affects the match flow)', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, {}, { role: 'technician' })).status).toBe(200);
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

  it('attachToAccountId supplied but email now unmatched → 409 EMAIL_MATCH_CONFIRM (match null), zero writes', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null }, emailMatch: null }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-existing' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.match).toBeNull();
      expect(body.error).toMatch(/changed/i);
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  const multiAccountKnex = (calls) => makeKnex(makeResolver({
    preLead: baseLead(),
    lockedLead: { customer_id: null, converted_at: null },
    emailMatch: [existingEmailCustomer, { ...existingEmailCustomer, id: 'cust-other', account_id: 'acct-other', first_name: 'Other', last_name: 'Household' }],
  }), calls);

  it('attachToAccountId that is NOT one of the candidate accounts → 409 EMAIL_MATCH_CONFIRM (matchChanged), zero writes', async () => {
    const calls = [];
    install(multiAccountKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-nope' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.match).toBeNull();
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('admin, email across multiple accounts, no id → 409 EMAIL_MATCH_AMBIGUOUS with trimmed candidates, zero writes', async () => {
    const calls = [];
    install(multiAccountKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_AMBIGUOUS');
      expect(body.error).toMatch(/several accounts/i);
      expect(body.candidates).toEqual([
        { accountId: 'acct-existing', name: 'Existing Person', emailMasked: 'l***@example.com' },
        { accountId: 'acct-other', name: 'Other Household', emailMasked: 'l***@example.com' },
      ]);
      expect(body).not.toHaveProperty('match');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('technician, email across multiple accounts → 409 EMAIL_MATCH_ADMIN_REQUIRED, no candidates, zero writes', async () => {
    const calls = [];
    install(multiAccountKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, {}, { role: 'technician' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_ADMIN_REQUIRED');
      expect(body).not.toHaveProperty('candidates');
      expect(body).not.toHaveProperty('match');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('admin resolves ambiguity with attachToAccountId = a candidate → attaches there as Additional property', async () => {
    const calls = [];
    install(multiAccountKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-other' });
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(0);
      const custInsert = calls.find((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert.args[0]).toMatchObject({ account_id: 'acct-other', is_primary_profile: false, profile_label: 'Additional property' });
    });
  });

  it('admin resolves ambiguity with createSeparateAccount → fresh account (phone fail-closed still applies)', async () => {
    const calls = [];
    install(multiAccountKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: null, createSeparateAccount: true });
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      expect(calls.some((c) => c.table === 'customers' && c.op === 'chain')).toBe(false);
    });
  });

  const legacyRow = { id: 'cust-legacy', account_id: null, first_name: 'Legacy', last_name: 'Row', phone: '5551234567', is_primary_profile: true };
  const ARCHIVED = Symbol('archived-after-fence');
  const phoneMatchKnex = (calls, { refuse = false, afterFence = null } = {}) => {
    const base = makeResolver({ preLead: baseLead({ phone: '5551234567' }), lockedLead: { customer_id: null, converted_at: null } });
    let phoneLookups = 0;
    const knex = makeKnex((table, state) => {
      if (table === 'customers' && state.terminal?.op === 'first' && opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))) {
        phoneLookups += 1;
        if (phoneLookups > 1 && afterFence !== null) return afterFence === ARCHIVED ? null : afterFence;
        return legacyRow;
      }
      return base(table, state);
    }, calls);
    knex.raw = jest.fn(async (sql, bindings) => {
      calls.push({ table: null, op: 'raw', args: [sql, bindings], ops: [] });
      return { rows: [{ locked: !(refuse && /pg_try_advisory/.test(sql)) }] };
    });
    return knex;
  };

  it('phone-match attach: try-lock customer-comms:<matched id> AFTER the lead FOR UPDATE and BEFORE the customers update', async () => {
    const calls = [];
    install(phoneMatchKnex(calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl)).status).toBe(200);
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      const tryIdx = calls.findIndex((c) => c.op === 'raw' && /pg_try_advisory_xact_lock/.test(c.args[0]) && c.args[1][0] === 'customer-comms:cust-legacy');
      const custUpdateIdx = calls.findIndex((c) => c.table === 'customers' && c.op === 'update');
      expect(tryIdx).toBeGreaterThan(forUpdateIdx);
      expect(custUpdateIdx).toBeGreaterThan(tryIdx);
      // No blocking comms lock on that customer anywhere (lead row already held).
      expect(calls.some((c) => c.op === 'raw' && /SELECT pg_advisory_xact_lock/.test(c.args[0]) && c.args[1][0] === 'customer-comms:cust-legacy')).toBe(false);
    });
  });

  it.each([
    ['archived', ARCHIVED],
    ['re-pointed to another account', { ...legacyRow, account_id: 'acct-other' }],
    ['a different row now wins', { ...legacyRow, id: 'cust-winner' }],
  ])('phone-match attach: matched customer %s after the fence → 409 CUSTOMER_BUSY, zero writes', async (_label, afterFence) => {
    const calls = [];
    install(phoneMatchKnex(calls, { afterFence }));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CUSTOMER_BUSY');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
      // Re-resolve happened AFTER the try-lock.
      const tryIdx = calls.findIndex((c) => c.op === 'raw' && /pg_try_advisory_xact_lock/.test(c.args[0]));
      const phoneIdxs = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.table === 'customers' && c.op === 'first' && c.ops.some((o) => o.op === 'whereRaw' && /regexp_replace/.test(o.args[0]))).map(({ i }) => i);
      expect(phoneIdxs).toHaveLength(2);
      expect(phoneIdxs[0]).toBeLessThan(tryIdx);
      expect(phoneIdxs[1]).toBeGreaterThan(tryIdx);
    });
  });

  it('email-confirmed attach: email account-set changed after the fence → 409 EMAIL_MATCH_CONFIRM, zero writes', async () => {
    const calls = [];
    const base = makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null }, emailMatch: existingEmailCustomer });
    let emailLookups = 0;
    install(makeKnex((table, state) => {
      if (table === 'customers' && !state.terminal && opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) {
        emailLookups += 1;
        // Second resolution (under the fence): a second household now shares the email.
        return emailLookups > 1
          ? [existingEmailCustomer, { ...existingEmailCustomer, id: 'cust-other', account_id: 'acct-other' }]
          : [existingEmailCustomer];
      }
      return base(table, state);
    }, calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-existing' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.match).toBeNull();
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
      const tryIdx = calls.findIndex((c) => c.op === 'raw' && /pg_try_advisory_xact_lock/.test(c.args[0]));
      const emailIdxs = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.table === 'customers' && c.op === 'chain' && c.ops.some((o) => o.op === 'whereRaw' && /LOWER\(TRIM/.test(o.args[0]))).map(({ i }) => i);
      expect(emailIdxs).toHaveLength(2);
      expect(emailIdxs[1]).toBeGreaterThan(tryIdx);
    });
  });

  it('createSeparateAccount + live phone match → 409 PHONE_MATCH_CONFIRM (trimmed), zero writes, email matching skipped', async () => {
    const calls = [];
    install(phoneMatchKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: null, createSeparateAccount: true });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('PHONE_MATCH_CONFIRM');
      expect(body.match).toEqual({ accountId: 'cust-legacy', name: 'Legacy Row', phoneMasked: '***-***-4567' });
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
      expect(calls.some((c) => c.table === 'customers' && c.op === 'chain')).toBe(false);
    });
  });

  it('createSeparateAccount + ignorePhoneMatch with a live phone match → fresh account, no attach, no email lookup', async () => {
    const calls = [];
    install(phoneMatchKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: null, createSeparateAccount: true, ignorePhoneMatch: true });
      expect(res.status).toBe(200);
      expect((await res.json()).createdCustomer).toBe(true);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      expect(calls.filter((c) => c.table === 'customers' && c.op === 'update')).toHaveLength(0);
      expect(calls.some((c) => c.table === 'customers' && c.op === 'chain')).toBe(false);
      const custInsert = calls.find((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert.args[0]).toMatchObject({ account_id: 'acct-new', is_primary_profile: true, profile_label: 'Primary' });
    });
  });

  it('createSeparateAccount with no phone match → fresh account', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead({ phone: '5559876543' }), lockedLead: { customer_id: null, converted_at: null }, emailMatch: existingEmailCustomer }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { attachToAccountId: null, createSeparateAccount: true })).status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      expect(calls.some((c) => c.table === 'customers' && c.op === 'chain')).toBe(false);
    });
  });

  it('technician: createSeparateAccount/ignorePhoneMatch ignored → normal phone-first attach path', async () => {
    const calls = [];
    install(phoneMatchKnex(calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { createSeparateAccount: true, ignorePhoneMatch: true }, { role: 'technician' });
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'customer_accounts' && c.op === 'insert')).toHaveLength(1);
      const custInsert = calls.find((c) => c.table === 'customers' && c.op === 'insert');
      expect(custInsert.args[0]).toMatchObject({ profile_label: 'Additional property', is_primary_profile: false });
    });
  });

  it('locked row wins: pre-read has the old phone, locked row has the corrected one → matching + insert use the corrected phone', async () => {
    const calls = [];
    install(makeKnex(makeResolver({
      preLead: baseLead({ phone: '5550000000', first_name: 'Old' }),
      lockedLead: { customer_id: null, converted_at: null, phone: '5551234567', first_name: 'Corrected' },
    }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl)).status).toBe(200);
      const phoneLookup = calls.find((c) => c.table === 'customers' && c.op === 'first' && c.ops.some((o) => o.op === 'whereRaw' && /regexp_replace/.test(o.args[0])));
      expect(phoneLookup.ops.find((o) => o.op === 'whereRaw').args[1]).toEqual(['%5551234567']);
      const acct = calls.find((c) => c.table === 'customer_accounts' && c.op === 'insert').args[0];
      expect(String(acct.phone).replace(/\D/g, '').slice(-10)).toBe('5551234567');
      expect(acct.first_name).toBe('Corrected');
      const cust = calls.find((c) => c.table === 'customers' && c.op === 'insert').args[0];
      expect(String(cust.phone).replace(/\D/g, '').slice(-10)).toBe('5551234567');
      expect(cust.first_name).toBe('Corrected');
    });
  });

  it('phone-match attach: try-lock refused → 409 CUSTOMER_BUSY, zero customer updates/inserts', async () => {
    const calls = [];
    install(phoneMatchKnex(calls, { refuse: true }));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CUSTOMER_BUSY');
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('email-confirmed attach: try-lock customer-comms:<matched id> after lead lock, before customers update', async () => {
    const calls = [];
    install(emailKnexRoute(calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { attachToAccountId: 'acct-existing' })).status).toBe(200);
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      const tryIdx = calls.findIndex((c) => c.op === 'raw' && /pg_try_advisory_xact_lock/.test(c.args[0]) && c.args[1][0] === 'customer-comms:cust-existing');
      expect(tryIdx).toBeGreaterThan(forUpdateIdx);
      const firstWrite = calls.findIndex((c) => c.op === 'insert' || c.op === 'update');
      expect(firstWrite).toBeGreaterThan(tryIdx);
    });
  });

  it('email-confirmed attach: try-lock refused → 409 EMAIL_MATCH_CONFIRM, zero writes', async () => {
    const calls = [];
    const knex = emailKnexRoute(calls);
    knex.raw = jest.fn(async (sql, bindings) => {
      calls.push({ table: null, op: 'raw', args: [sql, bindings], ops: [] });
      return { rows: [{ locked: !/pg_try_advisory/.test(sql) }] };
    });
    install(knex);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-existing' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.error).toMatch(/being updated/i);
      expect(calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
    });
  });

  it('attachToAccountId A but lead phone now matches a customer on another account → 409 EMAIL_MATCH_CONFIRM, zero writes', async () => {
    const calls = [];
    const base = makeResolver({ preLead: baseLead({ phone: '5551234567' }), lockedLead: { customer_id: null, converted_at: null }, emailMatch: existingEmailCustomer });
    install(makeKnex((table, state) => {
      if (table === 'customers' && state.terminal?.op === 'first' && opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))) {
        return { id: 'cust-b', account_id: 'acct-b', phone: '5551234567' };
      }
      return base(table, state);
    }, calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { attachToAccountId: 'acct-existing' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_MATCH_CONFIRM');
      expect(body.error).toMatch(/different account/i);
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

  it('occupancy: date lock is the FIRST statement of the trx, before comms lock and lead FOR UPDATE', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { rebook: true })).status).toBe(200);
      const first = calls[calls.findIndex((c) => c.op === 'trx-begin') + 1];
      expect(first.op).toBe('raw');
      expect(first.args[0]).toMatch(/pg_advisory_xact_lock\(hashtext/);
      expect(first.args[1][1]).toBe('occupancy:2027-01-15');
      const commsIdx = calls.findIndex((c) => c.op === 'raw' && /customer-comms/.test(String(c.args[1]?.[0])));
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      expect(commsIdx).toBeGreaterThan(0);
      expect(forUpdateIdx).toBeGreaterThan(commsIdx);
    });
  });

  const ownBooking = { id: 'appt-existing', customer_id: 'cust-linked', technician_id: 'tech-1', scheduled_date: '2027-01-15', window_start: '10:00', window_end: '11:00', status: 'pending', service_type: 'Pest Control' };
  const otherBooking = { id: 'appt-other', customer_id: 'cust-other', technician_id: null, scheduled_date: '2027-01-15', window_start: '10:00', window_end: '11:00', status: 'pending', service_type: 'Lawn' };

  it('ordering: retry after commit with its OWN booking on the schedule → LEAD_ALREADY_CONVERTED, not SLOT_CONFLICT', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked, existingVisits: [ownBooking] }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('LEAD_ALREADY_CONVERTED');
      expect(calls.some((c) => c.table === 'scheduled_services' && c.op === 'chain' && isOccupancyProbe(c))).toBe(false);
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
    });
  });

  it('ordering: rebook same slot with its OWN booking on the schedule → DUPLICATE_VISIT, not SLOT_CONFLICT', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked, existingVisits: [ownBooking] }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('DUPLICATE_VISIT');
      expect(calls.some((c) => c.table === 'scheduled_services' && c.op === 'chain' && isOccupancyProbe(c))).toBe(false);
    });
  });

  it('ordering: occupancy probe runs after the dedupe lookup and immediately before the insert', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { rebook: true })).status).toBe(200);
      const dedupeIdx = calls.findIndex((c) => c.table === 'scheduled_services' && c.op === 'first');
      const probeIdx = calls.findIndex((c) => c.table === 'scheduled_services' && c.op === 'chain' && isOccupancyProbe(c));
      const insertIdx = calls.findIndex((c) => c.table === 'scheduled_services' && c.op === 'insert');
      expect(probeIdx).toBeGreaterThan(dedupeIdx);
      expect(insertIdx).toBe(probeIdx + 1);
    });
  });

  it.each([
    ['rebook', () => ({ preLead: linkedLead(), lockedLead: lockedLinked }), { rebook: true }],
    ['first conversion', () => ({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), {}],
  ])('occupancy: %s overlapping another customer\'s visit (tech NULL) → BOOKS with a warning naming the date (advisory — owner ruling 2026-08-25)', async (_label, fixture, body) => {
    const calls = [];
    install(makeKnex(makeResolver({ ...fixture(), existingVisits: [otherBooking] }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, body);
      expect(res.status).toBe(200);
      const json = await res.json();
      // The overlap no longer refuses the booking — it commits and the
      // response carries the advisory warning naming the date.
      expect(json.warnings).toEqual([expect.stringContaining('2027-01-15')]);
      expect(calls.filter((c) => c.table === 'scheduled_services' && c.op === 'insert')).toHaveLength(1);
      // Probe still runs, tech-blind with the shared admin exclusion set
      // (freed terminal rows never draw a false overlap note).
      const probe = calls.find((c) => c.table === 'scheduled_services' && c.op === 'chain' && isOccupancyProbe(c));
      expect(probe.ops.find((o) => o.op === 'whereNotIn').args).toEqual(['status', ['cancelled', 'completed', 'skipped', 'no_show']]);
      expect(probe.ops.some((o) => o.op === 'where' && o.args[0]?.technician_id !== undefined)).toBe(false);
    });
  });

  it('occupancy: a clean booking carries no warnings key', async () => {
    // Dynamic future date — a hardcoded one time-bombs the not-in-the-past
    // validator (AGENTS.md date rule).
    const et = jest.requireActual('../utils/datetime-et');
    const futureDate = et.etDateString(et.addETDays(et.parseETDateTime(`${et.etDateString()}T12:00`), 30));
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true, date: futureDate });
      expect(res.status).toBe(200);
      expect((await res.json()).warnings).toBeUndefined();
    });
  });

  it('rebook preserves converted_at and emits no "converted" activity (appointment event only)', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: linkedLead(), lockedLead: lockedLinked }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { rebook: true })).status).toBe(200);
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.args[0]).not.toHaveProperty('converted_at');
      const activities = calls.filter((c) => c.table === 'lead_activities' && c.op === 'insert').map((c) => c.args[0].activity_type);
      expect(activities).toEqual(['appointment_scheduled']);
    });
  });

  it('first conversion sets converted_at and logs both converted + appointment activities', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl)).status).toBe(200);
      const leadUpdate = calls.find((c) => c.table === 'leads' && c.op === 'update');
      expect(leadUpdate.args[0].converted_at).toBeInstanceOf(Date);
      const activities = calls.filter((c) => c.table === 'lead_activities' && c.op === 'insert').map((c) => c.args[0].activity_type);
      expect(activities).toEqual(['converted', 'appointment_scheduled']);
    });
  });

  it('rebook twice for the same slot → second is 409 DUPLICATE_VISIT with zero inserts', async () => {
    const calls = [];
    install(makeKnex(makeResolver({
      preLead: linkedLead(),
      lockedLead: lockedLinked,
      existingVisits: [{ id: 'appt-existing', customer_id: 'cust-linked', scheduled_date: '2027-01-15', window_start: '10:00', status: 'pending' }],
    }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('DUPLICATE_VISIT');
      expect(body.scheduled_service_id).toBe('appt-existing');
      expect(calls.filter((c) => c.op === 'insert')).toHaveLength(0);
      // The dedupe lookup excludes cancelled visits and ran under the locks.
      const lookup = calls.find((c) => c.table === 'scheduled_services' && c.op === 'first');
      expect(lookup.ops.find((o) => o.op === 'whereNotIn').args).toEqual(['status', ['cancelled']]);
      expect(lookup.ops[0].args[0]).toMatchObject({ customer_id: 'cust-linked', scheduled_date: '2027-01-15', window_start: '10:00', service_type: 'Pest Control' });
      const forUpdateIdx = calls.findIndex((c) => c.table === 'leads' && c.op === 'first' && c.ops.some((o) => o.op === 'forUpdate'));
      expect(calls.indexOf(lookup)).toBeGreaterThan(forUpdateIdx);
    });
  });

  it('rebook with a different date → 200, visit inserted', async () => {
    const calls = [];
    install(makeKnex(makeResolver({
      preLead: linkedLead(),
      lockedLead: lockedLinked,
      existingVisits: [{ id: 'appt-existing', customer_id: 'cust-linked', scheduled_date: '2027-01-15', window_start: '10:00', status: 'pending' }],
    }), calls));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { rebook: true, date: '2027-01-22' });
      expect(res.status).toBe(200);
      expect(calls.filter((c) => c.table === 'scheduled_services' && c.op === 'insert')).toHaveLength(1);
    });
  });

  it('first conversion (no rebook) skips the dedupe lookup', async () => {
    const calls = [];
    install(makeKnex(makeResolver({ preLead: baseLead(), lockedLead: { customer_id: null, converted_at: null } }), calls));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl)).status).toBe(200);
      expect(calls.filter((c) => c.table === 'scheduled_services' && c.op === 'first')).toHaveLength(0);
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
      const blockingBeforeLead = raws.filter((c) => /pg_advisory_xact_lock/.test(c.args[0]) && /customer-comms/.test(String(c.args[1]?.[0])) && c.i < forUpdateIdx);
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
  // Unit tests below exercise the fenced lead-convert contract: a trx-like
  // fake (isTransaction: true) + fenceAttach: true.
  const makeTrx = (resolve, calls) => Object.assign(makeKnex(resolve, calls), { isTransaction: true });
  const FENCED = { fenceAttach: true };

  it('stays phone-only by default (quick-add / webhooks semantics unchanged)', async () => {
    const calls = [];
    const knex = makeTrx(() => null, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'someone@example.com' });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('matches email only when matchEmail is set and phone found nothing', async () => {
    const calls = [];
    const knex = makeTrx((table, state) => {
      if (table !== 'customers') return null;
      return opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))
        ? [{ id: 'c1', account_id: 'a1', email: 'someone@example.com' }]
        : null;
    }, calls);
    const unconfirmed = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: '  SomeOne@Example.com', matchEmail: true });
    expect(unconfirmed).toMatchObject({ accountId: null, matchType: 'email', requiresConfirmation: true, match: { accountId: 'a1' } });
    expect(unconfirmed.match).not.toHaveProperty('customerId');
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: '  SomeOne@Example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: 'a1', matchType: 'email' });
    // unconfirmed: phone + email; confirmed: email, phone-conflict, fence, email again, phone again
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'first')).toHaveLength(3);
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'chain')).toHaveLength(3);
  });

  it('phone match wins and attaches without confirmation (unchanged), even with matchEmail', async () => {
    const calls = [];
    const knex = makeTrx((table, state) => {
      if (table !== 'customers' || state.terminal?.op !== 'first') return null;
      return opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))
        ? { id: 'cp', account_id: 'ap', phone: '5551234567' }
        : null;
    }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'x@example.com', matchEmail: true });
    expect(out).toMatchObject({ accountId: 'ap', matchType: 'phone' });
    expect(calls.filter((c) => c.op === 'chain')).toHaveLength(0);
  });

  it('phone path: re-resolve after fence sees a different account → CUSTOMER_BUSY, no attach', async () => {
    const calls = [];
    let n = 0;
    const knex = makeTrx((table, state) => {
      if (table !== 'customers' || state.terminal?.op !== 'first') return null;
      if (!opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))) return null;
      n += 1;
      return n === 1 ? { id: 'cp', account_id: null, phone: '5551234567' } : { id: 'cp', account_id: 'ap-undo', phone: '5551234567' };
    }, calls);
    await expect(findAccountByContact(knex, { ...FENCED, phone: '5551234567' })).rejects.toMatchObject({ code: 'CUSTOMER_BUSY', statusCode: 409 });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  it('email path: re-resolve after fence sees a different winning row → matchChanged, no attach', async () => {
    const calls = [];
    let n = 0;
    const knex = makeTrx((table, state) => {
      if (table !== 'customers') return null;
      if (opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) {
        n += 1;
        return n === 1
          ? [{ id: 'c1', account_id: 'a1', email: 'someone@example.com' }]
          : [{ id: 'c9', account_id: 'a1', email: 'someone@example.com' }];
      }
      return null;
    }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'someone@example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: null, requiresConfirmation: true, matchChanged: true, match: null });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  function emailKnex(rows, calls) {
    return makeTrx((table, state) => {
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
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true });
    expect(out).toMatchObject({ accountId: null, requiresConfirmation: true, ambiguous: true, match: null });
    expect(out.candidates).toEqual([
      { accountId: 'a1', name: '', emailMasked: 's***@example.com' },
      { accountId: 'a2', name: '', emailMasked: 's***@example.com' },
    ]);
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  it('ambiguous: candidates are one per account, trimmed, capped at 5', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, account_id: `a${i}`, email: 'shared@example.com', first_name: `N${i}`, address_line1: 'secret' }));
    rows.push({ id: 'c0b', account_id: 'a0', email: 'shared@example.com' });
    const out = await findAccountByContact(emailKnex(rows, []), { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true });
    expect(out.candidates).toHaveLength(5);
    expect(out.candidates.map((c) => c.accountId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    expect(Object.keys(out.candidates[0]).sort()).toEqual(['accountId', 'emailMasked', 'name']);
  });

  it('ambiguous + confirm id equal to one candidate → attaches to that account', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: 'a1', email: 'shared@example.com', is_primary_profile: true },
      { id: 'c2', account_id: 'a2', email: 'shared@example.com', is_primary_profile: true },
    ], calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true, confirmEmailAccountId: 'a2' });
    expect(out).toMatchObject({ accountId: 'a2', matchType: 'email', existingCustomer: { id: 'c2' } });
  });

  it('shared email across multiple rows of the SAME account → match that account', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: 'a1', email: 'shared@example.com', is_primary_profile: true },
      { id: 'c2', account_id: 'a1', email: 'shared@example.com', is_primary_profile: false },
    ], calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: 'a1', matchType: 'email', existingCustomer: { id: 'c1' } });
  });

  function emailPhoneKnex({ emailRows, phoneRow }, calls) {
    return makeTrx((table, state) => {
      if (table !== 'customers') return null;
      if (opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) return emailRows;
      if (state.terminal?.op === 'first' && opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))) return phoneRow;
      return null;
    }, calls);
  }
  const emailRowA = { id: 'c1', account_id: 'A', email: 'someone@example.com', first_name: 'Fake', last_name: 'Person' };

  it('confirm id A + phone match now on account B → requiresConfirmation (phoneConflict), zero writes', async () => {
    const calls = [];
    const knex = emailPhoneKnex({ emailRows: [emailRowA], phoneRow: { id: 'cB', account_id: 'B', phone: '5551234567' } }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'someone@example.com', matchEmail: true, confirmEmailAccountId: 'A' });
    expect(out).toMatchObject({ accountId: null, requiresConfirmation: true, matchChanged: true, phoneConflict: true, match: null });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
    // Email resolved FIRST on the confirmed path, phone validated after.
    const emailIdx = calls.findIndex((c) => c.op === 'chain');
    const phoneIdx = calls.findIndex((c) => c.op === 'first');
    expect(emailIdx).toBeGreaterThanOrEqual(0);
    expect(phoneIdx).toBeGreaterThan(emailIdx);
  });

  it('confirm id A + phone match on A → attaches to A', async () => {
    const calls = [];
    const knex = emailPhoneKnex({ emailRows: [emailRowA], phoneRow: { id: 'c2', account_id: 'A', phone: '5551234567' } }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'someone@example.com', matchEmail: true, confirmEmailAccountId: 'A' });
    expect(out).toMatchObject({ accountId: 'A', matchType: 'email', existingCustomer: { id: 'c1' } });
  });

  it('confirm id A + no phone match → attaches to A', async () => {
    const calls = [];
    const knex = emailPhoneKnex({ emailRows: [emailRowA], phoneRow: null }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'someone@example.com', matchEmail: true, confirmEmailAccountId: 'A' });
    expect(out).toMatchObject({ accountId: 'A', matchType: 'email' });
  });

  it('no confirm id + phone match on B → phone precedence as before (no email lookup)', async () => {
    const calls = [];
    const knex = emailPhoneKnex({ emailRows: [emailRowA], phoneRow: { id: 'cB', account_id: 'B', phone: '5551234567' } }, calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'someone@example.com', matchEmail: true });
    expect(out).toMatchObject({ accountId: 'B', matchType: 'phone' });
    expect(calls.filter((c) => c.op === 'chain')).toHaveLength(0);
  });

  it('confirm id supplied but email now unmatched → requiresConfirmation (matchChanged), never null', async () => {
    const calls = [];
    const out = await findAccountByContact(emailKnex([], calls), { ...FENCED, phone: '', email: 'gone@example.com', matchEmail: true, confirmEmailAccountId: 'a1' });
    expect(out).toMatchObject({ accountId: null, requiresConfirmation: true, matchChanged: true, match: null });
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert')).toHaveLength(0);
  });

  it('confirm id supplied but email now spans multiple accounts → requiresConfirmation, never null', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: 'a1', email: 'shared@example.com' },
      { id: 'c2', account_id: 'a2', email: 'shared@example.com' },
    ], calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true, confirmEmailAccountId: 'zz-not-a-candidate' });
    expect(out).toMatchObject({ accountId: null, requiresConfirmation: true, matchChanged: true, match: null });
  });

  it('unlinked legacy row (no account_id) alongside a linked row of another account → no match', async () => {
    const calls = [];
    const knex = emailKnex([
      { id: 'c1', account_id: null, email: 'shared@example.com' },
      { id: 'c2', account_id: 'a2', email: 'shared@example.com' },
    ], calls);
    const out = await findAccountByContact(knex, { ...FENCED, phone: '', email: 'shared@example.com', matchEmail: true });
    expect(out).toMatchObject({ requiresConfirmation: true, ambiguous: true });
    expect(out.candidates.map((c) => c.accountId)).toEqual(['c1', 'a2']);
  });

  it('forceNewAccount: skips email matching; phone match → phoneMatch confirmation; ignorePhoneMatch → null (create)', async () => {
    const calls = [];
    const knex = makeTrx((table, state) => {
      if (table !== 'customers') return null;
      if (opsOf(state, 'whereRaw').some((o) => /LOWER\(TRIM/.test(o.args[0]))) return [{ id: 'ce', account_id: 'ae', email: 'x@example.com' }];
      if (state.terminal?.op === 'first' && opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))) return { id: 'cp', account_id: 'ap', first_name: 'Fake', last_name: 'Person', phone: '+1 555 123 4567' };
      return null;
    }, calls);
    const blocked = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'x@example.com', matchEmail: true, forceNewAccount: true });
    expect(blocked).toMatchObject({ accountId: null, requiresConfirmation: true, phoneMatch: true, match: { accountId: 'ap', name: 'Fake Person', phoneMasked: '***-***-4567' } });
    expect(blocked.match).not.toHaveProperty('customerId');
    const created = await findAccountByContact(knex, { ...FENCED, phone: '5551234567', email: 'x@example.com', matchEmail: true, forceNewAccount: true, ignorePhoneMatch: true });
    expect(created).toBeNull();
    expect(calls.filter((c) => c.op === 'chain')).toHaveLength(0);
    expect(calls.filter((c) => c.op === 'update' || c.op === 'insert' || c.op === 'raw')).toHaveLength(0);
  });

  it('fenceAttach false (default): phone match attaches as before — no try-lock, no re-resolve', async () => {
    const calls = [];
    const knex = makeKnex((table, state) => {
      if (table !== 'customers' || state.terminal?.op !== 'first') return null;
      return opsOf(state, 'whereRaw').some((o) => /regexp_replace/.test(o.args[0]))
        ? { id: 'cp', account_id: null, phone: '5551234567' }
        : null;
    }, calls);
    const out = await findAccountByContact(knex, { phone: '5551234567' });
    expect(out).toMatchObject({ accountId: 'cp', matchType: 'phone' });
    expect(calls.filter((c) => c.op === 'raw')).toHaveLength(0);
    expect(calls.filter((c) => c.table === 'customers' && c.op === 'first')).toHaveLength(1);
    expect(calls.some((c) => c.table === 'customers' && c.op === 'update')).toBe(true);
  });

  it('fenceAttach true with a root (non-transaction) knex → throws before any read or write', async () => {
    const calls = [];
    const knex = makeKnex(() => ({ id: 'cp', account_id: null }), calls);
    await expect(findAccountByContact(knex, { phone: '5551234567', fenceAttach: true })).rejects.toThrow(/requires a knex transaction/);
    expect(calls).toHaveLength(0);
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
