// GATE_DAY_ONLY_PROMISE part B2: series moves. A staff series move whose children are system-placed promises only the first
// date ("We'll text each arrival window the day before"), and the no-show reader then yields level 'day' for the moved
// children (real reader functions over fakes); unmarked series rows read exactly as before. Synthetic ids only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  safeSendAppointment: jest.fn(),
  visitPrefsRow: jest.fn(async () => ({})),
  markRescheduleNoticeSent: jest.fn(async () => ({})),
  reminder72hStillReachable: () => true,
  reminder24hStillReachable: () => true,
}));

const detector = require('../services/no-show-detector');
const { recordAuditEvent } = require('../services/audit-log');
const dayMove = require('../services/day-only-move-notice');
const { loadPromiseLevels } = require('../services/auto-dispatch/told-visits');
const dispatch = require('../routes/admin-dispatch');

const { seriesNoticeDayOnly, renderSeriesDayBody } = dispatch._test;
const NOW = new Date('2026-11-20T09:00:00Z');

describe('the series notice decision (seriesNoticeDayOnly)', () => {
  let decide;
  beforeEach(() => { decide = jest.spyOn(dayMove, 'moveNoticeDayOnly').mockResolvedValue(true); });
  afterEach(() => { decide.mockRestore(); });

  test('asks about the anchor, the first date and the quoted start; no intent named (the anchor\'s recorded intent decides)', async () => {
    const out = await seriesNoticeDayOnly({
      result: { originalDate: '2026-11-18' }, serviceId: 'anchor', customerId: 'cust-1', newDate: '2026-11-27T00:00:00.000Z', startForText: '09:00',
    });
    expect(out).toBe(true);
    const arg = decide.mock.calls[0][0];
    expect(arg).toMatchObject({ serviceId: 'anchor', customerId: 'cust-1', oldDate: '2026-11-18', newDate: '2026-11-27' });
    expect(arg.newStartAt.toISOString()).toBe('2026-11-27T14:00:00.000Z');
    expect(arg).not.toHaveProperty('intent');
  });

  test('a date-only move quotes no start: today\'s copy, and nothing is asked', async () => {
    expect(await seriesNoticeDayOnly({ result: { originalDate: '2026-11-18' }, serviceId: 'anchor', customerId: 'cust-1', newDate: '2026-11-27', startForText: null })).toBe(false);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('the day-only series rows (renderSeriesDayBody)', () => {
  let row;
  beforeEach(() => { row = jest.spyOn(dayMove, 'renderDayRow').mockResolvedValue('day series body'); });
  afterEach(() => { row.mockRestore(); });
  const vars = { first_name: 'Pat', start_date: 'Friday, Nov 27' };

  test.each([
    ['appointment_series_rescheduled', 'appointment_series_rescheduled_day_v1'],
    ['appointment_recurring_placement_confirmed', 'appointment_recurring_placement_confirmed_day_v1'],
  ])('%s -> %s, with no window_text', async (templateKey, dayKey) => {
    const state = { dayOnly: true, keep: {} };
    expect(await renderSeriesDayBody({ state, templateKey, vars, serviceId: 'anchor' })).toBe('day series body');
    expect(row).toHaveBeenCalledWith(dayKey, vars, expect.objectContaining({ workflow: 'dispatch_series_reschedule', entity_id: 'anchor' }));
    expect(state.dayOnly).toBe(true);
  });

  test('not a day send: nothing rendered, nothing touched', async () => {
    const state = { dayOnly: false, keep: {} };
    expect(await renderSeriesDayBody({ state, templateKey: 'appointment_series_rescheduled', vars, serviceId: 'anchor' })).toBeNull();
    expect(row).not.toHaveBeenCalled();
  });

  test('the day row fails: today\'s row renders, the send is no longer day-only, and the marker comes off the metadata', async () => {
    row.mockResolvedValue(null);
    const meta = dayMove.withDayMeta({ scheduled_service_id: 'anchor', series_move_id: 'm1', rendered_slot_ms: 123 }, { dayOnly: true, keep: {} }, 123);
    const state = { dayOnly: true, keep: {}, meta };
    expect(await renderSeriesDayBody({ state, templateKey: 'appointment_series_rescheduled', vars, serviceId: 'anchor' })).toBeNull();
    expect(state.dayOnly).toBe(false);
    expect(meta).toEqual({ scheduled_service_id: 'anchor', series_move_id: 'm1', rendered_slot_ms: 123 });
  });

  test('withDayMeta: the marker, the guard fields and the slot; the guard slot rides on as rendered_slot_ms', () => {
    const slot = Date.parse('2026-11-27T14:00:00Z');
    const state = { dayOnly: true };
    const meta = dayMove.withDayMeta({ scheduled_service_id: 'anchor', rendered_slot_ms: slot }, state, slot);
    expect(meta).toMatchObject({ promise_level: 'day', window_unknown: true, rendered_slot_ms: slot, guard_slot_ms: slot, promised_date: '2026-11-27' });
    const plain = dayMove.withDayMeta({ scheduled_service_id: 'anchor', rendered_slot_ms: slot }, { dayOnly: false }, slot);
    expect(plain).toEqual({ scheduled_service_id: 'anchor', rendered_slot_ms: slot });
  });
});

/** A knex-shaped fake for loadPromiseEvents: series_moves reads come back in call order (fallback proof first, then the audit join). */
function readerConn({ fallbackMoves = [], auditMoves = [], fallbackRows = [], members = [] } = {}) {
  const seriesCalls = { n: 0 };
  const conn = (table) => {
    const filters = [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct', 'orWhere']) chain[m] = () => chain;
    chain.whereIn = (col, values) => { filters.push([col, (Array.isArray(values) ? values : []).map(String)]); return chain; };
    if (table === 'series_moves as sm') seriesCalls.n += 1;
    const which = table === 'series_moves as sm' ? seriesCalls.n : 0;
    chain.select = async () => {
      if (table === 'series_moves as sm') return which === 1 ? fallbackMoves : auditMoves;
      if (table === 'audit_log as al') return fallbackRows;
      if (table === 'scheduled_services') return members.filter((r) => filters.every(([col, vals]) => r[col] != null && vals.includes(String(r[col]))));
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  return conn;
}

const move = (over = {}) => ({
  id: 'm1', anchor_service_id: 'anchor', sent_at: '2026-11-19T15:00:00.000Z',
  rows: [{ id: 'anchor', anchor: true }, { id: 'c2' }, { id: 'c3' }],
  result: { rescheduledOccurrences: [{ id: 'anchor', date: '2026-11-27', visitWindowStart: '09:00' }] },
  ...over,
});

describe('the no-show reader: a day-only series notice makes the moved children level day', () => {
  test('seriesSupersessions: a marked notice gives every moved child start_at null and level day (a stop partner too)', () => {
    const partnered = move({ promise_level: 'day', rows: [{ id: 'anchor', anchor: true }, { id: 'c2' }, { id: 'p1', partner: true, forOccurrenceId: 'anchor' }] });
    const events = detector.seriesSupersessions([partnered], new Set(['c2', 'p1']));
    expect(events).toEqual([
      { visit_id: 'c2', start_at: null, level: 'day', communicated_at: partnered.sent_at, source: 'series_move', source_id: 'm1' },
      { visit_id: 'p1', start_at: null, level: 'day', communicated_at: partnered.sent_at, source: 'series_move', source_id: 'm1' },
    ]);
  });

  test('an unmarked notice is byte for byte today: an unknown window for children, the quoted start for an anchor-stop partner, no level key', () => {
    const partnered = move({ rows: [{ id: 'anchor', anchor: true }, { id: 'c2' }, { id: 'p1', partner: true, forOccurrenceId: 'anchor' }] });
    const events = detector.seriesSupersessions([partnered], new Set(['c2', 'p1']));
    expect(events).toEqual([
      { visit_id: 'c2', start_at: null, communicated_at: partnered.sent_at, source: 'series_move', source_id: 'm1' },
      { visit_id: 'p1', start_at: '2026-11-27T14:00:00.000Z', communicated_at: partnered.sent_at, source: 'series_move', source_id: 'm1' },
    ]);
    expect(events[0]).not.toHaveProperty('level');
  });

  test('loadPromiseEvents -> loadPromiseLevels: the audit-row proof of a day-only notice reads \'day\'; an unmarked one reads \'hour\' (unknown window)', async () => {
    const day = await loadPromiseLevels(readerConn({ auditMoves: [move({ promise_level: 'day' })] }), ['c2'], NOW);
    expect(day.get('c2')).toBe('day');
    const plain = await loadPromiseLevels(readerConn({ auditMoves: [move()] }), ['c2'], NOW);
    expect(plain.get('c2')).toBe('hour');
  });

  test('the fallback-ledger proof (the audit insert failed) carries the marker the same way', async () => {
    const levels = await loadPromiseLevels(readerConn({ fallbackMoves: [move({ promise_level: 'day' })] }), ['c3'], NOW);
    expect(levels.get('c3')).toBe('day');
  });

  test('the anchor\'s own fallback row: level day with no slot; an unmarked one keeps its exact event shape', async () => {
    const row = (metadata) => ({ id: 9, resource_id: 'anchor', created_at: '2026-11-19T15:00:01Z', metadata });
    const day = await detector.loadPromiseEvents(readerConn({ fallbackRows: [row({ start_at: null, communicated_at: '2026-11-19T15:00:00Z', promise_level: 'day' })] }), ['anchor'], { now: NOW });
    expect(day).toEqual([expect.objectContaining({ visit_id: 'anchor', start_at: null, level: 'day', source: 'call' })]);
    const plain = await detector.loadPromiseEvents(readerConn({ fallbackRows: [row({ start_at: '2026-11-27T14:00:00.000Z', communicated_at: '2026-11-19T15:00:00Z' })] }), ['anchor'], { now: NOW });
    expect(plain[0]).not.toHaveProperty('level');
  });

  test('both series reads select the marker', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    expect(src).toContain("conn.raw(\"fb.metadata->>'promise_level' as promise_level\")");
    expect(src).toContain("conn.raw(\"a.metadata->>'promise_level' as promise_level\")");
  });
});

describe('recordSentWindowFallback keeps the day marker', () => {
  beforeEach(() => recordAuditEvent.mockClear());

  test('a day-only series notice: promise_level day, no start, and the series proof', async () => {
    await detector.recordSentWindowFallback({ visitId: 'anchor', startAtMs: null, windowUnknown: true, seriesMoveId: 'm1', promiseLevel: 'day' });
    expect(recordAuditEvent.mock.calls[0][0].metadata).toMatchObject({ start_at: null, series_move_id: 'm1', promise_level: 'day' });
  });

  test('without the marker the ledger row is exactly as before', async () => {
    await detector.recordSentWindowFallback({ visitId: 'anchor', startAtMs: Date.now(), seriesMoveId: 'm1' });
    expect(recordAuditEvent.mock.calls[0][0].metadata).not.toHaveProperty('promise_level');
  });

  test('the sender passes the marker only for a day-only notice', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'messaging', 'send-customer-message.js'), 'utf8');
    expect(src).toContain('...dayPromiseLevelArg(sendInput.metadata)');
    expect(src).toContain("metadata?.promise_level === 'day' ? { promiseLevel: 'day' } : {}");
  });
});
