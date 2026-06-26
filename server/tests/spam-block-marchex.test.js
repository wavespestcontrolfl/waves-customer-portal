jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { checkInboundBlock } = require('../middleware/spam-block');

function makeDb({ manualBlock = null } = {}) {
  const inserts = [];
  db.mockImplementation((table) => ({
    where() {
      return this;
    },
    first: async () => (table === 'blocked_numbers' ? manualBlock : null),
    insert(row) {
      inserts.push({ table, row });
      return Promise.resolve();
    },
  }));
  return { inserts };
}

function marchexAddOns(recommendation, { shallow = false } = {}) {
  const verdict = { recommendation, reason: 'test-reason' };
  return JSON.stringify({
    status: 'successful',
    results: {
      marchex_cleancall: {
        status: 'successful',
        result: shallow ? verdict : { result: verdict },
      },
    },
  });
}

const CALL = { from: '+15555550100', to: '+19412975749', channel: 'voice', twilioSid: 'CA_test' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('spam-block Marchex Clean Call integration', () => {
  test('gate off: BLOCK verdict shadow-logs, records a marchex_shadow row, and allows the call', async () => {
    const { inserts } = makeDb();
    isEnabled.mockReturnValue(false);

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('BLOCK') });

    expect(result).toEqual({ blocked: false });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('would block'));
    // Shadow verdict is persisted (not blocked) so accuracy can be judged later.
    expect(inserts).toEqual([
      {
        table: 'blocked_call_attempts',
        row: expect.objectContaining({
          number: CALL.from,
          our_endpoint_id: CALL.to,
          channel: 'voice',
          block_type: 'marchex_shadow',
          twilio_sid: 'CA_test',
        }),
      },
    ]);
  });

  test('gate on: BLOCK verdict rejects and writes a marchex_auto audit row', async () => {
    const { inserts } = makeDb();
    isEnabled.mockImplementation((gate) => gate === 'marchexAutoBlock');

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('BLOCK') });

    expect(result.blocked).toBe(true);
    expect(result.blockType).toBe('marchex_auto');
    expect(result.twiml).toContain('<Reject');
    expect(inserts).toEqual([
      {
        table: 'blocked_call_attempts',
        row: expect.objectContaining({
          number: CALL.from,
          our_endpoint_id: CALL.to,
          channel: 'voice',
          block_type: 'marchex_auto',
          twilio_sid: 'CA_test',
        }),
      },
    ]);
  });

  test('gate on: PASS verdict allows the call', async () => {
    makeDb();
    isEnabled.mockReturnValue(true);

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('PASS') });

    expect(result).toEqual({ blocked: false });
  });

  test('shallow result nesting (result.recommendation) also parses', async () => {
    makeDb();
    isEnabled.mockReturnValue(true);

    const result = await checkInboundBlock({
      ...CALL,
      addOns: marchexAddOns('BLOCK', { shallow: true }),
    });

    expect(result.blocked).toBe(true);
    expect(result.blockType).toBe('marchex_auto');
  });

  test('malformed AddOns payload fails open', async () => {
    makeDb();
    isEnabled.mockReturnValue(true);

    const result = await checkInboundBlock({ ...CALL, addOns: '{not json' });

    expect(result).toEqual({ blocked: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unparseable AddOns'));
  });

  test('missing AddOns param allows the call', async () => {
    makeDb();
    isEnabled.mockReturnValue(true);

    const result = await checkInboundBlock({ ...CALL });

    expect(result).toEqual({ blocked: false });
  });

  test('sms channel never consults Marchex', async () => {
    const { inserts } = makeDb();
    isEnabled.mockReturnValue(true);

    const result = await checkInboundBlock({
      ...CALL,
      channel: 'sms',
      addOns: marchexAddOns('BLOCK'),
    });

    expect(result).toEqual({ blocked: false });
    expect(inserts).toHaveLength(0);
  });

  test('manual hard_block still wins regardless of Marchex', async () => {
    const { inserts } = makeDb({ manualBlock: { block_type: 'hard_block' } });
    isEnabled.mockReturnValue(false);

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('PASS') });

    expect(result.blocked).toBe(true);
    expect(result.blockType).toBe('hard_block');
    expect(inserts[0].row.block_type).toBe('hard_block');
  });
});
