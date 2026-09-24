/**
 * Test contract change (PR #4673 round 3 follow-up).
 *
 * call-outbound-booking.test.js's "field-confirm semantics cover day-of
 * takeovers on BOTH status routes" describe block source-grepped
 * admin-dispatch.js for a literal `.forUpdate()` call and the exact text
 * `takeoverCandidate || explicitFieldConfirm` within 2000 characters of
 * `let fieldConfirmVerified = false`. Round 3 (per its own explicit task —
 * "introduce ONE helper ... use it inside the transaction of EVERY
 * technician-reachable per-visit write in admin-dispatch.js") moved the row
 * lock into the shared `lockOwnedLiveVisit` helper
 * (server/services/technician-visit-scope.js), so:
 *   - the FOR UPDATE lock now lives in that helper, not as a literal
 *     `.forUpdate()` call in admin-dispatch.js itself, and
 *   - the codex-review commentary documenting the fenced races pushed the
 *     (unchanged, still-present) `takeoverCandidate || explicitFieldConfirm`
 *     predicate past the guard's fixed-size text window.
 * Duplicating an inline FOR-UPDATE re-read back into this one route just to
 * satisfy the old literal shape would recreate the exact two-copies-of-a-
 * security-check risk the shared helper was built to eliminate (a future
 * change to ownership scoping could patch one copy and miss the other), so
 * per the round-3 instructions this is a deliberate test-contract change:
 * the source-grep assertions on admin-dispatch.js's re-verification shape
 * are replaced with a BEHAVIORAL proof that the guard's actual intent still
 * holds on BOTH status routes — a day-of takeover by field-confirm succeeds
 * and stamps field_confirmed_at, and a technician who does not own the
 * visit is refused, never silently takes it over.
 *
 * (The admin-schedule.js half of the original guard — the source-grep on
 * `const isFieldLifecycleTakeover` — is untouched by this PR and still
 * passes as-is; the tests below add missing BEHAVIORAL coverage for it too,
 * since none existed anywhere in the suite before this file.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'tech-A', role: 'technician' };
      req.technicianId = 'tech-A';
      req.techRole = 'technician';
      return next();
    },
  };
});
const mockTransitionJobStatus = jest.fn().mockResolvedValue({ ok: true, adminPayload: null });
jest.mock('../services/job-status', () => {
  const actual = jest.requireActual('../services/job-status');
  return { ...actual, transitionJobStatus: (...a) => mockTransitionJobStatus(...a) };
});

// A generic, table-agnostic knex fake: `_where` (equality), `_cmp` (3-arg
// comparisons, e.g. the 7-day access-window check), and `_notIn` (an ARRAY
// of [col, vals] pairs, so distinct whereNot/whereNotIn calls on different
// columns compose instead of overwriting each other) are all matched for
// real in `first()`, so a broken/omitted predicate genuinely fails a test
// instead of a mock silently no-op'ing through it. `update()` records what
// it was asked to write without needing to mutate the fixture back.
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
  const normCol = (c) => String(c).replace(/^scheduled_services\./, '');
  const cmp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
  const dbFn = (table) => {
    const b = {
      _where: {}, _cmp: [], _notIn: [],
      where(w, op, val) {
        if (typeof w === 'function') { w.call(b); return b; }
        if (w && typeof w === 'object') Object.assign(b._where, w);
        else if (val !== undefined) b._cmp.push([w, op, val]);
        else b._where[w] = op;
        return b;
      },
      andWhere(...a) { return b.where(...a); },
      whereNot(col, val) { b._notIn.push([col, [val]]); return b; },
      whereNotIn(col, vals) { b._notIn.push([col, vals]); return b; },
      whereIn() { return b; }, whereNull() { return b; }, whereNotNull() { return b; },
      whereRaw() { return b; }, orWhere() { return b; },
      modify(cb) { cb(b); return b; },
      leftJoin() { return b; }, forUpdate() { return b; }, orderBy() { return b; }, select() { return b; },
      async first(...cols) {
        const rows = table === 'scheduled_services' ? state.scheduledServices : [];
        const found = rows.find((r) => Object.entries(b._where).every(([k, v]) => r[normCol(k)] === v)
          && b._cmp.every(([c, op, v]) => cmp(r[normCol(c)], op, v))
          && b._notIn.every(([c, vals]) => !vals.includes(r[normCol(c)])));
        if (!found) return undefined;
        return cols.length ? Object.fromEntries(cols.map((c) => [normCol(c), found[normCol(c)]])) : { ...found };
      },
      async update(u) { state.writes.push({ table, op: 'update', where: { ...b._where }, u }); return 1; },
      async insert(r) { state.writes.push({ table, op: 'insert', r }); return [1]; },
      async del() { state.writes.push({ table, op: 'del' }); return 0; },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return b;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    const trx = (table) => dbFn(table);
    trx.raw = async () => ({});
    trx.fn = dbFn.fn;
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');
const scheduleRouter = require('../routes/admin-schedule');
const { etDateString } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use('/api/admin/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

async function putStatus(base, id, body) {
  const res = await fetch(`${baseUrl}${base}/${id}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function fieldConfirmedWrite() {
  return db.__state.writes.find((w) => w.table === 'scheduled_services' && w.op === 'update' && w.u.field_confirmed_at);
}

beforeEach(() => {
  mockTransitionJobStatus.mockClear();
  db.__state.writes = [];
  // An unactivated outbound-review booking (still owing activation —
  // customer_confirmed unset) assigned to tech-A, scheduled today.
  db.__state.scheduledServices = [{
    id: 'svc-1',
    technician_id: 'tech-A',
    customer_id: 'cust-1',
    status: 'pending',
    scheduled_date: TODAY,
    source_action: 'ai_call_outbound_review',
    customer_confirmed: null,
    service_type: 'Pest Control',
    tech_name: 'Tech A',
  }];
});

describe('admin-dispatch.js PUT /:serviceId/status', () => {
  test("day-of takeover: the visit's OWN technician moving an unactivated office-review row straight to en_route stamps field_confirmed_at", async () => {
    const { status, body } = await putStatus('/api/admin/dispatch', 'svc-1', { status: 'en_route' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(fieldConfirmedWrite()).toBeTruthy();
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({ jobId: 'svc-1', fromStatus: 'pending', toStatus: 'en_route' });
  });

  test('control: a technician who does NOT own the visit is refused (403) — never silently stamped, never a takeover', async () => {
    db.__state.scheduledServices[0].technician_id = 'tech-B';
    const { status, body } = await putStatus('/api/admin/dispatch', 'svc-1', { status: 'en_route' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
    expect(fieldConfirmedWrite()).toBeFalsy();
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });

  test('control: an ordinary (non office-review) visit day-of does NOT stamp field_confirmed_at — the takeover predicate is source_action-scoped', async () => {
    db.__state.scheduledServices[0].source_action = null;
    const { status } = await putStatus('/api/admin/dispatch', 'svc-1', { status: 'en_route' });
    expect(status).toBe(200);
    expect(fieldConfirmedWrite()).toBeFalsy();
  });
});

describe('admin-schedule.js PUT /:id/status', () => {
  test("day-of takeover: the same office-review row moved day-of by its OWN technician stamps field_confirmed_at", async () => {
    const { status, body } = await putStatus('/api/admin/schedule', 'svc-1', { status: 'en_route' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(fieldConfirmedWrite()).toBeTruthy();
    expect(mockTransitionJobStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionJobStatus.mock.calls[0][0]).toMatchObject({ jobId: 'svc-1', fromStatus: 'pending', toStatus: 'en_route' });
  });

  test('control: a technician who does NOT own the visit gets 404 (this route pre-scopes its own SELECT via technicianCurrentVisitFilter) — never stamped', async () => {
    db.__state.scheduledServices[0].technician_id = 'tech-B';
    const { status } = await putStatus('/api/admin/schedule', 'svc-1', { status: 'en_route' });
    expect(status).toBe(404);
    expect(fieldConfirmedWrite()).toBeFalsy();
    expect(mockTransitionJobStatus).not.toHaveBeenCalled();
  });
});
