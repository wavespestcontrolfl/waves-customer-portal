/**
 * PUT /admin/triage/:id/resolve, /dismiss, and POST /admin/triage/:id/verdict
 * for a reschedule_link_promise card (codex #4293 P1 r4).
 *
 * Before this fix, a triage action on this card closed only the triage_items
 * row: the linked call_commitments promise stayed 'open' and its
 * outbox_messages row stayed parked in 'review' forever, invisible — nothing
 * in the pipeline ever recreates a card for a row whose status and
 * last_error never change. These tests drive the real route handlers
 * (transitionCore + the /verdict guard) against an in-memory fake db and
 * assert the commitment and outbox row land in a consistent terminal state
 * alongside the card, and that a call-level verdict on some OTHER card never
 * silently sweeps this one up.
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

// A small, generic in-memory table simulator — enough knex-shaped surface
// (where/whereIn/whereNotIn/whereNull/forUpdate/first/pluck/select/count/
// update/insert) for transitionCore, settleParkedPromiseCard, and the real
// call-commitments.applyHumanUpdate to run against real rows and mutate
// them in place, without a live Postgres connection.
function makeFakeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const ensure = (name) => tables[name] || (tables[name] = []);

  function builder(tableName) {
    const rows = ensure(tableName);
    const eq = {};
    const whereInClauses = [];
    const whereNotInClauses = [];
    const orPredicates = [];
    const applyEq = (a, b) => { if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b; };
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
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
      // A second arg is knex's RETURNING column list (Postgres): the real
      // admin-triage /verdict bulk update relies on the returned rows (not
      // merely a count) to know WHICH reason_codes it actually closed.
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

// admin-triage.js calls `db.transaction(...)` and `db.schema.hasTable(...)`
// directly on the imported db mock (a jest.fn), not on whatever it RETURNS
// when called as db(table) — mockImplementation alone only wires the latter.
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
const COMMITMENT_ID = 'commitment-1';
const OUTBOX_ID = 'outbox-1';

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: 'reschedule_link_promise', status: 'open',
      category: 'customer_followup', severity: 'advisory',
      payload: { reschedule_link_promise: { commitment_id: COMMITMENT_ID, commitment_ids: [COMMITMENT_ID], reason: 'promise_needs_review' } },
    }],
    call_log: [{ id: CALL_ID, review_status: 'open' }],
    call_commitments: [{
      id: COMMITMENT_ID, call_log_id: CALL_ID, kind: 'send_reschedule_link', party: 'waves',
      status: 'open', human_state: null, evidence: '[]', subject: null, fulfillment: null,
    }],
    outbox_messages: [{
      id: OUTBOX_ID, commitment_id: COMMITMENT_ID, related_call_log_id: CALL_ID, status: 'review', last_error: 'promise_needs_review',
    }],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('PUT /admin/triage/:id/resolve on a reschedule_link_promise card', () => {
  test('settles the commitment as fulfilled and cancels the outbox row, atomically with the card', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Called the customer directly.' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    expect(tables.call_commitments[0]).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    expect(tables.outbox_messages[0]).toMatchObject({ status: 'cancelled', last_error: 'resolved_by_office' });
    expect(tables.call_log[0].review_status).toBe('resolved');
  });
});

describe('PUT /admin/triage/:id/dismiss on a reschedule_link_promise card', () => {
  test('settles the commitment as dismissed and cancels the outbox row', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/dismiss`, {});
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('dismissed');
    expect(tables.call_commitments[0]).toMatchObject({ status: 'dismissed', human_state: 'dismissed' });
    expect(tables.outbox_messages[0]).toMatchObject({ status: 'cancelled', last_error: 'dismissed_by_office' });
  });

  test('a commitment already fulfilled by a genuine delivery in the interim is left exactly as delivery left it', async () => {
    // The card can still name a commitment that settled through the normal
    // send pipeline moments before the office clicked Dismiss — a race the
    // settle step must not clobber.
    const { conn, tables } = fixture({
      call_commitments: [{
        id: COMMITMENT_ID, call_log_id: CALL_ID, kind: 'send_reschedule_link', party: 'waves',
        status: 'fulfilled', human_state: 'confirmed', fulfillment: { kind: 'reschedule_link_delivered' }, evidence: '[]', subject: null,
      }],
      outbox_messages: [{ id: OUTBOX_ID, commitment_id: COMMITMENT_ID, related_call_log_id: CALL_ID, status: 'delivered', last_error: null }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/dismiss`, {});
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('dismissed');
    // Untouched — still the genuine delivery record, not overwritten to 'dismissed'.
    expect(tables.call_commitments[0]).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    expect(tables.outbox_messages[0]).toMatchObject({ status: 'delivered' });
  });
});

describe('POST /admin/triage/:id/verdict', () => {
  test('rejects a direct call verdict on a reschedule_link_promise card', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not a call verdict/);
    });
    // Nothing moved — the card, commitment, and outbox row are all untouched.
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.call_commitments[0].status).toBe('open');
    expect(tables.outbox_messages[0].status).toBe('review');
  });

  test('a call-level verdict on a DIFFERENT card for the same call leaves the promise card open — again-visible, not silently swept up', async () => {
    const otherCardId = 'card-2';
    const { conn, tables } = fixture({
      triage_items: [
        { id: CARD_ID, call_log_id: CALL_ID, reason_code: 'reschedule_link_promise', status: 'open', category: 'customer_followup', severity: 'advisory',
          payload: { reschedule_link_promise: { commitment_id: COMMITMENT_ID, commitment_ids: [COMMITMENT_ID], reason: 'promise_needs_review' } } },
        { id: otherCardId, call_log_id: CALL_ID, reason_code: 'address_unverified', status: 'open', category: 'address', severity: 'blocking' },
      ],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${otherCardId}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(200);
    });
    // The OTHER card resolved through the call-level verdict...
    expect(tables.triage_items.find((c) => c.id === otherCardId).status).toBe('resolved');
    // ...but the promise card, its commitment, and its outbox row are
    // completely untouched — the bulk cascade excluded it by design.
    expect(tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('open');
    expect(tables.call_commitments[0].status).toBe('open');
    expect(tables.outbox_messages[0].status).toBe('review');
  });
});
