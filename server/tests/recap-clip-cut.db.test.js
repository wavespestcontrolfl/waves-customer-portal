// Glasses clips (GATE_RECAP_GLASSES_CLIPS, owner 2026-11-01): the cut job turns each `processing` clip into a
// 5-second `ready` clip, through PostgreSQL. The AI picks only the window; the clip row then points at the cut in
// one transaction with the recap mark (clip row locked and read again, recap marked first, like recap-media).
// The dispatcher, S3 and ffmpeg are mocked: no binary, no network, no paid call. Writes run in a transaction that
// is rolled back, except the two-connection test, which commits one row and deletes it after. Synthetic rows only.
// Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn(async () => ({})) })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('../config', () => ({ ...jest.requireActual('../config'), s3: { bucket: 'test-bucket', region: 'us-east-1' } }));

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/service-report/recap-transcode', () => ({
  downloadTo: jest.fn(),
  uploadFrom: jest.fn(),
  runFfmpeg: jest.fn(),
  deleteObject: jest.fn(),
}));
jest.mock('../services/service-report/recap-payload', () => ({ buildRecapPayload: jest.fn() }));
jest.mock('../services/service-report/recap-render', () => ({ renderRecapToFile: jest.fn(), cleanupRecapFile: jest.fn() }));
jest.mock('../services/service-report/recap-storage', () => ({ putRecapFromFile: jest.fn() }));

const fsp = require('node:fs/promises');
const path = require('node:path');
const knex = require('knex');
const { randomUUID } = require('crypto');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('../services/llm/call');
const transcode = require('../services/service-report/recap-transcode');
const { processPendingClipCuts } = require('../services/service-report/recap-clip-cut');
const pipeline = require('../services/service-report/recap-pipeline');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
const SAVED_GATE = process.env.GATE_RECAP_GLASSES_CLIPS;
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const ORIGINAL_KEY = 'recap-media/test/original.mov';
const CUT_BYTES = 12345;

async function insertRecap(scheduledServiceId = randomUUID()) {
  const [row] = await mockPg('service_recaps').insert({
    scheduled_service_id: scheduledServiceId,
    status: 'ready',
    s3_key: 'recaps/test/visit-recap-v1.mp4',
    greeting_version: pipeline.RECAP_GREETING_VERSION,
    rendered_at: minutesAgo(3),
  }).returning('*');
  return row;
}

async function insertClip(fields = {}) {
  const [row] = await mockPg('service_media').insert({
    scheduled_service_id: randomUUID(), media_type: 'video', role: 'perimeter', caption: 'Sealing your perimeter barrier',
    s3_key: ORIGINAL_KEY, content_type: 'video/quicktime', status: 'processing', duration_ms: 40000, bytes: 9000000,
    ...fields,
  }).returning('*');
  return row;
}

const clipRow = (id) => mockPg('service_media').where({ id }).first();
const isFrameRun = (args) => args.some((a) => String(a).startsWith('fps='));
const isCutRun = (args) => args.includes('-ss');
const originalDeleted = () => transcode.deleteObject.mock.calls.some(([key]) => key === ORIGINAL_KEY);

// The cut key the job uploaded (each attempt makes its own: <original>.cut-<8 hex>.mp4).
const uploadedKeys = () => transcode.uploadFrom.mock.calls.map(([key]) => key);
const cutKeyOf = (original) => uploadedKeys().find((key) => key.startsWith(`${original}.cut-`));

describeDb('glasses clip cuts', () => {
  const tempDirs = [];
  const keyByDir = new Map();
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
    tempDirs.length = 0;
    keyByDir.clear();
    mockPg = await database.transaction();
    transcode.downloadTo.mockImplementation(async (key, filePath) => {
      tempDirs.push(path.dirname(filePath));
      keyByDir.set(path.dirname(filePath), key);
      await fsp.writeFile(filePath, 'original-bytes');
    });
    transcode.uploadFrom.mockResolvedValue(undefined);
    transcode.deleteObject.mockResolvedValue(undefined);
    // The frame run writes three JPEGs next to the output pattern; the cut run writes the cut file.
    transcode.runFfmpeg.mockImplementation(async (args) => {
      const out = args[args.length - 1];
      if (isFrameRun(args)) {
        for (const n of ['001', '002', '003']) await fsp.writeFile(path.join(path.dirname(out), `frame-${n}.jpg`), `jpg-${n}`);
      } else {
        await fsp.writeFile(out, Buffer.alloc(CUT_BYTES));
      }
    });
    dispatchWithFallback.mockResolvedValue({ ok: true, text: '{"start_second": 12}' });
  });
  afterEach(async () => {
    const trx = mockPg;
    mockPg = database;
    await trx.rollback();
    if (SAVED_GATE === undefined) delete process.env.GATE_RECAP_GLASSES_CLIPS; else process.env.GATE_RECAP_GLASSES_CLIPS = SAVED_GATE;
  });
  afterAll(async () => {
    if (database) await database.destroy();
  });

  test('gate off: nothing is queried, claimed or cut', async () => {
    delete process.env.GATE_RECAP_GLASSES_CLIPS;
    const clip = await insertClip();
    const spy = { raw: jest.fn(), transaction: jest.fn() };
    expect(await processPendingClipCuts({}, spy)).toEqual({ claimed: 0, ready: 0, failed: 0, abandoned: 0 });
    expect(spy.raw).not.toHaveBeenCalled();
    expect(await processPendingClipCuts()).toEqual({ claimed: 0, ready: 0, failed: 0, abandoned: 0 });
    expect((await clipRow(clip.id)).status).toBe('processing');
    expect(transcode.downloadTo).not.toHaveBeenCalled();
  });

  test('a processing clip becomes a 5-second ready clip at the AI window, and the built recap goes pending', async () => {
    const recap = await insertRecap();
    const clip = await insertClip({ scheduled_service_id: recap.scheduled_service_id });

    expect(await processPendingClipCuts()).toEqual({ claimed: 1, ready: 1, failed: 0, abandoned: 0 });

    expect(await clipRow(clip.id)).toMatchObject({
      status: 'ready', s3_key: cutKeyOf(ORIGINAL_KEY), content_type: 'video/mp4', duration_ms: 5000, bytes: CUT_BYTES,
      role: 'perimeter', caption: 'Sealing your perimeter barrier',
    });
    expect(await mockPg('service_recaps').where({ id: recap.id }).first('status', 'clip_revision', 'approved_at'))
      .toEqual({ status: 'pending', clip_revision: 1, approved_at: null });

    const cutArgs = transcode.runFfmpeg.mock.calls.map(([args]) => args).find(isCutRun);
    expect(cutArgs.slice(cutArgs.indexOf('-ss'), cutArgs.indexOf('-ss') + 2)).toEqual(['-ss', '12']);
    expect(cutArgs.slice(cutArgs.indexOf('-t'), cutArgs.indexOf('-t') + 2)).toEqual(['-t', '5']);
    expect(cutArgs).toEqual(expect.arrayContaining(['-an', 'libx264', 'yuv420p', '+faststart']));
    const frameArgs = transcode.runFfmpeg.mock.calls.map(([args]) => args).find(isFrameRun);
    expect(frameArgs.join(' ')).toContain('fps=1/2,scale=512:-2');
    expect(frameArgs.slice(frameArgs.indexOf('-frames:v'), frameArgs.indexOf('-frames:v') + 2)).toEqual(['-frames:v', '30']);

    expect(transcode.downloadTo).toHaveBeenCalledWith(ORIGINAL_KEY, expect.any(String));
    expect(cutKeyOf(ORIGINAL_KEY)).toMatch(/\.cut-[0-9a-f]{8}\.mp4$/);
    expect(transcode.uploadFrom).toHaveBeenCalledWith(cutKeyOf(ORIGINAL_KEY), expect.any(String), 'video/mp4');
    expect(transcode.deleteObject.mock.calls).toEqual([[ORIGINAL_KEY]]);
    for (const dir of tempDirs) await expect(fsp.stat(dir)).rejects.toThrow();
  });

  test('the dispatcher gets the recap_clip_pick policy, the labelled frames, and a validator for the window', async () => {
    await insertClip();
    await processPendingClipCuts();

    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.recapClipPick);
    expect(payload).toMatchObject({ laneId: 'recap_clip_pick', jsonMode: false });
    expect(payload.images.map((i) => i.label)).toEqual(['Frame at 0s', 'Frame at 2s', 'Frame at 4s']);
    expect(payload.images[0]).toMatchObject({ mimeType: 'image/jpeg', data: Buffer.from('jpg-001').toString('base64') });
    expect(payload.text).toContain('Sealing your perimeter barrier');
    // 40 s clip: start 0..35 is valid; anything else makes the dispatcher try its fallback provider.
    const verdict = (text) => options.validate({ text });
    expect(verdict('{"start_second": 35}')).toBeNull();
    expect(verdict('```json\n{"start_second": 0}\n```')).toBeNull();
    for (const bad of ['{"start_second": 36}', '{"start_second": -1}', '{"start_second": 3.5}', '{"start_second": "4"}', 'no json', '{}']) {
      expect(verdict(bad)).toBe('invalid_window');
    }
  });

  test.each([
    ['an answer outside the clip', async () => ({ ok: true, text: '{"start_second": 99}' })],
    ['a non-integer answer', async () => ({ ok: true, text: '{"start_second": 7.5}' })],
    ['both providers failing', async () => ({ ok: false, reason: 'all_providers_failed' })],
    ['the dispatcher throwing', async () => { throw new Error('boom'); }],
  ])('%s: the middle window is cut, and the clip still becomes ready', async (_name, answer) => {
    dispatchWithFallback.mockImplementation(answer);
    const clip = await insertClip({ duration_ms: 40000 });

    expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 1, failed: 0 });

    const cutArgs = transcode.runFfmpeg.mock.calls.map(([args]) => args).find(isCutRun);
    expect(cutArgs[cutArgs.indexOf('-ss') + 1]).toBe('17'); // floor((40 - 5) / 2)
    expect((await clipRow(clip.id)).status).toBe('ready');
  });

  test('a clip removed while it is cut is left alone: no row change, no recap mark, the cut is deleted, the original is kept', async () => {
    const recap = await insertRecap();
    const clip = await insertClip({ scheduled_service_id: recap.scheduled_service_id });
    // The tech removes the clip after the cut was made, before the job finishes.
    transcode.uploadFrom.mockImplementation(async () => { await mockPg('service_media').where({ id: clip.id }).del(); });

    expect(await processPendingClipCuts()).toEqual({ claimed: 1, ready: 0, failed: 0, abandoned: 1 });

    expect(await clipRow(clip.id)).toBeUndefined();
    expect(await mockPg('service_recaps').where({ id: recap.id }).first('status', 'clip_revision'))
      .toEqual({ status: 'ready', clip_revision: 0 });
    expect(transcode.deleteObject.mock.calls).toEqual([[cutKeyOf(ORIGINAL_KEY)]]);
  });

  test('a clip that is no longer cutting (it was changed meanwhile) is left alone too', async () => {
    const clip = await insertClip();
    transcode.uploadFrom.mockImplementation(async () => { await mockPg('service_media').where({ id: clip.id }).update({ status: 'failed' }); });

    expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 0, abandoned: 1 });
    expect((await clipRow(clip.id)).status).toBe('failed');
    expect(transcode.deleteObject.mock.calls).toEqual([[cutKeyOf(ORIGINAL_KEY)]]);
  });

  test('two attempts on one clip never share a cut key; the abandoned one deletes only its own cut', async () => {
    const clip = await insertClip();
    // First attempt: while it cuts, the row is changed under it (as a stale-cutting recovery would).
    transcode.uploadFrom.mockImplementationOnce(async () => {
      await mockPg('service_media').where({ id: clip.id }).update({ status: 'processing' });
    });
    expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 0, abandoned: 1 });
    // Second attempt cuts it.
    expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 1, abandoned: 0 });

    const [first, second] = uploadedKeys();
    expect(first).not.toBe(second);
    expect((await clipRow(clip.id)).s3_key).toBe(second);
    expect(transcode.deleteObject.mock.calls).toEqual([[first], [ORIGINAL_KEY]]);
  });

  describe('an older attempt after a stale-cutting recovery gave the clip to a newer one', () => {
    // While the older attempt works, the clip is recovered and re-claimed: status stays `cutting`, the
    // claim stamp (updated_at) moves on.
    const reclaimedBy = (clip, stamp) => async () => {
      await mockPg('service_media').where({ id: clip.id }).update({ status: 'cutting', updated_at: stamp });
    };

    test('its failure does not fail the newer attempt\'s clip', async () => {
      const clip = await insertClip();
      const newerStamp = new Date(Date.now() + 20 * 60 * 1000);
      transcode.downloadTo.mockImplementationOnce(async (key, filePath) => {
        await reclaimedBy(clip, newerStamp)();
        throw new Error('download failed');
      });

      expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, failed: 1 });
      expect(await clipRow(clip.id)).toMatchObject({ status: 'cutting', s3_key: ORIGINAL_KEY });
      expect(new Date((await clipRow(clip.id)).updated_at).getTime()).toBe(newerStamp.getTime());
    });

    test('its finish does not publish over the newer attempt: it abandons and deletes only its own cut', async () => {
      const clip = await insertClip();
      transcode.uploadFrom.mockImplementationOnce(reclaimedBy(clip, new Date(Date.now() + 20 * 60 * 1000)));

      expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 0, abandoned: 1 });
      expect(await clipRow(clip.id)).toMatchObject({ status: 'cutting', s3_key: ORIGINAL_KEY });
      expect(transcode.deleteObject.mock.calls).toEqual([[cutKeyOf(ORIGINAL_KEY)]]);
    });
  });

  test('a failed cut sets that clip failed and the next clip is still cut', async () => {
    const first = await insertClip({ created_at: minutesAgo(5) });
    const second = await insertClip({ s3_key: 'recap-media/test/second.mov', created_at: minutesAgo(1) });
    transcode.runFfmpeg.mockImplementation(async (args) => {
      const out = args[args.length - 1];
      if (isFrameRun(args)) { await fsp.writeFile(path.join(path.dirname(out), 'frame-001.jpg'), 'jpg'); return; }
      if (keyByDir.get(path.dirname(out)) === ORIGINAL_KEY) throw new Error('ffmpeg exited 1');
      await fsp.writeFile(out, Buffer.alloc(CUT_BYTES));
    });

    expect(await processPendingClipCuts()).toEqual({ claimed: 2, ready: 1, failed: 1, abandoned: 0 });

    expect(await clipRow(first.id)).toMatchObject({ status: 'failed', s3_key: ORIGINAL_KEY });
    expect(await clipRow(second.id)).toMatchObject({ status: 'ready', s3_key: cutKeyOf('recap-media/test/second.mov') });
    expect(originalDeleted()).toBe(false);
    for (const dir of tempDirs) await expect(fsp.stat(dir)).rejects.toThrow();
  });

  test('a failed recap mark rolls the finish back: the clip is not ready, the cut is deleted', async () => {
    const recap = await insertRecap();
    const clip = await insertClip({ scheduled_service_id: recap.scheduled_service_id });
    const mark = jest.spyOn(pipeline, 'markRecapClipsChanged').mockRejectedValueOnce(new Error('mark failed'));
    try {
      expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 0, failed: 1 });
    } finally { mark.mockRestore(); }
    expect(await clipRow(clip.id)).toMatchObject({ status: 'failed', s3_key: ORIGINAL_KEY });
    expect(transcode.deleteObject.mock.calls).toEqual([[cutKeyOf(ORIGINAL_KEY)]]);
  });

  test('a clip stuck in cutting for 15 minutes goes back to processing; a newer one is left cutting', async () => {
    const stale = await insertClip({ status: 'cutting', updated_at: minutesAgo(20) });
    const fresh = await insertClip({ status: 'cutting', updated_at: minutesAgo(5) });

    expect(await processPendingClipCuts({ limit: 0 })).toMatchObject({ claimed: 0 });

    expect((await clipRow(stale.id)).status).toBe('processing');
    expect((await clipRow(fresh.id)).status).toBe('cutting');
  });

  test('a stale clip is cut in the same pass that recovers it', async () => {
    const stale = await insertClip({ status: 'cutting', updated_at: minutesAgo(20) });
    expect(await processPendingClipCuts()).toMatchObject({ claimed: 1, ready: 1 });
    expect((await clipRow(stale.id)).status).toBe('ready');
  });

  test('each pass claims at most its limit, oldest first, and never the same clip twice', async () => {
    const clips = [];
    for (const [i, age] of [30, 20, 10].entries()) clips.push(await insertClip({ s3_key: `recap-media/test/c${i}.mov`, created_at: minutesAgo(age) }));

    expect(await processPendingClipCuts({ limit: 2 })).toMatchObject({ claimed: 2, ready: 2 });
    expect((await clipRow(clips[2].id)).status).toBe('processing');
    expect(await processPendingClipCuts({ limit: 2 })).toMatchObject({ claimed: 1, ready: 1 });
    expect(await processPendingClipCuts({ limit: 2 })).toMatchObject({ claimed: 0 });
    expect(transcode.downloadTo.mock.calls.map(([key]) => key).sort()).toEqual(clips.map((c) => c.s3_key).sort());
  });

  describe('on two connections', () => {
    let committed = null;
    afterEach(async () => {
      if (committed) await database('service_media').where({ id: committed.id }).del();
      committed = null;
    });

    test('a clip another connection holds locked is skipped, not waited for or cut', async () => {
      // The job runs on `database` here, not on the rolled-back transaction: the committed row is visible to both.
      [committed] = await database('service_media').insert({
        scheduled_service_id: randomUUID(), media_type: 'video', role: 'perimeter', s3_key: 'recap-media/test/locked.mov',
        status: 'processing', duration_ms: 40000, created_at: minutesAgo(60),
      }).returning('*');
      const holder = await database.transaction();
      try {
        await holder('service_media').where({ id: committed.id }).forUpdate().first();
        await processPendingClipCuts({}, database);
      } finally { await holder.rollback(); }
      expect(transcode.downloadTo).not.toHaveBeenCalledWith('recap-media/test/locked.mov', expect.any(String));
      expect((await database('service_media').where({ id: committed.id }).first('status')).status).toBe('processing');
    });
  });
});
