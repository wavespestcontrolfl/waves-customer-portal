/**
 * POST /api/admin/schedule is a thin wrapper over
 * services/schedule-booking.js (createScheduleBooking), which the
 * Intelligence Bar's start-a-program tool will share. These cases pin the
 * wrapper contract: the route hands over the body and the acting user, sends
 * back exactly the { status, json } the service returns, and passes a thrown
 * error to next(). The last case pins the lazy helper hand-off: every helper
 * the service pulls from the router must exist there.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', name: 'Test Admin', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/schedule-booking', () => ({ createScheduleBooking: jest.fn() }));

const { createScheduleBooking } = require('../services/schedule-booking');
const adminScheduleRouter = require('../routes/admin-schedule');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message, handledBy: 'next' }));
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => createScheduleBooking.mockReset());

function post(body) {
  return fetch(`${baseUrl}/api/admin/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/schedule delegates to createScheduleBooking', () => {
  test('passes the body and actor, and answers with the service status and json', async () => {
    const json = { id: 'new-1', recurringCreated: 1, appointments: [{ id: 'new-1' }], warnings: [] };
    createScheduleBooking.mockResolvedValue({ status: 201, json });
    const body = { customerId: 'cust-1', scheduledDate: '2099-07-01', serviceType: 'General Pest Control' };

    const res = await post(body);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(json);
    expect(createScheduleBooking).toHaveBeenCalledTimes(1);
    expect(createScheduleBooking).toHaveBeenCalledWith({
      body,
      actor: { technicianId: 'staff-1', technicianName: 'Test Admin' },
    });
  });

  test('a refusal status and body pass through unchanged', async () => {
    const json = { code: 'duplicate_call_booking', error: 'The phone agent already booked this visit for this customer.', existingVisits: [] };
    createScheduleBooking.mockResolvedValue({ status: 409, json });

    const res = await post({ customerId: 'cust-1' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(json);
  });

  test('an error the service throws goes to next()', async () => {
    createScheduleBooking.mockRejectedValue(new Error('boom'));

    const res = await post({ customerId: 'cust-1' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom', handledBy: 'next' });
  });
});

describe('scheduleBookingHelpers', () => {
  test('provides every helper the booking service destructures', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/schedule-booking.js'), 'utf8');
    const block = src.match(/const \{([^}]+)\} = require\('\.\.\/routes\/admin-schedule'\)\.scheduleBookingHelpers;/);
    expect(block).not.toBeNull();
    const names = block[1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    const { scheduleBookingHelpers } = adminScheduleRouter;
    expect(names.filter((n) => scheduleBookingHelpers[n] === undefined)).toEqual([]);
  });
});
