/**
 * PUT /admin/triage/:id/resolve on a callback_number_needed card (codex
 * round-2 finding #2, PR #4807).
 *
 * Resolving this card is the office's word that a usable callback number is
 * now confirmed — it must lift the callback_number_needed SMS hold
 * (scheduled_services.callback_number_hold_at) on every LIVE visit the call
 * created, in the SAME transaction as the resolve. Dismissing the card must
 * NOT clear anything: "leave the note" is not a verified number.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
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

// Same minimal knex-shaped in-memory simulator as
// admin-triage-reschedule-promise.test.js, extended with whereNotNull.
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const notNullCols = [];
    const whereInClauses = [];
    const whereNotInClauses = [];
    const orPredicates = [];
    const applyEq = (a, b) => { if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b; };
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && notNullCols.every((col) => row[col] != null)
      && whereInClauses.every(({ col, vals }) => vals.includes(row[col]))
      && whereNotInClauses.every(({ col, vals }) => !vals.includes(row[col]))
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
      whereNull(col) { eq[col] = null; return api; },
      whereNotNull(col) { notNullCols.push(col); return api; },
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
  conn.schema = { hasTable: async () => false };
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

const CALL_ID = 'call-1';
const CARD_ID = 'card-1';
const HELD_VISIT_ID = 'svc-held';
const OTHER_CALL_VISIT_ID = 'svc-other-call';
const CANCELLED_VISIT_ID = 'svc-cancelled';

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: 'callback_number_needed', status: 'open',
      updated_at: '2030-01-07T12:00:00.000Z', category: 'customer_followup', severity: 'advisory', payload: {},
    }],
    call_log: [{ id: CALL_ID, review_status: 'open' }],
    scheduled_services: [
      // The visit this call created — held, live.
      { id: HELD_VISIT_ID, source_call_log_id: CALL_ID, status: 'confirmed', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // A visit created by a DIFFERENT call — never touched by this resolve.
      { id: OTHER_CALL_VISIT_ID, source_call_log_id: 'call-other', status: 'confirmed', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // Same call, but cancelled — not live, must not be touched.
      { id: CANCELLED_VISIT_ID, source_call_log_id: CALL_ID, status: 'cancelled', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
    ],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('PUT /admin/triage/:id/resolve on a callback_number_needed card', () => {
  test('lifts the hold on every LIVE visit this call created, and no other', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed her cell — texts should go there now.' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
    // A different call's held visit is untouched.
    const other = tables.scheduled_services.find((s) => s.id === OTHER_CALL_VISIT_ID);
    expect(other.call_sms_cleared_at).toBeNull();
    // A cancelled (non-live) visit from the SAME call is untouched.
    const cancelled = tables.scheduled_services.find((s) => s.id === CANCELLED_VISIT_ID);
    expect(cancelled.call_sms_cleared_at).toBeNull();
  });

  test('a card with no held visit is a no-op on scheduled_services (nothing to clear)', async () => {
    const { conn, tables } = fixture({
      scheduled_services: [
        { id: 'svc-never-held', source_call_log_id: CALL_ID, status: 'confirmed', callback_number_hold_at: null, call_sms_cleared_at: null },
      ],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`);
      expect(res.status).toBe(200);
    });
    expect(tables.scheduled_services[0].call_sms_cleared_at).toBeNull();
  });
});

describe('PUT /admin/triage/:id/dismiss on a callback_number_needed card', () => {
  test('never clears the hold — "leave the note" is not a verified number', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/dismiss`, { note: 'Left a note for the tech; number unconfirmed.' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('dismissed');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toBeNull();
  });
});
