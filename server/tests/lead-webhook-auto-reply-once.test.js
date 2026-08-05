// The lead auto-reply (lead_auto_reply_biz) fires AT MOST ONCE per person,
// ever (owner ruling 2026-08-05). hasPriorLeadAutoReply is the dedup gate,
// checked in order:
//   0. lead_auto_reply_sends — durable marker this route writes inside the
//      send's advisory-lock transaction (survives persistAudit failures).
//   1. messaging_audit_log entry_point='lead_webhook_auto_reply' with a
//      non-null sent_at AND a real Twilio SID (SM/MM) — gate-blocked /
//      template-disabled / owner-silence rows carry sentinel provider ids
//      and never reached the customer, so they must not suppress a later
//      real send. The sms_log 'auto_reply' type is shared with the
//      public-quote booking invite and cannot distinguish templates.
//   2. Legacy leg: sms_log auto_reply rows STRICTLY BEFORE the first audit
//      row (2026-05-04T11:16:45Z) — 36 menu sends predate the audit table.
// On a dedup-query error the guard FAILS CLOSED (reports "already sent") —
// a missed greeting is recoverable, a duplicate text is not.

jest.mock('../models/db', () => {
  const state = {
    marker: async () => null,
    audit: async () => null,
    legacy: async () => null,
  };
  const pick = (table) =>
    table === 'lead_auto_reply_sends' ? state.marker
      : table === 'messaging_audit_log' ? state.audit
        : state.legacy;
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
    chains[table] = mkChain(pick(table));
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
  db.__state.marker = async () => null;
  db.__state.audit = async () => null;
  db.__state.legacy = async () => null;
});

describe('hasPriorLeadAutoReply', () => {
  test('no marker, no audit hit, no legacy hit → false (send allowed)', async () => {
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(false);
    expect(db).toHaveBeenCalledWith('lead_auto_reply_sends');
    expect(db).toHaveBeenCalledWith('messaging_audit_log');
    expect(db).toHaveBeenCalledWith('sms_log');
  });

  test('durable marker row → true, later legs never consulted', async () => {
    db.__state.marker = async () => ({ phone_digits: '9415551234' });
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    expect(db.__chains['lead_auto_reply_sends'].where).toHaveBeenCalledWith({ phone_digits: '9415551234' });
    expect(db).not.toHaveBeenCalledWith('messaging_audit_log');
    expect(db).not.toHaveBeenCalledWith('sms_log');
  });

  test('audit row for this entry point and phone hash → true (send skipped)', async () => {
    db.__state.audit = async () => ({ id: 'a1' });
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    const audit = db.__chains['messaging_audit_log'];
    expect(audit.where).toHaveBeenCalledWith({ entry_point: 'lead_webhook_auto_reply', to_hash: PHONE_HASH });
    expect(audit.whereNotNull).toHaveBeenCalledWith('sent_at');
    // Sentinel provider ids (gate-blocked / template-disabled /
    // owner-silence) record sent_at without any text reaching the
    // customer — the audit leg must demand a REAL Twilio SID.
    expect(audit.whereRaw).toHaveBeenCalledWith("provider_message_id ~ '^(SM|MM)'");
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
    db.__state.marker = async () => { throw new Error('connection reset'); };
    await expect(hasPriorLeadAutoReply(PHONE)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail closed'));
  });

  test('accepts a transaction handle and runs all legs on it', async () => {
    const calls = [];
    const mkChain = () => {
      const chain = {
        where: jest.fn(() => chain),
        whereNotNull: jest.fn(() => chain),
        whereRaw: jest.fn(() => chain),
        first: jest.fn(async () => null),
      };
      return chain;
    };
    const trx = jest.fn((table) => { calls.push(table); return mkChain(); });
    await expect(hasPriorLeadAutoReply(PHONE, trx)).resolves.toBe(false);
    expect(calls).toEqual(['lead_auto_reply_sends', 'messaging_audit_log', 'sms_log']);
    expect(db).not.toHaveBeenCalled();
  });
});
