// PUT /api/admin/schedule/new-caller/:visitId/link (GATE_NEW_CALLER_BOOKING): the office's Link
// for a visit booked by address. The service is mocked; these pin the route's own contract: the
// link first, then reminders and the confirmation (unless the office unticked it), and a link that
// committed is never reported as a failure when a text or reminder step fails after it.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.technicianId = 'admin-1'; next(); },
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => gate === 'newCallerBooking' || actual.isEnabled(gate) };
});
jest.mock('../services/booking/new-caller-visit', () => ({
  listPickableCalls: jest.fn(),
  bookNewCallerVisit: jest.fn(),
  linkNewCallerVisit: jest.fn(),
  armLinkedVisitComms: jest.fn(),
}));

const http = require('http');
const express = require('express');
const service = require('../services/booking/new-caller-visit');

const VISIT_ID = '0f8b9d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f';
const CUSTOMER_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const linkedVisit = { id: VISIT_ID, customer_id: CUSTOMER_ID, scheduled_date: '2031-03-07', window_start: '13:00:00' };

async function put(body) {
  const app = express();
  app.use(express.json());
  app.use('/new-caller', require('../routes/admin-schedule-new-caller'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/new-caller/${VISIT_ID}/link`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  service.linkNewCallerVisit.mockResolvedValue({ visit: linkedVisit, addedProperty: true });
  service.armLinkedVisitComms.mockResolvedValue(true);
});

test('links the visit, then arms reminders and sends the confirmation by default', async () => {
  const { status, json } = await put({ customerId: CUSTOMER_ID });

  expect(status).toBe(200);
  expect(json).toEqual({ ok: true, id: VISIT_ID, customerId: CUSTOMER_ID, addedProperty: true, confirmationSent: true, warning: null });
  expect(service.linkNewCallerVisit).toHaveBeenCalledWith({ visitId: VISIT_ID, customerId: CUSTOMER_ID, adminUserId: 'admin-1' });
  expect(service.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit, sendConfirmation: true });
});

test('an unticked confirmation arms the reminders without the text', async () => {
  service.armLinkedVisitComms.mockResolvedValue(false);

  const { json } = await put({ customerId: CUSTOMER_ID, sendConfirmation: false });

  expect(service.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit, sendConfirmation: false });
  expect(json.confirmationSent).toBe(false);
});

test('a reminder or text failure after the link answers 200 with a warning: the link stands', async () => {
  service.armLinkedVisitComms.mockRejectedValue(new Error('provider down'));

  const { status, json } = await put({ customerId: CUSTOMER_ID });

  expect(status).toBe(200);
  expect(json).toMatchObject({ ok: true, confirmationSent: false, warning: 'The visit is linked, but its reminders or confirmation did not go out. Check the visit.' });
});

test('a refused link answers its own status and message and arms nothing', async () => {
  service.linkNewCallerVisit.mockRejectedValue(Object.assign(new Error('This visit already has a customer, or it was cancelled.'), { status: 409, isOperational: true }));

  const { status, json } = await put({ customerId: CUSTOMER_ID });

  expect(status).toBe(409);
  expect(json).toEqual({ error: 'This visit already has a customer, or it was cancelled.' });
  expect(service.armLinkedVisitComms).not.toHaveBeenCalled();
});
