jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => next(),
}));

const db = require('../models/db');
const trackingRouter = require('../routes/tracking');

function routeHandler(path, method) {
  const layer = trackingRouter.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockResponse() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function callRoute(path, method, req = {}) {
  const res = mockResponse();
  const next = jest.fn();
  await routeHandler(path, method)({
    params: { id: 'tracker-1' },
    body: {},
    customerId: 'cust-1',
    customer: { id: 'cust-1' },
    ...req,
  }, res, next);
  return { res, next };
}

describe('retired customer tracker mutation routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['put', '/:id/step', 403, 'Tracker updates are staff-only'],
    ['post', '/:id/note', 403, 'Tracker notes are staff-only'],
    ['put', '/:id/complete', 403, 'Tracker completion is staff-only'],
  ])('%s %s is terminal and does not touch service_tracking', async (method, path, status, error) => {
    const { res, next } = await callRoute(path, method, {
      body: { step: 3, note: 'legacy write attempt', summary: { ok: true } },
    });

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ error });
    expect(next).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('demo advance endpoint is fully retired even outside production', async () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const { res, next } = await callRoute('/demo/advance', 'post');

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
      expect(next).not.toHaveBeenCalled();
      expect(db).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });
});
