jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const db = require('../models/db');

function chain(result = []) {
  const q = {};
  ['where', 'andWhere', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhereNull', 'whereRaw', 'modify', 'select', 'orderBy', 'limit', 'leftJoin', 'join']
    .forEach((m) => { q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q, q); return q; }); });
  q.pluck = jest.fn(async () => []);
  q.update = jest.fn(async () => 0);
  q.del = jest.fn(async () => 0);
  q.first = jest.fn(async () => null);
  q.returning = jest.fn(async () => []);
  q.then = (res) => Promise.resolve(result).then(res);
  q.catch = (fn) => Promise.resolve(result).catch(fn);
  return q;
}
db.raw = jest.fn((sql) => ({ sql }));
db.transaction = jest.fn(async (fn) => fn(db));

test('a technician read scope excludes hidden recruiting rows; an admin scope does not', async () => {
  const { markInboundSmsRead } = require('../services/inbound-sms-read');
  const calls = [];
  db.mockImplementation((table) => { const q = chain([]); calls.push([table, q]); return q; });
  await markInboundSmsRead({ messageIds: ['m-1'], adminUserId: 'tech-1', role: 'technician' }).catch(() => {});
  const techScoped = calls.filter(([t]) => t === 'messages').some(([, q]) => q.orWhere.mock.calls.some((c) => c[0] === 'message_type' && c[1] === 'not like' && c[2] === 'job\\_%'));
  expect(techScoped).toBe(true);
  calls.length = 0;
  await markInboundSmsRead({ messageIds: ['m-1'], adminUserId: 'admin-1', role: 'admin' }).catch(() => {});
  const adminScoped = calls.filter(([t]) => t === 'messages').some(([, q]) => q.orWhere.mock.calls.some((c) => c[0] === 'message_type'));
  expect(adminScoped).toBe(false);
});
