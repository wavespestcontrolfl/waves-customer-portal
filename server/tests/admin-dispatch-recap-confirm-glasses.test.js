/**
 * Recap clip routes with GATE_RECAP_GLASSES_CLIPS: the confirm's refusal copy follows the gate; a
 * confirmed or removed clip asks the pipeline to mark the recap (the pipeline decides; its SQL runs in
 * recap-late-clip-races.db.test.js); GET /recap-video tells the card whether late clips are live.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const chain = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.first = async () => null;
  chain.then = (resolve) => Promise.resolve([]).then(resolve);
  chain.catch = () => chain;
  const proxy = () => chain;
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/service-report/recap-media', () => ({
  ...jest.requireActual('../services/service-report/recap-media'),
  confirmUpload: jest.fn(),
  deleteMedia: jest.fn(),
}));
jest.mock('../services/service-report/recap-pipeline', () => ({
  ...jest.requireActual('../services/service-report/recap-pipeline'),
  markRecapClipsChanged: jest.fn(async () => ({ marked: true, status: 'pending' })),
  getRecap: jest.fn(),
  callbackRecapRetired: jest.fn(async () => false),
}));

const router = require('../routes/admin-dispatch');
const recapMedia = require('../services/service-report/recap-media');
const recapPipeline = require('../services/service-report/recap-pipeline');

const CONFIRM_PATH = '/:serviceId/recap-media/:mediaId/confirm';

function invoke(params, body, { path = CONFIRM_PATH, method = 'post' } = {}) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, query: {}, techRole: 'admin', technicianId: 'admin-1' }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const params = { serviceId: 'visit-1', mediaId: 'm1' };
const SAVED = process.env.GATE_RECAP_GLASSES_CLIPS;
afterEach(() => {
  if (SAVED === undefined) delete process.env.GATE_RECAP_GLASSES_CLIPS; else process.env.GATE_RECAP_GLASSES_CLIPS = SAVED;
  jest.clearAllMocks();
});

test('a confirm hands the recap mark to the clip change (same transaction), then answers with the clip status', async () => {
  recapMedia.confirmUpload.mockResolvedValue({ ok: true, row: { id: 'm1', status: 'processing' } });
  const res = await invoke(params, { durationMs: 45000 });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ ok: true, id: 'm1', status: 'processing' });
  const [mediaId, options] = recapMedia.confirmUpload.mock.calls[0];
  expect([mediaId, options.scheduledServiceId, options.durationMs]).toEqual(['m1', 'visit-1', 45000]);
  await options.onChange({ id: 'm1', status: 'ready' }, 'trx-1');
  expect(recapPipeline.markRecapClipsChanged).toHaveBeenCalledWith('visit-1', { id: 'm1', status: 'ready' }, { knex: 'trx-1' });
});

test('a refused clip answers with the copy for the gate', async () => {
  recapMedia.confirmUpload.mockResolvedValue({ ok: false, reason: 'too_long' });
  process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
  const res = await invoke(params, { durationMs: 70000 });
  expect(res.statusCode).toBe(413);
  expect(res.body.error).toBe('Clip too long — keep glasses clips under 60 seconds.');
  expect(recapPipeline.markRecapClipsChanged).not.toHaveBeenCalled();
});

test('gate off: a too-large clip keeps the 20-second copy', async () => {
  delete process.env.GATE_RECAP_GLASSES_CLIPS;
  recapMedia.confirmUpload.mockResolvedValue({ ok: false, reason: 'too_large' });
  const res = await invoke(params, { durationMs: 5000 });
  expect(res.statusCode).toBe(413);
  expect(res.body.error).toBe('Clip too large — keep it under ~20 seconds.');
});

describe('removing a clip', () => {
  const DELETE = { path: '/:serviceId/recap-media/:mediaId', method: 'delete' };

  test('a removal hands the recap mark to the clip change (same transaction)', async () => {
    recapMedia.deleteMedia.mockResolvedValue({ id: 'm1', status: 'ready' });
    const res = await invoke(params, {}, DELETE);
    expect(res.body).toEqual({ ok: true });
    const [mediaId, options] = recapMedia.deleteMedia.mock.calls[0];
    expect([mediaId, options.scheduledServiceId]).toEqual(['m1', 'visit-1']);
    await options.onChange({ id: 'm1', status: 'ready' }, 'trx-1');
    expect(recapPipeline.markRecapClipsChanged).toHaveBeenCalledWith('visit-1', { id: 'm1', status: 'ready' }, { knex: 'trx-1' });
  });

  test('a clip that was not there answers ok: false', async () => {
    recapMedia.deleteMedia.mockResolvedValue(false);
    const res = await invoke(params, {}, DELETE);
    expect(res.body).toEqual({ ok: false });
  });
});

test('GET /recap-video says whether late clips are live, by the gate', async () => {
  const GET = { path: '/:serviceId/recap-video', method: 'get' };
  recapPipeline.getRecap.mockResolvedValue({ status: 'ready', sent_at: null });
  process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
  expect((await invoke({ serviceId: 'visit-1' }, {}, GET)).body).toMatchObject({ status: 'ready', lateClips: true });
  delete process.env.GATE_RECAP_GLASSES_CLIPS;
  expect((await invoke({ serviceId: 'visit-1' }, {}, GET)).body).toMatchObject({ status: 'ready', lateClips: false });
});
