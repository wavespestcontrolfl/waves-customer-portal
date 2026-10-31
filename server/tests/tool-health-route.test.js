/**
 * GET /api/admin/tool-health?hours=…: the window is a whole number of hours
 * from 1 to 720. "-1" used to move the window into the future and report an
 * idle page, and parseInt read "1.5" or "24abc" as a window (health audit
 * HE-01). A refused value never reaches the database. Drives the handler on
 * router.stack, like admin-departure-time-route.test.js.
 */
jest.mock('../models/db', () => jest.fn(() => {
  throw new Error('a refused window must not query');
}));

const toolHealthRouter = require('../routes/tool-health');

function getHandler() {
  const layer = toolHealthRouter.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function get(query) {
  const req = { query, params: {}, headers: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    status: jest.fn(function status(c) { this.statusCode = c; return this; }),
    json: jest.fn(function json(b) { this.body = b; return this; }),
  };
  const next = jest.fn();
  await getHandler()(req, res, next);
  return { res, next };
}

describe('GET /tool-health window check', () => {
  it.each([
    ['a negative window', '-1'],
    ['zero', '0'],
    ['a fraction', '1.5'],
    ['a number with trailing text', '24abc'],
    ['more than 30 days', '721'],
    ['a padded number', ' 24'],
    ['a repeated parameter', ['1', '24']],
  ])('refuses %s with a 400 and no query', async (_label, hours) => {
    const { res, next } = await get({ hours });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'hours must be a whole number from 1 to 720' });
  });
});
