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
  reminder72hStillReachable: () => true,
  reminder24hStillReachable: () => true,
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
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'orWhere', 'orWhereRaw', 'orderBy']) {
    q[m] = jest.fn((...args) => {
      calls.push([m, ...args]);
      if (typeof args[0] === 'function') args[0](q);
      return q;
    });
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

  test('a newer staff move that covers this anchor drops the older text, even inside the hold', async () => {
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
    // Supersession = same anchor, or the newer move's recorded shifted set
    // includes this anchor. A shared recurring parent is NOT enough.
    expect(calls).toContainEqual(['where', 'anchor_service_id', 'visit-1']);
    expect(calls.find((c) => c[0] === 'orWhereRaw')[2]).toEqual([JSON.stringify([{ id: 'visit-1' }])]);
    expect(flat).not.toContain('parent_service_id');
  });

  // The compiled query, real knex/pg dialect. Behavior against real rows was
  // checked on a scratch Postgres: a later-occurrence move (shifts only that
  // visit and later ones) does NOT drop the earlier text; the same anchor
  // drops; a newer move whose shifted set includes the older anchor drops;
  // a newer move with no recorded result on another anchor does not.
  test('compiles to: same anchor OR shifted set contains the anchor, never the parent', async () => {
    const knex = require('knex')({ client: 'pg' });
    let sql = null;
    const conn = (table) => {
      const qb = knex(table);
      qb.first = (...cols) => { sql = qb.select(...cols).toString(); return Promise.resolve(null); };
      return qb;
    };
    await coalesce.findNewerSeriesMove({ seriesMoveId: 'm1', markers: marker(), conn });
    expect(sql).toContain(`("anchor_service_id" = 'visit-1' or COALESCE(result->'rescheduledOccurrences', '[]'::jsonb) @> '[{"id":"visit-1"}]'::jsonb)`);
    expect(sql).toContain(`"source_surface" in ('dispatch_board', 'edit_modal')`);
    expect(sql).not.toContain('parent_service_id');
    await knex.destroy();
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

  describe('an inconclusive supersession lookup (the read throws)', () => {
    const conn = jest.fn(() => { throw new Error('db down'); });
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('inside the hold: held', async () => {
      const out = await coalesce.decideSeriesTextRelease({ seriesMoveId: 'm1', markers: marker(), now: NOW, conn });
      expect(out.action).toBe('hold');
    });

    test('hold over (after 3 minutes) but inside the held-text window: still held, never sent with a possibly stale date', async () => {
      const out = await coalesce.decideSeriesTextRelease({
        seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 10 * MIN) }), holdStartedMs: NOW - 10 * MIN, now: NOW, conn,
      });
      expect(out.action).toBe('hold');
    });

    test('past the held-text window: sent anyway, so the customer hears something', async () => {
      const out = await coalesce.decideSeriesTextRelease({
        seriesMoveId: 'm1',
        markers: marker({ created_at: new Date(NOW - coalesce.SERIES_TEXT_HELD_WINDOW_MS - 1) }),
        holdStartedMs: NOW - coalesce.SERIES_TEXT_HELD_WINDOW_MS, now: NOW, conn,
      });
      expect(out).toEqual({ action: 'send' });
    });

    test('the cap counts from the post-commit start: a move blocked 40 minutes before commit is still held', async () => {
      const out = await coalesce.decideSeriesTextRelease({
        seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 40 * MIN) }), holdStartedMs: NOW - 10 * 1000, now: NOW, conn,
      });
      expect(out.action).toBe('hold');
    });
  });

  test('the hold counts from the post-commit start, not created_at (a move that waited on locks)', async () => {
    process.env[GATE] = 'true';
    const conn = jest.fn(() => seriesMovesChain());
    // created_at (transaction start) is 5 minutes old; the first post-commit pass was 10 seconds ago.
    const held = await coalesce.decideSeriesTextRelease({
      seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 5 * MIN) }), holdStartedMs: NOW - 10 * 1000, now: NOW, conn,
    });
    expect(held.action).toBe('hold');
    expect(held.releaseAt.getTime()).toBe(NOW - 10 * 1000 + coalesce.SERIES_TEXT_HOLD_MS);
    const due = await coalesce.decideSeriesTextRelease({
      seriesMoveId: 'm1', markers: marker({ created_at: new Date(NOW - 5 * MIN) }), holdStartedMs: NOW - 3 * MIN - 1, now: NOW, conn,
    });
    expect(due).toEqual({ action: 'send' });
  });
});

// The effects pass, end to end against a table-keyed fake.
describe('applySeriesMoveEffects with the gate', () => {
  const stamps = [];
  const sends = [];
  const reminderUpdates = [];
  let guardReadFails;
  let markers;
  let newerMove;

  beforeEach(() => {
    jest.clearAllMocks();
    stamps.length = 0;
    sends.length = 0;
    reminderUpdates.length = 0;
    guardReadFails = false;
    newerMove = null;
    db.fn = { now: () => 'now()' };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    AppointmentReminders.safeSendAppointment.mockImplementation(async () => { sends.push(1); return true; });
    db.mockImplementation((table) => {
      if (table === 'series_moves') {
        const q = {};
        for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw', 'orWhere', 'orderBy']) q[m] = jest.fn(() => q);
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
        // No reminder row for the occurrence unless a test makes the guard
        // read fail (the re-arm then runs on its unguarded fallback).
        const q = {
          whereIn: jest.fn(() => q),
          where: jest.fn(() => q),
          select: jest.fn(async () => { if (guardReadFails) throw new Error('guard read failed'); return []; }),
          update: jest.fn(async (values) => { reminderUpdates.push(values); return 1; }),
        };
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
    anchor_service_id: 'visit-1', created_at: new Date(), result: {}, ...over,
  });
  // A move whose first post-commit pass (the hold start) was `ms` ago.
  const heldFor = (ms) => ({ result: { textHoldStartedAt: new Date(Date.now() - ms).toISOString() } });
  const holdStartStamp = () => stamps.find((st) => st.result?.sql?.includes('textHoldStartedAt'));
  const notifiedStamps = () => stamps.filter((s) => Object.hasOwn(s, 'notified_at'));

  test('gate off: the text goes out at once (today\'s behavior)', async () => {
    markers = baseMarkers();
    const out = await run();
    expect(sends).toHaveLength(1);
    expect(out.notificationSent).toBe(true);
    expect(out.notificationSent).toBe(true);
  });

  test('gate on, young move: text held, notified_at left NULL, no failure reported', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 10 * 1000) });
    // A re-arm would take its unguarded fallback and write: make that visible.
    guardReadFails = true;
    const out = await run();
    expect(sends).toHaveLength(0);
    // null, not false: a staff screen shows "text failed" only for false.
    expect(out).toMatchObject({ notificationSent: null, notificationError: null });
    expect(notifiedStamps()).toHaveLength(0);
    // The sync covered the due reminder windows for this text: a deliberate
    // hold leaves them covered (no re-arm), so the reminder cron cannot send
    // a reminder ahead of the held confirmation.
    expect(reminderUpdates).toHaveLength(0);
  });

  test('gate off, send blocked: the covered reminder windows are re-armed and the non-send concluded (unchanged)', async () => {
    markers = baseMarkers();
    guardReadFails = true;
    AppointmentReminders.safeSendAppointment.mockImplementation(async () => false);
    const out = await run();
    expect(out.notificationSent).toBe(false);
    expect(reminderUpdates).toHaveLength(1);
    expect(reminderUpdates[0]).toMatchObject({ reminder_24h_sent: false, reminder_24h_sent_at: null });
    expect(stamps).toContainEqual(expect.objectContaining({ notified_at: 'now()', customer_notified: false }));
  });

  test('gate on, hold over, send blocked: same re-arm as a gate-off failure', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 4 * MIN), ...heldFor(4 * MIN) });
    guardReadFails = true;
    AppointmentReminders.safeSendAppointment.mockImplementation(async () => false);
    const out = await run();
    expect(out.notificationSent).toBe(false);
    expect(reminderUpdates).toHaveLength(1);
  });

  test('gate on, reminder sync incomplete (reminders_synced_at NULL): still held, and the sync is left for the retry', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ reminders_synced_at: null, created_at: new Date(Date.now() - 10 * 1000) });
    const out = await run();
    expect(sends).toHaveLength(0);
    expect(out.notificationSent).toBeNull();
    // Neither the sync marker nor the text marker is stamped by a pass whose
    // sync did not finish: the reconcile selection retries both.
    expect(stamps.some((st) => Object.hasOwn(st, 'notified_at'))).toBe(false);
  });

  test('gate on, first post-commit pass stamps the hold start in the row, fenced on the lease', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 10 * 1000) });
    await run();
    const stamp = holdStartStamp();
    expect(stamp).toBeDefined();
    expect(new Date(stamp.result.bindings[0]).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  test('gate on, created_at is 5 minutes old (waited on locks) but the post-commit start is fresh: held, not sent', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 5 * MIN), ...heldFor(10 * 1000) });
    const out = await run();
    expect(sends).toHaveLength(0);
    expect(out.notificationSent).toBeNull();
    expect(holdStartStamp()).toBeUndefined();
    expect(notifiedStamps()).toHaveLength(0);
  });

  test('gate on, an old move with no recorded start (live pass died): the reconciler pass stamps it and holds', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 20 * MIN) });
    const out = await run();
    expect(holdStartStamp()).toBeDefined();
    expect(sends).toHaveLength(0);
    expect(out.notificationSent).toBeNull();
  });

  test('gate on, hold over, nothing newer: the text goes out', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 4 * MIN), ...heldFor(4 * MIN) });
    const out = await run();
    expect(sends).toHaveLength(1);
    expect(out.notificationSent).toBe(true);
  });

  test('gate on, newer move exists: older text dropped, concluded as a non-send and marked superseded', async () => {
    process.env[GATE] = 'true';
    markers = baseMarkers({ created_at: new Date(Date.now() - 4 * MIN) });
    newerMove = { id: 'm2' };
    guardReadFails = true;
    const out = await run();
    expect(sends).toHaveLength(0);
    expect(out.notificationSent).toBeNull();
    // Concluded (never retried) and said so: customer_notified stays false.
    expect(stamps).toContainEqual(expect.objectContaining({ notified_at: 'now()', customer_notified: false }));
    // The row names the move that replaced it.
    // A superseded pass never re-arms: the newer move re-stamped these reminder
    // rows at its own time and owns their windows (a guarded re-arm of this
    // move's time would match no row, and an unguarded one would clear flags
    // the newer move owns).
    expect(reminderUpdates).toHaveLength(0);
    const named = stamps.find((st) => st.result?.bindings?.[0] === 'm2');
    expect(named.result.sql).toContain('textSupersededBy');
    expect(named.result.bindings).toEqual(['m2']);
  });
});

describe('reconcileSeriesMoveEffects selection', () => {
  // A knex-shaped chain that records every call and runs nested where groups.
  async function selectionCalls(options) {
    const calls = [];
    const q = {};
    for (const m of ['whereIn', 'where', 'whereNull', 'whereNotNull', 'orWhere', 'whereRaw', 'orderByRaw', 'limit', 'modify']) {
      q[m] = jest.fn((...args) => {
        calls.push([m, ...args]);
        if (m === 'modify') args[0](q, ...args.slice(1));
        else if (typeof args[0] === 'function') args[0](q);
        return q;
      });
    }
    q.select = jest.fn(async () => []);
    q.update = jest.fn(async () => 0);
    db.mockImplementation(() => q);
    const out = await reconcileSeriesMoveEffects(options);
    expect(out).toEqual({ candidates: 0, finished: 0 });
    return calls;
  }
  const heldWhere = ['where', { status: 'committed', notify_requested: true }];
  const surfaceCalls = (calls) => calls.filter((c) => c[0] === 'whereIn' && c[1] === 'source_surface').map((c) => c[2]);

  test('gate off: exactly the old selection (every reconcile surface, normal age rule, no held-text rows)', async () => {
    const calls = await selectionCalls(undefined);
    expect(surfaceCalls(calls)).toHaveLength(1);
    expect(surfaceCalls(calls)[0]).toEqual(expect.arrayContaining(['dispatch_board', 'edit_modal', 'sms_reply', 'customer_web', 'quick_move', 'call_reschedule']));
    expect(calls).not.toContainEqual(heldWhere);
  });

  test("'only' (ticks between quarter hours): just held staff texts, with no reminder-sync requirement", async () => {
    const calls = await selectionCalls({ heldTexts: 'only' });
    expect(surfaceCalls(calls)).toEqual([coalesce.COALESCE_SURFACES]);
    expect(calls).toContainEqual(heldWhere);
    expect(calls).toContainEqual(['whereNull', 'notified_at']);
    // A pass that failed to stamp reminders_synced_at still has its text
    // released at the end of the hold; the effects pass retries the sync.
    expect(calls.some((c) => c[0] === 'whereNotNull' && c[1] === 'reminders_synced_at')).toBe(false);
    // A text the last pre-cap attempt held is still selected after the
    // 30-minute cap, so its capped send comes from this sweep.
    const lower = calls.find((c) => c[0] === 'whereRaw' && /> \?$/.test(c[1]));
    expect(Date.now() - lower[2][0].getTime()).toBeGreaterThan(coalesce.SERIES_TEXT_HELD_WINDOW_MS + 2 * 60 * 1000);
    // Both bounds age the row from the post-commit hold start, not the
    // transaction-start created_at (a move blocked on locks before commit).
    const bounds = calls.filter((c) => c[0] === 'whereRaw' && /textHoldStartedAt/.test(c[1]));
    expect(bounds).toHaveLength(2);
    expect(bounds.every((c) => /COALESCE\(\(result->>'textHoldStartedAt'\)::timestamptz, created_at\)/.test(c[1]))).toBe(true);
  });

  test("'with' (quarter hour): the normal rule OR held staff texts", async () => {
    const calls = await selectionCalls({ heldTexts: 'with' });
    const surfaces = surfaceCalls(calls);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0]).toEqual(expect.arrayContaining(['sms_reply', 'customer_web']));
    expect(surfaces[1]).toEqual(coalesce.COALESCE_SURFACES);
    expect(calls).toContainEqual(heldWhere);
    expect(calls.some((c) => c[0] === 'whereNotNull' && c[1] === 'reminders_synced_at')).toBe(false);
  });
});
