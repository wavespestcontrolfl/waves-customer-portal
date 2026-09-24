/**
 * admin-consultations routes — role gating (a technician records the outcome
 * of their own consultation; only admin reads the cross-technician stats
 * panel) and the service-error → HTTP status mapping (400/404/409).
 *
 * Pattern mirrors admin-ads-route-guards.test.js: real requireAdmin /
 * requireTechOrAdmin run; only adminAuthenticate is stubbed to inject a
 * controllable role, and both the service module and db are mocked so no
 * real query ever runs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', name: 'Adam', role: mockCurrentRole };
      req.technicianId = 'staff-1';
      req.techRole = mockCurrentRole;
      return next();
    },
  };
});

const mockRecordOutcome = jest.fn();
const mockConsultationStats = jest.fn();
jest.mock('../services/consultation-outcomes', () => ({
  recordOutcome: (...args) => mockRecordOutcome(...args),
  consultationStats: (...args) => mockConsultationStats(...args),
}));

let mockOutcomeRow = null;
jest.mock('../models/db', () => {
  const fn = jest.fn(() => ({
    where: () => ({ first: () => Promise.resolve(mockOutcomeRow) }),
  }));
  return fn;
});

const express = require('express');
const consultationsRouter = require('../routes/admin-consultations');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/consultations', consultationsRouter);
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));  
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: method.toUpperCase(),
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json || {} };
}

beforeEach(() => {
  mockCurrentRole = 'admin';
  mockOutcomeRow = null;
  jest.clearAllMocks();
});

describe('POST /:scheduledServiceId/outcome — a technician records their own consultation', () => {
  test('technician role is allowed', async () => {
    mockCurrentRole = 'technician';
    mockRecordOutcome.mockResolvedValue({ id: 'co-1', outcome: 'warm' });
    const res = await call('post', '/api/admin/consultations/visit-1/outcome', { outcome: 'warm' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ id: 'co-1', outcome: 'warm' });
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledServiceId: 'visit-1', outcome: 'warm' }),
      expect.objectContaining({ trx: expect.any(Function) }),
    );
  });

  test('admin role is also allowed', async () => {
    mockRecordOutcome.mockResolvedValue({ id: 'co-1', outcome: 'cold' });
    const res = await call('post', '/api/admin/consultations/visit-1/outcome', { outcome: 'cold' });
    expect(res.status).toBe(200);
  });

  test.each([
    [400, 'VALIDATION', "outcome 'won' cannot be recorded directly"],
    [404, 'NOT_FOUND', 'Scheduled service not found'],
    [409, 'NOT_CONSULTATION', 'That visit is not a Waves Assessment consultation'],
  ])('maps a %i %s service error to the same HTTP status', async (statusCode, code, message) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.isOperational = true;
    err.code = code;
    mockRecordOutcome.mockRejectedValue(err);
    const res = await call('post', '/api/admin/consultations/visit-1/outcome', { outcome: 'won' });
    expect(res.status).toBe(statusCode);
    expect(res.body).toMatchObject({ error: message, code });
  });
});

describe('GET /:scheduledServiceId/outcome', () => {
  test('404s when no outcome is recorded for that visit', async () => {
    mockOutcomeRow = null;
    const res = await call('get', '/api/admin/consultations/visit-1/outcome');
    expect(res.status).toBe(404);
  });

  test('returns the row when one exists (technician allowed)', async () => {
    mockCurrentRole = 'technician';
    mockOutcomeRow = { id: 'co-1', outcome: 'warm', scheduled_service_id: 'visit-1' };
    const res = await call('get', '/api/admin/consultations/visit-1/outcome');
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual(mockOutcomeRow);
  });
});

describe('GET /stats — admin only', () => {
  test('technician role gets 403', async () => {
    mockCurrentRole = 'technician';
    const res = await call('get', '/api/admin/consultations/stats');
    expect(res.status).toBe(403);
    expect(mockConsultationStats).not.toHaveBeenCalled();
  });

  test('admin role gets the stats payload, default window when no from/to given', async () => {
    mockConsultationStats.mockResolvedValue({ booked: 5, showed: 3 });
    const res = await call('get', '/api/admin/consultations/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ booked: 5, showed: 3 });
    expect(mockConsultationStats).toHaveBeenCalledWith({ from: undefined, to: undefined });
  });

  test('admin role passes through from/to query params', async () => {
    mockConsultationStats.mockResolvedValue({ booked: 1 });
    const res = await call('get', '/api/admin/consultations/stats?from=2026-01-01&to=2026-02-01');
    expect(res.status).toBe(200);
    expect(mockConsultationStats).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-02-01' });
  });
});
