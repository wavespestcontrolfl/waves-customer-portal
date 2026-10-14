// GATE_SMS_SHARED_PHONE_LINK (codex #6268 r14): a text linked through the
// shared-phone primary mark joins the customer's thread as that one message.
// The number's earlier unknown-contact thread (and every message in it) is
// NOT promoted into the marked account — some of those messages may belong
// to the other account on the phone. Without the flag, promotion runs as before.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCalls = [];
const mockState = { customerThread: null, unknownThread: null };
function mockChain(table) {
  const c = { _table: table, _ops: [] };
  const rec = (op) => (...args) => { c._ops.push([op, ...args]); return c; };
  c.where = rec('where'); c.whereNull = rec('whereNull'); c.whereRaw = rec('whereRaw');
  c.orderBy = rec('orderBy'); c.limit = rec('limit'); c.forUpdate = rec('forUpdate');
  c.first = async () => {
    const whereCustomer = c._ops.some(([op, a]) => op === 'where' && a && typeof a === 'object' && a.customer_id);
    if (table === 'conversations' && whereCustomer) return mockState.customerThread;
    if (table === 'conversations' && c._ops.some(([op]) => op === 'whereRaw')) return mockState.unknownThread;
    return null;
  };
  c.update = (patch) => {
    mockCalls.push(['update', table, patch]);
    const done = Promise.resolve(1);
    return { then: done.then.bind(done), catch: done.catch.bind(done), returning: async () => [{ id: 'promoted', ...patch }] };
  };
  c.insert = (rowIn) => ({ returning: async () => { mockCalls.push(['insert', table, rowIn]); return [{ id: 'new-thread', ...rowIn }]; } });
  c.count = async () => [{ count: 0 }];
  return c;
}
const mockDb = jest.fn((table) => mockChain(table));
mockDb.raw = jest.fn(async () => ({ rows: [] }));
mockDb.fn = { now: () => new Date() };
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);

const { findOrCreateThread } = require('../services/conversations');

beforeEach(() => { mockCalls.length = 0; mockState.customerThread = null; mockState.unknownThread = { id: 'unknown-1', customer_id: null, contact_phone: '+19415550100' }; });

const base = { customerId: 'cust-a', channel: 'sms', ourEndpointId: '+19410000000', contactPhone: '+19415550100' };

test('preserveUnknownThread: an existing customer thread is returned and the unknown thread is left alone', async () => {
  mockState.customerThread = { id: 'thread-a', customer_id: 'cust-a' };
  const t = await findOrCreateThread({ ...base, preserveUnknownThread: true });
  expect(t.id).toBe('thread-a');
  expect(mockCalls).toEqual([]);
});

test('preserveUnknownThread: with no customer thread a NEW one is inserted; the unknown thread is not promoted', async () => {
  const t = await findOrCreateThread({ ...base, preserveUnknownThread: true });
  expect(t.id).toBe('new-thread');
  expect(mockCalls.filter(([op]) => op === 'update')).toEqual([]);
  expect(mockCalls.filter(([op, table]) => op === 'insert' && table === 'conversations')).toHaveLength(1);
});

test('without the flag the unknown thread is promoted as before', async () => {
  const t = await findOrCreateThread(base);
  expect(mockCalls.some(([op, table, patch]) => op === 'update' && table === 'conversations' && patch.customer_id === 'cust-a')).toBe(true);
  expect(t).toBeTruthy();
});
