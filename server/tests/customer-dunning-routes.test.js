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
const mockSummary = jest.fn();
const mockSummaryForInvoice = jest.fn();
const mockRecord = jest.fn(async () => {});
jest.mock('../services/customer-dunning/wiring', () => ({
  ...jest.requireActual('../services/customer-dunning/wiring'),
  controlCustomerSchedule: (...a) => mockControl(...a),
  customerScheduleSummary: (...a) => mockSummary(...a),
  customerScheduleSummaryForInvoice: (...a) => mockSummaryForInvoice(...a),
  recordStaffControl: (...a) => mockRecord(...a),
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

beforeEach(() => { mockControl.mockReset(); mockSendNextTouchNow.mockReset(); mockSummary.mockReset(); mockSummaryForInvoice.mockReset(); mockRecord.mockClear(); });

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
    expect(mockSendNextTouchNow).toHaveBeenCalledWith('inv-1', { operatorInitiated: true, combined: null });
  });

  // Codex #5503 r2 P1: the combined step goes out only with the operator's explicit confirmation of it.
  test('the request confirms a combined step only with { combined: true, scheduleId, stepIndex }; anything else confirms nothing', async () => {
    mockSendNextTouchNow.mockResolvedValue(undefined);
    await withServer(async (base) => {
      await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 'sched-1', stepIndex: 4 });
      await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: 'yes', scheduleId: 'sched-1', stepIndex: 4 });
      await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 7, stepIndex: '4' });
    });
    expect(mockSendNextTouchNow.mock.calls.map(([, opts]) => opts.combined)).toEqual([
      { scheduleId: 'sched-1', stepIndex: 4 },
      null,
      { scheduleId: null, stepIndex: null },
    ]);
  });

  test('an owned customer without the confirmation: 409 COMBINED_CONFIRM_REQUIRED with the office copy; with it, the combined send\'s 200', async () => {
    const { sendNowForInvoiceOnSchedule } = jest.requireActual('../services/customer-dunning/wiring');
    mockSendNextTouchNow.mockImplementation(async (_id, { combined }) => (combined
      ? { routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' }
      : sendNowForInvoiceOnSchedule('sched-1', CUST, combined)));
    await withServer(async (base) => {
      const refused = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: 'This customer is on combined reminders. Reload to see the combined step before sending.',
        code: 'COMBINED_CONFIRM_REQUIRED',
        scheduleId: 'sched-1',
      });
      const sent = await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 'sched-1', stepIndex: 4 });
      expect(sent.status).toBe(200);
      expect((await sent.json()).outcome).toBe('advanced');
    });
  });

  test('a confirmed combined step whose schedule closed meanwhile: 409 COMBINED_SCHEDULE_CLOSED, never the invoice\'s own step', async () => {
    const { combinedScheduleClosed } = jest.requireActual('../services/customer-dunning/wiring');
    mockSendNextTouchNow.mockResolvedValue(combinedScheduleClosed('sched-1'));
    await withServer(async (base) => {
      const res = await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 'sched-1', stepIndex: 4 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This customer is no longer on combined reminders. Reload to see this invoice\'s next step before sending.',
        code: 'COMBINED_SCHEDULE_CLOSED',
        scheduleId: 'sched-1',
      });
    });
  });

  // Codex local review P2: an early exit (paid invoice, finished reminders) answered 200 { ok: true } and the
  // panel toasted "Done" over a click that sent nothing.
  test('nothing to send (a paid invoice, finished reminders, no sequence): 409 NOT_SENT with the plain copy, never 200', async () => {
    await withServer(async (base) => {
      mockSendNextTouchNow.mockResolvedValueOnce({ ok: false, reason: 'nothing_to_send', message: 'Not sent: this invoice is paid or its reminders are finished.' });
      const finished = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(finished.status).toBe(409);
      expect(await finished.json()).toEqual({ error: 'Not sent: this invoice is paid or its reminders are finished.', code: 'NOT_SENT' });
      mockSendNextTouchNow.mockResolvedValueOnce({ ok: false, reason: 'nothing_to_send', message: 'Not sent: this invoice has no follow-up reminders.' });
      const none = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(none.status).toBe(409);
      expect((await none.json()).error).toBe('Not sent: this invoice has no follow-up reminders.');
    });
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

  test('F4: a schedule send-now that sent nothing is never a 200 (the client would toast "Done"): held / paused are 409 NOT_SENT with the reason', async () => {
    await withServer(async (base) => {
      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'held', reason: 'collection_hold' });
      const held = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(held.status).toBe(409);
      expect(await held.json()).toEqual({
        error: 'Not sent: reminders are on hold (a collections hold is active).', code: 'NOT_SENT', outcome: 'held', scheduleId: 'sched-1',
      });
      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'skipped', reason: 'schedule_paused' });
      const paused = await post(base, '/api/admin/invoices/inv-1/followup/send-now');
      expect(paused.status).toBe(409);
      expect((await paused.json()).error).toBe('Not sent: this customer\'s combined reminders are paused.');
      mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'autopay_hold' });
      expect((await post(base, '/api/admin/invoices/inv-1/followup/send-now')).status).toBe(409);
    });
  });
});

describe('GET /api/admin/invoices/:id/followup', () => {
  const db = require('../models/db');
  const get = (base, path) => fetch(`${base}${path}`, { headers: { 'x-test-role': 'admin' } });
  const sequenceRead = (row) => db.mockImplementation((table) => {
    expect(table).toBe('invoice_followup_sequences');
    return { where: () => ({ first: async () => row }) };
  });

  test('a customer on combined reminders: the sequence, the steps, and customerSchedule (the combined step and invoice count)', async () => {
    sequenceRead({ id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, status: 'active', step_index: 2 });
    const summary = {
      id: 'sched-1', status: 'active', stepIndex: 4, stepLabel: '60-day reminder', invoiceCount: 3, nextTouchAt: '2026-10-08T14:00:00.000Z',
    };
    mockSummary.mockResolvedValue(summary);
    await withServer(async (base) => {
      const res = await get(base, '/api/admin/invoices/inv-1/followup');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.customerSchedule).toEqual(summary);
      expect(body.sequence).toMatchObject({ id: 'seq-1', step_index: 2 });
      expect(Array.isArray(body.steps)).toBe(true);
    });
    expect(mockSummary).toHaveBeenCalledWith(CUST);
  });

  test('not on combined reminders: customerSchedule is null, with or without a sequence', async () => {
    sequenceRead({ id: 'seq-1', invoice_id: 'inv-1', customer_id: CUST, status: 'active', step_index: 2 });
    mockSummary.mockResolvedValue(null);
    mockSummaryForInvoice.mockResolvedValue(null);
    await withServer(async (base) => {
      expect((await (await get(base, '/api/admin/invoices/inv-1/followup')).json()).customerSchedule).toBeNull();
      sequenceRead(undefined);
      const none = await (await get(base, '/api/admin/invoices/inv-2/followup')).json();
      expect(none).toMatchObject({ sequence: null, customerSchedule: null });
    });
    expect(mockSummary).toHaveBeenCalledTimes(1);
    expect(mockSummaryForInvoice).toHaveBeenCalledTimes(1);
  });

  // Codex #5593 r1 P2: an invoice with no reminder row of its own that the combined balance covers.
  test('no sequence, but the combined balance covers the invoice: customerSchedule comes from the invoice lookup', async () => {
    sequenceRead(undefined);
    const summary = { id: 'sched-1', customerId: CUST, status: 'active', stepIndex: 4, stepLabel: '60-day reminder', invoiceCount: 3, nextTouchAt: null, controllable: true };
    mockSummaryForInvoice.mockResolvedValue(summary);
    await withServer(async (base) => {
      const body = await (await get(base, '/api/admin/invoices/inv-9/followup')).json();
      expect(body).toMatchObject({ sequence: null, customerSchedule: summary });
    });
    expect(mockSummaryForInvoice).toHaveBeenCalledWith('inv-9');
    expect(mockSummary).not.toHaveBeenCalled();
  });
});

describe('the invoice send-now records the press on the customer\'s activity log (owner 10-01)', () => {
  const db = require('../models/db');
  afterEach(() => db.mockReset());

  test('routed to the schedule: one record with who pressed it and what happened; a per-invoice send records nothing here', async () => {
    db.mockImplementation((table) => ({ where: () => ({ first: async () => (table === 'invoices' ? { customer_id: CUST } : undefined) }) }));
    mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' });
    await withServer(async (base) => {
      const res = await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 'sched-1', stepIndex: 4 });
      expect(res.status).toBe(200);
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUST, control: 'send-now', adminId: 'tech-7', via: 'invoice', result: expect.objectContaining({ status: 200 }),
    }));
    mockSendNextTouchNow.mockResolvedValueOnce(undefined);
    await withServer(async (base) => {
      expect((await post(base, '/api/admin/invoices/inv-1/followup/send-now')).status).toBe(200);
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  test('a failed invoice lookup never turns the answer into a 500', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    mockSendNextTouchNow.mockResolvedValueOnce({ routedTo: 'customer_schedule', scheduleId: 'sched-1', outcome: 'advanced' });
    await withServer(async (base) => {
      expect((await post(base, '/api/admin/invoices/inv-1/followup/send-now', { combined: true, scheduleId: 'sched-1', stepIndex: 4 })).status).toBe(200);
    });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
