/**
 * package-followup-booking — visit 2 of a two-treatment package (cockroach /
 * flea / bed bug) booked with visit 1 (owner rulings 2026-10-04). Pins: the
 * gate is the only switch; only package catalog rows qualify (by service_id,
 * else key snapshot, else an exact name match for a row with neither); the
 * child shape (14 days exactly, no
 * weekend roll, confirmed, $0 included, both link columns, package source
 * marker, inherited tech/window/address); idempotency on a live child; the
 * savepoint posture (a failed child never fails the primary); the
 * eligibility refusals (holds, recurring, callbacks, chaining off visit 2,
 * terminal primaries).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/visit-groups', () => ({ maybeGroupRow: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn() }));
jest.mock('../services/technician-eligibility', () => ({ assertAssignableTechnician: jest.fn(async () => true) }));
jest.mock('../services/scheduling/occupancy', () => ({ findConflictingVisits: jest.fn(async () => []) }));
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn(async () => ({ id: 'alert-1' })) }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn(async () => {}) }));
jest.mock('../services/booking/create-scheduled-service', () => ({
  createScheduledService: jest.fn(async ({ insertData, source }) => ({ id: 'child-1', ...insertData, source_action: source.sourceAction })),
}));

const { assertAssignableTechnician } = require('../services/technician-eligibility');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { createScheduledService } = require('../services/booking/create-scheduled-service');
const { maybeGroupRow } = require('../services/visit-groups');
const logger = require('../services/logger');
const {
  ensurePackageFollowUpVisit, packageFollowUpDate, isPackageFollowUpServiceKey,
  PACKAGE_FOLLOWUP_SOURCE_ACTION, PACKAGE_FOLLOWUP_SERVICE_KEYS,
} = require('../services/package-followup-booking');

const ROACH = { id: 'svc-roach', service_key: 'cockroach_control', name: 'Cockroach Treatment Service', category: 'pest_control', follow_up_interval_days: 14, default_duration_minutes: 60 };
const FLEA = { id: 'svc-flea', service_key: 'flea_tick', name: 'Flea Elimination Package', category: 'specialty', follow_up_interval_days: null, default_duration_minutes: 90 };
const BEDBUG = { id: 'svc-bedbug', service_key: 'bed_bug_treatment', name: 'Bed Bug Treatment', category: 'specialty', follow_up_interval_days: 14, default_duration_minutes: 120 };
const PEST = { id: 'svc-pest', service_key: 'pest_general_quarterly', name: 'General Pest Control (Quarterly)', category: 'pest_control', follow_up_interval_days: null };
const COLS = Object.fromEntries(['followup_source_service_id', 'followup_included', 'parent_service_id', 'source_action', 'service_id', 'service_key_snapshot',
  'service_category_snapshot', 'payer_id', 'property_id', 'lat', 'lng', 'service_address_line1', 'service_address_city', 'zone', 'time_window', 'window_display',
  'estimated_duration_minutes', 'estimated_price', 'create_invoice_on_complete', 'booking_source'].map((c) => [c, {}]));

const PRIMARY = {
  id: 'visit-1', customer_id: 'cust-1', technician_id: 'tech-1', payer_id: 'payer-1', property_id: 'prop-1', lat: 27.4, lng: -82.5,
  service_address_line1: '1 Main St', service_address_city: 'Bradenton', zone: 'bradenton', time_window: 'morning',
  scheduled_date: '2026-10-05', window_start: '09:00:00', window_end: '10:00:00', window_display: '9:00 AM', estimated_duration_minutes: 75,
  service_type: 'Cockroach Treatment Service', service_id: 'svc-roach', status: 'pending', estimated_price: 239, booking_source: 'admin',
};

// Table-routed fake transaction: services (catalog lookups by id / key),
// scheduled_services (live-child lookup + columnInfo). trx.transaction runs
// the savepoint body on the same fake.
function fakeTrx({ catalog = [ROACH, FLEA, BEDBUG, PEST], existingChild = null, columnInfo = COLS } = {}) {
  const log = { lookups: [] };
  const trx = (table) => {
    let whereArg = null; let notIn = null; let keyIn = null; let nameEq = null;
    const chain = {
      where: (arg) => { whereArg = { ...(whereArg || {}), ...arg }; return chain; },
      whereIn: (col, vals) => { keyIn = vals; return chain; },
      whereRaw: (sql, bindings) => { if (/lower\(trim\(name\)\)/.test(sql)) [nameEq] = bindings; return chain; },
      whereNotIn: (col, vals) => { notIn = { col, vals }; return chain; },
      first: async () => {
        log.lookups.push({ table, where: whereArg, notIn });
        if (table === 'services') return catalog.find((r) => r.id === whereArg.id) || null;
        if (table === 'scheduled_services') return existingChild;
        return null;
      },
      select: async () => {
        log.lookups.push({ table, where: whereArg });
        if (table === 'services' && keyIn) return catalog.filter((r) => keyIn.includes(r.service_key) && r.name.trim().toLowerCase() === nameEq);
        if (table === 'services') return catalog.filter((r) => r.service_key === whereArg.service_key);
        return [];
      },
      columnInfo: async () => columnInfo,
    };
    return chain;
  };
  trx.isTransaction = true;
  trx.transaction = async (fn) => fn(trx);
  return { trx, log };
}

const prior = process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK;
beforeEach(() => {
  process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK = 'true';
  jest.clearAllMocks();
  createScheduledService.mockImplementation(async ({ insertData, source }) => ({ id: 'child-1', ...insertData, source_action: source.sourceAction }));
  assertAssignableTechnician.mockResolvedValue(true);
  findConflictingVisits.mockResolvedValue([]);
});
afterAll(() => {
  if (prior === undefined) delete process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK;
  else process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK = prior;
});

describe('scope + date math', () => {
  test('owner scope is cockroach, flea and bed bug — the two-treatment package set', () => {
    expect([...PACKAGE_FOLLOWUP_SERVICE_KEYS]).toEqual(['cockroach_control', 'flea_tick', 'bed_bug_treatment']);
    expect([...PACKAGE_FOLLOWUP_SERVICE_KEYS].sort()).toEqual([...require('../services/typed-followup-obligation').TWO_TREATMENT_PACKAGE_KEYS].sort());
    expect(isPackageFollowUpServiceKey('pest_general_quarterly')).toBe(false);
    expect(isPackageFollowUpServiceKey(undefined)).toBe(false);
  });

  test('visit 2 is exactly interval days later — no weekend roll (owner), ET calendar days across DST', () => {
    expect(packageFollowUpDate('2026-10-05', 14)).toBe('2026-10-19');
    // 2026-10-24 (Sat) + 14 = Sat 2026-11-07, left on the weekend as ruled.
    expect(packageFollowUpDate('2026-10-24', 14)).toBe('2026-11-07');
    // Across the Nov 1 2026 DST fall-back the day count still holds.
    expect(packageFollowUpDate('2026-10-25', 14)).toBe('2026-11-08');
    // Unset / non-positive interval → 14.
    expect(packageFollowUpDate('2026-10-05', null)).toBe('2026-10-19');
    expect(packageFollowUpDate('2026-10-05', 0)).toBe('2026-10-19');
    // pg `date` hydration (JS Date at local midnight) recovers the calendar day.
    expect(packageFollowUpDate(new Date(2026, 9, 5), 14)).toBe('2026-10-19');
    expect(packageFollowUpDate('not-a-date', 14)).toBeNull();
  });
});

describe('ensurePackageFollowUpVisit', () => {
  test('gate off: nothing is read, nothing is booked', async () => {
    delete process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK;
    const { trx, log } = fakeTrx();
    expect(await ensurePackageFollowUpVisit({ trx, primary: PRIMARY })).toBeNull();
    expect(log.lookups).toEqual([]);
    expect(createScheduledService).not.toHaveBeenCalled();
  });

  test('cockroach visit 1 books a confirmed, $0 included visit 2 two weeks out through the booking contract', async () => {
    const { trx } = fakeTrx();
    const child = await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS });
    expect(child).toMatchObject({ id: 'child-1' });
    expect(createScheduledService).toHaveBeenCalledTimes(1);
    const [{ trx: usedTrx, insertData, cols, source }] = createScheduledService.mock.calls[0];
    expect(usedTrx).toBe(trx);
    expect(cols).toBe(COLS);
    expect(source).toEqual({ sourceAction: PACKAGE_FOLLOWUP_SOURCE_ACTION });
    expect(PACKAGE_FOLLOWUP_SOURCE_ACTION.length).toBeLessThanOrEqual(30); // varchar(30)
    expect(insertData).toMatchObject({
      customer_id: 'cust-1',
      technician_id: 'tech-1',
      scheduled_date: '2026-10-19',
      window_start: '09:00',
      window_end: '10:00',
      window_display: '9:00 AM',
      service_type: 'Cockroach Treatment Service',
      service_id: 'svc-roach',
      service_key_snapshot: 'cockroach_control',
      service_category_snapshot: 'pest_control',
      status: 'confirmed',
      customer_confirmed: false,
      is_recurring: false,
      parent_service_id: 'visit-1',
      followup_source_service_id: 'visit-1',
      followup_included: true,
      estimated_price: 0,
      create_invoice_on_complete: false,
      payer_id: 'payer-1',
      property_id: 'prop-1',
      lat: 27.4,
      lng: -82.5,
      service_address_line1: '1 Main St',
      zone: 'bradenton',
      time_window: 'morning',
      estimated_duration_minutes: 75,
      booking_source: 'admin',
    });
    expect(insertData.confirmed_at).toBeInstanceOf(Date);
    expect(insertData.notes).toMatch(/Treatment 2 of 2/);
    expect(insertData.source_estimate_id).toBeUndefined(); // never correlates as an accept retry
    expect(assertAssignableTechnician).toHaveBeenCalledWith('tech-1', { conn: trx, date: '2026-10-19' });
    expect(maybeGroupRow).toHaveBeenCalledWith('child-1', { database: trx, createdBy: 'dispatch' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('flea by key snapshot (no service_id) uses the 14-day default and the catalog duration when the primary has none', async () => {
    const { trx } = fakeTrx();
    const primary = { ...PRIMARY, service_id: null, service_key_snapshot: 'flea_tick', service_type: 'Flea Elimination Package', estimated_duration_minutes: null };
    await ensurePackageFollowUpVisit({ trx, primary, cols: COLS });
    const [{ insertData }] = createScheduledService.mock.calls[0];
    expect(insertData).toMatchObject({ scheduled_date: '2026-10-19', service_id: 'svc-flea', service_key_snapshot: 'flea_tick', estimated_duration_minutes: 90 });
  });

  test('a non-package catalog row is a no-op — a stamped identity always beats the label', async () => {
    const { trx } = fakeTrx();
    expect(await ensurePackageFollowUpVisit({ trx, primary: { ...PRIMARY, service_id: 'svc-pest' }, cols: COLS })).toBeNull();
    expect(await ensurePackageFollowUpVisit({ trx, primary: { ...PRIMARY, service_id: null, service_key_snapshot: 'pest_general_quarterly' }, cols: COLS })).toBeNull();
    expect(createScheduledService).not.toHaveBeenCalled();
  });

  test('a row with no catalog identity (availability confirm path) resolves on an exact name match only', async () => {
    const { trx } = fakeTrx();
    const bare = { ...PRIMARY, service_id: null, service_key_snapshot: null };
    expect(await ensurePackageFollowUpVisit({ trx, primary: { ...bare, service_type: 'Roach problem in kitchen' }, cols: COLS })).toBeNull();
    expect(await ensurePackageFollowUpVisit({ trx, primary: { ...bare, service_type: 'General Pest Control' }, cols: COLS })).toBeNull();
    expect(createScheduledService).not.toHaveBeenCalled();
    await ensurePackageFollowUpVisit({ trx, primary: { ...bare, service_type: '  bed bug treatment ' }, cols: COLS });
    expect(createScheduledService.mock.calls[0][0].insertData).toMatchObject({ service_id: 'svc-bedbug', service_key_snapshot: 'bed_bug_treatment', scheduled_date: '2026-10-19' });
  });

  test('idempotent: a live child linked by followup_source_service_id is returned, not duplicated', async () => {
    const existing = { id: 'child-0', scheduled_date: '2026-10-19', status: 'confirmed', technician_id: 'tech-1' };
    const { trx, log } = fakeTrx({ existingChild: existing });
    expect(await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS })).toBe(existing);
    expect(createScheduledService).not.toHaveBeenCalled();
    const childLookup = log.lookups.find((l) => l.table === 'scheduled_services');
    expect(childLookup.where).toEqual({ followup_source_service_id: 'visit-1' });
    expect(childLookup.notIn).toEqual({ col: 'status', vals: ['cancelled', 'skipped', 'no_show'] });
  });

  test.each([
    ['slot hold (reservation_expires_at)', { reservation_expires_at: new Date() }],
    ['recurring parent', { is_recurring: true }],
    ['recurring child', { recurring_parent_id: 'series-1' }],
    ['re-service callback', { is_callback: true }],
    ['an included follow-up itself (visit 2 never chains a visit 3)', { followup_included: true }],
    ['a row already linked as a follow-up child', { followup_source_service_id: 'other' }],
    ['completed primary', { status: 'completed' }],
    ['cancelled primary', { status: 'cancelled' }],
    ['no customer', { customer_id: null }],
    ['no date', { scheduled_date: null }],
  ])('refuses: %s', async (_label, patch) => {
    const { trx, log } = fakeTrx();
    expect(await ensurePackageFollowUpVisit({ trx, primary: { ...PRIMARY, ...patch }, cols: COLS })).toBeNull();
    expect(log.lookups).toEqual([]);
    expect(createScheduledService).not.toHaveBeenCalled();
  });

  test('office confirm promotes a pending call-booked visit 2 to a confirmed package child; other callers leave it', async () => {
    const { transitionJobStatus } = require('../services/job-status');
    const pendingCallChild = { id: 'child-call', scheduled_date: '2026-10-19', status: 'pending', technician_id: 'tech-1', source_action: 'ai_call_pipeline_followup', customer_confirmed: false };
    const left = fakeTrx({ existingChild: pendingCallChild });
    expect(await ensurePackageFollowUpVisit({ trx: left.trx, primary: PRIMARY, cols: COLS })).toBe(pendingCallChild);
    expect(transitionJobStatus).not.toHaveBeenCalled();

    const promoted = fakeTrx({ existingChild: pendingCallChild });
    const updates = [];
    const base = promoted.trx;
    const trx = (table) => ({ ...base(table), where: (arg) => ({ ...base(table).where(arg), update: async (patch) => { updates.push({ arg, patch }); return 1; } }) });
    trx.transaction = async (fn) => fn(trx);
    const out = await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS, promotePendingCallFollowUp: true });
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'child-call', fromStatus: 'pending', toStatus: 'confirmed', trx }));
    expect(updates).toEqual([{ arg: { id: 'child-call' }, patch: expect.objectContaining({ source_action: PACKAGE_FOLLOWUP_SOURCE_ACTION }) }]);
    expect(out).toMatchObject({ id: 'child-call', status: 'confirmed', source_action: PACKAGE_FOLLOWUP_SOURCE_ACTION });
    expect(createScheduledService).not.toHaveBeenCalled();
  });

  test('an inherited technician no longer assignable lands visit 2 unassigned', async () => {
    assertAssignableTechnician.mockRejectedValueOnce(Object.assign(new Error('offboarded'), { code: 'TECH_NOT_ASSIGNABLE' }));
    const { trx } = fakeTrx();
    await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS });
    expect(createScheduledService.mock.calls[0][0].insertData.technician_id).toBeNull();
  });

  test('a slot clash still books and rings a Schedule needs-you card for the office', async () => {
    findConflictingVisits.mockResolvedValueOnce([{ id: 'other-stop' }]);
    const { trx } = fakeTrx();
    const child = await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS });
    expect(child.id).toBe('child-1');
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-10-19', windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-1', excludeServiceIds: ['child-1'],
    }));
    expect(raiseAdminAlert).toHaveBeenCalledWith('schedule_conflict', expect.objectContaining({
      area: 'Schedule', severity: 'needs-you', who: 'person', subject: { type: 'visit', id: 'child-1' }, doneWhen: 'followup_respaced',
      link: '/admin/dispatch?tab=schedule&date=2026-10-19&appointment=child-1',
    }), expect.objectContaining({ dedupeKey: 'package_followup_overlap:child-1' }));
  });

  test('the overlap card waits for the outermost commit and is dropped on rollback (codex #5896 r1 P2)', async () => {
    findConflictingVisits.mockResolvedValue([{ id: 'other-stop' }]);
    let commit; let rollback;
    const committed = fakeTrx();
    committed.trx.executionPromise = new Promise((resolve) => { commit = resolve; });
    await ensurePackageFollowUpVisit({ trx: committed.trx, primary: PRIMARY, cols: COLS });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    commit();
    await new Promise((r) => setImmediate(r));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);

    raiseAdminAlert.mockClear();
    const rolledBack = fakeTrx();
    rolledBack.trx.executionPromise = new Promise((_resolve, reject) => { rollback = reject; });
    await ensurePackageFollowUpVisit({ trx: rolledBack.trx, primary: PRIMARY, cols: COLS });
    rollback(new Error('outer rollback'));
    await new Promise((r) => setImmediate(r));
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a failed overlap probe rolls back only its own savepoint: the child still books (codex #5896 r1 P1)', async () => {
    findConflictingVisits.mockRejectedValueOnce(new Error('probe statement failed'));
    const { trx } = fakeTrx();
    let savepoints = 0;
    const inner = trx.transaction;
    trx.transaction = async (fn) => { savepoints += 1; return inner(fn); };
    const child = await ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS });
    expect(child.id).toBe('child-1');
    // One savepoint for the child, a second one confining the probe.
    expect(savepoints).toBe(2);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a failed child write never fails the primary: logged, null, savepoint rolled back', async () => {
    createScheduledService.mockRejectedValueOnce(new Error('boom'));
    const { trx } = fakeTrx();
    await expect(ensurePackageFollowUpVisit({ trx, primary: PRIMARY, cols: COLS })).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('primary booking kept'));
  });

  test('losing the one-live-child race (23505) returns the winner', async () => {
    const winner = { id: 'child-w', status: 'confirmed' };
    createScheduledService.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const { trx } = fakeTrx();
    let calls = 0;
    const outer = Object.assign((table) => {
      const chain = { where: () => chain, whereNotIn: () => chain, first: async () => { calls += 1; return table === 'scheduled_services' ? winner : null; } };
      return chain;
    }, { isTransaction: true, transaction: async (fn) => fn(trx) });
    expect(await ensurePackageFollowUpVisit({ trx: outer, primary: PRIMARY, cols: COLS })).toBe(winner);
    expect(calls).toBe(1);
  });

  test('missing link columns (pre-migration schema) → skip with a warning, never a bare insert', async () => {
    const { trx } = fakeTrx({ columnInfo: { source_action: {} } });
    expect(await ensurePackageFollowUpVisit({ trx, primary: PRIMARY })).toBeNull();
    expect(createScheduledService).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('link columns'));
  });
});
