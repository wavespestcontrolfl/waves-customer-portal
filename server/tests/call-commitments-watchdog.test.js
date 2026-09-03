// The overdue-promise bell: per-commitment per-day dedupe keys, the
// aggregate collapse, the gate, and the test-account filter. The queue read
// is mocked; the classifier is covered in call-commitments-queue.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: jest.fn((id) => id === 'test-account') }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));
jest.mock('../services/call-commitments', () => {
  const actual = jest.requireActual('../services/call-commitments');
  return { ...actual, listOpenCommitments: jest.fn(), refreshFulfillment: jest.fn(() => Promise.resolve({ fulfilled: 0 })), stillOpenIds: jest.fn(async (_conn, ids) => new Set(ids)) };
});

const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { listOpenCommitments, refreshFulfillment, stillOpenIds, OVERDUE_IMPLICIT_DAYS } = require('../services/call-commitments');
const { runCallCommitmentsWatchdog, AGGREGATE_THRESHOLD } = require('../services/call-commitments-watchdog');

const NOW = new Date('2026-09-05T15:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const row = (id, extra = {}) => ({
  id, call_log_id: `call-${id}`, status: 'open', party: 'waves', kind: 'callback', description: `Call back ${id}`,
  due_at: daysAgo(1), call_started_at: daysAgo(2), from_phone: '+15555550123', direction: 'inbound', customer_id: null, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n1' });
});

test('gated off → no-op, no query', async () => {
  isEnabled.mockReturnValue(false);
  expect(await runCallCommitmentsWatchdog({ now: NOW })).toEqual({ skipped: true, reason: 'gated_off' });
  expect(listOpenCommitments).not.toHaveBeenCalled();
});

test('one bell per overdue promise, keyed per commitment per ET day, linking to the Owed tab', async () => {
  listOpenCommitments.mockResolvedValue([
    row('a'),
    row('b', { due_at: null, kind: 'send_estimate', call_started_at: daysAgo(OVERDUE_IMPLICIT_DAYS + 2) }),
    row('c', { due_at: new Date(NOW.getTime() + 3600000).toISOString() }), // not due yet
    row('d', { customer_id: 'test-account' }), // demo account never rings
  ]);
  const result = await runCallCommitmentsWatchdog({ now: NOW });
  expect(result).toMatchObject({ scanned: 4, overdue: 2, alerted: 2, unannounced: 0 });
  const keys = NotificationService.notifyAdmin.mock.calls.map((c) => c[3].dedupeKey);
  expect(keys).toEqual(['call-commitment-overdue:a:2026-09-05', 'call-commitment-overdue:b:2026-09-05']);
  for (const call of NotificationService.notifyAdmin.mock.calls) {
    expect(call[3].bell).toBe(true);
    expect(call[3].link).toBe('/admin/communications#tab=owed');
    expect(call[2]).not.toContain('+15555550123'); // phones are masked in bell bodies
  }
});

test('a human-recorded promise reads as open since it was RECORDED, not since the older call (codex #3725 r18 P2)', async () => {
  listOpenCommitments.mockResolvedValue([
    row('h', { source: 'human', kind: 'send_report', due_at: null, call_started_at: daysAgo(40), created_at: daysAgo(OVERDUE_IMPLICIT_DAYS + 1) }),
  ]);
  const result = await runCallCommitmentsWatchdog({ now: NOW });
  expect(result).toMatchObject({ overdue: 1, alerted: 1 });
  const body = NotificationService.notifyAdmin.mock.calls[0][2];
  expect(body).toMatch(/open since Sep 1/);
  expect(body).not.toMatch(/Jul/);
});

test('a burst past the threshold collapses into one aggregate bell keyed on the DAY (refreshed in place when the set moves, never re-minted per batch)', async () => {
  listOpenCommitments.mockResolvedValue(Array.from({ length: AGGREGATE_THRESHOLD + 2 }, (_, i) => row(`r${i}`)));
  const result = await runCallCommitmentsWatchdog({ now: NOW });
  expect(result).toMatchObject({ overdue: AGGREGATE_THRESHOLD + 2, alerted: 1, aggregate: true });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [, title, , opts] = NotificationService.notifyAdmin.mock.calls[0];
  expect(title).toMatch(/promises to callers are overdue/);
  expect(opts.dedupeKey).toBe('call-commitments-overdue:2026-09-05');
  expect(opts.refreshOnDedupe).toBe(true);
  expect(opts.metadata.overdue_count).toBe(AGGREGATE_THRESHOLD + 2);
  expect(opts.metadata.overdue_commitment_ids).toHaveLength(AGGREGATE_THRESHOLD + 2);
  // A second run the same day with one item settled keys the SAME row.
  NotificationService.notifyAdmin.mockClear();
  listOpenCommitments.mockResolvedValue(Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => row(`r${i}`)));
  await runCallCommitmentsWatchdog({ now: NOW });
  expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toBe('call-commitments-overdue:2026-09-05');
  expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.overdue_count).toBe(AGGREGATE_THRESHOLD + 1);
});

test('a silenced or failed write is reported as unannounced, never as alerted', async () => {
  listOpenCommitments.mockResolvedValue([row('a')]);
  NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
  expect(await runCallCommitmentsWatchdog({ now: NOW })).toMatchObject({ overdue: 1, alerted: 0, unannounced: 1 });
});

test('fulfillment is refreshed for every candidate call before paging; a promise a later record kept is re-listed away and never rings', async () => {
  listOpenCommitments
    .mockResolvedValueOnce([row('a'), row('b', { call_log_id: 'call-a' })])
    .mockResolvedValueOnce([row('b', { call_log_id: 'call-a' })]);
  refreshFulfillment.mockResolvedValueOnce({ fulfilled: 1 });
  const out = await runCallCommitmentsWatchdog({ now: NOW });
  expect(refreshFulfillment).toHaveBeenCalledTimes(1);
  expect(refreshFulfillment).toHaveBeenCalledWith(expect.anything(), 'call-a');
  expect(listOpenCommitments).toHaveBeenCalledTimes(2);
  expect(out).toMatchObject({ overdue: 1, alerted: 1 });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toContain('call-commitment-overdue:b:');
});

test('a call whose fulfillment refresh FAILED is left out of the bell — its promise may already be kept — and reported as unverified', async () => {
  listOpenCommitments.mockResolvedValue([row('a'), row('b')]);
  refreshFulfillment.mockRejectedValueOnce(new Error('connection reset'));
  const out = await runCallCommitmentsWatchdog({ now: NOW });
  expect(refreshFulfillment).toHaveBeenCalledTimes(2);
  expect(out).toMatchObject({ overdue: 1, alerted: 1, unverified: 1 });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toContain('call-commitment-overdue:b:');
});

test('a refresh whose lookups failed (failed > 0 in the summary) also leaves that call out of the bell', async () => {
  listOpenCommitments.mockResolvedValue([row('a'), row('b')]);
  refreshFulfillment.mockResolvedValueOnce({ checked: 1, fulfilled: 0, hinted: 0, cleared: 0, failed: 1 });
  const out = await runCallCommitmentsWatchdog({ now: NOW });
  expect(out).toMatchObject({ overdue: 1, alerted: 1, unverified: 1 });
  expect(NotificationService.notifyAdmin.mock.calls[0][3].dedupeKey).toContain('call-commitment-overdue:b:');
});

test('a promise the office settled after the snapshot was taken never rings: rows are re-checked as still open right before paging; the bells carry the tech-visible trigger key', async () => {
  listOpenCommitments.mockResolvedValue([row('a'), row('b')]);
  stillOpenIds.mockResolvedValueOnce(new Set(['b']));
  const out = await runCallCommitmentsWatchdog({ now: NOW });
  expect(stillOpenIds).toHaveBeenCalledWith(expect.anything(), ['a', 'b']);
  expect(out).toMatchObject({ overdue: 1, alerted: 1 });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata).toMatchObject({ triggerKey: 'call_commitment_overdue', commitment_id: 'b' });
  expect(require('../services/notification-triggers').TRIGGER_REGISTRY.call_commitment_overdue.techVisible).toBe(true);
});

test('the scan walks every page: a full first page is followed by the next offset, and rows past page one still ring', async () => {
  const full = Array.from({ length: 200 }, (_, i) => row(`p1-${i}`, { due_at: null, call_started_at: daysAgo(0) })); // open, not overdue
  listOpenCommitments
    .mockResolvedValueOnce(full)
    .mockResolvedValueOnce([row('late')]); // page two: one overdue promise
  const out = await runCallCommitmentsWatchdog({ now: NOW });
  expect(listOpenCommitments).toHaveBeenCalledTimes(2);
  expect(listOpenCommitments.mock.calls[1][1]).toMatchObject({ offset: 200, limit: 200 });
  expect(out).toMatchObject({ scanned: 201, overdue: 1, alerted: 1 });
});

test('the cron treats a pool-exhausted skip as a failed daily run, not as the gate or a peer lease', () => {
  const fs = require('fs');
  const scheduler = fs.readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const at = scheduler.indexOf('const result = await runCallCommitmentsWatchdog();');
  expect(at).toBeGreaterThan(-1);
  const site = scheduler.slice(at, at + 1200);
  expect(site).toContain("result.reason !== 'gated_off' && result.reason !== 'lease_held'");
  expect(site).toContain("recordJobEnd('call-commitments-watchdog', t0, new Error(`tick skipped: ${result.reason || 'no_connection'}`))");
  expect(site).toContain('throw new Error(');
});

test('nothing overdue → quiet', async () => {
  listOpenCommitments.mockResolvedValue([row('c', { due_at: new Date(NOW.getTime() + 3600000).toISOString() })]);
  expect(await runCallCommitmentsWatchdog({ now: NOW })).toEqual({ skipped: false, scanned: 1, overdue: 0, alerted: 0, unverified: 0 });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});
