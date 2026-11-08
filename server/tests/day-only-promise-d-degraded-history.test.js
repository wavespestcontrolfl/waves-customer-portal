/**
 * GATE_DAY_ONLY_PROMISE part D: a swallowed move-history read failure (reschedule_log). isCustomerPickedVisit answers
 * { picked: true, degraded: true }; time-promise.js carries `degraded` into the row's failed: true marker, so an AI context
 * says only the day, while a screen still shows the hour and the senders still keep today's window copy.
 * Real dayOnlyEligibility / loadTimeDisplay / dayOnlySendDecision / loadDayOnlyCheck over a knex-shaped fake. Synthetic ids.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { dayOnlyEligibility, dayOnlySendDecision, loadTimeDisplay } = require('../services/time-promise');
const { loadDayOnlyCheck } = require('../services/day-only-ai-context');

const NOW = new Date('2026-11-10T09:00:00Z');
const START = new Date('2026-11-20T14:00:00Z');
const ROWS = [{ id: 's1', scheduled_date: '2026-11-20', window_start: '09:00:00' }];
const svc = (id, over = {}) => ({
  id, visit_id: null, status: 'pending', scheduled_date: '2026-11-20', is_recurring: false, recurring_parent_id: null,
  date_exception: null, date_exception_source: null, date_exception_at: null, customer_asked_time: null, ...over,
});
const officeReminder = (id) => ({ scheduled_service_id: id, source: 'admin_manual', cancelled: false, created_at: '2026-11-09T12:00:00Z' });

/** A knex-shaped fake: scheduled_services and appointment_reminders answer; reschedule_log throws when failMoves. */
function fakeConn({ services, reminders = [], failMoves = false, moves = [] }) {
  const conn = (table) => {
    const ins = [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'distinct', 'orWhere', 'orderBy', 'where', 'whereNotIn']) chain[m] = () => chain;
    chain.whereIn = (col, values) => { ins.push([col, (values || []).map(String)]); return chain; };
    chain.select = async () => {
      if (table === 'reschedule_log') { if (failMoves) throw new Error('read failed: reschedule_log'); return moves; }
      const pick = (rows) => rows.filter((r) => ins.every(([col, vals]) => r[col] != null && vals.includes(String(r[col]))));
      if (table === 'scheduled_services') return pick(services);
      if (table === 'appointment_reminders') return pick(reminders);
      return [];
    };
    return chain;
  };
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.isTransaction = true;
  return conn;
}

const OLD = process.env.GATE_DAY_ONLY_PROMISE;
beforeEach(() => { process.env.GATE_DAY_ONLY_PROMISE = 'true'; });
afterEach(() => { if (OLD === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD; });

const broken = () => fakeConn({ services: [svc('s1')], reminders: [officeReminder('s1')], failMoves: true });
const healthy = () => fakeConn({ services: [svc('s1')], reminders: [officeReminder('s1')] });

describe('a swallowed move-history read failure', () => {
  test('dayOnlyEligibility: not eligible, the real level, and failed: true', async () => {
    expect((await dayOnlyEligibility(broken(), ['s1'], NOW)).get('s1')).toEqual({ eligible: false, level: 'none', failed: true });
  });

  test('loadTimeDisplay: the screen fields are unchanged (hour shown) and the row is marked failed', async () => {
    expect((await loadTimeDisplay(broken(), ROWS, NOW)).get('s1')).toEqual({ showHour: true, level: 'none', eligible: false, failed: true });
  });

  test('loadDayOnlyCheck: the AI says only the day', async () => {
    const isDayOnly = await loadDayOnlyCheck(broken(), ROWS, NOW);
    expect(isDayOnly(ROWS[0])).toBe(true);
  });

  test('the sender decision is unchanged: not day-only, not eligible (today\'s window copy)', async () => {
    const decision = await dayOnlySendDecision(broken(), { id: 's1', startAt: START, now: NOW, reminder24hEnabled: true });
    expect(decision).toEqual({ dayOnly: false, level: 'none', eligible: false });
  });

  test('a stop where one member read degraded marks the requested visit failed', async () => {
    const services = [svc('s1', { visit_id: 'v1' }), svc('s2', { visit_id: 'v1' })];
    const reminders = [officeReminder('s1'), officeReminder('s2')];
    const out = await dayOnlyEligibility(fakeConn({ services, reminders, failMoves: true }), ['s1'], NOW);
    expect(out.get('s1')).toMatchObject({ eligible: false, failed: true });
  });
});

describe('a good move-history read carries no marker', () => {
  test('no customer move: eligible, no failed key, the AI check says the day only after the cutoff', async () => {
    const out = await dayOnlyEligibility(healthy(), ['s1'], NOW);
    expect(out.get('s1')).toEqual({ eligible: true, level: 'none' });
    const display = await loadTimeDisplay(healthy(), ROWS, NOW);
    expect('failed' in display.get('s1')).toBe(false);
    expect(display.get('s1').showHour).toBe(false);
  });

  test('a real "customer picked it" verdict is not marked failed', async () => {
    const moves = [{ created_at: '2026-11-09T13:00:00Z', new_date: '2026-11-20', initiated_by: 'customer_sms' }];
    const out = await dayOnlyEligibility(fakeConn({ services: [svc('s1')], reminders: [officeReminder('s1')], moves }), ['s1'], NOW);
    expect(out.get('s1')).toEqual({ eligible: false, level: 'none' });
  });
});

describe('gate off', () => {
  test('loadTimeDisplay reads nothing and carries no marker, even with a broken history', async () => {
    process.env.GATE_DAY_ONLY_PROMISE = 'false';
    expect((await loadTimeDisplay(broken(), ROWS, NOW)).get('s1')).toEqual({ showHour: true, level: null, eligible: false });
  });
});
