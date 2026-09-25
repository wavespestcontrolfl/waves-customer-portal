/**
 * codex #4815 r3 P1: pushCallToRetryLaneAfterQuarantineFailure
 * (call-recording-processor.js) — the shared last-resort fallback when a
 * durable quarantine-retry queue write (markQuarantinePending) itself
 * fails to land. Previously the identity-conflict quarantine catch had its
 * own inline copy of this fallback, and both NEW price_agreed_on_call call
 * sites ignored markQuarantinePending's boolean entirely — a false left
 * the call finalized as 'processed' with neither the block nor a queued
 * retry. Now all three sites share this one function.
 *
 * Drives the real function against a minimal call_log query mock.
 * Fixtures fictitious (call-1); no real customer data.
 */

let mockUpdateResult = 1;
const mockCalls = [];

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const b = { _table: table, _wheres: [] };
    for (const m of ['where', 'whereNull']) {
      b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
    }
    b.update = async (row) => {
      mockCalls.push({ table, wheres: b._wheres.slice(), row });
      return mockUpdateResult;
    };
    return b;
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const { _test } = require('../services/call-recording-processor');
const { pushCallToRetryLaneAfterQuarantineFailure } = _test;
const logger = require('../services/logger');

const CALL = { id: 'call-1', twilio_call_sid: 'CA-fallback-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockUpdateResult = 1;
});

describe('pushCallToRetryLaneAfterQuarantineFailure', () => {
  test('pushes the call to extraction_failed, fenced on processing_token IS NULL and the SAME generation', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(mockCalls).toHaveLength(1);
    const write = mockCalls[0];
    expect(write.table).toBe('call_log');
    expect(write.row).toMatchObject({ processing_status: 'extraction_failed' });
    expect(write.wheres).toContainEqual(['where', { id: 'call-1' }]);
    expect(write.wheres).toContainEqual(['whereNull', 'processing_token']);
    expect(write.wheres).toContainEqual(['where', 'processing_generation', 7]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pushed to the retry lane'));
  });

  test('with no generation, the write is NOT generation-fenced (legacy shape)', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: null, reason: 'price_agreed_on_call',
    });

    const write = mockCalls[0];
    expect(write.wheres.some(([m, col]) => m === 'where' && col === 'processing_generation')).toBe(false);
  });

  test('a 0-row write (a newer pass owns the call) logs info, not error — this is a verdict, not a failure', async () => {
    mockUpdateResult = 0;

    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('a newer pass owns the call'));
  });

  test('a thrown write is caught and logged, never propagated', async () => {
    const dbMock = require('../models/db');
    dbMock.mockImplementationOnce(() => { throw new Error('db down'); });

    await expect(pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ALSO failed'));
  });

  test('the reason string rides both log lines for the two callers sharing this one fallback', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'email_identity_conflict',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('email_identity_conflict'));
  });
});
