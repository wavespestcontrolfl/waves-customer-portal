jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  // admin-leads.js transitively loads admin-customers.js, whose route
  // registration references requireAdmin at import time — mock it so the
  // suite can load.
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

// db stub for the create path: leads.insert(...).returning('*') resolves the
// inserted row, lead_activities.insert resolves. Captures the insert payload.
function primeCreate(captured) {
  db.mockImplementation((table) => {
    if (table === 'leads') {
      return {
        insert: jest.fn((row) => {
          captured.insert = row;
          return { returning: jest.fn(async () => [{ id: 'lead-1', ...row }]) };
        }),
      };
    }
    if (table === 'lead_activities') {
      return { insert: jest.fn(async () => [1]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

// db stub for the update path: the existence check resolves a row, then
// update(...).returning('*') captures the patch.
function primeUpdate(captured, existing = { id: 'lead-1', status: 'new' }) {
  db.mockImplementation((table) => {
    if (table === 'leads') {
      const q = {};
      q.where = jest.fn(() => q);
      q.whereNull = jest.fn(() => q);
      q.first = jest.fn(async () => existing);
      q.update = jest.fn((patch) => {
        captured.update = patch;
        return { returning: jest.fn(async () => [{ ...existing, ...patch }]) };
      });
      return q;
    }
    if (table === 'lead_activities') {
      return { insert: jest.fn(async () => [1]) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('builder warranty fields on leads', () => {
  test('create accepts provider + date-shaped expiry and stores empty as NULL', async () => {
    const captured = {};
    primeCreate(captured);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: 'Test',
          builder_warranty_provider: '  Builder Pest Co  ',
          builder_warranty_expires_on: '2026-08-31',
        }),
      });
      expect(res.status).toBe(200);
    });
    expect(captured.insert.builder_warranty_provider).toBe('Builder Pest Co');
    expect(captured.insert.builder_warranty_expires_on).toBe('2026-08-31');

    primeCreate(captured);
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: 'Test',
          builder_warranty_provider: '',
          builder_warranty_expires_on: '',
        }),
      });
      expect(res.status).toBe(200);
    });
    expect(captured.insert.builder_warranty_provider).toBeNull();
    expect(captured.insert.builder_warranty_expires_on).toBeNull();
  });

  test('create rejects non-date and impossible-date expiries (Postgres would 500 on a DATE it cannot parse)', async () => {
    const captured = {};
    primeCreate(captured);
    await withServer(async (baseUrl) => {
      // Timestamps smuggle a timezone into a calendar DATE; impossible
      // calendar dates pass a shape regex but blow up at insert (codex P2).
      for (const bad of ['2026-08-31T00:00:00Z', '2026-02-31', '2026-99-01', '2026-00-10']) {
        const res = await fetch(`${baseUrl}/admin/leads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ first_name: 'Test', builder_warranty_expires_on: bad }),
        });
        expect(res.status).toBe(400);
      }
    });
    expect(captured.insert).toBeUndefined();
  });

  test('update accepts the fields, normalizes clearing to NULL, and rejects bad dates', async () => {
    const captured = {};
    primeUpdate(captured);
    await withServer(async (baseUrl) => {
      let res = await fetch(`${baseUrl}/admin/leads/lead-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_warranty_provider: 'Builder Pest Co',
          builder_warranty_expires_on: '2026-09-15',
        }),
      });
      expect(res.status).toBe(200);
      expect(captured.update.builder_warranty_provider).toBe('Builder Pest Co');
      expect(captured.update.builder_warranty_expires_on).toBe('2026-09-15');

      res = await fetch(`${baseUrl}/admin/leads/lead-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder_warranty_provider: '',
          builder_warranty_expires_on: '',
        }),
      });
      expect(res.status).toBe(200);
      expect(captured.update.builder_warranty_provider).toBeNull();
      expect(captured.update.builder_warranty_expires_on).toBeNull();

      captured.update = undefined;
      for (const bad of ['next month', '2026-02-31', '2026-13-05']) {
        res = await fetch(`${baseUrl}/admin/leads/lead-1`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ builder_warranty_expires_on: bad }),
        });
        expect(res.status).toBe(400);
      }
      expect(captured.update).toBeUndefined();
    });
  });
});
