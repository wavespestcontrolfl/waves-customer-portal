// The one-hour follow-up pager (owner ruling 2026-09-26): the business-hour
// deadline, which promises count as missed, one bell per missed promise, and
// the rolling 24-hour list. The commitments read is mocked; fulfillment
// proof is covered in call-commitments tests.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(),
  // A system retire closes the row done (read is not done).
  _private: { openToCloser: jest.fn((q) => q.where((open) => open.whereNull('done_at').orWhereRaw('COALESCE(person_done_by, false)'))), doneColumns: jest.fn(({ by, resolution }) => ({ done_at: 'DONE_AT', done_by: by, resolution, read_at: 'DONE_AT' })) },
  // The real guard, so an in-place rewrite is judged on the text a fresh post stores.
  normalizeAdminText: (...args) => jest.requireActual('../services/notification-service').normalizeAdminText(...args),
}));
jest.mock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: jest.fn((id) => id === 'test-account') }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false), adminBodyGuardAllLive: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));
jest.mock('../services/callback-cards', () => ({ ...jest.requireActual('../services/callback-cards'), enabled: jest.fn(() => true), prepareCallbackCards: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })) }));
jest.mock('../services/voice-agent/relay-protocol', () => ({ whereNotSandboxCall: jest.fn((qb) => qb.whereRaw('not_sandbox')) }));
jest.mock('../services/call-commitments', () => {
  const actual = jest.requireActual('../services/call-commitments');
  return {
    ...actual,
    listOpenCommitments: jest.fn(),
    refreshFulfillment: jest.fn(() => Promise.resolve({ fulfilled: 0 })),
    stillOpenIds: jest.fn(async (_conn, ids) => new Set(ids)),
    // Defaults to the real implementation; individual tests override with
    // mockRejectedValueOnce to prove a failure propagates rather than
    // silently reading as "no renewal".
    obligationRenewedAt: jest.fn(actual.obligationRenewedAt),
    // Callback promises ask whether an estimate is the call's OWN quote.
    directEstimatesSentAfter: jest.fn(async () => new Map()),
  };
});

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { isEnabled } = require('../config/feature-gates');
const { listOpenCommitments, refreshFulfillment, stillOpenIds, obligationRenewedAt, directEstimatesSentAfter } = require('../services/call-commitments');
const {
  runFollowUpSlaWatcher, followUpDueAt, selectMissed, slaOwnedIds, pagerHealthy, lastScheduledTick, followedUpIds, ROLLING_KEY,
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
// A person's call that reached the customer, and a person's delivered text,
// as staff-contact.js reads them (personCallBack / operatorReply + smsDelivered).
const STAFF_CONTACT = {
  call_log: { source: 'admin-click', v2_extraction_status: 'valid', is_voicemail: 'false' },
  sms_log: { status: 'delivered', message_type: 'manual', operator_sent: true },
};
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
      if (table === 'call_log' && cols.includes('twilio_call_sid') && !cols.includes('duration_seconds')) {
        // The promise calls the callback quote check reads (SID, linkage, number).
        const ids = entry.calls.filter(([m, col]) => m === 'whereIn' && col === 'id').flatMap(([, , v]) => v);
        return ids.map((id) => ({ id, twilio_call_sid: `CA${id}`, created_at: et('14:00').toISOString(), customer_id: null,
          from_phone: '+19415550123', to_phone: '+19415550100', direction: 'inbound' }));
      }
      if (['scheduled_services', 'call_log', 'sms_log'].includes(table)) {
        const on = typeof activity[table] === 'function' ? activity[table]() : activity[table];
        if (!on) return [];
        // One far-future record per contact the query asked about: by default
        // a person's call that reached the customer, or a person's delivered
        // text (the fields staff-contact.js reads); an object overrides them.
        const fields = { ...STAFF_CONTACT[table], ...(typeof on === 'object' ? on : {}) };
        const ins = entry.calls.filter(([m]) => m === 'whereIn');
        const custs = ins.filter(([, col]) => col === 'customer_id').flatMap(([, , v]) => v);
        const phones = entry.calls.filter(([m, sql]) => (m === 'whereRaw' || m === 'orWhereRaw') && /regexp_replace\(COALESCE/.test(sql)).flatMap(([, , v]) => v);
        return [...custs.map((c) => ({ id: 'x', customer_id: c, created_at: '2100-01-01T00:00:00Z', ...fields })),
          ...phones.map((p) => ({ id: 'x', customer_id: null, to_phone: p, created_at: '2100-01-01T00:00:00Z', ...fields }))];
      }
      if (table === 'estimates') {
        const on = typeof activity.estimates === 'function' ? activity.estimates() : activity.estimates;
        if (!on) return [];
        // One estimate with a real handoff long after the promise; the
        // unowned-phone read gets the number it asked about.
        const phones = entry.calls.filter(([m, sql]) => m === 'whereRaw' && /regexp_replace\(COALESCE/.test(sql)).flatMap(([, , v]) => v);
        const fields = typeof on === 'object' ? on : {};
        // The canonical ownership fence binds the customer id (five times).
        const custs = entry.calls.filter(([m, sql]) => m === 'whereRaw' && /estimates\.customer_id = \?/.test(sql)).map(([, , v]) => v[0]);
        const base = { handed_off_at: '2100-01-01T00:00:00Z', ...fields };
        if (custs.length) return custs.map((c) => ({ id: `est-${c}`, customer_id: c, customer_phone: null, ...base }));
        return [{ id: 'est-1', customer_id: null, customer_phone: phones[0] || null, ...base }];
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
  directEstimatesSentAfter.mockResolvedValue(new Map());
});

const rollingCall = () => NotificationService.notifyAdmin.mock.calls.find((c) => c[3].dedupeKey.startsWith(`${ROLLING_KEY}:`));
const posted = (ids, extra = {}) => ({ id: 'n0', read_at: null, metadata: { dedupeKey: `${ROLLING_KEY}:2026-09-26T19:00:00.000Z`, missed_commitment_ids: ids, ...extra } });

test('gated off → no scan, and any standing list is retired', async () => {
  const updates = mockDb();
  isEnabled.mockReturnValue(false);
  expect(await runFollowUpSlaWatcher({ now: NOW })).toEqual({ skipped: true, reason: 'gated_off' });
  expect(listOpenCommitments).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1);
  // Retired as done (read is not done), by the pager.
  expect(updates[0].patch).toMatchObject({ done_by: 'followup-sla' });
  expect(updates[0].patch.done_at).toBeTruthy();
  // Flagged emptied, so a re-enabled pager posts its list fresh.
  expect(String(updates[0].patch.metadata)).toMatch(/emptied/);
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
  // One miss opens its call; several open the Owed list.
  expect(opts).toMatchObject({ dedupeKey: `${ROLLING_KEY}:${NOW.toISOString()}`, bell: true, link: '/admin/communications#tab=calls&call=call-a', metadata: { missed_commitment_ids: ['a'] } });
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
  // The brevity guard's form: a one-sentence body, the whole list in `detail`.
  expect(updates[0].patch.body.length).toBeLessThanOrEqual(110);
  expect(updates[0].patch.detail).toContain('callback promised to Test Caller');
  expect(updates[0].patch.read_at).toBeUndefined();
});

test('a standing single-miss post from before the link change is rewritten quietly when only its link differs', async () => {
  listOpenCommitments.mockResolvedValue([row('a')]);
  // Learn the title/body the tick writes for this list, so only the link can differ.
  const learned = (await (async () => {
    const u = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title: 'x', body: 'x' } });
    await runFollowUpSlaWatcher({ now: NOW });
    return u;
  })())[0].patch;
  const stored = (link) => ({ ...posted(['a']), read_at: NOW, title: learned.title, body: learned.body, detail: learned.detail, link });

  const updates = mockDb({ standingRow: stored('/admin/communications#tab=owed') });
  await runFollowUpSlaWatcher({ now: NOW });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.link).toBe('/admin/communications#tab=calls&call=call-a');
  expect(updates[0].patch.read_at).toBeUndefined();

  // Already carrying the right link: nothing to write.
  const quiet = mockDb({ standingRow: stored(learned.link) });
  await runFollowUpSlaWatcher({ now: NOW });
  expect(quiet).toHaveLength(0);
});

test('a standing post already in the guard\'s form is not rewritten every tick', async () => {
  listOpenCommitments.mockResolvedValue([row('a')]);
  const first = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title: 'x', body: 'old text' } });
  await runFollowUpSlaWatcher({ now: NOW });
  const { title, body, detail, link } = first[0].patch;
  const second = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title, body, detail, link } });
  await runFollowUpSlaWatcher({ now: NOW });
  expect(second).toHaveLength(0);
});

test('a new miss joining the list re-posts it and retires the older post', async () => {
  const updates = mockDb({ standingRow: posted(['a']) });
  listOpenCommitments.mockResolvedValue([row('a'), row('b', { call_log_id: 'call-b' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).alerted).toBe(1);
  expect(rollingCall()[1]).toBe('2 missed follow-ups in the last 24 hours');
  expect(rollingCall()[3].link).toBe('/admin/communications#tab=owed');
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ table: 'notifications', patch: { done_by: 'followup-sla', resolution: 'Replaced by a newer missed-follow-up list' } });
});

test('items only dropping off rewrite the latest post in place, read state kept — no new ping', async () => {
  const updates = mockDb({ standingRow: posted(['a', 'b']) });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(updates).toHaveLength(1);
  expect(updates[0].patch.title).toBe('1 missed follow-up in the last 24 hours');
  // Down to one miss, the standing post now opens that call.
  expect(updates[0].patch.link).toBe('/admin/communications#tab=calls&call=call-a');
  expect(updates[0].patch.read_at).toBeUndefined();
  expect(JSON.parse(updates[0].patch.metadata).missed_commitment_ids).toEqual(['a']);
});

test('an emptied list is retired and flagged, so a miss that returns later (e.g. after a snooze) is posted fresh', async () => {
  const updates = mockDb({ standingRow: posted(['a']) });
  listOpenCommitments.mockResolvedValue([]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(updates).toHaveLength(1);
  expect(updates[0].patch).toMatchObject({ done_by: 'followup-sla' });
  expect(updates[0].patch.done_at).toBeTruthy();
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

test('only a text that reached the customer counts: queued, sent-but-undelivered, reserved and failed rows are excluded (the proof\'s smsDelivered)', async () => {
  mockDb({ activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('sms_log', 'whereIn')).toContainEqual(['status', ['sent', 'delivered']]);
  // A text accepted but never delivered keeps the promise on the list.
  mockDb({ activity: { sms_log: { status: 'sent' } } });
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
});

test('a text counts only when a person sent it: the composer\'s stamp or the sending admin, or an AI draft staff approved/revised (the proof\'s operatorReply) — never a bare manual type', async () => {
  mockDb({ activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(argsOf('sms_log', 'whereRaw').map(([sql]) => sql).join(' ')).toMatch(/human_authored.*admin_user_id IS NOT NULL/);
  expect(argsOf('sms_log', 'orWhereIn')).toContainEqual(['message_type', ['ai_approved', 'ai_revised']]);
  mockDb({ activity: { sms_log: { operator_sent: false } } });
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  mockDb({ activity: { sms_log: { operator_sent: false, message_type: 'ai_approved' } } });
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
});

test('only a call a person placed counts: an automated outbound call (collections), or a staff call that reached voicemail, keeps the promise on the list', async () => {
  mockDb({ activity: { call_log: true } });
  listOpenCommitments.mockResolvedValue([row('a')]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(argsOf('call_log', 'whereIn')).toContainEqual(['source', ['admin-click', 'admin-callback', 'tech-click']]);
  mockDb({ activity: { call_log: { source: 'collections_voice' } } });
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  mockDb({ activity: { call_log: { is_voicemail: 'true' } } });
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
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
  expect(NOW.getTime() - activeSince.getTime()).toBe((24 + 60 * 24) * 60 * 60 * 1000);
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

describe('followedUpIds — renewal-boundary propagation', () => {
  test('a failed obligationRenewedAt lookup propagates rather than reading as "no renewal"', async () => {
    obligationRenewedAt.mockRejectedValueOnce(new Error('synthetic audit_log lookup failure'));
    const reopenedRow = {
      id: 'fixture-reopened-1', kind: 'callback', party: 'waves', human_state: 'confirmed',
      customer_id: 'fixture-customer-1', created_at: NOW, call_started_at: NOW, source: 'ai',
    };
    // Old evidence from BEFORE the reopen must never silently count as
    // fulfillment when the renewal boundary itself couldn't be verified —
    // every existing caller (the pager's own runInner, promise-chaser-bell)
    // already treats a thrown followedUpIds as "unverified, hold for retry".
    await expect(followedUpIds(db, [reopenedRow])).rejects.toThrow('synthetic audit_log lookup failure');
  });

  test('a row the pager itself would ever pass (no human_state) touches no renewal-boundary query at all', async () => {
    // renewedFloors no longer short-circuits on kind/human_state itself
    // (Codex #5019 r12 P1: obligationRenewedAt is the single source of
    // truth for which rows it renews, so this file never duplicates —
    // or drifts from — that decision), so it IS called for every row now.
    // The real guarantee this test pins is unchanged: obligationRenewedAt's
    // OWN human_state guard returns before ever touching audit_log, so a
    // row the pager's own candidates always look like (no human_state)
    // still causes zero DB work — `db` (the bare mock) is never invoked.
    const untouchedRow = {
      id: 'fixture-untouched-1', kind: 'callback', party: 'waves', human_state: null,
      customer_id: null, created_at: NOW, call_started_at: NOW, source: 'ai', from_phone: null, to_phone: null, direction: 'inbound',
    };
    await followedUpIds(db, [untouchedRow]).catch(() => {}); // db is a bare mock; only proving the call pattern here
    expect(obligationRenewedAt).toHaveBeenCalledTimes(1);
    expect(db).not.toHaveBeenCalled();
  });
});

describe('pagerHealthy — judged against the pager schedule', () => {
  test.each([
    ['2:07 PM → the 2:00 PM tick', et('14:07'), et('14:00')],
    ['11 PM → the 8:45 PM tick', et('23:00'), et('20:45')],
    ['6 AM → the previous 8:45 PM tick', et('06:00', '2026-09-27'), et('20:45')],
  ])('%s', (_label, now, tick) => {
    expect(lastScheduledTick(now).toISOString()).toBe(tick.toISOString());
  });

  let status = 'success';
  let started = null;
  const healthAt = (lastSuccess, lastStatus = 'success', lastStarted = null) => {
    status = lastStatus;
    started = lastStarted;
    db.mockImplementation(() => { const q = {}; q.where = () => q; q.first = async () => (lastSuccess ? { last_success_at: lastSuccess, last_started_at: started || lastSuccess, last_status: status } : null); return q; });
  };
  test('a success at or after the latest tick (minus slack) is healthy; an older one, or none, is not', async () => {
    healthAt(et('20:46').toISOString());
    expect(await pagerHealthy(db, et('06:00', '2026-09-27'))).toBe(true);
    // The 20:45 tick never ran: a 20:30 success does not cover it.
    healthAt(et('20:31').toISOString());
    expect(await pagerHealthy(db, et('23:00'))).toBe(false);
    healthAt(et('14:00').toISOString());
    expect(await pagerHealthy(db, et('06:00', '2026-09-27'))).toBe(false);
    healthAt(null);
    expect(await pagerHealthy(db, NOW)).toBe(false);
    // A failed latest tick is unhealthy however recent the success before it.
    healthAt(et('20:31').toISOString(), 'failed');
    expect(await pagerHealthy(db, et('23:00'))).toBe(false);
    // A 20:30 run that finished at 20:46 did not run the 20:45 tick.
    healthAt(et('20:46').toISOString(), 'success', et('20:30').toISOString());
    expect(await pagerHealthy(db, et('23:00'))).toBe(false);
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

test('a quote delivered to the customer (the proof\'s association hint) counts as follow-up', async () => {
  mockDb({ hints: { q: JSON.stringify({ kind: 'estimate_sent', strength: 'association', matched_at: et('13:30').toISOString() }) } });
  listOpenCommitments.mockResolvedValue([row('q', { kind: 'send_estimate', call_started_at: et('13:00').toISOString() })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('at the 8:00 AM opening tick the pager is judged against last night\'s 8:45 PM run, not the run still in progress', async () => {
  db.mockImplementation(() => { const q = {}; q.where = () => q; q.first = async () => ({ last_success_at: et('20:46', '2026-09-26').toISOString(), last_started_at: et('20:45', '2026-09-26').toISOString(), last_status: 'success' }); return q; });
  expect(await pagerHealthy(db, et('08:00', '2026-09-27'))).toBe(true);
  expect(await pagerHealthy(db, et('08:05', '2026-09-27'))).toBe(true);
});

test('an in-place rewrite stores admin text emoji-stripped, like a fresh post', async () => {
  const updates = mockDb({ standingRow: { ...posted(['a']), read_at: NOW, title: 'x', body: 'old text' } });
  listOpenCommitments.mockResolvedValue([row('a', { customer_first_name: 'Test\u{1F41B}' })]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(updates[0].patch.body).not.toMatch(/\u{1F41B}/u);
  expect(updates[0].patch.detail).not.toMatch(/\u{1F41B}/u);
});

test('a held-over promise whose call cannot be verified still drops off when later activity proves follow-up', async () => {
  mockDb({ standingRow: posted(['b']), activity: { sms_log: true } });
  listOpenCommitments.mockResolvedValue([row('b', { call_log_id: 'call-b' })]);
  refreshFulfillment.mockResolvedValue({ failed: 1 });
  await expect(runFollowUpSlaWatcher({ now: NOW })).rejects.toThrow('verification incomplete');
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('the closure calendar runs from the oldest scanned promise through 60 days AHEAD of now — a closed today counts', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([]);
  await runFollowUpSlaWatcher({ now: NOW });
  const { getBlackoutLayers } = require('../services/scheduling/blackout-dates');
  const [from, to] = getBlackoutLayers.mock.calls.at(-1);
  expect(from <= '2026-07-27').toBe(true);
  expect(to).toBe('2026-11-25');
});

test('the scan pages until exhaustion — no hidden row ceiling', async () => {
  mockDb();
  const page = (n) => Array.from({ length: n }, (_, i) => row(`p${n}-${i}`, { call_started_at: et('09:00', '2026-09-20').toISOString() }));
  listOpenCommitments.mockReset();
  for (let i = 0; i < 30; i += 1) listOpenCommitments.mockResolvedValueOnce(page(200));
  listOpenCommitments.mockResolvedValueOnce([]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(listOpenCommitments).toHaveBeenCalledTimes(31);
});

test('an ordinary connected outbound call (no callback card, 60 s+) counts as follow-up too', async () => {
  mockDb({ activity: { call_log: true } });
  listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate', call_started_at: et('13:00').toISOString() })]);
  await runFollowUpSlaWatcher({ now: NOW });
  const raws = argsOf('call_log', 'whereRaw').map(([sql]) => sql).join(' ');
  expect(raws).toMatch(/relatedCommitmentId' IS NULL/);
  expect(raws).toMatch(/COALESCE\(duration_seconds, 0\) >= 60/);
});

test('evidence for a floor promise counts only from its stated time — earlier activity does not keep it', async () => {
  mockDb();
  listOpenCommitments.mockResolvedValue([row('f', { due_at: et('14:30').toISOString(), due_type: 'floor', call_started_at: et('13:00').toISOString() })]);
  await runFollowUpSlaWatcher({ now: NOW });
  const since = argsOf('sms_log', 'where').filter(([col]) => col === 'created_at').map(([, , v]) => new Date(v).toISOString());
  expect(new Set(since)).toEqual(new Set([et('14:30').toISOString()]));
});

test('a quote hint from before a floor time does not keep the promise', async () => {
  mockDb({ hints: { q: JSON.stringify({ kind: 'estimate_sent', strength: 'association', matched_at: et('13:30').toISOString() }) } });
  listOpenCommitments.mockResolvedValue([row('q', { kind: 'send_estimate', call_started_at: et('13:00').toISOString(), due_at: et('14:00').toISOString(), due_type: 'floor' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
});

test('a booking after the call FOR the stated slot keeps a scheduling promise before that time (it is the appointment); another slot, or a quote promise, still waits for it', async () => {
  mockDb();
  const base = db.getMockImplementation();
  // Each booked at 13:58, on a 12:45 call, against a 2 PM stated time.
  // As pg returns them: DATE a UTC-midnight Date, TIME an 'HH:MM:SS' string.
  const booked = {
    'cust-visit': ['2026-09-26', '14:00:00'],
    'cust-untyped': ['2026-09-26', '14:00:00'],
    'cust-sameday': ['2026-09-26', '10:00:00'],
    'cust-later': ['2026-09-30', '14:00:00'],
    'cust-quote': ['2026-09-26', '14:00:00'],
  };
  db.mockImplementation((t) => {
    const q = base(t);
    if (t === 'scheduled_services') q.select = async () => Object.entries(booked).map(([customer_id, [day, start]]) => ({
      customer_id, created_at: et('13:58').toISOString(), scheduled_date: new Date(`${day}T00:00:00Z`), window_start: start,
    }));
    return q;
  });
  const stated = { call_started_at: et('12:45').toISOString(), due_at: et('14:00').toISOString() };
  listOpenCommitments.mockResolvedValue([
    row('visit', { kind: 'schedule_visit', ...stated, due_type: 'floor' }), // "on the schedule for around 2"
    row('untyped', { kind: 'schedule_visit', ...stated }),
    // "schedule it after the 2 PM inspection": unrelated visits that day or at 2 PM another day
    row('sameday', { kind: 'schedule_visit', ...stated, due_type: 'floor' }),
    row('later', { kind: 'schedule_visit', ...stated, due_type: 'floor' }),
    row('quote', { kind: 'send_estimate', ...stated, due_type: 'floor' }),
  ]);
  await runFollowUpSlaWatcher({ now: NOW });
  expect(rollingCall()[3].metadata.missed_commitment_ids).toEqual(['later', 'quote', 'sameday']);
  // The scan (the lock's re-check covers only the listed quote): bookings are
  // read from the call's end, texts still from the stated time.
  const scanSince = (t) => queriesOn(t)[0].calls.filter(([m, col]) => m === 'where' && col === 'created_at').map(([, , , v]) => new Date(v).toISOString());
  expect(scanSince('scheduled_services')).toEqual([et('12:45').toISOString()]);
  expect(scanSince('sms_log')).toEqual([et('14:00').toISOString()]);
});

test('a pager run in progress right now counts as healthy; a stuck one does not', async () => {
  db.mockImplementation(() => { const q = {}; q.where = () => q; q.first = async () => ({ last_status: 'running', last_started_at: et('14:00').toISOString(), last_success_at: et('13:46').toISOString() }); return q; });
  expect(await pagerHealthy(db, et('14:02'))).toBe(true);
  expect(await pagerHealthy(db, et('14:30'))).toBe(false);
});

test('an anonymous caller ID gives no contact to match on — unrelated activity never keeps the promise', async () => {
  mockDb({ activity: { sms_log: true, call_log: true } });
  listOpenCommitments.mockResolvedValue([row('anon', { customer_id: null, from_phone: 'anonymous' })]);
  expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  expect(queriesOn('sms_log')).toHaveLength(0);
});

describe('an estimate sent to the customer keeps a quote promise; a callback only by its own call\'s quote', () => {
  test('a delivered estimate for the same customer after the promise drops a send_estimate promise, read through the canonical ownership fence (so a live lead-owned estimate sent by email only counts)', async () => {
    mockDb({ activity: { estimates: true } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
    const fence = argsOf('estimates', 'whereRaw').find(([sql]) => /estimates\.customer_id = \?/.test(sql));
    expect(fence).toBeDefined();
    expect(fence[0]).toMatch(/estimates\.customer_id IS NULL/);
    expect(fence[0]).toMatch(/l\.deleted_at IS NULL/);
    expect(fence[1]).toEqual(Array(5).fill('cust-a'));
  });

  test('a callback is NOT closed by an unrelated estimate to the customer ("we will call back with availability")', async () => {
    mockDb({ activity: { estimates: true } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'callback' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    // No customer-wide estimate read at all for a callback.
    expect(queriesOn('estimates')).toHaveLength(0);
  });

  test('a callback IS closed by its own call\'s quote (the estimate on the lead the call created), asked through the canonical direct proof', async () => {
    mockDb();
    directEstimatesSentAfter.mockImplementation(async (_conn, probes) => new Map(probes.map((p) => [p.key, { kind: 'estimate_sent' }])));
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'callback' }), row('b', { kind: 'callback' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
    const probes = directEstimatesSentAfter.mock.calls[0][1];
    expect(probes.map((p) => p.callId).sort()).toEqual(['call-a', 'call-b']);
    expect(probes[0]).toMatchObject({ twilioCallSid: 'CAcall-a', key: 'a' });
    // The evidence boundary is the call's end.
    expect(new Date(probes[0].after).toISOString()).toBe(et('14:00').toISOString());
    // Only the call's own quote closes it: the proof finds nothing for 'b', so it stays.
    directEstimatesSentAfter.mockImplementation(async () => new Map([['a', { kind: 'estimate_sent' }]]));
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    expect(rollingCall()[3].metadata.missed_commitment_ids).toEqual(['b']);
  });

  test('a delivered estimate_sent text keeps a quote promise, and only a quote promise', async () => {
    mockDb({ activity: { sms_log: { message_type: 'estimate_sent', operator_sent: false, status: 'delivered' } } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
    // A queued/failed text is no delivery; the same text never clears a callback or a visit promise.
    mockDb({ activity: { sms_log: { message_type: 'estimate_sent', operator_sent: false, status: 'queued' } } });
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    mockDb({ activity: { sms_log: { message_type: 'estimate_sent', operator_sent: false, status: 'delivered' } } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'callback' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'schedule_visit' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  });

  test('an estimate does not keep a schedule_visit promise', async () => {
    mockDb({ activity: { estimates: true } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'schedule_visit' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    expect(queriesOn('estimates')).toHaveLength(0);
  });

  test('an unlinked caller is matched only by an UNOWNED estimate on the same number', async () => {
    mockDb({ activity: { estimates: { customer_phone: '(941) 555-0123' } } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate', customer_id: null, direction: 'inbound', from_phone: '+19415550123' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
    expect(argsOf('estimates', 'whereNull')).toContainEqual(['customer_id']);
    // Another number's estimate never clears it.
    mockDb({ activity: { estimates: { customer_phone: '(941) 555-0999' } } });
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  });

  test('an estimate sent while UNOWNED (its estimate_sent text has no customer_id) keeps a LINKED customer\'s promise through the promise\'s phone', async () => {
    mockDb();
    const base = db.getMockImplementation();
    let smsQuery;
    db.mockImplementation((t) => {
      const q = base(t);
      if (t === 'sms_log') {
        smsQuery = q;
        const baseSelect = q.select;
        q.select = async (...cols) => {
          await baseSelect(...cols);
          // Only the unowned row exists, as admin-estimates logs it.
          return [{ id: 'sms-x', customer_id: null, to_phone: '+19415550123', created_at: '2100-01-01T00:00:00Z', status: 'delivered',
            message_type: 'estimate_sent', from_phone: '+19415550100', operator_sent: false, provider_accepted: false, push_channel: false }];
        };
      }
      return q;
    });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate', from_phone: '+19415550123', to_phone: '+19415550100' })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(0);
    expect(smsQuery).toBeDefined();
    // The unowned arm rides the same query, scoped to estimate_sent rows with no customer.
    const calls = queriesOn('sms_log')[0].calls.map(([m, ...a]) => [m, ...a.filter((v) => typeof v !== 'function')]);
    expect(calls).toContainEqual(['whereNull', 'customer_id']);
    expect(calls).toContainEqual(['where', 'message_type', 'estimate_sent']);
    // Another number's unowned estimate text never clears it, and only for these kinds.
    db.mockImplementation((t) => {
      const q = base(t);
      if (t === 'sms_log') q.select = async () => [{ id: 'sms-y', customer_id: null, to_phone: '+19415550999', created_at: '2100-01-01T00:00:00Z', status: 'delivered',
        message_type: 'estimate_sent', from_phone: '+19415550100', operator_sent: false, provider_accepted: false, push_channel: false }];
      return q;
    });
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'callback', from_phone: '+19415550123', to_phone: '+19415550100' })]);
    db.mockImplementation((t) => {
      const q = base(t);
      if (t === 'sms_log') q.select = async () => [{ id: 'sms-x', customer_id: null, to_phone: '+19415550123', created_at: '2100-01-01T00:00:00Z', status: 'delivered',
        message_type: 'estimate_sent', from_phone: '+19415550100', operator_sent: false, provider_accepted: false, push_channel: false }];
      return q;
    });
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  });

  test('the evidence boundary is the call end: a handoff before the promise does not keep it', async () => {
    mockDb({ activity: { estimates: { handed_off_at: et('13:00').toISOString() } } });
    listOpenCommitments.mockResolvedValue([row('a', { kind: 'send_estimate', call_started_at: et('14:00').toISOString() })]);
    expect((await runFollowUpSlaWatcher({ now: NOW })).missed).toBe(1);
  });
});
