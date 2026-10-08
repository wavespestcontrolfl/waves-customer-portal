// GATE_STAFF_ONBOARDING_DOCS: dark = no reads and no records; the routes are admin-guarded and
// reach the right service call with the caller's own identity.
const express = require('express');
jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('the database must not be read'); });
  db.transaction = jest.fn(() => { throw new Error('the database must not be read'); });
  return db;
});
jest.mock('../services/staff-onboarding', () => ({
  onboardingFor: jest.fn().mockResolvedValue({ enabled: true, documents: [], counts: { outstanding: 0, total: 0 } }),
  onboardingForTeam: jest.fn().mockResolvedValue({ enabled: true, technicians: [] }),
}));
jest.mock('../services/staff-documents', () => ({ list: jest.fn(), setOnboardingRequired: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
    req.techRole = req.headers['x-role'] || 'technician'; req.technicianId = '00000000-0000-4000-8000-000000000001'; next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin required' })),
}));
const db = require('../models/db');
const documents = require('../services/staff-documents');
const realOnboarding = jest.requireActual('../services/staff-onboarding');

const ENV = ['GATE_STAFF_ONBOARDING_DOCS', 'GATE_CONTROLLED_STAFF_DOCUMENTS'];
const saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
afterAll(() => { for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
beforeEach(() => { for (const name of ENV) delete process.env[name]; jest.clearAllMocks(); });

describe('service while dark', () => {
  const tech = { id: 'tech-1', role: 'technician' };
  const empty = { enabled: false, documents: [], counts: { outstanding: 0, total: 0 } };

  test.each([
    ['both gates unset', {}],
    ['only the onboarding gate on', { GATE_STAFF_ONBOARDING_DOCS: 'true' }],
    ['only the staff documents gate on', { GATE_CONTROLLED_STAFF_DOCUMENTS: 'true' }],
    ['the onboarding gate set to a non-strict value', { GATE_STAFF_ONBOARDING_DOCS: '1', GATE_CONTROLLED_STAFF_DOCUMENTS: 'true' }],
  ])('%s: both reads answer empty without touching the database', async (name, env) => {
    Object.assign(process.env, env);
    expect(await realOnboarding.onboardingFor(tech)).toEqual(empty);
    expect(await realOnboarding.onboardingForTeam()).toEqual({ enabled: false, technicians: [] });
    expect(db).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  const onboarding = require('../services/staff-onboarding');
  const app = express();
  app.use(express.json());
  app.use('/documents', require('../routes/tech-staff-documents'));
  let server;
  let origin;
  const headers = (role = 'technician') => ({ Authorization: 'Bearer qa', 'x-role': role, 'Content-Type': 'application/json' });
  const documentId = '00000000-0000-4000-8000-0000000000aa';
  beforeAll(async () => {
    server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  test('dark staff documents: the onboarding routes 404 with the rest of the router', async () => {
    expect((await fetch(`${origin}/documents/onboarding`, { headers: headers() })).status).toBe(404);
    expect(onboarding.onboardingFor).not.toHaveBeenCalled();
  });

  test('the caller reads only their own standing, and /onboarding is not taken for a document id', async () => {
    process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
    const response = await fetch(`${origin}/documents/onboarding`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(onboarding.onboardingFor).toHaveBeenCalledWith({ id: '00000000-0000-4000-8000-000000000001', role: 'technician' });
    expect(documents.list).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/documents/onboarding`)).status).toBe(401);
  });

  test('the team list and the required toggle are admin only', async () => {
    process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
    expect((await fetch(`${origin}/documents/onboarding/team`, { headers: headers() })).status).toBe(403);
    expect((await fetch(`${origin}/documents/${documentId}/onboarding-required`, { method: 'POST', headers: headers(), body: JSON.stringify({ required: true }) })).status).toBe(403);
    expect(onboarding.onboardingForTeam).not.toHaveBeenCalled();
    expect(documents.setOnboardingRequired).not.toHaveBeenCalled();

    expect((await fetch(`${origin}/documents/onboarding/team`, { headers: headers('admin') })).status).toBe(200);
    documents.setOnboardingRequired.mockResolvedValue({ id: documentId, onboarding_required: true });
    const toggled = await fetch(`${origin}/documents/${documentId}/onboarding-required`, { method: 'POST', headers: headers('admin'), body: JSON.stringify({ required: true }) });
    expect(toggled.status).toBe(200);
    expect(documents.setOnboardingRequired).toHaveBeenCalledWith(documentId, true, { id: '00000000-0000-4000-8000-000000000001', role: 'admin' });
  });

  test('the toggle rejects a missing or non-boolean value', async () => {
    process.env.GATE_CONTROLLED_STAFF_DOCUMENTS = 'true';
    for (const body of [{}, { required: 'yes' }]) {
      const response = await fetch(`${origin}/documents/${documentId}/onboarding-required`, { method: 'POST', headers: headers('admin'), body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect(documents.setOnboardingRequired).not.toHaveBeenCalled();
  });
});
