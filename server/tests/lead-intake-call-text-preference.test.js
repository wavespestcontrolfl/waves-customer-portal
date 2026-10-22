/**
 * GATE_LEAD_CALL_TEXT_PREFERENCE: a lead in SMS intake answering the
 * auto-reply with a bare CALL or TEXT gets one note on their newest lead, and
 * the reply is NOT consumed (it still reaches inbox + bell). Nothing else is
 * stored, nothing is sent to the customer, lead_intake_status never changes.
 * The customer row is locked and its status re-read before the note.
 */

let mockGateOn;
let mockLockedRow;
let mockLockedForUpdate;
let mockLeadRow;
let mockActivityInserts;
let mockCustomerUpdates;
let mockSmsSends;
let mockInsertFails;

jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => name === 'leadCallTextPreference' && mockGateOn,
}));

jest.mock('../models/db', () => {
  const db = (table) => {
    const chain = {
      select() { return chain; },
      where() { return chain; },
      whereNull() { return chain; },
      whereIn() { return chain; },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      forUpdate() { if (table === 'customers') mockLockedForUpdate = true; return chain; },
      async first() {
        if (table === 'customers') return mockLockedRow;
        if (table === 'leads') return mockLeadRow;
        return null;
      },
      async update(patch) {
        if (table === 'customers') mockCustomerUpdates.push(patch);
        return 1;
      },
      insert(row) {
        if (table === 'lead_activities') {
          if (mockInsertFails) return Promise.reject(new Error('boom'));
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
  db.transaction = async (cb) => cb((table) => db(table));
  return db;
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

jest.mock('../services/twilio', () => ({
  sendSMS: (...args) => { mockSmsSends.push(args); return Promise.resolve({ sid: 'SM1' }); },
}));

const mockClassify = jest.fn();
jest.mock('../services/sms-service-intent', () => ({
  ...jest.requireActual('../services/sms-service-intent'),
  classifyServiceIntent: (...args) => mockClassify(...args),
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
  mockLockedRow = { lead_intake_status: 'awaiting_service' };
  mockLockedForUpdate = false;
  mockLeadRow = { id: 'lead-1' };
  mockActivityInserts = [];
  mockCustomerUpdates = [];
  mockSmsSends = [];
  mockInsertFails = false;
  mockClassify.mockResolvedValue(null);
});

describe('recordCallTextReply, gate on', () => {
  test.each([
    ['CALL', 'call', 'Lead replied CALL: wants a phone call'],
    ['Text me', 'text', 'Lead replied TEXT: prefers text'],
    ['please text', 'text', 'Lead replied TEXT: prefers text'],
  ])('%j writes one note on the newest lead and returns %s', async (body, choice, description) => {
    expect(await recordCallTextReply(CUSTOMER(), body, { triggerSmsLogId: 'log-1' })).toBe(choice);
    expect(mockLockedForUpdate).toBe(true);
    expect(mockActivityInserts).toHaveLength(1);
    expect(mockActivityInserts[0]).toMatchObject({ lead_id: 'lead-1', activity_type: 'contact_preference', description, performed_by: 'system' });
    expect(JSON.parse(mockActivityInserts[0].metadata)).toEqual({ choice, source: 'sms_reply', smsLogId: 'log-1' });
    // One automated text only; intake status untouched.
    expect(mockSmsSends).toEqual([]);
    expect(mockCustomerUpdates).toEqual([]);
  });

  test.each(['awaiting_service', 'awaiting_address'])('intake status %s (re-read from the locked row) is eligible', async (status) => {
    mockLockedRow = { lead_intake_status: status };
    expect(await recordCallTextReply(CUSTOMER(), 'call', {})).toBe('call');
  });

  test('a longer or mixed reply records nothing', async () => {
    expect(await recordCallTextReply(CUSTOMER(), 'call me after 5', {})).toBeUndefined();
    expect(mockLockedForUpdate).toBe(false);
    expect(mockActivityInserts).toEqual([]);
  });

  test('the LOCKED row went to estimate_drafted (a service reply won the race): no note, no label', async () => {
    // The caller's copy still says awaiting_service; the locked row is what counts.
    mockLockedRow = { lead_intake_status: 'estimate_drafted' };
    expect(await recordCallTextReply(CUSTOMER('awaiting_service'), 'call', {})).toBeUndefined();
    expect(mockActivityInserts).toEqual([]);
  });

  test.each([[{ lead_intake_status: null }], [undefined]])('locked row %j (intake cleared / customer gone): no note', async (row) => {
    mockLockedRow = row;
    expect(await recordCallTextReply(CUSTOMER(), 'text', {})).toBeUndefined();
    expect(mockActivityInserts).toEqual([]);
  });

  test('no lead row: nothing written, no label', async () => {
    mockLeadRow = null;
    expect(await recordCallTextReply(CUSTOMER(), 'text', {})).toBeUndefined();
    expect(mockActivityInserts).toEqual([]);
  });

  test('a write error is logged by customer id only and returns no label', async () => {
    mockInsertFails = true;
    expect(await recordCallTextReply(CUSTOMER(), 'call', {})).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const logged = mockLogger.error.mock.calls[0][0];
    expect(logged).toContain('cust-1');
    expect(logged).not.toContain('+1941');
    expect(logged.toLowerCase()).not.toContain('call me');
  });
});

describe('gate off', () => {
  test.each(['call', 'text', 'Text me'])('%j records nothing and returns nothing', async (body) => {
    mockGateOn = false;
    expect(await recordCallTextReply(CUSTOMER(), body, {})).toBeUndefined();
    expect(mockLockedForUpdate).toBe(false);
    expect(mockActivityInserts).toEqual([]);
    expect(mockSmsSends).toEqual([]);
  });
});

test('handleIntakeReply never consumes a bare CALL / TEXT reply (gate on or off) and never reaches the classifier', async () => {
  for (const on of [true, false]) {
    mockGateOn = on;
    for (const status of ['awaiting_service', 'awaiting_address']) {
      expect(await handleIntakeReply(CUSTOMER(status), 'call', {})).toEqual({ handled: false });
    }
  }
  expect(mockActivityInserts).toEqual([]);
  expect(mockSmsSends).toEqual([]);
});
