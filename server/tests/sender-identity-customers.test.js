/**
 * customerIdsBySenderIdentity: the ONE rule that says which live customers a
 * texting phone identity belongs to (the emitter names the sender with it and
 * the relevance sweep judges the bell with it). Query-shape fake: the identity
 * SQL itself is proved in admin-alert-relevance-db.test.js (CI, Postgres).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { customerIdsBySenderIdentity, PHONE_COLUMNS } = require('../services/sender-identity-customers');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function fakeConn(tables) {
  const queries = [];
  const conn = (table) => {
    const q = { table, calls: [], timeouts: [] };
    queries.push(q);
    const b = new Proxy({}, {
      get(_t, method) {
        if (method === 'then') {
          return (resolve, reject) => Promise.resolve(tables[table] || []).then(resolve, reject);
        }
        if (method === 'timeout') return (...a) => { q.timeouts.push(a); return b; };
        return (...a) => { q.calls.push([method, ...a]); return b; };
      },
    });
    return b;
  };
  conn.raw = (sql) => ({ raw: sql });
  conn.queries = queries;
  return conn;
}

describe('customerIdsBySenderIdentity', () => {
  test('one customers query over the four phone columns, each against the identity list', async () => {
    const conn = fakeConn({ customers: [{ id: A, peers: ['5555550142', '', '', ''] }] });
    const peers = await customerIdsBySenderIdentity(conn, ['5555550142']);
    expect([...peers.get('5555550142')]).toEqual([A]);
    const read = conn.queries.find((q) => q.table === 'customers');
    const raw = read.calls.find(([m, sql]) => m === 'whereRaw' && String(sql).includes('service_contact3_phone'));
    expect(PHONE_COLUMNS).toHaveLength(4);
    expect(String(raw[1]).match(/ = ANY\(\?\)/g)).toHaveLength(4);
    expect(read.calls.some(([m, col]) => m === 'whereNull' && col === 'deleted_at')).toBe(true);
  });

  test('a shared number (primary on one account, a service contact on another) gives two ids', async () => {
    const conn = fakeConn({ customers: [{ id: A, peers: ['5555550142'] }, { id: B, peers: ['5555550199', '5555550142'] }] });
    const peers = await customerIdsBySenderIdentity(conn, ['5555550142']);
    expect([...peers.get('5555550142')].sort()).toEqual([A, B]);
  });

  test('a live lead with that phone adds its LIVE customer; a deleted customer adds nobody; the same customer twice is one', async () => {
    const conn = fakeConn({
      customers: [{ id: A, peers: ['5555550142'] }],
      leads: [{ customer_id: A, peer: '5555550142' }, { customer_id: C, peer: '5555550142' }],
    });
    // The live-customer read answers only A (C is deleted, so it is not returned).
    const original = conn;
    const wrapped = (table) => {
      const b = original(table);
      return table === 'customers' && original.queries.length > 2
        ? new Proxy(b, { get: (t, m) => (m === 'then' ? (res) => Promise.resolve([{ id: A }]).then(res) : t[m]) })
        : b;
    };
    wrapped.raw = original.raw;
    wrapped.queries = original.queries;
    const peers = await customerIdsBySenderIdentity(wrapped, ['5555550142']);
    expect([...peers.get('5555550142')]).toEqual([A]);
  });

  test('an international identity is its own key: it never collects the customer of the same last 10 digits', async () => {
    const conn = fakeConn({ customers: [{ id: A, peers: ['7700900123'] }] });
    const peers = await customerIdsBySenderIdentity(conn, ['+447700900123']);
    expect(peers.get('+447700900123').size).toBe(0);
    expect(JSON.stringify(conn.queries.find((q) => q.table === 'customers').calls)).toContain('+447700900123');
  });

  test('timeoutMs bounds every query with a cancel timeout; with none, no timeout is applied', async () => {
    const bounded = fakeConn({ customers: [], leads: [{ customer_id: A, peer: '5555550142' }] });
    await customerIdsBySenderIdentity(bounded, ['5555550142'], { timeoutMs: 1000 });
    expect(bounded.queries.length).toBeGreaterThanOrEqual(3);
    for (const q of bounded.queries) expect(q.timeouts).toEqual([[1000, { cancel: true }]]);
    const open = fakeConn({ customers: [] });
    await customerIdsBySenderIdentity(open, ['5555550142']);
    for (const q of open.queries) expect(q.timeouts).toEqual([]);
  });
});
