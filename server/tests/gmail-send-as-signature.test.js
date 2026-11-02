/**
 * getSendAsSignature: the Gmail "send as" signature for the shared inbox.
 * Cached 60 minutes, non-empty values only; errors propagate and are not cached.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockSendAsGet = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn(), on: jest.fn() })) },
    gmail: jest.fn(() => ({ users: { settings: { sendAs: { get: (...args) => mockSendAsGet(...args) } } } })),
  },
}));

let gmailClient;
let now;

beforeEach(() => {
  jest.resetModules();
  const db = require('../models/db');
  db.mockImplementation(() => ({ first: async () => ({ id: 1, refresh_token: 'synthetic-refresh' }) }));
  gmailClient = require('../services/email/gmail-client');
  mockSendAsGet.mockReset();
  now = 1_800_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GMAIL_USER_EMAIL;
});

test('reads the signature for the own address', async () => {
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>Waves</div>' } });
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('<div>Waves</div>');
  expect(mockSendAsGet).toHaveBeenCalledWith({ userId: 'me', sendAsEmail: 'contact@wavespestcontrol.com' });
});

test('uses GMAIL_USER_EMAIL when set', async () => {
  process.env.GMAIL_USER_EMAIL = 'shared@example.test';
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>S</div>' } });
  await gmailClient.getSendAsSignature();
  expect(mockSendAsGet).toHaveBeenCalledWith({ userId: 'me', sendAsEmail: 'shared@example.test' });
});

test('caches a non-empty signature for 60 minutes, then reads again', async () => {
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>One</div>' } });
  await gmailClient.getSendAsSignature();
  now += 59 * 60 * 1000;
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('<div>One</div>');
  expect(mockSendAsGet).toHaveBeenCalledTimes(1);
  now += 2 * 60 * 1000;
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>Two</div>' } });
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('<div>Two</div>');
  expect(mockSendAsGet).toHaveBeenCalledTimes(2);
});

test('an empty signature is returned as an empty string and is not cached', async () => {
  mockSendAsGet.mockResolvedValue({ data: {} });
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('');
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>Later</div>' } });
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('<div>Later</div>');
  expect(mockSendAsGet).toHaveBeenCalledTimes(2);
});

test('an error propagates and is not cached', async () => {
  mockSendAsGet.mockRejectedValueOnce(new Error('insufficient scope'));
  await expect(gmailClient.getSendAsSignature()).rejects.toThrow('insufficient scope');
  mockSendAsGet.mockResolvedValue({ data: { signature: '<div>Ok</div>' } });
  await expect(gmailClient.getSendAsSignature()).resolves.toBe('<div>Ok</div>');
});
