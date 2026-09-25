/**
 * codex #4815 r3 P1 (r5 P1: routed through the bounded extraction-failure
 * accounting): pushCallToRetryLaneAfterQuarantineFailure
 * (call-recording-processor.js) — the shared last-resort fallback when a
 * durable quarantine-retry queue write (markQuarantinePending) itself
 * fails to land. Previously the identity-conflict quarantine catch had its
 * own inline copy of this fallback, and both NEW price_agreed_on_call call
 * sites ignored markQuarantinePending's boolean entirely — a false left
 * the call finalized as 'processed' with neither the block nor a queued
 * retry. r5: a bare processing_status write never advanced
 * extraction_attempts, so processAllPending retried the call every 10
 * minutes forever instead of stopping at CALL_EXTRACTION_MAX_ATTEMPTS, with
 * no exhausted-retry card ever filed — this now increments the SAME
 * counter and files the SAME triage card the ordinary extraction_failed
 * path uses. The live-owner mode this file used to also cover was retired
 * in r5: the pre-finalization price-agreed call site now defers its durable
 * queue write into the finalization transaction itself and never reaches
 * this fallback.
 *
 * Drives the real function against a minimal call_log/triage_items query
 * mock. Fixtures fictitious (call-1); no real customer data.
 */

const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('../config/call-extraction-retry');

let mockUpdateResult = 1;
let mockAttemptsAfterWrite = 1;
const mockCalls = [];
const triageInserts = [];

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const b = { _table: table, _wheres: [] };
    for (const m of ['where', 'whereNull']) {
      b[m] = (...a) => { b._wheres.push([m, ...a]); return b; };
    }
    b.update = (row) => {
      mockCalls.push({ table, wheres: b._wheres.slice(), row });
      return {
        returning: () => Promise.resolve(
          mockUpdateResult ? [{ extraction_attempts: mockAttemptsAfterWrite }] : [],
        ),
        then: (resolve, reject) => Promise.resolve(mockUpdateResult).then(resolve, reject),
      };
    };
    b.insert = (row) => ({
      onConflict: () => ({
        ignore: () => {
          triageInserts.push({ table, row });
          return Promise.resolve();
        },
      }),
    });
    return b;
  });
  db.raw = jest.fn((sql) => ({ __raw: sql }));
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
  triageInserts.length = 0;
  mockUpdateResult = 1;
  mockAttemptsAfterWrite = 1;
});

describe('pushCallToRetryLaneAfterQuarantineFailure', () => {
  test('pushes the call to extraction_failed, fenced on processing_token IS NULL and the SAME generation, and increments extraction_attempts', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(mockCalls).toHaveLength(1);
    const write = mockCalls[0];
    expect(write.table).toBe('call_log');
    expect(write.row).toMatchObject({ processing_status: 'extraction_failed', extraction_attempts: { __raw: 'COALESCE(extraction_attempts, 0) + 1' } });
    expect(write.wheres).toContainEqual(['where', { id: 'call-1' }]);
    expect(write.wheres).toContainEqual(['whereNull', 'processing_token']);
    expect(write.wheres).toContainEqual(['where', 'processing_generation', 7]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pushed to the bounded retry lane'));
  });

  // codex #4815 r8 P1: an exhausted (or aged-out) retry lane reads as
  // SETTLED, so a verdict that rode the lane alone stopped blocking. The
  // verdict itself rides the same statement into the quarantine queue —
  // either both land or neither does. (Real-jsonb coverage:
  // estimator-quarantine-multi-entry-postgres.test.js.)
  test('the SAME statement queues the verdict in the multi-entry quarantine queue', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(mockCalls).toHaveLength(1);
    expect(mockCalls[0].row.metadata.__raw).toContain('estimator_quarantine_queue');
    const dbMock = require('../models/db');
    const rawCall = dbMock.raw.mock.calls.find(([sql]) => String(sql).includes('estimator_quarantine_queue'));
    expect(rawCall[1][0]).toBe('price_agreed_on_call');
    expect(JSON.parse(rawCall[1][1])).toMatchObject({ reason: 'price_agreed_on_call', generation: 7 });
  });

  test('with no generation, the write is NOT generation-fenced (legacy shape)', async () => {
    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: null, reason: 'price_agreed_on_call',
    });

    const write = mockCalls[0];
    expect(write.wheres.some(([m, col]) => m === 'where' && col === 'processing_generation')).toBe(false);
  });

  test('a 0-row write (a newer pass owns the call) logs info, not error, and files no triage card — this is a verdict, not a failure', async () => {
    mockUpdateResult = 0;

    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('a newer pass owns the call'));
    expect(triageInserts).toHaveLength(0);
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

  test('below CALL_EXTRACTION_MAX_ATTEMPTS, no exhausted-retry triage card files — the sweep still has budget left', async () => {
    mockAttemptsAfterWrite = Math.max(1, CALL_EXTRACTION_MAX_ATTEMPTS - 1);

    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(triageInserts).toHaveLength(0);
  });

  test('at CALL_EXTRACTION_MAX_ATTEMPTS, files the SAME exhausted-retry triage card the ordinary extraction_failed path uses — this is the bounded accounting the r4 finalStatus flip skipped entirely', async () => {
    mockAttemptsAfterWrite = CALL_EXTRACTION_MAX_ATTEMPTS;

    await pushCallToRetryLaneAfterQuarantineFailure({
      call: CALL, callSid: CALL.twilio_call_sid, procGeneration: 7, reason: 'price_agreed_on_call',
    });

    expect(triageInserts).toHaveLength(1);
    expect(triageInserts[0].table).toBe('triage_items');
    expect(triageInserts[0].row).toMatchObject({
      call_log_id: 'call-1',
      reason_code: 'extraction_failed_permanent',
    });
  });
});
