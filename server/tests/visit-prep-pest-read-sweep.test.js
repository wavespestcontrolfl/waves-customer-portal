/**
 * services/visit-prep-pest-read-sweep.js — GATE_VISIT_PREP_READ_SWEEP.
 * Pure/unit coverage against a small purpose-built chainable fake conn (same
 * convention as visit-prep-pest-read.test.js), with triggerVisitPrepPestRead
 * and isPestStop fully mocked — this suite is about CANDIDATE SELECTION and
 * the one-retry-per-row-per-case bound, not the engine/claim/cap machinery
 * itself (covered by visit-prep-pest-read.test.js).
 */

const mockTrigger = jest.fn(async () => undefined);
jest.mock('../services/visit-prep-pest-read', () => ({
  triggerVisitPrepPestRead: (...args) => mockTrigger(...args),
}));

const mockIsPestStop = jest.fn(async () => false);
jest.mock('../services/visit-prep-pest-applicability', () => ({
  isPestStop: (...args) => mockIsPestStop(...args),
}));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepReadSweepLive: () => mockGateOn,
}));

const {
  sweepVisitPrepPestReads,
  SWEEP_BATCH_LIMIT,
  _internal: { selectCandidates, SWEEP_CASE, SWEEP_ACTION },
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
    q.where = (col, op, val) => { q._wheres.push({ col: colKey(col), val }); return q; };
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
    q.where = (obj) => { q._action = obj?.action; return q; };
    q.whereRaw = (sql, bindings) => { q._caseValue = bindings[0]; return q; };
    q.whereIn = (_rawCol, vals) => { q._idsFilter = vals.map(String); return q; };
    q.pluck = async () => store.activityLog
      .filter((r) => r.action === q._action)
      .filter((r) => !q._caseValue || metaOf(r).case === q._caseValue)
      .filter((r) => !q._idsFilter || q._idsFilter.includes(String(metaOf(r).submissionId)))
      .map((r) => String(metaOf(r).submissionId));
    q.insert = async (row) => { store.activityLog.push(row); return [{ id: `gen-${store.activityLog.length}` }]; };
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

describe('candidate selection — case (a) stale pending', () => {
  test('a pending row stale past 15 minutes is a candidate', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'pending', created_at: new Date(NOW.getTime() - 16 * MIN) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    const candidates = await selectCandidates(conn, NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].caseLabel).toBe(SWEEP_CASE.STALE_PENDING);
  });

  test('a pending row NOT yet stale (< 15 minutes) is not a candidate', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'pending', created_at: new Date(NOW.getTime() - 5 * MIN) })],
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
    expect(candidates[0].caseLabel).toBe(SWEEP_CASE.RECLASSIFIED_PEST);
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

  test('a submission older than the 72h window is excluded', async () => {
    const conn = fakeConn({
      submissions: [submission({ read_status: 'none', created_at: new Date(NOW.getTime() - 73 * 3600 * 1000) })],
      services: [svc({ scheduled_date: TODAY_ET })],
    });
    expect(await selectCandidates(conn, NOW)).toHaveLength(0);
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

  test('a trigger failure for one row is logged and does not stop the rest of the batch', async () => {
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
    const result = await sweepVisitPrepPestReads(conn, NOW);
    expect(result.candidates).toBe(2);
    expect(result.retried).toBe(1); // one threw, one succeeded
    expect(mockTrigger).toHaveBeenCalledTimes(2);
  });
});
