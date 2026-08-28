/**
 * Collective series moves (owner rulings 2026-07-30 + 2026-08-28).
 *
 * The invariant lives at ONE choke point — SmartRebooker.reschedule — so
 * every mover inherits it: with GATE_ADMIN_COLLECTIVE_MOVE on, a DATE move of
 * a cadence visit becomes a series move. What the sweep may touch is pinned
 * here too: siblings keep their own window/status (date only), a manual
 * date exception shifts by the anchor's delta instead of regenerating, an
 * immovable sibling never becomes the anchor, and every shift is ONE
 * recorded operation (series_moves: counts, before/after snapshots with the
 * post-write version stamp, operation_key replay, failure telemetry).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({
  isBlackoutDate: jest.fn().mockResolvedValue(false),
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
}));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
// Weekly cadence: BASE, +7, +14, +21. Anchor moves +2 days.
const BASE = dayOffset(10);
const TARGET = dayOffset(12);
const SIB1 = dayOffset(17);
const SIB2 = dayOffset(24);
const SIB3 = dayOffset(31);

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    orWhere: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
    catch: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}
// Knex Raw stand-in that is CIRCULAR, like the real one: a snapshot that
// serialized it would throw and roll back the move.
const rawFactory = (label) => jest.fn((sql, bindings) => {
  const raw = { label, sql, bindings };
  raw.client = { raw };
  return raw;
});

function anchorRow(overrides = {}) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: null,
    scheduled_date: BASE,
    window_start: '09:00:00',
    window_end: '11:00:00',
    status: 'confirmed',
    is_recurring: true,
    recurring_parent_id: null,
    recurring_pattern: 'weekly',
    recurring_nth: null,
    recurring_weekday: null,
    recurring_interval_days: null,
    ...overrides,
  };
}

// Series harness (mirrors rebooker-live-reschedule-override): unlocked
// sibling SELECT, the same SELECT again under the locks (lockedSiblings =
// what that read returns; defaults to the same rows), same-series clash
// probe, then one UPDATE chain per sibling in order.
function wireSeriesMocks(siblings, { anchor = anchorRow(), priorMove = null, updateResults = null, freshAnchor = null, lockedSiblings = null, lockedParent = null } = {}) {
  const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
  const siblingsReread = chain({ select: jest.fn().mockResolvedValue(lockedSiblings || siblings) });
  // The parent's recurrence config, re-read under the maintenance lock.
  const parentReread = chain({ first: jest.fn().mockResolvedValue(lockedParent || anchor) });
  const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
  const updates = siblings.map((_, i) => chain({
    update: jest.fn().mockResolvedValue(updateResults ? updateResults[i] : [{ updated_at: `stamp-${i}` }]),
  }));
  const historyInsert = chain();
  const logInsert = chain();
  const seriesMovesInsert = chain();

  const scheduledQueue = [siblingsQuery, siblingsReread, parentReread, seriesClashProbe, ...updates];
  const trx = jest.fn((table) => {
    if (table === 'scheduled_services') return scheduledQueue.shift();
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    if (table === 'series_moves') return seriesMovesInsert;
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (callback) => callback(trx));

  const dbQueries = [anchorLookup, parentLookup];
  // The catch-side winner fence re-reads the anchor after a conflict.
  if (freshAnchor) dbQueries.push(chain({ first: jest.fn().mockResolvedValue(freshAnchor) }));
  const escalationCount = chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
  const priorLookup = chain({ first: jest.fn().mockResolvedValue(priorMove) });
  // Non-replay tests: the (always-run) prior lookup finds nothing.
  const seriesMovesDb = chain({ first: jest.fn().mockResolvedValue(undefined) });
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return escalationCount;
    if (table === 'property_preferences') return chain({ first: jest.fn().mockResolvedValue(null) });
    if (table === 'series_moves') return priorMove !== null ? priorLookup : seriesMovesDb;
    throw new Error(`Unexpected db table ${table}`);
  });

  return { updates, historyInsert, logInsert, seriesMovesInsert, seriesMovesDb, priorLookup, siblingsQuery, siblingsReread, parentReread, trx };
}

const ADMIN_OPTS = { allowLive: true, adminWindowRules: true, overlapAdvisory: true, sourceSurface: 'dispatch_board' };
const seriesMoveRow = (seriesMovesInsert) => seriesMovesInsert.insert.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
});

describe('reschedule() choke point', () => {
  let realSeries;
  beforeEach(() => {
    realSeries = SmartRebooker.rescheduleSeries;
    SmartRebooker.rescheduleSeries = jest.fn().mockResolvedValue({ success: true, seriesMoveId: 'sm-1', rescheduledOccurrences: [] });
  });
  afterEach(() => { SmartRebooker.rescheduleSeries = realSeries; });

  function wireLookup(svc, { priorMove = undefined, priorKey = null } = {}) {
    db.transaction = jest.fn();
    // Key-aware prior lookup: answers the prior only for the operation_key
    // it was stored under (as the real query would).
    const priorLookup = chain();
    priorLookup.where = jest.fn(function where(arg) {
      if (arg && typeof arg === 'object' && arg.operation_key && priorKey && arg.operation_key !== priorKey) priorLookup._miss = true;
      return priorLookup;
    });
    priorLookup.first = jest.fn(async () => (priorLookup._miss ? undefined : priorMove));
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ first: jest.fn().mockResolvedValue(svc) });
      if (table === 'series_moves') return priorLookup;
      throw new Error(`Unexpected db table ${table}`);
    });
    return { priorLookup };
  }

  test('gate on + cadence row + date delta delegates to rescheduleSeries, carrying the caller pin as expectAnchor', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    wireLookup(anchorRow());
    const result = await SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS,
      excludeServiceIds: ['svc-1'],
      expect: { scheduled_date: BASE, window_start: '09:00:00', estimated_duration_minutes: 60 },
    });
    expect(result.seriesMoveId).toBe('sm-1');
    expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledWith('svc-1', TARGET, { start: '13:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS,
      // The FULL scheduling pin rides along (duration too).
      expectAnchor: { scheduled_date: BASE, window_start: '09:00:00', estimated_duration_minutes: 60 },
    });
    // A DERIVED key is never handed over as a client key (that would lose
    // its retry horizon / supersession) — the series path derives it itself.
    expect(SmartRebooker.rescheduleSeries.mock.calls[0][5]).not.toHaveProperty('operationKey');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a retry after the first attempt committed (anchor already ON the target) replays the prior move instead of a same-date single edit', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    const priorMove = {
      id: 'sm-prior', new_date: TARGET,
      result: { success: true, newDate: TARGET, occurrencesRescheduled: 3, rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '13:00', windowEnd: '15:00' }] },
    };
    const { priorLookup } = wireLookup(anchorRow({ scheduled_date: TARGET, window_start: '13:00:00', window_end: '15:00:00' }), { priorMove, priorKey: `svc-1:${TARGET}:13:00:15:00` });
    const result = await SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: '15:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(result).toMatchObject({ replayed: true, seriesMoveId: 'sm-prior', occurrencesRescheduled: 3 });
    expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    // Derived keys are honored only within the retry horizon.
    expect(priorLookup.where).toHaveBeenCalledWith({ anchor_service_id: 'svc-1', operation_key: `svc-1:${TARGET}:13:00:15:00`, status: 'committed' });
    expect(priorLookup.where).toHaveBeenCalledWith('created_at', '>', expect.any(Date));
  });

  test('a derived-key retry whose anchor has changed since is STALE — 409, never applied as a single edit', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    // Same request key as the committed move, but the anchor's end was corrected since.
    wireLookup(anchorRow({ scheduled_date: TARGET, window_start: '13:00:00', window_end: '16:00:00' }), {
      priorMove: { id: 'sm-prior', new_date: TARGET, result: { rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '13:00', windowEnd: '15:00' }] } },
      priorKey: `svc-1:${TARGET}:13:00:15:00`,
    });
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('single-path-reached'), { single: true }); });
    await expect(SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: '15:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERIES_MOVE_STALE' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a legitimate return move (A→B, B→C, C→B within the horizon) proceeds: the request was observed at C, not at the prior move\'s origin', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    const C = dayOffset(20);
    wireLookup(anchorRow({ scheduled_date: C, window_start: '13:00:00', window_end: '15:00:00' }), {
      priorMove: { id: 'sm-prior', original_date: BASE, new_date: TARGET, result: { rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '13:00', windowEnd: '15:00' }] } },
      priorKey: `svc-1:${TARGET}:13:00:15:00`,
    });
    const result = await SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: '15:00' }, 'admin', 'admin', { ...ADMIN_OPTS, expect: { scheduled_date: C, window_start: '13:00:00' } });
    expect(result.seriesMoveId).toBe('sm-1');
    expect(SmartRebooker.rescheduleSeries).toHaveBeenCalledTimes(1);
  });

  test('the same shape observed at the prior move\'s ORIGIN is the stale retry — 409', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    wireLookup(anchorRow({ scheduled_date: dayOffset(20), window_start: '13:00:00', window_end: '15:00:00' }), {
      priorMove: { id: 'sm-prior', original_date: BASE, new_date: TARGET, result: { rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '13:00', windowEnd: '15:00' }] } },
      priorKey: `svc-1:${TARGET}:13:00:15:00`,
    });
    await expect(SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: '15:00' }, 'admin', 'admin', { ...ADMIN_OPTS, expect: { scheduled_date: BASE, window_start: '09:00:00' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERIES_MOVE_STALE' });
  });

  test('an end-only correction right after a series move is a DIFFERENT request — no replay, the single same-date edit proceeds', async () => {
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    wireLookup(anchorRow({ scheduled_date: TARGET, window_start: '13:00:00', window_end: '15:00:00' }), {
      priorMove: { id: 'sm-prior', new_date: TARGET, result: { rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '13:00', windowEnd: '15:00' }] } },
      priorKey: `svc-1:${TARGET}:13:00:15:00`,
    });
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('single-path-reached'), { single: true }); });
    // Same date + start, new end: key differs (…:13:00:16:00), and even a
    // matching key would fail the still-current check once the row changed.
    await expect(SmartRebooker.reschedule('svc-1', TARGET, { start: '13:00', end: '16:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ single: true });
    expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
  });

  test.each([
    ['gate off', {}, anchorRow(), TARGET],
    ['seriesPolicy single (auto-dispatch / disclosed-scope callers)', { seriesPolicy: 'single' }, anchorRow(), TARGET],
    ['same-date window edit', {}, anchorRow(), BASE],
    ['booster row (is_recurring=false, recurring_parent_id set)', {}, anchorRow({ is_recurring: false, recurring_parent_id: 'svc-0' }), TARGET],
  ])('does NOT delegate: %s', async (_label, extra, svc, date) => {
    if (_label !== 'gate off') process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    wireLookup(svc);
    // The single path continues into its own transaction — stub it out; the
    // assertion is only that the series path was not entered.
    db.transaction = jest.fn(async () => { throw Object.assign(new Error('single-path-reached'), { single: true }); });
    await expect(SmartRebooker.reschedule('svc-1', date, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, ...extra }))
      .rejects.toMatchObject({ single: true });
    expect(SmartRebooker.rescheduleSeries).not.toHaveBeenCalled();
  });
});

describe('single-path date exceptions', () => {
  function wireSingleMocks(svc) {
    const trxScheduled = chain({ update: jest.fn().mockResolvedValue(1) });
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return trxScheduled;
      if (table === 'job_status_history') return chain();
      if (table === 'reschedule_log') return chain();
      throw new Error(`Unexpected trx table ${table}`);
    });
    trx.raw = rawFactory('trx.raw');
    trx.fn = { now: jest.fn(() => 'NOW()') };
    db.transaction = jest.fn(async (callback) => callback(trx));
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ first: jest.fn().mockResolvedValue(svc) });
      if (table === 'reschedule_log') return chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });
      throw new Error(`Unexpected db table ${table}`);
    });
    return { trxScheduled };
  }

  test.each([
    ['staff this-visit-only move', 'admin', 'admin'],
    ['customer SMS reply', 'customer_request', 'customer_sms'],
  ])('%s of a cadence child stamps date_exception with provenance', async (_label, reason, initiatedBy) => {
    const { trxScheduled } = wireSingleMocks(anchorRow({ id: 'svc-2', recurring_parent_id: 'svc-1' }));
    await SmartRebooker.reschedule('svc-2', TARGET, { start: '09:00', end: '11:00' }, reason, initiatedBy, { seriesPolicy: 'single' });
    expect(trxScheduled.update.mock.calls[0][0]).toMatchObject({
      scheduled_date: TARGET,
      date_exception: true,
      date_exception_source: initiatedBy,
      date_exception_at: expect.any(Date),
      // Series position = the cadence date it deviated from.
      date_exception_cadence_date: BASE,
    });
  });

  test('a repeated single move keeps the ORIGINAL cadence position', async () => {
    const { trxScheduled } = wireSingleMocks(anchorRow({
      id: 'svc-2', recurring_parent_id: 'svc-1', scheduled_date: SIB1, date_exception: true, date_exception_cadence_date: BASE,
    }));
    await SmartRebooker.reschedule('svc-2', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', { seriesPolicy: 'single' });
    expect(trxScheduled.update.mock.calls[0][0]).toMatchObject({ date_exception_cadence_date: BASE });
  });

  test('an auto-dispatch nudge never stamps an exception (placement, not intent)', async () => {
    const { trxScheduled } = wireSingleMocks(anchorRow({ id: 'svc-2', recurring_parent_id: 'svc-1' }));
    await SmartRebooker.reschedule('svc-2', TARGET, { start: '09:00', end: '11:00' }, 'auto_dispatch', 'auto_dispatch', { seriesPolicy: 'single' });
    expect(trxScheduled.update.mock.calls[0][0]).not.toHaveProperty('date_exception');
  });

  test('a same-date window edit is not an exception', async () => {
    const { trxScheduled } = wireSingleMocks(anchorRow({ id: 'svc-2', recurring_parent_id: 'svc-1' }));
    await SmartRebooker.reschedule('svc-2', BASE, { start: '13:00', end: '15:00' }, 'admin', 'admin', { seriesPolicy: 'single' });
    expect(trxScheduled.update.mock.calls[0][0]).not.toHaveProperty('date_exception');
  });
});

describe('rescheduleSeries — date-only sweep', () => {
  const sib = (id, date, extra = {}) => ({
    id, status: 'confirmed', scheduled_date: date, window_start: '09:00:00', window_end: '11:00:00', technician_id: null, ...extra,
  });

  test('anchor takes the new window + confirmed; siblings keep window, status and tech (a pending placeholder stays pending)', async () => {
    const { updates, historyInsert } = wireSeriesMocks([
      sib('svc-1', BASE),
      sib('svc-2', SIB1, { window_start: '13:00:00', window_end: '15:00:00', technician_id: 'tech-9' }),
      sib('svc-3', SIB2, { status: 'pending' }),
    ]);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '08:00', end: '10:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(result.success).toBe(true);
    expect(updates[0].update.mock.calls[0][0]).toMatchObject({ scheduled_date: TARGET, window_start: '08:00', window_end: '10:00', status: 'confirmed' });
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(19), window_start: '13:00:00', window_end: '15:00:00', status: 'confirmed' });
    expect(updates[1].update.mock.calls[0][0]).not.toHaveProperty('technician_id');
    expect(updates[2].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(26), window_start: '09:00:00', status: 'pending' });
    // No status transition is written for siblings — only the anchor moves
    // through the lifecycle (and it was already confirmed here).
    expect(historyInsert.insert).not.toHaveBeenCalled();
    expect(result.rescheduledOccurrences[2]).toMatchObject({ id: 'svc-3', windowStart: '09:00:00', windowEnd: '11:00:00' });
  });

  test('a date exception shifts by the anchor delta and keeps its flag; one that lands on cadence rejoins (flag cleared)', async () => {
    // Weekly from TARGET: index 2 cadence date = TARGET+14 = dayOffset(26).
    // svc-3 sits 2 days off cadence (customer traveling) → +2 delta → dayOffset(28), still an exception.
    // svc-4 (index 3, cadence dayOffset(33)) is flagged but sits at dayOffset(31) → +2 → dayOffset(33) = cadence → rejoins.
    const { updates, seriesMovesInsert } = wireSeriesMocks([
      sib('svc-1', BASE),
      sib('svc-2', SIB1),
      sib('svc-3', dayOffset(26), { date_exception: true, date_exception_source: 'admin' }),
      sib('svc-4', SIB3, { date_exception: true, date_exception_source: 'customer_sms' }),
    ]);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(updates[2].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(28) });
    expect(updates[2].update.mock.calls[0][0]).not.toHaveProperty('date_exception');
    expect(updates[3].update.mock.calls[0][0]).toMatchObject({
      scheduled_date: dayOffset(33), date_exception: false, date_exception_source: null, date_exception_at: null,
    });
    // A kept exception's series position moves to its new cadence slot.
    expect(updates[2].update.mock.calls[0][0]).toMatchObject({ date_exception_cadence_date: dayOffset(26) });
    expect(result.exceptionCount).toBe(1);
    expect(seriesMoveRow(seriesMovesInsert)).toMatchObject({ exception_count: 1, delta_days: 2 });
  });

  test('siblings are selected and ordered by SERIES POSITION, so an exception pulled before the anchor still moves with it', async () => {
    // svc-3 is the index-2 occurrence (cadence SIB2) the customer pulled to
    // dayOffset(8) — BEFORE the anchor's date. Position, not date, keeps it
    // in the sweep; the +2 delta lands it on dayOffset(10).
    const { updates, siblingsQuery } = wireSeriesMocks([
      sib('svc-1', BASE),
      sib('svc-2', SIB1),
      sib('svc-3', dayOffset(8), { date_exception: true, date_exception_cadence_date: SIB2 }),
    ]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(siblingsQuery.whereRaw).toHaveBeenCalledWith('COALESCE(date_exception_cadence_date, scheduled_date) >= ?::date', [BASE]);
    expect(siblingsQuery.orderByRaw).toHaveBeenCalledWith('COALESCE(date_exception_cadence_date, scheduled_date) asc, scheduled_date asc');
    expect(updates[2].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(10), date_exception_cadence_date: dayOffset(26) });
  });

  test('an anchor that was itself an exception defines the cadence again — its exception is cleared', async () => {
    const { updates } = wireSeriesMocks(
      [sib('svc-1', BASE, { date_exception: true, date_exception_cadence_date: dayOffset(9) }), sib('svc-2', SIB1)],
      { anchor: anchorRow({ date_exception: true, date_exception_cadence_date: dayOffset(9) }) },
    );
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(updates[0].update.mock.calls[0][0]).toMatchObject({ date_exception: false, date_exception_cadence_date: null });
  });

  test('an immovable (skipped) sibling never becomes the anchor — later siblings follow the collective move', async () => {
    const { updates, seriesMovesInsert } = wireSeriesMocks([
      sib('svc-1', BASE),
      sib('svc-2', SIB1, { status: 'skipped' }),
      sib('svc-3', SIB2),
    ]);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    // UPDATE chains are consumed per WRITTEN row: anchor, then svc-3. The
    // skipped row is counted for cadence math, never written.
    expect(updates[0].update.mock.calls[0][0]).toMatchObject({ scheduled_date: TARGET });
    // svc-3 keeps index 2 → TARGET + 14: projected from the NEW anchor, not from the skipped sibling.
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(26) });
    expect(updates[2].update).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
    expect(seriesMoveRow(seriesMovesInsert)).toMatchObject({ movable_count: 2, skipped_count: 1 });
  });
});

describe('rescheduleSeries — one recorded operation', () => {
  const sib = (id, date, extra = {}) => ({
    id, status: 'confirmed', scheduled_date: date, window_start: '09:00:00', window_end: '11:00:00', technician_id: null, route_order: 3, ...extra,
  });

  test('writes a committed series_moves row with counts + before/after snapshots carrying the RETURNING version stamp, links reschedule_log, returns the id', async () => {
    const { updates, seriesMovesInsert, logInsert, seriesMovesDb } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS, operationKey: 'op-123', sourceSurface: 'edit_modal',
    });
    const row = seriesMoveRow(seriesMovesInsert);
    expect(row).toMatchObject({
      id: result.seriesMoveId,
      operation_key: 'op-123',
      anchor_service_id: 'svc-1',
      parent_service_id: 'svc-1',
      customer_id: 'cust-1',
      source_surface: 'edit_modal',
      initiated_by: 'admin',
      reason_code: 'admin',
      original_date: BASE,
      new_date: TARGET,
      delta_days: 2,
      movable_count: 2,
      skipped_count: 0,
      exception_count: 0,
      conflict_count: 0,
      status: 'committed',
    });
    const rows = JSON.parse(row.rows);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'svc-1', anchor: true, before: { scheduled_date: BASE, route_order: 3, status: 'confirmed' }, after: { scheduled_date: TARGET, route_order: null, updated_at: 'stamp-0' } });
    // The SQL-computed expiry is a Raw expression in updateData: the snapshot
    // takes the persisted value from RETURNING (absent in this mock → null),
    // never the expression itself.
    expect(rows[0].after.track_token_expires_at).toBeNull();
    expect(updates[0].update).toHaveBeenCalledWith(expect.any(Object), expect.arrayContaining(['updated_at', 'track_token_expires_at', 'scheduled_date']));
    expect(rows[1]).toMatchObject({ id: 'svc-2', anchor: false, before: { scheduled_date: SIB1 }, after: { scheduled_date: dayOffset(19), updated_at: 'stamp-1' } });
    expect(logInsert.insert.mock.calls[0][0]).toMatchObject({ series_move_id: result.seriesMoveId, reason_code: 'admin_series' });
    // The replay payload is written WITH the row, inside the move trx.
    expect(JSON.parse(row.result)).toMatchObject({ success: true, newDate: TARGET, occurrencesRescheduled: 2, deltaDays: 2 });
    expect(seriesMovesDb.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deltaDays: 2, skippedCount: 0, exceptionCount: 0, occurrencesRescheduled: 2, seriesMoveId: row.id });
  });

  test('a kept sibling window must still pass the admin window rules — an off-hour sibling aborts with the visit named', async () => {
    wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1, { window_start: '09:30:00', window_end: '11:30:00' })]);
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ message: expect.stringContaining(`The future visit on ${SIB1} keeps a time this move can't carry forward`) });
  });

  test('a client operation_key reused for the same date but a DIFFERENT window is rejected (request_key bound), never replayed', async () => {
    wireSeriesMocks([sib('svc-1', BASE)], {
      priorMove: { id: 'sm-prior', new_date: TARGET, request_key: `svc-1:${TARGET}:09:00:11:00`, result: { success: true, newDate: TARGET } },
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '13:00', end: '15:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'OPERATION_KEY_REUSED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('an operation_key reused for a DIFFERENT target of the same appointment is rejected, never replayed', async () => {
    wireSeriesMocks([sib('svc-1', BASE)], {
      priorMove: { id: 'sm-prior', new_date: SIB1, result: { success: true, newDate: SIB1 } },
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'OPERATION_KEY_REUSED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('callers that mint no key get the request identity anchor:target:start; an older committed row with that key is superseded first', async () => {
    const { seriesMovesInsert, seriesMovesDb } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(seriesMoveRow(seriesMovesInsert)).toMatchObject({ operation_key: `svc-1:${TARGET}:09:00:11:00`, request_key: `svc-1:${TARGET}:09:00:11:00` });
    expect(seriesMovesDb.where).toHaveBeenCalledWith({ anchor_service_id: 'svc-1', operation_key: `svc-1:${TARGET}:09:00:11:00`, status: 'committed' });
    expect(seriesMovesInsert.update).toHaveBeenCalledWith({ status: 'superseded' });
  });

  test('clearAnchorWindow lands the anchor windowless IN the series transaction (legacy display fields cleared, reminder pre-closed)', async () => {
    const { updates } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    const AppointmentReminders = require('../services/appointment-reminders');
    const preclose = jest.spyOn(AppointmentReminders, 'precloseWindowlessReminderInTx').mockResolvedValue(undefined);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: null, end: null }, 'admin', 'admin', { ...ADMIN_OPTS, clearAnchorWindow: true });
    expect(updates[0].update.mock.calls[0][0]).toMatchObject({ scheduled_date: TARGET, window_start: null, window_end: null, time_window: null, window_display: null });
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ window_start: '09:00:00', window_end: '11:00:00' });
    expect(preclose).toHaveBeenCalledWith(expect.anything(), 'svc-1');
    expect(result.rescheduledOccurrences[0]).toMatchObject({ id: 'svc-1', windowStart: null, windowEnd: null });
    preclose.mockRestore();
  });

  test('a customer/SMS series path normalizes an off-hour kept sibling start to its hour (duration kept) instead of dead-ending; staff paths abort', async () => {
    const { updates } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1, { window_start: '09:15:00', window_end: '11:15:00' })]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve', {});
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ window_start: '09:00', window_end: '11:00' });
  });

  test('a pinned NULL window_start fences a window added meanwhile (presence-based, like window_end)', async () => {
    wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS, expectAnchor: { scheduled_date: BASE, window_start: null },
    })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
  });

  test('the series anchor pin also fences window_end and duration (a start-only resolution derives its window from them)', async () => {
    wireSeriesMocks([sib('svc-1', BASE, { estimated_duration_minutes: 90 }), sib('svc-2', SIB1)]);
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS, expectAnchor: { scheduled_date: BASE, window_start: '09:00:00', estimated_duration_minutes: 60 },
    })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
  });

  test('a repeated operation_key replays the committed result without re-running the sweep', async () => {
    const { priorLookup } = wireSeriesMocks([sib('svc-1', TARGET)], {
      anchor: anchorRow({ scheduled_date: TARGET }),
      priorMove: { id: 'sm-prior', new_date: TARGET, result: { success: true, newDate: TARGET, occurrencesRescheduled: 2, rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '09:00', windowEnd: '11:00' }] } },
    });
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' });
    expect(result).toMatchObject({ success: true, newDate: TARGET, occurrencesRescheduled: 2, seriesMoveId: 'sm-prior', replayed: true });
    expect(db.transaction).not.toHaveBeenCalled();
    // The replay lookup is scoped to THIS appointment's key.
    expect(priorLookup.where).toHaveBeenCalledWith({ anchor_service_id: 'svc-1', operation_key: 'op-123', status: 'committed' });
  });

  test('a replay whose stored result is missing rebuilds the occurrence list from the row snapshots', async () => {
    wireSeriesMocks([sib('svc-1', TARGET)], {
      anchor: anchorRow({ scheduled_date: TARGET }),
      priorMove: {
        id: 'sm-prior', result: null, original_date: BASE, new_date: TARGET, delta_days: 2, skipped_count: 1, exception_count: 0,
        rows: [
          { id: 'svc-1', after: { scheduled_date: TARGET, window_start: '09:00:00', window_end: '11:00:00' }, before: { window_start: '09:00:00' } },
          { id: 'svc-2', after: { scheduled_date: dayOffset(19), window_start: null, window_end: null }, before: { window_start: '09:00:00' } },
        ],
      },
    });
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' });
    expect(result).toMatchObject({
      replayed: true, seriesMoveId: 'sm-prior', occurrencesRescheduled: 2, deltaDays: 2, skippedCount: 1,
      rescheduledOccurrences: [
        { id: 'svc-1', date: TARGET, windowStart: '09:00:00', conflicted: false },
        { id: 'svc-2', date: dayOffset(19), windowStart: null, conflicted: true },
      ],
    });
  });

  test('the call-booked follow-up shift runs INSIDE the move transaction (non-idempotent — never on a replay)', async () => {
    const { shiftCallFollowUpsForParentMove } = require('../services/call-booking-catalog');
    wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(shiftCallFollowUpsForParentMove).toHaveBeenCalledTimes(1);
    const call = shiftCallFollowUpsForParentMove.mock.calls[0][0];
    expect(call).toMatchObject({ parentServiceId: 'svc-1', fromDate: BASE, toDate: TARGET });
    expect(call.conn).not.toBe(db);
  });

  test('a replay of a committed move re-runs the idempotent live-anchor cleanup (tech pointer release) but not the follow-up shift', async () => {
    const { clearTechCurrentJob } = require('../services/tech-status');
    const { shiftCallFollowUpsForParentMove } = require('../services/call-booking-catalog');
    wireSeriesMocks([sib('svc-1', BASE)], {
      priorMove: {
        id: 'sm-prior', new_date: TARGET, customer_id: 'cust-1',
        result: { success: true, newDate: TARGET, occurrencesRescheduled: 1, rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '09:00', windowEnd: '11:00' }] },
        rows: [{ id: 'svc-1', anchor: true, before: { status: 'on_site', technician_id: 'tech-9' }, after: {} }],
      },
      anchor: anchorRow({ scheduled_date: TARGET }),
    });
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' });
    expect(clearTechCurrentJob).toHaveBeenCalledWith({ tech_id: 'tech-9', current_job_id: 'svc-1', status: 'idle' });
    expect(shiftCallFollowUpsForParentMove).not.toHaveBeenCalled();
  });

  test('the LOSER of two concurrent identical operations (CAS 409 before the unique insert) replays the winner instead of failing', async () => {
    const winner = {
      id: 'sm-winner', new_date: TARGET, request_key: `svc-1:${TARGET}:09:00:11:00`,
      result: { success: true, newDate: TARGET, occurrencesRescheduled: 2, rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '09:00', windowEnd: '11:00' }] },
    };
    // Prior lookup: nothing BEFORE the trx, the winner's row AFTER the CAS
    // miss — and the anchor now sits where the winner left it.
    const { seriesMovesDb } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)], {
      updateResults: [[{ updated_at: 's' }], []],
      freshAnchor: anchorRow({ scheduled_date: TARGET, window_start: '09:00:00', window_end: '11:00:00' }),
    });
    seriesMovesDb.first.mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(result).toMatchObject({ replayed: true, seriesMoveId: 'sm-winner', occurrencesRescheduled: 2 });
    expect(seriesMovesDb.insert).not.toHaveBeenCalled();
  });

  test('a conflict on a return move (A→B, B→C, C→B) never replays the OLD A→B row: only a concurrent winner with the anchor on the slot counts', async () => {
    const C = dayOffset(20);
    const oldRow = {
      id: 'sm-old', created_at: new Date(Date.now() - 60 * 1000), original_date: BASE, new_date: TARGET, request_key: `svc-1:${TARGET}:09:00:11:00`,
      result: { success: true, newDate: TARGET, occurrencesRescheduled: 2, rescheduledOccurrences: [{ id: 'svc-1', date: TARGET, windowStart: '09:00', windowEnd: '11:00' }] },
    };
    // Pre-trx lookup sees the A→B row; the request was observed at C, so the
    // return move proceeds — then its CAS misses (slot conflict) and the
    // catch-side lookup finds only that same old row, anchor still at C.
    const { priorLookup, seriesMovesDb } = wireSeriesMocks([sib('svc-1', C), sib('svc-2', SIB1)], {
      anchor: anchorRow({ scheduled_date: C }),
      priorMove: oldRow,
      updateResults: [[{ updated_at: 's' }], []],
      freshAnchor: anchorRow({ scheduled_date: C }),
    });
    priorLookup.first.mockResolvedValueOnce(oldRow).mockResolvedValueOnce(oldRow);
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', {
      ...ADMIN_OPTS, expectAnchor: { scheduled_date: C, window_start: '09:00:00' },
    })).rejects.toMatchObject({ statusCode: 409 });
    // The catch-side lookup fences on the judged row's commit time.
    expect(priorLookup.where).toHaveBeenCalledWith('created_at', '>', oldRow.created_at);
    expect(priorLookup.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(seriesMovesDb.insert).not.toHaveBeenCalled();
  });

  test('a rolled-back sweep records a failed series_moves row outside the transaction and rethrows', async () => {
    const { seriesMovesDb, seriesMovesInsert } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)], { updateResults: [[{ updated_at: 's' }], []] });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(seriesMovesInsert.insert).not.toHaveBeenCalled();
    expect(seriesMovesDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', anchor_service_id: 'svc-1', source_surface: 'dispatch_board', delta_days: 2,
      error: expect.stringContaining('changed concurrently'),
    }));
  });

  test('the per-parent maintenance lock is taken AFTER the date-occupancy locks and BEFORE the locked re-read the sweep writes from', async () => {
    const { siblingsQuery, siblingsReread, trx, updates } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    const rawOrder = (pred) => {
      const idx = trx.raw.mock.calls.findIndex(([, bindings]) => Array.isArray(bindings) && pred(bindings));
      expect(idx).toBeGreaterThan(-1);
      return trx.raw.mock.invocationCallOrder[idx];
    };
    // Byte-identical key to admin-schedule's acquireRecurringSeriesMaintenanceLock.
    const maintenance = rawOrder((b) => b[0] === 'recurring-series-maintenance' && b[1] === 'svc-1');
    const lastOccupancy = Math.max(...trx.raw.mock.calls
      .map(([, b], i) => (Array.isArray(b) && String(b[1]).startsWith('occupancy:') ? trx.raw.mock.invocationCallOrder[i] : -1)));
    expect(lastOccupancy).toBeGreaterThan(-1);
    const unlockedRead = siblingsQuery.select.mock.invocationCallOrder[0];
    const lockedRead = siblingsReread.select.mock.invocationCallOrder[0];
    expect(unlockedRead).toBeLessThan(lastOccupancy);
    expect(lastOccupancy).toBeLessThan(maintenance);
    expect(maintenance).toBeLessThan(lockedRead);
    expect(lockedRead).toBeLessThan(updates[0].update.mock.invocationCallOrder[0]);
  });

  test('a series that changed between the unlocked read and the locked re-read (an auto-extend child landed) aborts 409 SERIES_CHANGED — nothing written, failure recorded', async () => {
    const before = [sib('svc-1', BASE), sib('svc-2', SIB1)];
    const { updates, seriesMovesInsert, seriesMovesDb } = wireSeriesMocks(before, {
      lockedSiblings: [...before, sib('svc-3', SIB2, { status: 'pending' })],
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERIES_CHANGED' });
    expect(updates[0].update).not.toHaveBeenCalled();
    expect(seriesMovesInsert.insert).not.toHaveBeenCalled();
    expect(seriesMovesDb.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', anchor_service_id: 'svc-1' }));
  });

  test('a sibling whose movability flipped under the locks (confirmed → skipped) is a changed series too — 409, not a sweep over a stale picture', async () => {
    const { updates } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)], {
      lockedSiblings: [sib('svc-1', BASE), sib('svc-2', SIB1, { status: 'skipped' })],
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERIES_CHANGED' });
    expect(updates[0].update).not.toHaveBeenCalled();
  });

  test('a cadence edit that committed while the move waited on the lock (pattern/interval/ordinal/weekend config) is a changed series — 409 SERIES_CHANGED', async () => {
    const { updates, parentReread } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)], {
      lockedParent: anchorRow({ recurring_pattern: 'biweekly' }),
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS))
      .rejects.toMatchObject({ statusCode: 409, code: 'SERIES_CHANGED' });
    expect(parentReread.first).toHaveBeenCalledWith('recurring_pattern', 'recurring_interval_days', 'recurring_nth', 'recurring_weekday', 'skip_weekends', 'weekend_shift');
    expect(updates[0].update).not.toHaveBeenCalled();
  });

  test('a skipped sibling still reserves its cadence slot: the movable row behind it lands on the NEXT slot, not the one the skipped row owns', async () => {
    // Daily custom cadence, weekends skipped; Wednesday W → Friday F. Index 1
    // (Sat → Mon) is skipped and is not written, but Monday is its slot; the
    // movable index 2 (Sun → Mon) therefore lands on Tuesday.
    let W = dayOffset(10);
    while (etParts(parseETDateTime(`${W}T12:00`)).dayOfWeek !== 3) W = etDateString(addETDays(parseETDateTime(`${W}T12:00`), 1));
    const day = (n) => etDateString(addETDays(parseETDateTime(`${W}T12:00`), n));
    const { updates } = wireSeriesMocks([
      sib('svc-1', W),
      sib('svc-2', day(1), { status: 'skipped' }),
      sib('svc-3', day(2)),
    ], { anchor: anchorRow({ scheduled_date: W, recurring_pattern: 'custom', recurring_interval_days: 1, skip_weekends: true }) });
    const result = await SmartRebooker.rescheduleSeries('svc-1', day(2), { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(result.skippedCount).toBe(1);
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ scheduled_date: day(6) }); // Tue — Monday is the skipped row's slot
  });

  test('the sweep writes from the LOCKED read: a window that changed between the reads is what the sibling keeps', async () => {
    const { updates } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)], {
      lockedSiblings: [sib('svc-1', BASE), sib('svc-2', SIB1, { window_start: '13:00:00', window_end: '15:00:00' })],
    });
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ scheduled_date: dayOffset(19), window_start: '13:00:00', window_end: '15:00:00' });
  });

  test('an exception records the COLLISION-ADJUSTED cadence slot as its position — never a raw cadence date another row already owns', async () => {
    // Daily custom cadence with weekends skipped. Old anchor = a Wednesday W,
    // moved +2 to Friday F. Projected from F: index 1 = Sat → Mon; index 2 =
    // Sun → Mon, taken → Tue; the index-2 exception (W+5, a Monday) shifts by
    // the delta to Wed and keeps its flag, so its position is Tue (slot 2),
    // not the raw Monday the index-1 row owns; index 3 = Mon → Tue → Wed all
    // taken → Thu.
    let W = dayOffset(10);
    while (etParts(parseETDateTime(`${W}T12:00`)).dayOfWeek !== 3) W = etDateString(addETDays(parseETDateTime(`${W}T12:00`), 1));
    const day = (n) => etDateString(addETDays(parseETDateTime(`${W}T12:00`), n));
    const F = day(2);
    const { updates } = wireSeriesMocks([
      sib('svc-1', W),
      sib('svc-2', day(1)),
      sib('svc-3', day(5), { date_exception: true, date_exception_source: 'admin', date_exception_cadence_date: day(2) }),
      sib('svc-4', day(3)),
    ], { anchor: anchorRow({ scheduled_date: W, recurring_pattern: 'custom', recurring_interval_days: 1, skip_weekends: true }) });
    const result = await SmartRebooker.rescheduleSeries('svc-1', F, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(result.success).toBe(true);
    expect(updates[1].update.mock.calls[0][0]).toMatchObject({ scheduled_date: day(5) }); // Mon
    expect(updates[2].update.mock.calls[0][0]).toMatchObject({ scheduled_date: day(7), date_exception_cadence_date: day(6) }); // Wed, position Tue
    expect(updates[2].update.mock.calls[0][0]).not.toHaveProperty('date_exception');
    expect(updates[3].update.mock.calls[0][0]).toMatchObject({ scheduled_date: day(8) }); // Thu
  });
});

describe('previewSeriesMove', () => {
  test('counts come from the same sibling selection + projector as the move; conflicts probed per projected sibling', async () => {
    const anchor = anchorRow();
    const siblings = [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'skipped', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-3', status: 'pending', scheduled_date: dayOffset(26), window_start: '09:00:00', window_end: '11:00:00', date_exception: true },
      { id: 'svc-4', status: 'pending', scheduled_date: SIB3, window_start: null, window_end: null },
    ];
    const dbQueries = [
      chain({ first: jest.fn().mockResolvedValue(anchor) }),
      chain({ first: jest.fn().mockResolvedValue(anchor) }),
      chain({ select: jest.fn().mockResolvedValue(siblings) }),
    ];
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return dbQueries.shift();
      if (table === 'property_preferences') return chain({ first: jest.fn().mockResolvedValue(null) });
      throw new Error(`Unexpected db table ${table}`);
    });
    findConflictingVisits.mockResolvedValueOnce([{ id: 'other' }]);
    const preview = await SmartRebooker.previewSeriesMove('svc-1', TARGET);
    expect(preview).toEqual({
      collective: true,
      deltaDays: 2,
      movableCount: 3,
      skippedCount: 1,
      exceptionCount: 1,
      conflictCount: 1,
      firstAffectedDate: TARGET,
      lastAffectedDate: dayOffset(33),
    });
    // Only the timed sibling (svc-3) was probed: the anchor's window is the
    // caller's choice and the windowless svc-4 occupies nothing.
    expect(findConflictingVisits).toHaveBeenCalledTimes(1);
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ date: dayOffset(28), excludeServiceIds: ['svc-1', 'svc-3', 'svc-4'] }));
  });

  test('same date, one-time row → not collective, zero counts', async () => {
    db.mockImplementation(() => chain({ first: jest.fn().mockResolvedValue(anchorRow({ is_recurring: false })) }));
    expect(await SmartRebooker.previewSeriesMove('svc-1', TARGET)).toMatchObject({ collective: false, movableCount: 0 });
  });
});

describe('migration backfill — cadence deviations (modal-moved exceptions with no reschedule_log)', () => {
  const { planCadenceExceptions } = require('../models/migrations/20260828000030_series_moves_and_date_exception.js');
  const parent = { id: 'p', recurring_pattern: 'weekly', recurring_nth: null, recurring_weekday: null, recurring_interval_days: null, skip_weekends: false };

  test('an occurrence off the series cadence is planned with the cadence date as its position; on-cadence and already-flagged rows are not', () => {
    const rows = [
      { id: 'a', scheduled_date: BASE },
      { id: 'b', scheduled_date: SIB1 },
      { id: 'c', scheduled_date: dayOffset(26), date_exception: false },          // cadence SIB2 = dayOffset(24) → deviates by +2
      { id: 'd', scheduled_date: dayOffset(33), date_exception: true, date_exception_cadence_date: SIB3 }, // already flagged
      { id: 'e', scheduled_date: dayOffset(38) },                                  // cadence dayOffset(38) = on time
    ];
    expect(planCadenceExceptions(parent, rows)).toEqual({ planned: [{ id: 'c', expected: SIB2 }], ambiguous: false });
  });

  test('the cadence is derived from the MAJORITY, not from the first row — a moved first occurrence is the exception, later rows are not', () => {
    const rows = [
      { id: 'a', scheduled_date: dayOffset(12) }, // moved from BASE via the modal (no log)
      { id: 'b', scheduled_date: SIB1 },
      { id: 'c', scheduled_date: SIB2 },
      { id: 'd', scheduled_date: SIB3 },
    ];
    expect(planCadenceExceptions(parent, rows)).toEqual({ planned: [{ id: 'a', expected: BASE }], ambiguous: false });
  });

  test('an exception moved PAST its siblings reorders the date ranks — no origin explains the series, so it is reported ambiguous (the caller preserves it wholesale)', () => {
    // Weekly D, D+7, D+14, D+21; the first occurrence was moved to D+19 and
    // now sorts between the 3rd and 4th. Nothing in the schema proves its
    // original slot, so the migration must not guess.
    const rows = [
      { id: 'b', scheduled_date: SIB1 },
      { id: 'c', scheduled_date: SIB2 },
      { id: 'a', scheduled_date: dayOffset(29) },
      { id: 'd', scheduled_date: SIB3 },
    ];
    expect(planCadenceExceptions(parent, rows)).toEqual({ planned: [], ambiguous: true });
  });

  test('the cadence-deviation backfill leaves a row whose ONLY logged date moves were auto_dispatch to regenerate (optimizer placement is not intent); unlogged and manually-moved rows are stamped', () => {
    const src = fs.readFileSync(path.join(__dirname, '../models/migrations/20260828000030_series_moves_and_date_exception.js'), 'utf8');
    const loop = src.slice(src.indexOf('const plannedIds = plan.planned.map((entry) => entry.id);'), src.indexOf("date_exception_source: 'backfill_cadence'"));
    expect(loop).toContain(".whereRaw('original_date <> new_date')");
    expect(loop).toContain("if (initiators.length && initiators.every((who) => who === 'auto_dispatch')) optimizerOnly.add(id);");
    expect(loop).toContain('if (optimizerOnly.has(String(entry.id))) {');
  });

  test('a series no origin can explain for a majority is left alone (ambiguous); no pattern or a single row plans nothing', () => {
    expect(planCadenceExceptions(parent, [{ id: 'a', scheduled_date: BASE }, { id: 'b', scheduled_date: dayOffset(19) }])).toEqual({ planned: [], ambiguous: true });
    expect(planCadenceExceptions({ ...parent, recurring_pattern: null }, [{ id: 'a', scheduled_date: BASE }, { id: 'b', scheduled_date: SIB1 }])).toEqual({ planned: [], ambiguous: false });
    expect(planCadenceExceptions(parent, [{ id: 'a', scheduled_date: BASE }])).toEqual({ planned: [], ambiguous: false });
  });
});

describe('caller wiring (source)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('series text: the recorded window is rechecked before sending, reminders close under the captured guards, and the terminal marker lands after the re-arm', () => {
    const disp = read('../routes/admin-dispatch.js');
    const fn = disp.indexOf('async function applySeriesMoveEffects(');
    const body = disp.slice(fn, disp.indexOf('async function reconcileSeriesMoveEffects('));
    expect(body).toContain("hm(row.window_start) === recordedStart");
    expect(body).toContain('guardsByServiceId ? { guardsByServiceId } : {}');
    const rearm = body.indexOf('await rearmRescheduleReminderWindows(');
    const terminal = body.indexOf("stampMarker('notified_at', { customer_notified: false })");
    expect(rearm).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(rearm);
  });

  test('SMS-reply effects — the customer confirmation included — run through the durable shared pass; the 15-minute cron reconciles dead passes', () => {
    const sms = read('../services/reschedule-sms.js');
    expect(sms).toContain("const { applySeriesMoveEffects } = require('../routes/admin-dispatch');");
    expect(sms).toContain("sourceSurface: 'sms_reply',\n            notifyRequested: true,");
    expect(sms).not.toContain('notify: false');
    expect(read('../index.js')).toContain("runExclusive('series-move-effects-reconcile'");
  });

  test('an SMS reply pins the schedule it observed on the move (the series path tells a return move from a stale retry by it)', () => {
    const sms = read('../services/reschedule-sms.js');
    expect(sms).toContain("observedSchedule = svc ? { scheduled_date: toYmd(svc.scheduled_date), window_start: svc.window_start ?? null } : null;");
    expect(sms).toContain('...(observedSchedule ? { expect: observedSchedule } : {}),');
  });

  test('series effects: an occurrence rescheduled again since (stale sync, or a guard off this move\'s time) is excluded from the close and the re-arm', () => {
    const disp = read('../routes/admin-dispatch.js');
    const sync = disp.slice(disp.indexOf('async function syncRescheduleReminder('), disp.indexOf('async function markRescheduleReminderNotified('));
    expect(sync).toContain("if (synced && synced.skippedStale === true) return 'stale';");
    const fn = disp.indexOf('async function applySeriesMoveEffects(');
    const body = disp.slice(fn, disp.indexOf('async function reconcileSeriesMoveEffects('));
    expect(body).toContain("if (synced === 'stale') {");
    expect(body).toContain('seriesReminderGuards.push(...ownedGuards(occurrenceGuards));');
    expect(body).toContain('const closeIds = ownedOccurrences()');
    // The text and the close are separate recorded steps: customer_notified is written BEFORE the close is attempted, a failed close leaves notified_at NULL, and a retry with the text already out redoes ONLY the close.
    expect(body).toContain('await recordCustomerNotified();\n            await closeSeriesReminders();');
    expect(body).toContain('} else if (notify && markers.customer_notified === true) {');
    expect(body).toContain('const closed = await markRescheduleReminderNotified(closeIds, guardsByServiceId ? { guardsByServiceId } : {});');
    expect(body).toContain("if (!closed) {");
    expect(disp.slice(disp.indexOf('async function markRescheduleReminderNotified('), disp.indexOf('// Snapshot the reminder rows THIS request just synced'))).toContain('return outcome !== null && outcome !== undefined;');
    expect(body).toContain('await rearmRescheduleReminderWindows(guardsForRearm, ownedOccurrences().map((occurrence) => ({');
    // A retry pass re-arms guarded on a fresh, owned snapshot — not unguarded over every occurrence.
    expect(body).toContain('const retryGuards = ownedGuards(await captureReminderGuards(ownedOccurrences().map((occurrence) => occurrence.id)));');
  });

  test('the Edit appointment series commit pins date, start, end AND duration on the anchor (the fields the landing window was derived from)', () => {
    const sched = read('../routes/admin-schedule.js');
    const fn = sched.indexOf('async function planCollectiveEditDateMove(req)');
    const body = sched.slice(fn, sched.indexOf("router.put('/:id/update-details'"));
    expect(body).toContain('window_end: row.window_end ?? null,');
    expect(body).toContain('estimated_duration_minutes: postEditDuration,');
    expect(body).toContain("const postEditDuration = (req.body.estimatedDuration !== undefined && req.body.estimatedDuration !== '')");
  });

  test('the dispatch explicit series path fences on the FULL pin the resolution read; a retryable provider failure keeps the series text pending; a partial guard map never closes an uncovered id', () => {
    const disp = read('../routes/admin-dispatch.js');
    const seriesBranch = disp.slice(disp.indexOf("if (scope === 'series') {"), disp.indexOf("const effects = await applySeriesMoveEffects({", disp.indexOf("if (scope === 'series') {")));
    expect(seriesBranch).toContain('{ expectAnchor: rescheduleExpectPredicate(observedAnchor) }');
    expect(seriesBranch).not.toContain('window_start: observedAnchor.window_start ?? null');
    const fn = disp.indexOf('async function applySeriesMoveEffects(');
    const body = disp.slice(fn, disp.indexOf('async function reconcileSeriesMoveEffects('));
    expect(body).toContain('definitiveNonSend = sendOutcome.lastDeferred !== true && sendOutcome.retryable !== true;');
    expect(body).toContain('.filter((id) => !guardsByServiceId || Object.prototype.hasOwnProperty.call(guardsByServiceId, id));');
    expect(body).toContain('const closed = await markRescheduleReminderNotified(closeIds, guardsByServiceId ? { guardsByServiceId } : {});');
  });

  test('auto-dispatch hard-codes seriesPolicy single on its own move — never a caller convention', () => {
    const src = read('../services/auto-dispatch/apply.js');
    const policyIdx = src.indexOf("options.seriesPolicy = 'single';");
    const moveIdx = src.indexOf("SmartRebooker.reschedule(service.id, best.date, newWindow, 'auto_dispatch', 'auto_dispatch', options)");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(moveIdx).toBeGreaterThan(policyIdx);
  });

  test('the IB reschedule tool refuses a gated cadence date move instead of moving one row (until its series path lands)', () => {
    const src = read('../services/intelligence-bar/tools.js');
    const fn = src.indexOf('async function rescheduleAppointment(input)');
    const refuse = src.indexOf("code: 'COLLECTIVE_MOVE_REQUIRED'", fn);
    const write = src.indexOf('scheduled_date: dateStr,', fn);
    expect(refuse).toBeGreaterThan(fn);
    expect(refuse).toBeLessThan(write);
    expect(src.slice(fn, refuse)).toContain('collectiveMoveGateOn() && appt.is_recurring === true && dateStr !== oldDateStr');
  });

  test('rain-out fallback and the customer web single branch opt out; the edit modal intercepts BEFORE its per-row edit', () => {
    // Quick Move's series behavior is owned by its own gate + effects path:
    // its single call always opts out of the collective choke point.
    expect(read('../services/rain-out.js')).toMatch(/excludeServiceIds: \[job\.id\],[\s\S]{0,900}seriesPolicy: 'single',/);
    expect(read('../routes/reschedule-public.js')).toContain("{ technicianId: slot.technician_id, seriesPolicy: 'single' }");
    const sched = read('../routes/admin-schedule.js');
    const handler = sched.indexOf("router.put('/:id/update-details'");
    // Disclosure: without seriesAck the planner refuses up front (nothing saved) with the preview.
    expect(sched.slice(sched.indexOf('async function planCollectiveEditDateMove'), handler)).toContain("code: 'COLLECTIVE_MOVE_ACK_REQUIRED'");
    const disp = read('../routes/admin-dispatch.js');
    expect(disp).toContain("if (collectiveMoveGateOn() && req.body.seriesAck !== true) {");
    const plan = sched.indexOf('const seriesMovePlan = await planCollectiveEditDateMove(req);', handler);
    const destructure = sched.indexOf('} = req.body;', handler);
    const commit = sched.indexOf('seriesMove = await seriesMovePlan.commit();', handler);
    const notice = sched.indexOf('// Immediate reschedule text', handler);
    expect(plan).toBeGreaterThan(handler);
    expect(plan).toBeLessThan(destructure);
    expect(sched.slice(plan, destructure)).toContain('delete req.body.scheduledDate;');
    // The series commits only after the per-row edit — before the notice
    // block, after every validation the handler can still fail on.
    expect(commit).toBeGreaterThan(destructure);
    expect(commit).toBeLessThan(notice);
  });
});
