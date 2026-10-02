// The dispatch facade (/api/dispatch): a technician's GET /jobs is pinned to
// their own current/recent visits whatever techId the query says; the route
// board, reoptimize and insights are admin-only (codex #5568 r2 P1).
let mockRole = 'technician';
const mockFilter = jest.fn((req, q) => { q.where('scheduled_services.technician_id', req.technicianId); return q; });
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianCurrentVisitFilter: (...a) => mockFilter(...a),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const { requireTechOrAdmin } = require('../middleware/admin-auth');
const router = require('../routes/dispatch');

function chain() {
  const q = {};
  for (const m of ['leftJoin', 'select', 'orderByRaw', 'orderBy', 'where', 'whereIn', 'whereNotIn', 'modify']) q[m] = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/dispatch', (req, _res, next) => { req.technicianId = 'tech-1'; req.techRole = mockRole; next(); }, requireTechOrAdmin, router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/dispatch`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

let q;
beforeEach(() => { jest.clearAllMocks(); mockRole = 'technician'; q = chain(); db.mockImplementation(() => q); db.raw = jest.fn((x) => x); });

test('a technician GET /jobs?techId=<someone else> is still scoped to their own visits', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/jobs?techId=other-tech&date=2026-10-02`);
    expect(res.status).toBe(200);
  });
  expect(mockFilter).toHaveBeenCalledTimes(1);
  expect(q.where).toHaveBeenCalledWith('scheduled_services.technician_id', 'tech-1');
  expect(q.where).not.toHaveBeenCalledWith('scheduled_services.technician_id', 'other-tech');
});

test('an admin GET /jobs?techId= filters by the requested technician', async () => {
  mockRole = 'admin';
  await withServer(async (base) => { expect((await fetch(`${base}/jobs?techId=other-tech`)).status).toBe(200); });
  expect(mockFilter).not.toHaveBeenCalled();
  expect(q.where).toHaveBeenCalledWith('scheduled_services.technician_id', 'other-tech');
});

test.each([['GET', '/routes'], ['POST', '/routes/reoptimize'], ['GET', '/insights']])('%s %s is admin-only', async (method, path) => {
  await withServer(async (base) => {
    expect((await fetch(`${base}${path}`, { method })).status).toBe(403);
  });
  expect(db).not.toHaveBeenCalled();
});
