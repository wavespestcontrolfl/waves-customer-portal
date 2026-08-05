// The lead auto-reply (lead_auto_reply_biz) fires AT MOST ONCE per person,
// ever (owner ruling 2026-08-05). hasPriorLeadAutoReply is the dedup gate:
// any prior outbound auto_reply row to the same last-10 phone digits means
// skip. On a dedup-query error the guard FAILS CLOSED (reports "already
// sent") — a missed greeting is recoverable, a duplicate text is not.

jest.mock('../models/db', () => {
  const state = { first: async () => null };
  const chain = {
    where: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    first: jest.fn(() => state.first()),
  };
  const db = jest.fn(() => chain);
  db.raw = jest.fn();
  db.__state = state;
  db.__chain = chain;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { _test } = require('../routes/lead-webhook');
const { hasPriorLeadAutoReply } = _test;

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.first = async () => null;
});

describe('hasPriorLeadAutoReply', () => {
  test('no prior auto_reply row → false (send allowed)', async () => {
    await expect(hasPriorLeadAutoReply('+19415551234')).resolves.toBe(false);
    expect(db).toHaveBeenCalledWith('sms_log');
    expect(db.__chain.where).toHaveBeenCalledWith({ direction: 'outbound', message_type: 'auto_reply' });
  });

  test('prior auto_reply row exists → true (send skipped)', async () => {
    db.__state.first = async () => ({ id: 'abc', created_at: new Date('2026-05-01') });
    await expect(hasPriorLeadAutoReply('+19415551234')).resolves.toBe(true);
  });

  test('matches on the LAST 10 digits of the phone, ignoring +1 prefix', async () => {
    await hasPriorLeadAutoReply('+19415551234');
    expect(db.__chain.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10)"),
      ['9415551234'],
    );
  });

  test('dedup query throws → true (FAIL CLOSED, no duplicate risk) and warns', async () => {
    db.__state.first = async () => { throw new Error('connection reset'); };
    await expect(hasPriorLeadAutoReply('+19415551234')).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail closed'));
  });
});
