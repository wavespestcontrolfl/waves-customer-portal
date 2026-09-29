/**
 * services/visit-prep-plant-read.js — GATE_VISIT_PREP_PLANT_READ, sibling
 * of visit-prep-pest-read.test.js. Pure/unit coverage against a small
 * chainable fake conn (same convention as the pest read's own suite) with
 * a mocked identifyPlantV2 engine and a mocked PhotoService (no real S3, no
 * real vision call). The applicability module itself
 * (visit-prep-plant-applicability.js) is NOT mocked — it runs for real
 * against the fake conn's scheduled_services rows, same as the pest
 * suite's own _internal.isPestStop coverage.
 */

const mockIdentifyPlantV2 = jest.fn();
jest.mock('../services/photo-id-v2/plant-engine', () => ({
  identifyPlantV2: (...args) => mockIdentifyPlantV2(...args),
}));

const mockTechStopMemberIds = jest.fn(async (svc) => [svc.id]);
jest.mock('../services/visit-prep', () => ({
  techStopMemberIds: (...args) => mockTechStopMemberIds(...args),
}));

const mockLockStopForRow = jest.fn(async (trx, id) => id);
jest.mock('../services/visit-groups', () => ({
  lockStopForRow: (...args) => mockLockStopForRow(...args),
}));

const mockGetPhotoBase64 = jest.fn();
jest.mock('../services/photos', () => ({
  getPhotoBase64: (...args) => mockGetPhotoBase64(...args),
}));

// "Not this read's stop" outcomes go back to the ONE dispatcher.
const mockDispatch = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-read-dispatch', () => ({
  dispatchVisitPrepRead: (...args) => mockDispatch(...args),
}));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepPlantReadLive: () => mockGateOn,
}));

const { triggerVisitPrepPlantRead: realTrigger, dailyCap, _internal } = require('../services/visit-prep-plant-read');

function triggerVisitPrepPlantRead(args = {}) {
  const store = args.conn?._store;
  if (store && args.svc?.id && !store.scheduled_services.some((r) => r.id === args.svc.id)) {
    store.scheduled_services.push({ status: 'confirmed', visit_id: null, ...args.svc });
  }
  return realTrigger(args);
}

// Same minimal chainable knex-ish stub as visit-prep-pest-read.test.js
// (table-scoped where/whereIn + select, count().first(), insert().returning(),
// update()), adapted for read_result instead of a second table.
function fakeConn(tables = {}) {
  const store = {
    pest_identifications: [], scheduled_services: [], visit_prep_submissions: [], ...tables,
  };
  if (!store.visit_prep_submissions.some((r) => r.id === 'sub-1')) {
    store.visit_prep_submissions = [...store.visit_prep_submissions, { id: 'sub-1', created_at: new Date(), read_status: 'none' }];
  }
  const writes = [];
  let nextId = 1;

  const conn = (table) => {
    const q = { _where: {} };
    q.where = (a, b, c) => {
      if (typeof a === 'object') Object.assign(q._where, a);
      else q._where[a] = c !== undefined ? c : b;
      return q;
    };
    q.whereIn = (col, vals) => { q._whereIn = { col, vals }; return q; };
    q.forShare = () => q;
    const rowsMatching = () => (store[table] || []).filter((r) => {
      if (q._whereIn && !q._whereIn.vals.includes(r[q._whereIn.col])) return false;
      return Object.entries(q._where).every(([k, v]) => {
        if (k === 'created_at') return true;
        return r[k] === v;
      });
    });
    q.select = async () => rowsMatching();
    const baseForShare = q.forShare;
    q.forShare = () => { (store._shareLocked = store._shareLocked || []).push(q._whereIn ? q._whereIn.vals : q._where.id); return baseForShare ? baseForShare() : q; };
    q.count = () => ({ first: async () => ({ count: rowsMatching().length }) });
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

const BASE_SVC = {
  id: 'svc-1', customer_id: 'cust-1', service_type: 'Weekly Lawn Care', visit_id: null,
};
const PHOTOS = [{ s3Key: 'visitprep/a.jpg', mimeType: 'image/jpeg' }];

function okEngineResult(overrides = {}) {
  return {
    ok: true,
    v2: {
      version: 2,
      kind: 'workup',
      subject_type: 'lawn',
      answer: { level: 'entry', wording: 'likely', headline: 'Likely: Brown Patch' },
      subject: { plant: { common_name: 'St. Augustinegrass' }, weeds: [] },
      possibilities: [{
        common_name: 'Brown Patch', fits: ['Roughly circular brown patch'], not_yet: ['A smoke-ring edge'], safety_line: null, safety: null,
      }],
      next_step_hint: { kind: 'inspection', text: 'A technician checks this on your next visit.' },
      referral: null,
    },
    internal: { models: {}, escalation_triggered: false },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTechStopMemberIds.mockReset();
  mockTechStopMemberIds.mockImplementation(async (svc) => [svc.id]);
  mockLockStopForRow.mockReset();
  mockLockStopForRow.mockImplementation(async (trx, id) => id);
  mockGateOn = true;
  delete process.env.VISIT_PREP_READ_DAILY_CAP;
});

describe('gate', () => {
  test('gate off: no engine call, no write at all', async () => {
    mockGateOn = false;
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(conn._writes).toHaveLength(0);
  });

  test('no photos: returns immediately, no write, gate on', async () => {
    const conn = fakeConn();
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: [], conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(conn._writes).toHaveLength(0);
  });
});

describe('trigger rule', () => {
  test('a lawn visit: runs the engine with subject=lawn', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Weekly Lawn Care' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2.mock.calls[0][0].subject).toBe('lawn');
  });

  test('a tree & shrub visit: runs the engine with subject=tree_shrub', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult({ v2: { ...okEngineResult().v2, subject_type: 'tree_shrub' } }));
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Tree & Shrub Care' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2.mock.calls[0][0].subject).toBe('tree_shrub');
  });

  test('a pest visit: unsupported, no engine call — pest wins', async () => {
    const conn = fakeConn();
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: 'Quarterly Pest Control' }, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });

  test.each([
    ['WDO Inspection Service', false],
    ['Waves Assessment', false],
    ['Termite Bait Monitoring', false],
    ['Weekly Lawn Care', true],
    ['Tree & Shrub Fertilization', true],
  ])('strict lawn/tree_shrub identity: %s → read=%s', async (serviceType, reads) => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: { ...BASE_SVC, service_type: serviceType }, photos: PHOTOS, conn });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(reads ? 1 : 0);
  });

  test('grouped stop: pest wins even when the requested row itself is lawn', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Weekly Lawn Care', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Quarterly Pest Control', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1',
      svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Weekly Lawn Care', visit_id: 'visit-9' },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'unsupported' }]);
  });

  test('grouped stop: lawn if a live lawn sibling exists even when the requested row is tree & shrub', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Tree & Shrub Care', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Weekly Lawn Care', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1',
      svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Tree & Shrub Care', visit_id: 'visit-9' },
      photos: PHOTOS,
      conn,
    });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2.mock.calls[0][0].subject).toBe('lawn');
  });

  test('the claim takes the canonical stop lock first, and a stop that keeps moving is refused (none), never read', async () => {
    const moved = Object.assign(new Error('visit stop moved concurrently — retry'), { code: 'VISIT_STOP_MOVED' });
    mockLockStopForRow.mockRejectedValue(moved);
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn });
    expect(mockLockStopForRow).toHaveBeenCalledTimes(3);
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'none' }]);
  });
});

describe('daily cap (VISIT_PREP_READ_DAILY_CAP) — shared with the pest read', () => {
  test('default cap is 40', () => {
    expect(dailyCap()).toBe(40);
  });

  test('an invalid/zero env value falls back to the default', () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '0';
    expect(dailyCap()).toBe(40);
  });

  test('the cap counts submissions regardless of which engine produced them (a pest-only fixture row still counts)', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '2';
    const conn = fakeConn({
      visit_prep_submissions: [
        { id: 'sub-a', read_status: 'done', read_ref: 'pi-1' }, // a pest read
        { id: 'sub-b', read_status: 'failed' },
      ],
    });
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1')).toEqual([{ read_status: 'none' }]);
  });

  test('under the cap: proceeds, using the SAME advisory lock key the pest read uses', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '2';
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-a', read_status: 'done' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(conn._rawCalls.some((c) => /pg_advisory_xact_lock/.test(c.sql) && c.bindings[0] === 'visit-prep-pest-read-cap')).toBe(true);
  });
});

describe('engine failure — never blocks the submission, always ends at failed', () => {
  test('identifyPlantV2 throws', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockRejectedValue(new Error('vision provider down'));
    await expect(triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    })).resolves.toBe('failed');
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['pending', 'failed']);
  });

  test('identifyPlantV2 returns { ok: false }', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['pending', 'failed']);
  });

  test('S3 load throws: the engine is never called and the claim is released (none, not a counted failure)', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockRejectedValue(new Error('S3 unavailable'));
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(readStatusWrites(conn, 'sub-1').map((w) => w.read_status)).toEqual(['none']);
  });
});

describe('a successful read', () => {
  test('writes done + read_result (v2 + internal + subject_type), never touching read_ref', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'base64bytes', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue(okEngineResult());
    await triggerVisitPrepPlantRead({
      submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn,
    });
    expect(mockGetPhotoBase64).toHaveBeenCalledWith('visitprep/a.jpg');
    const writes = readStatusWrites(conn, 'sub-1');
    // The claim stamps the engine marker so the display knows who owns it.
    expect(writes[0]).toEqual({
      read_status: 'pending', read_attempts: 1, read_claimed_at: expect.any(Date), read_result: JSON.stringify({ engine: 'plant', subject_type: 'lawn' }),
    });
    expect(writes[1].read_status).toBe('done');
    const stored = JSON.parse(writes[1].read_result);
    expect(stored.subject_type).toBe('lawn');
    expect(stored.v2.possibilities[0].common_name).toBe('Brown Patch');
    expect(Object.keys(writes[1])).not.toContain('read_ref');
  });
});

describe('_internal.resolveApplicability', () => {
  test('classifies lawn, tree_shrub and unsupported via the strict predicates', async () => {
    const lawn = fakeConn({ scheduled_services: [{ ...BASE_SVC, service_type: 'Weekly Lawn Care', status: 'confirmed' }] });
    expect(await _internal.resolveApplicability(BASE_SVC, lawn)).toBe('lawn');
    const shrub = fakeConn({ scheduled_services: [{ ...BASE_SVC, service_type: 'Tree & Shrub Care', status: 'confirmed' }] });
    expect(await _internal.resolveApplicability(BASE_SVC, shrub)).toBe('tree_shrub');
    const pest = fakeConn({ scheduled_services: [{ ...BASE_SVC, service_type: 'Quarterly Pest Control', status: 'confirmed' }] });
    expect(await _internal.resolveApplicability(BASE_SVC, pest)).toBe('unsupported');
  });
});

describe('claim day (Codex #5320 r12): the cap counts the day a read runs', () => {
  test('an older submission (the recovery sweep re-reading it) claims, and its attempt counts on today\'s cap', async () => {
    const conn = fakeConn({ visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(Date.now() - 36 * 3600 * 1000), read_status: 'none' }] });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue({ ok: false, reason: 'blurry' });
    await triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
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
      await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('capped');
      expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
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

describe('one engine per row (Codex #5320 r1)', () => {
  test('a row the pest read already claimed is never claimed again (no plant engine call)', async () => {
    const conn = fakeConn({
      scheduled_services: [{ id: 'svc-1', service_type: 'Weekly Lawn Care', status: 'confirmed', visit_id: null }],
      visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'pending' }],
    });
    mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
    await triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: { id: 'svc-1', customer_id: 'cust-1', service_type: 'Weekly Lawn Care', visit_id: null }, photos: PHOTOS, conn });
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('pending');
  });
});

describe('service labels (Codex #5320 r2/r5: the canonical classifier)', () => {
  test.each([
    ['WDO Inspection Service'], ['Quarterly Pest Control'], ['Lawn + Pest Combo'], ['Lawn & Pest Program'], ['Palm Injection Service'], ['Termite Bait Monitoring'],
  ])('%s is never a plant read', (label) => {
    const { isTreeShrubOnlyServiceType: ts, isLawnOnlyServiceType: lawn } = require('../services/visit-prep-plant-applicability');
    expect(ts(label) || lawn(label)).toBe(false);
  });

  const { isTreeShrubOnlyServiceType, isLawnOnlyServiceType } = require('../services/visit-prep-plant-applicability');
  test.each([
    ['Quarterly Trees & Shrubs', 'tree_shrub'],
    ['Tree & Shrub Care', 'tree_shrub'],
    ['Weekly Lawn Care', 'lawn'],
    ['Lawns Program', 'lawn'],
    ['lawn_care', 'lawn'],
    ['tree_shrub', 'tree_shrub'],
    ['Weed Control Service', 'lawn'],
    ['Sod Replacement', 'lawn'],
    ['Ornamental Care Program', 'tree_shrub'],
    ['Lawn Pest Control', 'lawn'],
    ['Lawn Pest Knockdown Service', 'lawn'],
  ])('%s → %s', (label, kind) => {
    expect(kind === 'tree_shrub' ? isTreeShrubOnlyServiceType(label) : isLawnOnlyServiceType(label)).toBe(true);
  });
});



describe('released attempts still count against the daily cap (Codex #5320 r8 audit)', () => {
  test('cap 1: a read released because the stop changed mid-read keeps its slot, so the re-dispatched read is capped', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '1';
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockImplementation(async () => {
      conn._store.scheduled_services.forEach((r) => { if (r.id === 'svc-1') r.service_type = 'Tree & Shrub Care'; });
      return okEngineResult();
    });
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    const row = conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1');
    expect(row.read_status).toBe('none');
    expect(row.read_attempts).toBe(1);
    // The re-dispatch, run by hand: the day's one slot is already spent.
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('capped');
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
  });

  test('readsToday sums attempts, and counts a claimed row with no attempts recorded (pre-column) once', async () => {
    const { readsToday } = require('../services/visit-prep-read-claim');
    const conn = fakeConn({
      visit_prep_submissions: [
        { id: 'a', read_status: 'done', read_attempts: 0 },
        { id: 'b', read_status: 'none', read_attempts: 1 },
        { id: 'c', read_status: 'done', read_attempts: 2 },
        { id: 'd', read_status: 'unsupported', read_attempts: 0 },
      ],
    });
    // sub-1 is seeded at 'none' with no attempts.
    expect(await readsToday(conn)).toBe(4);
  });
});

describe('the stop changes line or subject (Codex #5320 r7–r9): back to the dispatcher, never to the other engine', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const retype = (conn, type) => conn._store.scheduled_services.forEach((r) => { if (r.id === 'svc-1') r.service_type = type; });
  beforeEach(async () => { await tick(); mockDispatch.mockClear(); });

  test('a pest stop at the locked claim: unsupported, no engine call, re-dispatched with the dispatch count', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    const svc = { ...BASE_SVC, service_type: 'Quarterly Pest Control' };
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc, photos: PHOTOS, conn, dispatches: 2 })).resolves.toBe('unsupported');
    await tick();
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', photos: PHOTOS, conn, dispatches: 2 }));
    expect(mockDispatch.mock.calls[0][0]).not.toHaveProperty('expectStatus');
  });

  test('lawn → tree & shrub while the engine runs: the lawn result is not stored, the claim released, the stop re-dispatched', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockImplementation(async () => { retype(conn, 'Tree & Shrub Care'); return okEngineResult(); });
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    await tick();
    const row = conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1');
    expect(row.read_status).toBe('none');
    expect(row.read_result).toBeNull();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('an engine FAILURE on a stop that changed is released and re-dispatched too, never left failed under the old subject', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockImplementation(async () => { retype(conn, 'Quarterly Pest Control'); throw new Error('vision provider down'); });
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('changed');
    await tick();
    expect(conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1').read_status).toBe('none');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a failure on an unchanged stop settles failed with the plant marker, no re-dispatch', async () => {
    const conn = fakeConn();
    mockGetPhotoBase64.mockResolvedValue({ data: 'b64', mimeType: 'image/jpeg' });
    mockIdentifyPlantV2.mockResolvedValue({ ok: false, reason: 'blurry' });
    await expect(triggerVisitPrepPlantRead({ submissionId: 'sub-1', svc: BASE_SVC, photos: PHOTOS, conn })).resolves.toBe('failed');
    await tick();
    const row = conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1');
    expect(row.read_status).toBe('failed');
    expect(JSON.parse(row.read_result)).toEqual({ engine: 'plant', subject_type: 'lawn' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
