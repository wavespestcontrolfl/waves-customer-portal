/**
 * Shared-phone text link (owner 2026-10-10, "link text"; always on since 2026-10-31).
 *
 * Two or more customer rows share the sender's phone. The text attaches to the
 * ONE account marked sms_primary_for_shared_phone; no mark or two marks stay
 * unlinked (no guessing). All names and numbers here are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { rows: [], limits: [], throwOnSelect: false };

jest.mock('../models/db', () => {
  const build = () => {
    const query = {};
    for (const method of ['whereNull', 'whereRaw', 'select', 'orderBy']) {
      query[method] = (...args) => {
        // The mark query has no select(); its first builder call after the mark predicate is whereRaw.
        if ((method === 'select' || (method === 'whereRaw' && query._markedOnly)) && mockState.throwOnSelect) throw new Error('lookup failed');
        return query;
      };
    }
    // The second (mark) query carries where({ sms_primary_for_shared_phone: true }).
    query.where = (cond) => { if (cond && cond.sms_primary_for_shared_phone === true) query._markedOnly = true; return query; };
    query.limit = async (n) => {
      mockState.limits.push(n);
      const rows = query._markedOnly ? mockState.rows.filter((r) => r.sms_primary_for_shared_phone === true) : mockState.rows;
      return rows.slice(0, n);
    };
    return query;
  };
  const db = jest.fn(() => build());
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});

const logger = require('../services/logger');
const { findSingleCustomerByPhone } = require('../routes/twilio-webhook')._internals;

const PHONE = '+19415550100';

function row(id, extra = {}) {
  return {
    id,
    phone: PHONE,
    updated_at: '2026-10-01T12:00:00Z',
    sms_primary_for_shared_phone: false,
    shared_phone_last_sms_at: null,
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.rows = [];
  mockState.limits = [];
  mockState.throwOnSelect = false;
});

describe('findSingleCustomerByPhone with a shared phone', () => {
  test('a single match links without the second query', async () => {
    mockState.rows = [row('a')];
    expect((await findSingleCustomerByPhone(PHONE)).id).toBe('a');
    expect(mockState.limits).toEqual([2]);
  });

  test('one account marked: that account is linked', async () => {
    mockState.rows = [
      row('a', { shared_phone_last_sms_at: '2026-10-09T12:00:00Z' }),
      row('b', { sms_primary_for_shared_phone: true, shared_phone_last_sms_at: '2026-09-01T12:00:00Z' }),
    ];
    expect((await findSingleCustomerByPhone(PHONE)).id).toBe('b');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shared-phone: primary mark'));
  });

  test('marked: the linked row carries a NON-enumerable sharedPhoneLinked tag (never written or serialized)', async () => {
    mockState.rows = [row('a'), row('b', { sms_primary_for_shared_phone: true })];
    const picked = await findSingleCustomerByPhone(PHONE);
    expect(picked.sharedPhoneLinked).toBe(true);
    expect(Object.keys(picked)).not.toContain('sharedPhoneLinked');
    expect({ ...picked }).not.toHaveProperty('sharedPhoneLinked');
    expect(JSON.parse(JSON.stringify(picked))).not.toHaveProperty('sharedPhoneLinked');
  });

  test('a single match (no mark path) carries no tag', async () => {
    mockState.rows = [row('a')];
    expect((await findSingleCustomerByPhone(PHONE)).sharedPhoneLinked).toBeUndefined();
  });

  test('none marked: stays unlinked, no guess from texts or updated_at', async () => {
    mockState.rows = [
      row('a', { updated_at: '2026-10-09T12:00:00Z', shared_phone_last_sms_at: '2026-10-05T12:00:00Z' }),
      row('b', { updated_at: '2026-08-01T12:00:00Z' }),
    ];
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no primary mark'));
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('two accounts marked: ambiguous, stays unlinked with a warning', async () => {
    mockState.rows = [
      row('a', { sms_primary_for_shared_phone: true }),
      row('b', { sms_primary_for_shared_phone: true }),
    ];
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous'));
  });

  test('lookup failure: stays unlinked', async () => {
    mockState.rows = [row('a'), row('b')];
    mockState.throwOnSelect = true;
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shared-phone lookup failed'), expect.anything());
  });
});
