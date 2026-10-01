/**
 * services/visit-prep-pest-read.js — PR 5, GATE_VISIT_PREP_PEST_READ.
 * Pure/unit coverage of triggerVisitPrepPestRead against a small chainable
 * fake conn (same convention as visit-prep-tech-facts.test.js) with a
 * mocked identifyPestV2 engine and a mocked PhotoService (no real S3, no
 * real vision call). visit-prep.js's own wiring (the fire-and-forget call
 * site, the submissionId/photos it hands this module) is covered in
 * visit-prep.test.js; this file is the trigger-rule/cap/gate/failure
 * matrix for the module itself.
 */

const mockIdentifyPestV2 = jest.fn();
jest.mock('../services/photo-id-v2/pest-engine', () => ({
  identifyPestV2: (...args) => mockIdentifyPestV2(...args),
}));

// The stop's member ids come from visit-prep.js techStopMemberIds (the
// technician's own physical-stop rule); stubbed per test.
const mockTechStopMemberIds = jest.fn(async (svc) => [svc.id]);
jest.mock('../services/visit-prep', () => ({
  techStopMemberIds: (...args) => mockTechStopMemberIds(...args),
}));

// The canonical stop lock (visit-groups.js); stubbed per test.
const mockLockStopForRow = jest.fn(async (trx, id) => id);
jest.mock('../services/visit-groups', () => ({
  lockStopForRow: (...args) => mockLockStopForRow(...args),
}));

const mockGetPhotoBase64 = jest.fn();
jest.mock('../services/photos', () => ({
  getPhotoBase64: (...args) => mockGetPhotoBase64(...args),
}));

let mockGateOn = true;
// "Not this read's stop" outcomes go back to the ONE dispatcher.
const mockDispatch = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-read-dispatch', () => ({
  dispatchVisitPrepRead: (...args) => mockDispatch(...args),
}));

// The plant gate is dark unless a test turns it on: with both live, a stop
// that also has a lawn / tree & shrub part is the combined read's, not this
// engine's (visit-prep-read-key.js).
let mockPlantLive = false;
jest.mock('../config/feature-gates', () => ({
  visitPrepPestReadLive: () => mockGateOn,
  visitPrepPlantReadLive: () => mockPlantLive,
}));

const { triggerVisitPrepPestRead: realTrigger, dailyCap, _internal } = require('../services/visit-prep-pest-read');

// The trigger re-reads the visit row from the DB; seed the fake with the svc
// a test passes unless the test already put that row there.
function triggerVisitPrepPestRead(args = {}) {
  const store = args.conn?._store;
  if (store && args.svc?.id && !store.scheduled_services.some((r) => r.id === args.svc.id)) {
    store.scheduled_services.push({ status: 'confirmed', visit_id: null, ...args.svc });
  }
  return realTrigger(args);
}

// A minimal chainable knex-ish stub, table-scoped, matching exactly the
// calls the module makes: where/whereIn (predicate accumulation) + select,
// count().first(), insert().returning(), and update() (recorded for
// assertions, also applied to the in-memory row so a later read in the
// SAME test sees it). `.raw()` is a plain pass-through marker — the
// module's cap query only needs a truthy value to chain on, not real SQL.
function fakeConn(tables = {}) {
  const store = { pest_identifications: [], scheduled_services: [], visit_prep_submissions: [], ...tables };
  // The submission under test exists and was sent today (claimReadSlot
  // only lets a same-ET-day submission claim).
  if (!store.visit_prep_submissions.some((r) => r.id === 'sub-1')) {
    store.visit_prep_submissions = [...store.visit_prep_submissions, { id: 'sub-1', created_at: new Date(), read_status: 'none' }];
  }
  const writes = [];
  let nextId = 1;

  const conn = (table) => {
    const q = { _where: {} };
    q.where = (a, b, c) => {
      if (typeof a === 'object') Object.assign(q._where, a);
      else q._where[a] = c !== undefined ? c : b; // (col, op, val) or (col, val) — value only, op ignored
      return q;
    };
    q.whereIn = (col, vals) => { q._whereIn = { col, vals }; return q; };
    q.forShare = () => q;
    q.forUpdate = () => q;
    const rowsMatching = () => (store[table] || []).filter((r) => {
      if (q._whereIn && !q._whereIn.vals.includes(r[q._whereIn.col])) return false;
      return Object.entries(q._where).every(([k, v]) => {
        if (k === 'created_at') return true; // date-window filtering is out of scope for this fake
        return r[k] === v;
      });
    });
    q.select = async () => rowsMatching();
    // Recorded so a test can see which rows the claim share-locked.
    const baseForShare = q.forShare;
    q.forShare = () => { (store._shareLocked = store._shareLocked || []).push(q._whereIn ? q._whereIn.vals : q._where.id); return baseForShare ? baseForShare() : q; };
    q.count = () => ({
      first: async () => ({ count: rowsMatching().length }),
    });
    // readsToday's Postgres attempt sum, computed the same way here.
    // (claim day: read_claimed_at today; a row with no claim stamp by its
    // submission day), computed the same way here.
    q.whereRaw = () => q;
    q.first = async (...cols) => {
      if (typeof cols[0] === 'string' && cols[0].includes('SUM(CASE')) {
        const day = jest.requireActual('../services/visit-prep-read-claim').etDayStart();
        const claimed = ['pending', 'done', 'failed'];
        const attemptsToday = (r) => {
          const n = Number(r.read_attempts) || 0;
          if (r.read_claimed_at) return new Date(r.read_claimed_at) >= day ? Math.max(n, 1) : 0;
          if (r.created_at && new Date(r.created_at) < day) return 0;
          return Math.max(n, claimed.includes(r.read_status) ? 1 : 0);
        };
        return { count: rowsMatching().reduce((sum, r) => sum + attemptsToday(r), 0) };
      }
      return rowsMatching()[0] || null;
    };
    q.insert = (row) => ({
      returning: async () => {
        const id = `gen-${nextId}`; nextId += 1;
        const stored = { id, ...row };
        store[table] = store[table] || [];
        store[table].push(stored);
        return [{ id }];
      },
    });
    q.update = async (patch) => {
      let matched = 0;
      writes.push({ table, where: { ...q._where }, patch });
      for (const row of (store[table] || [])) {
        if (q._whereIn && !q._whereIn.vals.includes(row[q._whereIn.col])) continue;
        if (Object.entries(q._where).every(([k, v]) => row[k] === v)) {
          // The release's GREATEST(read_attempts, 1), evaluated like Postgres.
          const applied = { ...patch };
          if (String(applied.read_attempts).includes('GREATEST(read_attempts, 1)')) applied.read_attempts = Math.max(Number(row.read_attempts) || 0, 1);
          Object.assign(row, applied);
          matched += 1;
        }
      }
      return matched;
    };
    return q;
  };
  conn.raw = (sql) => `RAW(${sql})`;
  // Transactions run on the same fake; the advisory lock is a no-op here.
  conn.transaction = async (fn) => fn(conn);
  conn._rawCalls = [];
  const baseRaw = conn.raw;
  conn.raw = (sql, bindings) => { conn._rawCalls.push({ sql, bindings }); return baseRaw(sql); };
  conn._store = store;
  conn._writes = writes;
  return conn;
}

function readStatusWrites(conn, submissionId) {
  return conn._writes.filter((w) => w.table === 'visit_prep_submissions' && w.where.id === submissionId).map((w) => w.patch);
}

const BASE_SVC = { id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', visit_id: null };
const PHOTOS = [{ s3Key: 'visitprep/a.jpg', mimeType: 'image/jpeg' }];

function okEngineResult(overrides = {}) {
  return {
    ok: true,
    v1: {
      species_slug: 'german-cockroach',
      service_line: 'pest',
      urgency: 'moderate',
      report_contract: {
        contract_version: 'pest_id_v1',
        identification: { slug: 'german-cockroach', category: 'pest_issue' },
        safety: {
          stinging: false, venomous: false, disease_vector: true, structural_threat: false,
        },
        observations: ['Two dark stripes behind the head'],
        distinguishing_features: ['A clear top-down photo'],
      },
    },
    v2: {
      answer: { wording: 'likely' },
      entry: { slug: 'german-cockroach', common_name: 'German cockroach' },
      referral: null,
    },
    internal: { models: {}, escalation_triggered: false },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Applicability is checked twice (pre-check and inside the claim).
  mockTechStopMemberIds.mockReset();
  mockTechStopMemberIds.mockImplementation(async (svc) => [svc.id]);
  mockLockStopForRow.mockReset();
  mockLockStopForRow.mockImplementation(async (trx, id) => id);
  mockGateOn = true;
  mockPlantLive = false;
  delete process.env.VISIT_PREP_READ_DAILY_CAP;
});

describe('gate', () => {
  test('gate off: no engine call, no write at all — read_status stays at its DB default', async () => {
    mockGateOn = false;
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(conn._writes).toHaveLength(0);
  });

  test('no photos: returns immediately, no write, gate on', async () => {
    const conn = fakeConn();
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: [], conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(conn._writes).toHaveLength(0);
  });
});

describe('trigger rule', () => {
  test('a pest visit: runs the engine', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Quarterly Pest Control' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
  });

  test('a lawn visit: unsupported, no engine call', async () => {
    const conn = fakeConn();
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Lawn Weed & Feed' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });

  test('grouped stop: pest if ANY LIVE member is pest, even when the requested row itself is lawn', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1',
      svc: {
        id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Weed & Feed', visit_id: 'visit-9',
      },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
  });

  test('the claim takes the canonical stop lock first, and a stop that keeps moving is refused (none), never read', async () => {
    const moved = Object.assign(new Error('visit stop moved concurrently — retry'), { code: 'VISIT_STOP_MOVED' });
    mockLockStopForRow.mockRejectedValue(moved);
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn });
    expect(mockLockStopForRow).toHaveBeenCalledTimes(3);
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'none' }]);
  });

  test('the claim share-locks every row of the stop, siblings included', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1',
      svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Weed & Feed', visit_id: 'visit-9' },
      photos: PHOTOS,
      conn,
    });
    expect(conn._store._shareLocked).toContainEqual(['svc-1', 'svc-2']);
  });

  test('grouped stop: a TERMINAL (cancelled) pest sibling does not count — unsupported', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'cancelled', visit_id: 'visit-9' },
      ],
    });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1',
      svc: {
        id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Weed & Feed', visit_id: 'visit-9',
      },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });
});

describe('trigger rule: moved siblings and topics', () => {
  test('a pest sibling that moved to another day or window (off the physical stop) does not count', async () => {
    // techStopMemberIds drops it even though it keeps the frozen visit_id.
    mockTechStopMemberIds.mockResolvedValue(['svc-1']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1',
      svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Weed & Feed', visit_id: 'visit-9' },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });

  test('a RESCHEDULED pest sibling (awaiting a new date) does not count', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'rescheduled', visit_id: 'visit-9' },
      ],
    });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1',
      svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Lawn Weed & Feed', visit_id: 'visit-9' },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test('the visit was reclassified to lawn after the upload: the fresh row wins, no engine call', async () => {
    const conn = fakeConn({ scheduled_services: [{ id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: null }] });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, id: 'svc-1', service_type: 'Quarterly Pest Control' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test('the visit was cancelled after the upload: no engine call', async () => {
    const conn = fakeConn({ scheduled_services: [{ id: 'svc-1', service_type: 'Quarterly Pest Control', status: 'cancelled', visit_id: null }] });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, id: 'svc-1', service_type: 'Quarterly Pest Control' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test.each([
    ['WDO Inspection Service', false],
    ['Waves Assessment', false],
    ['Termite Bait Monitoring', false],
    ['Quarterly Pest Control', true],
    ['One-Time Pest Treatment', true],
  ])('strict pest identity: %s → read=%s', async (serviceType, reads) => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: serviceType }, photos: PHOTOS, conn });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(reads ? 1 : 0);
  });

  test('reclassified to lawn between the pre-check and the claim: the locked claim refuses (unsupported, no engine call)', async () => {
    const conn = fakeConn();
    const realTx = conn.transaction;
    // The visit becomes a lawn visit just before the claim transaction runs.
    conn.transaction = async (fn) => {
      conn._store.scheduled_services.forEach((r) => { if (r.id === 'svc-1') r.service_type = 'Lawn Weed & Feed'; });
      return realTx(fn);
    };
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });

  test('a topic on the submission is not an input: a lawn visit stays unsupported', async () => {
    const conn = fakeConn();
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Lawn Weed & Feed' }, topic: 'pest', photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });
});

describe('daily cap (VISIT_PREP_READ_DAILY_CAP)', () => {
  test('default cap is 40', () => {
    expect(dailyCap()).toBe(40);
  });

  test('an invalid/zero env value falls back to the default', () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '0';
    expect(dailyCap()).toBe(40);
    process.env.VISIT_PREP_READ_DAILY_CAP = 'nope';
    expect(dailyCap()).toBe(40);
  });

  test('at the cap: failed, no engine call, photos are untouched (this module never touches photos)', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '2';
    // One done + one FAILED read today: an engine call that failed still
    // counts toward the cap (it cost a vision call).
    const conn = fakeConn({
      visit_prep_submissions: [
        { id: 'sub-a', read_status: 'done' },
        { id: 'sub-b', read_status: 'failed' },
        { id: 'sub-c', read_status: 'unsupported' },
      ],
    });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    // 'none': a cap rejection never claimed a slot, so it never counts.
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'none' }]);
  });

  test('under the cap: proceeds', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '2';
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-a', read_status: 'done' }, { id: 'sub-c', read_status: 'unsupported' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
    // The count and the pending claim ran under the cap's advisory lock.
    expect(conn._rawCalls.some((c) => /pg_advisory_xact_lock/.test(c.sql))).toBe(true);
  });

  test('a cap reached by OTHER submissions never blocks THEIR photos from being delivered — this module writes only read_status', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '1';
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-a', read_status: 'done' }, { id: 'sub-c', read_status: 'unsupported' }] });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    const patch = readStatusWrites(conn, 'sub-1')[0];
    expect(Object.keys(patch)).toEqual(['read_status']);
  });
});

describe('engine failure — never blocks the submission, always ends at failed', () => {
  test('identifyPestV2 throws', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockRejectedValue(new Error('vision provider down'));
    await expect(triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    })).resolves.toBe('failed');
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['pending', 'failed']);
  });

  test('identifyPestV2 returns { ok: false } (no_route / vision_unavailable)', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['pending', 'failed']);
  });

  test('S3 load throws: the engine is never called and the claim is released (none, not a counted failure)', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockRejectedValue(new Error('S3 unavailable'));
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    // Loaded before the claim: no slot was ever held.
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['none']);
  });

  test('storing the pest_identifications row throws: still resolves to failed, never throws out of the trigger', async () => {
    const base = fakeConn();
    // fakeConn returns a NEW builder object per call, so patch the table's
    // insert on every future call by wrapping the factory.
    const wrapped = (table) => {
      const q = base(table);
      if (table === 'pest_identifications') {
        q.insert = () => { throw new Error('insert failed'); };
      }
      return q;
    };
    wrapped.raw = base.raw;
    wrapped.transaction = async (fn) => fn(wrapped);
    wrapped._store = base._store;
    wrapped._writes = base._writes;
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await expect(triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn: wrapped,
    })).resolves.toBe('failed');
    expect(readStatusWrites(wrapped, 'sub-1').map((w) => w.read_status)).toEqual(['pending', 'failed']);
  });
});

describe('a successful read', () => {
  test('stores pest_identifications with source=visit_prep, mode=internal, and writes done + read_ref', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'base64bytes', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockGetPhotoBase64).toHaveBeenCalledWith('visitprep/a.jpg');
    const stored = conn._store.pest_identifications.find((r) => r.source === 'visit_prep');
    expect(stored).toBeTruthy();
    expect(stored.mode).toBe('internal');
    expect(stored.customer_id).toBe('cust-1');
    const writes = readStatusWrites(conn, 'sub-1');
    expect(writes[0]).toEqual({ read_status: 'pending', read_attempts: 1, read_claimed_at: expect.any(Date), read_ref: null, read_result: null });
    expect(writes[1].read_status).toBe('done');
    expect(writes[1].read_ref).toBe(stored.id);
  });
});

describe('_internal.isPestStop', () => {
  test('classifies via the shared service-line classifier', async () => {
    // The row is read from the database, not taken from the caller.
    const pest = fakeConn({ scheduled_services: [{ ...BASE_SVC, service_type: 'Quarterly Pest Control', status: 'confirmed' }] });
    expect(await _internal.isPestStop(BASE_SVC, pest)).toBe(true);
    const lawn = fakeConn({ scheduled_services: [{ ...BASE_SVC, service_type: 'Lawn Weed & Feed', status: 'confirmed' }] });
    expect(await _internal.isPestStop(BASE_SVC, lawn)).toBe(false);
  });
});

describe('_internal.etDayStart (cap day = America/New_York calendar day)', () => {
  test('8:30 PM ET on Sep 28 (00:30 UTC Sep 29) still counts from Sep 28 midnight ET', () => {
    const start = _internal.etDayStart(new Date('2026-09-29T00:30:00Z'));
    expect(start.toISOString()).toBe('2026-09-28T04:00:00.000Z');
  });

  test('winter (EST) offset', () => {
    const start = _internal.etDayStart(new Date('2026-12-15T15:00:00Z'));
    expect(start.toISOString()).toBe('2026-12-15T05:00:00.000Z');
  });
});

describe('unsupported never clobbers the other engine', () => {
  test('a lawn stop whose row a plant read already claimed (pending) stays pending', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', service_type: 'Lawn Weed & Feed', status: 'confirmed', visit_id: null }],
      visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'pending' }],
    });
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Lawn Weed & Feed' }, photos: PHOTOS, conn });
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('pending');
  });
});

describe('expected status (Codex #5319 r1 P1)', () => {
  test('a read that finished meanwhile is never re-claimed or re-run', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'done' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn, expectStatus: ['pending'] });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('done');
  });

  test('a stale pending row the caller expects is re-claimed and read', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'pending' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn, expectStatus: ['pending'] });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
  });

  test('a pre-claim write never overwrites a finished read (photo load fails after the original finished)', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'done' }] });
    mockGetPhotoBase64.mockRejectedValue(new Error('S3 down'));
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn, expectStatus: ['pending'] });
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('done');
  });
});

describe('claim day (Codex #5320 r12): the cap counts the day a read runs', () => {
  test('an older submission (the recovery sweep re-reading it) claims, and its attempt counts on today\'s cap', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(Date.now() - 36 * 3600 * 1000), read_status: 'none' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue({ ok: false, reason: 'blurry' });
    await triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
    const { readsToday } = jest.requireActual('../services/visit-prep-read-claim');
    expect(await readsToday(conn)).toBe(1);
  });

  test('with today\'s cap already spent, an older submission is refused like any other', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '1';
    try {
      const conn = fakeConn({ visit_prep_submissions: [
        { id: 'sub-0', created_at: new Date(Date.now() - 72 * 3600 * 1000), read_status: 'done', read_attempts: 1, read_claimed_at: new Date() },
        { id: 'sub-1', created_at: new Date(Date.now() - 36 * 3600 * 1000), read_status: 'none' },
      ] });
      mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
      await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('capped');
      expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    } finally {
      delete process.env.VISIT_PREP_READ_DAILY_CAP;
    }
  });

  test('an attempt claimed on an earlier day no longer counts today', async () => {
    const conn = fakeConn({ visit_prep_submissions: [
      { id: 'sub-0', created_at: new Date(), read_status: 'done', read_attempts: 1, read_claimed_at: new Date(Date.now() - 48 * 3600 * 1000) },
    ] });
    const { readsToday } = jest.requireActual('../services/visit-prep-read-claim');
    // sub-1 (seeded unclaimed today) and sub-0 (claimed two days ago) — nothing today.
    expect(await readsToday(conn)).toBe(0);
  });
});



describe('the stop changes line (Codex #5320 r7–r9): back to the dispatcher, never to the other engine', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const retype = (conn, type) => conn._store.scheduled_services.forEach((r) => { if (r.id === 'svc-1') r.service_type = type; });
  beforeEach(async () => { await tick(); mockDispatch.mockClear(); });

  test('reclassified to lawn under the lock: unsupported, re-dispatched', async () => {
    const conn = fakeConn();
    const realTx = conn.transaction;
    conn.transaction = async (fn) => { retype(conn, 'Lawn Weed & Feed'); return realTx(fn); };
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('unsupported');
    await tick();
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', photos: PHOTOS, conn, dispatches: 1 }));
  });

  test('pest → lawn while the engine runs: nothing stored, claim released, re-dispatched', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockImplementationOnce(async () => { retype(conn, 'Lawn Weed & Feed'); return okEngineResult(); });
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    await tick();
    expect(conn._store.pest_identifications).toHaveLength(0);
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('none');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('an engine miss on a stop that changed is released and re-dispatched, not left failed', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockImplementationOnce(async () => { retype(conn, 'Lawn Weed & Feed'); return { ok: false, reason: 'no_route' }; });
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    await tick();
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('none');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('trigger outcome', () => {
  test('reports done on success, failed when the engine throws, skipped with the gate off', async () => {
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValueOnce(okEngineResult());
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('done');
    mockIdentifyPestV2.mockRejectedValueOnce(new Error('down'));
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('failed');
    mockGateOn = false;
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('skipped');
  });
});

describe('a stop that will not hold still while the read settles (Codex #5320 r10)', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  beforeEach(async () => { await tick(); mockDispatch.mockClear(); });

  test('VISIT_STOP_MOVED on every settle attempt releases the paid read and re-dispatches, never failed', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPestV2.mockResolvedValue(okEngineResult());
    // The claim's lock succeeds; every settle attempt finds the stop moved.
    let calls = 0;
    mockLockStopForRow.mockImplementation(async (trx, id) => {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error('moved'), { code: 'VISIT_STOP_MOVED' });
      return id;
    });
    await expect(triggerVisitPrepPestRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    await tick();
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('none');
    expect(conn._store.pest_identifications).toHaveLength(0);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('a released read stays counted even when it predates read_attempts (pre-push audit P1)', () => {
  test('a legacy pending row (attempts 0) released on a changed stop keeps one attempt counted', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'pending', read_attempts: 0 }] });
    const { settleClaimedRead, readsToday } = jest.requireActual('../services/visit-prep-read-claim');
    const out = await settleClaimedRead(conn, 'sub-1', BASE_SVC, { applicable: async () => false, matches: Boolean, store: async () => {} });
    expect(out).toBe('changed');
    expect(conn._store.visit_prep_submissions[0]).toMatchObject({ read_status: 'none', read_attempts: 1 });
    expect(await readsToday(conn)).toBe(1);
  });
});
