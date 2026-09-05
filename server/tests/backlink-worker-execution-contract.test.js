let mockProvider = 'hermes';
jest.mock('../middleware/link-worker-auth', () => ({ linkWorkerAuth: () => (_req, _res, next) => next(), finalizeWorkerRequest: jest.fn(async () => {}) }));
jest.mock('../services/seo/link-prospect-worker', () => ({ claim: jest.fn(async () => []), report: jest.fn(async () => ({ ok: true })), businessProfile: () => ({}) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const worker = require('../services/seo/link-prospect-worker');
const { isEnabled } = require('../config/feature-gates');
const router = require('../routes/integrations-backlink-worker');
function call(method, path, { query = {}, body = {} } = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  return new Promise((resolve, reject) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
    layer.route.stack.at(-1).handle({ query, body, linkWorker: { provider: mockProvider } }, res, reject);
  });
}
beforeEach(() => { jest.clearAllMocks(); mockProvider = 'hermes'; isEnabled.mockReturnValue(true); worker.report.mockResolvedValue({ ok: true }); });
test('a report cannot replace the authenticated provider with a body field', async () => {
  expect((await call('post', '/report', { body: { prospect_id: 'p', outcome: 'placed', provider: 'deterministic_runner', lease_token: 'lease', pending: true } })).status).toBe(200);
  expect(worker.report).toHaveBeenCalledWith({ prospect_id: 'p', outcome: 'placed', provider: 'hermes', lease_token: 'lease', pending: true });
});
test('claim forwards the explicit execution mode and authenticated provider', async () => {
  mockProvider = 'deterministic_runner';
  expect((await call('get', '/claim', { query: { type: 'outreach', mode: 'acquire' } })).status).toBe(200);
  expect(worker.claim).toHaveBeenCalledWith(expect.objectContaining({ type: 'outreach', mode: 'acquire', provider: 'deterministic_runner' }));
});
test('unknown claim modes are rejected without leasing', async () => {
  expect((await call('get', '/claim', { query: { mode: 'send' } })).status).toBe(400);
  expect(worker.claim).not.toHaveBeenCalled();
});
test('a dark draft gate returns an empty claim', async () => {
  isEnabled.mockReturnValue(false);
  const result = await call('get', '/claim', { query: { type: 'outreach' } });
  expect(result.body.prospects).toEqual([]); expect(worker.claim).not.toHaveBeenCalled();
});
test('provider/lease conflicts remain HTTP 409', async () => {
  worker.report.mockResolvedValue({ ok: false, code: 'stale_lease' });
  expect((await call('post', '/report', { body: { prospect_id: 'p', outcome: 'failed', lease_token: 'lease' } })).status).toBe(409);
});
