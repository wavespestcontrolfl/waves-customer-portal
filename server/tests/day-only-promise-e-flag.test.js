// GATE_DAY_ONLY_PROMISE part E: GET /api/admin/feature-flags carries `day_only_promise` always (the gate is gone; the key stays for browser tabs still on an older client build). Same harness as estimate-call-list.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/visual-service-notes', () => ({
  VISUAL_SERVICE_NOTES_FLAG: 'visual_service_notes',
  getVisualServiceNotesSettings: jest.fn(),
  isVisualServiceNotesEnabled: jest.fn(async () => false),
  setVisualServiceNotesSettings: jest.fn(),
}));

const db = require('../models/db');

function routeHandler(router, path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const handler = routeHandler(require('../routes/admin-feature-flags'), '/', 'get');

async function flags() {
  db.mockReset();
  const q = {};
  q.where = jest.fn(() => q);
  q.select = jest.fn(async () => [{ flag_key: 'day_only_promise', enabled: true }]);
  db.mockImplementation(() => q);
  const res = { json: jest.fn() };
  await handler({ technicianId: 't1' }, res, jest.fn());
  return res.json.mock.calls[0][0].flags;
}

test('the admin client always sees the flag (kept for tabs still on an older client build)', async () => {
  expect((await flags()).day_only_promise).toBe(true);
});

test('the flag is true even with no per-user row', async () => {
  db.mockReset();
  const q = {};
  q.where = jest.fn(() => q);
  q.select = jest.fn(async () => []);
  db.mockImplementation(() => q);
  const res = { json: jest.fn() };
  await handler({ technicianId: 't1' }, res, jest.fn());
  expect(res.json.mock.calls[0][0].flags.day_only_promise).toBe(true);
});
