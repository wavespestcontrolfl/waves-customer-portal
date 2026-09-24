// Audit repro r1-leads-reviews-1: POST /api/admin/leads/:id/schedule-callback
// must interpret the operator's date+time as ET wall-clock, not server-local.
// Production runs on a UTC box, so the test pins TZ=UTC before any Date work.
process.env.TZ = 'UTC';

jest.mock('../../models/db', () => jest.fn());
jest.mock('../../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { first_name: 'Ava', last_name: 'Admin' };
    req.technicianId = 'admin-1';
    next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../../models/db');
const leadsRouter = require('../../routes/admin-leads');
const { parseETDateTime } = require('../../utils/datetime-et');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

describe('schedule-callback parses the operator date+time as ET', () => {
  it('stores 2026-09-23 14:00 entered in the admin as 14:00 ET (18:00Z)', async () => {
    const updates = [];
    const inserts = [];
    db.mockImplementation((table) => {
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        first: jest.fn(async () => (table === 'leads' ? { id: 'lead-1' } : undefined)),
        insert: jest.fn(async (row) => { inserts.push(row); return [1]; }),
        update: jest.fn(async (row) => { updates.push(row); return 1; }),
      };
      return q;
    });

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
});
