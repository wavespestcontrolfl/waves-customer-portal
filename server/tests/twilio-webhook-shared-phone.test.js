/**
 * GATE_SMS_SHARED_PHONE_LINK (owner 2026-10-10, "link text").
 *
 * Two or more customer rows share the sender's phone. Gate off: the text stays
 * unlinked, as before. Gate on: it attaches to the ONE account marked
 * sms_primary_for_shared_phone; no mark or two marks stay unlinked (no guessing).
 * All names and numbers here are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { rows: [], limits: [], throwOnSelect: false };

jest.mock('../models/db', () => {
  const build = () => {
    const query = {};
    for (const method of ['whereNull', 'whereRaw', 'select', 'orderBy']) {
      query[method] = (...args) => {
        // The gate-on query has no select(); its first builder call after the mark predicate is whereRaw.
        if ((method === 'select' || (method === 'whereRaw' && query._markedOnly)) && mockState.throwOnSelect) throw new Error('lookup failed');
        return query;
      };
    }
    // The second (gate-on) query carries where({ sms_primary_for_shared_phone: true }).
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

const GATE = 'GATE_SMS_SHARED_PHONE_LINK';
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

let savedGate;
beforeEach(() => {
  jest.clearAllMocks();
  savedGate = process.env[GATE];
  delete process.env[GATE];
  mockState.rows = [];
  mockState.limits = [];
  mockState.throwOnSelect = false;
});
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
});

describe('findSingleCustomerByPhone with a shared phone', () => {
  test('gate off: two matches stay unlinked, one cheap query, warning as before', async () => {
    mockState.rows = [row('a'), row('b')];
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(mockState.limits).toEqual([2]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('share sender phone'));
  });

  test('gate off: a single match still links', async () => {
    mockState.rows = [row('a')];
    expect((await findSingleCustomerByPhone(PHONE)).id).toBe('a');
  });

  test('gate on: a single match still links without the second query', async () => {
    process.env[GATE] = 'true';
    mockState.rows = [row('a')];
    expect((await findSingleCustomerByPhone(PHONE)).id).toBe('a');
    expect(mockState.limits).toEqual([2]);
  });

  test('gate on, one account marked: that account is linked', async () => {
    process.env[GATE] = 'true';
    mockState.rows = [
      row('a', { shared_phone_last_sms_at: '2026-10-09T12:00:00Z' }),
      row('b', { sms_primary_for_shared_phone: true, shared_phone_last_sms_at: '2026-09-01T12:00:00Z' }),
    ];
    expect((await findSingleCustomerByPhone(PHONE)).id).toBe('b');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('shared-phone: primary mark'));
  });

  test('gate on, none marked: stays unlinked, no guess from texts or updated_at', async () => {
    process.env[GATE] = 'true';
    mockState.rows = [
      row('a', { updated_at: '2026-10-09T12:00:00Z', shared_phone_last_sms_at: '2026-10-05T12:00:00Z' }),
      row('b', { updated_at: '2026-08-01T12:00:00Z' }),
    ];
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no primary mark'));
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('gate on, two accounts marked: ambiguous, stays unlinked with a warning', async () => {
    process.env[GATE] = 'true';
    mockState.rows = [
      row('a', { sms_primary_for_shared_phone: true }),
      row('b', { sms_primary_for_shared_phone: true }),
    ];
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous'));
  });

  test('gate on, lookup failure: stays unlinked', async () => {
    process.env[GATE] = 'true';
    mockState.rows = [row('a'), row('b')];
    mockState.throwOnSelect = true;
    expect(await findSingleCustomerByPhone(PHONE)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('shared-phone lookup failed'), expect.anything());
  });
});
