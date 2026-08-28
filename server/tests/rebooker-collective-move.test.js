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
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

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

// Series harness (mirrors rebooker-live-reschedule-override): sibling SELECT,
// same-series clash probe, then one UPDATE chain per sibling in order.
function wireSeriesMocks(siblings, { anchor = anchorRow(), priorMove = null, updateResults = null } = {}) {
  const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
  const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
  const updates = siblings.map((_, i) => chain({
    update: jest.fn().mockResolvedValue(updateResults ? updateResults[i] : [{ updated_at: `stamp-${i}` }]),
  }));
  const historyInsert = chain();
  const logInsert = chain();
  const seriesMovesInsert = chain();

  const scheduledQueue = [siblingsQuery, seriesClashProbe, ...updates];
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

  return { updates, historyInsert, logInsert, seriesMovesInsert, seriesMovesDb, priorLookup, siblingsQuery };
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

  function wireLookup(svc) {
    db.transaction = jest.fn();
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain({ first: jest.fn().mockResolvedValue(svc) });
      throw new Error(`Unexpected db table ${table}`);
    });
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
      expectAnchor: { scheduled_date: BASE, window_start: '09:00:00' },
    });
    expect(db.transaction).not.toHaveBeenCalled();
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

  test('an operation_key reused for a DIFFERENT target of the same appointment is rejected, never replayed', async () => {
    wireSeriesMocks([sib('svc-1', BASE)], {
      priorMove: { id: 'sm-prior', new_date: SIB1, result: { success: true, newDate: SIB1 } },
    });
    await expect(SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'OPERATION_KEY_REUSED' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('callers that mint no key get the action identity anchor:from:to as the operation key', async () => {
    const { seriesMovesInsert, seriesMovesDb } = wireSeriesMocks([sib('svc-1', BASE), sib('svc-2', SIB1)]);
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin', 'admin', ADMIN_OPTS);
    expect(seriesMoveRow(seriesMovesInsert)).toMatchObject({ operation_key: `svc-1:${BASE}:${TARGET}` });
    expect(seriesMovesDb.where).toHaveBeenCalledWith({ anchor_service_id: 'svc-1', operation_key: `svc-1:${BASE}:${TARGET}`, status: 'committed' });
  });

  test('a repeated operation_key replays the committed result without re-running the sweep', async () => {
    const { priorLookup } = wireSeriesMocks([sib('svc-1', BASE)], {
      priorMove: { id: 'sm-prior', new_date: TARGET, result: { success: true, newDate: TARGET, occurrencesRescheduled: 2 } },
    });
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00' }, 'admin', 'admin', { ...ADMIN_OPTS, operationKey: 'op-123' });
    expect(result).toEqual({ success: true, newDate: TARGET, occurrencesRescheduled: 2, seriesMoveId: 'sm-prior', replayed: true });
    expect(db.transaction).not.toHaveBeenCalled();
    // The replay lookup is scoped to THIS appointment's key.
    expect(priorLookup.where).toHaveBeenCalledWith({ anchor_service_id: 'svc-1', operation_key: 'op-123', status: 'committed' });
  });

  test('a replay whose stored result is missing rebuilds the occurrence list from the row snapshots', async () => {
    wireSeriesMocks([sib('svc-1', BASE)], {
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

describe('caller wiring (source)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

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
    // Quick Move's single call opts out ONLY after an explicit series attempt
    // (wantsSeriesShift) — with the older series gate off, the choke point decides.
    expect(read('../services/rain-out.js')).toMatch(/excludeServiceIds: \[job\.id\],[\s\S]{0,900}\.\.\.\(wantsSeriesShift\s*\?\s*\{ seriesPolicy: 'single'/);
    expect(read('../routes/reschedule-public.js')).toContain("{ technicianId: slot.technician_id, seriesPolicy: 'single' }");
    const sched = read('../routes/admin-schedule.js');
    const handler = sched.indexOf("router.put('/:id/update-details'");
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
