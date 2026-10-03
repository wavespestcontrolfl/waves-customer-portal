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
jest.mock('../services/call-recording-processor', () => ({ processRecording: jest.fn(async () => ({ success: true })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'tech-1', role: 'admin' };
    req.technicianId = 'tech-1';
    req.techRole = req.headers['x-test-role'] || 'admin';
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
        // The street-level address-hold exclusion: none of these fixtures holds one.
        if (sql.includes('street_level_address')) return api;
        // ACTIVE_CLAIM_SQL: a pass holds the claim and it has not gone quiet long enough to be reclaimed
        // (fixtures mark a crashed pass with claim_stale; the real predicate is proven on Postgres).
        if (sql.includes("processing_status = 'processing'")) {
          rawPredicates.push((row) => row.processing_status === 'processing' && !!row.processing_token && !row.claim_stale);
          return api;
        }
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
  conn.raw = (sql, bindings) => {
    // The first-name fulfilment query (utils/missing-first-name-card): each listed id is
    // named when its row is live with a nonblank first name (no merge journal in this fake).
    if (String(sql).includes('customer_merge_journal') && String(sql).includes('as named')) {
      const ids = bindings?.[0] || [];
      return { rows: ids.map((id) => {
        const row = (tables.customers || []).find((c) => String(c.id) === String(id));
        return { id, named: !!row && row.deleted_at == null && String(row.first_name || '').trim() !== '' };
      }) };
    }
    return { __raw: sql, bindings };
  };
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

function put(baseUrl, path, body = {}, headers = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}
function post(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const CALL_ID = 'call-1';
const CARD_ID = 'card-1';
const CARD_VERSION = '2030-01-07T12:00:00.000Z';
const NEW_CARD_VERSION = '2030-01-07T12:01:00.000Z';
const COMMITMENT_ID = 'commitment-1';
const OUTBOX_ID = 'outbox-1';

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: 'reschedule_link_promise', status: 'open',
      updated_at: CARD_VERSION,
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
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Called the customer directly.', expected_updated_at: CARD_VERSION });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    expect(tables.call_commitments[0]).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    expect(tables.outbox_messages[0]).toMatchObject({ status: 'cancelled', last_error: 'resolved_by_office' });
    expect(tables.call_log[0].review_status).toBe('resolved');
  });
});

describe('a promise parks between the pre-lock read and the lock (codex #4293 P1)', () => {
  test('the stale action is refused and a refreshed action settles both commitments', async () => {
    // Two commitments and their outbox rows are seeded as already parked
    // against the same call, but the CARD only names the first one — the
    // second's append is what a concurrent parkReview would have done in
    // the gap between transitionCore's initial (pre-lock) read of `item`
    // and this call actually acquiring lockTriageCall. lockTriageCall is
    // mocked below to perform that exact append the moment the route
    // reaches the lock, simulating the interleaving without needing real
    // Postgres concurrency.
    const COMMITMENT_ID_2 = 'commitment-2';
    const OUTBOX_ID_2 = 'outbox-2';
    const { conn, tables } = fixture({
      call_commitments: [
        { id: COMMITMENT_ID, call_log_id: CALL_ID, kind: 'send_reschedule_link', party: 'waves',
          status: 'open', human_state: null, evidence: '[]', subject: null, fulfillment: null },
        { id: COMMITMENT_ID_2, call_log_id: CALL_ID, kind: 'send_reschedule_link', party: 'waves',
          status: 'open', human_state: null, evidence: '[]', subject: null, fulfillment: null },
      ],
      outbox_messages: [
        { id: OUTBOX_ID, commitment_id: COMMITMENT_ID, related_call_log_id: CALL_ID, status: 'review', last_error: 'promise_needs_review' },
        { id: OUTBOX_ID_2, commitment_id: COMMITMENT_ID_2, related_call_log_id: CALL_ID, status: 'review', last_error: 'promise_needs_review' },
      ],
    });
    wireDb(db, { conn });
    const { lockTriageCall } = require('../utils/triage-locks');
    lockTriageCall.mockImplementationOnce(async () => {
      // Splice in a NEW object rather than mutating the existing row
      // in place — `item` (captured by the route BEFORE this lock call)
      // is a reference to the OLD object, exactly like a real pre-lock
      // knex read is a snapshot unaffected by a later writer's commit; a
      // same-object mutation here would let `item.payload` see the append
      // "for free" and defeat the very race this test exists to catch.
      const idx = tables.triage_items.findIndex((c) => c.id === CARD_ID);
      const card = tables.triage_items[idx];
      const parked = card.payload.reschedule_link_promise.commitment_ids;
      tables.triage_items[idx] = { ...card, updated_at: NEW_CARD_VERSION, payload: { ...card.payload,
        reschedule_link_promise: { ...card.payload.reschedule_link_promise, commitment_ids: [...parked, COMMITMENT_ID_2] } } };
    });
    await withServer(async (baseUrl) => {
      const stale = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Called the customer directly.', expected_updated_at: CARD_VERSION });
      expect(stale.status).toBe(409);
      expect(tables.triage_items[0].status).toBe('open');
      expect(tables.call_commitments.map((c) => c.status)).toEqual(['open', 'open']);
      expect(tables.outbox_messages.map((o) => o.status)).toEqual(['review', 'review']);
      const refreshed = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Called the customer directly.', expected_updated_at: NEW_CARD_VERSION });
      expect(refreshed.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    // Both commitments settle — not only the one the route's stale pre-lock
    // snapshot knew about.
    expect(tables.call_commitments.find((c) => c.id === COMMITMENT_ID)).toMatchObject({ status: 'fulfilled' });
    expect(tables.call_commitments.find((c) => c.id === COMMITMENT_ID_2)).toMatchObject({ status: 'fulfilled' });
    expect(tables.outbox_messages.find((o) => o.id === OUTBOX_ID)).toMatchObject({ status: 'cancelled' });
    expect(tables.outbox_messages.find((o) => o.id === OUTBOX_ID_2)).toMatchObject({ status: 'cancelled' });
  });
});

describe('PUT /admin/triage/:id/dismiss on a reschedule_link_promise card', () => {
  test('settles the commitment as dismissed and cancels the outbox row', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION });
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
      const res = await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('dismissed');
    // Untouched — still the genuine delivery record, not overwritten to 'dismissed'.
    expect(tables.call_commitments[0]).toMatchObject({ status: 'fulfilled', human_state: 'confirmed' });
    expect(tables.outbox_messages[0]).toMatchObject({ status: 'delivered' });
  });
});

test.each(['resolve', 'dismiss'])('%s requires the card version and leaves the promise parked on a stale action', async (action) => {
  const { conn, tables } = fixture();
  wireDb(db, { conn });
  await withServer(async (baseUrl) => {
    for (const expected_updated_at of [undefined, '2030-01-07T11:59:00.000Z']) {
      const res = await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at });
      expect(res.status).toBe(409);
    }
  });
  expect(tables.triage_items[0].status).toBe('open');
  expect(tables.call_commitments[0].status).toBe('open');
  expect(tables.outbox_messages[0].status).toBe('review');
});

describe('PUT /admin/triage/:id/resolve on a missing_first_name card', () => {
  const seed = () => {
    const f = fixture({ customers: [{ id: '33333333-3333-4333-8333-333333333333', first_name: 'Sam', deleted_at: null }] });
    f.tables.triage_items[0].reason_code = 'missing_first_name';
    f.tables.triage_items[0].payload = { customer_ids: ['33333333-3333-4333-8333-333333333333'], heard_name_v1: { first_name: null, last_name: 'Murphy' } };
    return f;
  };
  test('a non-admin Resolve is refused (403) and the card stays open; Dismiss stays available', async () => {
    const { conn, tables } = seed();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION }, { 'x-test-role': 'technician' });
      expect(res.status).toBe(403);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });
  test('Resolve is refused (409, plain message) until EVERY listed customer is live with a nonblank first name; Dismiss stays the waiver', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const f = fixture({ customers: [{ id: A, first_name: 'Sam', deleted_at: null }, { id: B, first_name: '', deleted_at: null }] });
    f.tables.triage_items[0].reason_code = 'missing_first_name';
    f.tables.triage_items[0].payload = { customer_ids: [A, B] };
    wireDb(db, { conn: f.conn });
    await withServer(async (baseUrl) => {
      let res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('Enter the first name on the customer record first');
      expect(f.tables.triage_items[0].status).toBe('open');
      // B gets a name -> allowed
      f.tables.customers[1].first_name = 'Lee';
      res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION });
      expect(res.status).toBe(200);
    });
    expect(f.tables.triage_items[0].status).toBe('resolved');
  });
  test('a list that grew after the operator loaded the card (version moved) refuses BOTH Resolve and Dismiss; the check runs on the live payload', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const f = fixture({ customers: [{ id: A, first_name: 'Sam', deleted_at: null }, { id: B, first_name: '', deleted_at: null }] });
    f.tables.triage_items[0].reason_code = 'missing_first_name';
    f.tables.triage_items[0].payload = { customer_ids: [A] };
    wireDb(db, { conn: f.conn });
    await withServer(async (baseUrl) => {
      // reprocess appends B (bumping updated_at) after the operator loaded the card showing only A
      f.tables.triage_items[0].payload = { customer_ids: [A, B] };
      f.tables.triage_items[0].updated_at = '2030-01-07T12:05:00.000Z';
      for (const action of ['resolve', 'dismiss']) {
        const res = await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at: CARD_VERSION });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('STALE_CARD_VERSION');
      }
      // a request without any version is refused too
      expect((await put(baseUrl, `/${CARD_ID}/dismiss`, {})).status).toBe(409);
    });
    expect(f.tables.triage_items[0].status).toBe('open');
  });
  test('a deleted or missing listed customer blocks Resolve; Dismiss still works', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const f = fixture({ customers: [{ id: A, first_name: 'Sam', deleted_at: '2026-10-01T00:00:00Z' }] });
    f.tables.triage_items[0].reason_code = 'missing_first_name';
    f.tables.triage_items[0].payload = { customer_id: A }; // pre-list scalar shape
    wireDb(db, { conn: f.conn });
    await withServer(async (baseUrl) => {
      expect((await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION })).status).toBe(409);
      expect((await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
    });
    expect(f.tables.triage_items[0].status).toBe('dismissed');
  });
  test('an admin Resolve closes it', async () => {
    const { conn, tables } = seed();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });
});

describe('POST /admin/triage/:id/verdict', () => {
  test('rejects a direct call verdict on a missing_first_name card (an owed capture)', async () => {
    const { conn, tables } = fixture();
    tables.triage_items[0].reason_code = 'missing_first_name';
    tables.triage_items[0].payload = { heard_name_v1: { first_name: null, last_name: 'Murphy' } };
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not a call verdict/);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

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

describe('a household_address_match card (GATE_CALL_HOUSEHOLD_HOLD) is an operational card, not a call verdict', () => {
  const SUGGESTED = '44444444-4444-4444-8444-444444444444';
  const seed = (extra = {}) => {
    const f = fixture(extra);
    f.tables.triage_items[0].reason_code = 'household_address_match';
    f.tables.triage_items[0].category = 'customer_field_conflict';
    f.tables.triage_items[0].severity = 'blocking';
    f.tables.triage_items[0].payload = { suggested_customer_id: SUGGESTED, heard_name_v1: { first_name: 'Sample', last_name: 'Caller' }, caller_phone: '+19415550123', address: '100 Example Loop, Sarasota, 34240' };
    return f;
  };

  test('/verdict is refused (400, plain message) and nothing closes', async () => {
    const { conn, tables } = seed();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      for (const verdict of ['accept', 'deny']) {
        const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/not a call verdict/);
      }
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('Resolve AND Dismiss are refused (409, plain message) while a pass is working the call, atomically under the per-call lock; fine once it finishes, and a crashed (stale) claim never blocks', async () => {
    const f = seed();
    f.tables.call_log[0].processing_status = 'processing';
    f.tables.call_log[0].processing_token = 'tok-live';
    wireDb(db, { conn: f.conn });
    const { lockTriageCall } = require('../utils/triage-locks');
    await withServer(async (baseUrl) => {
      for (const action of ['resolve', 'dismiss']) {
        lockTriageCall.mockClear();
        const res = await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at: CARD_VERSION });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('CALL_STILL_PROCESSING');
        expect(body.error).toBe('This call is still being processed. Try again in a moment.');
        expect(lockTriageCall).toHaveBeenCalledTimes(1); // judged under the lock the filer takes
        expect(f.tables.triage_items[0].status).toBe('open');
      }
      // a crashed pass stops beating: the claim is reclaimable, so it no longer blocks — and its token is
      // REVOKED in the same transaction, so a stalled worker that resumes fails its fence and abandons
      f.tables.call_log[0].claim_stale = true;
      expect((await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
      expect(f.tables.call_log[0].processing_token).toBeNull();
    });
    expect(f.tables.triage_items[0].status).toBe('dismissed');
    // a finished pass
    const g = seed();
    wireDb(db, { conn: g.conn });
    g.tables.call_log[0].processing_status = 'processed';
    await withServer(async (baseUrl) => {
      expect((await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
    });
    expect(g.tables.triage_items[0].status).toBe('resolved');
  });

  describe('Dismiss means "really someone new": the call is reprocessed after the dismissal commits (Resolve starts nothing)', () => {
    const processor = () => require('../services/call-recording-processor');
    const settle = async (cond) => { for (let i = 0; i < 40 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5)); };
    const idle = () => new Promise((r) => setTimeout(r, 40)); // lets a (wrongly) started background pass show itself
    const seedCall = (f, over = {}) => { Object.assign(f.tables.call_log[0], { twilio_call_sid: 'CAhousehold1', customer_id: null, ...over }); return f; };
    beforeEach(() => processor().processRecording.mockReset().mockResolvedValue({ success: true }));

    test('Dismiss answers at once, then force-reprocesses the call through the existing entry point; the card stays dismissed; a double Dismiss starts nothing more', async () => {
      const f = seedCall(seed());
      wireDb(db, { conn: f.conn });
      let release; const gate = new Promise((r) => { release = r; });
      processor().processRecording.mockImplementation(async () => { await gate; return { success: true }; });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION }); // returns while the pass is still pending
        expect(res.status).toBe(200);
        await settle(() => processor().processRecording.mock.calls.length > 0);
        expect(processor().processRecording).toHaveBeenCalledWith('CAhousehold1', { force: true, operator: true });
        // the card is committed dismissed BEFORE the pass starts (the waiver the processor reads)
        expect(f.tables.triage_items[0].status).toBe('dismissed');
        const again = await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION });
        expect(again.status).toBe(409);
        release();
      });
      await idle();
      expect(processor().processRecording).toHaveBeenCalledTimes(1);
      expect(f.tables.triage_items.filter((c) => c.reason_code === 'auto_booking_skipped_after_approval')).toHaveLength(0);
    });

    test('Resolve ("handled on the existing customer") starts nothing', async () => {
      const f = seedCall(seed());
      wireDb(db, { conn: f.conn });
      await withServer(async (baseUrl) => {
        expect((await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
      });
      await idle();
      expect(processor().processRecording).not.toHaveBeenCalled();
    });

    test.each([
      ['the pass is already running', async () => ({ success: false, skipped: true, reason: 'already_processing' })],
      ['the pass lost its claim', async () => ({ success: false, skipped: true, reason: 'terminal_write_ownership_lost' })],
      ['the pass throws', async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); }],
    ])('when %s the office still gets an actionable task (skipped-booking card, household_hold_dismissed)', async (_label, impl) => {
      const f = seedCall(seed());
      f.tables.triage_items[0].payload = { ...f.tables.triage_items[0].payload, preferred_date_time: 'Tuesday at 10 AM', service: 'Pest Control' };
      wireDb(db, { conn: f.conn });
      processor().processRecording.mockImplementation(impl);
      await withServer(async (baseUrl) => {
        expect((await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
      });
      await settle(() => f.tables.triage_items.length > 1);
      const task = f.tables.triage_items.find((c) => c.reason_code === 'auto_booking_skipped_after_approval');
      expect(task).toBeTruthy();
      expect(JSON.parse(task.payload)).toMatchObject({ skipped_reason: 'household_hold_dismissed', preferred_date_time: 'Tuesday at 10 AM', service: 'Pest Control' });
      expect(f.tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('dismissed');
      expect(f.tables.call_log[0].review_status).toBe('open');
    });

    test('a call the office linked to a customer meanwhile is left alone', async () => {
      const f = seedCall(seed(), { customer_id: '77777777-7777-4777-8777-777777777777' });
      wireDb(db, { conn: f.conn });
      await withServer(async (baseUrl) => {
        expect((await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
      });
      await idle();
      expect(processor().processRecording).not.toHaveBeenCalled();
      expect(f.tables.triage_items).toHaveLength(1);
    });
  });

  test('a technician cannot reach the card through /verdict either (403), and an admin gets the plain 400', async () => {
    const { conn, tables } = seed();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/triage/${CARD_ID}/verdict`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': 'technician' }, body: JSON.stringify({ verdict: 'accept' }),
      });
      expect(res.status).toBe(403);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('a call-level verdict on a DIFFERENT card of the same call never sweeps the hold card up', async () => {
    const other = 'card-2';
    const f = seed();
    f.tables.triage_items.push({ id: other, call_log_id: CALL_ID, reason_code: 'address_unverified', status: 'open', category: 'address', severity: 'blocking' });
    wireDb(db, { conn: f.conn });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, `/${other}/verdict`, { verdict: 'accept' })).status).toBe(200);
    });
    expect(f.tables.triage_items.find((c) => c.id === other).status).toBe('resolved');
    expect(f.tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('open');
  });

  test('a non-admin Resolve AND Dismiss are refused (403) and the card stays open', async () => {
    const { conn, tables } = seed();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      for (const action of ['resolve', 'dismiss']) {
        const res = await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at: CARD_VERSION }, { 'x-test-role': 'technician' });
        expect(res.status).toBe(403);
      }
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('an admin can Resolve it, or Dismiss it', async () => {
    for (const [action, status] of [['resolve', 'resolved'], ['dismiss', 'dismissed']]) {
      const { conn, tables } = seed();
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        expect((await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at: CARD_VERSION })).status).toBe(200);
      });
      expect(tables.triage_items[0].status).toBe(status);
    }
  });

  test('Resolve AND Dismiss are version-bound: a card refreshed (match moved) after the operator loaded it refuses with the stale outcome, and so does a request with no version', async () => {
    const f = seed();
    wireDb(db, { conn: f.conn });
    await withServer(async (baseUrl) => {
      f.tables.triage_items[0].payload = { ...f.tables.triage_items[0].payload, suggested_customer_id: '55555555-5555-4555-8555-555555555555' };
      f.tables.triage_items[0].updated_at = NEW_CARD_VERSION;
      for (const action of ['resolve', 'dismiss']) {
        const res = await put(baseUrl, `/${CARD_ID}/${action}`, { expected_updated_at: CARD_VERSION });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('STALE_CARD_VERSION');
        expect((await put(baseUrl, `/${CARD_ID}/${action}`, {})).status).toBe(409);
      }
      expect(f.tables.triage_items[0].status).toBe('open');
      expect((await put(baseUrl, `/${CARD_ID}/dismiss`, { expected_updated_at: NEW_CARD_VERSION })).status).toBe(200);
    });
    expect(f.tables.triage_items[0].status).toBe('dismissed');
  });

  test('wiring: the list resolves the suggested customer to its live merge survivor for the Open customer link', () => {
    const src = require('fs').readFileSync(require.resolve('../routes/admin-triage'), 'utf8');
    expect(src).toContain("i.reason_code === 'household_address_match'");
    expect(src).toContain('openTargetsForIds(db, wanted)');
    expect(src).toContain('item.suggested_customer_open_id =');
  });
});
