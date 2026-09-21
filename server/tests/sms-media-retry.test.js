const mockSend = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn((input) => ({ input })),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../config', () => ({
  s3: { region: 'test', bucket: 'synthetic-test' },
  twilio: { accountSid: 'AC-test', authToken: 'synthetic' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { uploadTwilioMedia } = require('../services/sms-media');
const originalFetch = global.fetch;
function payload(sid = 'SM-test', count = 1) {
  const body = { AccountSid: 'AC-test', MessageSid: sid, NumMedia: String(count) };
  for (let i = 0; i < count; i++) {
    body[`MediaUrl${i}`] = `https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages/${sid}/Media/ME-${i}`;
    body[`MediaContentType${i}`] = 'image/jpeg';
  }
  return body;
}
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({
    ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('synthetic image'),
  }));
});
afterAll(() => { global.fetch = originalFetch; });

test('redelivery writes the same media object key instead of orphaning a new object', async () => {
  const first = await uploadTwilioMedia(payload());
  const retry = await uploadTwilioMedia(payload());
  expect(first[0].key).toBe(retry[0].key);
  expect(first[0].key).toMatch(/^sms-media\/inbound\/[a-f0-9]{64}$/);
  expect(mockSend.mock.calls.map(([command]) => command.input.Key)).toEqual([first[0].key, first[0].key]);
});

test('message and media identities cannot overwrite one another', async () => {
  const first = await uploadTwilioMedia(payload('SM-one', 2));
  const other = await uploadTwilioMedia(payload('SM-two'));
  expect(new Set([...first, ...other].map((item) => item.key)).size).toBe(3);
});

test('untrusted media URLs never reach storage', async () => {
  const body = payload();
  body.MediaUrl0 = 'https://example.invalid/secret';
  const media = await uploadTwilioMedia(body);
  expect(media[0].rejected).toBe(true);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});
