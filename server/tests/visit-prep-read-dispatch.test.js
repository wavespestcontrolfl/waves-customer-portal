/**
 * services/visit-prep-read-dispatch.js — the ONE place a visit prep
 * submission is routed to a read engine (Codex #5320 r9). Applicability and
 * both engines are mocked; this suite covers the routing, the gates, the
 * dispatch bound, and the unsupported / error settlements.
 */

const mockIsPestStop = jest.fn();
jest.mock('../services/visit-prep-pest-applicability', () => ({
  isPestStop: (...args) => mockIsPestStop(...args),
}));
const mockPlantSubject = jest.fn();
jest.mock('../services/visit-prep-plant-applicability', () => ({
  plantSubjectForStop: (...args) => mockPlantSubject(...args),
}));
const mockPestTrigger = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-pest-read', () => ({
  triggerVisitPrepPestRead: (...args) => mockPestTrigger(...args),
}));
const mockPlantTrigger = jest.fn(async () => 'done');
jest.mock('../services/visit-prep-plant-read', () => ({
  triggerVisitPrepPlantRead: (...args) => mockPlantTrigger(...args),
}));
let mockPestLive = true;
let mockPlantLive = true;
jest.mock('../config/feature-gates', () => ({
  visitPrepPestReadLive: () => mockPestLive,
  visitPrepPlantReadLive: () => mockPlantLive,
}));

const { dispatchVisitPrepRead, MAX_DISPATCHES } = require('../services/visit-prep-read-dispatch');

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

beforeEach(() => {
  jest.clearAllMocks();
  mockPestLive = true;
  mockPlantLive = true;
  mockIsPestStop.mockResolvedValue(false);
  mockPlantSubject.mockResolvedValue(null);
});

test('a pest stop goes to the pest read only, with the dispatch count bumped', async () => {
  mockIsPestStop.mockResolvedValue(true);
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('done');
  expect(mockPestTrigger).toHaveBeenCalledWith(expect.objectContaining({ submissionId: 'sub-1', dispatches: 1 }));
  expect(mockPlantTrigger).not.toHaveBeenCalled();
  expect(mockPlantSubject).not.toHaveBeenCalled();
});

test('a lawn stop goes to the plant read only', async () => {
  mockPlantSubject.mockResolvedValue('lawn');
  await dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn: fakeConn(), dispatches: 1 });
  expect(mockPlantTrigger).toHaveBeenCalledWith(expect.objectContaining({ dispatches: 2 }));
  expect(mockPestTrigger).not.toHaveBeenCalled();
});

test('pest gate off: a pest stop is not read (the plant engine never takes a pest stop)', async () => {
  mockPestLive = false;
  mockIsPestStop.mockResolvedValue(true);
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('unsupported');
  expect(mockIsPestStop).not.toHaveBeenCalled();
  expect(mockPestTrigger).not.toHaveBeenCalled();
  expect(mockPlantTrigger).not.toHaveBeenCalled();
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
  mockIsPestStop.mockResolvedValue(true);
  await dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, expectStatus: ['none'] });
  expect(mockPestTrigger).toHaveBeenCalledWith(expect.objectContaining({ expectStatus: ['none'] }));
});

test('both gates off: nothing is read and nothing is written', async () => {
  mockPestLive = false;
  mockPlantLive = false;
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('skipped');
  expect(conn._writes).toEqual([]);
});

test(`after ${MAX_DISPATCHES} dispatches the row is left for the recovery sweep`, async () => {
  mockIsPestStop.mockResolvedValue(true);
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({
    submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn, dispatches: MAX_DISPATCHES,
  })).resolves.toBe('exhausted');
  expect(mockPestTrigger).not.toHaveBeenCalled();
  expect(conn._writes).toEqual([]);
});

test('an applicability error settles none (unclaimed), never throws', async () => {
  mockIsPestStop.mockRejectedValue(new Error('db down'));
  const conn = fakeConn();
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: PHOTOS, conn })).resolves.toBe('error');
  expect(conn._writes[0].patch).toEqual({ read_status: 'none' });
});

test('no photos or no submission: skipped', async () => {
  await expect(dispatchVisitPrepRead({ submissionId: 'sub-1', svc: SVC, photos: [], conn: fakeConn() })).resolves.toBe('skipped');
  await expect(dispatchVisitPrepRead({ svc: SVC, photos: PHOTOS, conn: fakeConn() })).resolves.toBe('skipped');
});
