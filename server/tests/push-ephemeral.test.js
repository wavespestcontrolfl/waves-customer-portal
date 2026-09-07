const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');
jest.mock('../models/db', () => jest.fn(() => { throw new Error('DB forbidden'); }));
jest.mock('../services/logger', () => ({ info() {}, warn() {}, error() {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn(async () => ({})) }));
jest.mock('http2', () => ({ connect: jest.fn() }));
const http2 = require('http2');
const webpush = require('web-push');
const keys = ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  jest.clearAllMocks();
});

test('APNs receives expiration zero only for a perishable advisory, while preserving the app URL', async () => {
  process.env.APNS_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
  process.env.APNS_KEY_ID = 'SYNTHETIC';
  process.env.APNS_TEAM_ID = 'SYNTHETIC';
  const headers = [];
  const payloads = [];
  http2.connect.mockImplementation(() => {
    const client = new EventEmitter();
    client.close = jest.fn();
    client.request = (value) => {
      headers.push(value);
      const req = new EventEmitter();
      req.setEncoding = jest.fn(); req.setTimeout = jest.fn();
      req.end = (body) => { payloads.push(JSON.parse(body)); req.emit('response', { ':status': 200 }); req.emit('end'); };
      return req;
    };
    return client;
  });
  let apns;
  jest.isolateModules(() => { apns = require('../services/apns'); });
  const url = '/?tab=property&wateringPlanCustomer=synthetic-property';
  expect(await apns.send('synthetic-device', { title: 'Plan', url, ephemeral: true })).toEqual({ ok: true });
  expect(headers[0]['apns-expiration']).toBe('0');
  expect(payloads[0].url).toBe(url);
  await apns.send('synthetic-device', { title: 'Appointment' });
  expect(headers[1]).not.toHaveProperty('apns-expiration');
});

test('web push receives TTL zero only for the perishable advisory', async () => {
  process.env.VAPID_PUBLIC_KEY = 'synthetic-public';
  process.env.VAPID_PRIVATE_KEY = 'synthetic-private';
  let push;
  jest.isolateModules(() => { push = require('../services/push-notifications'); });
  const sub = { platform: 'web', subscription_data: JSON.stringify({ endpoint: 'https://example.com/synthetic-push' }) };
  expect(await push._sendSubscription(sub, { title: 'Plan', ephemeral: true })).toEqual({ sent: true });
  expect(webpush.sendNotification.mock.calls[0][2]).toMatchObject({ TTL: 0 });
  await push._sendSubscription(sub, { title: 'Appointment' });
  expect(webpush.sendNotification.mock.calls[1][2]).not.toHaveProperty('TTL');
});
