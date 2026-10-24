/**
 * GET /api/admin/schedule/rodent-trapping-visits — the create-appointment
 * modal's rodent trapping notice (owner ruling 2026-09-26). Pins the route's
 * own contract: office-only, request validation before any lookup, and a
 * straight pass-through of the lookup's answer. The lookup itself is covered
 * by rodent-trap-visits.test.js and rodent-trap-visits-postgres.test.js.
 *
 * Follows this repo's convention for route files with no supertest harness
 * (see admin-schedule-create-stacking-gate.test.js): locate the handler on
 * router.stack and drive it directly against mocked deps.
 */
const mockDb = jest.fn(() => {
  throw new Error('the notice route reads only through rodent-trap-visits');
});
jest.mock('../models/db', () => mockDb);
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/rodent-trap-visits', () => ({
  recentTrappingVisits: jest.fn(),
}));

const router = require('../routes/admin-schedule');
const { requireAdmin } = require('../middleware/admin-auth');
const { recentTrappingVisits } = require('../services/rodent-trap-visits');

const layer = router.stack.find((l) => l.route?.path === '/rodent-trapping-visits' && l.route.methods.get);
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

const CUSTOMER = '11111111-2222-4333-8444-555555555555';
const PROPERTY = '66666666-7777-4888-9999-000000000000';

async function call(query) {
  const res = { body: undefined, json(body) { this.body = body; return this; } };
  let error = null;
  await handler({ query }, res, (err) => { error = err || null; });
  return { res, error };
}

beforeEach(() => {
  recentTrappingVisits.mockReset();
  recentTrappingVisits.mockResolvedValue({ windowDays: 60, since: '2026-08-10', through: '2026-10-09', count: 0, visits: [] });
});

describe('GET /rodent-trapping-visits', () => {
  test('is office-only (requireAdmin on the route, like the booking POST)', () => {
    expect(layer.route.stack.map((l) => l.handle)).toContain(requireAdmin);
  });

  test('looks up the booking property and date and returns the answer unchanged', async () => {
    const answer = {
      windowDays: 60, since: '2026-08-10', through: '2026-10-09', count: 2,
      visits: [{ id: 'v1', date: '2026-10-01', serviceKey: 'rodent_trapping' }, { id: 'v2', date: '2026-10-08', serviceKey: 'rodent_trapping_followup' }],
    };
    recentTrappingVisits.mockResolvedValueOnce(answer);
    const { res, error } = await call({ customerId: CUSTOMER, propertyId: PROPERTY, date: '2026-10-09' });
    expect(error).toBeNull();
    expect(recentTrappingVisits).toHaveBeenCalledWith(mockDb, CUSTOMER, { propertyId: PROPERTY, date: '2026-10-09' });
    expect(res.body).toEqual(answer);
  });

  test('with no property or date the lookup uses the primary address and today', async () => {
    const { error } = await call({ customerId: CUSTOMER });
    expect(error).toBeNull();
    expect(recentTrappingVisits).toHaveBeenCalledWith(mockDb, CUSTOMER, { propertyId: null, date: null });
  });

  test.each([
    [{}, 'customerId'],
    [{ customerId: 'not-a-uuid' }, 'customerId'],
    [{ customerId: [CUSTOMER, CUSTOMER] }, 'customerId'],
    [{ customerId: CUSTOMER, propertyId: 'not-a-uuid' }, 'propertyId'],
    [{ customerId: CUSTOMER, date: '2026-02-30' }, 'date'],
    [{ customerId: CUSTOMER, date: '10/09/2026' }, 'date'],
  ])('rejects %j with a 400 before any lookup', async (query, field) => {
    const { res, error } = await call(query);
    expect(error).toMatchObject({ status: 400 });
    expect(error.message).toContain(field);
    expect(res.body).toBeUndefined();
    expect(recentTrappingVisits).not.toHaveBeenCalled();
  });

  test('a lookup failure goes to the error handler, never a partial answer', async () => {
    recentTrappingVisits.mockRejectedValueOnce(new Error('connection reset'));
    const { res, error } = await call({ customerId: CUSTOMER });
    expect(error).toMatchObject({ message: 'connection reset' });
    expect(res.body).toBeUndefined();
  });
});
