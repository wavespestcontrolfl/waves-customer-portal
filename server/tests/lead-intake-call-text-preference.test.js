/**
 * GATE_LEAD_CALL_TEXT_PREFERENCE: a lead in SMS intake answering the
 * auto-reply with a bare CALL or TEXT has the choice saved and noted, and the
 * reply is NOT consumed (it still reaches inbox + bell). Nothing is sent to
 * the customer and lead_intake_status never changes.
 */

let mockGateOn;
let mockPrefUpserts;
let mockActivityInserts;
let mockSmsSends;
let mockLeadRow;
let mockPrefFails;
let mockNewerActivity;
let mockSmsLogRow;
let mockLocks;

jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => name === 'leadCallTextPreference' && mockGateOn,
}));

jest.mock('../models/db', () => {
  const db = (table) => {
    const chain = {
      select() { return chain; },
      join() { return chain; },
      where() { return chain; },
      whereNull() { return chain; },
      whereIn() { return chain; },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      async first() {
        if (table === 'leads') return mockLeadRow;
        if (table === 'lead_activities as a') return mockNewerActivity;
        if (table === 'sms_log') return mockSmsLogRow;
        return null;
      },
      async update() { return 1; },
      insert(row) {
        if (table === 'lead_activities') {
          mockActivityInserts.push(row);
          return Promise.resolve([{ id: 1 }]);
        }
        if (table === 'property_preferences') {
          return {
            onConflict(col) {
              return {
                async merge(patch) {
                  if (mockPrefFails) throw new Error('boom');
                  mockPrefUpserts.push({ row, conflict: col, patch });
                },
              };
            },
          };
        }
        return Promise.resolve([{ id: 'x', ...row }]);
      },
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return chain;
  };
  db.raw = () => ({});
  db.fn = { now: () => new Date() };
  db.transaction = async (cb) => {
    const trx = (table) => db(table);
    trx.raw = async (sql, bindings) => { mockLocks.push({ sql, bindings }); return { rows: [] }; };
    return cb(trx);
  };
  return db;
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

jest.mock('../services/twilio', () => ({
  sendSMS: (...args) => { mockSmsSends.push(args); return Promise.resolve({ sid: 'SM1' }); },
}));

jest.mock('../services/sms-service-intent', () => ({ classifyServiceIntent: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/estimate-clarify-asks', () => ({
  recordClarifyAnswer: jest.fn().mockResolvedValue(true),
  parkClarifyAsk: jest.fn().mockResolvedValue(true),
  clarifyAsksEnabled: () => false,
}));
jest.mock('../services/estimator-engine/sms-thread', () => ({
  smsThreadDraftsEnabled: () => true,
  startSmsThreadDraft: jest.fn().mockResolvedValue({ started: false, skipped: 'x' }),
}));

const { handleIntakeReply, recordCallTextReply, parseCallTextReply } = require('../services/lead-intake');

const CUSTOMER = (status = 'awaiting_service') => ({
  id: 'cust-1',
  first_name: 'Dana',
  phone: '+19415550123',
  address_line1: '100 Sample St',
  lead_intake_status: status,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGateOn = true;
  mockPrefUpserts = [];
  mockActivityInserts = [];
  mockSmsSends = [];
  mockLeadRow = { id: 'lead-1' };
  mockPrefFails = false;
  mockNewerActivity = null;
  mockSmsLogRow = { created_at: new Date('2026-10-14T15:00:00.000Z') };
  mockLocks = [];
});

describe('parseCallTextReply', () => {
  test.each([
    ['call', 'call'], ['CALL', 'call'], ['Call.', 'call'], ['  call me  ', 'call'],
    ['Please call!', 'call'], ['call please', 'call'], ['"Call"', 'call'], ['call   me', 'call'],
    ['text', 'text'], ['TEXT', 'text'], ['Text me', 'text'], ['text please', 'text'], ['Please text', 'text'], ['please text.', 'text'],
    ['Texting', 'text'], ['txt', 'text'], ['Text!!', 'text'],
  ])('%j => %s', (input, expected) => {
    expect(parseCallTextReply(input)).toBe(expected);
  });

  test.each([
    'call me after 5', 'ants in kitchen', 'text me the quote', 'please call me tomorrow',
    'call or text', 'please text me tomorrow', 'no call', 'do not text', '', '   ', '...', 'recall', 'context', '100 Palm Ave',
    null, undefined, 42, {},
  ])('%j => null', (input) => {
    expect(parseCallTextReply(input)).toBeNull();
  });
});

describe('recordCallTextReply, gate on', () => {
  test.each([['CALL', 'call', 'Lead replied CALL: wants a phone call'], ['Text me', 'text', 'Lead replied TEXT: prefers text']])(
    '%j saves %s on the preference row and notes the newest lead',
    async (body, preference, description) => {
      const result = await recordCallTextReply(CUSTOMER(), body, { triggerSmsLogId: 'log-1' });
      expect(result).toBe(preference);
      expect(mockPrefUpserts).toHaveLength(1);
      expect(mockPrefUpserts[0].row).toEqual({ customer_id: 'cust-1', contact_preference: preference });
      expect(mockPrefUpserts[0].conflict).toBe('customer_id');
      expect(mockPrefUpserts[0].patch).toMatchObject({ contact_preference: preference });
      expect(mockActivityInserts).toHaveLength(1);
      expect(mockActivityInserts[0]).toMatchObject({ lead_id: 'lead-1', description, performed_by: 'system' });
      expect(JSON.parse(mockActivityInserts[0].metadata)).toMatchObject({ contact_preference: preference, source_at: '2026-10-14T15:00:00.000Z' });
      // Serialized per customer; one automated text only.
      expect(mockLocks).toHaveLength(1);
      expect(mockLocks[0].sql).toContain('pg_advisory_xact_lock');
      expect(mockLocks[0].bindings[0]).toContain('cust-1');
      expect(mockSmsSends).toEqual([]);
    },
  );

  test('a longer or mixed reply records nothing', async () => {
    expect(await recordCallTextReply(CUSTOMER(), 'call me after 5', {})).toBeUndefined();
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
    expect(mockLocks).toEqual([]);
  });

  test('a newer reply is already recorded: the older reply writes nothing, but still reports its own choice', async () => {
    mockNewerActivity = { id: 99 };
    const result = await recordCallTextReply(CUSTOMER(), 'call', { triggerSmsLogId: 'log-old' });
    expect(result).toBe('call');
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
  });

  test('no lead row: preference still saved, no activity', async () => {
    mockLeadRow = null;
    expect(await recordCallTextReply(CUSTOMER(), 'text', {})).toBe('text');
    expect(mockPrefUpserts).toHaveLength(1);
    expect(mockActivityInserts).toEqual([]);
  });

  test('a save failure is logged by customer id only and never blocks the reply', async () => {
    mockPrefFails = true;
    expect(await recordCallTextReply(CUSTOMER(), 'call', {})).toBe('call');
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const logged = mockLogger.error.mock.calls[0][0];
    expect(logged).toContain('cust-1');
    expect(logged).not.toContain('+1941');
  });
});

describe('gate off', () => {
  test.each(['call', 'text', 'Text me'])('%j records nothing and returns nothing', async (body) => {
    mockGateOn = false;
    expect(await recordCallTextReply(CUSTOMER(), body, {})).toBeUndefined();
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
    expect(mockLocks).toEqual([]);
    expect(mockSmsSends).toEqual([]);
  });
});

test('handleIntakeReply never consumes a bare CALL / TEXT reply (gate on or off)', async () => {
  for (const on of [true, false]) {
    mockGateOn = on;
    for (const status of ['awaiting_service', 'awaiting_address']) {
      expect(await handleIntakeReply(CUSTOMER(status), 'call', {})).toEqual({ handled: false });
    }
  }
  expect(mockPrefUpserts).toEqual([]);
  expect(mockSmsSends).toEqual([]);
});
