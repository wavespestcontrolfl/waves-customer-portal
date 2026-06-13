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

const { tryClaimInboundWebhook, claimInboundWebhook, releaseInboundWebhook } = require('../services/messaging/inbound-dedupe');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('tryClaimInboundWebhook', () => {
  test('first delivery: processable AND owned', async () => {
    mockChain.returning.mockResolvedValue([{ twilio_sid: 'SM123' }]);
    await expect(tryClaimInboundWebhook('SM123', 'sms')).resolves.toEqual({ processable: true, owned: true });
    expect(mockChain.insert).toHaveBeenCalledWith({ twilio_sid: 'SM123', channel: 'sms' });
    expect(mockChain.onConflict).toHaveBeenCalledWith('twilio_sid');
    expect(mockChain.ignore).toHaveBeenCalled();
  });

  test('redelivery (conflict): neither processable nor owned', async () => {
    mockChain.returning.mockResolvedValue([]); // ON CONFLICT DO NOTHING -> 0 rows
    await expect(tryClaimInboundWebhook('SM123', 'sms')).resolves.toEqual({ processable: false, owned: false });
  });

  test('FAILS OPEN on write error: processable but NOT owned (must not release a row it never took)', async () => {
    mockChain.returning.mockRejectedValue(new Error('relation does not exist'));
    await expect(tryClaimInboundWebhook('CA999', 'voice')).resolves.toEqual({ processable: true, owned: false });
  });

  test('missing SID: processable but not owned, no DB call', async () => {
    await expect(tryClaimInboundWebhook(undefined, 'sms')).resolves.toEqual({ processable: true, owned: false });
    expect(mockChain.insert).not.toHaveBeenCalled();
  });
});

describe('claimInboundWebhook (boolean wrapper)', () => {
  test('returns true for a fresh claim', async () => {
    mockChain.returning.mockResolvedValue([{ twilio_sid: 'SM123' }]);
    await expect(claimInboundWebhook('SM123', 'sms')).resolves.toBe(true);
  });

  test('returns false for a duplicate', async () => {
    mockChain.returning.mockResolvedValue([]);
    await expect(claimInboundWebhook('SM123', 'sms')).resolves.toBe(false);
  });

  test('returns true on fail-open', async () => {
    mockChain.returning.mockRejectedValue(new Error('boom'));
    await expect(claimInboundWebhook('SM123', 'sms')).resolves.toBe(true);
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
