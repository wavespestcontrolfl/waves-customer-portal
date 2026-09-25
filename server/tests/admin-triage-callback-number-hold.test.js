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
// The /verdict clear check's lazy require of call-recording-processor.js
// (finding #3, round 4) pulls in that file's own huge require graph — a
// one-time Babel transform cost the FIRST test to reach it pays, which can
// exceed Jest's default 5000ms on a cold run. Same fix as the other slow
// first-import suites in this repo (see jest.setTimeout usage elsewhere).
jest.setTimeout(30000);
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
  // Finding #3 (round 4 P1, PR #4807): the /verdict route's callback-number
  // clear check now lazily requires call-recording-processor.js (for its
  // direction-aware resolveCallContactPhone) — that module's own require
  // chain (messaging/send-customer-message -> twilio-sms -> twilio.js)
  // reaches routes/admin-sms-templates.js, which destructures requireAdmin
  // from this same mock at its own require time. Without it here the whole
  // chain throws at require() (undefined route middleware), not inside this
  // test's own code.
  requireAdmin: (_req, _res, next) => next(),
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
    const rawPredicates = [];
    const applyEq = (a, b) => { if (a && typeof a === 'object') Object.assign(eq, a); else eq[a] = b; };
    const matches = (row) => Object.entries(eq).every(([k, v]) => row[k] === v)
      && notNullCols.every((col) => row[col] != null)
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
      // Only the /verdict route's own reschedule-proposal exclusion uses
      // whereRaw against this table (same shape as
      // admin-triage-reschedule-promise.test.js's builder).
      whereRaw(sql) {
        if (sql !== "payload->'reschedule_proposal' IS NULL") throw new Error(`Unsupported test query: ${sql}`);
        rawPredicates.push((row) => row.payload?.reschedule_proposal == null);
        return api;
      },
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

function post(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

const CALL_ID = 'call-1';
const CARD_ID = 'card-1';
const HELD_VISIT_ID = 'svc-held';
const OTHER_CALL_VISIT_ID = 'svc-other-call';
const CANCELLED_VISIT_ID = 'svc-cancelled';
const EN_ROUTE_VISIT_ID = 'svc-en-route';
const RESCHEDULED_VISIT_ID = 'svc-rescheduled';
const CUSTOMER_ID = 'cust-1';
// The number the caller disclaimed (call_log.from_phone) — the /verdict
// route's phone-verification gate (codex round-4 P2) compares the
// customer's on-file phone against this ANI.
const DISCLAIMED_ANI = '9415551234';

function fixture(extra = {}) {
  return makeFakeDb({
    triage_items: [{
      id: CARD_ID, call_log_id: CALL_ID, reason_code: 'callback_number_needed', status: 'open',
      updated_at: '2030-01-07T12:00:00.000Z', category: 'customer_followup', severity: 'advisory', payload: {},
    }],
    // customer phone defaults to the disclaimed ANI itself (the pre-#4807
    // state — no correction on file yet); /verdict tests override this via
    // the `customers` key in `extra`.
    call_log: [{ id: CALL_ID, review_status: 'open', from_phone: DISCLAIMED_ANI, customer_id: CUSTOMER_ID }],
    customers: [{ id: CUSTOMER_ID, phone: DISCLAIMED_ANI }],
    scheduled_services: [
      // The visit this call created — held, live.
      { id: HELD_VISIT_ID, source_call_log_id: CALL_ID, status: 'confirmed', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // A visit created by a DIFFERENT call — never touched by this resolve.
      { id: OTHER_CALL_VISIT_ID, source_call_log_id: 'call-other', status: 'confirmed', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // Same call, but cancelled — not live, must not be touched.
      { id: CANCELLED_VISIT_ID, source_call_log_id: CALL_ID, status: 'cancelled', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // Same call, tech already rolling — codex round-3 P2: this is still a
      // LIVE (nonterminal) visit and must clear along with 'confirmed'.
      { id: EN_ROUTE_VISIT_ID, source_call_log_id: CALL_ID, status: 'en_route', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
      // Same call, rebooked to a new date (status flips to 'rescheduled') —
      // codex round-5 P2: this row can still be a GROUPED SIBLING of the
      // visit the customer was rebooked onto (resolveCallbackNumberHoldRows
      // checks every row sharing visit_id), so it must clear too, or the
      // group-wide hold predicate keeps reading the new row as held even
      // after the office confirms the number here.
      { id: RESCHEDULED_VISIT_ID, source_call_log_id: CALL_ID, status: 'rescheduled', callback_number_hold_at: new Date('2030-01-07T10:00:00Z'), call_sms_cleared_at: null },
    ],
    // Round 6 (structural): the NUMBER-keyed hold this call placed — the
    // row every SMS `to` is actually checked against. Plus a hold a
    // DIFFERENT call placed on another number, which no action on this
    // card may touch.
    disclaimed_number_holds: [
      { id: 'hold-1', phone_e164: '+19415551234', source_call_log_id: CALL_ID, customer_id: CUSTOMER_ID, cleared_at: null },
      { id: 'hold-other', phone_e164: '+19415550000', source_call_log_id: 'call-other', customer_id: 'cust-other', cleared_at: null },
    ],
    ...extra,
  });
}

const numberHold = (tables, id = 'hold-1') => tables.disclaimed_number_holds.find((h) => h.id === id);

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

  test('round 6: resolving lifts the NUMBER hold this call placed (cleared_at + who + why), and no other call\'s', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed her cell — texts should go there now.' });
      expect(res.status).toBe(200);
    });
    expect(numberHold(tables).cleared_at).toBeInstanceOf(Date);
    expect(numberHold(tables).cleared_by).toBe('tech-1');
    // Round 7 P1: the single-card Resolve is the explicit "this SAME number
    // is actually fine" verification — named as such on the row.
    expect(numberHold(tables).clear_reason).toBe('verified_same_number');
    expect(numberHold(tables, 'hold-other').cleared_at).toBeNull();
  });

  test('round 7 P1: the reply names the verified-same-number meaning — the disclaimed number is cleared', async () => {
    const { conn } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Called back — this IS her number.' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.callback_number).toMatchObject({
        verdict: 'verified_same_number', disclaimed_number_hold: 'cleared', number_holds_cleared: 1,
      });
    });
  });

  test('codex round-3 P2: an en_route visit (tech already rolling) still clears — nonterminal, not just pending/confirmed', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed her cell — texts should go there now.' });
      expect(res.status).toBe(200);
    });
    const enRoute = tables.scheduled_services.find((s) => s.id === EN_ROUTE_VISIT_ID);
    expect(enRoute.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
  });

  test('codex round-5 P2: a rescheduled visit (rebooked, grouped sibling) still clears — CLEARABLE, not just NONTERMINAL', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed her cell — texts should go there now.' });
      expect(res.status).toBe(200);
    });
    const rescheduled = tables.scheduled_services.find((s) => s.id === RESCHEDULED_VISIT_ID);
    expect(rescheduled.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
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
    expect(numberHold(tables).cleared_at).toBeNull();
  });
});

/**
 * Codex round-4 P2, PR #4807: TriageInboxTabV2 renders callback_number_needed
 * as a generic call-verdict card (Accept/Deny → POST /:id/verdict), not
 * through the single-card /resolve action above. Accept there is a
 * whole-call routing judgment, not a deliberate "I confirmed this number"
 * click, so the route must independently verify a corrected number is
 * actually on file before it clears the hold — refusing 409
 * CALLBACK_NUMBER_UNVERIFIED instead of trusting the verdict alone.
 */
describe('POST /admin/triage/:id/verdict on a callback_number_needed card', () => {
  test('Accept with a corrected customer phone clears the hold on every live visit', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, phone: '9415559999' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
    const enRoute = tables.scheduled_services.find((s) => s.id === EN_ROUTE_VISIT_ID);
    expect(enRoute.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
    // Round 7 P1 (supersedes round 6's "the verdict clears the number
    // too"): this verdict's prerequisite only proved the customer's phone
    // MOVED to a replacement — the OLD disclaimed number was never verified,
    // and the send predicate checks its row globally (duplicate customers,
    // leads, queued messages to that shared/office line). It stays held.
    expect(numberHold(tables).cleared_at).toBeNull();
    expect(numberHold(tables, 'hold-other').cleared_at).toBeNull();
  });

  test('round 7 P1: bulk verdict after a replacement keeps the OLD ANI blocked and says so; a later sender to that ANI is still refused', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, phone: '9415559999' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.callback_number).toMatchObject({
        verdict: 'replacement_number', disclaimed_number_hold: 'kept', number_holds_cleared: 0,
      });
      expect(body.callback_number.message).toMatch(/stays blocked/);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    const row = numberHold(tables);
    expect(row.cleared_at).toBeNull();
    expect(row.clear_reason == null).toBe(true);
    // The global send predicate, reading the same table: the old ANI (any
    // formatting) is still refused, the replacement is not held.
    const Holds = require('../services/disclaimed-number-holds');
    expect(await Holds.disclaimedNumberBlocksSend({ to: DISCLAIMED_ANI, conn })).toBe(true);
    expect(await Holds.disclaimedNumberBlocksSend({ to: '(941) 555-1234', conn })).toBe(true);
    expect(await Holds.disclaimedNumberBlocksSend({ to: '9415559999', conn })).toBe(false);
  });

  test('round 7 P1: single-card Resolve after the same replacement DOES clear the old ANI (explicit same-number verification)', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, phone: '9415559999' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed the office line is fine too.' });
      expect(res.status).toBe(200);
    });
    expect(numberHold(tables).cleared_at).toBeInstanceOf(Date);
    expect(numberHold(tables).clear_reason).toBe('verified_same_number');
  });

  test('Accept with the customer phone still == the disclaimed ANI refuses 409 CALLBACK_NUMBER_UNVERIFIED — nothing resolves, nothing clears', async () => {
    // Default fixture: customers.phone === DISCLAIMED_ANI (no correction).
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('CALLBACK_NUMBER_UNVERIFIED');
    });
    // The whole verdict is refused, not just the clearing: the card stays
    // open for a retry once the number is actually fixed.
    expect(tables.triage_items[0].status).toBe('open');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toBeNull();
    expect(numberHold(tables).cleared_at).toBeNull();
  });

  test('a differently-formatted but equal ANI (dashes, leading 1) still counts as unverified — digits compare, not string compare', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, phone: '1-941-555-1234' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(409);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  /**
   * Finding #3 (round 4 P1, PR #4807): an OUTBOUND auto-booking call has
   * from_phone as the Waves Twilio number, not the caller's disclaimed
   * number — the processor's resolveCallContactPhone uses to_phone for
   * outbound. Comparing the customer's on-file phone against a bare
   * from_phone made an unchanged phone look like a verified replacement.
   */
  const WAVES_NUMBER = '9412975749'; // TWILIO_NUMBERS.mainLine, an internal/owned number.
  const DISCLAIMED_DESTINATION = '9415557777'; // to_phone on the outbound leg — the disclaimed number.

  test('outbound call: customer phone unchanged from the DIALED (to_phone) number still refuses 409 — from_phone (Waves) is not the disclaimed number', async () => {
    const { conn, tables } = fixture({
      call_log: [{
        id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID,
        direction: 'outbound-api', from_phone: WAVES_NUMBER, to_phone: DISCLAIMED_DESTINATION,
      }],
      customers: [{ id: CUSTOMER_ID, phone: DISCLAIMED_DESTINATION }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('CALLBACK_NUMBER_UNVERIFIED');
    });
    expect(tables.triage_items[0].status).toBe('open');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toBeNull();
  });

  test('outbound call: a genuinely corrected phone (different from to_phone) clears the hold', async () => {
    const { conn, tables } = fixture({
      call_log: [{
        id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID,
        direction: 'outbound-api', from_phone: WAVES_NUMBER, to_phone: DISCLAIMED_DESTINATION,
      }],
      customers: [{ id: CUSTOMER_ID, phone: '9415559999' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept' });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
    const held = tables.scheduled_services.find((s) => s.id === HELD_VISIT_ID);
    expect(held.call_sms_cleared_at).toEqual({ __raw: 'GREATEST(callback_number_hold_at, now())', bindings: undefined });
  });
});
