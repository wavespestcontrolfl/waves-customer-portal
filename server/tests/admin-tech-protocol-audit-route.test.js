// /api/admin/tech-protocol-audits (Tech Rewards Plan D5-3): the admin-only guard, the month pass-through and the
// error mapping, with the service stubbed. The reads, the sample and the upsert run against Postgres in
// tech-protocol-audit-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers['x-test-auth']) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = req.headers['x-test-role'] || 'admin';
    req.technicianId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/tech-protocol-audit', () => ({
  ...jest.requireActual('../services/tech-protocol-audit'),
  getBoard: jest.fn(),
  saveMark: jest.fn(),
}));

const express = require('express');
const audit = require('../services/tech-protocol-audit');
const router = require('../routes/admin-tech-protocol-audit');

describe('/api/admin/tech-protocol-audits', () => {
  let server;
  let baseUrl;
  const VISIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const TECH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const AUTH = { 'x-test-auth': '1', 'content-type': 'application/json' };
  const get = (query = '', headers = AUTH) => fetch(`${baseUrl}/${query}`, { headers });
  const put = (body, headers = AUTH) => fetch(`${baseUrl}/visits/${VISIT}`, { method: 'PUT', headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/tech-protocol-audits', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/tech-protocol-audits`;
  });
  afterAll(() => new Promise((resolve) => { server.close(resolve); }));
  beforeEach(() => {
    audit.getBoard.mockReset().mockResolvedValue({ month: '2026-04', sampleSize: 5, technicians: [] });
    audit.saveMark.mockReset().mockResolvedValue({ scheduledServiceId: VISIT, result: 'match', note: null, auditedAt: '2026-04-30T12:00:00.000Z' });
  });

  test('no login is 401 and a technician login is 403, before any read or write', async () => {
    expect((await get('', {})).status).toBe(401);
    expect((await get('', { 'x-test-auth': '1', 'x-test-role': 'technician' })).status).toBe(403);
    expect((await put({ result: 'match' }, { 'x-test-auth': '1', 'x-test-role': 'technician', 'content-type': 'application/json' })).status).toBe(403);
    expect((await put({ result: 'match' }, { 'content-type': 'application/json' })).status).toBe(401);
    expect(audit.getBoard).not.toHaveBeenCalled();
    expect(audit.saveMark).not.toHaveBeenCalled();
  });

  test('GET answers the board for the month, uncached', async () => {
    const res = await get('?month=2026-04');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ month: '2026-04', sampleSize: 5 });
    expect(audit.getBoard).toHaveBeenCalledWith('2026-04');
  });

  test('PUT saves the mark as the signed-in admin', async () => {
    const res = await put({ result: 'mismatch', note: 'rate off', technicianId: TECH, month: '2026-04', recordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mark: { scheduledServiceId: VISIT } });
    expect(audit.saveMark).toHaveBeenCalledWith({ scheduledServiceId: VISIT, result: 'mismatch', note: 'rate off', technicianId: TECH, month: '2026-04', recordId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', auditedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  });

  test("the service's refusals keep their status and code; any other failure is a plain 500", async () => {
    audit.getBoard.mockRejectedValueOnce(new audit.ProtocolAuditError(400, 'INVALID_MONTH', 'month must be YYYY-MM'));
    const bad = await get('?month=nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'month must be YYYY-MM', code: 'INVALID_MONTH' });
    audit.saveMark.mockRejectedValueOnce(new audit.ProtocolAuditError(409, 'NOT_IN_SAMPLE', 'not in sample'));
    expect((await put({ result: 'match' })).status).toBe(409);
    audit.saveMark.mockRejectedValueOnce(new Error('connection lost with details'));
    const broken = await put({ result: 'match' });
    expect(broken.status).toBe(500);
    expect(JSON.stringify(await broken.json())).not.toContain('details');
  });

  test('a database failure logs the operation and a code only: no SQL, no customer name', async () => {
    const dbError = Object.assign(new Error("select ... where lower(name) in ('sample customer') failed"), { code: '57014' });
    audit.getBoard.mockRejectedValueOnce(dbError);
    audit.saveMark.mockRejectedValueOnce(new Error('select ... Sample Customer'));
    await get('?month=2026-04');
    await put({ result: 'match' });
    const logged = logger.error.mock.calls.map(([line]) => line).join('\n');
    expect(logged).toContain('load the protocol audit failed (57014)');
    expect(logged).toContain('save the protocol audit mark failed (Error)');
    expect(logged).not.toMatch(/sample customer|select/i);
  });
});
