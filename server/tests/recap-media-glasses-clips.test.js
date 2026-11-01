// GATE_RECAP_GLASSES_CLIPS (owner 2026-11-01): clips from the phone's photo library (camera glasses).
// confirmUpload limits and statuses, the too-long answer, and the late-clip rebuild of an unsent recap.
// Gate off is exactly the old 20 s / 80 MB behavior.
let mockHeadBytes = 0;
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({
    send: jest.fn(async () => {
      if (mockHeadBytes === null) throw new Error('NotFound');
      return { ContentLength: mockHeadBytes };
    }),
  })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ s3: { bucket: 'b', region: 'us-east-1' }, jwt: { secret: 'test' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/recap-payload', () => ({ buildRecapPayload: jest.fn() }));
jest.mock('../services/service-report/recap-render', () => ({ renderRecapToFile: jest.fn(), cleanupRecapFile: jest.fn() }));
jest.mock('../services/service-report/recap-storage', () => ({ putRecapFromFile: jest.fn() }));

const MB = 1024 * 1024;
const recapMedia = require('../services/service-report/recap-media');
const pipeline = require('../services/service-report/recap-pipeline');

const SAVED = process.env.GATE_RECAP_GLASSES_CLIPS;
afterEach(() => {
  if (SAVED === undefined) delete process.env.GATE_RECAP_GLASSES_CLIPS; else process.env.GATE_RECAP_GLASSES_CLIPS = SAVED;
});

// service_media: a row lookup, the update (recorded), and the delete.
function mediaKnex(row) {
  const calls = { update: null, deleted: false };
  const knex = () => {
    const chain = {
      where: () => chain,
      andWhere: () => chain,
      first: async () => row,
      update: (patch) => { calls.update = patch; return { returning: async () => [{ ...row, ...patch }] }; },
      del: async () => { calls.deleted = true; },
    };
    return chain;
  };
  knex.transaction = async (work) => work(knex);
  return { knex, calls };
}
const videoRow = { id: 'm1', media_type: 'video', s3_key: 'k', scheduled_service_id: 'v1' };
const imageRow = { id: 'm2', media_type: 'image', s3_key: 'k2', scheduled_service_id: 'v1' };

async function confirm(row, bytes, durationMs) {
  mockHeadBytes = bytes;
  const { knex, calls } = mediaKnex(row);
  const result = await recapMedia.confirmUpload(row.id, { scheduledServiceId: 'v1', durationMs }, knex);
  return { result, calls };
}

describe('confirmUpload with the glasses gate off', () => {
  beforeEach(() => { delete process.env.GATE_RECAP_GLASSES_CLIPS; });

  test('keeps the old limits and statuses', async () => {
    const ok = await confirm(videoRow, 10 * MB, 15000);
    expect(ok.result).toMatchObject({ ok: true, row: { status: 'ready' } });
    const long = await confirm(videoRow, 10 * MB, 30000);
    expect(long.result).toEqual({ ok: false, reason: 'bad_duration' });
    expect(long.calls.deleted).toBe(true);
    const big = await confirm(videoRow, 90 * MB, 15000);
    expect(big.result).toEqual({ ok: false, reason: 'too_large' });
  });

  test('a video with no readable length is refused', async () => {
    expect((await confirm(videoRow, MB, null)).result).toEqual({ ok: false, reason: 'bad_duration' });
  });

  test('says 20 seconds', () => {
    expect(recapMedia.confirmFailure('too_large')).toEqual({ status: 413, error: 'Clip too large — keep it under ~20 seconds.' });
  });
});

describe('confirmUpload with the glasses gate on', () => {
  beforeEach(() => { process.env.GATE_RECAP_GLASSES_CLIPS = 'true'; });

  test('a clip over 20 s and up to 60 s waits as processing', async () => {
    const { result, calls } = await confirm(videoRow, 150 * MB, 45000);
    expect(result).toMatchObject({ ok: true, row: { status: 'processing', bytes: 150 * MB, duration_ms: 45000 } });
    expect(calls.update.status).toBe('processing');
  });

  test('a clip of 20 s or less is ready', async () => {
    expect((await confirm(videoRow, 10 * MB, 15000)).result).toMatchObject({ ok: true, row: { status: 'ready' } });
    expect((await confirm(videoRow, 10 * MB, 20000)).result).toMatchObject({ ok: true, row: { status: 'ready' } });
  });

  test('a clip over 60 s or over 200 MB is refused and dropped', async () => {
    const long = await confirm(videoRow, 10 * MB, 70000);
    expect(long.result).toEqual({ ok: false, reason: 'too_long' });
    expect(long.calls.deleted).toBe(true);
    const big = await confirm(videoRow, 250 * MB, 15000);
    expect(big.result).toEqual({ ok: false, reason: 'too_large' });
    expect(big.calls.deleted).toBe(true);
  });

  test('a video with no readable length is still refused', async () => {
    expect((await confirm(videoRow, MB, null)).result).toEqual({ ok: false, reason: 'bad_duration' });
    expect((await confirm(videoRow, MB, 0)).result).toEqual({ ok: false, reason: 'bad_duration' });
  });

  test('a photo keeps the 80 MB limit and is ready', async () => {
    expect((await confirm(imageRow, 5 * MB, null)).result).toMatchObject({ ok: true, row: { status: 'ready' } });
    expect((await confirm(imageRow, 90 * MB, null)).result).toEqual({ ok: false, reason: 'too_large' });
  });

  test('a missing S3 object is still refused', async () => {
    const { result, calls } = await confirm(videoRow, null, 15000);
    expect(result).toEqual({ ok: false, reason: 'not_uploaded' });
    expect(calls.deleted).toBe(true);
  });

  test('says glasses clips stay under 60 seconds', () => {
    expect(recapMedia.confirmFailure('too_long')).toEqual({ status: 413, error: 'Clip too long — keep glasses clips under 60 seconds.' });
    expect(recapMedia.confirmFailure('too_large').error).toBe('Clip too large — keep glasses clips under 60 seconds.');
  });
});

// The late-clip mark is one UPDATE on the recap row; its SQL behavior (re-queue, sent, rendering, a send in
// progress) runs on Postgres in recap-late-clip-races.db.test.js. Here: when it must not run at all.
function markKnex({ fail = false } = {}) {
  const calls = { raw: 0 };
  const knex = () => ({ where: () => ({ orderBy: () => ({ first: async () => null }) }) });
  knex.raw = async () => {
    calls.raw += 1;
    if (fail) throw new Error('db down');
    return { rows: [{ status: 'pending' }] };
  };
  return { knex, calls };
}
const READY = { status: 'ready' };

describe('markRecapClipsChanged', () => {
  test('gate off: nothing is touched', async () => {
    delete process.env.GATE_RECAP_GLASSES_CLIPS;
    const { knex, calls } = markKnex();
    expect(await pipeline.markRecapClipsChanged('v1', READY, { knex })).toEqual({ marked: false });
    expect(calls.raw).toBe(0);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_RECAP_GLASSES_CLIPS = 'true'; });

    test('a ready clip marks the recap row', async () => {
      const { knex, calls } = markKnex();
      expect(await pipeline.markRecapClipsChanged('v1', READY, { knex })).toEqual({ marked: true, status: 'pending' });
      expect(calls.raw).toBe(1);
    });

    test('a processing clip does not count yet', async () => {
      const { knex, calls } = markKnex();
      expect(await pipeline.markRecapClipsChanged('v1', { status: 'processing' }, { knex })).toEqual({ marked: false });
      expect(calls.raw).toBe(0);
    });

    test('a failed mark throws, so the clip change it runs in rolls back', async () => {
      const { knex } = markKnex({ fail: true });
      await expect(pipeline.markRecapClipsChanged('v1', READY, { knex })).rejects.toThrow('db down');
    });
  });
});
