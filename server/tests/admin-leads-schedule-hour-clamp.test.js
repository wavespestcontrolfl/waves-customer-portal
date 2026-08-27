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

function postAppointment(baseUrl, body) {
  return fetch(`${baseUrl}/admin/leads/lead-1/schedule-appointment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2027-01-15', serviceType: 'Pest Control', ...body }),
  });
}

describe('POST /admin/leads/:id/schedule-appointment on-the-hour clamp', () => {
  beforeEach(() => {
    db.mockReset();
  });

  // Appointment windows start on the hour (owner rule 2026-07-27).
  it.each(['10:30', '09:15', '9:00', '10:00:00', 'noonish'])(
    'rejects %s with 400 before touching the database',
    async (time) => {
      await withServer(async (baseUrl) => {
        const res = await postAppointment(baseUrl, { time });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/on the hour/i);
        expect(db).not.toHaveBeenCalled();
      });
    },
  );

  it('lets an HH:00 time through validation (proceeds to the lead lookup)', async () => {
    await withServer(async (baseUrl) => {
      // Lead lookup returns nothing → 404, which proves the time cleared the
      // format gate without mocking the whole booking transaction.
      const q = {
        where: jest.fn(() => q),
        whereNull: jest.fn(() => q),
        first: jest.fn(async () => undefined),
      };
      db.mockImplementation(() => q);
      const res = await postAppointment(baseUrl, { time: '10:00' });
      expect(res.status).toBe(404);
      expect(db).toHaveBeenCalledWith('leads');
    });
  });
});

describe('POST /admin/leads/:id/schedule-appointment shared window rules (scheduling/window-rules.js)', () => {
  beforeEach(() => db.mockReset());

  // Lead found; the shared validator runs after the lead/duration lookups
  // and its 422 is mapped onto this route's 400 shape. No transaction opens.
  function leadFound() {
    const q = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      first: jest.fn(async () => ({ id: 'lead-1', first_name: 'Test', customer_id: null })),
    };
    db.mockImplementation(() => q);
    db.transaction = jest.fn(async () => { throw new Error('transaction must not open on a refused window'); });
  }

  it('lets a pre-8am on-the-hour start through validation (no day-start floor)', async () => {
    await withServer(async (baseUrl) => {
      leadFound();
      const res = await postAppointment(baseUrl, { time: '07:00' });
      const body = await res.json();
      // The window validator no longer 400s an early start; the route moves
      // on past the lead lookup (the rest of the booking is not mocked here).
      expect(res.status).not.toBe(400);
      expect(body.error || '').not.toMatch(/before 08:00/);
      expect(db).toHaveBeenCalledWith('leads');
    });
  });

  it('rejects a duration that runs past the day end (and so can never wrap midnight) with 400', async () => {
    await withServer(async (baseUrl) => {
      leadFound();
      const res = await postAppointment(baseUrl, { time: '19:00', durationMinutes: 120 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/end by 20:00/);
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});
