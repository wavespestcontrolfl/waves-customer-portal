const { EventEmitter } = require('node:events');

const mockGetAccessToken = jest.fn();
const mockRequest = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: class {
        getAccessToken(...args) { return mockGetAccessToken(...args); }
      },
    },
  },
}));
jest.mock('https', () => ({ request: (...args) => mockRequest(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const previousServiceAccount = process.env.FCM_SERVICE_ACCOUNT;
process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'fixture-project',
  client_email: 'fixture@example.invalid',
  private_key: 'fixture-private-key',
});
const fcm = require('../services/fcm');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function acceptProviderRequest() {
  mockRequest.mockImplementation((_options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = jest.fn();
    request.destroy = jest.fn((err) => request.emit('error', err));
    request.end = jest.fn(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.setEncoding = jest.fn();
      onResponse(response);
      queueMicrotask(() => {
        response.emit('end');
        request.emit('close');
      });
    });
    return request;
  });
}

afterAll(() => {
  if (previousServiceAccount === undefined) delete process.env.FCM_SERVICE_ACCOUNT;
  else process.env.FCM_SERVICE_ACCOUNT = previousServiceAccount;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccessToken.mockResolvedValue({ token: 'fixture-access-token' });
  acceptProviderRequest();
});

test('a send window that closes during OAuth blocks before the provider request', async () => {
  const oauth = deferred();
  let allowed = true;
  const shouldContinue = jest.fn(async () => allowed);
  mockGetAccessToken.mockReturnValue(oauth.promise);

  const sending = fcm.send('fixture-device', { title: 'Visit update' }, { shouldContinue });
  expect(shouldContinue).not.toHaveBeenCalled();
  allowed = false;
  oauth.resolve({ token: 'fixture-access-token' });

  await expect(sending).resolves.toEqual({
    ok: false, skipped: true, reason: 'pre_send_check_blocked',
  });
  expect(shouldContinue).toHaveBeenCalledTimes(1);
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a throwing final guard blocks without retry or token expiry semantics', async () => {
  const shouldContinue = jest.fn(async () => { throw new Error('ownership unreadable'); });

  await expect(fcm.send('fixture-device', { title: 'Visit update' }, { shouldContinue }))
    .resolves.toEqual({ ok: false, skipped: true, reason: 'pre_send_check_blocked' });

  expect(mockRequest).not.toHaveBeenCalled();
});

test('a caller without a guard retains the normal provider send', async () => {
  await expect(fcm.send('fixture-device', { title: 'Visit update' }))
    .resolves.toEqual({ ok: true });

  expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
