/**
 * POST /api/admin/schedule/:id/in-person-terms (Book at the Table, GATE_IN_PERSON_CARD,
 * owner 2026-11-02): the signed-in admin page records the terms the customer ticked
 * on the app's isolated customer view. Dark gate 404, admin only, a stale version 409.
 * The stamping itself is covered in in-person-handoff.test.js.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-1';
    req.technician = { id: 'tech-1' };
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
const mockRecord = jest.fn();
jest.mock('../services/in-person-handoff', () => ({ recordInPersonTerms: (...a) => mockRecord(...a) }));
const mockGate = jest.fn();
jest.mock('../config/feature-gates', () => {
  const real = jest.requireActual('../config/feature-gates');
  return new Proxy(real, { get: (target, prop) => (prop === 'inPersonCardLive' ? () => mockGate() : target[prop]) });
});

const express = require('express');
const router = require('../routes/admin-schedule');

const VISIT = '0b8f1c1e-5f4a-4a53-9a39-3b6a5d0c9f11';

async function post(id, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/schedule/${id}/in-person-terms`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockReturnValue(true);
  mockRecord.mockResolvedValue({ ok: true, recorded: true });
});

describe('POST /admin/schedule/:id/in-person-terms', () => {
  test('a dark gate answers 404 {enabled:false} and records nothing', async () => {
    mockGate.mockReturnValue(false);
    const res = await post(VISIT, { terms_version: 'v2026-10' });
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a non-admin is refused 403', async () => {
    const res = await post(VISIT, { terms_version: 'v2026-10' }, { 'x-test-role': 'technician' });
    expect(res.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('passes the visit, admin, version and notice flag to the service', async () => {
    const res = await post(VISIT, { terms_version: ' v2026-10 ', consumer_notice_shown: true });
    expect(res).toEqual({ status: 200, body: { success: true, recorded: true } });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      visitId: VISIT, technician: { id: 'tech-1' }, termsVersion: 'v2026-10', consumerNoticeShown: true,
    }));
  });

  test('anything but true is "notice not shown"', async () => {
    await post(VISIT, { terms_version: 'v2026-10', consumer_notice_shown: 'yes' });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ consumerNoticeShown: false }));
  });

  test('a service refusal maps to its status and code', async () => {
    mockRecord.mockResolvedValue({ ok: false, status: 409, code: 'TERMS_VERSION_STALE', error: 'The terms were updated.' });
    expect(await post(VISIT, { terms_version: 'v2026-01' })).toEqual({ status: 409, body: { error: 'The terms were updated.', code: 'TERMS_VERSION_STALE' } });
  });

  test('a malformed visit id is 404 before the service runs', async () => {
    const res = await post('not-a-uuid', { terms_version: 'v2026-10' });
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
