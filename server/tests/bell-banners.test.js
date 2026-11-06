/**
 * Phone banners for bell-only admin alerts (GATE_BELL_BANNERS, owner 2026-11-03, choices A and B): which writes send
 * one, the 7:00 AM to 9:00 PM Eastern window for the two reminder kinds, and the wait for the commit.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: false, push: { sent: 1 } })) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { triggerNotification } = require('../services/notification-triggers');
const { BELL_BANNER_KINDS, isNightQuiet, bannerAfterWrite } = require('../services/bell-banners');

// 2026-07-15 noon ET: inside the window for the kinds that observe it.
const NOON_ET = new Date('2026-07-15T16:00:00Z');

// The committed rows the db stand-in serves back (what a read after the commit sees), by id.
const stored = new Map();
const row = (over = {}) => {
  const written = { id: 'n-1', title: 'A promise to a caller is overdue', body: 'Pat S. - call back (due today).', link: '/admin/communications#tab=owed', read_at: null, metadata: {}, deduped: false, ...over };
  // By default the commit keeps exactly what was written; a test overrides stored.set(...) to say otherwise.
  stored.set(written.id, { id: written.id, title: written.title, body: written.body, link: written.link, read_at: null, done_at: null, metadata: written.metadata });
  return written;
};
const meta = (triggerKey, over = {}) => ({ triggerKey, ...over });
// A refresh that rang: notifyAdmin stamps metadata.rungAt on the row it returns and writes.
const rang = (rungAt = '2026-07-15T16:00:00.000Z', over = {}) => row({ deduped: true, refreshed: true, rung: true, metadata: { rungAt }, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  stored.clear();
  db.mockImplementation(() => {
    let id;
    const chain = { where: (cond) => { id = cond.id; return chain; }, first: async () => stored.get(id) };
    return chain;
  });
  jest.useFakeTimers({ now: NOON_ET });
  process.env.GATE_BELL_BANNERS = 'true';
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_BELL_BANNERS;
});

describe('isNightQuiet', () => {
  test.each([
    ['winter 6:59 AM', '2026-01-15T11:59:00Z', true],
    ['winter 7:00 AM', '2026-01-15T12:00:00Z', false],
    ['winter 8:59 PM', '2026-01-16T01:59:00Z', false],
    ['winter 9:00 PM', '2026-01-16T02:00:00Z', true],
    ['summer 6:59 AM', '2026-07-15T10:59:00Z', true],
    ['summer 7:00 AM', '2026-07-15T11:00:00Z', false],
    ['summer 8:59 PM', '2026-07-16T00:59:00Z', false],
    ['summer 9:00 PM', '2026-07-16T01:00:00Z', true],
    ['midnight', '2026-07-15T04:00:00Z', true],
    // Spring forward (2026-03-08, 2:00 AM EST becomes 3:00 AM EDT): 7:00 AM is 11:00Z that day, 12:00Z the day before.
    ['spring-forward day 6:59 AM EDT', '2026-03-08T10:59:00Z', true],
    ['spring-forward day 7:00 AM EDT', '2026-03-08T11:00:00Z', false],
    ['day before spring-forward 7:00 AM EST', '2026-03-07T12:00:00Z', false],
    // Fall back (2026-11-01, 2:00 AM EDT becomes 1:00 AM EST): 9:00 PM is 02:00Z on the 2nd, a fixed -4 offset says 01:00Z.
    ['fall-back day 6:59 AM EST', '2026-11-01T11:59:00Z', true],
    ['fall-back day 7:00 AM EST', '2026-11-01T12:00:00Z', false],
    ['fall-back day 8:59 PM EST', '2026-11-02T01:59:00Z', false],
    ['fall-back day 9:00 PM EST', '2026-11-02T02:00:00Z', true],
    ['day before fall-back 9:30 PM EDT', '2026-11-01T01:30:00Z', true],
  ])('%s', (_label, iso, quiet) => {
    expect(isNightQuiet(new Date(iso))).toBe(quiet);
  });
});

test('the banner kinds: two reminders and the stuck-booking alert keep the night quiet; Facebook messages and new-lead emails do not', () => {
  expect(BELL_BANNER_KINDS).toEqual({
    sms_operational_followup: { nightQuiet: true },
    call_commitment_overdue: { nightQuiet: true },
    messenger_reply: { nightQuiet: false },
    // GATE_RING_NEW_CONTACTS, not GATE_BELL_BANNERS (owner 2026-11-04).
    new_lead_email: { nightQuiet: false, gate: 'ringNewContactsLive' },
    // A customer stuck booking from an estimate (estimate-stuck-alert.js, owner 2026-11-05).
    estimate_stuck: { nightQuiet: true },
  });
  expect(Object.isFrozen(BELL_BANNER_KINDS)).toBe(true);
});

describe('bannerAfterWrite: which writes send a banner', () => {
  test.each(['sms_operational_followup', 'call_commitment_overdue', 'messenger_reply', 'estimate_stuck'])('a fresh unread %s row sends one pushOnly banner with the row\'s own words', async (kind) => {
    const written = row({ id: 'n-77', title: 'Pat S. wrote on Facebook', body: 'Can you call me?', link: '/admin/communications#tab=messenger&thread=t-1' });
    await bannerAfterWrite(written, { metadata: meta(kind) });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [key, payload, opts] = triggerNotification.mock.calls[0];
    expect(key).toBe(kind);
    expect(payload).toEqual({ alertRowId: 'n-77', alertTitle: 'Pat S. wrote on Facebook', alertBody: 'Can you call me?', alertLink: '/admin/communications#tab=messenger&thread=t-1' });
    expect(opts).toEqual(expect.objectContaining({ pushOnly: true, adminOnly: true, bellAuthorized: true, beforePush: expect.any(Function) }));
  });

  test('the customer the row is about rides along so a test account never gets a banner', async () => {
    await bannerAfterWrite(row(), { metadata: meta('sms_operational_followup', { customerId: 'cust-9' }) });
    expect(triggerNotification.mock.calls[0][1]).toEqual(expect.objectContaining({ customerId: 'cust-9' }));
    await bannerAfterWrite(row({ id: 'n-2' }), { metadata: meta('call_commitment_overdue', { customer_id: 'cust-8' }) });
    expect(triggerNotification.mock.calls[1][1]).toEqual(expect.objectContaining({ customerId: 'cust-8' }));
  });

  test('a refreshed standing row that rang again sends one; a quiet refresh sends none', async () => {
    await bannerAfterWrite(rang(), { metadata: meta('messenger_reply') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    await bannerAfterWrite(row({ deduped: true, refreshed: true, rung: false, metadata: { rungAt: 'T' } }), { metadata: meta('messenger_reply') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a plain row written without a dedupe key (no deduped field) rings like a fresh keyed one', async () => {
    const { deduped: _gone, ...plain } = row();
    await bannerAfterWrite(plain, { metadata: meta('sms_operational_followup') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['gate off', () => { delete process.env.GATE_BELL_BANNERS; }, row(), meta('messenger_reply')],
    ['gate set to something other than true', () => { process.env.GATE_BELL_BANNERS = '1'; }, row(), meta('messenger_reply')],
    ['a trigger that is not a banner kind', () => {}, row(), meta('sms_reply')],
    ['an inherited object key', () => {}, row(), meta('toString')],
    ['no trigger key', () => {}, row(), {}],
    ['no metadata at all', () => {}, row(), undefined],
    ['an identical repeat', () => {}, row({ deduped: true }), meta('messenger_reply')],
    ['a refresh that did not ring', () => {}, row({ deduped: true, refreshed: true, rung: false, metadata: { rungAt: 'T' } }), meta('messenger_reply')],
    ['a refresh that rang but carries no ring stamp', () => {}, row({ deduped: true, refreshed: true, rung: true }), meta('messenger_reply')],
    ['a withheld bell', () => {}, { id: null, suppressed: true }, meta('messenger_reply')],
    ['a withheld bell with a reason', () => {}, { id: null, suppressed: true, reason: 'bell_policy' }, meta('messenger_reply')],
    ['a relay suppression', () => {}, { suppressed: true, deduped: true }, meta('messenger_reply')],
    ['a failed write (null)', () => {}, null, meta('messenger_reply')],
    ['a row that is already read', () => {}, row({ read_at: new Date() }), meta('messenger_reply')],
    ['the backlog summary (Activity-only)', () => {}, row({ metadata: { feed: 'activity' } }), meta('call_commitment_overdue', { feed: 'activity', overdue_count: 12 })],
    ['a row written quiet by a ring gate', () => {}, row({ metadata: { quiet: true, feed: 'activity' } }), meta('sms_operational_followup')],
    ['a row routed to Claude\'s queue', () => {}, row({ metadata: { claudeQueue: 'ops-job' } }), meta('sms_operational_followup')],
  ])('no banner for %s', async (_label, arrange, written, metadata) => {
    arrange();
    const sent = bannerAfterWrite(written, { metadata });
    expect(sent).toBeNull();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the row\'s own metadata can veto a row the caller\'s metadata did not (a ring gate rewrote it)', async () => {
    const sent = bannerAfterWrite(row({ metadata: JSON.stringify({ feed: 'activity', quiet: true }) }), { metadata: meta('messenger_reply') });
    expect(sent).toBeNull();
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('bannerAfterWrite: the night', () => {
  const at = (iso) => jest.setSystemTime(new Date(iso));

  test.each(['sms_operational_followup', 'call_commitment_overdue', 'estimate_stuck'])('%s sends no banner at night and one at 7:00 AM sharp', async (kind) => {
    at('2026-07-15T02:00:00Z'); // 10:00 PM ET
    await bannerAfterWrite(row(), { metadata: meta(kind) });
    at('2026-07-15T10:59:00Z'); // 6:59 AM ET
    await bannerAfterWrite(row(), { metadata: meta(kind) });
    expect(triggerNotification).not.toHaveBeenCalled();
    at('2026-07-15T11:00:00Z'); // 7:00 AM ET
    await bannerAfterWrite(row(), { metadata: meta(kind) });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a reminder is quiet from 9:00 PM and still goes at 8:59 PM', async () => {
    at('2026-07-16T00:59:00Z');
    await bannerAfterWrite(row(), { metadata: meta('call_commitment_overdue') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    at('2026-07-16T01:00:00Z');
    await bannerAfterWrite(row(), { metadata: meta('call_commitment_overdue') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a Facebook message pushes at any hour, like a text', async () => {
    for (const iso of ['2026-07-15T07:30:00Z', '2026-07-15T10:59:00Z', '2026-07-16T01:00:00Z', '2026-07-16T03:30:00Z']) {
      at(iso);
      await bannerAfterWrite(row(), { metadata: meta('messenger_reply') });
    }
    expect(triggerNotification).toHaveBeenCalledTimes(4);
  });
});

describe('bannerAfterWrite: after the commit', () => {
  // A knex transaction object as far as the banner cares: executionPromise settles on commit (resolve) or rollback (reject).
  function fakeTrx(parent = null) {
    let commit; let rollback;
    const trx = { executionPromise: new Promise((resolve, reject) => { commit = resolve; rollback = reject; }) };
    if (parent) trx.parentTransaction = parent;
    return { trx, commit, rollback };
  }
  const flush = () => new Promise((resolve) => { jest.requireActual('timers').setImmediate(resolve); });

  test('a write on the caller\'s transaction waits for the commit, then sends', async () => {
    const { trx, commit } = fakeTrx();
    const pending = bannerAfterWrite(row(), { metadata: meta('messenger_reply'), trx });
    await flush();
    expect(triggerNotification).not.toHaveBeenCalled();
    commit();
    await pending;
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a rollback sends nothing', async () => {
    const { trx, rollback } = fakeTrx();
    const pending = bannerAfterWrite(row(), { metadata: meta('messenger_reply'), trx });
    rollback(new Error('boom'));
    await expect(pending).resolves.toBeNull();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a savepoint waits for the OUTERMOST commit, not its own release', async () => {
    const outer = fakeTrx();
    const inner = fakeTrx(outer.trx);
    const deepest = fakeTrx(inner.trx);
    const pending = bannerAfterWrite(row(), { metadata: meta('call_commitment_overdue'), trx: deepest.trx });
    deepest.commit();
    inner.commit();
    await flush();
    expect(triggerNotification).not.toHaveBeenCalled();
    outer.commit();
    await pending;
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a savepoint released and then rolled back with the outer transaction sends nothing', async () => {
    const outer = fakeTrx();
    const inner = fakeTrx(outer.trx);
    const pending = bannerAfterWrite(row(), { metadata: meta('call_commitment_overdue'), trx: inner.trx });
    inner.commit();
    outer.rollback(new Error('outer rolled back'));
    await expect(pending).resolves.toBeNull();
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the hour is judged when the banner goes, not when the row was written', async () => {
    jest.setSystemTime(new Date('2026-07-16T00:59:00Z')); // 8:59 PM ET: the write
    const { trx, commit } = fakeTrx();
    const pending = bannerAfterWrite(row(), { metadata: meta('sms_operational_followup'), trx });
    jest.setSystemTime(new Date('2026-07-16T01:00:30Z')); // 9:00 PM ET: the commit
    commit();
    await pending;
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a transaction with no commit hook sends no banner and says so', () => {
    expect(bannerAfterWrite(row(), { metadata: meta('messenger_reply'), trx: {} })).toBeNull();
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no commit hook'));
  });

  test('the global pool (no transaction) sends at once', async () => {
    await bannerAfterWrite(row(), { metadata: meta('messenger_reply'), trx: db });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });
});

describe('bannerAfterWrite: failures stay out of the caller', () => {
  test('a push failure only logs, with no row text', async () => {
    triggerNotification.mockRejectedValueOnce(Object.assign(new Error('Pat S. 941-555-0100 failed'), { code: 'ECONNRESET' }));
    await expect(bannerAfterWrite(row({ body: 'Pat S. 941-555-0100' }), { metadata: meta('messenger_reply') })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('ECONNRESET');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/Pat S|941/);
  });

  test('a throw while deciding never reaches the caller', () => {
    const hostile = { get id() { throw new Error('hostile'); } };
    expect(() => bannerAfterWrite(hostile, { metadata: meta('messenger_reply') })).not.toThrow();
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});

describe('the committed row decides', () => {
  const T1 = '2026-07-15T15:59:00.000Z';
  const T2 = '2026-07-15T16:00:00.000Z';

  test('the banner carries the COMMITTED words, not the ones the write scheduled', async () => {
    const written = rang(T2, { title: 'Scheduled title', body: 'Scheduled body' });
    stored.set('n-1', { ...stored.get('n-1'), title: 'Committed title', body: 'Committed body' });
    await bannerAfterWrite(written, { metadata: meta('messenger_reply') });
    expect(triggerNotification.mock.calls[0][1]).toMatchObject({ alertRowId: 'n-1', alertTitle: 'Committed title', alertBody: 'Committed body' });
  });

  test.each([
    ['a savepoint rolled the refresh back: the row keeps its OLD ring stamp', () => stored.set('n-1', { ...stored.get('n-1'), metadata: { rungAt: T1 } })],
    ['a rolled-back refresh of a row that never had a stamp', () => stored.set('n-1', { ...stored.get('n-1'), metadata: {} })],
    ['a later ring in the same transaction replaced the stamp (that ring sends its own banner)', () => stored.set('n-1', { ...stored.get('n-1'), metadata: JSON.stringify({ rungAt: '2026-07-15T16:00:01.000Z' }) })],
    ['the row is gone (a rolled-back insert whose rollback resolved executionPromise)', () => stored.delete('n-1')],
    ['the row is read by commit time', () => stored.set('n-1', { ...stored.get('n-1'), read_at: new Date() })],
    ['the row is closed by commit time', () => stored.set('n-1', { ...stored.get('n-1'), done_at: new Date() })],
  ])('no banner when %s', async (_label, arrange) => {
    const written = rang(T2);
    arrange();
    await bannerAfterWrite(written, { metadata: meta('messenger_reply') });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a stamp stored as JSON text still matches', async () => {
    const written = rang(T2);
    stored.set('n-1', { ...stored.get('n-1'), metadata: JSON.stringify({ rungAt: T2 }) });
    await bannerAfterWrite(written, { metadata: meta('messenger_reply') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a fresh insert is matched by its row: it goes when the row is there, not when it is gone', async () => {
    await bannerAfterWrite(row({ id: 'n-8' }), { metadata: meta('messenger_reply') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    triggerNotification.mockClear();
    const rolledBack = row({ id: 'n-9' });
    stored.delete('n-9');
    await bannerAfterWrite(rolledBack, { metadata: meta('messenger_reply') });
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a fresh insert that a refresh rang again before the send sends no banner of its own (the refresh sends one)', async () => {
    const insert = row({ id: 'n-1' });
    stored.set('n-1', { ...stored.get('n-1'), title: 'Refreshed title', metadata: { rungAt: T2 } });
    await bannerAfterWrite(insert, { metadata: meta('messenger_reply') });
    expect(triggerNotification).not.toHaveBeenCalled();
    await bannerAfterWrite(rang(T2, { title: 'Refreshed title' }), { metadata: meta('messenger_reply') });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification.mock.calls[0][1]).toMatchObject({ alertRowId: 'n-1', alertTitle: 'Refreshed title' });
  });

  test('a failed lookup is unverified: no banner, and the log carries no row text', async () => {
    db.mockImplementation(() => { throw new Error('lookup down for Pat S.'); });
    await bannerAfterWrite(row({ body: 'Pat S. 941-555-0100' }), { metadata: meta('messenger_reply') });
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/Pat S|941/);
  });

  describe('the look just before the send', () => {
    const lastLook = async (written) => {
      await bannerAfterWrite(written, { metadata: meta('messenger_reply') });
      return triggerNotification.mock.calls[0][2].beforePush;
    };

    test('goes while the committed row is still this ring, open and unread', async () => {
      expect(await (await lastLook(rang(T2)))()).toBe(true);
    });

    test.each([
      ['read while the push is prepared (the watchdog marks a promise it already summarised)', { read_at: new Date() }],
      ['closed', { done_at: new Date() }],
      ['rung again by a newer write', { metadata: { rungAt: '2026-07-15T16:00:05.000Z' } }],
    ])('stops when the row is %s', async (_label, change) => {
      const look = await lastLook(rang(T2));
      stored.set('n-1', { ...stored.get('n-1'), ...change });
      expect(await look()).toBe(false);
    });

    test('stops when the row is gone or the lookup fails', async () => {
      const look = await lastLook(rang(T2));
      stored.delete('n-1');
      expect(await look()).toBe(false);
      db.mockImplementation(() => { throw new Error('lookup down'); });
      expect(await look()).toBe(false);
    });
  });
});
