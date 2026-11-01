/**
 * POST /admin/dispatch/:serviceId/recap-media/:mediaId/confirm with GATE_RECAP_GLASSES_CLIPS:
 * the refusal copy follows the gate, and a confirmed clip asks the pipeline to rebuild an unsent
 * recap (the pipeline decides; its own tests are in recap-media-glasses-clips.test.js).
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
}));
jest.mock('../services/service-report/recap-pipeline', () => ({
  ...jest.requireActual('../services/service-report/recap-pipeline'),
  rebuildRecapForLateClip: jest.fn(async () => ({ marked: true, status: 'pending' })),
}));

const router = require('../routes/admin-dispatch');
const recapMedia = require('../services/service-report/recap-media');
const recapPipeline = require('../services/service-report/recap-pipeline');

const CONFIRM_PATH = '/:serviceId/recap-media/:mediaId/confirm';

function invoke(params, body) {
  const layer = router.stack.find((l) => l.route && l.route.path === CONFIRM_PATH && l.route.methods.post);
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

test('a confirmed clip asks the pipeline to rebuild, then answers with the clip status', async () => {
  recapMedia.confirmUpload.mockResolvedValue({ ok: true, row: { id: 'm1', status: 'processing' } });
  const res = await invoke(params, { durationMs: 45000 });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ ok: true, id: 'm1', status: 'processing' });
  expect(recapPipeline.rebuildRecapForLateClip).toHaveBeenCalledWith('visit-1', { id: 'm1', status: 'processing' });
});

test('a refused clip never reaches the rebuild', async () => {
  recapMedia.confirmUpload.mockResolvedValue({ ok: false, reason: 'too_long' });
  process.env.GATE_RECAP_GLASSES_CLIPS = 'true';
  const res = await invoke(params, { durationMs: 70000 });
  expect(res.statusCode).toBe(413);
  expect(res.body.error).toBe('Clip too long — keep glasses clips under 60 seconds.');
  expect(recapPipeline.rebuildRecapForLateClip).not.toHaveBeenCalled();
});

test('gate off: a too-large clip keeps the 20-second copy', async () => {
  delete process.env.GATE_RECAP_GLASSES_CLIPS;
  recapMedia.confirmUpload.mockResolvedValue({ ok: false, reason: 'too_large' });
  const res = await invoke(params, { durationMs: 5000 });
  expect(res.statusCode).toBe(413);
  expect(res.body.error).toBe('Clip too large — keep it under ~20 seconds.');
});
