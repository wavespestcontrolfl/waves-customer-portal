/**
 * POST /admin/schedule/held-visits/:callLogId/dismiss: Dismiss on the Dispatch held-visit strip
 * (owner 2026-11-01). Admin only. A malformed id is a 400 before any write, the route refuses
 * with GATE_CALL_HELD_VISIT off, an unknown call is a 404, and otherwise the call and the
 * admin's id go to dismissHeldVisit. Drives the handler on router.stack against mocks, like
 * admin-blackout-date-route.test.js.
 */
const mockDb = jest.fn(() => { throw new Error('db must not be touched'); });
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({ ...jest.requireActual('../config/feature-gates'), isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-held-visits', () => ({ listHeldVisits: jest.fn(), dismissHeldVisit: jest.fn() }));

const { isEnabled } = require('../config/feature-gates');
const { dismissHeldVisit } = require('../services/call-held-visits');
const { requireAdmin } = require('../middleware/admin-auth');
const adminScheduleRouter = require('../routes/admin-schedule');

const PATH = '/held-visits/:callLogId/dismiss';
const CALL_ID = '3f2b9a1c-0d4e-4f5a-8b6c-7d8e9f0a1b2c';
const route = () => adminScheduleRouter.stack.find((l) => l.route && l.route.path === PATH && l.route.methods.post).route;

async function dismiss(callLogId) {
  const req = { params: { callLogId }, body: {}, query: {}, headers: {}, technicianId: 'tech-admin-1' };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const { stack } = route();
  await stack[stack.length - 1].handle(req, res, jest.fn());
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => true);
});

test('only an admin reaches the handler', () => {
  expect(route().stack.map((layer) => layer.handle)).toContain(requireAdmin);
});

test('a malformed call id is a 400 and writes nothing', async () => {
  const res = await dismiss('not-a-call');
  expect(res.statusCode).toBe(400);
  expect(dismissHeldVisit).not.toHaveBeenCalled();
});

test('with the strip gate off it refuses and writes nothing', async () => {
  isEnabled.mockImplementation((name) => name !== 'callHeldVisit');
  const res = await dismiss(CALL_ID);
  expect(res.statusCode).toBe(409);
  expect(dismissHeldVisit).not.toHaveBeenCalled();
});

test('an unknown call is a 404', async () => {
  dismissHeldVisit.mockResolvedValue({ found: false, closedBells: 0 });
  const res = await dismiss(CALL_ID);
  expect(res.statusCode).toBe(404);
});

test("dismisses the call as the signed-in admin and reports the bells it closed", async () => {
  dismissHeldVisit.mockResolvedValue({ found: true, closedBells: 1 });
  const res = await dismiss(CALL_ID);
  expect(dismissHeldVisit).toHaveBeenCalledWith(CALL_ID, { by: 'tech-admin-1' });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ success: true, closedBells: 1 });
});

test('a failed write is a 500 with words the strip can show', async () => {
  dismissHeldVisit.mockRejectedValue(new Error('db down'));
  const res = await dismiss(CALL_ID);
  expect(res.statusCode).toBe(500);
  expect(res.body).toEqual({ error: 'Could not dismiss. Try again.' });
});
