// Call recordings are admin-only (security audit 2026-10-01). A technician
// login must never list recordings, read a call row (transcript), stream the
// audio, run paid processing, tag a disposition (spam deletes the call and
// blocks the caller) or touch the block list. The follow-through surfaces a
// technician works from the field stay reachable.
//
// The role middlewares are the REAL ones; only adminAuthenticate is replaced
// so the test can pick the role.
let mockRole = 'technician';
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  twilio: { accountSid: 'AC_test', authToken: 'auth_test' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({
  getStats: jest.fn(async () => ({ total: 0 })),
  processRecording: jest.fn(),
  processAllPending: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = 'staff-1';
      req.techRole = mockRole;
      next();
    },
  };
});

const express = require('express');
const db = require('../models/db');
const processor = require('../services/call-recording-processor');
const router = require('../routes/admin-call-recordings');

const CALL_ID = '11111111-2222-4333-8444-555555555555';
const SID = `CA${'a'.repeat(32)}`;
const RECORDING_SID = `RE${'1'.repeat(32)}`;

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/call-recordings', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

function call(base, method, path, body) {
  return fetch(`${base}/admin/call-recordings${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// Every row carries a body slot (null = none): a two-value row would make
// jest pass its `done` callback as the third argument.
const ADMIN_ONLY = [
  ['GET', '/stats', null],
  ['GET', '/recordings', null],
  ['GET', `/recording/${CALL_ID}`, null],
  ['GET', `/audio/${RECORDING_SID}`, null],
  ['POST', `/process/${SID}`, {}],
  ['POST', '/process-all', {}],
  ['POST', `/synopsis/${SID}`, {}],
  ['PUT', `/calls/${CALL_ID}/disposition`, { disposition: 'spam' }],
  ['GET', '/blocked', null],
  ['DELETE', '/blocked/9415550100', null],
];

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => { throw new Error('db must not be reached'); });
});

describe('call recordings are admin-only', () => {
  test.each(ADMIN_ONLY)('%s %s → 403 for a technician, before any data access', async (method, path, body) => {
    mockRole = 'technician';
    await withServer(async (base) => {
      const res = await call(base, method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
    });
    expect(db).not.toHaveBeenCalled();
    expect(processor.getStats).not.toHaveBeenCalled();
    expect(processor.processRecording).not.toHaveBeenCalled();
    expect(processor.processAllPending).not.toHaveBeenCalled();
  });

  test.each(ADMIN_ONLY)('%s %s is not refused by the role gate for an admin', async (method, path, body) => {
    mockRole = 'admin';
    await withServer(async (base) => {
      const res = await call(base, method, path, body);
      // The stubbed db/processor may make the handler fail; the role gate must not.
      expect(res.status).not.toBe(403);
    });
  });

  test('an admin reads the stats', async () => {
    mockRole = 'admin';
    await withServer(async (base) => {
      const res = await call(base, 'GET', '/stats');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ total: 0 });
    });
  });
});

describe('technician follow-through stays reachable', () => {
  test.each([
    ['GET', '/commitments/open'],
    ['GET', '/proposals'],
  ])('%s %s is not refused by the role gate for a technician', async (method, path) => {
    mockRole = 'technician';
    await withServer(async (base) => {
      const res = await call(base, method, path);
      expect(res.status).not.toBe(403);
    });
  });
});
