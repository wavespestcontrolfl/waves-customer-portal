// GATE_TECH_PAY_STUBS (payroll item 7): a technician reads only their own finalized pay stubs.
// Route behavior with the service mocked: gate off answers 404 after the login check and before any query,
// the technician id comes from the session, and the service's 404 passes through.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payroll-runs', () => ({ listOwnChecks: jest.fn(), getOwnStub: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate(req, res, next) {
    const role = req.headers.authorization?.replace('Bearer ', '');
    if (!role) return res.status(401).end();
    req.techRole = role;
    req.technicianId = '00000000-0000-4000-8000-000000000001';
    return next();
  },
  requireTechOrAdmin(req, res, next) { return ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).end(); },
}));

const express = require('express');
const payrollRuns = require('../services/payroll-runs');
const { PayrollError } = require('../services/payroll-w4');
const router = require('../routes/tech-payroll');

const ownId = '00000000-0000-4000-8000-000000000001';
const checkId = '00000000-0000-4000-8000-0000000000aa';
let server;
let base;
const call = (path, role = 'technician') => fetch(`${base}${path}`, { headers: role ? { Authorization: `Bearer ${role}` } : {} });

beforeAll(async () => {
  const app = express();
  app.use('/api/tech/payroll', router);
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/api/tech/payroll`;
});
afterAll(async () => { delete process.env.GATE_TECH_PAY_STUBS; await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { jest.clearAllMocks(); process.env.GATE_TECH_PAY_STUBS = 'true'; });

test.each(['/checks', `/checks/${checkId}/stub`])('gate off answers 404 after the login check and before any query: %s', async (path) => {
  for (const off of [undefined, '1', 'TRUE', 'on', 'false']) {
    if (off === undefined) delete process.env.GATE_TECH_PAY_STUBS; else process.env.GATE_TECH_PAY_STUBS = off;
    const response = await call(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ enabled: false });
  }
  expect(payrollRuns.listOwnChecks).not.toHaveBeenCalled();
  expect(payrollRuns.getOwnStub).not.toHaveBeenCalled();
});

test('gate off still needs the staff login: no route here is public', async () => {
  delete process.env.GATE_TECH_PAY_STUBS;
  expect((await call('/checks', null)).status).toBe(401);
  expect((await call(`/checks/${checkId}/stub`, 'customer')).status).toBe(403);
});

test.each([null, 'customer'])('rejects %s before reading any pay record', async (role) => {
  expect((await call('/checks', role)).status).toBe(role ? 403 : 401);
  expect((await call(`/checks/${checkId}/stub`, role)).status).toBe(role ? 403 : 401);
  expect(payrollRuns.listOwnChecks).not.toHaveBeenCalled();
  expect(payrollRuns.getOwnStub).not.toHaveBeenCalled();
});

test('the list is scoped by the authenticated technician, never a client-sent id', async () => {
  payrollRuns.listOwnChecks.mockResolvedValue([{ id: checkId }]);
  const response = await call(`/checks?technicianId=00000000-0000-4000-8000-000000000002`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ checks: [{ id: checkId }] });
  expect(payrollRuns.listOwnChecks).toHaveBeenCalledWith(ownId);
});

test('an admin login reads through the same own-id scope', async () => {
  payrollRuns.listOwnChecks.mockResolvedValue([]);
  expect((await call('/checks', 'admin')).status).toBe(200);
  expect(payrollRuns.listOwnChecks).toHaveBeenCalledWith(ownId);
});

test('the stub is read for the authenticated technician', async () => {
  payrollRuns.getOwnStub.mockResolvedValue({ checkId });
  const response = await call(`/checks/${checkId}/stub?technicianId=00000000-0000-4000-8000-000000000002`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ stub: { checkId } });
  expect(payrollRuns.getOwnStub).toHaveBeenCalledWith(ownId, checkId);
});

test('another person\'s, draft or voided check answers the service 404', async () => {
  payrollRuns.getOwnStub.mockRejectedValue(new PayrollError(404, 'Pay stub not found.'));
  const response = await call(`/checks/${checkId}/stub`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Pay stub not found.' });
});

test('an unexpected failure answers 500 without the error text', async () => {
  payrollRuns.listOwnChecks.mockRejectedValue(new Error('relation "payroll_checks" broke'));
  const response = await call('/checks');
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain('payroll_checks');
});
