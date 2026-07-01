jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  // admin-leads.js transitively loads admin-customers.js, whose route
  // registration references requireAdmin at import time — mock it so the suite
  // can load (otherwise: "Route.post() requires a callback ... got Undefined").
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeQuery({ first } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  return q;
}

function makeDeleteTransaction(calls) {
  const trx = jest.fn((table) => {
    const q = {};
    q.where = jest.fn((clause) => {
      calls.push({ table, op: 'where', clause });
      return q;
    });
    q.update = jest.fn(async (patch) => {
      calls.push({ table, op: 'update', patch });
      return 1;
    });
    q.del = jest.fn(async () => {
      calls.push({ table, op: 'del' });
      return 1;
    });
    return q;
  });
  trx.schema = { hasTable: jest.fn(async (table) => table === 'lead_agent_responses') };
  return trx;
}

describe('admin leads delete route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn(async () => undefined);
  });

  test('deletes a lead and detaches agent responses', async () => {
    const calls = [];
    const lead = { id: 'lead-1', phone: '9415550101' };
    db.mockImplementation((table) => {
      if (table === 'leads') return makeQuery({ first: lead });
      throw new Error(`Unexpected table ${table}`);
    });
    db.transaction = jest.fn(async (callback) => callback(makeDeleteTransaction(calls)));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1`, { method: 'DELETE' });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true, deleted: true });
    });

    expect(calls).toEqual([
      { table: 'lead_agent_responses', op: 'where', clause: { lead_id: 'lead-1' } },
      { table: 'lead_agent_responses', op: 'update', patch: { lead_id: null } },
      { table: 'lead_activities', op: 'where', clause: { lead_id: 'lead-1' } },
      { table: 'lead_activities', op: 'del' },
      { table: 'leads', op: 'where', clause: { id: 'lead-1' } },
      { table: 'leads', op: 'del' },
    ]);
  });
});
