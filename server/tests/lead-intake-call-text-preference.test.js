/**
 * GATE_LEAD_CALL_TEXT_PREFERENCE: a lead in SMS intake answering the
 * auto-reply with a bare CALL or TEXT has the choice saved and noted, and the
 * reply is NOT consumed (it still reaches inbox + bell). Nothing is sent to
 * the customer and lead_intake_status never changes.
 */

let mockGateOn;
let mockCustomerUpdates;
let mockPrefUpserts;
let mockActivityInserts;
let mockSmsSends;
let mockLeadRow;
let mockPrefFails;

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
      orderBy() { return chain; },
      limit() { return chain; },
      async first() {
        if (table === 'leads') return mockLeadRow;
        return null;
      },
      async update(patch) {
        if (table === 'customers') mockCustomerUpdates.push(patch);
        return 1;
      },
      insert(row) {
        if (table === 'lead_activities') {
          mockActivityInserts.push(row);
          return Promise.resolve([{ id: 1 }]);
        }
        if (table === 'property_preferences') {
          const q = {
            onConflict(col) {
              return {
                async merge(patch) {
                  if (mockPrefFails) throw new Error('boom');
                  mockPrefUpserts.push({ row, conflict: col, patch });
                },
              };
            },
          };
          return q;
        }
        return Promise.resolve([{ id: 'x', ...row }]);
      },
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return chain;
  };
  db.raw = () => ({});
  db.fn = { now: () => new Date() };
  return db;
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

jest.mock('../services/twilio', () => ({
  sendSMS: (...args) => { mockSmsSends.push(args); return Promise.resolve({ sid: 'SM1' }); },
}));

const mockClassify = jest.fn();
jest.mock('../services/sms-service-intent', () => ({
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

const { handleIntakeReply, parseCallTextReply } = require('../services/lead-intake');
const { intakeOutcome } = require('../routes/twilio-webhook')._internals;

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
  mockCustomerUpdates = [];
  mockPrefUpserts = [];
  mockActivityInserts = [];
  mockSmsSends = [];
  mockLeadRow = { id: 'lead-1' };
  mockPrefFails = false;
  mockClassify.mockResolvedValue(null);
});

describe('parseCallTextReply', () => {
  test.each([
    ['call', 'call'], ['CALL', 'call'], ['Call.', 'call'], ['  call me  ', 'call'],
    ['Please call!', 'call'], ['call please', 'call'], ['"Call"', 'call'], ['call   me', 'call'],
    ['text', 'text'], ['TEXT', 'text'], ['Text me', 'text'], ['text please', 'text'],
    ['Texting', 'text'], ['txt', 'text'], ['Text!!', 'text'],
  ])('%j => %s', (input, expected) => {
    expect(parseCallTextReply(input)).toBe(expected);
  });

  test.each([
    'call me after 5', 'ants in kitchen', 'text me the quote', 'please call me tomorrow',
    'call or text', 'no call', 'do not text', '', '   ', '...', 'recall', 'context', '100 Palm Ave',
    null, undefined, 42, {},
  ])('%j => null', (input) => {
    expect(parseCallTextReply(input)).toBeNull();
  });
});

describe('gate on', () => {
  for (const status of ['awaiting_service', 'awaiting_address']) {
    test.each([['CALL', 'call', 'Lead replied CALL: wants a phone call'], ['Text me', 'text', 'Lead replied TEXT: prefers text']])(
      `${status}: %j saves ${'%s'} and notes the lead, consuming nothing`,
      async (body, preference, description) => {
        const result = await handleIntakeReply(CUSTOMER(status), body, { triggerSmsLogId: 'log-1' });
        expect(result).toEqual({ handled: false, callTextPreference: preference });
        expect(intakeOutcome(result)).toBe('continue');
        expect(mockPrefUpserts).toHaveLength(1);
        expect(mockPrefUpserts[0].row).toEqual({ customer_id: 'cust-1', contact_preference: preference });
        expect(mockPrefUpserts[0].conflict).toBe('customer_id');
        expect(mockPrefUpserts[0].patch).toMatchObject({ contact_preference: preference });
        expect(mockActivityInserts).toHaveLength(1);
        expect(mockActivityInserts[0]).toMatchObject({ lead_id: 'lead-1', description, performed_by: 'system' });
        // One automated text only, and the intake status is left alone.
        expect(mockSmsSends).toEqual([]);
        expect(mockCustomerUpdates).toEqual([]);
        expect(mockClassify).not.toHaveBeenCalled();
      },
    );
  }

  test('a longer or mixed reply falls through to the classifier exactly as before', async () => {
    const result = await handleIntakeReply(CUSTOMER(), 'call me after 5', {});
    expect(result).toEqual({ handled: false });
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
  });

  test('estimate_drafted (or no status) is untouched', async () => {
    expect(await handleIntakeReply(CUSTOMER('estimate_drafted'), 'call', {})).toEqual({ handled: false });
    expect(await handleIntakeReply({ ...CUSTOMER(), lead_intake_status: null }, 'call', {})).toEqual({ handled: false });
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
  });

  test('no lead row: preference still saved, no activity, still not consumed', async () => {
    mockLeadRow = null;
    const result = await handleIntakeReply(CUSTOMER(), 'text', {});
    expect(result).toEqual({ handled: false, callTextPreference: 'text' });
    expect(mockPrefUpserts).toHaveLength(1);
    expect(mockActivityInserts).toEqual([]);
  });

  test('a save failure is logged by customer id only and never blocks the reply', async () => {
    mockPrefFails = true;
    const result = await handleIntakeReply(CUSTOMER(), 'call', {});
    expect(result).toEqual({ handled: false, callTextPreference: 'call' });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const logged = mockLogger.error.mock.calls[0][0];
    expect(logged).toContain('cust-1');
    expect(logged).not.toContain('+1941');
    // The lead note is still attempted after the preference write failed.
    expect(mockActivityInserts).toHaveLength(1);
  });
});

describe('gate off', () => {
  test.each(['call', 'text', 'Text me'])('%j behaves exactly as before: nothing recorded, no preference returned', async (body) => {
    mockGateOn = false;
    const result = await handleIntakeReply(CUSTOMER(), body, {});
    expect(result).toEqual({ handled: false });
    expect(result).not.toHaveProperty('callTextPreference');
    expect(mockPrefUpserts).toEqual([]);
    expect(mockActivityInserts).toEqual([]);
    expect(mockSmsSends).toEqual([]);
    expect(mockCustomerUpdates).toEqual([]);
    // The reply still went to the classifier, as it did before the gate existed.
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });
});
