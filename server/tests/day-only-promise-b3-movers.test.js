// GATE_DAY_ONLY_PROMISE part B3: every intent write is bound to its OWN move. The mover writes customer_asked_time and
// customer_asked_time_at in the SAME UPDATE that changes the slot (time-promise.js moveIntentColumns), so a stalled effect can
// no longer land over a later move's intent (A -> B -> C -> B). Real rebooker over the table-queue stand-ins of
// rebooker-live-reschedule-override.test.js; synthetic data only.
jest.mock('../models/db', () => jest.fn());
// The follow-up shift is a separate fenced+transactional unit with its own
// suite (call-booking-catalog.test.js) — here we only verify the rebooker
// invokes it with the right args and swallows its failures.
jest.mock('../services/call-booking-catalog', () => ({
  ...jest.requireActual('../services/call-booking-catalog'),
  shiftCallFollowUpsForParentMove: jest.fn().mockResolvedValue(0),
  planCallFollowUpShift: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/tech-status', () => ({
  clearTechCurrentJob: jest.fn().mockResolvedValue(null),
}));
// Tech-facing notices (tech-visit-notifications.js) ride the rebooker's
// post-commit tail; the hook contract (sides, actor, previous slot) is
// asserted below, the service itself in tech-visit-notifications.test.js.
jest.mock('../services/tech-visit-notifications', () => ({
  notifyAssignmentChange: jest.fn().mockResolvedValue(undefined),
  notifyVisitRescheduled: jest.fn().mockResolvedValue(undefined),
}));
// Inert blackout lookups: rescheduleSeries' non-admin guards (blackout, then
// seasonal winter) lazy-require this module, and the real one queries the db.
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
  isBlackoutDate: jest.fn().mockResolvedValue(false),
  getWeeklyDaysOff: jest.fn().mockResolvedValue([]),
  expandWeeklyDaysOff: jest.fn().mockReturnValue(new Set()),
  WEEKLY_DAYS_OFF_KEY: 'weekly_days_off',
}));
const mockIoEmit = jest.fn();
const mockIoTo = jest.fn(() => ({ emit: mockIoEmit }));
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => ({ to: mockIoTo })),
}));
// The shared tech-blind occupancy gate has its own suites
// (scheduling-occupancy.test.js, rebooker-occupancy-conflict.test.js); this
// file exercises the allowLive/tech-scoped semantics, so the module is
// stubbed clean here to keep the table-queue mocks focused.
jest.mock('../services/scheduling/occupancy', () => ({
  findConflictingVisits: jest.fn().mockResolvedValue([]),
  // Date-wide occupancy locks (asserted in rebooker-occupancy-conflict /
  // scheduling-occupancy) stubbed inert here too.
  acquireOccupancyLock: jest.fn().mockResolvedValue(undefined),
  acquireOccupancyLocks: jest.fn().mockResolvedValue(undefined),
  // The move's CAS pins the technician only while the scoped probe is live.
  techScopedConfirmActive: jest.fn(() => false),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const SmartRebooker = require('../services/rebooker');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { clearTechCurrentJob } = require('../services/tech-status');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

// reschedule() rejects past target dates against the REAL clock, so fixture
// dates must be dynamic — hardcoded ones time-bomb the suite when the
// calendar catches up (this file died on 2026-07-01 for exactly that).
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));
const BASE = dayOffset(10); // anchor's original date
const TARGET = dayOffset(12); // reschedule target (+2 days)
const SIB1 = dayOffset(17); // weekly sibling 1 (BASE + 7)
const SIB1_SHIFTED = dayOffset(19); // sibling 1 recomputed from the new anchor (TARGET + 7)
const SIB2 = dayOffset(24); // weekly sibling 2 (BASE + 14)
const SIB2_SHIFTED = dayOffset(26); // sibling 2 recomputed (TARGET + 14)

// An UPDATE result that resolves to the row count like knex AND answers
// `.returning([...])` with the committed row (the reschedule writer reads the
// committed technician_id off the CAS write).
function updateResult(count, rows) {
  const p = Promise.resolve(count);
  return {
    then: p.then.bind(p),
    catch: p.catch.bind(p),
    returning: jest.fn().mockResolvedValue(rows ?? (count ? [{ id: 'svc-1', technician_id: 'tech-1' }] : [])),
  };
}

function chain(overrides = {}) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) {
      // Grouped-where callbacks receive the builder both as `this` AND as
      // the first arg (knex passes the sub-builder as the parameter).
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
    first: jest.fn(),
    update: jest.fn().mockImplementation(() => updateResult(1)),
    insert: jest.fn().mockResolvedValue(),
    count: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    orderByRaw: jest.fn().mockReturnThis(),
  });
  return Object.assign(builder, overrides);
}

function rawFactory(label) {
  return jest.fn((sql, bindings) => ({ label, sql, bindings }));
}

function liveService(status) {
  return {
    id: 'svc-1',
    customer_id: 'cust-1',
    technician_id: 'tech-1',
    scheduled_date: BASE,
    window_start: '09:00:00',
    window_end: '11:00:00',
    status,
  };
}

// Wire db/trx mocks for a full single-job reschedule pass.
function wireRescheduleMocks(service) {
  const serviceLookup = chain({ first: jest.fn().mockResolvedValue(service) });
  const updateQuery = chain({ update: jest.fn().mockImplementation(() => updateResult(1)) });
  const historyInsert = chain();
  const logInsert = chain();
  const logCount = chain({ first: jest.fn().mockResolvedValue({ count: '1' }) });

  const trx = jest.fn((table) => {
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) });
    if (table === 'scheduled_services') return updateQuery;
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    if (table === 'series_moves') return chain();
    if (table === 'technicians') return chain({ first: jest.fn().mockResolvedValue({ id: 't2', employment_status: 'active', field_dispatchable: true }) });
    if (table === 'technician_absences') return chain();
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.fn = { now: jest.fn(() => 'NOW()') };

  const dbQueries = [serviceLookup, logCount];
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return dbQueries.shift();
    // The series writer always looks up a prior operation_key first — none here.
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { updateQuery, historyInsert };
}


const NOW_RAW = { label: 'trx.raw', sql: 'now()', bindings: undefined };
const timePromise = require('../services/time-promise');
const OLD_GATE = process.env.GATE_DAY_ONLY_PROMISE;

beforeEach(() => {
  jest.clearAllMocks();
  db.raw = rawFactory('db.raw');
  db.transaction = undefined;
  process.env.GATE_DAY_ONLY_PROMISE = 'true';
});
afterEach(() => {
  if (OLD_GATE === undefined) delete process.env.GATE_DAY_ONLY_PROMISE; else process.env.GATE_DAY_ONLY_PROMISE = OLD_GATE;
});

const move = (options, initiatedBy = 'admin') => SmartRebooker.reschedule(
  'svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', initiatedBy, { allowLive: true, seriesPolicy: 'single', ...options },
);
function wireSeriesMocks(anchorStatus, siblings, { preferredDay = null, anchorOverrides = {} } = {}) {
  const anchor = {
    ...liveService(anchorStatus),
    recurring_parent_id: null,
    is_recurring: true,
    recurring_pattern: 'weekly',
    recurring_nth: null,
    recurring_weekday: null,
    recurring_interval_days: null,
    ...anchorOverrides,
  };
  const anchorLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const parentLookup = chain({ first: jest.fn().mockResolvedValue(anchor) });
  const siblingsQuery = chain({ select: jest.fn().mockResolvedValue(siblings) });
  // Same-series date-collision probe (codex r6 on #2725) runs once before
  // any row updates — no clash by default.
  const seriesClashProbe = chain({ first: jest.fn().mockResolvedValue(undefined) });
  const updates = siblings.map(() => chain({ update: jest.fn().mockImplementation(() => updateResult(1)) }));
  const historyInsert = chain();
  const logInsert = chain();

  const scheduledQueue = [siblingsQuery, siblingsQuery, parentLookup, seriesClashProbe, ...updates];
  const trx = jest.fn((table) => {
    // The locked (FOR SHARE) re-read of the preference answers the same
    // verdict the pre-trx read did.
    if (table === 'property_preferences') return chain({ forShare: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(preferredDay ? { preferred_day: preferredDay } : null) });
    if (table === 'scheduled_services') return scheduledQueue.shift();
    if (table === 'job_status_history') return historyInsert;
    if (table === 'reschedule_log') return logInsert;
    if (table === 'series_moves') return chain();
    if (table === 'technicians') return chain({ first: jest.fn().mockResolvedValue({ id: 't2', employment_status: 'active', field_dispatchable: true }) });
    if (table === 'technician_absences') return chain();
    throw new Error(`Unexpected trx table ${table}`);
  });
  trx.raw = rawFactory('trx.raw');
  trx.fn = { now: jest.fn(() => 'NOW()') };
  db.transaction = jest.fn(async (callback) => callback(trx));

  const dbQueries = [anchorLookup, parentLookup];
  // Post-commit escalation check (mirrors the single path since codex r4
  // on #2725) reads reschedule_log via db — serve an under-threshold count.
  const escalationCount = chain({ first: jest.fn().mockResolvedValue({ count: '0' }) });
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return dbQueries.shift();
    if (table === 'reschedule_log') return escalationCount;
    // B6: rescheduleSeries consults the customer's live weekday preference.
    if (table === 'property_preferences') {
      return chain({ first: jest.fn().mockResolvedValue(preferredDay ? { preferred_day: preferredDay } : null) });
    }
    // The series writer always looks up a prior operation_key first — none here.
    if (table === 'series_moves') return chain();
    throw new Error(`Unexpected db table ${table}`);
  });

  return { updates, historyInsert, logInsert, siblingsQuery, escalationCount };
}



const payloadOf = (updateQuery) => updateQuery.update.mock.calls[0][0];

describe('moveIntentColumns (the one helper every mover uses)', () => {
  const { moveIntentColumns, moveIntentFor } = timePromise;
  const conn = { raw: (sql) => ({ sql }) };

  test('gate off: nothing, whatever the options say', () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    expect(moveIntentColumns(conn, { customerAskedTime: true, sourceSurface: 'customer_web' })).toEqual({});
  });

  test('an explicit boolean wins; a customer surface records true; anything else records nothing', () => {
    expect(moveIntentColumns(conn, { customerAskedTime: false })).toEqual({ customer_asked_time: false, customer_asked_time_at: { sql: 'now()' } });
    expect(moveIntentColumns(conn, { customerAskedTime: true, sourceSurface: 'dispatch_board' }).customer_asked_time).toBe(true);
    for (const surface of ['customer_web', 'sms_reply', 'call_reschedule', 'call_makeup']) {
      expect(moveIntentColumns(conn, { sourceSurface: surface }).customer_asked_time).toBe(true);
    }
    expect(moveIntentColumns(conn, { customerAskedTime: false, sourceSurface: 'customer_web' }).customer_asked_time).toBe(false);
    expect(moveIntentColumns(conn, { sourceSurface: 'dispatch_board' })).toEqual({});
    expect(moveIntentColumns(conn, {})).toEqual({});
    expect(moveIntentColumns(conn, { customerAskedTime: 'true' })).toEqual({});
  });

  test('a move that did not change the slot records nothing; a series move records a customer surface only', () => {
    expect(moveIntentColumns(conn, { customerAskedTime: false }, { slotChanged: false })).toEqual({});
    expect(moveIntentColumns(conn, { customerAskedTime: false, sourceSurface: 'dispatch_board' }, { series: true })).toEqual({});
    expect(moveIntentColumns(conn, { customerAskedTime: false, sourceSurface: 'customer_web' }, { series: true }).customer_asked_time).toBe(true);
    expect(moveIntentFor({ customerAskedTime: false }, { series: true })).toBeUndefined();
  });
});

describe('single move (rebooker.reschedule): the intent rides the move\'s own UPDATE', () => {
  test('dispatch board class: the office box, per its value, with the database clock', async () => {
    const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'dispatch_board', customerAskedTime: false });
    expect(payloadOf(updateQuery)).toMatchObject({ scheduled_date: TARGET, customer_asked_time: false, customer_asked_time_at: NOW_RAW });
    const asked = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'dispatch_board', customerAskedTime: true });
    expect(payloadOf(asked.updateQuery)).toMatchObject({ customer_asked_time: true, customer_asked_time_at: NOW_RAW });
  });

  test('customer class: every customer surface records "asked for this time" with no option from its caller', async () => {
    for (const [surface, initiatedBy] of [['customer_web', 'customer_self_serve'], ['sms_reply', 'customer_sms'], ['call_reschedule', 'admin'], ['call_reschedule', 'ai_call_pipeline']]) {
      const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));
      await move({ sourceSurface: surface }, initiatedBy);
      expect(payloadOf(updateQuery)).toMatchObject({ customer_asked_time: true, customer_asked_time_at: NOW_RAW });
    }
  });

  test('a move that names no intent and is not a customer surface writes neither column', async () => {
    const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'quick_move' });
    expect(payloadOf(updateQuery)).not.toHaveProperty('customer_asked_time');
    expect(payloadOf(updateQuery)).not.toHaveProperty('customer_asked_time_at');
  });

  test('a technician-only change (same date and window) keeps the intent of the slot it holds', async () => {
    const { updateQuery } = wireRescheduleMocks({ ...liveService('confirmed'), scheduled_date: TARGET });
    await SmartRebooker.reschedule('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'admin_edit', 'admin',
      { allowLive: true, seriesPolicy: 'single', keepStatus: true, technicianId: 't2', sourceSurface: 'dispatch_board', customerAskedTime: false });
    expect(payloadOf(updateQuery)).not.toHaveProperty('customer_asked_time');
  });

  test('gate off: the UPDATE payload is exactly today\'s (no key, whatever the options say)', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const { updateQuery } = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'customer_web', customerAskedTime: true });
    const keys = Object.keys(payloadOf(updateQuery));
    expect(keys).not.toContain('customer_asked_time');
    expect(keys).not.toContain('customer_asked_time_at');
  });
});

describe('series move (rebooker.rescheduleSeries): a customer series move records its intent on every swept row, an office one does not', () => {
  const SIBS = () => [
    { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
    { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
  ];

  test('customer class: every swept row carries true + the database clock in its own UPDATE', async () => {
    const { updates } = wireSeriesMocks('confirmed', SIBS());
    const result = await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
      { allowLive: true, sourceSurface: 'customer_web' });
    expect(result.success).toBe(true);
    for (const u of updates) expect(u.update.mock.calls[0][0]).toMatchObject({ customer_asked_time: true, customer_asked_time_at: NOW_RAW });
  });

  test('office class: a dispatch-board series move writes no intent, even with the office box in the options (current behavior)', async () => {
    const { updates } = wireSeriesMocks('confirmed', SIBS());
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin',
      { allowLive: true, sourceSurface: 'dispatch_board', customerAskedTime: true });
    for (const u of updates) expect(u.update.mock.calls[0][0]).not.toHaveProperty('customer_asked_time');
  });

  test('gate off: no key on a customer series move', async () => {
    delete process.env.GATE_DAY_ONLY_PROMISE;
    const { updates } = wireSeriesMocks('confirmed', SIBS());
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve',
      { allowLive: true, sourceSurface: 'customer_web' });
    for (const u of updates) expect(u.update.mock.calls[0][0]).not.toHaveProperty('customer_asked_time_at');
  });
});

// ── A -> B -> C -> B with delayed effects ──
// An in-memory visit and its reschedule_log: each committed move applies its UPDATE payload and logs a row at its own commit time
// (the intent shares the move's now()). The OLD design wrote the office intent AFTER the commit, from the effects pass, bound only to
// the destination slot: if those effects stalled until the customer had moved the visit away and back to the same slot, the late
// write replaced the customer's true with false and a fresh time. Now no effect writes the column at all, so there is nothing to stall.
function visitModel() {
  let tick = 0;
  const row = { customer_asked_time: null, customer_asked_time_at: null };
  const log = [];
  return {
    row,
    log,
    // One committed move: its payload (the mover's own UPDATE) lands together with its log row.
    commit(payload) {
      tick += 1;
      log.push(tick);
      if ('customer_asked_time' in payload) Object.assign(row, { customer_asked_time: payload.customer_asked_time, customer_asked_time_at: tick });
    },
    // What eligibility reads: the newest slot-changing log row, compared with the intent's own time (loadNewestSlotRows after_intent).
    read() {
      const newest = log.length ? { after_intent: row.customer_asked_time_at == null ? null : Math.max(...log) > row.customer_asked_time_at } : null;
      return timePromise.currentIntent(row, newest);
    },
  };
}

describe('A -> B -> C -> B: an office move\'s intent cannot land over a later customer move', () => {
  test('dispatch class: office false, then the customer moves away and back: the customer\'s true stands', async () => {
    const visit = visitModel();
    const office = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'dispatch_board', customerAskedTime: false });           // A -> B
    visit.commit(payloadOf(office.updateQuery));
    expect(visit.read()).toBe(false);
    for (let i = 0; i < 2; i += 1) {                                                        // B -> C, C -> B
      const customer = wireRescheduleMocks(liveService('confirmed'));
      await move({ sourceSurface: 'customer_web' }, 'customer_self_serve');
      visit.commit(payloadOf(customer.updateQuery));
    }
    expect(visit.row.customer_asked_time).toBe(true);
    expect(visit.read()).toBe(true);
  });

  test('a customer move with NO intent of its own (a surface that records none) makes the office false read as stale, not as day only', async () => {
    const visit = visitModel();
    const office = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'dispatch_board', customerAskedTime: false });
    visit.commit(payloadOf(office.updateQuery));
    const other = wireRescheduleMocks(liveService('confirmed'));
    await move({ sourceSurface: 'quick_move' });
    visit.commit(payloadOf(other.updateQuery));
    expect(visit.read()).toBeNull();
  });

  test('series class: an office series move writes nothing; the customer series move\'s true holds', async () => {
    const visit = visitModel();
    const rows = () => [
      { id: 'svc-1', status: 'confirmed', scheduled_date: BASE, window_start: '09:00:00', window_end: '11:00:00' },
      { id: 'svc-2', status: 'confirmed', scheduled_date: SIB1, window_start: '09:00:00', window_end: '11:00:00' },
    ];
    const officeSeries = wireSeriesMocks('confirmed', rows());
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'weather_rain', 'admin', { allowLive: true, sourceSurface: 'dispatch_board', customerAskedTime: false });
    visit.commit(officeSeries.updates[0].update.mock.calls[0][0]);
    expect(visit.row.customer_asked_time).toBeNull();
    const customerSeries = wireSeriesMocks('confirmed', rows());
    await SmartRebooker.rescheduleSeries('svc-1', TARGET, { start: '09:00', end: '11:00' }, 'customer_request', 'customer_self_serve', { allowLive: true, sourceSurface: 'customer_web' });
    visit.commit(customerSeries.updates[0].update.mock.calls[0][0]);
    expect(visit.read()).toBe(true);
  });

  test('no effect or post-commit step writes customer_asked_time any more: only the in-transaction office writer calls recordCustomerAskedTime', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    for (const rel of ['../routes/admin-dispatch.js', '../services/appointment-reminders.js', '../services/intelligence-bar/schedule-tools.js',
      '../services/visit-groups.js', '../services/rebooker.js', '../routes/reschedule-public.js', '../services/sms-scheduling-act.js', '../services/call-reschedule-apply.js']) {
      expect(read(rel)).not.toMatch(/recordCustomerAskedTime\(/);
    }
    expect(read('../routes/admin-schedule.js')).toMatch(/recordCustomerAskedTime\(conn, ids/);
  });
});

describe('the customer movers name a surface that records the intent', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

  test('public rescheduler (single and series), text reply / offer, and both call-reschedule moves', () => {
    expect(timePromise.CUSTOMER_MOVE_SURFACES).toEqual(['customer_web', 'sms_reply', 'call_reschedule', 'call_makeup']);
    // The series call names its surface; the single call passes the explicit option (gate on only).
    expect(read('../routes/reschedule-public.js')).toContain("sourceSurface: 'customer_web'");
    expect(read('../routes/reschedule-public.js')).toContain('...dayPromiseMoveIntent(),');
    expect(read('../routes/reschedule-public.js')).toContain("? { customerAskedTime: true } : {}");
    expect(read('../services/sms-scheduling-act.js')).toContain("const SOURCE_SURFACE = 'sms_reply';");
    expect(read('../services/reschedule-sms.js')).toContain("sourceSurface: 'sms_reply'");
    expect(read('../services/call-reschedule-apply.js').match(/sourceSurface: 'call_reschedule'/g).length).toBeGreaterThanOrEqual(2);
  });
});

// An intent is stamped with its move's transaction now(); the move's own slot-changing reschedule_log row must carry the SAME time,
// i.e. be inserted in the SAME transaction as the UPDATE that carries the intent. A post-commit audit row is strictly later and would
// make the move's own intent read stale at once (currentIntent). This pins every mover that writes the columns.
describe('every mover that writes the intent audits its move in the same transaction', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  test('only the rebooker and the Intelligence Bar mover call moveIntentColumns (a new caller must be added here, with its log row)', () => {
    const callers = [...walk('services'), ...walk('routes')].filter((f) => f.endsWith('.js') && /\bmoveIntentColumns\(/.test(read(f)) && !f.endsWith('time-promise.js')).sort();
    expect(callers).toEqual(['services/intelligence-bar/schedule-tools.js', 'services/rebooker.js']);
  });

  test('rebooker (single, series anchor, carried partners; visit-groups members, customer web and call reschedule all run through it): every log row goes through the move transaction', () => {
    const src = read('services/rebooker.js');
    const inserts = src.match(/\w+\('reschedule_log'\)\.insert\(/g);
    expect(inserts).toHaveLength(3);                       // single, series anchor, series partners
    for (const call of inserts) expect(call).toMatch(/^trx\(/);
    expect(src).not.toMatch(/\bdb\('reschedule_log'\)\.insert/);
  });

  test('Intelligence Bar: with the gate on the row is inserted in the batch transaction (savepoint), and the post-commit append skips an audited stop', () => {
    const src = read('services/intelligence-bar/schedule-tools.js');
    expect(src).toContain('if (auditInTrx) await auditMovedStopInTrx(trx, c, dateStr, reason);');
    expect(src).toContain('await trx.transaction((sp) => insertMoveAudit(sp, c, dateStr, reason));');
    expect(src).toContain('if (c.auditedInTrx) continue;');
    // The only other insert of the row is the post-commit one (gate off), through the db connection.
    expect(src.match(/insertMoveAudit\(db, /g)).toHaveLength(1);
  });
});
