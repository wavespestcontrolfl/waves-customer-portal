/**
 * services/visit-prep-pest-read-sweep.js — GATE_VISIT_PREP_READ_SWEEP.
 * Pure/unit coverage against a small purpose-built chainable fake conn (same
 * convention as visit-prep-pest-read.test.js), with dispatchVisitPrepRead
 * and its engine choice fully mocked — this suite is about CANDIDATE
 * SELECTION and the one-retry-per-row-per-case bound, not the dispatch/
 * engine/claim/cap machinery itself (covered by visit-prep-read-dispatch,
 * visit-prep-pest-read and visit-prep-plant-read tests).
 */

const mockTrigger = jest.fn(async () => undefined);
// "Does a live engine read this stop now" — the dispatcher's own chooseEngine.
const mockIsPestStop = jest.fn(async () => false);
jest.mock('../services/visit-prep-read-dispatch', () => ({
  dispatchVisitPrepRead: (...args) => mockTrigger(...args),
  _internal: {
    // true → the stop wants a pest read; a string is taken as the key itself.
    currentReadKey: async (svc, conn) => {
      const v = await mockIsPestStop(svc, conn);
      return v === true ? 'pest' : (v || null);
    },
    storedReadKey: (r) => {
      const parsed = typeof r === 'string' ? JSON.parse(r) : r;
      return parsed?.engine === 'plant' ? `plant:${parsed.subject_type}` : 'pest';
    },
  },
}));

// The stop lock itself is covered by the claim's own suites; here the
// locked body runs directly on the fake conn.
const mockLockedStop = jest.fn((conn, svc, { body }) => body(conn));
jest.mock('../services/visit-prep-read-claim', () => ({
  ...jest.requireActual('../services/visit-prep-read-claim'),
  withLockedStop: (...args) => mockLockedStop(...args),
}));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepReadSweepLive: () => mockGateOn,
  visitPrepPestReadLive: () => true,
  visitPrepPlantReadLive: () => true,
}));

const {
  sweepVisitPrepPestReads,
  SWEEP_BATCH_LIMIT,
  _internal: { selectCandidates, SWEEP_CASE, SWEEP_ACTION, retryOne: _retryOneForTest },
} = require('../services/visit-prep-pest-read-sweep');

const NOW = new Date('2026-09-29T18:00:00Z'); // 2:00 PM ET — well inside 2026-09-29 either offset
const TODAY_ET = '2026-09-29';
const MIN = 60 * 1000;

function metaOf(row) {
  return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
}

// ── purpose-built fake conn ────────────────────────────────────────────────
function fakeConn(seed = {}) {
  const store = {
    submissions: [], services: [], photos: [], activityLog: [], ...seed,
  };

  function colKey(qualified) {
    const bare = String(qualified).split('.').pop();
    return bare === 'scheduled_date' ? '_scheduled_date' : bare;
  }

  function joinedRow(vps) {
    const ss = store.services.find((s) => s.id === vps.scheduled_service_id);
    if (!ss) return null;
    return {
      submission_id: vps.id,
      read_status: vps.read_status,
      created_at: vps.created_at,
      read_result: vps.read_result ?? null,
      read_attempts: vps.read_attempts ?? 0,
      scheduled_service_id: ss.id,
      customer_id: ss.customer_id,
      service_type: ss.service_type,
      visit_id: ss.visit_id,
      status: ss.status,
      _scheduled_date: ss.scheduled_date,
    };
  }

  function joinedQuery() {
    const q = { _whereIn: null, _whereNotIn: null, _wheres: [] };
    q.join = () => q;
    q.whereIn = (col, vals) => { q._whereIn = { col: colKey(col), vals }; return q; };
    q.whereNotIn = (col, vals) => { q._whereNotIn = { col: colKey(col), vals }; return q; };
    q.where = (col, op, val) => {
      if (typeof col === 'object') { q._match = { ...(q._match || {}), ...col }; return q; }
      q._wheres.push({ col: colKey(col), val });
      return q;
    };
    // The stale-done release: a guarded single-row update.
    q.update = async (patch) => {
      const hits = store.submissions.filter((r) => Object.entries(q._match || {})
        .every(([k, v]) => (k === 'read_attempts' ? (r.read_attempts ?? 0) === v : r[k] === v)));
      hits.forEach((r) => Object.assign(r, patch));
      return hits.length;
    };
    q.select = async () => store.submissions
      .map(joinedRow)
      .filter(Boolean)
      .filter((row) => {
        if (q._whereIn && !q._whereIn.vals.includes(row[q._whereIn.col])) return false;
        if (q._whereNotIn && q._whereNotIn.vals.includes(row[q._whereNotIn.col])) return false;
        return q._wheres.every((w) => row[w.col] >= w.val);
      });
    return q;
  }

  function activityQuery() {
    const q = {};
    q.where = (a, _op, since) => {
      if (typeof a === 'object') q._action = a?.action;
      else if (a === 'created_at') q._since = since;
      return q;
    };
    q.whereRaw = (sql, bindings) => { q._caseValue = bindings[0]; return q; };
    q.whereIn = (_rawCol, vals) => { q._idsFilter = vals.map(String); return q; };
    // Mirrors the real query: an aliased select, never pluck() on a Raw
    // (Knex 3's pluck needs a string column; Codex #5319 r1).
    q.pluck = () => { throw new Error('pluck() must not be used here'); };
    q.groupByRaw = () => { q._grouped = true; return q; };
    q.select = async () => (q._grouped ? lastCheckedRows : (rows) => rows)(store.activityLog
      .filter((r) => r.action === q._action)
      .filter((r) => !q._since || !r.created_at || new Date(r.created_at) >= q._since)
      .filter((r) => !q._caseValue || metaOf(r).case === q._caseValue)
      .filter((r) => !q._idsFilter || q._idsFilter.includes(String(metaOf(r).submissionId)))
      .map((r) => ({
        submission_id: String(metaOf(r).submissionId),
        attempts: metaOf(r).attempts == null ? null : String(metaOf(r).attempts),
        created_at: r.created_at,
      })));
    // MAX(created_at) per submission, as the grouped query returns.
    const lastCheckedRows = (rows) => {
      const last = new Map();
      for (const r of rows) {
        const prev = last.get(r.submission_id);
        if (!prev || new Date(r.created_at) > new Date(prev)) last.set(r.submission_id, r.created_at);
      }
      return [...last].map(([submission_id, last_checked]) => ({ submission_id, last_checked }));
    };
    q.insert = async (row) => { store.activityLog.push({ created_at: new Date(), ...row }); return [{ id: `gen-${store.activityLog.length}` }]; };
    return q;
  }

  function photosQuery() {
    const q = { _where: {} };
    q.where = (obj) => { Object.assign(q._where, obj); return q; };
    q.select = async () => store.photos.filter((p) => Object.entries(q._where).every(([k, v]) => p[k] === v));
    return q;
  }

  const conn = (tableExpr) => {
    if (String(tableExpr).startsWith('visit_prep_submissions')) return joinedQuery();
    if (tableExpr === 'activity_log') return activityQuery();
    if (tableExpr === 'visit_prep_photos') return photosQuery();
    throw new Error(`fakeConn: unexpected table "${tableExpr}"`);
  };
  conn.raw = (sql) => ({ __raw: sql });
  conn._store = store;
  return conn;
}

const PEST_SVC = { id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', visit_id: null, status: 'confirmed' };

function svc(overrides = {}) {
  return { ...PEST_SVC, ...overrides };
}

function submission(overrides = {}) {
  return {
    id: 'sub-1', scheduled_service_id: 'svc-1', read_status: 'none', created_at: NOW, ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGateOn = true;
  mockIsPestStop.mockResolvedValue(false);
});

describe('gate', () => {
  test('gate off: no query, no write, nothing retried', async () => {
    mockGateOn = false;
    const conn = () => { throw new Error('conn should never be called with the gate off'); };
    const result = await sweepVisitPrepPestReads(conn, NOW);
    expect(result).toEqual({ enabled: false, candidates: 0, retried: 0 });
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe('pending rows are never retried (Codex #5319 r2)', () => {
  test('a pending row, however old, is not a candidate (it may be a read still running)', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'pending', created_at: new Date(NOW.getTime() - 60 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });
});

describe('candidate selection — case (b) none', () => {
  test('a "none" row past the age buffer is a candidate', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    const candidates = await selectCandidates(conn, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].caseLabel).toBe(SWEEP_CASE.NONE_RETRY);
  });

  test('a freshly-created "none" row is left alone — never races the submission\'s own in-flight trigger', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 1 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });
});

describe('candidate selection — case (c) unsupported reclassified to pest', () => {
  test('an unsupported row whose stop IS pest now is a candidate', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'unsupported', created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    const candidates = await selectCandidates(conn, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].caseLabel).toBe(SWEEP_CASE.RECLASSIFIED);
    expect(mockIsPestStop).toHaveBeenCalledWith({ id: 'svc-1', visit_id: null }, conn);
  });

  test('an unsupported row whose stop is still NOT pest is never a candidate', async () => {
    mockIsPestStop.mockResolvedValue(false);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'unsupported', created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });
});

describe('the unsupported scan advances (Codex #5319 r2)', () => {
  test('a row checked and found still not pest is skipped for an hour, so later rows get checked', async () => {
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'unsupported', created_at: new Date(NOW.getTime() - 30 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    mockIsPestStop.mockResolvedValue(false);
    await selectCandidates(conn, NOW);
    expect(mockIsPestStop).toHaveBeenCalledTimes(1);
    mockIsPestStop.mockClear();
    await selectCandidates(conn, NOW);
    expect(mockIsPestStop).not.toHaveBeenCalled();
  });
});

describe('"failed" is never retried', () => {
  test('a failed row is excluded even when every other condition matches', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'failed', created_at: new Date(NOW.getTime() - 60 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });
});

describe('base eligibility filters', () => {
  test('a visit that already happened (scheduled_date in the past) is excluded', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: '2026-09-27' })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });

  test('a join-ineligible stop status (cancelled) is excluded', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET, status: 'cancelled' })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });

  test('a join-ineligible stop status (rescheduled) is excluded', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET, status: 'rescheduled' })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });

  test('a submission from an earlier day on a still-upcoming visit is a candidate; one older than the recovery window is not (Codex #5320 r12)', async () => {
    const recent = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 26 * 3600 * 1000) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(recent, NOW)).toHaveLength(1);
    const old = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 16 * 24 * 3600 * 1000) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(old, NOW)).toHaveLength(0);
  });
});

describe('one retry per row per case', () => {
  test('a row already swept once for this case is never selected again', async () => {
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      activityLog: [{ action: SWEEP_ACTION, metadata: { submissionId: 'sub-1', case: SWEEP_CASE.NONE_RETRY } }],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
  });

  test('a prior attempt for a DIFFERENT case does not block this one', async () => {
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      activityLog: [{ action: SWEEP_ACTION, metadata: { submissionId: 'sub-1', case: SWEEP_CASE.STALE_PENDING } }],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(1);
  });

  test('sweepVisitPrepPestReads records the attempt BEFORE retrying, so a second run never repeats it', async () => {
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    const first = await sweepVisitPrepPestReads(conn, NOW);
    expect(first).toEqual({ enabled: true, candidates: 1, retried: 1 });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(conn._store.activityLog).toHaveLength(1);
    expect(metaOf(conn._store.activityLog[0])).toMatchObject({ submissionId: 'sub-1', case: SWEEP_CASE.NONE_RETRY });

    // A second tick against the SAME store must not pick the row up again.
    mockTrigger.mockClear();
    const second = await sweepVisitPrepPestReads(conn, NOW);
    expect(second).toEqual({ enabled: true, candidates: 0, retried: 0 });
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe('the sweep bounds itself per run', () => {
  test(`only the oldest ${SWEEP_BATCH_LIMIT} candidates run in one tick`, async () => {
    const extra = SWEEP_BATCH_LIMIT + 3;
    const submissions = [];
    const services = [];
    for (let i = 0; i < extra; i += 1) {
      const id = `sub-${i}`;
      const svcId = `svc-${i}`;
      // Oldest first (i=0 is the oldest, furthest in the past).
      submissions.push(submission({ id, scheduled_service_id: svcId, read_status: 'none', created_at: new Date(NOW.getTime() - (60 - i) * MIN) }));
      services.push(svc({ id: svcId, scheduled_date: TODAY_ET }));
    }
    const conn = fakeConn({ submissions, services });
    const candidates = await selectCandidates(conn, NOW);
    expect(candidates).toHaveLength(SWEEP_BATCH_LIMIT);
    // Oldest-first: sub-0 (oldest) through sub-(LIMIT-1) are kept, the newest few are deferred to the next tick.
    expect(candidates.map((c) => c.submission_id)).toEqual(
      Array.from({ length: SWEEP_BATCH_LIMIT }, (_, i) => `sub-${i}`),
    );
  });
});

describe('sweepVisitPrepPestReads — retry wiring', () => {
  test('grouped stop reclassified to pest: retried with the fresh svc row and stored photos', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', scheduled_service_id: 'svc-1', read_status: 'unsupported', created_at: NOW })],
      services: [svc({ id: 'svc-1', visit_id: 'visit-9', scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    const result = await sweepVisitPrepPestReads(conn, NOW);
    expect(result).toEqual({ enabled: true, candidates: 1, retried: 1 });
    expect(mockTrigger).toHaveBeenCalledWith({
      submissionId: 'sub-1',
      svc: {
        id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', visit_id: 'visit-9', status: 'confirmed',
      },
      photos: [{ s3Key: 'visitprep/a.jpg', mimeType: 'image/jpeg' }],
      conn,
      // Claimed only while the row is still in the selected case.
      expectStatus: ['unsupported'],
    });
  });

  test('a row with no stored photos left records the attempt but never calls the trigger', async () => {
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [],
    });
    const result = await sweepVisitPrepPestReads(conn, NOW);
    expect(result).toEqual({ enabled: true, candidates: 1, retried: 1 });
    expect(mockTrigger).not.toHaveBeenCalled();
    expect(conn._store.activityLog).toHaveLength(1);
  });

  test('a retry the trigger reports as failed (it never throws) fails the run', async () => {
    mockTrigger.mockResolvedValueOnce('failed');
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'a.jpg', mime_type: 'image/jpeg' }],
    });
    const err = await sweepVisitPrepPestReads(conn, NOW).catch((e) => e);
    expect(err.result).toEqual({ enabled: true, candidates: 1, retried: 0, failed: 1 });
  });

  test('a capped or taken retry is not a failure', async () => {
    mockTrigger.mockResolvedValueOnce('capped');
    const conn = fakeConn({
      submissions: [submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'a.jpg', mime_type: 'image/jpeg' }],
    });
    await expect(sweepVisitPrepPestReads(conn, NOW)).resolves.toMatchObject({ retried: 1 });
  });

  test('a trigger failure for one row does not stop the rest of the batch, then fails the run (job_health)', async () => {
    mockTrigger
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const conn = fakeConn({
      submissions: [
        submission({ id: 'sub-1', read_status: 'none', created_at: new Date(NOW.getTime() - 20 * MIN) }),
        submission({ id: 'sub-2', scheduled_service_id: 'svc-2', read_status: 'none', created_at: new Date(NOW.getTime() - 30 * MIN) }),
      ],
      services: [svc({ scheduled_date: TODAY_ET }), svc({ id: 'svc-2', scheduled_date: TODAY_ET })],
      photos: [
        { submission_id: 'sub-1', s3_key: 'a.jpg', mime_type: 'image/jpeg' },
        { submission_id: 'sub-2', s3_key: 'b.jpg', mime_type: 'image/jpeg' },
      ],
    });
    const err = await sweepVisitPrepPestReads(conn, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.result).toEqual({ enabled: true, candidates: 2, retried: 1, failed: 1 });
    expect(mockTrigger).toHaveBeenCalledTimes(2); // both rows still ran
  });
});

describe('case (d): a finished read made for the wrong line or subject (Codex #5320 r10)', () => {
  const LAWN_READ = JSON.stringify({ engine: 'plant', subject_type: 'lawn', v2: {} });

  test('a done lawn read on a stop that is pest now is released and re-dispatched from none', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, read_attempts: 1, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    const candidates = await selectCandidates(conn, NOW);
    expect(candidates.map((c) => c.caseLabel)).toEqual([SWEEP_CASE.STALE_READ]);
    await sweepVisitPrepPestReads(conn, NOW);
    const row = conn._store.submissions[0];
    expect(row).toMatchObject({ read_status: 'none', read_result: null, read_ref: null, read_attempts: 1 });
    expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', expectStatus: ['none'] }));
  });

  test('a done lawn read on a stop now tree & shrub is stale too (subject changed)', async () => {
    mockIsPestStop.mockResolvedValue('plant:tree_shrub');
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect((await selectCandidates(conn, NOW)).map((c) => c.caseLabel)).toEqual([SWEEP_CASE.STALE_READ]);
  });

  test('a done read that still matches the stop is never a candidate (and is checked, then cooled down)', async () => {
    mockIsPestStop.mockResolvedValue('plant:lawn');
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toEqual([]);
    expect(conn._store.activityLog.map((r) => r.action)).toEqual(['visit_prep_read_sweep_check']);
  });

  test('a done read on a stop no live engine reads is left alone', async () => {
    mockIsPestStop.mockResolvedValue(null);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toEqual([]);
  });

  test('a stop that changed BACK before the release keeps its valid read: re-proved under the stop lock (Codex #5320 r11)', async () => {
    mockIsPestStop.mockResolvedValueOnce(true); // at selection: the stop wants a pest read
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, read_attempts: 1, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    const [row] = await selectCandidates(conn, NOW);
    mockIsPestStop.mockResolvedValue('plant:lawn'); // back to lawn before the retry runs
    await _retryOneForTest(conn, row);
    expect(mockLockedStop).toHaveBeenCalledWith(conn, expect.objectContaining({ id: 'svc-1' }), expect.any(Object));
    expect(conn._store.submissions[0]).toMatchObject({ read_status: 'done', read_result: LAWN_READ });
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('a legacy done read (attempts 0, pre-column) released keeps one attempt counted (pre-push audit P1)', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, read_attempts: 0, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    await sweepVisitPrepPestReads(conn, NOW);
    expect(conn._store.submissions[0]).toMatchObject({ read_status: 'none', read_attempts: 1 });
  });

  test('a re-read that landed after selection (attempts moved on) is never released', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_READ, read_attempts: 1, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    const [row] = await selectCandidates(conn, NOW);
    conn._store.submissions[0].read_attempts = 2; // another read claimed and finished meanwhile
    await _retryOneForTest(conn, row);
    expect(conn._store.submissions[0].read_status).toBe('done');
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe('case (d) covers failed reads and is one retry per settled attempt (Codex #5320 r13)', () => {
  const LAWN_FAIL = JSON.stringify({ engine: 'plant', subject_type: 'lawn' });
  const marker = (attempts) => ({
    action: 'visit_prep_read_sweep_attempt', created_at: NOW, metadata: { submissionId: 'sub-1', case: SWEEP_CASE.STALE_READ, attempts },
  });

  test('a failed lawn read on a stop that is pest now is released and re-read', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'failed', read_result: LAWN_FAIL, read_attempts: 1, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    expect((await selectCandidates(conn, NOW)).map((c) => c.caseLabel)).toEqual([SWEEP_CASE.STALE_READ]);
    await sweepVisitPrepPestReads(conn, NOW);
    expect(conn._store.submissions[0]).toMatchObject({ read_status: 'none', read_attempts: 1 });
    expect(mockTrigger).toHaveBeenCalledWith(expect.objectContaining({ expectStatus: ['none'] }));
  });

  test('a failed read on the line it failed on is never retried', async () => {
    mockIsPestStop.mockResolvedValue('plant:lawn');
    const conn = fakeConn({
      submissions: [submission({ read_status: 'failed', read_result: LAWN_FAIL, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toEqual([]);
  });

  test('a stop reclassified AGAIN after a recovered read gets its own retry; the same attempt never twice', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const LAWN_DONE = JSON.stringify({ engine: 'plant', subject_type: 'lawn', v2: {} });
    const again = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_DONE, read_attempts: 2, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      activityLog: [marker(1)],
    });
    expect((await selectCandidates(again, NOW)).map((c) => c.caseLabel)).toEqual([SWEEP_CASE.STALE_READ]);
    const same = fakeConn({
      submissions: [submission({ read_status: 'done', read_result: LAWN_DONE, read_attempts: 2, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      activityLog: [marker(2)],
    });
    expect(await selectCandidates(same, NOW)).toEqual([]);
  });

  test('the retry marker records the attempt it replaced', async () => {
    mockIsPestStop.mockResolvedValue(true);
    const conn = fakeConn({
      submissions: [submission({ read_status: 'failed', read_result: LAWN_FAIL, read_attempts: 3, created_at: NOW })],
      services: [svc({ scheduled_date: TODAY_ET })],
      photos: [{ submission_id: 'sub-1', s3_key: 'visitprep/a.jpg', mime_type: 'image/jpeg' }],
    });
    await sweepVisitPrepPestReads(conn, NOW);
    const retry = conn._store.activityLog.find((r) => r.action === 'visit_prep_read_sweep_attempt');
    expect(metaOf(retry)).toMatchObject({ case: SWEEP_CASE.STALE_READ, attempts: 3 });
  });
});

describe('the widened window (Codex #5348 r1)', () => {
  test('the 14-day cutoff is 14 ET calendar days, even across the spring DST change', async () => {
    // 00:30 ET on Sat Mar 20 2027 (EDT since Mar 14): 14 x 24 h back is
    // 23:30 EST on Mar 5, but the window starts at Mar 6 00:00 ET.
    const now = new Date('2027-03-20T04:30:00Z');
    const conn = fakeConn({
      submissions: [
        submission({ id: 'sub-old', read_status: 'none', created_at: new Date('2027-03-05T23:45:00-05:00') }),
        submission({ id: 'sub-in', read_status: 'none', created_at: new Date('2027-03-06T00:15:00-05:00') }),
      ],
      services: [svc({ scheduled_date: '2027-03-20' })],
    });
    expect((await selectCandidates(conn, now)).map((c) => c.submission_id)).toEqual(['sub-in']);
  });

  test('rows are checked least-recently-checked first, so newer rows are reached once old ones cool down', async () => {
    const conn = fakeConn({
      submissions: [
        submission({ id: 'sub-old', read_status: 'unsupported', created_at: new Date(NOW.getTime() - 3 * 3600 * 1000) }),
        submission({ id: 'sub-new', read_status: 'unsupported', created_at: new Date(NOW.getTime() - 1 * 3600 * 1000) }),
      ],
      services: [svc({ scheduled_date: TODAY_ET })],
      // The older row was checked 2 h ago (past the cooldown); the newer one never.
      activityLog: [{ action: 'visit_prep_read_sweep_check', created_at: new Date(NOW.getTime() - 2 * 3600 * 1000), metadata: { submissionId: 'sub-old' } }],
    });
    await selectCandidates(conn, NOW);
    const order = mockIsPestStop.mock.calls.map(([svcArg]) => svcArg.id);
    expect(order).toHaveLength(2);
    // Both rows share svc-1, so read the order off the check markers written.
    const checks = conn._store.activityLog.filter((r) => r.action === 'visit_prep_read_sweep_check').slice(1).map((r) => metaOf(r).submissionId);
    expect(checks).toEqual(['sub-new', 'sub-old']);
  });
});
