// Operations audit OP-13: Knowledge Base, Wiki and calibration writes are
// owner-only at the route, not only behind GATE_STAFF_DEFAULT_DENY. A
// technician still reads, and still asks the wiki a question.
jest.mock('../models/db', () => jest.fn(() => { throw new Error('no db in this test'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/knowledge-base', () => new Proxy({}, { get: () => jest.fn(async () => ({})) }));
jest.mock('../services/knowledge/wiki-compiler', () => new Proxy({}, { get: () => jest.fn(async () => ({})) }));
jest.mock('../services/knowledge/wiki-qa', () => ({ query: jest.fn(async () => ({ answer: 'fixture answer' })) }));
jest.mock('../services/knowledge/knowledge-gaps-weekly', () => ({ withoutSavedGaps: jest.fn((rows) => rows) }));
jest.mock('../services/knowledge/wiki-linter', () => ({}));
jest.mock('../services/equipment-reconciliation', () => ({
  SYSTEM_ASSET_FIELDS: [], COMPONENT_ASSET_FIELDS: [], SYSTEM_ASSET_LABELS: {}, buildEquipmentReconciliation: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = req.headers['x-role']; req.technicianId = 'staff-1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const express = require('express');
const WikiQA = require('../services/knowledge/wiki-qa');

const ID = '11111111-2222-4333-8444-555555555555';
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/kb', require('../routes/admin-kb'));
  app.use('/api/admin/knowledge', require('../routes/admin-knowledge'));
  app.use('/api/admin/equipment-systems', require('../routes/admin-equipment-systems'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => jest.clearAllMocks());

const call = (method, path, role) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', 'x-role': role },
  ...(method === 'GET' ? {} : { body: JSON.stringify({ title: 'Synthetic', question: 'Synthetic question?' }) }),
});

const OWNER_ONLY = [
  ['POST', '/api/admin/kb'],
  ['PUT', `/api/admin/kb/${ID}`],
  ['DELETE', `/api/admin/kb/${ID}`],
  ['POST', `/api/admin/kb/${ID}/verify`],
  ['POST', `/api/admin/kb/${ID}/flag`],
  ['POST', '/api/admin/kb/audit/run'],
  ['POST', '/api/admin/kb/auto-sync'],
  ['POST', '/api/admin/kb/tokens/check'],
  ['PUT', `/api/admin/knowledge/article/${ID}`],
  ['POST', `/api/admin/knowledge/article/${ID}/verify`],
  ['POST', `/api/admin/knowledge/queries/${ID}/rate`],
  ['POST', '/api/admin/knowledge/file-back'],
  ['POST', '/api/admin/knowledge/compile'],
  ['POST', '/api/admin/knowledge/compile-all'],
  ['POST', '/api/admin/knowledge/rebuild-index'],
  ['POST', '/api/admin/knowledge/seed-wiki-folder'],
  ['POST', '/api/admin/knowledge/import-blog-posts'],
  ['POST', `/api/admin/equipment-systems/calibrations/${ID}/verify`],
  ['PUT', `/api/admin/equipment-systems/calibrations/${ID}`],
  ['PUT', `/api/admin/equipment-systems/${ID}/assets`],
  ['POST', `/api/admin/equipment-systems/${ID}/calibrations`],
];

// The body is requireAdmin's own answer, so the handler never ran: no
// knowledge write, no paid compile or audit, no calibration row.
test.each(OWNER_ONLY)('a technician gets 403 on %s %s before any work', async (method, path) => {
  const res = await call(method, path, 'technician');
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: 'Admin access required' });
});

test.each(OWNER_ONLY)('the owner is not refused by the role guard on %s %s', async (method, path) => {
  const res = await call(method, path, 'admin');
  expect(res.status).not.toBe(403);
});

test('a technician still asks the wiki a question', async () => {
  const res = await call('POST', '/api/admin/knowledge/query', 'technician');
  expect(res.status).not.toBe(403);
  expect(WikiQA.query).toHaveBeenCalled();
});
