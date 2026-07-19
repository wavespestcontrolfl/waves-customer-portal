/**
 * Orphaned-photo reclaim sweep — the consumer for the
 * project_photo_delete_orphaned tombstones written when a DB-first photo
 * delete's post-commit S3 delete fails.
 */
const mockS3Send = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  DeleteObjectCommand: jest.fn((input) => input),
}));

const db = require('../models/db');
const { reclaimOrphanedPhotoObjects } = require('../services/photo-orphan-reclaim');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('reclaims a tombstoned object and stamps reclaimed_at', async () => {
  const activity = chain({
    select: jest.fn().mockResolvedValue([
      { id: 'act-1', metadata: { photo_id: 'photo-1', s3_key: 'project-photos/p1/x.jpg' } },
    ]),
  });
  db.mockImplementation(() => activity);
  mockS3Send.mockResolvedValue({});

  const result = await reclaimOrphanedPhotoObjects();
  expect(result).toEqual({ ok: true, scanned: 1, reclaimed: 1 });
  expect(mockS3Send).toHaveBeenCalledWith(expect.objectContaining({ Key: 'project-photos/p1/x.jpg' }));
  const stamped = JSON.parse(activity.update.mock.calls[0][0].metadata);
  expect(stamped.reclaimed_at).toBeTruthy();
  expect(stamped.s3_key).toBe('project-photos/p1/x.jpg');
});

test('a failed delete leaves the tombstone queued for the next run', async () => {
  const activity = chain({
    select: jest.fn().mockResolvedValue([
      { id: 'act-1', metadata: { s3_key: 'project-photos/p1/x.jpg' } },
    ]),
  });
  db.mockImplementation(() => activity);
  mockS3Send.mockRejectedValue(new Error('S3 timeout'));

  const result = await reclaimOrphanedPhotoObjects();
  expect(result).toEqual({ ok: true, scanned: 1, reclaimed: 0 });
  expect(activity.update).not.toHaveBeenCalled();
});

test('a malformed tombstone without a key is stamped so it never re-queues', async () => {
  const activity = chain({
    select: jest.fn().mockResolvedValue([{ id: 'act-1', metadata: { photo_id: 'photo-1' } }]),
  });
  db.mockImplementation(() => activity);

  const result = await reclaimOrphanedPhotoObjects();
  expect(result).toEqual({ ok: true, scanned: 1, reclaimed: 0 });
  expect(mockS3Send).not.toHaveBeenCalled();
  const stamped = JSON.parse(activity.update.mock.calls[0][0].metadata);
  expect(stamped.reclaimed_at).toBeTruthy();
  expect(stamped.reclaim_note).toBe('no_key');
});
