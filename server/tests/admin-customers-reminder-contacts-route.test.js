/**
 * GET  /api/admin/customers/:id/reminder-contacts and
 * POST /api/admin/customers/:id/reminder-contacts/:reminderId/stop | restart (owner 2026-11-27 "yes"): staff see the
 * people a caller named for the visit texts and stop or restart each one. Admin only; by = 'staff'; each change is
 * audited. The stop rules are proven on real SQL in call-visit-recipient-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => {
  const requireAdmin = (_req, _res, next) => next();
  requireAdmin.isRequireAdmin = true;
  return {
    adminAuthenticate: (_req, _res, next) => next(),
    requireTechOrAdmin: (_req, _res, next) => next(),
    requireAdmin,
  };
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn(async () => false), hasIrrigationEmailOptIn: jest.fn(async () => false) }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => ({ ok: true })) }));
jest.mock('../models/db', () => {
  const dbFn = Object.assign(jest.fn(), { raw: jest.fn(), fn: { now: jest.fn() } });
  dbFn.transaction = jest.fn(async (cb) => cb('TRX'));
  return dbFn;
});
jest.mock('../services/call-visit-recipient', () => ({
  listReminderContacts: jest.fn(async () => [{ id: 'r', firstName: 'Bob', stopped: false }]),
  setReminderContactStopped: jest.fn(async ({ stopped, by }) => ({ id: 'r', stopped, stoppedBy: stopped ? by : null, changed: true })),
}));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const REMINDER = '33333333-3333-4333-8333-333333333333';
const router = require('../routes/admin-customers');
const { recordAuditEvent } = require('../services/audit-log');
const VisitRecipient = require('../services/call-visit-recipient');

function layerFor(method, path) {
  return router.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
}
async function run(method, path, params) {
  const layer = layerFor(method, path);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params, technicianId: 'admin-1', ip: '127.0.0.1', get: jest.fn(() => 'jest') };
  const result = { status: 200, body: null, error: null };
  const res = { status(c) { result.status = c; return res; }, json(p) { result.body = p; return res; } };
  await handler(req, res, (err) => { result.error = err; });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => jest.clearAllMocks());

test('every route is admin only (requireAdmin in its own stack)', () => {
  for (const [method, path] of [['get', '/:id/reminder-contacts'], ['post', '/:id/reminder-contacts/:reminderId/stop'], ['post', '/:id/reminder-contacts/:reminderId/restart']]) {
    expect(layerFor(method, path).route.stack.some((s) => s.handle.isRequireAdmin)).toBe(true);
  }
});

test('staff read the list', async () => {
  const res = await run('get', '/:id/reminder-contacts', { id: CUSTOMER });
  expect(res.body.reminderContacts).toHaveLength(1);
  expect(VisitRecipient.listReminderContacts).toHaveBeenCalledWith(CUSTOMER);
});

test('a staff stop and restart are recorded as staff and audited', async () => {
  const stop = await run('post', '/:id/reminder-contacts/:reminderId/stop', { id: CUSTOMER, reminderId: REMINDER });
  expect(stop.body.reminderContact).toMatchObject({ stopped: true, stoppedBy: 'staff' });
  expect(VisitRecipient.setReminderContactStopped).toHaveBeenLastCalledWith({ customerId: CUSTOMER, id: REMINDER, stopped: true, by: 'staff', conn: 'TRX' });
  // same transaction, and a failed audit write fails the change
  expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'customer.reminder_contact_stopped', resource_id: CUSTOMER, critical: true, trx: 'TRX' }));
  await run('post', '/:id/reminder-contacts/:reminderId/restart', { id: CUSTOMER, reminderId: REMINDER });
  expect(recordAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'customer.reminder_contact_restarted' }));
});

test('a Stop on a row already stopped (or a Restart on an active one) writes no audit row', async () => {
  VisitRecipient.setReminderContactStopped.mockResolvedValueOnce({ id: 'r', stopped: true, stoppedBy: 'customer', changed: false });
  const res = await run('post', '/:id/reminder-contacts/:reminderId/stop', { id: CUSTOMER, reminderId: REMINDER });
  expect(res.body.reminderContact).toMatchObject({ stoppedBy: 'customer' });
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('bad ids are a 400; an id not on the list is a 404 with no audit row', async () => {
  expect((await run('post', '/:id/reminder-contacts/:reminderId/stop', { id: CUSTOMER, reminderId: 'x' })).status).toBe(400);
  VisitRecipient.setReminderContactStopped.mockResolvedValueOnce(null);
  expect((await run('post', '/:id/reminder-contacts/:reminderId/stop', { id: CUSTOMER, reminderId: REMINDER })).status).toBe(404);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});
