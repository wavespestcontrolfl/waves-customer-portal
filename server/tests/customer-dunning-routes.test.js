// Customer-level overdue reminders — the staff routes (dunning consolidation
// §8, B-8): POST /api/admin/customers/:id/dunning-schedule/{send-now,pause,
// resume,release} (admin only, like the neighbouring collection-hold
// controls) and the invoice follow-up send-now, which answers with the
// schedule's result when the customer is on a customer-level schedule.
// Real routers over HTTP; auth is a stand-in that admits only an admin.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'tech-7';
    req.techRole = req.get('x-test-role') || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/stripe', () => ({}));
const mockControl = jest.fn();
jest.mock('../services/customer-dunning/wiring', () => ({
  ...jest.requireActual('../services/customer-dunning/wiring'),
  controlCustomerSchedule: (...a) => mockControl(...a),
}));
const mockSendNextTouchNow = jest.fn();
jest.mock('../services/invoice-followups', () => ({
  ...jest.requireActual('../services/invoice-followups'),
  sendNextTouchNow: (...a) => mockSendNextTouchNow(...a),
}));

const express = require('express');
const customersRouter = require('../routes/admin-customers');
const invoicesRouter = require('../routes/admin-invoices');

const CUST = '0b6f4a52-6a0e-4c8e-9c7e-2f3a9d8e1a01';
const IN_FLIGHT_COPY = 'The reminder is sending right now. Try again in a minute.';

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/customers', customersRouter);
  app.use('/api/admin/invoices', invoicesRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const post = (base, path, body, role = 'admin') => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body || {}),
});

beforeEach(() => { mockControl.mockReset(); mockSendNextTouchNow.mockReset(); });

describe('POST /api/admin/customers/:id/dunning-schedule/:control', () => {
  test.each(['send-now', 'pause', 'resume', 'release'])('%s: admin only; passes the control, the admin and a trimmed reason; answers what the control returned', async (control) => {
    mockControl.mockResolvedValue({ status: 200, body: { scheduleId: 'sched-1', ok: true } });
    await withServer(async (base) => {
      const denied = await post(base, `/api/admin/customers/${CUST}/dunning-schedule/${control}`, {}, 'technician');
      expect(denied.status).toBe(403);
      expect(mockControl).not.toHaveBeenCalled();
      const res = await post(base, `/api/admin/customers/${CUST}/dunning-schedule/${control}`, { reason: `  customer called ${'x'.repeat(300)}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ scheduleId: 'sched-1', ok: true });
    });
    const [customerId, passed, opts] = mockControl.mock.calls[0];
    expect([customerId, passed]).toEqual([CUST, control]);
    expect(opts).toMatchObject({ adminId: 'tech-7' });
    expect(opts.reason).toMatch(/^customer called x+$/);
    expect(opts.reason).toHaveLength(200);
  });

  test('a send in flight is a 409 carrying the office copy; no open schedule is a 404; a throw is the error handler\'s', async () => {
    await withServer(async (base) => {
      mockControl.mockResolvedValueOnce({ status: 409, body: { error: IN_FLIGHT_COPY, code: 'IN_FLIGHT', scheduleId: 'sched-1' } });
      const busy = await post(base, `/api/admin/customers/${CUST}/dunning-schedule/pause`);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: IN_FLIGHT_COPY, code: 'IN_FLIGHT' });
      mockControl.mockResolvedValueOnce({ status: 404, body: { error: 'This customer has no open reminder schedule.', code: 'NO_OPEN_SCHEDULE' } });
      expect((await post(base, `/api/admin/customers/${CUST}/dunning-schedule/release`)).status).toBe(404);
      mockControl.mockRejectedValueOnce(new Error('db down'));
      expect((await post(base, `/api/admin/customers/${CUST}/dunning-schedule/resume`)).status).toBe(500);
      // an empty or non-string reason is passed as null
      mockControl.mockResolvedValueOnce({ status: 200, body: { ok: true } });
      await post(base, `/api/admin/customers/${CUST}/dunning-schedule/pause`, { reason: 42 });
      expect(mockControl.mock.calls.at(-1)[2]).toMatchObject({ reason: null });
    });
  });

  test('an unknown control is not a route', async () => {
    await withServer(async (base) => {
      const res = await post(base, `/api/admin/customers/${CUST}/dunning-schedule/delete`);
      expect(res.status).toBe(404);
      expect(mockControl).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/admin/invoices/:id/followup/send-now', () => {
  test('a per-invoice send answers { ok: true } as before, operator-initiated', async () => {
    mockSendNextTouchNow.mockResolvedValue(undefined);
    await withServer(async (base) => {
      const res = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
    expect(mockSendNextTouchNow).toHaveBeenCalledWith('inv-1', { operatorInitiated: true });
  });

  test('a customer on a schedule: the schedule\'s result as JSON (200 sent, 409 in flight with the copy, 409 dark)', async () => {
    await withServer(async (base) => {
      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' });
      const sent = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' });

      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', ok: false, reason: 'in_flight', message: IN_FLIGHT_COPY });
      const busy = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: IN_FLIGHT_COPY, code: 'IN_FLIGHT', scheduleId: 'sched-1' });

      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', ok: false, reason: 'schedule_not_live', message: 'off' });
      const dark = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(dark.status).toBe(409);
      expect((await dark.json()).code).toBe('SCHEDULE_NOT_LIVE');
    });
  });
});
