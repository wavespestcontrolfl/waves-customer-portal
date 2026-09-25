/**
 * Codex round-2 P1 on the V1/V2 email-disagreement hold (PR #4802): a card
 * carrying `email_disagreement` evidence has NO single confirmed address —
 * the hold's held_email is blank on purpose. Resolving that card as-is
 * (PUT /:id/resolve, or an Accept call verdict) previously closed the card
 * and called resumeHeldFirstTouch with nothing to release: the customer
 * stayed email-less, the blank hold can't send and the ledger sweep
 * excludes it (`.whereNot('held_email', '')`), and the terminal card left
 * no future trigger to fix it.
 *
 * Drives the REAL admin-triage route handlers (transitionCore's /resolve,
 * and /verdict's accept path) against an in-memory fake db, following the
 * same harness as admin-triage-reschedule-promise.test.js. Fixtures use
 * synthetic example.com addresses, never a real customer's.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/triage-locks', () => ({ lockTriageCall: jest.fn(async () => {}) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'tech-1', role: 'admin' };
    req.technicianId = 'tech-1';
    req.techRole = 'admin';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const triageRouter = require('../routes/admin-triage');

// Same generic in-memory table simulator as admin-triage-reschedule-promise.test.js.
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const whereInClauses = [];
    const whereNotInClauses = [];
    const rawPredicates = [];
    const orPredicates = [];
    const applyEq = (a, b) => { if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b; };
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && whereInClauses.every(({ col, vals }) => vals.includes(row[col]))
      && whereNotInClauses.every(({ col, vals }) => !vals.includes(row[col]))
      && rawPredicates.every((fn) => fn(row))
      && (orPredicates.length === 0 || orPredicates.some((fn) => fn(row)));
    const filtered = () => rows.filter(matches);
    const api = {
      where(a, b) {
        if (typeof a === 'function') {
          a({
            whereNull: (col) => { orPredicates.push((row) => row[col] == null); return api; },
            orWhere: (col, val) => { orPredicates.push((row) => row[col] === val); return api; },
          });
        } else applyEq(a, b);
        return api;
      },
      whereIn(col, vals) { whereInClauses.push({ col, vals }); return api; },
      whereNotIn(col, vals) { whereNotInClauses.push({ col, vals }); return api; },
      whereRaw(sql) {
        if (sql !== "payload->'reschedule_proposal' IS NULL") throw new Error(`Unsupported test query: ${sql}`);
        rawPredicates.push((row) => row.payload?.reschedule_proposal == null);
        return api;
      },
      whereNull(col) { eq[col] = null; return api; },
      forUpdate() { return api; },
      forShare() { return api; },
      orderBy() { return api; },
      limit() { return api; },
      join() { return api; },
      leftJoin() { return api; },
      modify(fn) { fn(api); return api; },
      first: async () => filtered()[0] || null,
      pluck: async (col) => filtered().map((r) => r[col]),
      select: async () => filtered(),
      count: () => ({ first: async () => ({ n: filtered().length }) }),
      update: async (patch, returning) => {
        const found = filtered();
        for (const row of found) Object.assign(row, patch);
        if (returning) return found.map((row) => Object.fromEntries(returning.map((col) => [col, row[col]])));
        return found.length;
      },
      insert(data) {
        const row = { ...data };
        rows.push(row);
        return {
          then: (resolve) => resolve([row]),
          onConflict: () => ({ ignore: async () => 1, merge: async () => 1 }),
          returning: async () => [row],
        };
      },
    };
    return api;
  }
  const conn = (table) => builder(String(table).split(' ')[0]);
  conn.transaction = async (fn) => fn(conn);
  conn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  conn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return { conn, tables };
}

function wireDb(dbMock, { conn }) {
  dbMock.mockImplementation(conn);
  dbMock.transaction = conn.transaction;
  dbMock.schema = conn.schema;
  dbMock.raw = conn.raw;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/triage', triageRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function put(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function post(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const CALL_ID = 'call-1';
const CARD_ID = 'card-1';
const CUSTOMER_ID = 'cust-1';
const DISAGREEMENT_PAYLOAD = {
  flag: 'email_unverified',
  email_candidates: [{ value: 'janedoee@example.com' }, { value: 'janedoe@example.com' }],
  email_disagreement: { v1: 'janedoee@example.com', v2: 'janedoe@example.com' },
};

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
      category: 'lead_intake', severity: 'advisory', payload: DISAGREEMENT_PAYLOAD,
    }],
    call_log: [{ id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID }],
    customers: [{ id: CUSTOMER_ID, email: null }],
    first_touch_holds: [{ id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending', held_email: '' }],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('PUT /admin/triage/:id/resolve on a card carrying email_disagreement', () => {
  test('refuses when neither the hold nor the customer has a confirmed address', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Read back on the phone.' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    // The card stays open — a work item survives for the operator to fix.
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('resolves once the hold has been retargeted to a confirmed address (the correction fanout already did this)', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed via correction.' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  test('resolves once the customer record itself has a confirmed email (e.g. edited directly)', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, email: 'janedoe@example.com' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, {});
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  test('a plain email_unverified card with no disagreement evidence is unaffected — resolves as before', async () => {
    const { conn, tables } = fixture({
      triage_items: [{
        id: CARD_ID, call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
        category: 'lead_intake', severity: 'advisory',
        payload: { flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }] },
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, {});
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });
});

describe('POST /admin/triage/:id/verdict accept on a card carrying email_disagreement', () => {
  test('refuses when neither the hold nor the customer has a confirmed address', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('an Accept succeeds once the hold has a confirmed target', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });
});
