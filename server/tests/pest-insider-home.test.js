// Pest Insider "Your home" facts (services/pest-insider/home.js): the service line from the platform's one
// classifier over the whole last day, the commercial and 365-day rules, member since, and the shape of the one
// batched read (the SQL's own rules run against real Postgres in pest-insider-home-postgres.test.js).
const { serviceLineOf, loadHomeFacts, HOME_TOKEN, HOME_TEXT_TOKEN, hasHomeToken, neutralizeHomeTokens } = require('../services/pest-insider/home');

jest.mock('../models/db', () => jest.fn());

const NOW = new Date('2026-11-21T15:00:00Z');

// A conn whose raw() records its calls and answers with the next batch of rows.
function fakeConn(batches) {
  const calls = [];
  const conn = { raw: jest.fn(async (sql, bindings) => { calls.push({ sql, bindings }); return { rows: batches.shift() || [] }; }) };
  return { conn, calls };
}

describe('serviceLineOf', () => {
  test.each([
    [['Quarterly Pest Control Service'], 'pest'],
    [['Lawn Care Visit'], 'lawn'],
    [['Mosquito Control'], 'mosquito'],
    [['Termite Inspection'], 'termite'],
    [['Rodent Exclusion'], 'rodent'],
    [['Tree & Shrub Care'], 'tree_shrub'],
    [['Palm Injection'], 'tree_shrub'],
    [['Commercial Pest Control'], 'pest'],
    [['Quarterly Pest Control', 'Pest Control Follow-up'], 'pest'],
  ])('%j -> %s', (types, line) => expect(serviceLineOf(types)).toBe(line));

  test.each([
    [null], [undefined], [[]], [['']], [['Spring special']], [['Lawn and Pest Combo']],
    // two names on the last day from two lines: no label
    [['Quarterly Pest Control', 'Lawn Care Visit']],
    [['Lawn Care Visit', 'Spring special', 'Mosquito Control']],
  ])('no line, or more than one across the whole day, gives null (%j)', (types) => {
    expect(serviceLineOf(types)).toBeNull();
  });
});

describe('loadHomeFacts', () => {
  const row = (over = {}) => ({
    subscriber_id: 11, customer_id: 'c1', reader_address: 'reader@example.invalid', member_since: new Date('2024-03-05T00:00:00Z'), property_type: 'single_family', waveguard_tier: 'Silver',
    last_date: new Date('2026-11-10T00:00:00Z'), last_types: ['Quarterly Pest Control'], ...over,
  });

  test('maps each row by subscriber id: dates as YYYY-MM-DD, member since as the since date, a line key, never a service name', async () => {
    const { conn } = fakeConn([[
      row(),
      row({ subscriber_id: 12, customer_id: 'c2', last_date: '2026-10-01', member_since: null, last_types: ['Gate code 4821 Mary'] }),
    ]]);
    const facts = await loadHomeFacts(conn, [11, 12], NOW);
    expect(facts.get(11)).toEqual({ customerId: 'c1', address: 'reader@example.invalid', lastVisit: { date: '2026-11-10', line: 'pest' }, sinceDate: '2024-03-05' });
    expect(facts.get(12)).toEqual({ customerId: 'c2', address: 'reader@example.invalid', lastVisit: { date: '2026-10-01', line: null }, sinceDate: null });
    expect(JSON.stringify([...facts])).not.toMatch(/4821|Mary|Quarterly/);
    expect(JSON.stringify([...facts])).not.toMatch(/visit_?count|count/i);
  });

  test('a last visit booked at another address than the home on file has no entry; the home\'s own address, in another spelling, does', async () => {
    const home = { home_line1: '100 Palm Drive', home_line2: null, home_city: 'Bradenton', home_zip: '34202', home_property_id: 'p1' };
    const stamp = (over = {}) => ({ property_id: null, address_line1: null, address_line2: null, city: null, zip: null, ...over });
    const { conn } = fakeConn([[
      row({ subscriber_id: 1, ...home, last_stamps: [] }),
      row({ subscriber_id: 2, ...home, last_stamps: [stamp()] }),
      row({ subscriber_id: 3, ...home, last_stamps: [stamp({ property_id: 'p1', address_line1: '100 Palm Dr', city: 'Bradenton', zip: '34202' })] }),
      row({ subscriber_id: 4, ...home, last_stamps: [stamp({ address_line1: '9 Other Road', city: 'Bradenton', zip: '34202' })] }),
      row({ subscriber_id: 5, ...home, last_stamps: [stamp({ property_id: 'p2' })] }),
      row({ subscriber_id: 6, ...home, last_stamps: [stamp({ property_id: 'p1' }), stamp({ address_line1: '100 Palm Drive', zip: '34211' })] }),
      row({ subscriber_id: 7, ...home, home_property_id: null, last_stamps: [stamp({ property_id: 'p9' })] }),
    ]]);
    const facts = await loadHomeFacts(conn, [1, 2, 3, 4, 5, 6, 7], NOW);
    expect([...facts.keys()]).toEqual([1, 2, 3]);
  });

  test('the last day\'s service names are classified together: two lines on one day give no label', async () => {
    const { conn } = fakeConn([[row({ last_types: ['Quarterly Pest Control', 'Lawn Care Visit'] }), row({ subscriber_id: 12, last_types: ['Lawn Care Visit', 'Lawn Care Visit #2'] })]]);
    const facts = await loadHomeFacts(conn, [11, 12], NOW);
    expect(facts.get(11).lastVisit.line).toBeNull();
    expect(facts.get(12).lastVisit.line).toBe('lawn');
  });

  test('a commercial account (platform helper: property type or the commercial tier) has no entry', async () => {
    const { conn } = fakeConn([[
      row({ subscriber_id: 1, property_type: 'commercial' }),
      row({ subscriber_id: 2, property_type: 'Business' }),
      row({ subscriber_id: 3, waveguard_tier: 'Commercial' }),
      row({ subscriber_id: 5, waveguard_tier: 'commercial' }),
      row({ subscriber_id: 4 }),
    ]]);
    expect([...(await loadHomeFacts(conn, [1, 2, 3, 4, 5], NOW)).keys()]).toEqual([4]);
  });

  test('a last visit more than 365 days before now has no entry; exactly 365 days still does', async () => {
    const { conn } = fakeConn([[row({ subscriber_id: 1, last_date: '2025-11-20' }), row({ subscriber_id: 2, last_date: '2025-11-21' })]]);
    expect([...(await loadHomeFacts(conn, [1, 2], NOW)).keys()]).toEqual([2]);
  });

  test('a row with an unreadable last date has no entry; an unreadable member since is just no since date', async () => {
    const { conn } = fakeConn([[row({ last_date: null }), row({ subscriber_id: 12, member_since: 'soon' })]]);
    const facts = await loadHomeFacts(conn, [11, 12], NOW);
    expect([...facts.keys()]).toEqual([12]);
    expect(facts.get(12).sinceDate).toBeNull();
  });

  test('one read per slice, by subscriber id, with today (Eastern) and the ids as the only bindings', async () => {
    const { conn, calls } = fakeConn([[]]);
    await loadHomeFacts(conn, [11, 11, null, undefined, 12], NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].bindings).toEqual(['2026-11-21', 11, 12]);
    expect(calls[0].sql).toContain('WHERE ns.id IN (?, ?)');
    expect(calls[0].sql).toContain("COALESCE(r.status, 'completed') = 'completed'");
    expect(calls[0].sql).toContain('FROM service_records r');
    expect(calls[0].sql).toContain('LOWER(TRIM(ns.email)) AS reader_address');
    // The visits are the records; the appointment is joined only for its address stamp.
    expect(calls[0].sql).not.toMatch(/FROM scheduled_services/);
    expect(calls[0].sql).toContain('LEFT JOIN scheduled_services ss ON ss.id = r.scheduled_service_id');
    expect(calls[0].sql).toMatch(/LOWER\(TRIM\(ns\.email\)\) = LOWER\(TRIM\(c\.email\)\)/);
    expect(calls[0].sql).toMatch(/COALESCE\(o\.account_id, o\.id\) = COALESCE\(c\.account_id, c\.id\)/);
    expect(calls[0].sql).toContain('customer_properties');
    // Every value is a binding: no id or date is written into the SQL.
    expect(calls[0].sql).not.toMatch(/2026-11-21|\b11, 12\b/);
  });

  test('today is the Eastern date: late evening on the 20th Eastern is still the 20th', async () => {
    const { conn, calls } = fakeConn([[]]);
    await loadHomeFacts(conn, [1], new Date('2026-11-21T03:00:00Z'));
    expect(calls[0].bindings[0]).toBe('2026-11-20');
  });

  test('a long list is read in slices, and an empty list reads nothing', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    const { conn, calls } = fakeConn([[], [], []]);
    await loadHomeFacts(conn, ids, NOW);
    expect(calls.map((c) => c.bindings.length - 1)).toEqual([1000, 1000, 500]);
    const none = fakeConn([]);
    expect((await loadHomeFacts(none.conn, [], NOW)).size).toBe(0);
    expect((await loadHomeFacts(none.conn, null, NOW)).size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  test('a failed read throws, so the caller fails closed', async () => {
    const conn = { raw: jest.fn(async () => { throw new Error('db down'); }) };
    await expect(loadHomeFacts(conn, [1], NOW)).rejects.toThrow('db down');
  });
});

test('the tokens are the two exact lowercase literals and nothing else', () => {
  expect(HOME_TOKEN).toBe('{{pi-home}}');
  expect(HOME_TEXT_TOKEN).toBe('{{pi-home-text}}');
  expect(hasHomeToken(`x ${HOME_TOKEN}`)).toBe(true);
  expect(hasHomeToken(`x ${HOME_TEXT_TOKEN}`)).toBe(true);
  expect(neutralizeHomeTokens(`a${HOME_TOKEN}b${HOME_TEXT_TOKEN}c`)).toBe('abc');
  expect(hasHomeToken('{{ PI-Home }}')).toBe(false);
  expect(neutralizeHomeTokens('a {{ PI-Home }} {{PI-HOME-TEXT}} b')).toBe('a {{ PI-Home }} {{PI-HOME-TEXT}} b');
});
