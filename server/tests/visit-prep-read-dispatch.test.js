/**
 * services/visit-prep-read-dispatch.js — the ONE place a visit prep
 * submission is routed to a read engine (Codex #5320 r9). Applicability and
 * the engines are mocked (the stop's live service_types are the one input
 * and the real shape / key logic runs over them); this suite covers the
 * routing including the combined Lawn & Pest reads (owner ruling 2026-09-30),
 * the gates, the dispatch bound, and the unsupported / error settlements.
 */

// The stop's live member service_types are the ONE input; the real shape /
// key logic (combo labels, pest-only, lawn-only) runs over them.
const mockLiveTypes = jest.fn();
jest.mock('../services/visit-prep-pest-applicability', () => ({
  ...jest.requireActual('../services/visit-prep-pest-applicability'),
  liveStopServiceTypes: (...args) => mockLiveTypes(...args),
}));
const mockPestTrigger = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-pest-read', () => ({
  triggerVisitPrepPestRead: (...args) => mockPestTrigger(...args),
}));
const mockPlantTrigger = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-plant-read', () => ({
  triggerVisitPrepPlantRead: (...args) => mockPlantTrigger(...args),
}));
const mockComboTrigger = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-combo-read', () => ({
  triggerVisitPrepComboRead: (...args) => mockComboTrigger(...args),
}));
let mockPestLive = true;
let mockPlantLive = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepPestReadLive: () => mockPestLive,
  visitPrepPlantReadLive: () => mockPlantLive,
}));

const { dispatchVisitPrepRead, MAX_DISPATCHES, _internal } = require('../services/visit-prep-read-dispatch');

function fakeConn() {
  const writes = [];
  const conn = (table) => {
    const q = { _where: {} };
    q.where = (w) => { Object.assign(q._where, w); return q; };
    q.whereIn = (col, vals) => { q._whereIn = { col, vals }; return q; };
    q.update = async (patch) => { writes.push({ table, where: q._where, whereIn: q._whereIn, patch }); return 1; };
    return q;
  };
  conn._writes = writes;
  return conn;
}

const SVC = { id: 'svc-1', visit_id: null, service_type: 'x' };
const PHOTOS = [{ s3Key: 'visitprep/a.jpg', mimeType: 'image/jpeg' }];

const PEST = 'Quarterly Pest Control Service';
const LAWN = 'Lawn Care Service';
const TREE = 'Tree & Shrub Care';
const COMBINED = 'Quarterly Pest Control Service + Lawn Care Service';

beforeEach(() => {
  jest.clearAllMocks();
  mockPestLive = true;
  mockPlantLive = true;
  mockLiveTypes.mockResolvedValue([]);
});

const stop = (...types) => mockLiveTypes.mockResolvedValue(types);
const run = (extra = {}) => dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn: fakeConn(), ...extra });
const ran = () => ({
  pest: mockPestTrigger.mock.calls.length, plant: mockPlantTrigger.mock.calls.length, combo: mockComboTrigger.mock.calls.length,
});

test('a pest stop goes to the pest read only, with the dispatch count bumped', async () => {
  stop(PEST);
  await expect(run()).resolves.toBe('done');
  expect(mockPestTrigger).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', dispatches: 1 }));
  expect(ran()).toEqual({ pest: 1, plant: 0, combo: 0 });
});

test('a lawn stop goes to the plant read only', async () => {
  stop(LAWN);
  await run({ dispatches: 1 });
  expect(mockPlantTrigger).toHaveBeenCalledWith(expect.objectContaining({ dispatches: 2 }));
  expect(ran()).toEqual({ pest: 0, plant: 1, combo: 0 });
});

describe('combined Lawn & Pest stops get BOTH reads under one combo dispatch (owner ruling 2026-09-30)', () => {
  test.each([
    ['(a) one combined service_type', [COMBINED]],
    ['(a) a combined type spelled "Lawn Care + Pest Control"', ['Lawn Care + Pest Control']],
    ['(a) a combined type spelled "Pest and Lawn"', ['Pest and Lawn']],
    ['(b) separate pest-only and lawn-only members', [PEST, LAWN]],
  ])('%s: combo:lawn with both gates live', async (_name, types) => {
    stop(...types);
    await expect(run()).resolves.toBe('done');
    expect(ran()).toEqual({ pest: 0, plant: 0, combo: 1 });
    expect(mockComboTrigger).toHaveBeenCalledWith(expect.objectContaining({ dispatches: 1 }));
  });

  test('a tree & shrub combination carries its own subject', async () => {
    stop(PEST, TREE);
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('combo:tree_shrub');
    stop('Pest Control Service + Tree & Shrub Care');
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('combo:tree_shrub');
  });

  test.each([
    ['(a)', [COMBINED]],
    ['(b)', [PEST, LAWN]],
  ])('%s with only the pest gate live: the pest read alone', async (_name, types) => {
    mockPlantLive = false;
    stop(...types);
    await run();
    expect(ran()).toEqual({ pest: 1, plant: 0, combo: 0 });
  });

  test.each([
    ['(a)', [COMBINED]],
    ['(b)', [PEST, LAWN]],
  ])('%s with only the plant gate live: the plant read alone', async (_name, types) => {
    mockPestLive = false;
    stop(...types);
    await run();
    expect(ran()).toEqual({ pest: 0, plant: 1, combo: 0 });
  });

  test('neither gate live: skipped, nothing written', async () => {
    mockPestLive = false;
    mockPlantLive = false;
    stop(COMBINED);
    const conn = fakeConn();
    await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('skipped');
    expect(ran()).toEqual({ pest: 0, plant: 0, combo: 0 });
    expect(conn._writes).toEqual([]);
  });

  test.each([
    'Pest & Mosquito',
    'Pest + Termite',
    'Pest + Rodent',
    'Lawn Care + Termite Bait',
    'Pest + Lawn + Mosquito',
    'Pest + Palm Injection',
    'Mosquito Control Service',
    'WDO Inspection',
  ])('%s is not a Lawn & Pest combo', async (label) => {
    stop(label);
    const key = await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true });
    expect(String(key)).not.toMatch(/^combo:/);
  });

  test('a lone mosquito / termite / rodent / palm member never pairs with a pest member into a combo', async () => {
    stop(PEST, 'Mosquito Control Service');
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('pest');
    stop(PEST, 'Palm Injection');
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('pest');
    stop(LAWN, 'Termite Inspection');
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('plant:lawn');
  });

  test('"Lawn Pest Control" (a lawn-line product) stays a plant-only stop', async () => {
    stop('Lawn Pest Control');
    expect(await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true })).toBe('plant:lawn');
  });
});

describe('read key round-trip', () => {
  const { storedReadKey } = _internal;
  test.each([
    ['pest', null],
    ['pest', JSON.stringify({ v2: null })],
    ['plant:lawn', JSON.stringify({ engine: 'plant', subject_type: 'lawn' })],
    ['plant:tree_shrub', { engine: 'plant', subject_type: 'tree_shrub' }],
    ['combo:lawn', JSON.stringify({ engine: 'combo', subject_type: 'lawn', pest: { status: 'done' }, plant: { status: 'failed' } })],
    ['combo:tree_shrub', { engine: 'combo', subject_type: 'tree_shrub' }],
  ])('%s', (key, stored) => {
    expect(storedReadKey(stored)).toBe(key);
  });

  test('a stored combo key equals the key the same stop wants now', async () => {
    stop(COMBINED);
    const want = await _internal.currentReadKey(SVC, fakeConn(), { pestLive: true, plantLive: true });
    expect(storedReadKey({ engine: 'combo', subject_type: 'lawn' })).toBe(want);
  });
});

test('pest gate off: a lone pest stop is not read', async () => {
  mockPestLive = false;
  stop(PEST);
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('unsupported');
  expect(ran()).toEqual({ pest: 0, plant: 0, combo: 0 });
});

test('a stop no live engine reads: marked unsupported only while unclaimed', async () => {
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('unsupported');
  expect(conn._writes).toEqual([expect.objectContaining({
    patch: { read_status: 'unsupported' }, whereIn: { col: 'read_status', vals: ['none', 'unsupported'] },
  })]);
});

test('the recovery sweep\'s expectStatus narrows every write and is passed to the engine', async () => {
  const conn = fakeConn();
  await dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, expectStatus: ['none'] });
  expect(conn._writes[0].whereIn).toEqual({ col: 'read_status', vals: ['none'] });
  stop(PEST);
  await dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, expectStatus: ['none'] });
  expect(mockPestTrigger).toHaveBeenCalledWith(expect.objectContaining({ expectStatus: ['none'] }));
  stop(COMBINED);
  await dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, expectStatus: ['none'] });
  expect(mockComboTrigger).toHaveBeenCalledWith(expect.objectContaining({ expectStatus: ['none'] }));
});

test('both gates off: nothing is read and nothing is written', async () => {
  mockPestLive = false;
  mockPlantLive = false;
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('skipped');
  expect(conn._writes).toEqual([]);
});

test(`after ${MAX_DISPATCHES} dispatches the row is left for the recovery sweep`, async () => {
  stop(COMBINED);
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({
    submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, dispatches: MAX_DISPATCHES,
  })).resolves.toBe('exhausted');
  expect(ran()).toEqual({ pest: 0, plant: 0, combo: 0 });
  expect(conn._writes).toEqual([]);
});

test('an applicability error settles none (unclaimed), never throws', async () => {
  mockLiveTypes.mockRejectedValue(new Error('db down'));
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('error');
  expect(conn._writes[0].patch).toEqual({ read_status: 'none' });
});

test('no photos or no submission: skipped', async () => {
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: [], conn: fakeConn() })).resolves.toBe('skipped');
  await expect(dispatchVisitPrepRead({ svc: SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('skipped');
});
