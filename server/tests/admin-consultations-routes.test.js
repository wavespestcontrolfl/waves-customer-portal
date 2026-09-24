/**
 * admin-consultations routes — role gating (a technician records/reads the
 * outcome of THEIR OWN consultation only; only admin reads the
 * cross-technician stats panel — quote_notes is internal, so any
 * technician reading/overwriting any other tech's consultation by
 * guessing/enumerating a scheduledServiceId would be a real leak/tamper
 * path — P0 fix), and the service-error → HTTP status mapping (400/404/409).
 *
 * Pattern mirrors admin-ads-route-guards.test.js: real requireAdmin /
 * requireTechOrAdmin run; only adminAuthenticate is stubbed to inject a
 * controllable role, and both the service module and db are mocked so no
 * real query ever runs.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockCurrentRole = 'admin';
const ACTING_TECHNICIAN_ID = 'staff-1';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: ACTING_TECHNICIAN_ID, name: 'Adam', role: mockCurrentRole };
      req.technicianId = ACTING_TECHNICIAN_ID;
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
  WON_WINDOW_DAYS: 90,
}));

// Table-aware db mock: the route's ownership guard reads scheduled_services
// (technician_id), separately from the outcome row it reads from
// consultation_outcomes for GET.
let mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: ACTING_TECHNICIAN_ID };
let mockOutcomeRow = null;
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => ({
    where: () => ({
      first: () => {
        if (table === 'scheduled_services') return Promise.resolve(mockVisitRow);
        if (table === 'consultation_outcomes') return Promise.resolve(mockOutcomeRow);
        return Promise.resolve(null);
      },
    }),
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
  mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: ACTING_TECHNICIAN_ID };
  mockOutcomeRow = null;
  jest.clearAllMocks();
});

describe('POST /:scheduledServiceId/outcome — a technician records their own consultation', () => {
  test('technician role is allowed on their OWN assigned visit', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: ACTING_TECHNICIAN_ID };
    mockRecordOutcome.mockResolvedValue({ id: 'co-1', outcome: 'warm' });
    const res = await call('post', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome', { outcome: 'warm' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ id: 'co-1', outcome: 'warm' });
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledServiceId: '11111111-1111-4111-8111-111111111111', outcome: 'warm' }),
      expect.objectContaining({ trx: expect.any(Function) }),
    );
  });

  test('admin role is also allowed', async () => {
    mockRecordOutcome.mockResolvedValue({ id: 'co-1', outcome: 'cold' });
    const res = await call('post', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome', { outcome: 'cold' });
    expect(res.status).toBe(200);
  });

  test('P0: a technician CANNOT record an outcome for another technician\'s consultation (403, service never called)', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: 'someone-else' };
    const res = await call('post', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome', { outcome: 'warm' });
    expect(res.status).toBe(403);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  test('P0: admin CAN record an outcome for ANY technician\'s consultation', async () => {
    mockCurrentRole = 'admin';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: 'someone-else' };
    mockRecordOutcome.mockResolvedValue({ id: 'co-1', outcome: 'cold' });
    const res = await call('post', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome', { outcome: 'cold' });
    expect(res.status).toBe(200);
    expect(mockRecordOutcome).toHaveBeenCalled();
  });

  test('404s a technician on an unknown visit (before the service is ever called)', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = null;
    const res = await call('post', '/api/admin/consultations/nope/outcome', { outcome: 'warm' });
    expect(res.status).toBe(404);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
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
    const res = await call('post', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome', { outcome: 'won' });
    expect(res.status).toBe(statusCode);
    expect(res.body).toMatchObject({ error: message, code });
  });
});

describe('GET /:scheduledServiceId/outcome', () => {
  test('404s when no outcome is recorded for that visit', async () => {
    mockOutcomeRow = null;
    const res = await call('get', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome');
    expect(res.status).toBe(404);
  });

  test('returns the row when one exists (technician allowed on their own visit)', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: ACTING_TECHNICIAN_ID };
    mockOutcomeRow = { id: 'co-1', outcome: 'warm', scheduled_service_id: '11111111-1111-4111-8111-111111111111' };
    const res = await call('get', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome');
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual(mockOutcomeRow);
  });

  test('P0: a technician CANNOT read another technician\'s consultation outcome (403, quote_notes never leaves the server)', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: 'someone-else' };
    mockOutcomeRow = { id: 'co-1', outcome: 'warm', scheduled_service_id: '11111111-1111-4111-8111-111111111111', quote_notes: 'internal pricing notes' };
    const res = await call('get', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome');
    expect(res.status).toBe(403);
    expect(res.body.outcome).toBeUndefined();
  });

  test('P0: admin CAN read ANY technician\'s consultation outcome', async () => {
    mockCurrentRole = 'admin';
    mockVisitRow = { id: '11111111-1111-4111-8111-111111111111', technician_id: 'someone-else' };
    mockOutcomeRow = { id: 'co-1', outcome: 'warm', scheduled_service_id: '11111111-1111-4111-8111-111111111111' };
    const res = await call('get', '/api/admin/consultations/11111111-1111-4111-8111-111111111111/outcome');
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual(mockOutcomeRow);
  });

  test('404s a technician on an unknown visit', async () => {
    mockCurrentRole = 'technician';
    mockVisitRow = null;
    const res = await call('get', '/api/admin/consultations/nope/outcome');
    expect(res.status).toBe(404);
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

  // Codex #4710 r3 P2: a bad window is a 400, never a Postgres 500.
  test.each([
    ['?from=bad', /from must be a real/],
    ['?from=2026-02-31', /from must be a real/],
    ['?to=2026-13-01', /to must be a real/],
    ['?from=2026-03-01&to=2026-02-01', /on or before/],
    // Codex #4710 r4 P2: reversed against the DEFAULTED endpoint too.
    ['?from=2099-01-01', /on or before/],
    ['?to=2020-01-01', /on or before/],
  ])('rejects %s with 400 before querying', async (qs, message) => {
    mockConsultationStats.mockClear();
    const res = await call('get', `/api/admin/consultations/stats${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(mockConsultationStats).not.toHaveBeenCalled();
  });
});
