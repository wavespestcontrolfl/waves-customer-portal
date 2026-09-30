// loadWeek's own query shape (the compose tests inject rows): an unresolved
// send is loaded whatever its age, so a stuck row is never dropped from the
// weekly check just because its call fell out of the lookback (pre-push P1
// on #5358).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockCalls = [];
function mockBuilder(table) {
  const b = {};
  const record = (name) => (...args) => {
    mockCalls.push({ table, name, args });
    if (typeof args[0] === 'function' && name !== 'modify') args[0](b);
    return b;
  };
  for (const name of ['where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNull', 'select', 'count']) b[name] = record(name);
  b.modify = (fn) => { fn(b); return b; };
  b.first = async () => (table === 'job_health' ? { last_success_at: new Date(), consecutive_failures: 0 } : { n: '0' });
  b.then = (resolve) => resolve([]);
  return b;
}
jest.mock('../models/db', () => {
  const db = (table) => mockBuilder(table);
  db.raw = (sql, bindings) => ({ sql, bindings });
  return db;
});
jest.mock('../services/call-booking-link-text', () => ({
  GATE: 'callBookingLinkText',
  METADATA_KEY: 'call_booking_link_text',
  activationBoundary: async () => new Date('2026-09-30T00:41:59.000Z'),
}));

const { _private: { loadWeek } } = require('../services/call-booking-link-weekly-check');

test('the weekly read keeps pending and claimed rows of any age', async () => {
  await loadWeek(new Date('2026-10-05T12:19:00.000Z'));
  const statusOr = mockCalls.find((c) => c.table === 'call_log' && c.name === 'orWhereRaw' && /IN \(/.test(c.args[0]));
  expect(statusOr).toBeDefined();
  expect(statusOr.args[1]).toEqual(['call_booking_link_text', 'status', 'pending', 'claimed']);
  const created = mockCalls.find((c) => c.table === 'call_log' && c.name === 'where' && c.args[0] === 'created_at');
  expect(created).toBeDefined();
});

// codex #5358 r4 P2: a send or a final decision in the week is loaded by its
// own time, whatever the call's age.
test('the weekly read loads sends and decisions by their own time', async () => {
  mockCalls.length = 0;
  await loadWeek(new Date('2026-10-05T12:13:00.000Z'));
  const byTime = mockCalls.filter((c) => c.table === 'call_log' && c.name === 'orWhereRaw' && /timestamptz/.test(c.args[0]));
  expect(byTime.map((c) => c.args[1][1])).toEqual(['sent_at', 'decided_at']);
  const [, , start, , , end] = byTime[0].args[1];
  expect(start.toISOString()).toBe('2026-09-28T12:13:00.000Z');
  expect(end.toISOString()).toBe('2026-10-05T12:13:00.000Z');
});
