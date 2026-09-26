// The one-hour follow-up pager (owner ruling 2026-09-26): the business-hour
// deadline, which promises count as missed, one bell per missed promise, and
// the rolling 24-hour list. The commitments read is mocked; fulfillment
// proof is covered in call-commitments tests.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: jest.fn((id) => id === 'test-account') }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));
jest.mock('../services/callback-cards', () => ({ ...jest.requireActual('../services/callback-cards'), enabled: jest.fn(() => true), prepareCallbackCards: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })) }));
jest.mock('../services/voice-agent/relay-protocol', () => ({ whereNotSandboxCall: jest.fn((qb) => qb.whereRaw('not_sandbox')) }));
jest.mock('../services/call-commitments', () => {
  const actual = jest.requireActual('../services/call-commitments');
  return { ...actual, listOpenCommitments: jest.fn(), refreshFulfillment: jest.fn(() => Promise.resolve({ fulfilled: 0 })), stillOpenIds: jest.fn(async (_conn, ids) => new Set(ids)) };
});

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { listOpenCommitments, refreshFulfillment, stillOpenIds } = require('../services/call-commitments');
const {
  runFollowUpSlaWatcher, followUpDueAt, selectMissed, slaOwnedIds, pagerHealthy, lastScheduledTick, ROLLING_KEY,
} = require('../services/followup-sla-watcher');

// ET is UTC-4 in late September.
const et = (hhmm, day = '2026-09-26') => new Date(`${day}T${hhmm}:00-04:00`);

describe('followUpDueAt — one hour of 8 AM–8 PM ET time', () => {
  test.each([
    ['2:15 PM → 3:15 PM', et('14:15'), et('15:15')],
    ['7:30 PM → 8:30 AM next day', et('19:30'), et('08:30', '2026-09-27')],
    ['11 PM → 9 AM next day', et('23:00'), et('09:00', '2026-09-27')],
    ['7:59 AM → 9 AM', et('07:59'), et('09:00')],
    ['exactly 7 PM → 8 PM', et('19:00'), et('20:00')],
  ])('%s', (_label, promised, due) => {
    expect(followUpDueAt(promised).toISOString()).toBe(due.toISOString());
  });

  test('a closed office day (holiday) does not count: 7:30 PM Dec 23 with Dec 24–25 closed is due 8:30 AM Dec 26', () => {
    const calendar = { start: '08:00', end: '20:00', closed: new Set(['2026-12-24', '2026-12-25']) };
    expect(followUpDueAt(new Date('2026-12-23T19:30:00-05:00'), calendar).toISOString())
      .toBe(new Date('2026-12-26T08:30:00-05:00').toISOString());
  });

  test('across the fall-back DST change the next morning is still 8:30 AM local', () => {
    // Nov 1 2026: clocks fall back overnight (EDT -4 → EST -5).
    expect(followUpDueAt(new Date('2026-10-31T19:30:00-04:00')).toISOString())
      .toBe(new Date('2026-11-01T08:30:00-05:00').toISOString());
  });
});

const NOW = et('16:00');
const row = (id, extra = {}) => ({
  id, call_log_id: `call-${id}`, status: 'open', party: 'waves', kind: 'callback', source: 'ai',
  call_started_at: et('14:00').toISOString(), due_at: null, customer_id: `cust-${id}`,
  customer_first_name: 'Test', customer_last_name: 'Caller', direction: 'inbound', ...extra,
});

describe('selectMissed', () => {
  test('keeps a promise whose deadline passed within the last 24 hours, oldest first', () => {
    const out = selectMissed([
      row('late'), // due 3 PM, now 4 PM
      row('notyet', { call_started_at: et('15:30').toISOString() }), // due 4:30 PM
      row('old', { call_started_at: et('09:00', '2026-09-25').toISOString() }), // due yesterday 10 AM (>24h)
      row('est', { kind: 'send_estimate', call_started_at: et('13:00').toISOString() }),
      row('other', { kind: 'send_report' }),
      row('cust', { party: 'customer' }),
      row('dismissed', { human_state: 'dismissed' }),
      row('demo', { customer_id: 'test-account' }),
    ], { now: NOW });
    expect(out.map((r) => r.id)).toEqual(['est', 'late']);
  });

  test('a stated time wins over the one-hour rule, and a snooze postpones it', () => {
    expect(selectMissed([row('stated', { due_at: et('17:00').toISOString() })], { now: NOW })).toEqual([]);
    expect(selectMissed([row('snoozed', { snoozed_until: et('16:30').toISOString() })], { now: NOW })).toEqual([]);
  });
});

// One chainable Knex stand-in for every test: each query is logged as
// { table, calls: [[method, ...args]] } so a test can assert what was asked,
// and `first`/`select`/`update` answer from the scenario given to mockDb.
let log = [];
function mockDb({ activity = {}, call = null, standingRow = null, settled = [], lockedStamp = {}, hints = {} } = {}) {
  log = [];
  const updates = [];
  db.raw = (sql) => sql;
  db.transaction = async (fn) => fn(db);
  db.mockImplementation((tableRaw) => {
    const table = String(tableRaw).split(' ')[0];
    const entry = { table, calls: [] };
    log.push(entry);
    const q = {};
    const chain = (name) => (...args) => {
      entry.calls.push([name, ...args]);
      if (typeof args[0] === 'function') args[0].call(q, q);
      return q;
    };
    for (const name of ['where', 'orWhere', 'orWhereRaw', 'whereRaw', 'whereNot', 'whereNull', 'whereNotNull', 'orWhereNotNull', 'whereIn',
      'orWhereIn', 'whereNotExists', 'whereNotIn', 'forUpdate', 'orderBy']) q[name] = chain(name);
    q.modify = (fn) => { fn(q); return q; };
    q.first = async () => {
      if (table === 'call_commitments') {
        const id = entry.calls.find(([m, a]) => m === 'where' && a && typeof a === 'object' && 'id' in a)?.[1].id;
        return settled.includes(id) ? null : { id };
      }
      if (table === 'notifications') return standingRow;
      return activity[table] ? { id: 'x' } : null;
    };
    q.select = async (...cols) => {
      if (table === 'call_log' && cols.includes('duration_seconds')) return call ? [call] : [];
      if (['scheduled_services', 'call_log', 'sms_log'].includes(table)) {
        const on = typeof activity[table] === 'function' ? activity[table]() : activity[table];
        if (!on) return [];
        // One far-future record per contact the query asked about.
        const ins = entry.calls.filter(([m]) => m === 'whereIn');
        const custs = ins.filter(([, col]) => col === 'customer_id').flatMap(([, , v]) => v);
        const phones = entry.calls.filter(([m, sql]) => (m === 'whereRaw' || m === 'orWhereRaw') && /regexp_replace\(COALESCE/.test(sql)).flatMap(([, , v]) => v);
        return [...custs.map((c) => ({ id: 'x', customer_id: c, created_at: '2100-01-01T00:00:00Z' })),
          ...phones.map((p) => ({ id: 'x', customer_id: null, to_phone: p, created_at: '2100-01-01T00:00:00Z' }))];
      }
      if (table === 'call_commitments' && cols.includes('fulfillment')) {
        const ids = entry.calls.filter(([m]) => m === 'whereIn').flatMap(([, , v]) => v);
        return ids.filter((id) => hints[id]).map((id) => ({ id, fulfillment: hints[id] }));
      }
      if (table === 'call_commitments') {
        const ids = argsOf('call_commitments', 'whereIn').flatMap(([, v]) => v);
        return ids.filter((id) => !settled.includes(id)).map((id) => ({ id, status: 'open', human_state: null, updated_at: lockedStamp[id] || null }));
      }
      return [];
    };
    q.update = async (patch) => { updates.push({ table, patch }); return 1; };
    return q;
  });
  return updates;
}
const queriesOn = (table) => log.filter((e) => e.table === table);
const argsOf = (table, method) => queriesOn(table).flatMap((e) => e.calls.filter(([m]) => m === method).map(([, ...a]) => a));

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n1', deduped: false });
  refreshFulfillment.mockResolvedValue({ fulfilled: 0 });
  stillOpenIds.mockImplementation(async (_conn, ids) => new Set(ids));
});

const rollingCall = () => NotificationService.notifyAdmin.mock.calls.find((c) => c[3].dedupeKey.startsWith(`${ROLLING_KEY}:`));
const posted = (ids, extra = {}) => ({ id: 'n0', read_at: null, metadata: { dedupeKey: `${ROLLING_KEY}:2026-09-26T19:00:00.000Z`, missed_commitment_ids: ids, ...extra } });

test('gated off → no-op', async () => {
  isEnabled.mockReturnValue(false);
  expect(await runFollowUpSlaWatcher({ now: NOW })).toEqual({ skipped: true, reason: 'gated_off' });
  expect(listOpenCommitments).not.toHaveBeenCalled();
});

test('a new miss posts the rolling list fresh, unread, at the top of the feed', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('a')]);
  const result = await runFollowUpSlaWatcher({ now: NOW });
  expect(result).toMatchObject({ missed: 1, alerted: 1 });
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  const [, title, body, opts] = rollingCall();
  expect(title).toBe('1 missed follow-up in the last 24 hours');
  expect(body).toContain('callback promised to Test Caller');
  expect(opts).toMatchObject({ dedupeKey: `${ROLLING_KEY}:${NOW.toISOString()}`, bell: true, metadata: { missed_commitment_ids: ['a'] } });
  // Posted inside the same transaction that retires the older posts.
  expect(opts.trx).toBe(db);
});

test('the rolling list has no cap', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue(Array.from({ length: 12 }, (_, i) => row(`r${i}`)));
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(12);
  expect(rollingCall()[1]).toBe('12 missed follow-ups in the last 24 hours');
  expect(rollingCall()[2].split('\n').filter((l) => l.startsWith('•'))).toHaveLength(12);
});

test('the same list as the latest post — read or not — is not re-posted', async () => {
  const updates = mockDb({ standingRow: { ...posted(['a']), read_at: NOW } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).alerted).toBe(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  // At most a quiet in-place refresh of its text — never back to unread.
  expect(updates.every((u) => u.patch.read_at === undefined)).toBe(true);
});

test('a listed promise whose details changed is rewritten in place, read state kept', async () => {
  const updates = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title: '1 missed follow-up in the last 24 hours', body: 'old text' } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.body).toContain('callback promised to Test Caller');
  expect(updates[0].patch.read_at).toBeUndefined();
});

test('a new miss joining the list re-posts it and retires the older post', async () => {
  const updates = mockDb({ standingRow: posted(['a']) });
  listOpenCommitments.mockResolvedValue([row('a'), row('b', { call_log_id: 'call-b' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).alerted).toBe(1);
  expect(rollingCall()[1]).toBe('2 missed follow-ups in the last 24 hours');
  expect(updates).toEqual([{ table: 'notifications', patch: { read_at: NOW } }]);
});

test('items only dropping off rewrite the latest post in place, read state kept — no new ping', async () => {
  const updates = mockDb({ standingRow: posted(['a', 'b']) });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.title).toBe('1 missed follow-up in the last 24 hours');
  expect(updates[0].patch.read_at).toBeUndefined();
  expect(JSON.parse(updates[0].patch.metadata).missed_commitment_ids).toEqual(['a']);
});

test('an emptied list is retired and flagged, so a miss that returns later (e.g. after a snooze) is posted fresh', async () => {
  const updates = mockDb({ standingRow: posted(['a']) });
  listOpenCommitments.mockResolvedValue([]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.read_at).toBe(NOW);
  expect(JSON.parse(updates[0].patch.metadata).emptied).toBe(true);

  mockDb({ standingRow: { ...posted(['a'], { emptied: true }), read_at: NOW } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).alerted).toBe(1);
});

test('the clock starts when the promise call ENDED — a 45-minute call is not due 15 minutes after it', async () => {
  mockDb({ call: { id: 'call-a', created_at: et('14:00').toISOString(), duration_seconds: 45 * 60, direction: 'inbound' } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect((await runFollowUpSlaWatcher({ now: et('15:30') })).candidates).toBe(0);
});

test('evidence starts when the promise call ENDED — a text sent during the call does not count', async () => {
  mockDb({ call: { id: 'call-a', created_at: et('14:00').toISOString(), duration_seconds: 600, direction: 'inbound' } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  const since = argsOf('sms_log', 'where').filter(([col]) => col === 'created_at').map(([, , v]) => new Date(v).toISOString());
  // Scan and the re-check under the lock both start at the call's end.
  expect(since.length).toBeGreaterThan(0);
  expect(new Set(since)).toEqual(new Set([et('14:10').toISOString()]));
});

test.each([
  ['a visit booked since', 'scheduled_services'],
  ['a connected outbound call since', 'call_log'],
  ['a staff-typed text since', 'sms_log'],
])('%s counts as followed up — nothing posted', async (_label, table) => {
  mockDb({ activity: { [table]: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('a promise the fulfillment proof closes, or staff settled, dismissed or snoozed, is not listed', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('a')]);
  stillOpenIds.mockResolvedValue(new Set());
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('one unverifiable call never holds back the other misses — they publish, and the tick still fails job health', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('a'), row('b', { call_log_id: 'call-b' })]);
  refreshFulfillment.mockImplementation(async (_conn, id) => (id === 'call-b' ? { failed: 1 } : { fulfilled: 0 }));
  await expect(runFollowUpSlaWatcher({ now: NOW })).rejects.toThrow('Follow-up verification incomplete for 1 call(s)');
  expect(rollingCall()[3].metadata.missed_commitment_ids).toEqual(['a']);
});

test('a promise already on the list stays on it while its call cannot be verified', async () => {
  mockDb({ standingRow: posted(['b']) });
  listOpenCommitments.mockResolvedValue([row('a'), row('b', { call_log_id: 'call-b' })]);
  refreshFulfillment.mockImplementation(async (_conn, id) => (id === 'call-b' ? { failed: 1 } : { fulfilled: 0 }));
  await expect(runFollowUpSlaWatcher({ now: NOW })).rejects.toThrow('verification incomplete');
  expect(rollingCall()[3].metadata.missed_commitment_ids).toEqual(['a', 'b']);
});

test('a lead with no customer record is checked by the number the promise was made on', async () => {
  mockDb({ activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('lead', { customer_id: null, from_phone: '+19415550123' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  const keyed = (t) => [...argsOf(t, 'whereRaw'), ...argsOf(t, 'orWhereRaw')].filter(([sql]) => /regexp_replace\(COALESCE/.test(sql)).map(([, v]) => v);
  expect(keyed('call_log')).toContainEqual(['9415550123', '19415550123']);
  expect(keyed('sms_log')).toContainEqual(['9415550123', '19415550123']);
  // No customer holds that number in this fixture, so no visit lookup.
  expect(queriesOn('scheduled_services')).toHaveLength(0);
});

test('a lead who became a customer through the follow-up still matches by number — calls, texts and bookings', async () => {
  mockDb();
  const base = db.getMockImplementation();
  db.mockImplementation((t) => {
    const q = base(t);
    if (t === 'customers') q.select = async () => [{ id: 'new-cust', phone: '+1 (941) 555-0123' }];
    if (t === 'scheduled_services') q.select = async () => [{ customer_id: 'new-cust', created_at: '2100-01-01T00:00:00Z' }];
    return q;
  });
  listOpenCommitments.mockResolvedValue([row('lead', { customer_id: null, from_phone: '9415550123' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(argsOf('scheduled_services', 'whereIn')).toContainEqual(['customer_id', ['new-cust']]);
});

test('only a text that actually went out counts — scheduled, reserved and failed rows are excluded', async () => {
  mockDb({ activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('sms_log', 'whereIn')).toContainEqual(['status', ['queued', 'sent', 'delivered']]);
});

test('a text counts only when a person typed it: manual AND a staff sender (automated texts with an admin id do not)', async () => {
  mockDb({ activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('sms_log', 'where')).toContainEqual(['message_type', 'manual']);
  expect(argsOf('sms_log', 'whereNotNull')).toEqual([['admin_user_id']]);
});

test.each(['send_estimate', 'schedule_visit'])('a connected call counts on a %s promise too — completed 60 s+ customer leg, affirmatively not voicemail', async (kind) => {
  mockDb({ activity: { call_log: true } });
  listOpenCommitments.mockResolvedValue([row('a', { kind, call_started_at: et('13:00').toISOString() })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  const raws = argsOf('call_log', 'whereRaw').map(([sql]) => sql).join(' ');
  expect(raws).toMatch(/customer_leg'->>'status' = 'completed'/);
  expect(raws).toMatch(/>= 60/);
  expect(raws).toMatch(/is_voicemail' = 'false'/);
  expect(argsOf('call_log', 'where')).toContainEqual(['v2_extraction_status', 'valid']);
});

test('the scan asks only for promises that can fall due inside the window, so a backlog cannot crowd them out', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([]);
  await runFollowUpSlaWatcher({ now: NOW });
  const { activeSince } = listOpenCommitments.mock.calls[0][1];
  expect(NOW.getTime() - activeSince.getTime()).toBe((24 + 7 * 24) * 60 * 60 * 1000);
});

test('only a booking someone made counts — generated series children (top-up, seeded follow-ups) do not', async () => {
  mockDb({ activity: { scheduled_services: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('scheduled_services', 'whereNull')).toEqual([['recurring_parent_id'], ['parent_service_id']]);
  // A booking later cancelled does not count either.
  expect(argsOf('scheduled_services', 'whereNotIn')).toEqual([['status', ['cancelled', 'canceled']]]);
});

test('slaOwnedIds: the pager owns SLA-kind promises until they age off its 24-hour list', async () => {
  mockDb({ call: { id: 'call-a', created_at: et('14:00').toISOString(), duration_seconds: 600, direction: 'inbound' } });
  const owned = await slaOwnedIds(db, [
    row('a'), // due 15:10 today — on the list
    row('future', { call_log_id: 'call-f', call_started_at: et('15:50').toISOString() }), // not due yet — still the pager's
    row('aged', { call_log_id: 'call-x', call_started_at: et('09:00', '2026-09-25').toISOString() }), // due yesterday 10 AM — handed back
    row('report', { kind: 'send_report' }), // not an SLA kind
  ], NOW);
  expect([...owned].sort()).toEqual(['a', 'future']);
});

test('a promise staff have touched (confirmed, edited, reopened, dismissed) or entered by hand is out of the pager scope, so it stays with the Owed queue', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([
    row('confirmed', { human_state: 'confirmed' }),
    row('edited', { kind: 'send_estimate', human_state: 'edited' }),
    row('byhand', { source: 'human', created_at: et('14:00').toISOString() }),
  ]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).candidates).toBe(0);
  expect([...await slaOwnedIds(db, [row('confirmed', { human_state: 'confirmed' }), row('a')], NOW)]).toEqual(['a']);
});

test('activity that lands after the scan but before publishing is caught by the re-check under the lock', async () => {
  let smsReads = 0;
  mockDb({ activity: { sms_log: () => (smsReads += 1) > 1 } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect(await runFollowUpSlaWatcher({ now: NOW })).toMatchObject({ changed: 1, alerted: 0 });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('the re-check under the lock is batched — three queries however many promises are listed', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue(Array.from({ length: 12 }, (_, i) => row(`r${i}`)));
  await runFollowUpSlaWatcher({ now: NOW });
  // Scan + re-check: two passes, each one query per evidence table.
  expect(queriesOn('sms_log')).toHaveLength(2);
  expect(queriesOn('scheduled_services')).toHaveLength(2);
});

test('after a callback-card rollback a stored snooze postpones nothing', () => {
  const cards = require('../services/callback-cards');
  cards.enabled.mockReturnValueOnce(false);
  expect(selectMissed([row('snoozed', { snoozed_until: et('16:30').toISOString() })], { now: NOW }).map((r) => r.id)).toEqual(['snoozed']);
});

test('a voice sandbox test call is never follow-up evidence', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('call_log', 'whereRaw').map(([sql]) => sql)).toContain('not_sandbox');
});

test('a promise staff changed or settled during the tick (row reloaded under lock) holds the whole list for the next tick', async () => {
  mockDb({ lockedStamp: { a: '2026-09-26T19:55:00.000Z' } });
  listOpenCommitments.mockResolvedValue([row('a', { updated_at: '2026-09-26T18:00:00.000Z' })]);
  expect(await runFollowUpSlaWatcher({ now: NOW })).toMatchObject({ missed: 1, changed: 1, alerted: 0 });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();

  mockDb({ settled: ['a'] });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect(await runFollowUpSlaWatcher({ now: NOW })).toMatchObject({ changed: 1, alerted: 0 });
  expect(argsOf('call_commitments', 'forUpdate')).toHaveLength(1);
});

test('the tick reads the office closure calendar for the scan window', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([]);
  await runFollowUpSlaWatcher({ now: NOW });
  const { getBlackoutLayers } = require('../services/scheduling/blackout-dates');
  expect(getBlackoutLayers).toHaveBeenCalled();
});

describe('pagerHealthy — judged against the pager schedule', () => {
  test.each([
    ['2:07 PM → the 2:00 PM tick', et('14:07'), et('14:00')],
    ['11 PM → the 8:45 PM tick', et('23:00'), et('20:45')],
    ['6 AM → the previous 8:45 PM tick', et('06:00', '2026-09-27'), et('20:45')],
  ])('%s', (_label, now, tick) => {
    expect(lastScheduledTick(now).toISOString()).toBe(tick.toISOString());
  });

  const healthAt = (lastSuccess) => {
    db.mockImplementation(() => { const q = {}; q.where = () => q; q.first = async () => (lastSuccess ? { last_success_at: lastSuccess } : null); return q; });
  };
  test('a success at or after the latest tick (minus slack) is healthy; an older one, or none, is not', async () => {
    healthAt(et('20:46').toISOString());
    expect(await pagerHealthy(db, et('06:00', '2026-09-27'))).toBe(true);
    healthAt(et('14:00').toISOString());
    expect(await pagerHealthy(db, et('06:00', '2026-09-27'))).toBe(false);
    healthAt(null);
    expect(await pagerHealthy(db, NOW)).toBe(false);
  });
});

test('a floor time ("send it after the inspection") starts the one-hour clock; only a deadline is the deadline itself', () => {
  const floor = row('floor', { due_at: et('15:30').toISOString(), due_type: 'floor' }); // due 16:30
  const untyped = row('untyped', { due_at: et('15:30').toISOString() }); // a missing type is a floor too
  const deadline = row('deadline', { due_at: et('15:30').toISOString(), due_type: 'deadline' }); // due 15:30
  expect(selectMissed([floor, untyped, deadline], { now: NOW }).map((r) => r.id)).toEqual(['deadline']);
});

test('an unlinked lead matches follow-up however its number was written', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('lead', { customer_id: null, from_phone: '(941) 555-0123' })]);
  await runFollowUpSlaWatcher({ now: NOW });
  const raw = argsOf('sms_log', 'orWhereRaw').find(([sql]) => /regexp_replace\(COALESCE/.test(sql));
  expect(raw[1]).toEqual(['9415550123', '19415550123']);
});

test('takeoverIds: only promises that aged off the list within the last hour', async () => {
  mockDb();
  const owned = await require('../services/followup-sla-watcher').takeoverIds(db, [
    row('justAged', { call_started_at: et('14:30', '2026-09-25').toISOString() }), // due 15:30 yesterday — aged off 30 min ago
    row('stillListed', { call_started_at: et('16:00', '2026-09-25').toISOString() }), // due 17:00 yesterday
    row('longGone', { call_started_at: et('09:00', '2026-09-25').toISOString() }), // due 10:00 yesterday
  ], NOW);
  expect([...owned]).toEqual(['justAged']);
});

test('a quote delivered to the customer (the proof\'s association hint) counts as follow-up', async () => {
  mockDb({ hints: { q: JSON.stringify({ kind: 'estimate_sent', strength: 'association' }) } });
  listOpenCommitments.mockResolvedValue([row('q', { kind: 'send_estimate', call_started_at: et('13:00').toISOString() })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('at the 8:00 AM opening tick the pager is judged against last night\'s 8:45 PM run, not the run still in progress', async () => {
  db.mockImplementation(() => { const q = {}; q.where = () => q; q.first = async () => ({ last_success_at: et('20:46', '2026-09-26').toISOString() }); return q; });
  expect(await pagerHealthy(db, et('08:00', '2026-09-27'))).toBe(true);
  expect(await pagerHealthy(db, et('08:05', '2026-09-27'))).toBe(true);
});

test('an in-place rewrite stores admin text emoji-stripped, like a fresh post', async () => {
  const updates = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title: 'x', body: 'old text' } });
  listOpenCommitments.mockResolvedValue([row('a', { customer_first_name: 'Test\u{1F41B}' })]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(updates[0].patch.body).not.toMatch(/\u{1F41B}/u);
});
