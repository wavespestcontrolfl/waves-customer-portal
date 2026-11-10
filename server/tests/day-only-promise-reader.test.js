// GATE_DAY_ONLY_PROMISE part A (owner 2026-11-05 "D2 a"): the no-show detector's promise reader learns an explicit
// day-only marker (metadata.promise_level 'day'), and auto-dispatch/told-visits.js turns it into a promise LEVEL:
// 'none' / 'day' / 'hour' (unknown window = 'hour', fail closed) plus an anyPromise "told anything" set.
// The detector runs for real over a fake knex; only the rows are fed in. Synthetic ids only.
const detector = require('../services/no-show-detector');
const { loadToldVisitIds, loadPromiseLevels } = require('../services/auto-dispatch/told-visits');

const NOW = new Date('2026-11-10T09:00:00Z');
const SLOT = Date.parse('2026-11-12T14:00:00Z');

/** A knex-shaped fake: messaging rows, email interaction rows and scheduled_services members; every other read is empty. */
function fakeConn({ messages = [], emails = [], members = [], failOn = null } = {}) {
  const wheres = [];
  const conn = (table) => {
    const filters = [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere']) {
      chain[m] = (...args) => { if (table === 'messaging_audit_log as a' && m === 'whereRaw') wheres.push(args); return chain; };
    }
    chain.whereIn = (col, values) => { filters.push([col, (Array.isArray(values) ? values : []).map(String)]); return chain; };
    chain.select = async () => {
      if (failOn === table) throw new Error(`read failed: ${table}`);
      if (table === 'messaging_audit_log as a') return messages;
      if (table === 'customer_interactions as ci') return emails;
      if (table === 'scheduled_services') return members.filter((r) => filters.every(([col, vals]) => r[col] != null && vals.includes(String(r[col]))));
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  conn.wheres = wheres;
  return conn;
}

const msg = (visit, over = {}) => ({
  id: over.id || 1, appointment_id: visit, purpose: 'appointment_confirmation', sent_at: '2026-11-09T14:00:00Z',
  metadata: { rendered_slot_ms: SLOT, ...(over.metadata || {}) }, ...(over.row || {}),
});
const dayMsg = (visit, over = {}) => msg(visit, { id: 2, ...over, metadata: { promise_level: 'day', rendered_slot_ms: undefined, ...(over.metadata || {}) } });
const stop = (id) => ({ id, visit_id: 'v1', status: 'pending' });

describe('the promise reader', () => {
  test('a day-marked row yields level day and a null start_at', async () => {
    const events = await detector.loadPromiseEvents(fakeConn({ messages: [dayMsg('s1')] }), ['s1'], { now: NOW });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ visit_id: 's1', start_at: null, level: 'day', source: 'message' });
  });

  test('a day-marked email interaction row yields level day too', async () => {
    const emails = [{ id: 7, metadata: { scheduled_service_id: 's1', event_type: 'appointment.confirmation', promise_level: 'day' }, created_at: '2026-11-09T15:00:00Z' }];
    const events = await detector.loadPromiseEvents(fakeConn({ emails }), ['s1'], { now: NOW });
    expect(events[0]).toMatchObject({ visit_id: 's1', start_at: null, level: 'day', source: 'email' });
  });

  test('an unmarked row keeps its exact event shape: no level key', async () => {
    const events = await detector.loadPromiseEvents(fakeConn({ messages: [msg('s1')] }), ['s1'], { now: NOW });
    expect(events[0]).not.toHaveProperty('level');
    expect(events[0].start_at).toBe(new Date(SLOT).toISOString());
    const legacy = await detector.loadPromiseEvents(fakeConn({ messages: [msg('s1', { metadata: { rendered_slot_ms: undefined } })] }), ['s1'], { now: NOW });
    expect(legacy[0]).not.toHaveProperty('level');
    expect(legacy[0].start_at).toBeNull();
  });

  test('the messaging read fetches a purpose appointment row that carries only the day marker', async () => {
    const conn = fakeConn();
    await detector.loadPromiseEvents(conn, ['s1'], { now: NOW });
    const [sql] = conn.wheres.find(([text]) => String(text).includes("a.purpose = 'appointment'"));
    expect(sql).toContain("a.metadata->>'promise_level' = 'day'");
    // The existing predicates stay.
    expect(sql).toContain("a.metadata->>'rendered_slot_ms' IS NOT NULL");
    expect(sql).toContain("LIKE 'rain_out_moved%'");
  });

  test('a day promise newer than a known window is the latest promise (it supersedes the older window)', () => {
    const known = { visit_id: 's1', start_at: new Date(SLOT).toISOString(), communicated_at: '2026-11-08T12:00:00Z', source: 'message' };
    const day = { visit_id: 's1', start_at: null, level: 'day', communicated_at: '2026-11-09T12:00:00Z', source: 'message' };
    expect(detector.latestPromises([known, day], NOW).get('s1')).toBe(day);
    expect(detector.latestPromises([day, known], NOW).get('s1')).toBe(day);
  });

  test('a tie between a known window and a day promise keeps the known window', () => {
    const at = '2026-11-09T12:00:00Z';
    const known = { visit_id: 's1', start_at: new Date(SLOT).toISOString(), communicated_at: at, source: 'message' };
    const day = { visit_id: 's1', start_at: null, level: 'day', communicated_at: at, source: 'email' };
    expect(detector.latestPromises([day, known], NOW).get('s1')).toBe(known);
    expect(detector.latestPromises([known, day], NOW).get('s1')).toBe(known);
  });

  test('stopPromise with a day promise newest returns it', () => {
    const members = [{ id: 's1', status: 'pending' }, { id: 's2', status: 'pending' }];
    const known = { visit_id: 's1', start_at: new Date(SLOT).toISOString(), communicated_at: '2026-11-08T12:00:00Z', source: 'message' };
    const day = { visit_id: 's2', start_at: null, level: 'day', communicated_at: '2026-11-09T12:00:00Z', source: 'message' };
    expect(detector.stopPromise(members, detector.byVisit([known, day]), NOW)).toBe(day);
  });
});

describe('loadPromiseLevels', () => {
  const levels = async (conn, ids = ['s1']) => Object.fromEntries(await loadPromiseLevels(conn, ids, NOW));

  test('no promise at all: none', async () => {
    expect(await levels(fakeConn())).toEqual({ s1: 'none' });
  });

  test('a known slot: hour', async () => {
    expect(await levels(fakeConn({ messages: [msg('s1')] }))).toEqual({ s1: 'hour' });
  });

  test('an explicit day marker with no slot: day', async () => {
    expect(await levels(fakeConn({ messages: [dayMsg('s1')] }))).toEqual({ s1: 'day' });
  });

  test('an unknown window WITHOUT the day marker counts as hour (fail closed)', async () => {
    const legacy = msg('s1', { purpose: 'appointment', metadata: { rendered_slot_ms: undefined, original_message_type: 'reschedule_series_confirmation' } });
    expect(await levels(fakeConn({ messages: [legacy] }))).toEqual({ s1: 'hour' });
  });

  test('the latest promise decides: a later day notice beats an older hour; a later hour beats an older day', async () => {
    const olderHour = msg('s1', { id: 1, row: { sent_at: '2026-11-08T12:00:00Z' } });
    const newerDay = dayMsg('s1', { row: { sent_at: '2026-11-09T12:00:00Z' } });
    expect(await levels(fakeConn({ messages: [olderHour, newerDay] }))).toEqual({ s1: 'day' });
    const olderDay = dayMsg('s1', { row: { sent_at: '2026-11-08T12:00:00Z' } });
    const newerHour = msg('s1', { id: 3, row: { sent_at: '2026-11-09T12:00:00Z' } });
    expect(await levels(fakeConn({ messages: [olderDay, newerHour] }))).toEqual({ s1: 'hour' });
  });

  test('stop-wide: a grouped day promise recorded on a sibling is the level of every live member', async () => {
    const conn = fakeConn({
      members: [stop('live'), { id: 'owner', visit_id: 'v1', status: 'cancelled' }],
      messages: [dayMsg('owner', { metadata: { notificationEventKey: 'k1' } })],
    });
    expect(await levels(conn, ['live'])).toEqual({ live: 'day' });
  });

  test('one stop-members read and one promise read for any number of ids', async () => {
    const spy = jest.spyOn(detector, 'loadPromiseEvents');
    await levels(fakeConn({ messages: [msg('s1')] }), ['s1', 's2', 's3']);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('no ids: an empty map, nothing read', async () => {
    const spy = jest.spyOn(detector, 'loadPromiseEvents');
    expect((await loadPromiseLevels(fakeConn(), [], NOW)).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a failed read throws, so callers fail closed', async () => {
    await expect(loadPromiseLevels(fakeConn({ failOn: 'messaging_audit_log as a' }), ['s1'], NOW)).rejects.toThrow('read failed');
    await expect(loadPromiseLevels(fakeConn({ failOn: 'scheduled_services' }), ['s1'], NOW)).rejects.toThrow('read failed');
  });
});

describe('loadToldVisitIds anyPromise', () => {
  const fixtures = () => fakeConn({
    messages: [msg('hour1'), dayMsg('day1', { id: 5 }),
      msg('unk1', { id: 6, purpose: 'appointment', metadata: { rendered_slot_ms: undefined, original_message_type: 'confirmation' } })],
  });
  const ids = ['hour1', 'day1', 'unk1', 'none1'];

  test('default (false) is today: only a known slot is told', async () => {
    expect([...await loadToldVisitIds(fixtures(), ids, NOW)]).toEqual(['hour1']);
    expect([...await loadToldVisitIds(fixtures(), ids, NOW, { anyPromise: false })]).toEqual(['hour1']);
  });

  test('anyPromise true: a day promise and an unknown window are told too; no promise is not', async () => {
    expect([...await loadToldVisitIds(fixtures(), ids, NOW, { anyPromise: true })].sort()).toEqual(['day1', 'hour1', 'unk1']);
  });

  test('a failed read throws with anyPromise too', async () => {
    await expect(loadToldVisitIds(fakeConn({ failOn: 'messaging_audit_log as a' }), ['s1'], NOW, { anyPromise: true })).rejects.toThrow('read failed');
  });
});
