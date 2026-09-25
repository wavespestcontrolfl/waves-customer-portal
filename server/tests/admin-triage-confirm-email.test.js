/**
 * Codex round-5 P1s on the V1/V2 email-disagreement hold (PR #4802):
 * emailDisagreementConfirmed guards the plain Resolve/Accept paths, but
 * there was no in-band way to actually SATISFY it — a customer-less
 * voicemail lead has no existing-lead email editor in the portal, and a
 * known customer whose on-file email already matches the confirmed
 * spelling could never produce a corrected_at stamp
 * (propagateCustomerEmailChange no-ops when oldEmail === newEmail, so
 * staff would have to change it to something wrong and back).
 *
 * POST /api/admin/triage/:id/confirm-email is the one action that closes
 * both gaps. Drives the REAL route against an in-memory fake db (same
 * harness as admin-triage-email-disagreement-resolve.test.js);
 * customer-email-fanout is mocked — its own correctness is covered by
 * customer-email-fanout.test.js, and this suite only needs to assert IT
 * WAS (or was not) called with the right before/after. Fixtures use
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
const mockPropagateCustomerEmailChange = jest.fn(async () => ({}));
const mockResendPendingConfirmation = jest.fn(async () => {});
jest.mock('../services/customer-email-fanout', () => ({
  propagateCustomerEmailChange: mockPropagateCustomerEmailChange,
  resendPendingConfirmation: mockResendPendingConfirmation,
}));
const mockResumeHeldNewsletterPostCommit = jest.fn(async () => {});
jest.mock('../services/lead-first-touch-resume', () => {
  const actual = jest.requireActual('../services/lead-first-touch-resume');
  return {
    ...actual,
    resumeHeldFirstTouch: jest.fn(async () => ({ resumed: false })),
    resumeHeldNewsletterPostCommit: mockResumeHeldNewsletterPostCommit,
  };
});

const express = require('express');
const db = require('../models/db');
const triageRouter = require('../routes/admin-triage');
const { resumeHeldFirstTouch } = require('../services/lead-first-touch-resume');
const { lockTriageCall } = require('../utils/triage-locks');

// Same generic in-memory table simulator as admin-triage-email-disagreement-resolve.test.js.
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
      whereNull(col) { eq[col] = null; return api; },
      forUpdate() { return api; },
      forShare() { return api; },
      orderBy() { return api; },
      limit() { return api; },
      join() { return api; },
      leftJoin() { return api; },
      modify(fn) { fn(api); return api; },
      // A snapshot copy, not a live reference — matches real knex/pg (a row
      // read here must not silently mutate when a LATER .update() call
      // touches the same table, the way a shared object reference would).
      first: async () => { const r = filtered()[0]; return r ? { ...r } : null; },
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
          onConflict: (col) => {
            // ON CONFLICT DO NOTHING: drop the new row when one with the same
            // conflict key already existed, and report no inserted rows.
            const dup = typeof col === 'string' && rows.some((r) => r !== row && r[col] === row[col]);
            if (dup) rows.splice(rows.indexOf(row), 1);
            const ignored = dup ? [] : [row];
            return {
              ignore: () => ({ then: (resolve) => resolve(ignored.length), returning: async () => ignored }),
              merge: async () => 1,
            };
          },
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

beforeEach(() => {
  jest.clearAllMocks();
  db.mockReset();
});

describe('POST /admin/triage/:id/confirm-email', () => {
  test('confirming a candidate: hold retargeted + corrected_at, customer email updated via the fanout, card resolves', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.confirmed_email).toBe('janedoe@example.com');
      expect(body.confirmed_source).toBe('candidate');
    });
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
    expect(tables.first_touch_holds[0].corrected_at).toBeInstanceOf(Date);
    expect(tables.customers[0].email).toBe('janedoe@example.com');
    expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
    const call = mockPropagateCustomerEmailChange.mock.calls[0][0];
    expect(call.before).toMatchObject({ id: CUSTOMER_ID, email: null });
    expect(call.after).toMatchObject({ id: CUSTOMER_ID, email: 'janedoe@example.com' });
    expect(tables.triage_items[0].status).toBe('resolved');
    const payload = JSON.parse(tables.triage_items[0].payload);
    expect(payload.confirmed_email).toBe('janedoe@example.com');
    expect(payload.confirmed_by).toBe('tech-1');
    expect(payload.confirmed_source).toBe('candidate');
  });

  test('the customer already has this exact spelling: hold is still retargeted (corrected_at stamped) and the card resolves, but the fanout is never called', async () => {
    const { conn, tables } = fixture({
      customers: [{ id: CUSTOMER_ID, email: 'janedoe@example.com' }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
    });
    // The whole point of the fix: this hold is now retargeted+corrected
    // even though the customer record never changed.
    expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
    expect(tables.first_touch_holds[0].corrected_at).toBeInstanceOf(Date);
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
    expect(tables.triage_items[0].status).toBe('resolved');
  });

  test('customer-less voicemail lead: the lead email and email_confirmed_at are stamped, card resolves', async () => {
    const { conn, tables } = fixture({
      call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
      customers: [],
      first_touch_holds: [],
      leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
    });
    expect(tables.leads[0].email).toBe('janedoe@example.com');
    expect(tables.leads[0].email_confirmed_at).toBeInstanceOf(Date);
    expect(tables.triage_items[0].status).toBe('resolved');
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('a typed address that is NOT one of the candidates is accepted and recorded operator_typed', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'completely.different@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.confirmed_source).toBe('operator_typed');
    });
    const payload = JSON.parse(tables.triage_items[0].payload);
    expect(payload.confirmed_source).toBe('operator_typed');
    expect(payload.confirmed_email).toBe('completely.different@example.com');
  });

  test('an invalid email format refuses with 400 and touches nothing', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'not-an-email', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(400);
    });
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('a stale expected_updated_at refuses with 409 and touches nothing', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: '2020-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('STALE_CARD_VERSION');
    });
    expect(tables.triage_items[0].status).toBe('open');
    expect(tables.first_touch_holds[0].held_email).toBe('');
  });

  test('a card with no email_disagreement evidence refuses — action not applicable', async () => {
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
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'plain@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(400);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('a non-email card reason_code refuses before touching anything', async () => {
    const { conn, tables } = fixture({
      triage_items: [{
        id: CARD_ID, call_log_id: CALL_ID, reason_code: 'address_unverified', status: 'open',
        category: 'address_review', severity: 'blocking', payload: { flag: 'address_unverified' },
        created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
      }],
    });
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(400);
    });
    expect(tables.triage_items[0].status).toBe('open');
  });

  test('resolves and releases the first-touch hold once no sibling email card is left open', async () => {
    const { conn } = fixture();
    wireDb(db, { conn });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(200);
    });
    expect(resumeHeldFirstTouch).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUSTOMER_ID, callLogId: CALL_ID, source: 'triage_confirm_email',
    }));
  });

  // Codex round-6 P1 (finding at admin-triage.js:709): propagateCustomerEmailChange's
  // unrollbackable sends (a held newsletter DOI resume, a moved
  // pending-confirmation resend) must run AFTER commit, exactly like the
  // Customer 360 edit path (admin-customers.js).
  describe('post-commit email-sync callbacks', () => {
    test('runs resumeHeldNewsletterPostCommit and resendPendingConfirmation with the fanout\'s returned payloads', async () => {
      const { conn, tables } = fixture();
      mockPropagateCustomerEmailChange.mockResolvedValueOnce({
        heldNewsletterResume: { subscriberId: 'sub-1' },
        pendingConfirmation: { token: 'tok-1' },
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      // The customer row is already committed by the time these run — this
      // suite has no real begin/commit boundary to assert against directly,
      // but the write above happens inside the transaction while these
      // callbacks are the code that runs strictly after it returns.
      expect(tables.customers[0].email).toBe('janedoe@example.com');
      expect(mockResumeHeldNewsletterPostCommit).toHaveBeenCalledWith({ subscriberId: 'sub-1' });
      expect(mockResendPendingConfirmation).toHaveBeenCalledWith({ token: 'tok-1' });
    });

    test('calls neither callback when the fanout returns nothing to resume', async () => {
      const { conn } = fixture();
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(mockResumeHeldNewsletterPostCommit).not.toHaveBeenCalled();
      expect(mockResendPendingConfirmation).not.toHaveBeenCalled();
    });

    test('never runs the callbacks on the customer-less lead path (no fanout call at all)', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.leads[0].email).toBe('janedoe@example.com');
      expect(mockResumeHeldNewsletterPostCommit).not.toHaveBeenCalled();
      expect(mockResendPendingConfirmation).not.toHaveBeenCalled();
    });
  });

  // Codex round-6 P1 (finding at admin-triage.js:638): pre-Step-6 window —
  // the disagreement card committed, but the processor's own hold-ledger
  // write for this run has not landed yet (mintEmailReviewCardsFenced and
  // recordFirstTouchHoldOwned are separate transactions in the same run).
  describe('pre-Step-6 window: no hold row exists yet when the operator confirms', () => {
    test('a zero-work correction marker is upserted, carrying the confirmed target and corrected_at', async () => {
      const { conn, tables } = fixture({ first_touch_holds: [] });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      // Same shape as customer-email-fanout's own zero-work marker
      // (propagateCustomerEmailChange): recordFirstTouchHold's later ON
      // CONFLICT merge reads corrected_at/held_email off THIS row (its own
      // correctness is covered by lead-first-touch-resume.test.js) instead
      // of overwriting it with the fresh, unconfirmed extraction.
      expect(tables.first_touch_holds).toHaveLength(1);
      const marker = tables.first_touch_holds[0];
      expect(marker.call_log_id).toBe(CALL_ID);
      expect(marker.customer_id).toBe(CUSTOMER_ID);
      expect(marker.held_email).toBe('janedoe@example.com');
      expect(marker.corrected_at).toBeInstanceOf(Date);
      expect(marker.held_drip).toBe(false);
      expect(marker.held_newsletter).toBe(false);
      expect(marker.status).toBe('released');
      expect(tables.triage_items[0].status).toBe('resolved');
    });
  });

  // Codex round-6 P1 (finding at admin-triage.js:679).
  describe('customer-less path: no authoritative lead resolved', () => {
    test('refuses with 409 LEAD_NOT_RESOLVED when neither a lead nor a hold channel confirmed anything', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [], // table absent below simulates no hold channel at all
        leads: [], // no metadata stamp, no SID match
      });
      // Simulate the hold ledger being entirely unavailable — the one
      // shape where the round-6 P1 fix (an always-successful zero-work
      // marker) cannot itself supply a confirmation signal.
      conn.schema.hasTable = async (name) => name !== 'first_touch_holds' && Object.prototype.hasOwnProperty.call(tables, name);
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('LEAD_NOT_RESOLVED');
      });
      expect(tables.triage_items[0].status).toBe('open');
    });

    test('refuses with 409 LEAD_NOT_RESOLVED when the only hold row is terminal (already sent) and nothing was retargeted', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [{ id: 'hold-1', call_log_id: CALL_ID, customer_id: null, status: 'sent', held_email: 'old@example.com' }],
        leads: [],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('LEAD_NOT_RESOLVED');
      });
      expect(tables.first_touch_holds).toHaveLength(1);
      expect(tables.first_touch_holds[0].held_email).toBe('old@example.com');
      expect(tables.triage_items[0].status).toBe('open');
    });

    test('still succeeds via the hold marker when no lead resolves but a hold channel exists (the ordinary case)', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [],
        leads: [],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds).toHaveLength(1);
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
      expect(tables.triage_items[0].status).toBe('resolved');
    });
  });

  // Codex round-6 P2 (finding at admin-triage.js:649).
  describe('lock ordering', () => {
    test('locks every call of the customer, sorted, BEFORE anything else — never a single-call lock followed by the fanout\'s own customer-wide lock', async () => {
      const OTHER_CALL_ID = 'call-2';
      const { conn } = fixture({
        call_log: [
          { id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA000' },
          { id: OTHER_CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA111' },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      // The route's OWN first two lock acquisitions must already cover
      // BOTH of the customer's calls, sorted — not just the clicked
      // card's own call (which would let the fanout's later customer-wide
      // lock acquire callY while a concurrent confirmation on callY holds
      // it and waits on callX: the AB-BA deadlock this fix removes).
      const firstTwoLockedIds = lockTriageCall.mock.calls.slice(0, 2).map((c) => c[1]);
      expect(firstTwoLockedIds).toEqual([CALL_ID, OTHER_CALL_ID].sort());
    });

    test('locks the customer row (FOR UPDATE) before taking any call advisory lock — same order as the Customer 360 edit path (Codex round-6 P2)', async () => {
      const OTHER_CALL_ID = 'call-2';
      const order = [];
      const { conn } = fixture({
        call_log: [
          { id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA000' },
          { id: OTHER_CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA111' },
        ],
      });
      // admin-customers.js's email edit locks the customer row (FOR UPDATE,
      // ~admin-customers.js:3939) BEFORE propagateCustomerEmailChange waits
      // on this customer's sorted call-lock set (customer-email-fanout.js:
      // 255-257). Wrap the fake conn so a `customers` FOR UPDATE is
      // recorded relative to each lockTriageCall — proves this route now
      // takes the SAME order instead of the reverse (the AB-BA deadlock
      // this fix removes).
      const trackedConn = (table) => {
        const api = conn(table);
        if (String(table).split(' ')[0] === 'customers') {
          const origForUpdate = api.forUpdate;
          api.forUpdate = (...args) => { order.push('customer-row-lock'); return origForUpdate.apply(api, args); };
        }
        return api;
      };
      trackedConn.transaction = async (fn) => fn(trackedConn);
      trackedConn.raw = conn.raw;
      trackedConn.schema = conn.schema;
      lockTriageCall.mockImplementation(async (_trx, callId) => { order.push(`call-lock:${callId}`); });
      wireDb(db, { conn: trackedConn });
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
            email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
          });
          expect(res.status).toBe(200);
        });
        expect(order).toEqual([
          'customer-row-lock',
          `call-lock:${CALL_ID}`,
          `call-lock:${OTHER_CALL_ID}`,
        ]);
      } finally {
        lockTriageCall.mockImplementation(async () => {});
      }
    });
  });
});
