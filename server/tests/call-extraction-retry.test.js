// AI-extraction failure handling: failures increment call_log.extraction_attempts,
// the pending sweep retries them while under CALL_EXTRACTION_MAX_ATTEMPTS, and the
// final failure files a blocking triage item. Regression for 2026-07-09: Google
// retired gemini-2.5-flash (rolling 404s) and six calls died at
// processing_status='extraction_failed' with no retry, no triage item, no lead —
// silent lead loss with zero surface in any inbox.
// Fixtures fictitious; 555-01xx numbers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const db = require('../models/db');
const { buildTriageItem } = require('../services/call-routing-gates');

const CALL_SID = 'CA000000000000000000000000000retry';

function baseCall(overrides = {}) {
  return {
    id: 'call-retry-1',
    twilio_call_sid: CALL_SID,
    direction: 'inbound',
    from_phone: '+15555550144',
    to_phone: '+15555550155',
    customer_id: null,
    processing_status: null,
    recording_url: 'https://api.twilio.com/fake/RE00retry',
    recording_duration_seconds: 90,
    duration_seconds: 90,
    // Cached Twilio transcript: with no OpenAI/Gemini keys in the test env the
    // transcriber falls back to this, so the run reaches AI extraction, which
    // then throws GEMINI_API_KEY-not-configured — the failure under test.
    transcription: 'Caller: I need pest control at my house please.',
    transcription_status: 'completed',
    created_at: new Date(),
    extraction_attempts: 0,
    ...overrides,
  };
}

// Table-aware thenable builder mock. call_log.first() returns the fixture;
// call_log.update() resolves 1 (claim + status writes) and exposes
// .returning() resolving the post-increment attempts row; triage_items
// .insert().onConflict().ignore() records the row.
function mockDb(call, { attemptsAfterFailure }) {
  const state = { callLogUpdates: [], triageInserts: [] };
  db.mockImplementation((table) => {
    const builder = {};
    const chain = () => builder;
    ['where', 'whereRaw', 'whereNull', 'whereNotNull', 'whereIn', 'orWhere', 'orWhereRaw', 'andWhere', 'select', 'orderBy', 'limit', 'leftJoin'].forEach((m) => { builder[m] = chain; });
    builder.first = () => Promise.resolve(table === 'call_log' ? call : null);
    builder.update = (payload) => {
      if (table === 'call_log') state.callLogUpdates.push(payload);
      return {
        returning: () => Promise.resolve([{ extraction_attempts: attemptsAfterFailure }]),
        then: (resolve, reject) => Promise.resolve(1).then(resolve, reject),
      };
    };
    builder.insert = (row) => ({
      onConflict: () => ({
        ignore: () => {
          if (table === 'triage_items') state.triageInserts.push(row);
          return Promise.resolve();
        },
      }),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    });
    builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return builder;
  });
  db.raw = (sql) => sql;
  return state;
}

describe('extraction failure: attempt counter + terminal triage card', () => {
  let processor;
  let fetchSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // No network in tests: the recording download rejects, forcing the
    // cached-transcript path.
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network disabled in test'));
    jest.isolateModules(() => {
      processor = require('../services/call-recording-processor');
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  test('non-final failure increments extraction_attempts in SQL and files NO triage item', async () => {
    const state = mockDb(baseCall(), { attemptsAfterFailure: 1 });

    const result = await processor.processRecording(CALL_SID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/AI extraction failed/);
    const failWrite = state.callLogUpdates.find((u) => u.processing_status === 'extraction_failed');
    expect(failWrite).toBeDefined();
    // SQL-side increment, not a value computed from the possibly-stale
    // in-memory row.
    expect(failWrite.extraction_attempts).toBe('COALESCE(extraction_attempts, 0) + 1');
    expect(failWrite.processing_token).toBeNull();
    expect(state.triageInserts).toHaveLength(0);
  });

  test('final failure (attempts reaches the cap) files a blocking extraction_failed_permanent card', async () => {
    const state = mockDb(baseCall({ extraction_attempts: 2, processing_status: 'extraction_failed' }), { attemptsAfterFailure: 3 });

    const result = await processor.processRecording(CALL_SID);

    expect(result.success).toBe(false);
    expect(state.triageInserts).toHaveLength(1);
    const item = state.triageInserts[0];
    expect(item.reason_code).toBe('extraction_failed_permanent');
    expect(item.category).toBe('service_unknown');
    expect(item.severity).toBe('blocking');
    expect(item.status).toBe('open');
    expect(item.call_log_id).toBe('call-retry-1');
    const payload = JSON.parse(item.payload);
    expect(payload.attempts).toBe(3);
    expect(payload.last_error).toMatch(/GEMINI_API_KEY/);
  });

  test('triage insert failure does not mask the extraction error result', async () => {
    const state = mockDb(baseCall({ extraction_attempts: 2 }), { attemptsAfterFailure: 3 });
    // Re-mock triage insert to throw.
    const originalImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      const builder = originalImpl(table);
      if (table === 'triage_items') {
        builder.insert = () => ({ onConflict: () => ({ ignore: () => Promise.reject(new Error('unique_violation')) }) });
      }
      return builder;
    });

    const result = await processor.processRecording(CALL_SID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/AI extraction failed/);
    expect(state.triageInserts).toHaveLength(0);
  });
});

describe('processAllPending picks up retryable extraction failures', () => {
  test('sweep SQL includes the extraction_failed branch with attempt cap, backoff age gate, and 7-day fence', async () => {
    const realKnex = require('knex')({ client: 'pg' });
    const captured = [];
    db.mockImplementation((table) => {
      const qb = realKnex(table);
      // Never execute — capture the rendered SQL and resolve empty.
      qb.then = (resolve, reject) => {
        captured.push(qb.toString());
        return Promise.resolve([]).then(resolve, reject);
      };
      return qb;
    });
    db.raw = (...args) => realKnex.raw(...args);

    let processor;
    jest.isolateModules(() => {
      processor = require('../services/call-recording-processor');
    });
    const result = await processor.processAllPending();

    expect(result.processed).toBe(0);
    const sweepSql = captured.find((sql) => sql.includes('extraction_failed'));
    expect(sweepSql).toBeDefined();
    expect(sweepSql).toContain("\"processing_status\" = 'extraction_failed'");
    expect(sweepSql).toContain('COALESCE(extraction_attempts, 0) < 3');
    expect(sweepSql).toContain("NOW() - INTERVAL '7 days'");
    // Existing branches survive.
    expect(sweepSql).toContain("'no_transcription'");
    expect(sweepSql).toContain("'processing'");
    await realKnex.destroy();
  });
});

describe('buildTriageItem extraction_failed_permanent mapping', () => {
  test('maps to service_unknown / blocking and carries the failure payload', () => {
    const item = buildTriageItem({
      callLogId: 'call-x',
      flag: 'extraction_failed_permanent',
      extraction: { meta: { call_summary: 'AI extraction failed 3 time(s)' } },
      extraPayload: { attempts: 3, last_error: 'Gemini HTTP 404' },
    });
    expect(item.category).toBe('service_unknown');
    expect(item.severity).toBe('blocking');
    expect(item.reason_code).toBe('extraction_failed_permanent');
    expect(item.summary).toMatch(/extraction failed/);
    const payload = JSON.parse(item.payload);
    expect(payload.attempts).toBe(3);
    expect(payload.last_error).toBe('Gemini HTTP 404');
  });
});
