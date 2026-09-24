// Audit repro r1-leads-reviews-1: POST /api/admin/leads/:id/schedule-callback
// must interpret the operator's date+time as ET wall-clock, not server-local.
// Production runs on a UTC box, so the test pins TZ=UTC before any Date work.
process.env.TZ = 'UTC';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');
const { parseETDateTime } = require('../utils/datetime-et');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

// The route writes the lead + activity inside one transaction (main); the
// lead lookup runs on the plain connection. Both hand out the same builder.
function mockDb({ updates, inserts }) {
  const builder = (table) => {
    const q = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      first: jest.fn(async () => (table === 'leads' ? { id: 'lead-1' } : undefined)),
      insert: jest.fn(async (row) => { inserts.push(row); return [1]; }),
      update: jest.fn(async (row) => { updates.push(row); return 1; }),
    };
    return q;
  };
  db.mockImplementation(builder);
  db.transaction = jest.fn(async (work) => work(builder));
}

describe('schedule-callback parses the operator date+time as ET', () => {
  it('stores 2026-09-23 14:00 entered in the admin as 14:00 ET (18:00Z)', async () => {
    const updates = [];
    const inserts = [];
    mockDb({ updates, inserts });

    const { server, baseUrl } = appServer();
    try {
      const res = await fetch(`${baseUrl}/admin/leads/lead-1/schedule-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-09-23', time: '14:00' }),
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }

    expect(updates).toHaveLength(1);
    const stored = updates[0].next_follow_up_at;
    const expected = parseETDateTime('2026-09-23T14:00:00'); // 2026-09-23T18:00:00.000Z (EDT)
    expect(expected.toISOString()).toBe('2026-09-23T18:00:00.000Z');
    expect(new Date(stored).toISOString()).toBe(expected.toISOString());

    // The activity line should echo the promised wall-clock time.
    expect(inserts[0].description).toMatch(/2:00:00 PM/);
  });

  it('rejects a spring-forward wall time that does not exist in Eastern Time (codex round-1 P2)', async () => {
    const updates = [];
    mockDb({ updates, inserts: [] });

    const { server, baseUrl } = appServer();
    let res;
    try {
      // 2026-03-08 is the US spring-forward date: clocks jump 2:00 AM ->
      // 3:00 AM ET, so 2:30 AM never happens that day.
      res = await fetch(`${baseUrl}/admin/leads/lead-1/schedule-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-03-08', time: '02:30' }),
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('rejects a fall-back wall time that happens twice in Eastern Time instead of storing the first occurrence (codex round-3 P2)', async () => {
    const updates = [];
    mockDb({ updates, inserts: [] });
    const { server, baseUrl } = appServer();
    let res;
    let repeated;
    let unique;
    try {
      // 2026-11-01 is the US fall-back date: 1:00-1:59 AM ET happens once in
      // EDT and again in EST. 01:30 is ambiguous; 03:30 the same day is not.
      repeated = await fetch(`${baseUrl}/admin/leads/lead-1/schedule-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-01', time: '01:30' }),
      });
      unique = await fetch(`${baseUrl}/admin/leads/lead-1/schedule-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-01', time: '03:30' }),
      });
      res = repeated;
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/twice/);
    expect(unique.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(new Date(updates[0].next_follow_up_at).toISOString()).toBe('2026-11-01T08:30:00.000Z'); // 03:30 EST
  });
});
