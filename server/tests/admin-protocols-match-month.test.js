/**
 * /admin/protocols/match resolves a month-keyed program (tree & shrub) to the
 * appointment month's visit; an unusable ?month keeps the rule visit (visit 1)
 * instead of silently becoming today's month.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const protocolsRouter = require('../routes/admin-protocols');

function matchHandler() {
  const layer = protocolsRouter.stack.find((l) => l.route && l.route.path === '/match' && l.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function callMatch(query) {
  let body;
  const res = { status: () => res, json: (payload) => { body = payload; return res; } };
  await matchHandler()({ query, user: { role: 'admin' }, technicianRole: 'admin' }, res, (err) => { throw err; });
  return body;
}

describe('GET /admin/protocols/match month', () => {
  test('tree & shrub returns the appointment month visit', async () => {
    const body = await callMatch({ serviceType: 'Tree & Shrub Care', month: 'Apr' });
    expect(body.matchedVisit).toMatchObject({ visit: 4, month: 'Apr' });
  });

  test.each([undefined, 'xyz', '13'])('month %p keeps the visit-1 fallback', async (month) => {
    const body = await callMatch({ serviceType: 'Tree & Shrub Care', month });
    expect(body.matchedVisit).toMatchObject({ visit: 1, month: 'Jan' });
  });
});
