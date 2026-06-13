/**
 * Contract tests for the inbound-webhook idempotency claim (RED audit R1).
 * Pure logic over a mocked db so it runs without a test database.
 */

const mockChain = {
  insert: jest.fn(() => mockChain),
  onConflict: jest.fn(() => mockChain),
  ignore: jest.fn(() => mockChain),
  returning: jest.fn(),
  where: jest.fn(() => mockChain),
  del: jest.fn(),
};

jest.mock('../models/db', () => jest.fn(() => mockChain));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { claimInboundWebhook, releaseInboundWebhook } = require('../services/messaging/inbound-dedupe');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('claimInboundWebhook', () => {
  test('first delivery wins the claim (returns true)', async () => {
    mockChain.returning.mockResolvedValue([{ twilio_sid: 'SM123' }]);
    await expect(claimInboundWebhook('SM123', 'sms')).resolves.toBe(true);
    expect(mockChain.insert).toHaveBeenCalledWith({ twilio_sid: 'SM123', channel: 'sms' });
    expect(mockChain.onConflict).toHaveBeenCalledWith('twilio_sid');
    expect(mockChain.ignore).toHaveBeenCalled();
  });

  test('redelivery hits the conflict and is reported as a duplicate (returns false)', async () => {
    mockChain.returning.mockResolvedValue([]); // ON CONFLICT DO NOTHING -> 0 rows
    await expect(claimInboundWebhook('SM123', 'sms')).resolves.toBe(false);
  });

  test('FAILS OPEN when the dedupe write errors (returns true — never drop a message)', async () => {
    mockChain.returning.mockRejectedValue(new Error('relation does not exist'));
    await expect(claimInboundWebhook('CA999', 'voice')).resolves.toBe(true);
  });

  test('missing SID is treated as processable (returns true, no DB call)', async () => {
    await expect(claimInboundWebhook(undefined, 'sms')).resolves.toBe(true);
    expect(mockChain.insert).not.toHaveBeenCalled();
  });
});

describe('releaseInboundWebhook', () => {
  test('deletes the claim row for the SID', async () => {
    mockChain.del.mockResolvedValue(1);
    await releaseInboundWebhook('SM123');
    expect(mockChain.where).toHaveBeenCalledWith({ twilio_sid: 'SM123' });
    expect(mockChain.del).toHaveBeenCalled();
  });

  test('no-ops on missing SID', async () => {
    await releaseInboundWebhook(undefined);
    expect(mockChain.del).not.toHaveBeenCalled();
  });

  test('swallows DB errors (best-effort)', async () => {
    mockChain.del.mockRejectedValue(new Error('boom'));
    await expect(releaseInboundWebhook('SM123')).resolves.toBeUndefined();
  });
});
