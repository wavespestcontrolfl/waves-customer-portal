/**
 * GATE_SERIES_MOVE_TEXT_COALESCE (owner 2026-10-06): staff moved one series
 * twice a minute apart and the customer got two texts. The text of a staff
 * series move is held 3 minutes and dropped when a newer staff move on the
 * same series exists; everything else about the move stays immediate.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/appointment-reminders', () => ({
  safeSendAppointment: jest.fn(),
  visitPrefsRow: jest.fn(async () => ({})),
  markRescheduleNoticeSent: jest.fn(async () => ({})),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const AppointmentReminders = require('../services/appointment-reminders');
const coalesce = require('../services/series-move-text-coalesce');
const { applySeriesMoveEffects, reconcileSeriesMoveEffects } = require('../routes/admin-dispatch');

const GATE = 'GATE_SERIES_MOVE_TEXT_COALESCE';
const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 20, 44, 0);

afterEach(() => { delete process.env[GATE]; });

const marker = (over = {}) => ({
  source_surface: 'dispatch_board',
  customer_id: 'cust-1',
  anchor_service_id: 'visit-1',
  parent_service_id: 'parent-1',
  created_at: new Date(NOW - 1 * MIN),
  ...over,
});

// A knex-shaped chain that records every where-clause and answers first().
function seriesMovesChain({ newer = null, calls = [] } = {}) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'orWhere', 'orderBy']) {
    q[m] = jest.fn((...args) => { calls.push([m, ...args]); return q; });
  }
  q.first = jest.fn(async () => newer);
  return q;
}

describe('decideSeriesTextRelease', () => {
  test('gate off: send at once, no read', async () => {
    const conn = jest.fn();
    const out = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker(), now: NOW, conn });
    expect(out).toEqual({ action: 'send' });
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on, young move with no newer move: hold until commit + 3 minutes', async () => {
    process.env[GATE] = 'true';
    const conn = jest.fn(() => seriesMovesChain());
    const out = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker(), now: NOW, conn });
    expect(out.action).toBe('hold');
    expect(out.releaseAt.getTime()).toBe(NOW - 1 * MIN + 3 * MIN);
  });

  test('gate on, hold over, nothing newer: send', async () => {
    process.env[GATE] = 'true';
    const conn = jest.fn(() => seriesMovesChain());
    const out = await coalesce.decideSeriesTextRelease({
      seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 3 * MIN - 1) }), now: NOW, conn,
    });
    expect(out).toEqual({ action: 'send' });
  });

  test('a newer staff move on the same series drops the older text, even inside the hold', async () => {
    process.env[GATE] = 'true';
    const calls = [];
    const conn = jest.fn(() => seriesMovesChain({ newer: { id: 'm2' }, calls }));
    const out = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker(), now: NOW, conn });
    expect(out).toEqual({ action: 'drop', supersededBy: 'm2' });
    // Scoped to this customer, committed, text requested, staff surfaces, newer, not itself.
    const flat = JSON.stringify(calls);
    expect(flat).toContain('"customer_id":"cust-1"');
    expect(flat).toContain('"status":"committed"');
    expect(flat).toContain('"notify_requested":true');
    expect(flat).toContain('dispatch_board');
    expect(flat).toContain('edit_modal');
    expect(calls).toContainEqual(['whereNot', { id: 'm1' }]);
    expect(calls.some((c) => c[0] === 'where' && c[1] === 'created_at' && c[2] === '>')).toBe(true);
  });

  test.each(['quick_move', 'customer_web', 'sms_reply', 'call_reschedule', 'unspecified'])(
    'surface %s is never held', async (source_surface) => {
      process.env[GATE] = 'true';
      const conn = jest.fn();
      const out = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker({ source_surface }), now: NOW, conn });
      expect(out).toEqual({ action: 'send' });
      expect(conn).not.toHaveBeenCalled();
    },
  );

  test('a failed newer-move read does not strand the text: the time rule decides', async () => {
    process.env[GATE] = 'true';
    const conn = jest.fn(() => { throw new Error('db down'); });
    const young = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker(), now: NOW, conn });
    expect(young.action).toBe('hold');
    const old = await coalesce.decideSeriesTextRelease({
      seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 10 * MIN) }), now: NOW, conn,
    });
    expect(old).toEqual({ action: 'send' });
  });
});

// The effects pass, end to end against a table-keyed fake.
describe('applySeriesMoveEffects with the gate', () => {
  const stamps = [];
  const sends = [];
  let markers;
  let newerMove;

  beforeEach(() => {
    jest.clearAllMocks();
    stamps.length = 0;
    sends.length = 0;
    newerMove = null;
    db.fn = { now: () => 'now()' };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    AppointmentReminders.safeSendAppointment.mockImplementation(async () => { sends.push(1); return true; });
    db.mockImplementation((table) => {
      if (table === 'series_moves') {
        const q = {};
        for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'orWhere', 'orderBy']) q[m] = jest.fn(() => q);
        q.first = jest.fn(async (...cols) => (cols[0] === 'conflict_card_at' ? markers : newerMove));
        q.update = jest.fn(async (values) => { stamps.push(values); return 1; });
        return q;
      }
      if (table === 'scheduled_services') {
        const q = { where: jest.fn(() => q) };
        q.first = jest.fn(async () => ({ customer_id: 'cust-1', scheduled_date: '2026-10-14', window_start: '09:00:00', visit_id: null }));
        return q;
      }
      if (table === 'customers') {
        const q = { where: jest.fn(() => q) };
        q.first = jest.fn(async () => ({ id: 'cust-1', first_name: 'Test' }));
        return q;
      }
      if (table === 'appointment_reminders') {
        // No reminder row for the occurrence: nothing to guard, close or re-arm.
        const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), select: jest.fn(async () => []), update: jest.fn(async () => 0) };
        return q;
      }
      throw new Error(`Unexpected table ${table}`);
    });
  });

  const run = () => applySeriesMoveEffects({
    result: {
      seriesMoveId: 'm1', notifyRequested: true,
      rescheduledOccurrences: [{ id: 'visit-1', date: '2026-10-14', windowStart: '09:00', windowEnd: '11:00' }],
    },
    serviceId: 'visit-1', newDate: '2026-10-14', newWindow: { start: '09:00', end: '11:00' },
  });
  const baseMarkers = (over) => ({
    status: 'committed', conflict_card_at: new Date(), reminders_synced_at: new Date(), notified_at: null,
    customer_notified: false, source_surface: 'dispatch_board', customer_id: 'cust-1',
    anchor_service_id: 'visit-1', parent_service_id: 'parent-1', created_at: new Date(), ...over,
  });
  const notifiedStamps = () => stamps.filter((s) => Object.hasOwn(s, 'notified_at'));

  test('gate off: the text goes out at once (today\'s behavior)', async () => {
    markers = baseMarkers();
    const out = await run();
    expect(sends).toHaveLength(1);
    expect(out.notificationSent).toBe(true);
    expect(out.notificationHeld).toBeUndefined();
  });

  test('gate on, young move: text held, notified_at left NULL, no failure reported', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 10 * 1000) });
    const out = await run();
    expect(sends).toHaveLength(0);
    expect(out).toMatchObject({ notificationSent: null, notificationError: null, notificationHeld: true });
    expect(new Date(out.notificationSendAfter).getTime()).toBeGreaterThan(Date.now() + 2 * MIN);
    expect(notifiedStamps()).toHaveLength(0);
  });

  test('gate on, hold over, nothing newer: the text goes out', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 4 * MIN) });
    const out = await run();
    expect(sends).toHaveLength(1);
    expect(out.notificationSent).toBe(true);
  });

  test('gate on, newer move exists: older text dropped, concluded as a non-send and marked superseded', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 4 * MIN) });
    newerMove = { id: 'm2' };
    const out = await run();
    expect(sends).toHaveLength(0);
    expect(out.notificationSent).toBe(false);
    expect(out.notificationError).toBe('superseded_by_newer_move');
    // Concluded (never retried) and said so: customer_notified stays false.
    expect(stamps).toContainEqual(expect.objectContaining({ notified_at: 'now()', customer_notified: false }));
    // The row names the move that replaced it.
    const named = stamps.find((s) => s.result !== undefined);
    expect(named.result.sql).toContain('textSupersededBy');
    expect(named.result.bindings).toEqual(['m2']);
  });
});

describe('reconcileSeriesMoveEffects heldTextsOnly', () => {
  test('selects only staff-surface committed rows with a waiting text, a few minutes old', async () => {
    const calls = [];
    const q = {};
    for (const m of ['whereIn', 'where', 'whereNull', 'whereNotNull', 'orWhere', 'orderByRaw', 'limit', 'modify']) {
      q[m] = jest.fn((...args) => {
        calls.push([m, ...args]);
        if (m === 'modify') args[0](q, ...args.slice(1));
        return q;
      });
    }
    q.select = jest.fn(async () => []);
    q.update = jest.fn(async () => 0);
    db.mockImplementation(() => q);
    const out = await reconcileSeriesMoveEffects({ olderThanMs: coalesce.SERIES_TEXT_HOLD_MS, heldTextsOnly: true });
    expect(out).toEqual({ candidates: 0, finished: 0 });
    expect(calls).toContainEqual(['whereIn', 'source_surface', coalesce.COALESCE_SURFACES]);
    expect(calls).toContainEqual(['where', { status: 'committed', notify_requested: true }]);
    expect(calls).toContainEqual(['whereNull', 'notified_at']);
    expect(calls).toContainEqual(['whereNotNull', 'reminders_synced_at']);
  });

  test('the default sweep still covers every reconcile surface', async () => {
    const calls = [];
    const q = {};
    for (const m of ['whereIn', 'where', 'whereNull', 'whereNotNull', 'orWhere', 'orderByRaw', 'limit', 'modify']) {
      q[m] = jest.fn((...args) => {
        calls.push([m, ...args]);
        if (m === 'modify') args[0](q, ...args.slice(1));
        return q;
      });
    }
    q.select = jest.fn(async () => []);
    db.mockImplementation(() => q);
    await reconcileSeriesMoveEffects();
    const surfaces = calls.find((c) => c[0] === 'whereIn' && c[1] === 'source_surface')[2];
    expect(surfaces).toEqual(expect.arrayContaining(['dispatch_board', 'edit_modal', 'sms_reply', 'customer_web', 'quick_move', 'call_reschedule']));
    expect(calls.some((c) => c[0] === 'whereNotNull' && c[1] === 'reminders_synced_at')).toBe(false);
  });
});
