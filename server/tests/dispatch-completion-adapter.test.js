process.env.JWT_SECRET = 'completion-adapter-test-secret';

jest.mock('../services/complete-scheduled-service', () => ({
  ...jest.requireActual('../services/complete-scheduled-service'),
  completeScheduledService: jest.fn(),
}));

const { completeScheduledService } = require('../services/complete-scheduled-service');
const router = require('../routes/admin-dispatch');
const route = router.stack.find((layer) => layer.route?.path === '/:serviceId/complete' && layer.route.methods.post);
const handler = route.route.stack.at(-1).handle;

beforeEach(() => jest.clearAllMocks());

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

test('the endpoint forwards authenticated actor and header separately from submitted fields', async () => {
  const body = { actor: { techRole: 'admin' }, idempotencyKey: 'body-key' };
  const req = {
    params: { serviceId: 'service-test' }, body,
    techRole: 'technician', technicianId: 'tech-test', technician: { id: 'tech-test' },
    get: jest.fn(() => 'header-key'),
  };
  const payload = { code: 'completion_in_progress' };
  completeScheduledService.mockResolvedValue({ status: 409, body: payload });
  const res = response();
  const next = jest.fn();
  await handler(req, res, next);
  expect(completeScheduledService).toHaveBeenCalledWith({
    serviceId: 'service-test', body,
    actor: { techRole: 'technician', technicianId: 'tech-test', technician: { id: 'tech-test' } },
    idempotencyKey: 'header-key',
  });
  expect(req.get).toHaveBeenCalledWith('Idempotency-Key');
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(payload);
  expect(next).not.toHaveBeenCalled();
});

test('unexpected completion failures reach the existing Express error handler', async () => {
  const error = new Error('synthetic completion failure');
  completeScheduledService.mockRejectedValue(error);
  const res = response();
  const next = jest.fn();
  await handler({ params: { serviceId: 'service-test' }, body: {}, get: () => undefined }, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.json).not.toHaveBeenCalled();
});

test('the endpoint remains behind both existing staff authentication guards', () => {
  const index = router.stack.indexOf(route);
  for (const name of ['adminAuthenticate', 'requireTechOrAdmin']) {
    const guard = router.stack.findIndex((layer) => !layer.route && layer.name === name);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(index);
  }
});
