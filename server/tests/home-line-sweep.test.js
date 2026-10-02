/**
 * Home line sweep (services/home-line.js): stamps each customer's line with
 * the address key it was derived from; leaves a current stamp alone; never
 * writes while GATE_HOME_LINE is off; a row edited since the read is left
 * for the next run (compare-and-set).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { stampHomeLines, homeLineCallerId } = require('../services/home-line');
const { addressKey } = require('../services/customer-property-address-keys');

function fakeDb(rows, { updateResult = 1 } = {}) {
  const updates = [];
  const predicates = [];
  const database = jest.fn(() => {
    const q = {
      whereNull: () => q,
      select: async () => rows,
      where: (w) => { q._id = w.id; return q; },
      whereRaw: (sql, bindings) => { predicates.push([sql, bindings]); return q; },
      update: async (patch) => { updates.push({ id: q._id, ...patch }); return updateResult; },
    };
    return q;
  });
  return { database, updates, predicates };
}

describe('stampHomeLines', () => {
  const ORIGINAL = process.env.GATE_HOME_LINE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_HOME_LINE;
    else process.env.GATE_HOME_LINE = ORIGINAL;
  });
  const now = new Date('2026-10-02T07:05:00Z');
  const parrish = { id: 'a', address_line1: '1 A St', city: '', zip: '34219' };
  const current = { id: 'b', address_line1: '2 B St', city: 'Venice', zip: '34285' };
  current.home_line_location_id = 'venice';
  current.home_line_address_key = addressKey(current);
  const moved = { id: 'c', address_line1: '3 New Rd', city: 'Sarasota', zip: '34236', home_line_location_id: 'venice', home_line_address_key: 'old-key' };

  test('gate off: writes nothing', async () => {
    delete process.env.GATE_HOME_LINE;
    const { database, updates } = fakeDb([parrish]);
    expect(await stampHomeLines({ now, database })).toEqual({ skipped: 'gated' });
    expect(updates).toHaveLength(0);
  });

  test('stamps unstamped and moved customers, leaves a current stamp alone', async () => {
    process.env.GATE_HOME_LINE = 'true';
    const { database, updates } = fakeDb([parrish, current, moved]);
    expect(await stampHomeLines({ now, database })).toEqual({ stamped: 2, unchanged: 1, noOffice: 0, lostRace: 0 });
    expect(updates).toEqual([
      { id: 'a', home_line_location_id: 'parrish', home_line_address_key: addressKey(parrish), home_line_source: 'derived', home_line_set_at: now },
      { id: 'c', home_line_location_id: 'sarasota', home_line_address_key: addressKey(moved), home_line_source: 'derived', home_line_set_at: now },
    ]);
  });

  test('an address that names no office is left unstamped (readers keep their fallbacks)', async () => {
    process.env.GATE_HOME_LINE = 'true';
    const blank = { id: 'd', address_line1: '', city: '', zip: '' };
    const outOfArea = { id: 'e', address_line1: '5 Far Rd', city: 'Orlando', zip: '32801' };
    const { database, updates } = fakeDb([blank, outOfArea, parrish]);
    expect(await stampHomeLines({ now, database })).toEqual({ stamped: 1, unchanged: 0, noOffice: 2, lostRace: 0 });
    expect(updates.map((u) => [u.id, u.home_line_location_id])).toEqual([['a', 'parrish']]);
    // …so the call path still presents the main line for them after a sweep.
    expect(homeLineCallerId(blank)).toBe('+19412975749');
  });

  test('a row changed since the read is counted, not overwritten', async () => {
    process.env.GATE_HOME_LINE = 'true';
    const { database } = fakeDb([parrish], { updateResult: 0 });
    expect(await stampHomeLines({ now, database })).toEqual({ stamped: 0, unchanged: 0, noOffice: 0, lostRace: 1 });
  });

  test('the compare-and-set covers every input the line is derived from', async () => {
    process.env.GATE_HOME_LINE = 'true';
    const { database, predicates } = fakeDb([parrish]);
    await stampHomeLines({ now, database });
    expect(predicates).toEqual(expect.arrayContaining(['address_line1', 'address_line2', 'city', 'zip', 'latitude', 'longitude', 'home_line_location_id', 'home_line_address_key'].map((c) => [`${c} IS NOT DISTINCT FROM ?`, [parrish[c] ?? null]])));
  });
});

describe('homeLineCallerId (calls, PR 2)', () => {
  const ORIGINAL = process.env.GATE_HOME_LINE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_HOME_LINE;
    else process.env.GATE_HOME_LINE = ORIGINAL;
  });
  const MAIN = '+19412975749';
  const PARRISH = '+19412972817';
  const parrish = { id: 'a', address_line1: '1 A St', city: '', zip: '34219' };

  test('gate off: every call presents the main line', () => {
    delete process.env.GATE_HOME_LINE;
    expect(homeLineCallerId(parrish)).toBe(MAIN);
  });

  test('gate on: a customer whose address names an office gets that line', () => {
    process.env.GATE_HOME_LINE = 'true';
    expect(homeLineCallerId(parrish)).toBe(PARRISH);
  });

  test('gate on: a current stored stamp wins over the derived office', () => {
    process.env.GATE_HOME_LINE = 'true';
    const stamped = { ...parrish, home_line_location_id: 'venice' };
    stamped.home_line_address_key = addressKey(stamped);
    expect(homeLineCallerId(stamped)).toBe('+19412973337');
  });

  test('gate on: no customer, or a lead with no office, keeps the main line', () => {
    process.env.GATE_HOME_LINE = 'true';
    expect(homeLineCallerId(null)).toBe(MAIN);
    expect(homeLineCallerId({ id: 'lead', city: '', zip: '' })).toBe(MAIN);
    expect(homeLineCallerId({ id: 'far', city: 'Orlando', zip: '32801' })).toBe(MAIN);
  });
});
