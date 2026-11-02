// GATE_ESTIMATE_FOLLOWUP_EMAIL_REPLY_PAUSE (owner 2026-11-02, option A): an
// inbound email from the customer pauses the estimate follow-up emails the way
// an inbound text already does. Mocked unit suite: the db builder records every
// table it is asked for and every predicate, and resolves per-table rows.

jest.mock('../models/db', () => {
  const calls = [];
  const mockDb = jest.fn((table) => {
    const rec = { table, wheres: [], raws: [], groupRaws: [], groupWheres: [] };
    calls.push(rec);
    const q = {};
    const chain = (name, store) => jest.fn((...args) => { rec[store].push([name, ...args]); return q; });
    q.join = jest.fn(() => q);
    q.first = jest.fn(() => q);
    q.orderBy = jest.fn((...a) => { rec.orderBy = a; return q; });
    q.limit = jest.fn((n) => { rec.limit = n; return q; });
    q.select = jest.fn((...a) => { rec.select = a; return q; });
    q.where = jest.fn((...args) => {
      if (typeof args[0] === 'function') { args[0].call({ whereNull: () => ({ orWhere: () => ({}) }) }, { whereNull() { return this; }, orWhere() { return this; } }); return q; }
      rec.wheres.push(args); return q;
    });
    q.whereRaw = chain('whereRaw', 'raws');
    q.andWhere = jest.fn((fn) => {
      const g = {
        where: (...a) => { rec.groupWheres.push(['where', ...a]); return g; },
        orWhere: (...a) => { rec.groupWheres.push(['orWhere', ...a]); return g; },
        orWhereRaw: (...a) => { rec.groupRaws.push(['orWhereRaw', ...a]); return g; },
      };
      if (typeof fn === 'function') fn.call(g);
      else rec.wheres.push([fn]);
      return q;
    });
    q.then = (resolve, reject) => {
      let v;
      try {
        v = typeof mockDb._rows === 'function' ? mockDb._rows(table, rec) : null;
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
      return Promise.resolve(v).then(resolve, reject);
    };
    return q;
  });
  mockDb._calls = calls;
  mockDb._rows = null;
  mockDb.raw = jest.fn((x) => x);
  return mockDb;
});
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../config/twilio-numbers', () => ({ getOutboundNumber: jest.fn(() => '+19413180000') }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true), // an every-key-true mock must NOT switch the new gate on
  estimateFollowupEmailReplyPauseLive: jest.fn(() => false),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: jest.fn((s) => s),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The real aligned-auth reader decides; only its module's Gmail client is stubbed.
jest.mock('../services/email/gmail-client', () => ({}));

const db = require('../models/db');
const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { hasRepliedRecently } = require('../services/estimate-follow-up')._private;

const CUSTOMER_EST = {
  id: 'est-1',
  customer_id: 'cust-1',
  customer_phone: '+19415550123',
  customer_email: 'Pat@Example.com ',
};
const LEAD_EST = { id: 'est-2', customer_id: null, customer_phone: null, customer_email: 'Lead@Example.com' };

const emailCalls = () => db._calls.filter((c) => c.table === 'emails');

// Gmail Authentication-Results values as the sync stores them.
const ALIGNED = (domain) => `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass (google.com: domain designates 192.0.2.1 as permitted sender) smtp.mailfrom=reply@${domain}`;
const SPOOFED = 'mx.google.com; dkim=pass header.i=@attacker.example header.s=s1; spf=fail (google.com: domain does not designate) smtp.mailfrom=bounce@attacker.example';
const CUSTOMER_REPLY = { from_address: 'pat@example.com', authentication_results: ALIGNED('example.com') };
const LEAD_REPLY = { from_address: 'lead@example.com', authentication_results: ALIGNED('example.com') };

function setGate(on) {
  featureGates.estimateFollowupEmailReplyPauseLive.mockReturnValue(on);
}

// rows: { messages: row|null, emails: rows[]|Error }
function setRows(rows) {
  db._rows = (table) => {
    const v = rows[table];
    if (v instanceof Error) throw v;
    return v || null;
  };
}

describe('hasRepliedRecently email arm (GATE_ESTIMATE_FOLLOWUP_EMAIL_REPLY_PAUSE)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._calls.length = 0;
    db._rows = null;
    setGate(false);
  });

  test('gate off: the emails table is never queried, even for a customer who emailed', async () => {
    setRows({ emails: { id: 'e1' } });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(0);
    expect(await hasRepliedRecently(LEAD_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(0);
  });

  test('a mock that answers true to every isEnabled key does not switch the gate on', async () => {
    setRows({ emails: { id: 'e1' } });
    await hasRepliedRecently(CUSTOMER_EST);
    expect(emailCalls()).toHaveLength(0);
  });

  test('gate on + authenticated inbound email linked by customer_id inside the window = true', async () => {
    setGate(true);
    setRows({ emails: [CUSTOMER_REPLY] });
    const before = Date.now();
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(true);
    const [c] = emailCalls();
    // newest rows first, bounded, reading the sender + its Authentication-Results
    expect(c.orderBy).toEqual(['emails.received_at', 'desc']);
    expect(c.limit).toBe(25);
    expect(c.select).toEqual(['emails.from_address', 'emails.authentication_results']);
    expect(c.wheres[0][0]).toBe('emails.received_at');
    expect(c.wheres[0][1]).toBe('>=');
    // 14-day window, same as the text arm
    expect(before - c.wheres[0][2].getTime()).toBeGreaterThanOrEqual(14 * 86400000 - 1000);
    expect(before - c.wheres[0][2].getTime()).toBeLessThan(14 * 86400000 + 5000);
    expect(c.groupWheres).toContainEqual(['orWhere', 'emails.customer_id', 'cust-1']);
    // and the from_address arm, lowercased and trimmed
    expect(c.groupRaws).toContainEqual(['orWhereRaw', 'LOWER(emails.from_address) = ?', ['pat@example.com']]);
  });

  test('a spoofed From never counts: the sender did not authenticate as its domain', async () => {
    setGate(true);
    setRows({ emails: [{ from_address: 'lead@example.com', authentication_results: SPOOFED }] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(1);
  });

  test('a row with no Authentication-Results never counts', async () => {
    setGate(true);
    setRows({ emails: [{ from_address: 'pat@example.com', authentication_results: null }] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
  });

  test('one authenticated reply among spoofed rows counts', async () => {
    setGate(true);
    setRows({ emails: [{ from_address: 'lead@example.com', authentication_results: SPOOFED }, LEAD_REPLY] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(true);
  });

  test('a lead (no customer_id) matches by from_address only', async () => {
    setGate(true);
    setRows({ emails: [LEAD_REPLY] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(true);
    const [c] = emailCalls();
    expect(c.groupWheres).toHaveLength(0);
    expect(c.groupRaws).toEqual([['orWhereRaw', 'LOWER(emails.from_address) = ?', ['lead@example.com']]]);
  });

  test('no email in the window = false', async () => {
    setGate(true);
    setRows({ emails: [] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(1);
  });

  test('a Gmail SENT row never counts: the query excludes personSentFilter rows (NULL labels kept)', async () => {
    setGate(true);
    setRows({ emails: [] });
    await hasRepliedRecently(CUSTOMER_EST);
    const [c] = emailCalls();
    expect(c.raws).toHaveLength(1);
    expect(c.raws[0][1]).toBe(
      "NOT COALESCE((jsonb_exists(emails.label_ids::jsonb, 'SENT') AND NOT jsonb_exists(emails.label_ids::jsonb, 'INBOX')), false)",
    );
  });

  test('one of our own addresses never matches by from_address', async () => {
    setGate(true);
    setRows({ emails: [CUSTOMER_REPLY] });
    // Lead with an internal address: no usable arm, no query, false.
    expect(await hasRepliedRecently({ ...LEAD_EST, customer_email: 'contact@wavespestcontrol.com' })).toBe(false);
    expect(emailCalls()).toHaveLength(0);
    // Customer whose estimate email is internal: customer_id arm only.
    expect(await hasRepliedRecently({ ...CUSTOMER_EST, customer_email: 'Contact@WavesPestControl.com' })).toBe(true);
    const [c] = emailCalls();
    expect(c.groupRaws).toHaveLength(0);
    expect(c.groupWheres).toEqual([['orWhere', 'emails.customer_id', 'cust-1']]);
  });

  test('a lead with no usable email and no phone is false without any email query', async () => {
    setGate(true);
    setRows({ emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently({ id: 'x', customer_id: null, customer_phone: null, customer_email: '  ' })).toBe(false);
    expect(emailCalls()).toHaveLength(0);
  });

  test('the SMS arm is checked first: a text short-circuits the email query', async () => {
    setGate(true);
    setRows({ messages: { id: 'm1' }, emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(true);
    expect(emailCalls()).toHaveLength(0);
  });

  test('email-read failure fails OPEN on the cron path', async () => {
    setGate(true);
    setRows({ emails: new Error('emails down') });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('emails down'));
  });

  test('email-read failure THROWS on the replay path', async () => {
    setGate(true);
    setRows({ emails: new Error('emails down') });
    await expect(hasRepliedRecently(CUSTOMER_EST, 14, { throwOnError: true })).rejects.toThrow('emails down');
  });

  test('gate off: an emails failure is unreachable (replay path still only reads texts)', async () => {
    setRows({ emails: new Error('emails down') });
    await expect(hasRepliedRecently(CUSTOMER_EST, 14, { throwOnError: true })).resolves.toBe(false);
  });
});
