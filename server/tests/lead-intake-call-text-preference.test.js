/**
 * GATE_LEAD_CALL_TEXT_PREFERENCE: a lead in SMS intake answering the
 * auto-reply with a bare CALL or TEXT has the choice saved and noted, and the
 * reply is NOT consumed (it still reaches inbox + bell). Nothing is sent to
 * the customer and lead_intake_status never changes.
 */

let mockGateOn;
let mockActivityInserts;
let mockSmsSends;
let mockLeadRow;
let mockPrefFails;
let mockNewerActivity;
let mockSmsLogRow;
let mockLocks;
let mockWhereRaw;

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
      whereRaw(sql, bindings) { mockWhereRaw.push({ sql, bindings }); return chain; },
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
    return cb(trx);
  };
  return db;
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

jest.mock('../services/twilio', () => ({
  sendSMS: (...args) => { mockSmsSends.push(args); return Promise.resolve({ sid: 'SM1' }); },
}));

jest.mock('../services/sms-service-intent', () => ({
  ...jest.requireActual('../services/sms-service-intent'),
  classifyServiceIntent: jest.fn().mockResolvedValue(null),
}));
let mockApplyResult;
let mockLockResult;
let mockApplyCalls;
jest.mock('../services/sms-operational-actions', () => ({
  lockPreferenceOwner: async (trx, id) => { mockLocks.push({ id }); return mockLockResult; },
  applyLeadContactPreference: async (trx, args) => {
    mockApplyCalls.push(args);
    if (mockPrefFails) throw new Error('boom');
    return mockApplyResult;
  },
}));
jest.mock('../services/estimate-clarify-asks', () => ({
  recordClarifyAnswer: jest.fn().mockResolvedValue(true),
  parkClarifyAsk: jest.fn().mockResolvedValue(true),
  clarifyAsksEnabled: () => false,
}));
jest.mock('../services/estimator-engine/sms-thread', () => ({
  smsThreadDraftsEnabled: () => true,
  startSmsThreadDraft: jest.fn().mockResolvedValue({ started: false, skipped: 'x' }),
}));

const { handleIntakeReply, recordCallTextReply } = require('../services/lead-intake');

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
  mockActivityInserts = [];
  mockSmsSends = [];
  mockLeadRow = { id: 'lead-1' };
  mockPrefFails = false;
  mockNewerActivity = null;
  mockSmsLogRow = { created_at: new Date('2026-10-14T15:00:00.000Z'), twilio_sid: 'SM-synthetic-1' };
  mockLocks = [];
  mockWhereRaw = [];
  mockApplyCalls = [];
  mockApplyResult = 'applied';
  mockLockResult = { id: 'cust-1' };
});

describe('recordCallTextReply, gate on', () => {
  test.each([['CALL', 'call', 'Lead replied CALL: wants a phone call'], ['Text me', 'text', 'Lead replied TEXT: prefers text']])(
    '%j saves %s through the SMS profile writer and notes the newest lead',
    async (body, preference, description) => {
      const result = await recordCallTextReply(CUSTOMER(), body, { triggerSmsLogId: 'log-1', receivedAtMs: 5000.25 });
      expect(result).toEqual({ leadPreference: preference, leadPreferenceAtMs: 5000.25 });
      // One writer call, under the writer's per-customer lock, carrying the source SMS time.
      expect(mockLocks).toEqual([{ id: 'cust-1' }]);
      expect(mockApplyCalls).toEqual([{
        customerId: 'cust-1', value: preference, messageAt: '2026-10-14T15:00:00.000Z', twilioSid: 'SM-synthetic-1', smsLogId: 'log-1',
      }]);
      expect(mockActivityInserts).toHaveLength(1);
      expect(mockActivityInserts[0]).toMatchObject({ lead_id: 'lead-1', description, performed_by: 'system' });
      expect(JSON.parse(mockActivityInserts[0].metadata)).toMatchObject({ contact_preference: preference, received_at_ms: 5000.25 });
      expect(mockSmsSends).toEqual([]);
    },
  );

  test('a longer or mixed reply records nothing', async () => {
    expect(await recordCallTextReply(CUSTOMER(), 'call me after 5', {})).toBeUndefined();
    expect(mockApplyCalls).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
    expect(mockLocks).toEqual([]);
  });

  test('ordering is the webhook-entry token, not the sms_log time: it is compared in the lock and stored', async () => {
    await recordCallTextReply(CUSTOMER(), 'call', { triggerSmsLogId: 'log-1', receivedAtMs: 4242.5 });
    expect(mockWhereRaw).toHaveLength(1);
    expect(mockWhereRaw[0].sql).toContain('received_at_ms');
    expect(mockWhereRaw[0].bindings).toEqual([4242.5]);
    expect(JSON.parse(mockActivityInserts[0].metadata).received_at_ms).toBe(4242.5);
  });

  test('a newer reply is already noted: nothing is written and the stale choice is NOT returned', async () => {
    mockNewerActivity = { id: 99 };
    expect(await recordCallTextReply(CUSTOMER(), 'call', { triggerSmsLogId: 'log-old' })).toBeUndefined();
    expect(mockApplyCalls).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
  });

  test('the writer reports a newer pending proposal: no note and no bell choice', async () => {
    mockApplyResult = 'superseded';
    expect(await recordCallTextReply(CUSTOMER(), 'text', { triggerSmsLogId: 'log-old' })).toBeUndefined();
    expect(mockApplyCalls).toHaveLength(1);
    expect(mockActivityInserts).toEqual([]);
  });

  test('customer row unavailable: nothing is written', async () => {
    mockLockResult = undefined;
    expect(await recordCallTextReply(CUSTOMER(), 'text', {})).toBeUndefined();
    expect(mockApplyCalls).toEqual([]);
  });

  test('no lead row: preference still saved, no activity', async () => {
    mockLeadRow = null;
    expect(await recordCallTextReply(CUSTOMER(), 'text', { receivedAtMs: 7 })).toEqual({ leadPreference: 'text', leadPreferenceAtMs: 7 });
    expect(mockApplyCalls).toHaveLength(1);
    expect(mockActivityInserts).toEqual([]);
  });

  test('a save failure is logged by customer id only and never blocks the reply', async () => {
    mockPrefFails = true;
    expect(await recordCallTextReply(CUSTOMER(), 'call', { receivedAtMs: 7 })).toEqual({ leadPreference: 'call', leadPreferenceAtMs: 7 });
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
    expect(mockApplyCalls).toEqual([]);
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
  expect(mockApplyCalls).toEqual([]);
  expect(mockSmsSends).toEqual([]);
});
