/**
 * services/visit-prep-combo-read.js — the combined Lawn & Pest read (owner
 * ruling 2026-09-30): ONE claim (weight 2 on the shared daily cap), both
 * engines over the same photos, ONE settle. Same chainable fake conn and mocked
 * engines / photo service as visit-prep-pest-read.test.js; the applicability
 * and read-key modules run for real over the fake conn's scheduled_services.
 */

const mockIdentifyPestV2 = jest.fn();
jest.mock('../services/photo-id-v2/pest-engine', () => ({
  identifyPestV2: (...args) => mockIdentifyPestV2(...args),
}));
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

const mockDispatch = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-read-dispatch', () => ({
  dispatchVisitPrepRead: (...args) => mockDispatch(...args),
}));

let mockPestLive = true;
let mockPlantLive = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepPestReadLive: () => mockPestLive,
  visitPrepPlantReadLive: () => mockPlantLive,
}));

const { triggerVisitPrepComboRead: realTrigger, COMBO_WEIGHT } = require('../services/visit-prep-combo-read');
const { dailyCap } = require('../services/visit-prep-read-claim');

function triggerVisitPrepComboRead(args = {}) {
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

const COMBINED_SVC = {
  id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control Service + Lawn Care Service', visit_id: null,
};
const PHOTOS = [{ s3Key: 'visitprep/a.jpg', mimeType: 'image/jpeg' }];

function okPest() {
  return {
    ok: true,
    v1: {
      species_slug: 'german-cockroach',
      service_line: 'pest',
      urgency: 'moderate',
      report_contract: {
        contract_version: 'pest_id_v1',
        identification: { slug: 'german-cockroach', category: 'pest_issue' },
        safety: { stinging: false, venomous: false, disease_vector: true, structural_threat: false },
        observations: ['Two dark stripes behind the head'],
      },
    },
    v2: { answer: { wording: 'likely' }, entry: { slug: 'german-cockroach', common_name: 'German cockroach' }, referral: null },
    internal: { models: {}, escalation_triggered: false },
  };
}

function okPlant() {
  return {
    ok: true,
    v2: {
      version: 2,
      kind: 'workup',
      subject_type: 'lawn',
      answer: { level: 'entry', wording: 'likely', headline: 'Likely: Brown Patch' },
      subject: { plant: { common_name: 'St. Augustinegrass' }, weeds: [] },
      possibilities: [{ common_name: 'Brown Patch', fits: ['Roughly circular brown patch'], not_yet: [], safety_line: null, safety: null }],
      next_step_hint: { kind: 'inspection', text: 'A technician checks this on your next visit.' },
      referral: null,
    },
    internal: { models: {}, escalation_triggered: false },
  };
}

const submissionRow = (conn) => conn._store.visit_prep_submissions.find((r) => r.id === 'sub-1');
const parsedResult = (conn) => JSON.parse(submissionRow(conn).read_result);
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  await tick();
  jest.clearAllMocks();
  mockTechStopMemberIds.mockReset();
  mockTechStopMemberIds.mockImplementation(async (svc) => [svc.id]);
  mockLockStopForRow.mockReset();
  mockLockStopForRow.mockImplementation(async (trx, id) => id);
  mockPestLive = true;
  mockPlantLive = true;
  mockGetPhotoBase64.mockResolvedValue({ data: 'x', mimeType: 'image/jpeg' });
  mockIdentifyPestV2.mockResolvedValue(okPest());
  mockIdentifyPlantV2.mockResolvedValue(okPlant());
  delete process.env.VISIT_PREP_READ_DAILY_CAP;
});

const run = (conn, svc = COMBINED_SVC, extra = {}) => triggerVisitPrepComboRead({
  submissionId: 'sub-1', svc, photos: PHOTOS, conn, ...extra,
});

describe('both shapes run both engines under one claim', () => {
  test('(a) one combined service_type: both engines, one photo load, done with both parts', async () => {
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('done');
    expect(mockGetPhotoBase64).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2.mock.calls[0][0].subject).toBe('lawn');
    const row = submissionRow(conn);
    expect(row.read_status).toBe('done');
    // the pest part is stored as the pest read stores it, and read_ref points at it
    const ident = conn._store.pest_identifications;
    expect(ident).toHaveLength(1);
    expect(ident[0]).toMatchObject({ mode: 'internal', source: 'visit_prep', species_slug: 'german-cockroach' });
    expect(row.read_ref).toBe(ident[0].id);
    expect(parsedResult(conn)).toMatchObject({
      engine: 'combo',
      subject_type: 'lawn',
      pest: { status: 'done' },
      plant: { status: 'done', v2: { subject_type: 'lawn' }, internal: { escalation_triggered: false } },
    });
  });

  test('(b) separate pest-only and lawn-only members on the stop', async () => {
    mockTechStopMemberIds.mockResolvedValue(['svc-1', 'svc-2']);
    const conn = fakeConn({
      scheduled_services: [
        { id: 'svc-1', service_type: 'Quarterly Pest Control Service', status: 'confirmed', visit_id: 'visit-9' },
        { id: 'svc-2', service_type: 'Lawn Care Service', status: 'confirmed', visit_id: 'visit-9' },
      ],
    });
    const svc = { id: 'svc-1', customer_id: 'cust-1', service_type: 'Quarterly Pest Control Service', visit_id: 'visit-9' };
    await expect(run(conn, svc)).resolves.toBe('done');
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
    expect(parsedResult(conn)).toMatchObject({ engine: 'combo', subject_type: 'lawn' });
  });

  test('a tree & shrub combination reads the tree_shrub subject', async () => {
    const conn = fakeConn();
    const svc = { ...COMBINED_SVC, service_type: 'Pest Control Service + Tree & Shrub Care' };
    await run(conn, svc);
    expect(mockIdentifyPlantV2.mock.calls[0][0].subject).toBe('tree_shrub');
    expect(parsedResult(conn).subject_type).toBe('tree_shrub');
  });

  test('the claim stamps the combo marker + subject while pending (before the engines answer)', async () => {
    const conn = fakeConn();
    let seen;
    mockIdentifyPestV2.mockImplementation(async () => { seen = { ...submissionRow(conn) }; return okPest(); });
    await run(conn);
    expect(seen.read_status).toBe('pending');
    expect(JSON.parse(seen.read_result)).toEqual({ engine: 'combo', subject_type: 'lawn' });
  });
});

describe('gates', () => {
  test.each([
    ['pest gate dark', () => { mockPestLive = false; }],
    ['plant gate dark', () => { mockPlantLive = false; }],
  ])('%s: skipped, nothing touched (the dispatcher sends a one-gate combo to the single live engine)', async (_name, dark) => {
    dark();
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('skipped');
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(conn._writes).toEqual([]);
  });

  test('a stop that is not a combo: unsupported, no engine call, handed back to the dispatcher', async () => {
    const conn = fakeConn();
    await expect(run(conn, { ...COMBINED_SVC, service_type: 'Quarterly Pest Control Service' })).resolves.toBe('unsupported');
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(submissionRow(conn).read_status).toBe('unsupported');
    await tick();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test.each(['Pest & Mosquito', 'Pest + Termite', 'Lawn Care + Rodent Exclusion', 'Pest + Palm Injection'])(
    '%s is not a Lawn & Pest combo: unsupported here',
    async (label) => {
      const conn = fakeConn();
      await expect(run(conn, { ...COMBINED_SVC, service_type: label })).resolves.toBe('unsupported');
      expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    },
  );

  test('no photos / no submission: skipped', async () => {
    await expect(realTrigger({ submissionId: 'sub-1', svc: COMBINED_SVC, photos: [], conn: fakeConn() })).resolves.toBe('skipped');
    await expect(realTrigger({ svc: COMBINED_SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('skipped');
  });

  test('a photo-load failure never claims a slot: read_status none', async () => {
    mockGetPhotoBase64.mockRejectedValue(new Error('s3 down'));
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('error');
    expect(submissionRow(conn)).toMatchObject({ read_status: 'none' });
    expect(submissionRow(conn).read_attempts).toBeUndefined();
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });
});

describe('partial failure: one side failing never throws away the other', () => {
  test('pest fails, plant ok: done, pest marked failed, no identification row, plant kept', async () => {
    mockIdentifyPestV2.mockResolvedValue({ ok: false, reason: 'vision_unavailable' });
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('done');
    expect(submissionRow(conn)).toMatchObject({ read_status: 'done', read_ref: null });
    expect(conn._store.pest_identifications).toHaveLength(0);
    expect(parsedResult(conn)).toMatchObject({ pest: { status: 'failed' }, plant: { status: 'done', v2: { subject_type: 'lawn' } } });
  });

  test('plant fails, pest ok: done, plant marked failed, pest identification stored', async () => {
    mockIdentifyPlantV2.mockResolvedValue({ ok: false });
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('done');
    expect(conn._store.pest_identifications).toHaveLength(1);
    expect(submissionRow(conn).read_ref).toBe(conn._store.pest_identifications[0].id);
    const result = parsedResult(conn);
    expect(result).toMatchObject({ engine: 'combo', pest: { status: 'done' }, plant: { status: 'failed' } });
    expect(result.plant.v2).toBeUndefined();
  });

  test('an engine that THROWS is a miss for that part only', async () => {
    mockIdentifyPestV2.mockRejectedValue(new Error('boom'));
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('done');
    expect(parsedResult(conn)).toMatchObject({ pest: { status: 'failed' }, plant: { status: 'done' } });
    expect(mockIdentifyPlantV2).toHaveBeenCalledTimes(1);
  });

  test('both fail: failed, with the combo marker and both parts marked failed', async () => {
    mockIdentifyPestV2.mockResolvedValue({ ok: false });
    mockIdentifyPlantV2.mockRejectedValue(new Error('boom'));
    const conn = fakeConn();
    await expect(run(conn)).resolves.toBe('failed');
    expect(submissionRow(conn)).toMatchObject({ read_status: 'failed', read_ref: null });
    expect(parsedResult(conn)).toEqual({
      engine: 'combo', subject_type: 'lawn', pest: { status: 'failed' }, plant: { status: 'failed' },
    });
    expect(conn._store.pest_identifications).toHaveLength(0);
  });

  test('storing the pest identification throws: the row ends failed (never stuck pending), never throws out', async () => {
    const conn = fakeConn();
    const base = conn;
    const wrapped = (table) => {
      if (table === 'pest_identifications') throw new Error('insert failed');
      return base(table);
    };
    Object.assign(wrapped, base);
    wrapped.transaction = async (fn) => fn(wrapped);
    await expect(run(wrapped)).resolves.toBe('failed');
    expect(submissionRow(base)).toMatchObject({ read_status: 'failed' });
  });
});

describe('daily cap: a combo read spends two vision calls and is counted as 2', () => {
  test('the claim adds COMBO_WEIGHT to read_attempts', async () => {
    expect(COMBO_WEIGHT).toBe(2);
    const conn = fakeConn();
    await run(conn);
    expect(submissionRow(conn).read_attempts).toBe(2);
  });

  test('other reads today count toward it: 38 used + 2 = exactly the cap of 40 is allowed', async () => {
    const conn = fakeConn({
      visit_prep_submissions: [{ id: 'other', created_at: new Date(), read_claimed_at: new Date(), read_status: 'done', read_attempts: 38 }],
    });
    await expect(run(conn)).resolves.toBe('done');
  });

  test('39 used: a single read would fit but the two-call combo does not, so it is capped (none, no engine call)', async () => {
    const conn = fakeConn({
      visit_prep_submissions: [{ id: 'other', created_at: new Date(), read_claimed_at: new Date(), read_status: 'done', read_attempts: 39 }],
    });
    expect(dailyCap()).toBe(40);
    await expect(run(conn)).resolves.toBe('capped');
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
    expect(mockIdentifyPlantV2).not.toHaveBeenCalled();
    expect(submissionRow(conn)).toMatchObject({ read_status: 'none' });
    expect(submissionRow(conn).read_attempts).toBeUndefined();
  });

  test('a finished combo read counts 2 against the next claimer', async () => {
    process.env.VISIT_PREP_READ_DAILY_CAP = '3';
    const conn = fakeConn({
      visit_prep_submissions: [{ id: 'sub-1', created_at: new Date(), read_status: 'none' }, { id: 'sub-2', created_at: new Date(), read_status: 'none' }],
    });
    await expect(run(conn)).resolves.toBe('done'); // 0 + 2 <= 3
    await expect(triggerVisitPrepComboRead({ submissionId: 'sub-2', svc: COMBINED_SVC, photos: PHOTOS, conn })).resolves.toBe('capped'); // 2 + 2 > 3
  });
});

describe('the stop changes while the engines run: released and re-dispatched, never stored', () => {
  test('a combo that lost its lawn part: nothing stored, claim released (attempts kept), re-dispatched', async () => {
    const conn = fakeConn();
    mockIdentifyPlantV2.mockImplementation(async () => {
      conn._store.scheduled_services.find((r) => r.id === 'svc-1').service_type = 'Quarterly Pest Control Service';
      return okPlant();
    });
    await expect(run(conn)).resolves.toBe('changed');
    expect(conn._store.pest_identifications).toHaveLength(0);
    expect(submissionRow(conn)).toMatchObject({ read_status: 'none', read_result: null, read_ref: null, read_attempts: 2 });
    await tick();
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', dispatches: 1 }));
  });

  test('a combo whose plant subject changed (lawn -> tree & shrub): released, not stored under the old subject', async () => {
    const conn = fakeConn();
    mockIdentifyPlantV2.mockImplementation(async () => {
      conn._store.scheduled_services.find((r) => r.id === 'svc-1').service_type = 'Pest Control Service + Tree & Shrub Care';
      return okPlant();
    });
    await expect(run(conn)).resolves.toBe('changed');
    expect(submissionRow(conn).read_status).toBe('none');
  });

  test('a both-engines miss on a stop that changed is released too, not left failed under the old combo', async () => {
    const conn = fakeConn();
    mockIdentifyPestV2.mockImplementation(async () => {
      conn._store.scheduled_services.find((r) => r.id === 'svc-1').service_type = 'Weekly Lawn Care';
      return { ok: false };
    });
    mockIdentifyPlantV2.mockResolvedValue({ ok: false });
    await expect(run(conn)).resolves.toBe('changed');
    expect(submissionRow(conn).read_status).toBe('none');
  });
});
