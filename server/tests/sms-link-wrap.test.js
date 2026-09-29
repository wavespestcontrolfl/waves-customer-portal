/**
 * SMS portal-link wrap (services/messaging/sms-link-wrap.js) — the rewrite,
 * the gate, the fail-open contract, and the post-send stamp/cleanup.
 * GATE_SMS_LINK_WRAP ships dark: every body is byte-identical with it off.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => {
  const actual = jest.requireActual('../services/short-url');
  return { ...actual, createShortCode: jest.fn() };
});

const db = require('../models/db');
const logger = require('../services/logger');
const { createShortCode } = require('../services/short-url');
const { ownedPortalLinkSpans } = require('../services/composer-customer-links');
const { wrapPortalLinks, settleWrappedLinks } = require('../services/messaging/sms-link-wrap');

const HOST = 'portal.wavespestcontrol.com';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex, the prep token shape
const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const LEAD_ID = '66666666-7777-4888-9999-000000000000';
const SID = 'SM' + 'a1'.repeat(16); // a real Twilio message sid shape
const base = { channel: 'sms', audience: 'customer', customerId: CUSTOMER_ID };

// A chainable short_codes/sms_log query double. `rows` is what a .first() returns.
function queryBuilder(table, log, rows = {}) {
  const b = {};
  for (const m of ['where', 'whereNull', 'orderBy', 'whereRaw']) {
    b[m] = jest.fn((...args) => { log.push({ table, [m]: args }); return b; });
  }
  b.whereIn = jest.fn((col, vals) => { log.push({ table, whereIn: [col, vals] }); return b; });
  b.first = jest.fn(async () => (rows[table] === undefined ? null : rows[table]));
  b.update = jest.fn(async (payload) => { log.push({ table, update: payload }); return 1; });
  return b;
}

let n;
let log;
let rows;
beforeEach(() => {
  jest.clearAllMocks();
  log = [];
  rows = {};
  db.mockImplementation((t) => queryBuilder(t, log, rows));
  process.env.GATE_SMS_LINK_WRAP = 'true';
  n = 0;
  createShortCode.mockImplementation(async () => {
    n += 1;
    return { code: `code${n}`, shortUrl: `https://${HOST}/l/code${n}` };
  });
});
afterAll(() => { delete process.env.GATE_SMS_LINK_WRAP; });

describe('link recognition (ownedPortalLinkSpans)', () => {
  test('finds full https and scheme-less portal links, in place, with trailing punctuation left out', () => {
    const body = `Prep: https://${HOST}/prep/${TOKEN}. Pay ${HOST}/pay/abc123def456ghi789jk, thanks`;
    const spans = ownedPortalLinkSpans(body);
    expect(spans.map((s) => body.slice(s.start, s.end))).toEqual([
      `https://${HOST}/prep/${TOKEN}`,
      `${HOST}/pay/abc123def456ghi789jk`,
    ]);
    expect(spans.map((s) => s.family)).toEqual(['prep', 'pay']);
    expect(spans[1].url).toBe(`https://${HOST}/pay/abc123def456ghi789jk`);
  });

  test('skips /l/ short links, the bare home, non-portal hosts and look-alikes', () => {
    const body = [
      `${HOST}/l/k3j9x2m4pq`,
      `https://${HOST}/l/k3j9x2m4pq/`,
      `https://${HOST}`,
      `https://wavespestcontrol.com/blog/ants`,
      `https://evil.example/?next=${HOST}/prep/${TOKEN}`,
      `https://${HOST}@evil.example/prep/${TOKEN}`,
      `https://evil.${HOST}/prep/${TOKEN}`,
      `${HOST}.evil.example/prep/${TOKEN}`,
    ].join(' ');
    expect(ownedPortalLinkSpans(body)).toEqual([]);
  });
});

describe('wrapPortalLinks', () => {
  test('rewrites a full https portal link into a scheme-stripped short link stamped to the customer', async () => {
    const out = await wrapPortalLinks({ ...base, body: `Your prep guide: https://${HOST}/prep/${TOKEN} See you soon.` });
    expect(out.body).toBe(`Your prep guide: ${HOST}/l/code1 See you soon.`);
    expect(out.codes).toEqual(['code1']);
    expect(createShortCode).toHaveBeenCalledWith(`https://${HOST}/prep/${TOKEN}`, expect.objectContaining({
      kind: 'other', entityType: 'portal:prep', customerId: CUSTOMER_ID, channel: 'sms', purpose: 'sms_link_wrap',
    }));
    expect(createShortCode.mock.calls[0][1].leadId).toBeNull();
  });

  test('rewrites a scheme-less portal link (the form the SMS seam has already stripped)', async () => {
    const out = await wrapPortalLinks({ ...base, body: `Prep: ${HOST}/prep/${TOKEN}` });
    expect(out.body).toBe(`Prep: ${HOST}/l/code1`);
    expect(createShortCode).toHaveBeenCalledWith(`https://${HOST}/prep/${TOKEN}`, expect.anything());
  });

  test.each([[','], [';'], ['),'], [', ']])('two portal URLs joined by "%s" wrap to two correct short links (GH Codex #5332 r4 P2)', async (glue) => {
    const PAY = 'abc123def456ghi789jk';
    const out = await wrapPortalLinks({ ...base, body: `Links: (${HOST}/prep/${TOKEN}${glue}${HOST}/pay/${PAY}) ok` });
    expect(createShortCode.mock.calls.map((c) => c[0])).toEqual([
      `https://${HOST}/prep/${TOKEN}`,
      `https://${HOST}/pay/${PAY}`,
    ]);
    expect(out.body).toBe(`Links: (${HOST}/l/code1${glue}${HOST}/l/code2) ok`);
    expect(out.codes).toEqual(['code1', 'code2']);
  });

  test('a single URL keeps one code (unchanged)', async () => {
    const out = await wrapPortalLinks({ ...base, body: `Prep: ${HOST}/prep/${TOKEN}.` });
    expect(out.body).toBe(`Prep: ${HOST}/l/code1.`);
    expect(out.codes).toEqual(['code1']);
  });

  test('a lead audience carries the lead id; a non-uuid id is never passed (FK-safe)', async () => {
    await wrapPortalLinks({ body: `${HOST}/estimate/tok123tok123tok123`, channel: 'sms', audience: 'lead', customerId: 'cust-1', leadId: LEAD_ID });
    expect(createShortCode.mock.calls[0][1]).toEqual(expect.objectContaining({ leadId: LEAD_ID, customerId: null }));
  });

  test('the same link twice in one body shares one code; two different links get two', async () => {
    const same = await wrapPortalLinks({ ...base, body: `${HOST}/prep/${TOKEN} and again ${HOST}/prep/${TOKEN}` });
    expect(same.body).toBe(`${HOST}/l/code1 and again ${HOST}/l/code1`);
    expect(same.codes).toEqual(['code1']);
    const two = await wrapPortalLinks({ ...base, body: `${HOST}/prep/${TOKEN} ${HOST}/pay/abc123def456ghi789jk` });
    expect(two.codes).toEqual(['code2', 'code3']);
  });

  test('a Knex-style error that embeds the bound bearer URL never reaches the log', async () => {
    const url = `https://${HOST}/prep/${TOKEN}`;
    createShortCode.mockRejectedValue(Object.assign(
      new Error(`insert into "short_codes" ("target_url") values ('${url}') - connection terminated`),
      { code: 'ECONNRESET' },
    ));
    const body = `Prep: ${url}`;
    await expect(wrapPortalLinks({ ...base, body })).resolves.toEqual({ body, codes: [] });
    const logged = logger.warn.mock.calls.flat().join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('short_codes');
  });

  test('a link that is already a /l/ short link is untouched and mints nothing', async () => {
    const body = `Pay here: ${HOST}/l/k3j9x2m4pq`;
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('reschedule and inspection links are left as typed (their delivery-evidence readers key on their own linkage)', async () => {
    const body = `Move it: https://${HOST}/reschedule/${TOKEN} or book: ${HOST}/inspection/lead1.1700000000.${TOKEN}`;
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
    // ...while a sibling link in the same text is still wrapped.
    const mixed = await wrapPortalLinks({ ...base, body: `${HOST}/reschedule/${TOKEN} ${HOST}/prep/${TOKEN}` });
    expect(mixed.body).toBe(`${HOST}/reschedule/${TOKEN} ${HOST}/l/code1`);
  });

  test('review-ask links are left as typed (their fence recognizes them by kind review)', async () => {
    const body = `Review us: ${HOST}/rate/${TOKEN} or ${HOST}/api/rate/${TOKEN}/go`;
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test.each(['review_request', 'missed_call_followup'])(
    '%s sends are skipped whole: they stamp the exact body and reconcile a stranded send by searching the provider for it',
    async (purpose) => {
      const body = `Prep: https://${HOST}/prep/${TOKEN}`;
      expect(await wrapPortalLinks({ ...base, purpose, body })).toEqual({ body, codes: [] });
      expect(createShortCode).not.toHaveBeenCalled();
      // Any other purpose is wrapped.
      expect((await wrapPortalLinks({ ...base, purpose: 'conversational', body })).codes).toEqual(['code1']);
    },
  );

  test('a non-portal host is untouched', async () => {
    const body = 'Read more: https://wavespestcontrol.com/blog/ants and https://example.com/prep/abc';
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('gate off: body untouched, nothing minted', async () => {
    delete process.env.GATE_SMS_LINK_WRAP;
    const body = `Prep: https://${HOST}/prep/${TOKEN}`;
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    process.env.GATE_SMS_LINK_WRAP = 'yes';
    expect(await wrapPortalLinks({ ...base, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test.each([
    ['internal audience', { audience: 'internal' }],
    ['applicant audience', { audience: 'applicant' }],
    ['email channel', { channel: 'email' }],
    ['media body', { hasMedia: true }],
  ])('%s: untouched', async (_label, over) => {
    const body = `Prep: https://${HOST}/prep/${TOKEN}`;
    expect(await wrapPortalLinks({ ...base, ...over, body })).toEqual({ body, codes: [] });
    expect(createShortCode).not.toHaveBeenCalled();
  });

  test('bearer link (prep token): a mint failure keeps the ORIGINAL link, warns, and never throws or blocks', async () => {
    createShortCode.mockRejectedValue(new Error('db down'));
    const body = `Prep: https://${HOST}/prep/${TOKEN}`;
    await expect(wrapPortalLinks({ ...base, body })).resolves.toEqual({ body, codes: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('original kept'));
    // The warn names the family and the error, never the URL or token.
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain(TOKEN);
  });

  test('one link failing does not stop the others being wrapped', async () => {
    createShortCode
      .mockRejectedValueOnce(new Error('collision retries exhausted'))
      .mockResolvedValueOnce({ code: 'ok1', shortUrl: `https://${HOST}/l/ok1` });
    const out = await wrapPortalLinks({ ...base, body: `${HOST}/prep/${TOKEN} ${HOST}/pay/abc123def456ghi789jk` });
    expect(out.body).toBe(`${HOST}/prep/${TOKEN} ${HOST}/l/ok1`);
    expect(out.codes).toEqual(['ok1']);
  });

  test('recognition throwing keeps the body and warns', async () => {
    const composer = require('../services/composer-customer-links');
    const spy = jest.spyOn(composer, 'ownedPortalLinkSpans').mockImplementation(() => { throw new Error('boom'); });
    const body = `Prep: ${HOST}/prep/${TOKEN}`;
    await expect(wrapPortalLinks({ ...base, body })).resolves.toEqual({ body, codes: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recognition failed'));
    spy.mockRestore();
  });
});

describe('settleWrappedLinks', () => {
  beforeEach(() => { rows.sms_log = { id: 'log-uuid-1' }; });

  test('an accepted send stamps every code with the sms_log row (only where still unstamped)', async () => {
    await settleWrappedLinks(['c1', 'c2'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID });
    expect(log).toContainEqual({ table: 'sms_log', where: [{ twilio_sid: SID }] });
    // Reservation placeholders are excluded (sms_log general-reader source guard).
    expect(log.some((e) => e.table === 'sms_log' && e.whereRaw)).toBe(true);
    expect(log).toContainEqual({ table: 'short_codes', whereIn: ['code', ['c1', 'c2']] });
    expect(log).toContainEqual({ table: 'short_codes', whereNull: ['message_ref'] });
    expect(log).toContainEqual({ table: 'short_codes', update: expect.objectContaining({ message_ref: 'sms_log:log-uuid-1' }) });
  });

  test('an unreadable sms_log row falls back to the provider id', async () => {
    db.mockImplementation((t) => {
      const b = queryBuilder(t, log, rows);
      if (t === 'sms_log') b.first = jest.fn(async () => { throw new Error('nope'); });
      return b;
    });
    await settleWrappedLinks(['c1'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID });
    expect(log).toContainEqual({ table: 'short_codes', update: expect.objectContaining({ message_ref: `twilio_sid:${SID}` }) });
  });

  test.each([
    ['blocked / never sent', { sent: false, deliveryOutcome: 'not_sent' }],
    ['uncertain delivery', { sent: false, deliveryOutcome: 'uncertain' }],
    ['provider dedupe (no new text went out)', { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', deduped: true, providerMessageId: SID }],
    ['push-routed send (accepted, but no text carried the links)', { sent: true, provider: 'push', deliveryOutcome: 'accepted', providerMessageId: 'push:delivered' }],
    ['push id under a twilio-shaped outcome', { sent: true, provider: 'twilio', deliveryOutcome: 'accepted', providerMessageId: 'push:delivered' }],
    ['a well-formed sid from a non-twilio provider', { sent: true, provider: 'push', deliveryOutcome: 'accepted', providerMessageId: SID }],
  ])('%s: codes stay unstamped and are never deleted', async (_l, outcome) => {
    await settleWrappedLinks(['c1'], outcome);
    expect(log).toEqual([]);
  });

  test('only codes still present in the body actually sent are stamped (a code stripped at the provider boundary stays unstamped)', async () => {
    rows.sms_log = { id: 'log-uuid-2', message_body: `Prep: ${HOST}/l/c1 and details ${HOST}/estimate/x` };
    await settleWrappedLinks(['c1', 'c2'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID, withheldLinksRewritten: ['est-1'] });
    expect(log).toContainEqual({ table: 'short_codes', whereIn: ['code', ['c1']] });
    expect(log).toContainEqual({ table: 'short_codes', update: expect.objectContaining({ message_ref: 'sms_log:log-uuid-2' }) });
  });

  test('a code is not matched by a longer code sharing its prefix', async () => {
    rows.sms_log = { id: 'log-uuid-3', message_body: `Pay ${HOST}/l/c12` };
    await settleWrappedLinks(['c1'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID });
    expect(log.some((e) => e.table === 'short_codes')).toBe(false);
  });

  test('every wrapped code removed at the boundary: nothing is stamped at all', async () => {
    rows.sms_log = { id: 'log-uuid-4', message_body: 'Waves: see your account at portal.wavespestcontrol.com' };
    await settleWrappedLinks(['c1'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID, withheldLinksRewritten: ['est-1'] });
    expect(log.some((e) => e.table === 'short_codes')).toBe(false);
  });

  test('a link was rewritten at the boundary and the final body is unreadable: nothing is stamped', async () => {
    db.mockImplementation((t) => {
      const b = queryBuilder(t, log, rows);
      if (t === 'sms_log') b.first = jest.fn(async () => { throw new Error('nope'); });
      return b;
    });
    await settleWrappedLinks(['c1'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID, withheldLinksRewritten: ['est-1'] });
    expect(log.some((e) => e.table === 'short_codes')).toBe(false);
  });

  test('a database error never throws', async () => {
    db.mockImplementation(() => { throw new Error('pool exhausted'); });
    await expect(settleWrappedLinks(['c1'], { sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: SID })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stamp failed'));
  });
});
