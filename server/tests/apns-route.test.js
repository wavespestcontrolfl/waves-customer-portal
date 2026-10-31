// One APNs send can name its own topic and host: Waves Admin (the iOS staff
// app) is a second bundle, and its development installs use the sandbox.

const { EventEmitter } = require('events');
const { generateKeyPairSync } = require('crypto');

const mockConnect = jest.fn();
jest.mock('http2', () => ({ connect: (...args) => mockConnect(...args), constants: { NGHTTP2_CANCEL: 8 } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ENV_KEYS = ['APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRODUCTION'];
const savedEnv = {};
let apns;

// An HTTP/2 client whose every request answers 200.
function fakeClient(requests) {
  const client = new EventEmitter();
  client.close = jest.fn();
  client.destroy = jest.fn();
  client.request = (headers) => {
    requests.push(headers);
    const stream = new EventEmitter();
    stream.setEncoding = () => {};
    stream.setTimeout = () => {};
    stream.close = () => {};
    stream.end = () => setImmediate(() => {
      stream.emit('response', { ':status': 200 });
      stream.emit('end');
    });
    return stream;
  };
  return client;
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.APNS_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.APNS_KEY_ID = 'ABC123DEFG';
  process.env.APNS_TEAM_ID = 'TEAM123456';
  process.env.APNS_BUNDLE_ID = 'com.wavespestcontrol.portal';
  process.env.APNS_PRODUCTION = 'true';
  jest.isolateModules(() => { apns = require('../services/apns'); });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => mockConnect.mockReset());

test('without a route, a send uses the configured customer-app topic and host', async () => {
  const requests = [];
  mockConnect.mockImplementation(() => fakeClient(requests));

  await expect(apns.send('tok-1', { title: 'Hi' })).resolves.toEqual({ ok: true });
  expect(mockConnect).toHaveBeenCalledWith('https://api.push.apple.com');
  expect(requests[0]['apns-topic']).toBe('com.wavespestcontrol.portal');
});

test('a Waves Admin development install goes to its own topic on the sandbox host', async () => {
  const requests = [];
  mockConnect.mockImplementation(() => fakeClient(requests));

  await expect(apns.send('tok-2', { title: 'Hi' }, { topic: apns.STAFF_APP_BUNDLE_ID, production: false }))
    .resolves.toEqual({ ok: true });
  expect(mockConnect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
  expect(requests[0]['apns-topic']).toBe('com.wavespestcontrol.wavespay');
});
