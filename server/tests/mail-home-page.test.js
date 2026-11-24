/**
 * services/mail/home-page.js with a mocked database: the token format gate, the exact columns it reads, the price rule,
 * the one atomic view write, and a failed view write that never fails the read and logs only a code.
 */

const mockCalls = [];
let mockRow;
let mockUpdateError;
let mockUpdateHang;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = { table, wheres: [], inLists: [] };
    q.where = jest.fn((cond) => { q.wheres.push(cond); return q; });
    q.whereIn = jest.fn((column, list) => { q.inLists.push([column, list]); return q; });
    q.first = jest.fn(async (...columns) => { mockCalls.push({ op: 'first', q, columns }); return mockRow; });
    q.update = jest.fn((set) => {
      mockCalls.push({ op: 'update', q, set });
      const run = async () => {
        if (mockUpdateHang) await new Promise(() => {}); // a row lock that never lets go
        if (mockUpdateError) throw mockUpdateError;
        return 1;
      };
      return { timeout: jest.fn((ms, opts) => { q.timeoutArgs = [ms, opts]; return run(); }) };
    });
    return q;
  });
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});

const logger = require('../services/logger');
const { getHomePage } = require('../services/mail/home-page');

const TOKEN = '0123456789abcdef0123456789abcdef';
const row = (over) => ({
  id: 'row-1', status: 'eligible', address_line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212',
  price_status: 'priced', price_annual: '627.01', price_setup_fee: '0.00', priced_at: new Date('2026-11-22T22:00:00Z'),
  ...over,
});

beforeEach(() => {
  mockCalls.length = 0;
  mockRow = row();
  mockUpdateError = undefined;
  jest.clearAllMocks();
});

describe('getHomePage', () => {
  test('a malformed token is null and never reaches the database', async () => {
    for (const bad of [undefined, null, 42, '', 'short', TOKEN.toUpperCase(), `${TOKEN}0`, `${TOKEN.slice(1)}g`]) {
      expect(await getHomePage(bad)).toBeNull();
    }
    expect(mockCalls).toEqual([]);
  });

  test('an unknown token is null and no view is written', async () => {
    mockRow = undefined;
    expect(await getHomePage(TOKEN, { recordView: true })).toBeNull();
    expect(mockCalls.map((c) => c.op)).toEqual(['first']);
  });

  test('reads only the new-home list live rows and only the columns it needs', async () => {
    await getHomePage(TOKEN);
    const read = mockCalls[0];
    expect(read.q.wheres).toEqual([{ page_token: TOKEN, list_key: 'new_home' }]);
    expect(read.q.inLists).toEqual([['status', ['eligible', 'held_back']]]);
    expect(read.columns).toEqual(['id', 'status', 'address_line1', 'city', 'zip', 'price_status', 'price_annual', 'price_setup_fee', 'priced_at', 'mailed_at', 'mailed_price']);
  });

  test('a priced eligible home: address, price to the cent, plan; nothing else', async () => {
    const page = await getHomePage(TOKEN);
    expect(page).toEqual({
      address: { line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212' },
      price: { monthly: 52.25, annual: 627.01, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' },
      plan: 'pest_quarterly',
      heldUntil: null,
    });
    expect(Object.keys(page).sort()).toEqual(['address', 'heldUntil', 'plan', 'price']);
  });

  test('a mailed home shows the printed price, not the columns, and the day it is held until (60 days, Eastern)', async () => {
    // The columns say 700; the card was printed with 52.25 a month. The page must agree with the card.
    mockRow = row({
      price_annual: '700.00',
      mailed_at: new Date('2026-11-24T15:00:00Z'),
      mailed_price: { plan: 'pest_quarterly', annual: 627.01, monthly: 52.25, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' },
    });
    const page = await getHomePage(TOKEN);
    expect(page.price).toEqual({ monthly: 52.25, annual: 627.01, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' });
    expect(page.heldUntil).toBe('2027-01-23');
  });

  test('a mailed home whose snapshot cannot be read shows no price and no hold date', async () => {
    mockRow = row({ mailed_at: new Date('2026-11-24T15:00:00Z'), mailed_price: { plan: 'pest_quarterly' } });
    const page = await getHomePage(TOKEN);
    expect(page.price).toBeNull();
    expect(page.heldUntil).toBeNull();
  });

  test('the monthly price is rounded from whole cents (301.02 / 12 = 25.085 is 25.09, not the float 25.08)', async () => {
    mockRow = row({ price_annual: '301.02' });
    expect((await getHomePage(TOKEN)).price.monthly).toBe(25.09);
  });

  test('held back, or not priced: price null, address still there', async () => {
    for (const over of [{ status: 'held_back' }, { price_status: 'missing_fact', price_annual: null, price_setup_fee: null, priced_at: null },
      { price_status: null, price_annual: null, price_setup_fee: null, priced_at: null }]) {
      mockRow = row(over);
      const page = await getHomePage(TOKEN);
      expect(page.price).toBeNull();
      expect(page.address.line1).toBe('101 EXAMPLE TRL');
      expect(page.plan).toBe('pest_quarterly');
    }
  });

  test('a view is written only when recordView is true: one atomic UPDATE', async () => {
    await getHomePage(TOKEN);
    await getHomePage(TOKEN, { recordView: false });
    expect(mockCalls.filter((c) => c.op === 'update')).toEqual([]);
    mockCalls.length = 0;
    await getHomePage(TOKEN, { recordView: true });
    const updates = mockCalls.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].q.wheres).toEqual([{ id: 'row-1' }]);
    expect(updates[0].q.timeoutArgs).toEqual([2000, { cancel: true }]);
    expect(updates[0].set).toEqual({
      page_views: { sql: 'page_views + 1' },
      page_first_viewed_at: { sql: 'coalesce(page_first_viewed_at, now())' },
      page_last_viewed_at: { sql: 'greatest(page_last_viewed_at, now())' },
    });
  });

  test('a failed view write still returns the page and logs only the error code', async () => {
    mockUpdateError = Object.assign(new Error(`update mail_prospects set ... where id = 'row-1' token ${TOKEN}`), { code: '57014' });
    const page = await getHomePage(TOKEN, { recordView: true });
    expect(page.address.line1).toBe('101 EXAMPLE TRL');
    await new Promise((resolve) => setImmediate(resolve)); // the write is not awaited by the read
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0].join(' ');
    expect(line).toContain('57014');
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain('mail_prospects');
  });

  test('a view write that waits on a row lock never holds the page', async () => {
    mockUpdateHang = true;
    try {
      const page = await getHomePage(TOKEN, { recordView: true });
      expect(page.address.line1).toBe('101 EXAMPLE TRL');
      expect(mockCalls.filter((c) => c.op === 'update')).toHaveLength(1);
    } finally {
      mockUpdateHang = false;
    }
  });
});
