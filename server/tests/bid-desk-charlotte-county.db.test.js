// Bid Desk Charlotte County due dates (GATE_BID_DESK_CHARLOTTE_DATES) through PostgreSQL: which bids the run reads the
// county for, the fill and its confirmed flag, and every row it must leave alone. A fake fetch stands in for the
// county's list; no test calls the real site. Every write runs in a transaction that is rolled back. Synthetic bids
// only. Skips without DATABASE_URL (CI runs it).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const county = require('../services/bid-desk/charlotte-county');
const { reminderDue } = require('../services/bid-desk/rules');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;

const DAY = 24 * 60 * 60 * 1000;
const COUNTY_KEY = 'charlotte county purchasing division';
const NOV4 = 1793818800000;

const countyRow = (fileNo, ms = NOV4, over = {}) => ({ FileNo: fileNo, FileNumber10: '20260000', Description: 'Sample', DueDate: `/Date(${ms})/`, bAwarded: false, ...over });
const fakeFetch = (rows) => jest.fn(async () => ({
  ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(rows),
}));

describeDb('Bid Desk Charlotte County due dates (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    process.env.GATE_BID_DESK = 'true';
    process.env.GATE_BID_DESK_CHARLOTTE_DATES = 'true';
    process.env.GATE_BID_DESK_AUTO_DATES = 'true';
  });
  afterEach(async () => {
    const trx = mockPg; mockPg = database; await trx.rollback();
    delete process.env.GATE_BID_DESK; delete process.env.GATE_BID_DESK_CHARLOTTE_DATES; delete process.env.GATE_BID_DESK_AUTO_DATES;
  });
  afterAll(async () => { if (database) await database.destroy(); });

  // A Charlotte County template bid: key "<agency>|<title>|<number>", as the detector files it.
  async function bid(number, over = {}) {
    const [row] = await mockPg('bid_opportunities').insert({
      source: 'gov_email', status: 'new', solicitation_number: number,
      gc_or_agency: 'Charlotte County Purchasing Division', project_title: `Sample Grounds ${number}`,
      group_key: `${COUNTY_KEY}|sample grounds ${number}|${number}`, due_at: null, due_confirmed: false,
      needs_date_confirmation: true, ...over,
    }).returning('*');
    return row;
  }
  const rowOf = (id) => mockPg('bid_opportunities').where({ id }).first();
  const bells = (bidId, key) => mockPg('notifications').insert({
    recipient_type: 'admin', category: 'lead', title: 't', body: 'b', metadata: JSON.stringify({ dedupeKey: `bid-desk:${key}:${bidId}:${randomUUID()}` }),
  });
  const openBells = async (bidId) => (await mockPg('notifications').whereRaw("metadata->>'dedupeKey' like ?", [`bid-desk:%${bidId}%`])
    .whereRaw("metadata->>'autoCleared' IS DISTINCT FROM 'true'").select('id')).length;

  test('gate off: nothing is read, nothing is fetched, nothing is written', async () => {
    const row = await bid('26-601');
    const fetchImpl = fakeFetch([countyRow('26-601')]);
    delete process.env.GATE_BID_DESK_CHARLOTTE_DATES;
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ skipped: 'gate_off' });
    process.env.GATE_BID_DESK_CHARLOTTE_DATES = 'true';
    delete process.env.GATE_BID_DESK;
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ skipped: 'gate_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await rowOf(row.id)).due_at).toBeNull();
  });

  test('no open dateless Charlotte bid: the county is not called', async () => {
    const fetchImpl = fakeFetch([countyRow('26-601')]);
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ skipped: 'nothing_to_fill' });
    // None of these is a candidate: dated, decided, no number, another sender, another provider's key.
    await bid('26-602', { due_at: new Date(NOV4) });
    await bid('26-603', { status: 'no_bid' });
    await bid('26-604', { status: 'submitted' });
    await bid(null, { group_key: `${COUNTY_KEY}|no number|` });
    await bid('26-605', { group_key: 'sample county|other|26-605' });
    await bid('26-606', { group_key: null });
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ skipped: 'nothing_to_fill' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a fill sets the date, its source line, confirmed (AUTO_DATES on), a clean flag and cleared reminder stamps', async () => {
    const row = await bid('26-601', { reminder_14d_sent_at: new Date(), reminder_7d_sent_at: new Date(), reminder_2d_sent_at: new Date(), decision_note: 'keep', project_title: 'Keep Title' });
    const fetchImpl = fakeFetch([countyRow('26-601'), countyRow('26-999')]);
    const before = await rowOf(row.id);
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ filled: 1, unmatched: 0, fetched: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const after = await rowOf(row.id);
    expect(after.due_at.getTime()).toBe(NOV4);
    expect(after).toMatchObject({
      due_source_line: 'Charlotte County bid list: due Nov 4, 2026, 2:00 PM ET',
      due_confirmed: true, needs_date_confirmation: false,
      reminder_14d_sent_at: null, reminder_7d_sent_at: null, reminder_2d_sent_at: null,
      status: 'new', project_title: 'Keep Title', decision_note: 'keep',
    });
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  test('AUTO_DATES off: the date is filled but not confirmed, so no reminder is owed', async () => {
    delete process.env.GATE_BID_DESK_AUTO_DATES;
    const row = await bid('26-601');
    expect(await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601')]) })).toMatchObject({ filled: 1 });
    const after = await rowOf(row.id);
    expect(after).toMatchObject({ due_confirmed: false, needs_date_confirmation: false });
    expect(after.due_at.getTime()).toBe(NOV4);
    expect(reminderDue(after, new Date(NOV4 - 6 * DAY))).toBeNull();
  });

  test('after a fill the existing reminder logic sees a confirmed date', async () => {
    const row = await bid('26-601');
    await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601')]) });
    const after = await rowOf(row.id);
    expect(reminderDue(after, new Date(NOV4 - 6 * DAY))).toBe('7d');
    expect(reminderDue(after, new Date(NOV4 - 1 * DAY))).toBe('2d');
  });

  test('a bid that already has a date is never overwritten; a bid on bid status still fills', async () => {
    const dated = await bid('26-601', { due_at: new Date(NOV4 - 3 * DAY), due_confirmed: true, needs_date_confirmation: false });
    const live = await bid('26-602', { status: 'bid' });
    const out = await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601', NOV4 + DAY), countyRow('26-602')]) });
    expect(out).toMatchObject({ filled: 1, unmatched: 0 });
    expect((await rowOf(dated.id)).due_at.getTime()).toBe(NOV4 - 3 * DAY);
    expect((await rowOf(live.id)).due_at.getTime()).toBe(NOV4);
  });

  test('a decided bid is untouched', async () => {
    const open = await bid('26-601');
    const decided = await bid('26-601', { status: 'no_bid', group_key: `${COUNTY_KEY}|decided|26-601` });
    const out = await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601')]) });
    expect(out.filled).toBe(1);
    expect((await rowOf(open.id)).due_at).not.toBeNull();
    expect(await rowOf(decided.id)).toMatchObject({ due_at: null, status: 'no_bid', due_confirmed: false });
  });

  test('a gov_email bid of another sender with the same number is untouched', async () => {
    const mine = await bid('26-601');
    const other = await bid('26-601', { gc_or_agency: 'Sample City', group_key: 'sample city|sample grounds|26-601' });
    const blank = await bid('26-601', { group_key: null });
    const out = await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601')]) });
    expect(out).toEqual({ filled: 1, unmatched: 0, fetched: true });
    expect((await rowOf(mine.id)).due_at).not.toBeNull();
    expect(await rowOf(other.id)).toMatchObject({ due_at: null, due_confirmed: false });
    expect((await rowOf(blank.id)).due_at).toBeNull();
  });

  test('a number not on the list (or listed twice, or awarded) is left alone and counted', async () => {
    const missing = await bid('26-601');
    const twice = await bid('26-602');
    const awarded = await bid('26-603');
    const fetchImpl = fakeFetch([countyRow('26-602'), countyRow('26-602', NOV4 + DAY), countyRow('26-603', NOV4, { bAwarded: true }), countyRow('26-700')]);
    expect(await county.runCharlotteDates({ fetchImpl })).toEqual({ filled: 0, unmatched: 3, fetched: true });
    for (const row of [missing, twice, awarded]) expect(await rowOf(row.id)).toMatchObject({ due_at: null, due_confirmed: false, needs_date_confirmation: true });
  });

  test('a failed fetch writes nothing and the run fails', async () => {
    const row = await bid('26-601');
    const failing = jest.fn(async () => ({ ok: false, status: 502, headers: { get: () => 'text/html' }, text: async () => 'x' }));
    await expect(county.runCharlotteDates({ fetchImpl: failing })).rejects.toThrow('Charlotte County list HTTP 502');
    await expect(county.runCharlotteDates({ fetchImpl: async () => { throw new TypeError('socket SECRET'); } })).rejects.toThrow('TypeError');
    expect(await rowOf(row.id)).toMatchObject({ due_at: null, due_confirmed: false, needs_date_confirmation: true });
  });

  test('a fill closes the date-question bells like an operator date confirmation, and rings nothing', async () => {
    const row = await bid('26-601');
    await bells(row.id, 'addendum');
    await bells(row.id, 'remind');
    await bells(row.id, 'new');
    const before = await openBells(row.id);
    expect(before).toBe(3);
    const count = await mockPg('notifications').count('* as n').first();
    await county.runCharlotteDates({ fetchImpl: fakeFetch([countyRow('26-601')]) });
    // The addendum (date question) and any reminder for an old date close; the new-bid bell stays; no new row.
    expect(await openBells(row.id)).toBe(1);
    expect((await mockPg('notifications').count('* as n').first()).n).toBe(count.n);
  });

  test('the row is checked again under its lock: a date set after the list was read is never overwritten', async () => {
    const row = await bid('26-601');
    const racing = jest.fn(async () => {
      await mockPg('bid_opportunities').where({ id: row.id }).update({ due_at: new Date(NOV4 + 5 * DAY) });
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify([countyRow('26-601')]) };
    });
    expect(await county.runCharlotteDates({ fetchImpl: racing })).toEqual({ filled: 0, unmatched: 0, fetched: true });
    expect((await rowOf(row.id)).due_at.getTime()).toBe(NOV4 + 5 * DAY);
  });
});
