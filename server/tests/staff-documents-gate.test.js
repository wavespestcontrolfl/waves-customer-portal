const express = require('express');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/staff-documents', () => ({ list: jest.fn().mockResolvedValue([]) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
    req.techRole = 'technician'; req.technicianId = '00000000-0000-4000-8000-000000000001'; next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res) => res.status(403).json({ error: 'Admin required' }),
}));
const db = require('../models/db');
const documents = require('../services/staff-documents');
const app = express();
app.use(express.json());
app.use('/documents', require('../routes/tech-staff-documents'));
let server;
let origin;
const auth = { Authorization: 'Bearer qa' };
beforeAll(async () => {
  server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
const previous = process.env.GATE_CONTROLLED_STAFF_DOCUMENTS;
afterAll(() => { if (previous === undefined) delete process.env.GATE_CONTROLLED_STAFF_DOCUMENTS; else process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = previous; });
beforeEach(() => { delete process.env.GATE_CONTROLLED_STAFF_DOCUMENTS; jest.clearAllMocks(); });

test('availability is authenticated and reads no document data while dark', async () => {
  expect((await fetch(`${origin}/documents/availability`)).status).toBe(401);
  const response = await fetch(`${origin}/documents/availability`, { headers: auth });
  expect(await response.json()).toEqual({ available: false });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(db).not.toHaveBeenCalled();
});
test('dark reads and writes stop before document services or the database', async () => {
  expect((await fetch(`${origin}/documents`, { headers: auth })).status).toBe(404);
  expect((await fetch(`${origin}/documents/drafts`, { method: 'POST', headers: auth })).status).toBe(404);
  expect(db).not.toHaveBeenCalled(); expect(documents.list).not.toHaveBeenCalled();
});
test('the request-time gate can enable and revoke reads without changing auth guards', async () => {
  process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
  expect((await fetch(`${origin}/documents`, { headers: auth })).status).toBe(200);
  expect((await fetch(`${origin}/documents/drafts`, { method: 'POST', headers: auth })).status).toBe(403);
  process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'false';
  expect((await fetch(`${origin}/documents`, { headers: auth })).status).toBe(404);
  expect(documents.list).toHaveBeenCalledTimes(1);
});
