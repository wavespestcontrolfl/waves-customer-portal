jest.mock('../services/field-team-program', () => Object.fromEntries(['overview', 'setup', 'visitOptions', 'estimateOptions', 'evidenceDetail', 'score', 'saveRule', 'saveLevel', 'saveAllocation', 'saveServiceEvidence', 'saveBusinessEvidence', 'saveAssessment', 'saveStatement'].map(key => [key, jest.fn()])));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate(req, res, next) {
    const role = req.headers.authorization?.replace('Bearer ', '');
    if (!role) return res.status(401).end();
    req.techRole = role;
    req.technicianId = '00000000-0000-4000-8000-000000000001';
    next();
  },
  requireTechOrAdmin(req, res, next) { return ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).end(); },
  requireAdmin(req, res, next) { return req.techRole === 'admin' ? next() : res.status(403).end(); },
}));

const express = require('express');
const program = require('../services/field-team-program');
const router = require('../routes/tech-pay-growth');
const ownId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
let server;
let base;
const call = (path = '', role = 'technician', body) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(role ? { Authorization: `Bearer ${role}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/pay-growth', router);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/pay-growth`;
});
afterAll(async () => { delete process.env.GATE_FIELD_TEAM_PROGRAM; await new Promise(resolve => server.close(resolve)); });
beforeEach(() => { jest.clearAllMocks(); process.env.GATE_FIELD_TEAM_PROGRAM = 'true'; program.overview.mockResolvedValue({ person: { id: ownId } }); });

test.each([null, 'customer'])('rejects %s before reading pay records', async role => {
  expect((await call('', role)).status).toBe(role ? 403 : 401);
  expect(program.overview).not.toHaveBeenCalled();
});
test('keeps the entire program dark unless explicitly enabled, including writes', async () => {
  delete process.env.GATE_FIELD_TEAM_PROGRAM;
  expect(await (await call('/availability')).json()).toEqual({ available: false });
  expect((await call()).status).toBe(404);
  expect((await call('/levels', 'admin', {})).status).toBe(404);
  expect(program.overview).not.toHaveBeenCalled();
  expect(program.saveLevel).not.toHaveBeenCalled();
});
test('a technician reads only their own records with no browser caching', async () => {
  const result = await call('?month=2026-09');
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(program.overview).toHaveBeenCalledWith(ownId, '2026-09');
  expect(await result.json()).toMatchObject({ can_manage: false });
});
test('query parameters cannot select another employee for a technician', async () => {
  expect((await call(`?technicianId=${otherId}`)).status).toBe(403);
  expect(program.overview).not.toHaveBeenCalled();
});
test('an admin can select an employee without changing the authenticated actor', async () => {
  expect((await call(`?technicianId=${otherId}&month=2026-09`, 'admin')).status).toBe(200);
  expect(program.overview).toHaveBeenCalledWith(otherId, '2026-09');
});
test.each(['/setup', '/visits', '/estimates', `/services/${otherId}/evidence`])('technicians cannot access admin evidence selectors at %s', async path => {
  expect((await call(path)).status).toBe(403);
  expect(program.setup).not.toHaveBeenCalled();
  expect(program.evidenceDetail).not.toHaveBeenCalled();
});
test.each(['/rules', '/levels', '/allocations', '/service-evidence', '/new-business', '/assessments', '/statements'])('technicians cannot mutate %s', async path => {
  expect((await call(path, 'technician', {})).status).toBe(403);
  for (const [key, fn] of Object.entries(program)) if (key.startsWith('save')) expect(fn).not.toHaveBeenCalled();
});
test.each(['?month=2026-13', '?technicianId=invalid', '?month[]=2026-09', '?status=paid'])('rejects malformed or unrecognized selectors %s', async query => {
  expect((await call(query)).status).toBe(400);
  expect(program.overview).not.toHaveBeenCalled();
});
test('the score reader receives the verified actor for its ownership check', async () => {
  program.score.mockResolvedValue({ entries: [] });
  expect((await call(`/services/${otherId}/score`)).status).toBe(200);
  expect(program.score).toHaveBeenCalledWith(otherId, { id: ownId, role: 'technician' });
});
test('invalid service identifiers do not reach the database reader', async () => {
  expect((await call('/services/invalid/score')).status).toBe(400);
  expect(program.score).not.toHaveBeenCalled();
});
test('concurrent-write conflicts are actionable without leaking SQL', async () => {
  program.saveLevel.mockRejectedValue(Object.assign(new Error('private SQL detail'), { code: '23505' }));
  const result = await call('/levels', 'admin', {});
  expect(result.status).toBe(409);
  expect(JSON.stringify(await result.json())).not.toContain('private SQL');
});
