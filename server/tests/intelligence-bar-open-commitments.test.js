// The Owed queue through the Intelligence Bar: read-only, the same read the
// Owed tab uses, customer resolved by name, overdue subset, Eastern times.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/call-commitments', () => {
  const actual = jest.requireActual('../services/call-commitments');
  return { ...actual, listOpenCommitments: jest.fn() };
});

const db = require('../models/db');
const { listOpenCommitments } = require('../services/call-commitments');
const { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');

const CUSTOMER_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const row = (id, extra = {}) => ({
  id, call_log_id: `call-${id}`, party: 'waves', kind: 'send_estimate', description: `Send estimate ${id}`, status: 'open', source: 'ai',
  extractor_version: 'commitments-v1', due_at: null, overdue: false, call_started_at: '2026-09-01T14:00:00Z', customer_id: CUSTOMER_ID,
  customer_first_name: 'Test', customer_last_name: 'Customer', fulfillment: null, ...extra,
});

beforeEach(() => { jest.clearAllMocks(); });

test('registered as a READ tool (no write gate) with a typed customer_id', () => {
  const tool = COMMS_TOOLS.find((t) => t.name === 'get_open_commitments');
  expect(tool).toBeDefined();
  expect(tool.input_schema.properties.customer_id.format).toBe('uuid');
  expect(COMMS_READ_TOOLS.map((t) => t.name)).toContain('get_open_commitments');
});

test('defaults to what Waves owes; overdue_only narrows; times are Eastern; the Owed tab link rides along', async () => {
  listOpenCommitments.mockResolvedValue([
    row('a', { overdue: true, due_at: '2026-09-01T13:00:00Z' }),
    // A callback with no stated time is implicitly due at the end of the
    // call's ET day — anchor this one to the exact current instant (no
    // offset: an hour back can cross ET midnight) so the fixture never
    // rots into "overdue" as the calendar moves (CI 2026-09-03).
    row('b', { kind: 'callback', extractor_version: 'relay-v1', call_started_at: new Date().toISOString() }),
  ]);
  const out = await executeCommsTool('get_open_commitments', { overdue_only: true });
  expect(listOpenCommitments).toHaveBeenCalledWith(db, expect.objectContaining({ party: 'waves', customerId: null, limit: 25 }));
  expect(out).toMatchObject({ enabled: true, total_open: 2, overdue: 1, link: '/admin/communications#tab=owed' });
  expect(out.commitments).toHaveLength(1);
  expect(out.commitments[0]).toMatchObject({ id: 'a', overdue: true, customer: 'Test Customer', source: 'AI' });
  // 13:00Z on Sept 1 is 9:00 AM EDT.
  expect(out.commitments[0].due_at).toBe('2026-09-01 9:00 AM ET');
  expect(out.commitments[0].effective_due_at).toBe('2026-09-01 9:00 AM ET');
  // The implicit rules ride along, and an undated row reports the deadline the queue judges it by.
  expect(out.implicit_due_rules).toMatchObject({ send_estimate: '24 hours after the call', other_prompts: '3 days after the call' });
  const all = await executeCommsTool('get_open_commitments', { party: 'all' });
  const undatedCallback = all.commitments.find((c) => c.id === 'b');
  expect(undatedCallback.due_at).toBeNull();
  expect(undatedCallback.effective_due_at).toMatch(/ 12:00 AM ET$/);
  expect(listOpenCommitments).toHaveBeenLastCalledWith(db, expect.objectContaining({ party: null }));
  expect(all.commitments.map((c) => c.source)).toEqual(['AI', 'AI phone assistant']);
});

test('resolves a customer by name; an unknown name answers with a note, never an unscoped read', async () => {
  const builder = { where: jest.fn(function () { return this; }), whereNull: jest.fn(function () { return this; }), limit: jest.fn(async () => [{ id: CUSTOMER_ID, first_name: 'Test', last_name: 'Customer' }]) };
  db.mockImplementation(() => builder);
  listOpenCommitments.mockResolvedValue([row('a')]);
  const out = await executeCommsTool('get_open_commitments', { customer_name: 'Test' });
  expect(listOpenCommitments).toHaveBeenCalledWith(db, expect.objectContaining({ customerId: CUSTOMER_ID }));
  expect(out.customer).toBe('Test Customer');
  builder.limit = jest.fn(async () => []);
  const none = await executeCommsTool('get_open_commitments', { customer_name: 'Nobody' });
  expect(none.commitments).toEqual([]);
  expect(listOpenCommitments).toHaveBeenCalledTimes(1);
});
