jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const logger = require('../services/logger');
const voiceRouter = require('../routes/twilio-voice-webhook');

function makeDbLike(rows) {
  const calls = {
    table: [],
    whereNull: [],
    whereRaw: [],
    orderBy: [],
    limit: [],
  };

  const builder = {
    whereNull: jest.fn((column) => {
      calls.whereNull.push(column);
      return builder;
    }),
    whereRaw: jest.fn((sql, bindings) => {
      calls.whereRaw.push({ sql, bindings });
      return builder;
    }),
    orderBy: jest.fn((column, direction) => {
      calls.orderBy.push([column, direction]);
      return builder;
    }),
    limit: jest.fn((value) => {
      calls.limit.push(value);
      return Promise.resolve(rows);
    }),
  };

  const dbLike = jest.fn((table) => {
    calls.table.push(table);
    return builder;
  });
  dbLike.calls = calls;
  return dbLike;
}

describe('twilio voice customer phone lookup', () => {
  const { customerPhoneLookupKey, findSingleCustomerByPhone, sanitizeVoiceProviderError } = voiceRouter._test;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses the same 10-digit lookup key for E.164, bare, and formatted NANP numbers', () => {
    expect(customerPhoneLookupKey('+19415551212')).toBe('9415551212');
    expect(customerPhoneLookupKey('9415551212')).toBe('9415551212');
    expect(customerPhoneLookupKey('(941) 555-1212')).toBe('9415551212');
    expect(customerPhoneLookupKey('1-941-555-1212')).toBe('9415551212');
  });

  test('matches a 10-digit stored customer phone when Twilio sends E.164', async () => {
    const customer = { id: 'customer-1', phone: '9415551212' };
    const dbLike = makeDbLike([customer]);

    await expect(findSingleCustomerByPhone(dbLike, '+19415551212')).resolves.toBe(customer);

    expect(dbLike.calls.table).toEqual(['customers']);
    expect(dbLike.calls.whereNull).toEqual(['deleted_at']);
    expect(dbLike.calls.whereRaw).toEqual([{
      sql: "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      bindings: ['9415551212', '19415551212'],
    }]);
    expect(dbLike.calls.orderBy).toEqual([['updated_at', 'desc']]);
    expect(dbLike.calls.limit).toEqual([2]);
  });

  test('matches an E.164 stored customer phone when Twilio sends formatted NANP', async () => {
    const customer = { id: 'customer-1', phone: '+19415551212' };
    const dbLike = makeDbLike([customer]);

    await expect(findSingleCustomerByPhone(dbLike, '(941) 555-1212')).resolves.toBe(customer);

    expect(dbLike.calls.whereRaw[0].bindings).toEqual(['9415551212', '19415551212']);
  });

  test('limits NANP lookups to stored 10-digit or leading-1 digit forms', async () => {
    const dbLike = makeDbLike([]);

    await expect(findSingleCustomerByPhone(dbLike, '+19415551212')).resolves.toBeNull();

    expect(dbLike.calls.whereRaw).toEqual([{
      sql: "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      bindings: ['9415551212', '19415551212'],
    }]);
  });

  test('does not auto-link when multiple customers share a caller phone', async () => {
    const dbLike = makeDbLike([
      { id: 'customer-1', phone: '+19415551212' },
      { id: 'customer-2', phone: '9415551212' },
    ]);

    await expect(findSingleCustomerByPhone(dbLike, '+19415551212')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customers share caller phone ***1212'));
  });

  test('preserves exact digit matching for non-NANP E.164 numbers', async () => {
    const customer = { id: 'customer-uk', phone: '+442079460958' };
    const dbLike = makeDbLike([customer]);

    expect(customerPhoneLookupKey('+44 20 7946 0958')).toBe('442079460958');
    await expect(findSingleCustomerByPhone(dbLike, '+44 20 7946 0958')).resolves.toBe(customer);

    expect(dbLike.calls.whereRaw).toEqual([{
      sql: "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?",
      bindings: ['442079460958'],
    }]);
  });

  test('scrubs phone numbers from lookup provider error text', () => {
    const message = 'fetch failed for https://lookups.twilio.com/v2/PhoneNumbers/%2B19415551212?Fields=caller_name and +19415551212';

    expect(sanitizeVoiceProviderError(message)).toBe(
      'fetch failed for https://lookups.twilio.com/v2/PhoneNumbers/[phone]?Fields=caller_name and [phone]'
    );
  });
});
