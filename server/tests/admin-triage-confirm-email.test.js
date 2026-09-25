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
    // Defaults to admin; a test overrides via the `x-test-role` header
    // (Codex round-7 P1: confirm-email is now admin-only, mirroring
    // apply-property-roles).
    const role = req.headers['x-test-role'] || 'admin';
    req.technician = { id: 'tech-1', role };
    req.technicianId = 'tech-1';
    req.techRole = role;
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
      // SQL semantics: an absent column reads as NULL (fixture rows omit
      // deleted_at), so match == null rather than strict === null.
      whereNull(col) { rawPredicates.push((row) => row[col] == null); return api; },
      whereNot(obj) {
        for (const [k, v] of Object.entries(obj)) rawPredicates.push((row) => row[k] !== v);
        return api;
      },
      // Only the one raw shape the canonical email writer's conflict check
      // uses (`LOWER(<col>) = ?`); anything else is ignored.
      whereRaw(sql, bindings = []) {
        const m = /LOWER\((\w+)\) = \?/.exec(String(sql));
        if (m) rawPredicates.push((row) => String(row[m[1]] ?? '').toLowerCase() === bindings[0]);
        return api;
      },
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
  // The fake runs everything on one "connection" that is also the
  // transaction handle — the canonical email writer refuses a
  // non-transactional handle, so mark it as one.
  conn.isTransaction = true;
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

// Wraps a fake conn so lock acquisitions and the customer email write are
// recorded in order. `onCallRowLock(n)` runs just before the n-th call_log
// FOR UPDATE read — the moment a concurrent relink that committed while this
// transaction waited on the call row becomes visible.
function trackConn(conn, order, { onCallRowLock } = {}) {
  let callRowLocks = 0;
  const tracked = (table) => {
    const name = String(table).split(' ')[0];
    const api = conn(table);
    const origForUpdate = api.forUpdate;
    if (name === 'customers') {
      api.forUpdate = (...a) => { order.push('customer-row-lock'); return origForUpdate.apply(api, a); };
      const origUpdate = api.update;
      api.update = async (patch, ...rest) => {
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'email')) order.push('customer-email-write');
        return origUpdate(patch, ...rest);
      };
    }
    if (name === 'call_log') {
      api.forUpdate = (...a) => {
        callRowLocks += 1;
        if (onCallRowLock) onCallRowLock(callRowLocks);
        order.push('call-row-lock');
        return origForUpdate.apply(api, a);
      };
    }
    return api;
  };
  tracked.isTransaction = true;
  tracked.transaction = async (fn) => fn(tracked);
  tracked.raw = (sql, bindings) => {
    if (/pg_advisory_xact_lock\(hashtextextended/.test(String(sql))) order.push(`email-key:${bindings[0]}`);
    return conn.raw(sql, bindings);
  };
  tracked.schema = conn.schema;
  return tracked;
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

function post(baseUrl, path, body = {}, headers = {}) {
  return fetch(`${baseUrl}/admin/triage${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
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

  test('codex round 9: an address longer than customers.email (varchar 150) refuses with 400 and touches nothing', async () => {
    const { conn, tables } = fixture();
    wireDb(db, { conn });
    const longEmail = `${'a'.repeat(140)}@example.com`; // 152 chars
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
        email: longEmail, expected_updated_at: CARD_UPDATED_AT,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/150 characters/);
    });
    expect(tables.triage_items[0].status).toBe('open');
    expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
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

    // Codex round-7 P1 (finding at admin-triage.js:862): a customer-less
    // confirmation now requires an authoritative lead REGARDLESS of
    // whether a hold marker would confirm anything — the hold ledger is a
    // first-touch send record, not proof a lead exists to carry the
    // confirmed address. This used to succeed via the hold marker alone;
    // it now refuses, and the hold table is untouched because the lead
    // gate runs before any write.
    test('refuses with 409 LEAD_NOT_RESOLVED even though a hold channel exists, when no lead resolves', async () => {
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
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('LEAD_NOT_RESOLVED');
      });
      expect(tables.first_touch_holds).toHaveLength(0);
      expect(tables.triage_items[0].status).toBe('open');
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

    // Codex round-8 restructure: the round-6 invariant (customer row before
    // any call advisory lock — the Customer 360 order) still holds; the
    // sequence now also shows the address key right after the row (row →
    // key, the Customer 360 / bounce-recovery order), the call ROW lock the
    // relink endpoint honors, and the canonical writer's re-entrant row +
    // key before its email write.
    test('lock order: customer row → address key → sorted call locks → call row → canonical writer (row, key, write)', async () => {
      const OTHER_CALL_ID = 'call-2';
      const order = [];
      const { conn } = fixture({
        call_log: [
          { id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA000' },
          { id: OTHER_CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA111' },
        ],
      });
      lockTriageCall.mockImplementation(async (_trx, callId) => { order.push(`call-lock:${callId}`); });
      wireDb(db, { conn: trackConn(conn, order) });
      try {
        await withServer(async (baseUrl) => {
          const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
            email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
          });
          expect(res.status).toBe(200);
        });
        expect(order).toEqual([
          'customer-row-lock',
          'email-key:customer-email:janedoe@example.com',
          `call-lock:${CALL_ID}`,
          `call-lock:${OTHER_CALL_ID}`,
          'call-row-lock',
          'customer-row-lock',
          'email-key:customer-email:janedoe@example.com',
          'customer-email-write',
        ]);
      } finally {
        lockTriageCall.mockImplementation(async () => {});
      }
    });
  });

  // Codex round-7 P1 (finding at admin-triage.js:793): the router is only
  // requireTechOrAdmin, but this endpoint overwrites a customer's email of
  // record and triggers token fanout + first-touch comms — admin-only, same
  // rule as apply-property-roles.
  describe('admin-only', () => {
    test('a tech token refuses with 403 and writes nothing', async () => {
      const { conn, tables } = fixture();
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        }, { 'x-test-role': 'technician' });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe('Admin access required');
      });
      expect(tables.triage_items[0].status).toBe('open');
      expect(tables.first_touch_holds[0].held_email).toBe('');
      expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
    });

    test('an admin token still succeeds (existing contract preserved)', async () => {
      const { conn, tables } = fixture();
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        }, { 'x-test-role': 'admin' });
        expect(res.status).toBe(200);
      });
      expect(tables.triage_items[0].status).toBe('resolved');
    });
  });

  // Codex round-7 P1 (finding at admin-triage.js:608): a staff relink moves
  // call_log.customer_id, not the first_touch_holds row, so the hold must be
  // repointed at the CURRENTLY locked call's customer — otherwise
  // resumeHeldFirstTouch's hold_customer_mismatch check
  // (lead-first-touch-resume.js:833-840) rejects the hold forever.
  describe('relinked call: the hold repoints to the currently locked customer', () => {
    test('confirming a relinked call updates the hold row\'s customer_id to the NEW customer, not the stale one', async () => {
      const OLD_CUSTOMER_ID = 'cust-old';
      const { conn, tables } = fixture({
        customers: [{ id: CUSTOMER_ID, email: null }, { id: OLD_CUSTOMER_ID, email: null }],
        // The call was relinked from OLD_CUSTOMER_ID to CUSTOMER_ID
        // (call_log.customer_id already reflects the relink), but the
        // ledger row a prior run wrote still carries the stale customer.
        first_touch_holds: [
          { id: 'hold-1', call_log_id: CALL_ID, customer_id: OLD_CUSTOMER_ID, status: 'pending', held_email: '' },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].customer_id).toBe(CUSTOMER_ID);
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
      expect(tables.first_touch_holds[0].corrected_at).toBeInstanceOf(Date);
    });
  });

  // Codex round-7 P1 (finding at admin-triage.js:608): an explicit
  // confirmation is exactly the correction a prior denial ('deny, await
  // correction') was waiting for — the retarget must clear that stamp
  // (mirroring customer-email-fanout's own deny-lift) or
  // resumeHeldFirstTouch rejects the stamped hold forever
  // (lead-first-touch-resume.js:787-795). An ownerless 'releasing' row (its
  // own deny bump already invalidated any outstanding lease) returns to
  // 'pending' so it is claimable again; a LIVE 'releasing' claim (no deny
  // stamp) keeps its status — its target is superseded, not stolen.
  describe('denial stamp clears on explicit confirmation', () => {
    test('a pending, deny-stamped hold has last_error cleared and is retargeted', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
          held_email: 'stale@example.com', last_error: 'email_denied_await_correction',
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].status).toBe('pending');
      expect(tables.first_touch_holds[0].last_error).toBeNull();
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
    });

    test('an ownerless releasing+deny-stamped hold returns to pending, ready to be claimed again', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'releasing',
          held_email: 'stale@example.com', last_error: 'email_denied_await_correction',
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].status).toBe('pending');
      expect(tables.first_touch_holds[0].last_error).toBeNull();
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
    });

    test('a LIVE releasing claim (no deny stamp) keeps its status — the target is superseded, not stolen', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'releasing',
          held_email: 'stale@example.com', last_error: null,
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].status).toBe('releasing');
      expect(tables.first_touch_holds[0].last_error).toBeNull();
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
    });
  });

  // Codex round-8 P1 (admin-triage.js:586): the customer was read before any
  // lock the relink endpoint honors. The relink endpoint locks its TARGET
  // customer row and then UPDATEs the call row; this handler now re-resolves
  // the target under the call row lock and restarts when it moved.
  describe('relink race: the target is revalidated under the call row lock', () => {
    const OTHER_CUSTOMER_ID = 'cust-b';

    test('a relink A→B that commits while the call row lock is awaited: rolls back, re-plans, writes B and repoints the hold at B', async () => {
      const order = [];
      const { conn, tables } = fixture({
        customers: [{ id: CUSTOMER_ID, email: null }, { id: OTHER_CUSTOMER_ID, email: null }],
      });
      wireDb(db, {
        conn: trackConn(conn, order, {
          onCallRowLock: (n) => { if (n === 1) tables.call_log[0].customer_id = OTHER_CUSTOMER_ID; },
        }),
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      // The stale customer is never written; B is, through the canonical writer.
      expect(tables.customers.find((c) => c.id === CUSTOMER_ID).email).toBeNull();
      expect(tables.customers.find((c) => c.id === OTHER_CUSTOMER_ID).email).toBe('janedoe@example.com');
      expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
      expect(mockPropagateCustomerEmailChange.mock.calls[0][0].before).toMatchObject({ id: OTHER_CUSTOMER_ID });
      expect(tables.first_touch_holds[0].customer_id).toBe(OTHER_CUSTOMER_ID);
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
      // Two attempts: the first stopped at its call row lock, before any write.
      expect(order.filter((e) => e === 'call-row-lock')).toHaveLength(2);
      expect(order.indexOf('customer-email-write')).toBeGreaterThan(order.lastIndexOf('call-row-lock'));
      expect(resumeHeldFirstTouch).toHaveBeenCalledWith(expect.objectContaining({ customerId: OTHER_CUSTOMER_ID }));
    });

    test('a call that keeps moving refuses with 409 CALL_RELINKED after bounded attempts and writes nothing', async () => {
      const { conn, tables } = fixture({
        customers: [{ id: CUSTOMER_ID, email: null }, { id: OTHER_CUSTOMER_ID, email: null }],
      });
      wireDb(db, {
        conn: trackConn(conn, [], {
          onCallRowLock: () => {
            tables.call_log[0].customer_id = tables.call_log[0].customer_id === CUSTOMER_ID ? OTHER_CUSTOMER_ID : CUSTOMER_ID;
          },
        }),
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('CALL_RELINKED');
      });
      expect(tables.customers.every((c) => c.email === null)).toBe(true);
      expect(tables.first_touch_holds[0].held_email).toBe('');
      expect(tables.triage_items[0].status).toBe('open');
      expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
    });
  });

  // Codex round-8 P1 (admin-triage.js:686): customers.email was assigned
  // without the shared per-address key and with no ownership check. The
  // canonical writer takes the key before the write (held to commit, through
  // the fanout) and refuses an address another ACCOUNT holds — the Customer
  // 360 contact_exists_on_another_account rule.
  describe('address ownership: the canonical writer decides under the address key', () => {
    test('an address another account already holds refuses with 409 EMAIL_IN_USE and writes nothing', async () => {
      const { conn, tables } = fixture({
        customers: [
          { id: CUSTOMER_ID, email: null, account_id: 'acct-1' },
          { id: 'cust-x', email: 'JaneDoe@example.com', account_id: 'acct-x', deleted_at: null },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('EMAIL_IN_USE');
      });
      expect(tables.customers[0].email).toBeNull();
      expect(tables.first_touch_holds[0].held_email).toBe('');
      expect(tables.first_touch_holds[0].corrected_at).toBeUndefined();
      expect(tables.triage_items[0].status).toBe('open');
      expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
      expect(resumeHeldFirstTouch).not.toHaveBeenCalled();
    });

    test('a same-account sibling profile sharing the address is allowed (customers.email is deliberately non-unique)', async () => {
      const { conn, tables } = fixture({
        customers: [
          { id: CUSTOMER_ID, email: null, account_id: 'acct-1' },
          { id: 'cust-sibling', email: 'janedoe@example.com', account_id: 'acct-1', deleted_at: null },
        ],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBe('janedoe@example.com');
    });

    test('the address key is taken on the customer-less lead path too (leads.email is an ownership source)', async () => {
      const order = [];
      const { conn } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null }],
      });
      wireDb(db, { conn: trackConn(conn, order) });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(order[0]).toBe('email-key:customer-email:janedoe@example.com');
    });
  });

  // Codex round-8 P1 (admin-triage.js:716): conversion/booking set
  // leads.customer_id without relinking call_log, so a converted voicemail
  // lead used to be treated as customer-less and only leads.email moved.
  describe('converted lead: the authoritative lead\'s customer gets the canonical write', () => {
    const CONVERTED_ID = 'cust-converted';

    test('call has no customer, its lead converted: the customer email is written via the canonical fanout and the lead is stamped', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [{ id: CONVERTED_ID, email: 'old@example.com', deleted_at: null }],
        first_touch_holds: [{ id: 'hold-1', call_log_id: CALL_ID, customer_id: null, status: 'pending', held_email: '' }],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null, customer_id: CONVERTED_ID }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBe('janedoe@example.com');
      expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
      const fanoutArgs = mockPropagateCustomerEmailChange.mock.calls[0][0];
      expect(fanoutArgs.before).toMatchObject({ id: CONVERTED_ID, email: 'old@example.com' });
      expect(fanoutArgs.after).toMatchObject({ id: CONVERTED_ID, email: 'janedoe@example.com' });
      expect(tables.leads[0].email).toBe('janedoe@example.com');
      expect(tables.leads[0].email_confirmed_at).toBeInstanceOf(Date);
      // The hold keeps the CALL's customer (none): resumeHeldFirstTouch
      // compares the hold's customer with call_log.customer_id.
      expect(tables.first_touch_holds[0].customer_id).toBeNull();
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
      expect(tables.triage_items[0].status).toBe('resolved');
      expect(resumeHeldFirstTouch).not.toHaveBeenCalled();
    });

    test('a lead converted while the call row lock was awaited: the attempt restarts and routes through the new customer', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [{ id: CONVERTED_ID, email: null, deleted_at: null }],
        first_touch_holds: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null, customer_id: null }],
      });
      wireDb(db, {
        conn: trackConn(conn, [], {
          onCallRowLock: (n) => { if (n === 1) tables.leads[0].customer_id = CONVERTED_ID; },
        }),
      });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBe('janedoe@example.com');
      expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
      expect(tables.leads[0].email).toBe('janedoe@example.com');
    });

    test('a lead whose customer was archived stays on the lead-only path', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [{ id: CONVERTED_ID, email: null, deleted_at: '2026-09-01T00:00:00.000Z' }],
        first_touch_holds: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null, customer_id: CONVERTED_ID }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBeNull();
      expect(mockPropagateCustomerEmailChange).not.toHaveBeenCalled();
      expect(tables.leads[0].email).toBe('janedoe@example.com');
    });
  });

  // Codex round-8 P2 (admin-triage.js:630): a live 'releasing' row's
  // updated_at is the claimant's lease stamp — resumeHeldFirstTouch settles
  // only while it equals the claim — so the retarget must not bump it,
  // mirroring customer-email-fanout's releasing-row retarget. A pending
  // row's retarget still bumps it, as the fanout's pending retarget does.
  describe('hold retarget leaves a live claim\'s lease stamp alone', () => {
    const LEASE = new Date('2026-09-24T12:00:00.000Z');

    test('a live releasing row is retargeted without touching updated_at', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'releasing',
          held_email: 'stale@example.com', last_error: null, updated_at: LEASE,
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].updated_at).toBe(LEASE);
      expect(tables.first_touch_holds[0].status).toBe('releasing');
      expect(tables.first_touch_holds[0].held_email).toBe('janedoe@example.com');
      expect(tables.first_touch_holds[0].corrected_at).toBeInstanceOf(Date);
    });

    test('an ownerless deny-stamped releasing row flips to pending without a bump (same as the fanout)', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'releasing',
          held_email: 'stale@example.com', last_error: 'email_denied_await_correction', updated_at: LEASE,
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].status).toBe('pending');
      expect(tables.first_touch_holds[0].updated_at).toBe(LEASE);
    });

    test('a pending row\'s retarget still bumps updated_at', async () => {
      const { conn, tables } = fixture({
        first_touch_holds: [{
          id: 'hold-1', call_log_id: CALL_ID, customer_id: CUSTOMER_ID, status: 'pending',
          held_email: '', last_error: null, updated_at: LEASE,
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.first_touch_holds[0].updated_at).not.toBe(LEASE);
      expect(tables.first_touch_holds[0].updated_at).toBeInstanceOf(Date);
    });
  });

  // Codex round-10 P2 (admin-triage.js :827): the fanout resolves the open
  // card first (with no resolution_source), so an OPEN_STATES-only close was
  // a no-op and the card was left un-attributed — the reprocess mint honors
  // only a human-resolved card carrying payload.confirmed_email.
  describe('the confirmed card ends human-resolved even when the fanout closed it first', () => {
    test('fanout resolves the card in the same transaction → resolution_source human + read-back note + confirmed_email', async () => {
      mockPropagateCustomerEmailChange.mockImplementationOnce(async (_args, trx) => {
        await trx('triage_items').where({ id: CARD_ID }).whereIn('status', ['open', 'in_progress']).update({
          status: 'resolved', resolution_note: 'Email corrected on the customer record (triage_confirm)',
          resolved_at: new Date(), updated_at: new Date(),
        });
        return {};
      });
      const { conn, tables } = fixture();
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
      const card = tables.triage_items[0];
      expect(card.status).toBe('resolved');
      expect(card.resolution_source).toBe('human');
      expect(card.resolution_note).toBe('Email confirmed via triage read-back: janedoe@example.com');
      expect(card.assigned_to).toBe('tech-1');
      expect(JSON.parse(card.payload).confirmed_email).toBe('janedoe@example.com');
    });

    test('a card already resolved before the request is refused as stale and never re-attributed', async () => {
      const { conn, tables } = fixture({
        triage_items: [{
          id: CARD_ID, call_log_id: CALL_ID, reason_code: 'email_unverified', status: 'resolved',
          resolution_source: 'auto', category: 'lead_intake', severity: 'advisory', payload: DISAGREEMENT_PAYLOAD,
          created_at: CARD_CREATED_AT, updated_at: CARD_UPDATED_AT,
        }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
      });
      expect(tables.triage_items[0].resolution_source).toBe('auto');
    });
  });

  // Codex round-10 P2 (admin-triage.js :637): the lead FOR UPDATE re-read
  // must repeat the live-row predicate.
  describe('a lead archived between the lookup and its row lock', () => {
    test('is never stamped: the attempt re-plans, refuses LEAD_NOT_RESOLVED, and the card stays open', async () => {
      const { conn, tables } = fixture({
        call_log: [{ id: CALL_ID, review_status: 'open', customer_id: null, twilio_call_sid: 'CA000' }],
        customers: [],
        first_touch_holds: [],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null }],
      });
      let archived = false;
      const wrapped = (table) => {
        const api = conn(table);
        if (String(table).split(' ')[0] === 'leads') {
          const origForUpdate = api.forUpdate;
          api.forUpdate = (...a) => {
            // The concurrent archive commits while this lock is awaited.
            if (!archived) { archived = true; tables.leads[0].deleted_at = '2026-09-25T00:00:00.000Z'; }
            return origForUpdate.apply(api, a);
          };
        }
        return api;
      };
      wrapped.isTransaction = true;
      wrapped.transaction = async (fn) => fn(wrapped);
      wrapped.raw = conn.raw;
      wrapped.schema = conn.schema;
      wireDb(db, { conn: wrapped });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('LEAD_NOT_RESOLVED');
      });
      expect(archived).toBe(true);
      expect(tables.leads[0].email).toBeNull();
      expect(tables.leads[0].email_confirmed_at).toBeUndefined();
      expect(tables.triage_items[0].status).toBe('open');
    });
  });

  // Codex round-10 P2 (admin-triage.js :656): a customer-linked call that
  // also created/reused a lead stamps that lead too — the fanout skips lead
  // sync when the customer's old email was blank.
  describe('customer-linked call with an authoritative lead', () => {
    test('the metadata lead of the same customer is stamped alongside the canonical customer write', async () => {
      const { conn, tables } = fixture({
        call_log: [{
          id: CALL_ID, review_status: 'open', customer_id: CUSTOMER_ID, twilio_call_sid: 'CA000',
          metadata: JSON.stringify({ lead_id: 'lead-1' }),
        }],
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null, customer_id: CUSTOMER_ID }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBe('janedoe@example.com');
      expect(mockPropagateCustomerEmailChange).toHaveBeenCalledTimes(1);
      expect(tables.leads[0].email).toBe('janedoe@example.com');
      expect(tables.leads[0].email_confirmed_at).toBeInstanceOf(Date);
      // The hold still carries the call's own customer.
      expect(tables.first_touch_holds[0].customer_id).toBe(CUSTOMER_ID);
      expect(tables.triage_items[0].status).toBe('resolved');
    });

    test('a SID-matched lead not yet linked to any customer is stamped too', async () => {
      const { conn, tables } = fixture({
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: null, customer_id: null }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.leads[0].email).toBe('janedoe@example.com');
    });

    test('a lead owned by a DIFFERENT customer (the call was relinked away from it) is never written', async () => {
      const { conn, tables } = fixture({
        leads: [{ id: 'lead-1', twilio_call_sid: 'CA000', deleted_at: null, email: 'other@example.com', customer_id: 'cust-other' }],
      });
      wireDb(db, { conn });
      await withServer(async (baseUrl) => {
        const res = await post(baseUrl, `/${CARD_ID}/confirm-email`, {
          email: 'janedoe@example.com', expected_updated_at: CARD_UPDATED_AT,
        });
        expect(res.status).toBe(200);
      });
      expect(tables.customers[0].email).toBe('janedoe@example.com');
      expect(tables.leads[0].email).toBe('other@example.com');
      expect(tables.leads[0].email_confirmed_at).toBeUndefined();
    });
  });
});
