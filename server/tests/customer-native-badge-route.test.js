const express = require('express');

jest.mock('../services/notification-service', () => ({ getCustomerUnreadCount: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticate(req, res, next) {
    if (req.headers.authorization !== 'Bearer fixture-session') return res.sendStatus(401);
    req.customerId = 'fixture-customer';
    next();
  },
}));

const NotificationService = require('../services/notification-service');
const router = require('../routes/customer-notifications');
let server;
let url;
const originalGate = process.env.GATE_CUSTOMER_NATIVE_BADGES;

beforeAll(async () => {
  const app = express();
  app.use('/customer-notifications', router);
  app.use((err, req, res, next) => res.status(500).json({ error: 'Unavailable' }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}/customer-notifications/unread-count`;
});
beforeEach(() => {
  delete process.env.GATE_CUSTOMER_NATIVE_BADGES;
  NotificationService.getCustomerUnreadCount.mockReset().mockResolvedValue(4);
});
afterAll(async () => {
  if (originalGate === undefined) delete process.env.GATE_CUSTOMER_NATIVE_BADGES;
  else process.env.GATE_CUSTOMER_NATIVE_BADGES = originalGate;
  await new Promise(resolve => server.close(resolve));
});

test('retains the old count contract, is dark by default, and never trusts a supplied customer id', async () => {
  const response = await fetch(`${url}?customerId=someone-else`, { headers: { Authorization: 'Bearer fixture-session' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ count: 4, nativeBadgeEnabled: false });
  expect(NotificationService.getCustomerUnreadCount).toHaveBeenCalledWith('fixture-customer');
});

test('reads enable and kill at request time', async () => {
  for (const [value, enabled] of [['true', true], ['false', false]]) {
    process.env.GATE_CUSTOMER_NATIVE_BADGES = value;
    const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-session' } });
    expect(await response.json()).toEqual({ count: 4, nativeBadgeEnabled: enabled });
  }
});

test.each([[undefined, false], ['ON', true], ['false', false]])('reports the badge startup gate for %s', (value, enabled) => {
  if (value !== undefined) process.env.GATE_CUSTOMER_NATIVE_BADGES = value;
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => {
      const { gates, logGateStatus } = require('../config/feature-gates');
      expect(gates.customerNativeBadges).toBe(enabled);
      logGateStatus();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`customerNativeBadges: ${enabled ? 'ENABLED' : 'DISABLED'}`));
    });
  } finally {
    log.mockRestore();
  }
});

test('requires authentication before counting', async () => {
  expect((await fetch(url)).status).toBe(401);
  expect(NotificationService.getCustomerUnreadCount).not.toHaveBeenCalled();
});

test('an unavailable count is an error, not a false zero', async () => {
  NotificationService.getCustomerUnreadCount.mockRejectedValue(new Error('database unavailable'));
  const response = await fetch(url, { headers: { Authorization: 'Bearer fixture-session' } });
  expect(response.status).toBe(500);
  expect(await response.json()).not.toHaveProperty('count');
});
