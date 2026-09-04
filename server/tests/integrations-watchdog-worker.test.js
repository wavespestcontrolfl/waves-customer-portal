/**
 * Watchdog worker route — the dark gate answers 404 AHEAD of auth (no audit
 * row while dark, so a disabled lane is never liveness); gate-on serves the
 * snapshot and finalizes 'observed'. Auth is exercised in link-worker-auth.test.
 */
const finalized = [];
jest.mock('../middleware/link-worker-auth', () => ({
  linkWorkerAuth: jest.fn(() => (req, res, next) => { req.linkWorkerRequestId = 'req-1'; next(); }),
  finalizeWorkerRequest: jest.fn(async (req, result) => { finalized.push(result); return true; }),
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/agent-watchdog-snapshot', () => ({
  buildWatchdogSnapshot: jest.fn(async () => ({ verdict: 'healthy', reasons: [] })),
}));

const { gateEnvValue } = require('../config/feature-gates');
const { linkWorkerAuth } = require('../middleware/link-worker-auth');
const router = require('../routes/integrations-watchdog-worker');

function statusHandler() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/status');
  return layer.route.stack[0].handle;
}

function makeRes() {
  const res = { statusCode: 200, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

beforeEach(() => { finalized.length = 0; gateEnvValue.mockReturnValue(false); });

test('the router mounts the dark gate BEFORE link-worker auth with the watchdog capability', () => {
  expect(linkWorkerAuth).toHaveBeenCalledWith('watchdog');
  const uses = router.stack.filter((l) => !l.route).map((l) => l.name);
  expect(uses.indexOf('watchdogGate')).toBeLessThan(uses.length - 1);
  expect(uses[0]).toBe('watchdogGate');
});

test('gate off → the gate answers 404 and never calls next (no auth, no audit row)', async () => {
  const res = makeRes();
  const next = jest.fn();
  router._test.watchdogGate({}, res, next);
  expect(res.statusCode).toBe(404);
  expect(res.body).toEqual({ error: 'watchdog lane disabled' });
  expect(next).not.toHaveBeenCalled();
  expect(finalized).toEqual([]);
});

test('gate on → the gate passes through', () => {
  gateEnvValue.mockReturnValue(true);
  const next = jest.fn();
  router._test.watchdogGate({}, makeRes(), next);
  expect(next).toHaveBeenCalledWith();
});

test('gate on → 200 snapshot, no-store, audit finalized observed', async () => {
  gateEnvValue.mockReturnValue(true);
  const res = makeRes();
  await statusHandler()({ linkWorkerRequestId: 'req-1' }, res, jest.fn());
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ verdict: 'healthy', reasons: [] });
  expect(res.headers['Cache-Control']).toBe('no-store');
  expect(finalized).toEqual(['observed']);
});

test('gate on but the heartbeat row did not persist → 503, never a false success', async () => {
  gateEnvValue.mockReturnValue(true);
  require('../middleware/link-worker-auth').finalizeWorkerRequest.mockResolvedValueOnce(false);
  const res = makeRes();
  await statusHandler()({ linkWorkerRequestId: 'req-1' }, res, jest.fn());
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ error: 'heartbeat not recorded' });
});
