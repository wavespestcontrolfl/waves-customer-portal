// PUT /api/admin/schedule/new-caller/:visitId/link (GATE_NEW_CALLER_BOOKING): the office's Link
// for a visit booked by address. The service is mocked; these pin the route's own contract: the
// link first, then reminders and the confirmation (unless the office unticked it), and a link that
// committed is never reported as a failure when a text or reminder step fails after it.
// POST /api/admin/schedule/new-caller books the visit in the zone the office create route stamps.
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

async function send(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/new-caller', require('../routes/admin-schedule-new-caller'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/new-caller${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const put = (body) => send('PUT', `/${VISIT_ID}/link`, body);

beforeEach(() => {
  jest.clearAllMocks();
  service.linkNewCallerVisit.mockResolvedValue({ visit: linkedVisit, addedProperty: true });
  service.armLinkedVisitComms.mockResolvedValue({ remindersArmed: true, confirmationSent: true });
});

test('POST books the visit in the zone of its address (the forecast areas\' getZone), with no address the default zone', async () => {
  service.bookNewCallerVisit.mockResolvedValue({ visit: { id: VISIT_ID }, warnings: [] });
  const { status, json } = await send('POST', '', { scheduledDate: '2031-03-07', address: { city: 'Sarasota', zip: '34236' } });
  expect(status).toBe(201);
  expect(json).toEqual({ ok: true, id: VISIT_ID, scheduledDate: '2031-03-07', warnings: [] });
  expect(service.bookNewCallerVisit).toHaveBeenCalledWith(expect.objectContaining({ zone: 'sarasota', adminUserId: 'admin-1' }));
  await send('POST', '', { scheduledDate: '2031-03-07' });
  expect(service.bookNewCallerVisit).toHaveBeenLastCalledWith(expect.objectContaining({ zone: 'lakewood_ranch' }));
});

test('links the visit, then arms reminders and sends the confirmation by default', async () => {
  const { status, json } = await put({ customerId: CUSTOMER_ID });

  expect(status).toBe(200);
  expect(json).toEqual({ ok: true, id: VISIT_ID, customerId: CUSTOMER_ID, addedProperty: true, remindersArmed: true, confirmationSent: true, warning: null });
  expect(service.linkNewCallerVisit).toHaveBeenCalledWith({ visitId: VISIT_ID, customerId: CUSTOMER_ID, adminUserId: 'admin-1' });
  expect(service.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit, sendConfirmation: true });
});

test('an unticked confirmation arms the reminders without the text, and warns about nothing', async () => {
  service.armLinkedVisitComms.mockResolvedValue({ remindersArmed: true, confirmationSent: false });

  const { json } = await put({ customerId: CUSTOMER_ID, sendConfirmation: false });

  expect(service.armLinkedVisitComms).toHaveBeenCalledWith({ visit: linkedVisit, sendConfirmation: false });
  expect(json).toMatchObject({ remindersArmed: true, confirmationSent: false, warning: null });
});

test('after a committed link, every comms shortfall answers 200 with a warning: the link stands', async () => {
  const cases = [
    [{ remindersArmed: false, confirmationSent: false }, 'The visit is linked, but its reminders were not set up and no confirmation went out. Check the visit.'],
    [{ remindersArmed: true, confirmationSent: false }, 'The visit is linked. The confirmation text did not go out; the customer may not take texts. Check the visit.'],
    [new Error('provider down'), 'The visit is linked, but its reminders were not set up and no confirmation went out. Check the visit.'],
  ];
  for (const [outcome, warning] of cases) {
    if (outcome instanceof Error) service.armLinkedVisitComms.mockRejectedValueOnce(outcome);
    else service.armLinkedVisitComms.mockResolvedValueOnce(outcome);
    const { status, json } = await put({ customerId: CUSTOMER_ID });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, warning });
  }
});

test('a refused link answers its own status and message and arms nothing', async () => {
  service.linkNewCallerVisit.mockRejectedValue(Object.assign(new Error('This visit already has a customer, or it was cancelled.'), { status: 409, isOperational: true }));

  const { status, json } = await put({ customerId: CUSTOMER_ID });

  expect(status).toBe(409);
  expect(json).toEqual({ error: 'This visit already has a customer, or it was cancelled.' });
  expect(service.armLinkedVisitComms).not.toHaveBeenCalled();
});
