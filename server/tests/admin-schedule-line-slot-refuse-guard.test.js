/**
 * update-details, the primary line discount slot's refuse-don't-drop
 * contract (PR #4405, round-2 fallback P1).
 *
 * `primaryLineDiscount` is read ONLY on the multi-line save branch
 * (`if (Array.isArray(addons))`). The legacy single-price branch has no
 * handling for it, so a slot posted without an addons array used to be
 * silently dropped once the gate was ON — the save reported success while
 * the operator's discount edit vanished. The gate-OFF 409 already refused
 * the field; the gate-ON path now refuses it too when it cannot be applied.
 *
 * Every shipped caller (CreateAppointmentModal, SchedulePage's edit modal)
 * posts the slot inside its addons payload, so this refuses only a request
 * that could not have been honored anyway.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GATE_DISCOUNT_STACKING = 'true';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../models/db', () => jest.fn());

const express = require('express');
const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

const STORED = { id: 'svc-1', scheduled_date: '2099-01-15', window_start: '10:00:00', window_end: '11:00:00' };

function chain(row) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'select', 'orderBy']) c[m] = jest.fn().mockReturnThis();
  c.first = jest.fn().mockResolvedValue(row);
  c.columnInfo = jest.fn().mockResolvedValue({});
  c.update = jest.fn().mockResolvedValue(1);
  return c;
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/schedule', adminScheduleRouter);
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = jest.fn();
  db.fn = { now: jest.fn(() => 'now()') };
  db.mockImplementation(() => chain(STORED));
  db.transaction = jest.fn(async () => { throw Object.assign(new Error('reached trx'), { status: 418 }); });
});

async function put(body) {
  const res = await fetch(`${baseUrl}/api/admin/schedule/svc-1/update-details`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const SLOT = { discountId: 'promo-1', discountAmount: 10 };

test('gate ON: a line slot posted with NO addons array is refused, not dropped', async () => {
  const { status, body } = await put({ estimatedPrice: 120, primaryLineDiscount: SLOT });
  expect(status).toBe(409);
  expect(body.error).toMatch(/requires the full service line list/);
  // Refused before any write is attempted.
  expect(db.transaction).not.toHaveBeenCalled();
});

test('gate ON: clearing the slot (null) without an addons array is refused too', async () => {
  const { status } = await put({ estimatedPrice: 120, primaryLineDiscount: null });
  expect(status).toBe(409);
  expect(db.transaction).not.toHaveBeenCalled();
});

test('gate ON: CLEARING the slot with an addons array is accepted into the save', async () => {
  const { status } = await put({ estimatedPrice: 120, addons: [], primaryLineDiscount: null });
  // 418 is the harness's "reached the transaction" sentinel — the guard let
  // this request through, which is the whole point.
  expect(status).toBe(418);
  expect(db.transaction).toHaveBeenCalledTimes(1);
});

test('gate ON: a catalog PICK with an addons array gets past the guard', async () => {
  // It then fails resolving 'promo-1' against this harness's stub catalog —
  // a 400 from resolveLineDiscount, NOT the guard's 409. Asserting the code
  // and the message keeps this from passing for the wrong reason.
  const { status, body } = await put({ estimatedPrice: 120, addons: [], primaryLineDiscount: SLOT });
  expect(status).not.toBe(409);
  expect(body.error).not.toMatch(/requires the full service line list/);
});

test('an untouched slot (field absent) is never refused', async () => {
  const { status } = await put({ estimatedPrice: 120 });
  expect(status).toBe(418);
  expect(db.transaction).toHaveBeenCalledTimes(1);
});
