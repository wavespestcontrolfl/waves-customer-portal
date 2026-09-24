/**
 * codex round-2 findings on PR #4673 (head 5c27279b6):
 *
 * P0: RainOut.commit's own collective-anchoring rule (GATE_COLLECTIVE_SERIES_ANCHOR)
 * shifts a recurring visit's WHOLE FUTURE SERIES whenever its date actually
 * changes — independent of scope — so a technician sending scope='job' (not
 * 'route') on their own recurring visit reached the same series-wide blast
 * radius the admin-only scope='route' gate was meant to close.
 *
 * P1: the ownership check on PATCH /:id/note and POST /:id/rain-out/
 * POST /:id/reschedule read a snapshot before the write; a reassignment
 * landing in between had no effect on the write itself, so the FORMER
 * technician's write still committed. The write is now pinned to the
 * authenticated technician id (an atomic WHERE match for note, the
 * rebooker's own options.expect CAS for reschedule, and an immediate
 * re-check right before RainOut.commit for rain-out).
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
const mockCommit = jest.fn().mockResolvedValue({ ok: true, results: [], qualityDates: [] });
jest.mock('../services/rain-out', () => ({ commit: (...a) => mockCommit(...a), getOptions: jest.fn() }));
const mockReschedule = jest.fn().mockResolvedValue({ success: true });
jest.mock('../services/rebooker', () => ({
  reschedule: (...a) => mockReschedule(...a),
  rescheduleSeries: jest.fn().mockResolvedValue({ success: true, rescheduledOccurrences: [] }),
  applyLiveMovePostCommitEffects: jest.fn(),
  collectiveMoveGateOn: () => false,
  previewSeriesMove: jest.fn().mockResolvedValue({ collective: false }),
}));
jest.mock('../routes/admin-schedule', () => ({
  sendRescheduleNoticeForVisit: jest.fn(async () => ({ sent: true, error: null })),
}));
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: jest.fn().mockResolvedValue({}),
}));

// Stateful db mock: table-qualified where()/whereIn()/update() actually
// filter the fixture rows, so a technician_id CAS predicate in the write's
// own WHERE genuinely misses once the row changes — a mock that ignored the
// predicate could not tell this fix from a no-op.
jest.mock('../models/db', () => {
  const state = { scheduledServices: [], writes: [] };
  const norm = (c) => String(c).replace(/^scheduled_services\./, '');
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[norm(k)] === v);
  const cmpOp = (a, op, v) => (op === '>=' ? a >= v : op === '>' ? a > v : op === '<=' ? a <= v : op === '<' ? a < v : a === v);
  const dbFn = (table) => {
    const b = { _where: {}, _notIn: {}, _cmp: [] };
    b.where = (w, opOrVal, val) => {
      if (typeof w === 'function') { w.call(b); return b; }
      if (w && typeof w === 'object') { Object.assign(b._where, w); return b; }
      if (val !== undefined) { b._cmp.push([norm(w), opOrVal, val]); return b; }
      b._where[norm(w)] = opOrVal;
      return b;
    };
    b.andWhere = (...a) => b.where(...a);
    b.modify = (fn) => { fn(b); return b; };
    b.whereNotIn = (col, vals) => { b._notIn[norm(col)] = vals; return b; };
    b.whereNot = (col, val) => { b._notIn[norm(col)] = [val]; return b; };
    for (const m of ['whereIn', 'whereNull', 'whereRaw', 'orWhere', 'leftJoin', 'forUpdate', 'orderBy']) b[m] = () => b;
    b.select = () => b;
    b.returning = (cols) => { b._returning = cols; return b; };
    b.first = async (...cols) => {
      const rows = table === 'scheduled_services' ? state.scheduledServices : [];
      const found = rows.find((r) => matches(r, b._where)
        && Object.entries(b._notIn).every(([k, vals]) => !vals.includes(r[norm(k)]))
        && b._cmp.every(([k, op, v]) => cmpOp(r[norm(k)], op, v)));
      if (!found) return undefined;
      // The only raw() column expression these routes select is the
      // "to_char(scheduled_date, 'YYYY-MM-DD') as day" reorder helper —
      // recognize it by its SQL text and answer with the ET date string.
      const colKey = (c) => (typeof c === 'string' && c.includes('as day') ? 'day' : c);
      const out = cols.length
        ? Object.fromEntries(cols.map((c) => [colKey(c), colKey(c) === 'day' ? String(found.scheduled_date).slice(0, 10) : found[c]]))
        : { ...found };
      // Fires a scripted concurrent reassignment right after THIS read
      // returns its (pre-race) snapshot — models a dispatcher's
      // assignDispatchJob landing between the route's ownership-check read
      // and its later write, so the write's own predicate (not a stale
      // earlier check) is what has to catch it.
      if (state.raceAfterNextRead && table === 'scheduled_services') {
        const { to } = state.raceAfterNextRead;
        state.raceAfterNextRead = null;
        found.technician_id = to;
      }
      return out;
    };
    b.update = (u) => {
      const rows = table === 'scheduled_services' ? state.scheduledServices : [];
      const hits = rows.filter((r) => matches(r, b._where));
      state.writes.push({ table, op: 'update', where: { ...b._where }, u, hit: hits.map((r) => r.id) });
      hits.forEach((r) => Object.assign(r, u));
      b._hits = hits;
      return b;
    };
    b.then = (resolve, reject) => Promise.resolve(b._returning ? (b._hits || []).map((r) => ({ ...r })) : (b._hits ? b._hits.length : [])).then(resolve, reject);
    return b;
  };
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => {
    // Models a reassignment transaction that committed in the instant
    // before ours acquires its FOR UPDATE lock — the realistic race for a
    // route whose ENTIRE read+write now runs inside one transaction (the
    // note route): a concurrent updater would block on our lock once we
    // hold it, so the only way it can still land is by committing first.
    if (state.raceOnTransaction) {
      const { to } = state.raceOnTransaction;
      state.raceOnTransaction = null;
      const row = state.scheduledServices.find((r) => r.id === 'svc-1');
      if (row) row.technician_id = to;
    }
    const trx = (table) => dbFn(table);
    trx.raw = dbFn.raw;
    return cb(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const dispatchRouter = require('../routes/admin-dispatch');
const { etDateString, addETDays } = require('../utils/datetime-et');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/dispatch', dispatchRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const TODAY = etDateString(new Date());
const NEXT_WEEK = etDateString(addETDays(new Date(), 7));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_COLLECTIVE_SERIES_ANCHOR;
  db.__state.scheduledServices = [
    { id: 'svc-1', technician_id: 'tech-A', customer_id: 'cust-1', status: 'confirmed', scheduled_date: TODAY, notes: 'original', is_recurring: true, window_start: '09:00:00', window_end: '10:00:00' },
  ];
  db.__state.writes = [];
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test("P0: rain-out scope='job' on the technician's OWN recurring visit with a changed date is refused when GATE_COLLECTIVE_SERIES_ANCHOR is on (would otherwise shift the whole future series)", async () => {
  process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
  const { status, body } = await call('POST', '/api/admin/dispatch/svc-1/rain-out', {
    reasonCode: 'weather_rain', scope: 'job', target: { date: NEXT_WEEK, window: { start: '09:00', end: '10:00' } },
  });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Admin access required for this action', code: 'admin_required' });
  expect(mockCommit).not.toHaveBeenCalled();
});

test('P1: POST /:id/rain-out — a reassignment landing right after the initial ownership read is caught by the immediate re-check before RainOut.commit', async () => {
  db.__state.raceAfterNextRead = { to: 'tech-B' };
  const { status, body } = await call('POST', '/api/admin/dispatch/svc-1/rain-out', {
    reasonCode: 'weather_rain', scope: 'job', target: { date: TODAY, window: { start: '11:00', end: '12:00' } },
  });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  expect(mockCommit).not.toHaveBeenCalled();
});

test('control: the same rain-out is allowed with the gate off', async () => {
  const { status } = await call('POST', '/api/admin/dispatch/svc-1/rain-out', {
    reasonCode: 'weather_rain', scope: 'job', target: { date: NEXT_WEEK, window: { start: '09:00', end: '10:00' } },
  });
  expect(status).toBe(200);
  expect(mockCommit).toHaveBeenCalledTimes(1);
});

test('control: a SAME-DAY rain-out (no date change) is unaffected by the gate', async () => {
  process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
  const { status } = await call('POST', '/api/admin/dispatch/svc-1/rain-out', {
    reasonCode: 'weather_rain', scope: 'job', target: { date: TODAY, window: { start: '11:00', end: '12:00' } },
  });
  expect(status).toBe(200);
  expect(mockCommit).toHaveBeenCalledTimes(1);
});

test('P1: PATCH /:id/note — a reassignment that commits the instant before this request acquires its row lock is refused (403), never overwritten', async () => {
  db.__state.raceOnTransaction = { to: 'tech-B' };
  const { status, body } = await call('PATCH', '/api/admin/dispatch/svc-1/note', { notes: 'should not land' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
  expect(db.__state.scheduledServices[0].notes).toBe('original');
});

test('control: PATCH /:id/note still writes normally for the technician who owns the visit', async () => {
  const { status, body } = await call('PATCH', '/api/admin/dispatch/svc-1/note', { notes: 'legit update' });
  expect(status).toBe(200);
  expect(body.notes).toBe('legit update');
  expect(db.__state.scheduledServices[0].notes).toBe('legit update');
});

test("P1: reschedule pins the rebooker's CAS to the authenticated technician_id for a technician caller", async () => {
  const { status } = await call('POST', '/api/admin/dispatch/svc-1/reschedule', {
    newDate: NEXT_WEEK, newWindow: { start: '09:00', end: '10:00' },
  });
  expect(status).toBe(200);
  expect(mockReschedule).toHaveBeenCalledTimes(1);
  const options = mockReschedule.mock.calls[0][5];
  expect(options.expect).toMatchObject({ technician_id: 'tech-A' });
});

test("codex round-3: PATCH /:id/note now rejects a STALE (>7 days old) or COMPLETED visit for a technician — lockOwnedLiveVisit's technicianLiveVisitFilter, not a bare technician_id compare", async () => {
  db.__state.scheduledServices[0].scheduled_date = '2020-01-01';
  const { status, body } = await call('PATCH', '/api/admin/dispatch/svc-1/note', { notes: 'too old' });
  expect(status).toBe(403);
  expect(body).toEqual({ error: 'Not assigned to this service', code: 'service_not_assigned' });
});

test('codex round-3: PUT /:id/reorder now rejects a stale visit for a technician too', async () => {
  db.__state.scheduledServices[0].scheduled_date = '2020-01-01';
  const res = await fetch(`${baseUrl}/api/admin/dispatch/svc-1/reorder`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routeOrder: 3 }),
  });
  expect(res.status).toBe(403);
});
