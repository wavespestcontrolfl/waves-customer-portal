// Pest Insider "Your home" facts (services/pest-insider/home.js): the service line from the platform's one
// classifier, the 365-day rule, and the shape of the one batched read. The rows themselves are pinned against
// real Postgres in pest-insider-home-postgres.test.js.
const { serviceLineOf, loadHomeFacts, HOME_TOKEN, HOME_TEXT_TOKEN, hasHomeToken, neutralizeHomeTokens } = require('../services/pest-insider/home');

const NOW = new Date('2026-11-21T15:00:00Z');

// A knex-shaped chain that records its calls and resolves to the next batch of rows.
function fakeConn(batches) {
  const calls = [];
  const conn = (table) => {
    const call = { table, ops: [] };
    calls.push(call);
    const q = new Proxy({}, {
      get: (_t, name) => {
        if (name === 'then') return (resolve, reject) => Promise.resolve(batches.shift() || []).then(resolve, reject);
        return (...args) => { call.ops.push([name, args]); return q; };
      },
    });
    return q;
  };
  conn.raw = (sql) => ({ raw: sql });
  return { conn, calls };
}

describe('serviceLineOf', () => {
  test.each([
    ['Quarterly Pest Control Service', 'pest'],
    ['Lawn Care Visit', 'lawn'],
    ['Mosquito Control', 'mosquito'],
    ['Termite Inspection', 'termite'],
    ['Rodent Exclusion', 'rodent'],
    ['Tree & Shrub Care', 'tree_shrub'],
    ['Palm Injection', 'tree_shrub'],
    ['Commercial Pest Control', 'pest'],
  ])('%s -> %s', (name, line) => expect(serviceLineOf(name)).toBe(line));

  test.each([null, undefined, '', 'Spring special', 'Lawn and Pest Combo', 7])('no line, or more than one, gives null (%p)', (name) => {
    expect(serviceLineOf(name)).toBeNull();
  });
});

describe('loadHomeFacts', () => {
  const row = (over = {}) => ({ customer_id: 'c1', last_date: new Date('2026-11-10T00:00:00Z'), since_date: new Date('2024-03-05T00:00:00Z'), visit_count: 7, service_type: 'Quarterly Pest Control', ...over });

  test('maps each row to the structured facts: dates as YYYY-MM-DD, the count, and a line key, never the service name', async () => {
    const { conn } = fakeConn([[row(), row({ customer_id: 'c2', last_date: '2026-10-01', since_date: '2026-10-01', visit_count: 1, service_type: 'Gate code 4821 Mary' })]]);
    const facts = await loadHomeFacts(conn, ['c1', 'c2'], NOW);
    expect(facts.get('c1')).toEqual({ lastVisit: { date: '2026-11-10', line: 'pest' }, sinceDate: '2024-03-05', visitCount: 7 });
    expect(facts.get('c2')).toEqual({ lastVisit: { date: '2026-10-01', line: null }, sinceDate: '2026-10-01', visitCount: 1 });
    expect(JSON.stringify([...facts])).not.toMatch(/4821|Mary|Quarterly/);
  });

  test('a latest visit more than 365 days before now has no entry; exactly 365 days still does', async () => {
    const { conn } = fakeConn([[
      row({ customer_id: 'old', last_date: '2025-11-20' }),
      row({ customer_id: 'edge', last_date: '2025-11-21' }),
    ]]);
    const facts = await loadHomeFacts(conn, ['old', 'edge'], NOW);
    expect([...facts.keys()]).toEqual(['edge']);
  });

  test('a row with an unreadable date has no entry', async () => {
    const { conn } = fakeConn([[row({ last_date: null }), row({ customer_id: 'c2', since_date: null })]]);
    expect((await loadHomeFacts(conn, ['c1', 'c2'], NOW)).size).toBe(0);
  });

  test('one read for a short list: finished visits only, up to today in Eastern time, live customers only', async () => {
    const { conn, calls } = fakeConn([[]]);
    await loadHomeFacts(conn, ['c1', 'c1', null, 'c2'], NOW);
    expect(calls).toHaveLength(1);
    const ops = Object.fromEntries(calls[0].ops.map(([name, args]) => [name, args]));
    expect(calls[0].table).toBe('scheduled_services as s');
    expect(ops.whereIn).toEqual(['s.customer_id', ['c1', 'c2']]);
    expect(calls[0].ops).toContainEqual(['where', ['s.status', 'completed']]);
    expect(calls[0].ops).toContainEqual(['where', ['s.scheduled_date', '<=', '2026-11-21']]);
    expect(calls[0].ops).toContainEqual(['whereNull', ['c.deleted_at']]);
    expect(calls[0].ops).toContainEqual(['whereRaw', ['c.active IS DISTINCT FROM false']]);
  });

  test('today is the Eastern date: late evening on the 20th Eastern is still the 20th', async () => {
    const { conn, calls } = fakeConn([[]]);
    await loadHomeFacts(conn, ['c1'], new Date('2026-11-21T03:00:00Z'));
    expect(calls[0].ops).toContainEqual(['where', ['s.scheduled_date', '<=', '2026-11-20']]);
  });

  test('a long list is read in slices, and an empty list reads nothing', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `c${i}`);
    const { conn, calls } = fakeConn([[], [], []]);
    await loadHomeFacts(conn, ids, NOW);
    expect(calls.map((c) => c.ops.find(([n]) => n === 'whereIn')[1][1].length)).toEqual([1000, 1000, 500]);
    const none = fakeConn([]);
    expect((await loadHomeFacts(none.conn, [], NOW)).size).toBe(0);
    expect((await loadHomeFacts(none.conn, null, NOW)).size).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  test('a failed read throws, so the caller fails closed', async () => {
    const failing = () => new Proxy({}, { get: (_t, name) => (name === 'then' ? (_res, rej) => rej(new Error('db down')) : failing) });
    failing.raw = () => ({});
    await expect(loadHomeFacts(failing, ['c1'], NOW)).rejects.toThrow('db down');
  });
});

test('the tokens', () => {
  expect(HOME_TOKEN).toBe('{{pi-home}}');
  expect(HOME_TEXT_TOKEN).toBe('{{pi-home-text}}');
  expect(hasHomeToken(`x ${HOME_TOKEN}`)).toBe(true);
  expect(neutralizeHomeTokens(`a${HOME_TOKEN}b${HOME_TEXT_TOKEN}c`)).toBe('abc');
});
