// Estimate follow-up email reply pause (owner 2026-11-02, option A): an
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
    q.whereNot = chain('whereNot', 'wheres');
    q.whereNotNull = chain('whereNotNull', 'wheres');
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
// A bare-object mock, as in many suites: no estimateReplyPauseSinceEstimateLive here means the gate is off. The
// since-estimate describe below sets the reader per test.
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
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
const { hasRepliedRecently, hasRepliedSince } = require('../services/estimate-follow-up')._private;

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
// The quoted-local-part forgery from email-auth-strict.test.js: the permissive
// parser reads a fake dkim=pass for example.com out of the attacker's MAIL FROM.
const FORGED = 'mx.google.com; dkim=none; spf=pass (google.com: domain of "x dkim=pass header.d=example.com y"@evil.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="x dkim=pass header.d=example.com y"@evil.example';
const LEAD_REPLY = { from_address: 'lead@example.com', authentication_results: ALIGNED('example.com') };

// rows: { messages: row|null, customers: row|null|Error, emails: rows[]|Error }
function setRows(rows) {
  db._rows = (table) => {
    const v = rows[table];
    if (v instanceof Error) throw v;
    return v || null;
  };
}

describe('hasRepliedRecently email arm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._calls.length = 0;
    db._rows = null;
  });

  test('authenticated email from the customer\'s address inside the window = true', async () => {
    setRows({ customers: { email: 'pat@example.com' }, emails: [CUSTOMER_REPLY] });
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
    // the estimate's address and the address on file, lowercased, trimmed, deduped
    expect(c.raws).toContainEqual(['whereRaw', 'LOWER(emails.from_address) = ANY(?)', [['pat@example.com']]]);
  });

  test('customer_id is never sender proof: the query keys on the expected addresses only', async () => {
    setRows({ customers: { email: 'owner@example.org' }, emails: [] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    const [c] = emailCalls();
    expect(JSON.stringify(c.wheres)).not.toContain('customer_id');
    expect(c.groupWheres).toHaveLength(0);
    expect(c.raws).toContainEqual(['whereRaw', 'LOWER(emails.from_address) = ANY(?)', [['pat@example.com', 'owner@example.org']]]);
  });

  test('a spoofed From never counts: the sender did not authenticate as its domain', async () => {
    setRows({ emails: [{ from_address: 'lead@example.com', authentication_results: SPOOFED }] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(1);
  });

  test('a dkim=pass forged inside a quoted MAIL FROM never counts (strict reader)', async () => {
    setRows({ emails: [{ from_address: 'lead@example.com', authentication_results: FORGED }] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(false);
  });

  test('a row with no Authentication-Results never counts', async () => {
    setRows({ emails: [{ from_address: 'pat@example.com', authentication_results: null }] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
  });

  test('one authenticated reply among spoofed rows counts', async () => {
    setRows({ emails: [{ from_address: 'lead@example.com', authentication_results: SPOOFED }, LEAD_REPLY] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(true);
  });

  test('a lead (no customer_id) matches its estimate address only, with no customer read', async () => {
    setRows({ emails: [LEAD_REPLY] });
    expect(await hasRepliedRecently(LEAD_EST)).toBe(true);
    expect(db._calls.filter((x) => x.table === 'customers')).toHaveLength(0);
    const [c] = emailCalls();
    expect(c.raws).toContainEqual(['whereRaw', 'LOWER(emails.from_address) = ANY(?)', [['lead@example.com']]]);
  });

  test('no email in the window = false', async () => {
    setRows({ emails: [] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    expect(emailCalls()).toHaveLength(1);
  });

  test('a Gmail SENT row never counts: the query excludes personSentFilter rows (NULL labels kept)', async () => {
    setRows({ emails: [] });
    await hasRepliedRecently(CUSTOMER_EST);
    const [c] = emailCalls();
    expect(c.raws).toHaveLength(2);
    expect(c.raws[0][1]).toBe(
      "NOT COALESCE((jsonb_exists(emails.label_ids::jsonb, 'SENT') AND NOT jsonb_exists(emails.label_ids::jsonb, 'INBOX')), false)",
    );
  });

  test('one of our own addresses never counts as a reply address', async () => {
    setRows({ customers: { email: 'pat@example.com' }, emails: [CUSTOMER_REPLY] });
    // Lead with an internal address: no usable address, no email query, false.
    expect(await hasRepliedRecently({ ...LEAD_EST, customer_email: 'contact@wavespestcontrol.com' })).toBe(false);
    expect(emailCalls()).toHaveLength(0);
    // Customer whose estimate went to an internal address: the address on file only.
    expect(await hasRepliedRecently({ ...CUSTOMER_EST, customer_email: 'Contact@WavesPestControl.com' })).toBe(true);
    const [c] = emailCalls();
    expect(c.raws).toContainEqual(['whereRaw', 'LOWER(emails.from_address) = ANY(?)', [['pat@example.com']]]);
    // Both internal: nothing to match, no email query.
    db._calls.length = 0;
    setRows({ customers: { email: 'contact@wavespestcontrol.com' }, emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently({ ...CUSTOMER_EST, customer_phone: null, customer_email: 'contact@wavespestcontrol.com' })).toBe(false);
    expect(emailCalls()).toHaveLength(0);
  });

  test('a lead with no usable email and no phone is false without any email query', async () => {
    setRows({ emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently({ id: 'x', customer_id: null, customer_phone: null, customer_email: '  ' })).toBe(false);
    expect(emailCalls()).toHaveLength(0);
  });

  test('the SMS arm is checked first: a text short-circuits the email query', async () => {
    setRows({ messages: { id: 'm1' }, emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(true);
    expect(emailCalls()).toHaveLength(0);
  });

  test('email-read failure fails OPEN on the cron path', async () => {
    setRows({ emails: Object.assign(new Error('select ... where from_address = any(pat@example.com) - emails down'), { code: '57P01' }) });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    // the estimate id and the error code only: never the message, which carries the bindings
    expect(logger.warn).toHaveBeenCalledWith('[est-followup] reply-pause check skipped for estimate est-1: 57P01');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('pat@example.com');
  });

  test('a failed customer-address read fails open on cron and throws on replay', async () => {
    setRows({ customers: new Error('customers down'), emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedRecently(CUSTOMER_EST)).toBe(false);
    await expect(hasRepliedRecently(CUSTOMER_EST, 14, { throwOnError: true })).rejects.toThrow('reply-pause check failed');
  });

  test('email-read failure THROWS on the replay path', async () => {
    setRows({ emails: new Error('select ... any(pat@example.com) - emails down') });
    const err = await hasRepliedRecently(CUSTOMER_EST, 14, { throwOnError: true }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // fails closed, and the thrown message carries no bindings (the replay caller logs it)
    expect(err.message).toBe('reply-pause check failed: Error');
    expect(err.message).not.toContain('pat@example.com');
  });
});

// hasRepliedSince: the same two arms from an explicit instant (the 2-hour estimate_sent stop, automation-runner.js);
// hasRepliedRecently is its "last N days" wrapper.
describe('hasRepliedSince', () => {
  const CUTOFF = new Date('2026-11-20T12:00:00Z');
  beforeEach(() => {
    jest.clearAllMocks();
    db._calls.length = 0;
    db._rows = null;
  });

  test('text arm: an inbound text since the cutoff = true, and the query reads from that instant', async () => {
    setRows({ messages: { id: 'm1' } });
    expect(await hasRepliedSince(CUSTOMER_EST, CUTOFF)).toBe(true);
    const [c] = db._calls.filter((call) => call.table === 'messages');
    expect(c.wheres).toContainEqual(['messages.created_at', '>=', CUTOFF]);
    expect(emailCalls()).toHaveLength(0);
  });

  test('email arm: an authenticated email since the cutoff = true, and the query reads from that instant', async () => {
    setRows({ customers: { email: 'pat@example.com' }, emails: [CUSTOMER_REPLY] });
    expect(await hasRepliedSince(CUSTOMER_EST, CUTOFF)).toBe(true);
    const [c] = emailCalls();
    expect(c.wheres[0]).toEqual(['emails.received_at', '>=', CUTOFF]);
  });

  test('no reply since the cutoff = false', async () => {
    setRows({ customers: { email: 'pat@example.com' }, emails: [] });
    expect(await hasRepliedSince(CUSTOMER_EST, CUTOFF)).toBe(false);
  });

  test('a failed read fails open and logs only the error code', async () => {
    setRows({ messages: Object.assign(new Error('select ... +19415550123'), { code: '57P01' }) });
    expect(await hasRepliedSince(CUSTOMER_EST, CUTOFF)).toBe(false);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('57P01');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('19415550123');
  });
});

// The text arm's phone match: the estimate can hold the phone as staff typed it, while an inbound text's conversation
// holds Twilio's E.164 form. Before this, a lead-only estimate with a formatted number never matched its own reply.
describe('text arm: the stored phone and its E.164 form both match', () => {
  const CUTOFF = new Date('2026-11-20T12:00:00Z');
  const messagesCall = () => db._calls.find((call) => call.table === 'messages');
  beforeEach(() => {
    jest.clearAllMocks();
    db._calls.length = 0;
    db._rows = null;
  });

  test('a lead-only estimate with a formatted phone matches the E.164 conversation', async () => {
    setRows({ messages: { id: 'm1' } });
    const lead = { id: 'est-3', customer_id: null, customer_phone: '(941) 555-0123', customer_email: null };
    expect(await hasRepliedSince(lead, CUTOFF)).toBe(true);
    expect(messagesCall().groupWheres).toEqual([
      ['orWhere', 'conversations.contact_phone', '(941) 555-0123'],
      ['orWhere', 'conversations.contact_phone', '+19415550123'],
    ]);
  });

  test('a customer estimate keeps its customer match and adds each phone form once', async () => {
    setRows({ messages: { id: 'm1' } });
    expect(await hasRepliedSince(CUSTOMER_EST, CUTOFF)).toBe(true);
    expect(messagesCall().groupWheres).toEqual([
      ['where', 'conversations.customer_id', 'cust-1'],
      ['orWhere', 'conversations.contact_phone', '+19415550123'],
    ]);
  });

  test('a phone that cannot be read as a US number is matched as stored only', async () => {
    setRows({ messages: null });
    const lead = { id: 'est-4', customer_id: null, customer_phone: '555-0123', customer_email: null };
    expect(await hasRepliedSince(lead, CUTOFF)).toBe(false);
    expect(messagesCall().groupWheres).toEqual([['orWhere', 'conversations.contact_phone', '555-0123']]);
  });

  test('a foreign number typed without "+" never matches a US conversation by its last ten digits', async () => {
    setRows({ messages: null });
    const lead = { id: 'est-6', customer_id: null, customer_phone: '49 941 555 0123', customer_email: null };
    expect(await hasRepliedSince(lead, CUTOFF)).toBe(false);
    expect(messagesCall().groupWheres).toEqual([['orWhere', 'conversations.contact_phone', '49 941 555 0123']]);
  });

  test('a US number written as 1 + ten digits matches its E.164 form', async () => {
    setRows({ messages: { id: 'm1' } });
    const lead = { id: 'est-7', customer_id: null, customer_phone: '1-941-555-0123', customer_email: null };
    expect(await hasRepliedSince(lead, CUTOFF)).toBe(true);
    expect(messagesCall().groupWheres).toEqual([
      ['orWhere', 'conversations.contact_phone', '1-941-555-0123'],
      ['orWhere', 'conversations.contact_phone', '+19415550123'],
    ]);
  });

  test('a lead with a blank phone has no text match and no phone predicate', async () => {
    const lead = { id: 'est-5', customer_id: null, customer_phone: '   ', customer_email: null };
    expect(await hasRepliedSince(lead, CUTOFF)).toBe(false);
    expect(messagesCall().groupWheres).toEqual([]);
  });
});

// GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE (owner 2026-11-21, option A): the 14-day reply pause counts only messages since
// the estimate was made, for a person's first sent estimate.
describe('reply pause since the estimate (gate)', () => {
  const gates = require('../config/feature-gates');
  const DAY = 86400000;
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const estimatesCalls = () => db._calls.filter((c) => c.table === 'estimates');
  const messagesCall = () => db._calls.find((c) => c.table === 'messages');
  // The cutoff both reply arms receive, as a time.
  const smsCutoff = () => messagesCall().wheres.find((w) => w[0] === 'messages.created_at')[2].getTime();
  // The engagement engine's call: only this call takes the since-estimate window.
  const SINCE = { sinceEstimate: true };
  const madeAgo = (days) => ({ ...CUSTOMER_EST, created_at: iso(days * DAY) });

  beforeEach(() => {
    jest.clearAllMocks();
    db._calls.length = 0;
    db._rows = null;
    gates.estimateReplyPauseSinceEstimateLive = jest.fn(() => true);
  });
  afterAll(() => { delete gates.estimateReplyPauseSinceEstimateLive; });

  test('gate off: an estimate made 2 days ago keeps now minus 14 days, and no estimates read happens', async () => {
    gates.estimateReplyPauseSinceEstimateLive = jest.fn(() => false);
    setRows({ messages: null, emails: [] });
    const before = Date.now();
    await hasRepliedRecently(madeAgo(2), 14, SINCE);
    expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
    expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
    expect(estimatesCalls()).toHaveLength(0);
  });

  test('the gate reader missing from a bare-object mock is gate off', async () => {
    delete gates.estimateReplyPauseSinceEstimateLive;
    setRows({ messages: null, emails: [] });
    await hasRepliedRecently(madeAgo(2), 14, SINCE);
    expect(estimatesCalls()).toHaveLength(0);
    expect(Date.now() - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
  });

  test('gate on, first estimate made 2 days ago: both arms read from created_at', async () => {
    const est = madeAgo(2);
    setRows({ estimates: null, messages: null, customers: { email: 'pat@example.com' }, emails: [] });
    expect(await hasRepliedRecently(est, 14, SINCE)).toBe(false);
    expect(smsCutoff()).toBe(new Date(est.created_at).getTime());
    expect(emailCalls()[0].wheres[0]).toEqual(['emails.received_at', '>=', new Date(est.created_at)]);
  });

  test('gate on, the other-estimate read asks for any other sent estimate of the same person, made before or after this one', async () => {
    const est = { ...madeAgo(2), customer_phone: '(941) 555-0123' };
    setRows({ estimates: null, messages: null, emails: [] });
    await hasRepliedRecently(est, 14, SINCE);
    const [c] = estimatesCalls();
    expect(c.wheres).toContainEqual(['whereNot', 'id', 'est-1']);
    expect(c.wheres).toContainEqual(['whereNotNull', 'sent_at']);
    // no created_at clause: an estimate made after this one counts too
    expect(JSON.stringify(c.wheres)).not.toContain('created_at');
    expect(c.groupWheres).toEqual([
      ['where', 'customer_id', 'cust-1'],
      ['orWhere', 'customer_phone', '(941) 555-0123'],
      ['orWhere', 'customer_phone', '+19415550123'],
    ]);
    // bindings, never an interpolated address; trimmed and lower-cased; every address a reply can come from
    expect(c.groupRaws).toEqual([
      ["orWhereRaw", "RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", ['9415550123']],
      ['orWhereRaw', 'LOWER(TRIM(customer_email)) = ANY(?)', [['pat@example.com']]],
    ]);
    expect(c.limit).toBeUndefined();
  });

  test('gate on: a reply BEFORE the estimate does not pause, a reply AFTER it does (the reply arms read from created_at)', async () => {
    const est = madeAgo(2);
    const created = new Date(est.created_at).getTime();
    const inboxSince = (rows) => (table, rec) => {
      if (table === 'estimates') return null;
      const w = rec.wheres.find((x) => x[0] === 'messages.created_at' || x[0] === 'emails.received_at');
      if (table === 'customers') return { email: 'pat@example.com' };
      const cutoff = w[2].getTime();
      return rows[table].filter((t) => t >= cutoff).length ? (table === 'messages' ? { id: 'm1' } : [CUSTOMER_REPLY]) : (table === 'messages' ? null : []);
    };
    db._rows = inboxSince({ messages: [created - 3600000], emails: [created - 3600000] });
    expect(await hasRepliedRecently(est, 14, SINCE)).toBe(false);
    db._calls.length = 0;
    db._rows = inboxSince({ messages: [created + 3600000], emails: [] });
    expect(await hasRepliedRecently(est, 14, SINCE)).toBe(true);
    db._calls.length = 0;
    db._rows = inboxSince({ messages: [], emails: [created + 3600000] });
    expect(await hasRepliedRecently(est, 14, SINCE)).toBe(true);
  });

  test('gate on, another sent estimate of the same person exists: today\'s window (customer_id, phone and email forms)', async () => {
    for (const est of [
      madeAgo(2),
      { ...madeAgo(2), customer_id: null, customer_email: null },
      { ...madeAgo(2), customer_id: null, customer_phone: null },
    ]) {
      db._calls.length = 0;
      setRows({ estimates: { id: 'est-0' }, messages: null, emails: [] });
      const before = Date.now();
      await hasRepliedRecently(est, 14, SINCE);
      expect(estimatesCalls()).toHaveLength(1);
      expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
      expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
    }
  });

  test('gate on, a person with no identifier at all: no estimates read, today\'s window', async () => {
    setRows({ messages: null, emails: [] });
    await hasRepliedRecently({ id: 'est-9', customer_id: null, customer_phone: ' ', customer_email: '', created_at: iso(2 * DAY) }, 14, SINCE);
    expect(estimatesCalls()).toHaveLength(0);
  });

  test('gate on, estimate made 30 days ago: today\'s window and no extra read', async () => {
    setRows({ messages: null, customers: { email: 'pat@example.com' }, emails: [] });
    const before = Date.now();
    await hasRepliedRecently(madeAgo(30), 14, SINCE);
    expect(estimatesCalls()).toHaveLength(0);
    expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
    expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
  });

  test('gate on, created_at missing, unparsable or in the future: today\'s window and no extra read', async () => {
    for (const created_at of [undefined, null, '', 'not a date', new Date(Date.now() + 3600000).toISOString()]) {
      db._calls.length = 0;
      setRows({ messages: null, emails: [] });
      const before = Date.now();
      await hasRepliedRecently({ ...CUSTOMER_EST, created_at }, 14, SINCE);
      expect(estimatesCalls()).toHaveLength(0);
      expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
      expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
    }
  });

  test('gate on, created_at as a Date object works like the string', async () => {
    const created = new Date(Date.now() - 2 * DAY);
    setRows({ estimates: null, messages: null, emails: [] });
    await hasRepliedRecently({ ...CUSTOMER_EST, created_at: created }, 14, SINCE);
    expect(smsCutoff()).toBe(created.getTime());
  });

  test('gate on, the other-estimate read throws: today\'s window, nothing thrown (cron and replay), only the code logged', async () => {
    const boom = Object.assign(new Error('select ... customer_phone = +19415550123 at 12 Palm Way'), { code: '57P01' });
    for (const opts of [{}, { throwOnError: true }]) {
      db._calls.length = 0;
      logger.warn.mockClear();
      setRows({ estimates: boom, messages: null, customers: { email: 'pat@example.com' }, emails: [] });
      const before = Date.now();
      await expect(hasRepliedRecently(madeAgo(2), 14, { ...opts, sinceEstimate: true })).resolves.toBe(false);
      expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
      expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
      expect(logger.warn).toHaveBeenCalledWith('[est-followup] reply-pause window check skipped for estimate est-1: 57P01');
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).not.toContain('19415550123');
      expect(logged).not.toContain('Palm Way');
      expect(logged).not.toContain('pat@example.com');
    }
  });

  test('gate on, a failed other-estimate read does not hide a later reply-arm failure on replay', async () => {
    setRows({ estimates: new Error('estimates down'), messages: new Error('messages down') });
    await expect(hasRepliedRecently(madeAgo(2), 14, { throwOnError: true, sinceEstimate: true })).rejects.toThrow('reply-pause check failed');
  });

  test('gate on WITHOUT sinceEstimate (the safetyGate path) = today\'s window and no estimates read, also on replay', async () => {
    for (const opts of [undefined, {}, { throwOnError: true }]) {
      db._calls.length = 0;
      setRows({ messages: null, customers: { email: 'pat@example.com' }, emails: [] });
      const before = Date.now();
      await hasRepliedRecently(madeAgo(2), 14, opts);
      expect(estimatesCalls()).toHaveLength(0);
      expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
      expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
    }
  });

  test('sinceEstimate is not passed on to hasRepliedSince: only throwOnError is', async () => {
    setRows({ estimates: null, messages: new Error('messages down'), customers: { email: 'pat@example.com' }, emails: [] });
    // throwOnError still reaches the reply arms; the unknown option does not change them
    await expect(hasRepliedRecently(madeAgo(2), 14, { sinceEstimate: true, throwOnError: true })).rejects.toThrow('reply-pause check failed');
    await expect(hasRepliedRecently(madeAgo(2), 14, SINCE)).resolves.toBe(false);
  });

  const LAST_TEN = 'RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, \'\'), \'[^0-9]\', \'\', \'g\'), 10) = ?';

  test('the other-estimate lookup matches a phone stored in any format by its last ten digits', async () => {
    for (const phone of ['+19415550123', '(941) 555-0123', '1-941-555-0123']) {
      db._calls.length = 0;
      setRows({ estimates: null, messages: null, emails: [] });
      await hasRepliedRecently({ ...madeAgo(2), customer_phone: phone }, 14, SINCE);
      const [c] = estimatesCalls();
      expect(c.groupRaws).toContainEqual(['orWhereRaw', LAST_TEN, ['9415550123']]);
      // the exact stored form is still compared too
      expect(c.groupWheres).toContainEqual(['orWhere', 'customer_phone', phone]);
    }
  });

  test('a phone under ten digits adds no last-ten clause (the exact form still matches)', async () => {
    setRows({ estimates: null, messages: null, emails: [] });
    await hasRepliedRecently({ ...madeAgo(2), customer_phone: '555-0123' }, 14, SINCE);
    const [c] = estimatesCalls();
    expect(c.groupRaws.map((r) => r[1])).toEqual(['LOWER(TRIM(customer_email)) = ANY(?)']);
    expect(c.groupWheres).toContainEqual(['orWhere', 'customer_phone', '555-0123']);
  });

  test('the customer\'s ON-FILE address (not the estimate\'s own) matching another sent estimate = today\'s window', async () => {
    const est = madeAgo(2);
    db._rows = (table, rec) => {
      if (table === 'customers') return { email: 'Owner@Example.org' };
      if (table === 'estimates') {
        // the stand-in for SQL: the other estimate matches only through the on-file address
        const anyAddr = rec.groupRaws.find((r) => r[1] === 'LOWER(TRIM(customer_email)) = ANY(?)');
        return anyAddr && anyAddr[2][0].includes('owner@example.org') ? { id: 'est-0' } : null;
      }
      return table === 'emails' ? [] : null;
    };
    const before = Date.now();
    await hasRepliedRecently(est, 14, SINCE);
    const [c] = estimatesCalls();
    expect(c.groupRaws).toContainEqual(['orWhereRaw', 'LOWER(TRIM(customer_email)) = ANY(?)', [['pat@example.com', 'owner@example.org']]]);
    expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
    expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
  });

  test('one of our own addresses is never an identity address in the lookup', async () => {
    setRows({ estimates: null, messages: null, customers: null, emails: [] });
    await hasRepliedRecently({ ...madeAgo(2), customer_id: null, customer_phone: null, customer_email: 'Contact@WavesPestControl.com' }, 14, SINCE);
    // no identifier left: no estimates read
    expect(estimatesCalls()).toHaveLength(0);
  });

  test('gate on, the customers read INSIDE the lookup throws: today\'s window, nothing thrown (cron and replay), only the code logged', async () => {
    const boom = Object.assign(new Error('select email from customers where id = cust-1 (pat@example.com, 12 Palm Way)'), { code: '57P01' });
    for (const opts of [{}, { throwOnError: true }]) {
      db._calls.length = 0;
      logger.warn.mockClear();
      let customersReads = 0;
      db._rows = (table) => {
        if (table === 'customers') {
          customersReads += 1;
          if (customersReads === 1) throw boom; // the lookup's own read; the reply arms read it later and succeed
          return { email: 'pat@example.com' };
        }
        return table === 'emails' ? [] : null;
      };
      const before = Date.now();
      await expect(hasRepliedRecently(madeAgo(2), 14, { ...opts, sinceEstimate: true })).resolves.toBe(false);
      expect(estimatesCalls()).toHaveLength(0);
      expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
      expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
      expect(logger.warn).toHaveBeenCalledWith('[est-followup] reply-pause window check skipped for estimate est-1: 57P01');
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).not.toContain('pat@example.com');
      expect(logged).not.toContain('Palm Way');
    }
  });

  test('a draft made first and sent last: with another estimate sent, A keeps the full window and a reply after B still pauses', async () => {
    // A (the estimate checked) was made 5 days ago as a draft; B was made 3 days ago and sent; the customer replied
    // 1 day ago; then A is sent. B is another sent estimate of the person, made after A, so A keeps today's window.
    const estA = { ...CUSTOMER_EST, id: 'est-A', created_at: iso(5 * DAY) };
    const replyAt = Date.now() - DAY;
    db._rows = (table, rec) => {
      if (table === 'estimates') return { id: 'est-B' };
      if (table === 'customers') return { email: 'pat@example.com' };
      const w = rec.wheres.find((x) => x[0] === 'messages.created_at' || x[0] === 'emails.received_at');
      if (table === 'messages') return replyAt >= w[2].getTime() ? { id: 'm1' } : null;
      return [];
    };
    const before = Date.now();
    expect(await hasRepliedRecently(estA, 14, SINCE)).toBe(true);
    const [c] = estimatesCalls();
    expect(JSON.stringify(c.wheres)).not.toContain('created_at');
    expect(before - smsCutoff()).toBeGreaterThanOrEqual(14 * DAY - 1000);
    expect(before - smsCutoff()).toBeLessThan(14 * DAY + 5000);
  });

  test('the gate reader is strict: only the exact string true turns it on', () => {
    jest.isolateModules(() => {
      const real = jest.requireActual('../config/feature-gates');
      const prior = process.env.GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE;
      try {
        for (const [v, want] of [['true', true], ['TRUE', false], ['True', false], ['1', false], ['yes', false], [' true', false], ['', false], [undefined, false]]) {
          if (v === undefined) delete process.env.GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE;
          else process.env.GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE = v;
          expect(real.estimateReplyPauseSinceEstimateLive()).toBe(want);
        }
      } finally {
        if (prior === undefined) delete process.env.GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE;
        else process.env.GATE_ESTIMATE_REPLY_PAUSE_SINCE_ESTIMATE = prior;
      }
    });
  });
});
