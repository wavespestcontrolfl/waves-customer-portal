/**
 * Codex round-2/round-3 P1s on the V1/V2 email-disagreement hold (PR #4802):
 * a card carrying `email_disagreement` evidence has NO single confirmed
 * address — the hold's held_email is blank on purpose. Resolving that card
 * as-is (PUT /:id/resolve, or an Accept call verdict) previously closed the
 * card and called resumeHeldFirstTouch with nothing to release: the
 * customer stayed email-less, the blank hold can't send and the ledger
 * sweep excludes it (`.whereNot('held_email', '')`), and the terminal card
 * left no future trigger to fix it.
 *
 * Round 3 narrowed confirmation provenance further: a pre-existing customer
 * email does NOT count (resumeHeldFirstTouch sends the HOLD's held_email,
 * never the customer's stored column — round-2's fallback was a false
 * confirmation that still left an unsendable blank hold behind the closed
 * card). Only two shapes count: (a) a hold row whose held_email was
 * actually retargeted by an operator correction (corrected_at set), or
 * (b) no hold row at all (a customer-less voicemail lead) with the
 * call-linked lead's own email set AFTER the card was filed. Round 3 also
 * added email cards to the expected_updated_at version check on both
 * routes.
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
const CARD_CREATED_AT = '2026-09-20T00:00:00.000Z';
const CARD_UPDATED_AT = '2026-09-20T00:00:00.000Z';
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
      created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
    }],
    call_log: [{ id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA000' }],
    customers: [{ id: CUSTOMER_ID, email: null }],
    first_touch_holds: [{ id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending', held_email: '' }],
    leads: [],
    ...extra,
  });
}

beforeEach(() => { db.mockReset(); });

describe('PUT /admin/triage/:id/resolve on a card carrying email_disagreement', () => {
  test('refuses when neither the hold nor the customer has a confirmed address', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Read back on the phone.', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    // The card stays open — a work item survives for the operator to fix.
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  // Codex round-3 P1 (finding #1): a pre-existing customer email is NOT
  // confirmation on its own — resumeHeldFirstTouch sends the HOLD's
  // held_email, never the customer's stored column, so a customer record
  // that happens to already have an address (unrelated to this hold) must
  // still refuse.
  test('a pre-existing customer email that never retargeted the hold is STILL refused (round-3 fix)', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, email: 'janedoe@example.com' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    expect(tables.triage_items[0].status).toBe('open');
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
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { note: 'Confirmed via correction.', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  // Codex round-3 P1 (finding #7): a customer-less voicemail lead never
  // gets a first_touch_holds row — the ONLY correction path is editing the
  // lead's own email, so that must be an accepted provenance shape too.
  // Codex round-4 P1 (finding #1): the signal is `leads.email_confirmed_at`
  // — stamped ONLY by admin-leads.js when the email field itself actually
  // changes — never the lead's generic `updated_at` (an unrelated
  // status/notes/SMS-bookkeeping touch bumps that and would falsely
  // confirm the card).
  describe('customer-less voicemail lead (no hold row at all)', () => {
    test('a lead email_confirmed_at set AFTER the card was filed confirms and closes the card', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        first_touch_holds: [],
        customers: [],
        leads: [{
          id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead@example.com',
          // A late, unrelated row touch (status change, SMS bookkeeping)
          // bumped updated_at even later — must NOT be what confirms this.
          updated_at: '2026-09-23T00:00:00.000Z', email_confirmed_at: '2026-09-21T00:00:00.000Z',
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(200);
      });
      expect(tables.triage_items[0].status).toBe('resolved');
    });

    test('a lead whose updated_at is late but email_confirmed_at predates the card still refuses (round-4 fix)', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        first_touch_holds: [],
        customers: [],
        leads: [{
          id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead@example.com',
          // Some UNRELATED field edit (status/notes) after the card was
          // filed bumped updated_at — round-3's updated_at signal would
          // have wrongly confirmed this; email_confirmed_at is untouched
          // and predates the card, so it correctly still refuses.
          updated_at: '2026-09-23T00:00:00.000Z', email_confirmed_at: '2026-09-19T00:00:00.000Z',
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
      });
      expect(tables.triage_items[0].status).toBe('open');
    });

    test('a lead with no email_confirmed_at at all still refuses, even with a nonblank email and a late updated_at', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        first_touch_holds: [],
        customers: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead@example.com', updated_at: '2026-09-23T00:00:00.000Z' }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(409);
      });
      expect(tables.triage_items[0].status).toBe('open');
    });

    test('no lead at all still refuses (never loops on the customer.email fallback)', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        first_touch_holds: [],
        customers: [],
        leads: [],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(409);
      });
      expect(tables.triage_items[0].status).toBe('open');
    });

    // Codex round-4 P1 (finding #3): leads.twilio_call_sid is NOT unique.
    test('two leads share the call SID → ambiguous, fails closed to unconfirmed', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        first_touch_holds: [],
        customers: [],
        leads: [
          { id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead1@example.com', email_confirmed_at: '2026-09-21T00:00:00.000Z' },
          { id: 'lead-2', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead2@example.com', email_confirmed_at: '2026-09-21T00:00:00.000Z' },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
      });
      expect(tables.triage_items[0].status).toBe('open');
    });

    // Codex round-4 P1 (finding #3): the processor's own authoritative
    // stamp (call_log.metadata.lead_id) resolves the lead unambiguously
    // when present, bypassing the non-unique SID match entirely — even
    // with ANOTHER lead sharing the same SID.
    test('call_log.metadata.lead_id resolves the correct lead even when the SID is shared with another', async () => {
      const { conn, tables } = fixture({
        call_log: [{
          id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000',
          metadata: { lead_id: 'lead-1' },
        }],
        first_touch_holds: [],
        customers: [],
        leads: [
          { id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead1@example.com', email_confirmed_at: '2026-09-21T00:00:00.000Z' },
          { id: 'lead-2', twilio_call_sid: 'CA000', deleted_at: null, email: 'lead2@example.com', email_confirmed_at: null },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
        expect(res.status).toBe(200);
      });
      expect(tables.triage_items[0].status).toBe('resolved');
    });
  });

  // Codex round-3 P1 (finding #5): email cards now join the
  // expected_updated_at version check the client already sends.
  test('a stale expected_updated_at on an email card refuses even with a confirmed hold', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const stale = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: '2020-01-01T00:00:00.000Z' });
      expect(stale.status).toBe(409);
      expect((await stale.json()).code).toBe('STALE_CARD_VERSION');
      const missing = await put(baseUrl, `/${CARD_ID}/resolve`, {});
      expect(missing.status).toBe(409);
      expect((await missing.json()).code).toBe('STALE_CARD_VERSION');
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('a plain email_unverified card with no disagreement evidence is unaffected — resolves as before', async () => {
    const { conn, tables } = fixture({
      triage_items: [{
        id: CARD_ID, call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
        category: 'lead_intake', severity: 'advisory',
        payload: { flag: 'email_unverified', email_candidates: [{ value: 'plain@example.com' }] },
        created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await put(baseUrl, `/${CARD_ID}/resolve`, { expected_updated_at: CARD_UPDATED_AT });
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
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('a pre-existing customer email that never retargeted the hold is STILL refused (round-3 fix)', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, email: 'janedoe@example.com' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(409);
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
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  test('a stale expected_updated_at on an email card refuses even with a confirmed hold', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: '2020-01-01T00:00:00.000Z' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('STALE_CARD_VERSION');
    });
    expect(tables.triage_items[0].status).toBe('open');
  });
});

// Codex round-4 P1 (finding #2): the version bind covers only the CLICKED
// item — a verdict submitted through a non-email sibling card must not
// bulk-resolve a SEPARATE (possibly superseded/replaced) email card and
// release its hold unseen. The client sends expected_updated_at for the
// clicked item only, never for siblings, so an unrelated email card is
// excluded from the bulk resolve entirely and survives for its own click.
describe('POST /admin/triage/:id/verdict on a DIFFERENT card, with an email disagreement card also open on the call', () => {
  const OTHER_CARD_ID = 'card-other';

  function siblingFixture(extra = {}) {
    return fixture({
      triage_items: [
        {
          id: CARD_ID, call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'open',
          category: 'lead_intake', severity: 'advisory', payload: DISAGREEMENT_PAYLOAD,
          created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
        },
        {
          id: OTHER_CARD_ID, call_log_id: CALL_ID, reason_code: 'address_unverified', status: 'open',
          category: 'address_review', severity: 'blocking', payload: { flag: 'address_unverified' },
          created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
        },
      ],
      ...extra,
    });
  }

  test('Accept on the OTHER card resolves it, but leaves the email card open and its hold untouched', async () => {
    const { conn, tables } = siblingFixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${OTHER_CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items.find((c) => c.id === OTHER_CARD_ID).status).toBe('resolved');
    // The email disagreement card survives, unconfirmed, needing its own click.
    expect(tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('a Deny on the OTHER card also leaves the email card open and untouched', async () => {
    const { conn, tables } = siblingFixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${OTHER_CARD_ID}/verdict`, { verdict: 'deny', wrong_fields: ['address'], expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items.find((c) => c.id === OTHER_CARD_ID).status).toBe('resolved');
    expect(tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('Accept on the email card ITSELF still resolves it (self-click still works)', async () => {
    const { conn, tables } = siblingFixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, { verdict: 'accept', expected_updated_at: CARD_UPDATED_AT });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items.find((c) => c.id === CARD_ID).status).toBe('resolved');
  });
});

// Codex round-6 P1 (finding at admin-triage.js:1397): denyClearsEmailEarly
// treats the email as approved (it lifts a stale deny stamp and later
// triggers the same resumeHeldFirstTouch release as Accept) whenever the
// operator denies on a field OTHER than name/consent/spam_status — 'email'
// isn't even a selectable wrong-field, so a Deny naming e.g. 'address' on
// the disagreement card ITSELF must be guarded exactly like Accept is.
describe('POST /admin/triage/:id/verdict deny (with an unrelated wrong-field) on the disagreement card itself', () => {
  test('refuses with 409 EMAIL_DISAGREEMENT_UNCONFIRMED, same as Accept', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, {
        verdict: 'deny', wrong_fields: ['address'], expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('EMAIL_DISAGREEMENT_UNCONFIRMED');
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('succeeds once the hold has a confirmed target, same as Accept', async () => {
    const { conn, tables } = fixture({
      first_touch_holds: [{
        id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
        held_email: 'janedoe@example.com', corrected_at: new Date().toISOString(),
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/verdict`, {
        verdict: 'deny', wrong_fields: ['address'], expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
    });
    expect(tables.triage_items[0].status).toBe('resolved');
  });
});
