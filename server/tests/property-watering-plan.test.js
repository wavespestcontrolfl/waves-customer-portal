jest.mock('../models/db', () => jest.fn(() => { throw new Error('Unexpected DB query'); }));
jest.mock('../services/account-membership-email', () => ({}));
jest.mock('../services/termite-stations', () => ({}));
jest.mock('../services/irrigation-weekly-email', () => ({ hasLawnServiceEvidence: jest.fn() }));
jest.mock('../services/irrigation-app-plan', () => ({ appPlanEnabled: jest.fn(), loadCustomerWateringPlan: jest.fn() }));
jest.mock('../middleware/auth', () => ({ authenticate: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer synthetic-session') return res.status(401).json({ error: 'Unauthorized' });
  req.customerId = 'owned-property';
  next();
} }));
const express = require('express');
const { appPlanEnabled, loadCustomerWateringPlan } = require('../services/irrigation-app-plan');
const app = express();
app.use('/api/property', require('../routes/property'));
app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Unavailable' }));
let server;
let base;
beforeAll(async () => { await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; });
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { jest.clearAllMocks(); appPlanEnabled.mockReturnValue(true); });
async function get(path, status, authenticated = true) {
  const response = await fetch(base + path, { headers: authenticated ? { Authorization: 'Bearer synthetic-session' } : {} });
  expect(response.status).toBe(status);
  return { body: await response.json(), headers: Object.fromEntries(response.headers) };
}


test('authentication precedes the plan reader', async () => {
  await get('/api/property/watering-plan', 401, false);
  expect(loadCustomerWateringPlan).not.toHaveBeenCalled();
});
test('the dark route does not query snapshots', async () => {
  appPlanEnabled.mockReturnValue(false);
  const res = await get('/api/property/watering-plan', 200);
  expect(res.body).toEqual({ available: false });
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(loadCustomerWateringPlan).not.toHaveBeenCalled();
});
test('query parameters cannot select another property', async () => {
  loadCustomerWateringPlan.mockResolvedValue({ instruction: 'Saved instructions' });
  const res = await get('/api/property/watering-plan?customerId=unowned-property', 200);
  expect(loadCustomerWateringPlan).toHaveBeenCalledWith('owned-property');
  expect(res.body).toEqual({ available: true, plan: { instruction: 'Saved instructions' } });
});
test('missing plans are empty and reader failures never substitute a guess', async () => {
  loadCustomerWateringPlan.mockResolvedValue(null);
  const res = await get('/api/property/watering-plan', 200);
  expect(res.body.plan).toBeNull();
  loadCustomerWateringPlan.mockRejectedValue(new Error('database unavailable'));
  await get('/api/property/watering-plan', 500);
});
