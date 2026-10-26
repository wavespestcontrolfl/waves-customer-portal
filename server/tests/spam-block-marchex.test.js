jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
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
  test('BLOCK verdict shadow-logs, records a marchex_shadow row, and allows the call', async () => {
    const { inserts } = makeDb();

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

  test('PASS verdict allows the call', async () => {
    makeDb();

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('PASS') });

    expect(result).toEqual({ blocked: false });
  });

  test('shallow result nesting (result.recommendation) also parses', async () => {
    makeDb();

    const result = await checkInboundBlock({
      ...CALL,
      addOns: marchexAddOns('BLOCK', { shallow: true }),
    });

    expect(result).toEqual({ blocked: false });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('would block'));
  });

  test('malformed AddOns payload fails open', async () => {
    makeDb();

    const result = await checkInboundBlock({ ...CALL, addOns: '{not json' });

    expect(result).toEqual({ blocked: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unparseable AddOns'));
  });

  test('missing AddOns param allows the call', async () => {
    makeDb();

    const result = await checkInboundBlock({ ...CALL });

    expect(result).toEqual({ blocked: false });
  });

  test('sms channel never consults Marchex', async () => {
    const { inserts } = makeDb();

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

    const result = await checkInboundBlock({ ...CALL, addOns: marchexAddOns('PASS') });

    expect(result.blocked).toBe(true);
    expect(result.blockType).toBe('hard_block');
    expect(inserts[0].row.block_type).toBe('hard_block');
  });

  // Blocked calls return TwiML before the webhook's call_log insert, so the
  // spam evidence for the calls most worth auditing must ride the
  // blocked_call_attempts row itself (Codex P2 on #2556).
  describe('signals capture on blocked-attempt audit rows', () => {
    const SIGNALS = { stir_verstat: 'TN-Validation-Passed-A', addons: { status: 'successful' } };

    test('manual block persists the signals JSON on the audit row', async () => {
      const { inserts } = makeDb({ manualBlock: { block_type: 'hard_block' } });

      await checkInboundBlock({ ...CALL, signals: SIGNALS });

      expect(inserts).toHaveLength(1);
      expect(JSON.parse(inserts[0].row.signals)).toEqual(SIGNALS);
    });

    test('marchex shadow row persists the signals JSON', async () => {
      const { inserts } = makeDb();

      await checkInboundBlock({ ...CALL, addOns: marchexAddOns('BLOCK'), signals: SIGNALS });

      expect(inserts).toHaveLength(1);
      expect(inserts[0].row.block_type).toBe('marchex_shadow');
      expect(JSON.parse(inserts[0].row.signals)).toEqual(SIGNALS);
    });

    test('omitted signals store NULL (sms caller passes nothing)', async () => {
      const { inserts } = makeDb({ manualBlock: { block_type: 'hard_block' } });

      await checkInboundBlock({ ...CALL, channel: 'sms' });

      expect(inserts).toHaveLength(1);
      expect(inserts[0].row.signals).toBeNull();
    });
  });
});
