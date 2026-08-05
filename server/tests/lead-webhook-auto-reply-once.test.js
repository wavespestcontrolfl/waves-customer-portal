// The lead auto-reply (lead_auto_reply_biz) fires AT MOST ONCE per person,
// ever (owner ruling 2026-08-05). hasPriorLeadAutoReply is the dedup gate:
//   1. messaging_audit_log entry_point='lead_webhook_auto_reply' with a
//      non-null sent_at (template-specific — sms_log.message_type
//      'auto_reply' is shared with the public-quote booking invite and
//      cannot distinguish templates; blocked/failed attempts don't count).
//   2. Legacy leg: sms_log auto_reply rows STRICTLY BEFORE the first audit
//      row (2026-05-04T11:16:45Z) — 36 menu sends predate the audit table.
// On a dedup-query error the guard FAILS CLOSED (reports "already sent") —
// a missed greeting is recoverable, a duplicate text is not.

jest.mock('../models/db', () => {
  const state = { audit: async () => null, legacy: async () => null };
  const mkChain = (firstFn) => {
    const chain = {
      where: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      first: jest.fn(() => firstFn()),
    };
    return chain;
  };
  const chains = {};
  const db = jest.fn((table) => {
    const fn = table === 'messaging_audit_log' ? state.audit : state.legacy;
    chains[table] = mkChain(fn);
    return chains[table];
  });
  db.raw = jest.fn();
  db.__state = state;
  db.__chains = chains;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('../services/logger');
const { _test } = require('../routes/lead-webhook');
const { hasPriorLeadAutoReply } = _test;

const PHONE = '+19415551234';
const PHONE_HASH = crypto.createHash('sha256').update(PHONE, 'utf8').digest('hex');

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.audit = async () => null;
  db.__state.legacy = async () => null;
});

describe('hasPriorLeadAutoReply', () => {
  test('no audit hit, no legacy hit → false (send allowed)', async () => {
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(false);
    expect(db).toHaveBeenCalledWith('messaging_audit_log');
    expect(db).toHaveBeenCalledWith('sms_log');
  });

  test('audit row for this entry point and phone hash → true (send skipped)', async () => {
    db.__state.audit = async () => ({ id: 'a1' });
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    const audit = db.__chains['messaging_audit_log'];
    expect(audit.where).toHaveBeenCalledWith({ entry_point: 'lead_webhook_auto_reply', to_hash: PHONE_HASH });
    expect(audit.whereNotNull).toHaveBeenCalledWith('sent_at');
    // Audit hit short-circuits — the legacy sms_log leg is never consulted.
    expect(db).not.toHaveBeenCalledWith('sms_log');
  });

  test('legacy pre-cutover sms_log row → true (send skipped)', async () => {
    db.__state.legacy = async () => ({ id: 's1' });
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    const legacy = db.__chains['sms_log'];
    expect(legacy.where).toHaveBeenCalledWith({ direction: 'outbound', message_type: 'auto_reply' });
    // The legacy leg is FROZEN to rows before the audit cutover — this is
    // what keeps post-cutover quote-wizard sends (which share the
    // 'auto_reply' type) from suppressing a first-time menu send.
    expect(legacy.where).toHaveBeenCalledWith('created_at', '<', new Date('2026-05-04T11:16:45Z'));
    expect(legacy.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10)"),
      ['9415551234'],
    );
  });

  test('dedup query throws → true (FAIL CLOSED, no duplicate risk) and warns', async () => {
    db.__state.audit = async () => { throw new Error('connection reset'); };
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail closed'));
  });

  test('accepts a transaction handle and runs both legs on it', async () => {
    const state = { audit: async () => null, legacy: async () => null };
    const calls = [];
    const mkChain = (firstFn) => {
      const chain = {
        where: jest.fn(() => chain),
        whereNotNull: jest.fn(() => chain),
        whereRaw: jest.fn(() => chain),
        first: jest.fn(() => firstFn()),
      };
      return chain;
    };
    const trx = jest.fn((table) => { calls.push(table); return mkChain(table === 'messaging_audit_log' ? state.audit : state.legacy); });
    await expect(hasPriorLeadAutoReply(PHONE, trx)).resolves.toBe(false);
    expect(calls).toEqual(['messaging_audit_log', 'sms_log']);
    expect(db).not.toHaveBeenCalled();
  });
});
