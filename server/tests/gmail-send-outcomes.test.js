// Real Google SDK with an in-memory transporter. No OAuth or message request
// reaches the network; transport failures still traverse the real SDK paths.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
const { google } = require('googleapis');
const gmail = require('../services/email/gmail-client');
const OAuth2 = google.auth.OAuth2;
let requests, providerFailure, expired, acceptedData;

beforeEach(() => {
  requests = []; expired = false; acceptedData = undefined;
  db.mockImplementation(() => ({ first: async () => ({ refresh_token: 'synthetic-refresh', access_token: 'synthetic-access',
    token_expires_at: new Date(Date.now() + (expired ? -3600000 : 3600000)) }) }));
  jest.spyOn(google.auth, 'OAuth2').mockImplementation((...args) => {
    const client = new OAuth2(...args);
    client.transporter = { request: async config => {
      requests.push(config);
      if (acceptedData !== undefined) return { data: acceptedData, status: 200, config };
      const error = Object.assign(new Error('Synthetic provider rejection'), providerFailure, { config });
      if (providerFailure.status) error.response = { status: providerFailure.status, config };
      throw error;
    } };
    return client;
  });
});
afterEach(() => jest.restoreAllMocks());

test('a valid accepted response retains its provider identifier', async () => {
  acceptedData = { id: 'synthetic-message', threadId: 'synthetic-thread' };
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture')).resolves.toEqual(acceptedData);
  expect(requests).toHaveLength(1);
});

test.each([{}, null])('an accepted response without an id stays uncertain for every caller: %j', async data => {
  acceptedData = data;
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture'))
    .rejects.toMatchObject({ providerOutcome: { outcomeUnknown: true } });
  expect(requests).toHaveLength(1);
});

test.each([
  ['response timeout', { code: 'ETIMEDOUT' }],
  ['connection reset', { code: 'ECONNRESET' }],
  ['HTTP 408', { status: 408 }],
  ['HTTP 503', { status: 503 }],
  ['unreadable accepted response', { status: 200 }],
])('%s after message submission remains uncertain without transport retry', async (_label, failure) => {
  providerFailure = failure;
  await expect(gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture'))
    .rejects.toMatchObject({ providerOutcome: { outcomeUnknown: true } });
  expect(requests).toHaveLength(1);
  expect(String(requests[0].url)).toContain('/messages/send');
  expect(requests[0].retry).toBe(false);
});

test.each([400, 401, 403, 429])('definitive HTTP %i is a failed send', async status => {
  providerFailure = { status };
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
});

test.each(['ENOTFOUND', 'ECONNREFUSED', 'CERT_HAS_EXPIRED'])('%s establishes no submission', async code => {
  providerFailure = { code };
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
});

test.each([{ code: 'ETIMEDOUT' }, { status: 503 }])('OAuth failure before submission stays failed: %j', async failure => {
  expired = true; providerFailure = failure;
  const error = await gmail.sendMessage('fixture@example.test', 'Synthetic', 'Fixture').catch(err => err);
  expect(error).toBeInstanceOf(Error);
  expect(error.providerOutcome).toBeUndefined();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => String(request.url).includes('/token'))).toBe(true);
});
