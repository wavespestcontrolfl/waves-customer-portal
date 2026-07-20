/**
 * Duplicate-series guard (fix: customers holding two active recurring
 * series of the same service).
 *
 * None of the three series creators — estimate-converter auto-schedule,
 * booking.js self-book quarterly seeding, admin POST /admin/schedule —
 * checked for an existing active series before minting a new one. The shared
 * helper findActiveRecurringSeries (recurring-appointment-seeder) matches on
 * service_id when both sides carry one, else the serviceKeyFor-normalized
 * service family (exact service_type equality is too narrow across creators).
 *
 * Unit tests drive the helper with a scripted fake connection; source
 * guards pin the three consumer call sites + the admin escape hatch.
 */
const fs = require('fs');
const path = require('path');

const { findActiveRecurringSeries, serviceKeyFor } = require('../services/recurring-appointment-seeder');
const { etDateString } = require('../utils/datetime-et');

const bookingSrc = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');
const converterSrc = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
const scheduleSrc = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

const COLS = { is_recurring: {}, recurring_parent_id: {}, recurring_ongoing: {}, service_id: {} };
const FUTURE = '2099-01-15';

// parents: rows returned for the parent query; upcomingByParent: map of
// parent id → upcoming row (or undefined).
function makeConn({ parents, upcomingByParent = {}, columns = COLS }) {
  const recorded = [];
  const conn = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if (name === 'where' && typeof args[0] === 'function') {
        const nested = [];
        const sub = {
          where(...a) { nested.push(['where', ...a]); return sub; },
          orWhere(...a) { nested.push(['orWhere', ...a]); return sub; },
        };
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNot', 'orderBy', 'select', 'limit']) {
      b[m] = record(m);
    }
    b.columnInfo = () => Promise.resolve(columns);
    b.first = (...args) => {
      calls.push(['first', ...args]);
      const scoped = calls.find(([n]) => n === 'whereFn');
      const parentId = scoped?.[1]?.find(([n, cond]) => n === 'where' && cond && cond.recurring_parent_id)?.[1]?.recurring_parent_id;
      return Promise.resolve(upcomingByParent[parentId]);
    };
    b.then = (res, rej) => {
      recorded.push({ table, calls });
      let rows = parents;
      const excluded = calls.find(([n]) => n === 'whereNot');
      if (excluded) rows = rows.filter((p) => p.id !== excluded[2]);
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  conn.recorded = recorded;
  return conn;
}

describe('findActiveRecurringSeries — service-family matching', () => {
  test('matches by service_id when both sides carry one (labels differ)', async () => {
    const conn = makeConn({
      parents: [{ id: 1, service_id: 'cat-9', service_type: 'Totally Renamed Program', recurring_ongoing: true, scheduled_date: '2026-01-01', status: 'completed' }],
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceId: 'cat-9', serviceType: 'Something Unrelated Entirely',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(1);
  });

  test('matches by normalized service family when service_ids differ', async () => {
    expect(serviceKeyFor({ service_type: 'Quarterly Pest Control' }))
      .toBe(serviceKeyFor({ service_type: 'General Pest Control Service' }));
    const conn = makeConn({
      parents: [{ id: 2, service_id: 'cat-1', service_type: 'Quarterly Pest Control', recurring_ongoing: true, scheduled_date: '2026-01-01', status: 'pending' }],
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceId: 'cat-2', serviceType: 'General Pest Control Service',
    });
    expect(matches).toHaveLength(1);
  });

  test('a DIFFERENT service family never matches', async () => {
    const conn = makeConn({
      parents: [{ id: 3, service_id: null, service_type: 'Mosquito Control', recurring_ongoing: true, scheduled_date: '2026-01-01', status: 'pending' }],
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceType: 'Quarterly Pest Control',
    });
    expect(matches).toHaveLength(0);
  });

  test('a lapsed series (not ongoing, no upcoming visits) never blocks a new one', async () => {
    const conn = makeConn({
      parents: [{ id: 4, service_id: null, service_type: 'Quarterly Pest Control', recurring_ongoing: false, scheduled_date: '2024-01-01', status: 'completed' }],
      upcomingByParent: {},
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceType: 'Quarterly Pest Control',
    });
    expect(matches).toHaveLength(0);
  });

  test('a non-ongoing series with a future visit IS active (carries next_upcoming_date)', async () => {
    const conn = makeConn({
      parents: [{ id: 6, service_id: null, service_type: 'Quarterly Pest Control', recurring_ongoing: false, scheduled_date: '2026-01-01', status: 'completed' }],
      upcomingByParent: { 6: { scheduled_date: FUTURE } },
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceType: 'Quarterly Pest Control',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].next_upcoming_date).toBe(FUTURE);
  });

  test('excludeParentId keeps a caller-just-created row from matching itself', async () => {
    const conn = makeConn({
      parents: [{ id: 7, service_id: null, service_type: 'Quarterly Pest Control', recurring_ongoing: true, scheduled_date: etDateString(), status: 'pending' }],
    });
    const matches = await findActiveRecurringSeries(conn, {
      customerId: 5, serviceType: 'Quarterly Pest Control', excludeParentId: 7,
    });
    expect(matches).toHaveLength(0);
  });

  test('returns [] without a customer or any service key, and pre-migration (no recurring_parent_id column)', async () => {
    await expect(findActiveRecurringSeries(makeConn({ parents: [] }), { serviceType: 'Pest' })).resolves.toEqual([]);
    await expect(findActiveRecurringSeries(makeConn({ parents: [] }), { customerId: 5 })).resolves.toEqual([]);
    await expect(findActiveRecurringSeries(
      makeConn({ parents: [], columns: { is_recurring: {} } }),
      { customerId: 5, serviceType: 'Pest' },
    )).resolves.toEqual([]);
  });
});

describe('the three series creators consume the guard (source guards)', () => {
  test('booking.js self-book: skip-with-note, booked visit kept, self-row excluded', () => {
    expect(bookingSrc).toContain('findActiveRecurringSeries(db, {');
    expect(bookingSrc).toContain('excludeParentId: serviceRow.id');
    expect(bookingSrc).toContain("action: 'recurring_series_skipped'");
    // Fail-open: guard errors must not change seeding.
    expect(bookingSrc).toContain('duplicate-series guard failed (seeding proceeds)');
  });

  test('estimate-converter auto-schedule: skips the whole duplicate unit with a note', () => {
    expect(converterSrc).toContain('findActiveRecurringSeries(database, {');
    expect(converterSrc).toContain("action: 'recurring_series_skipped'");
    const guardIdx = converterSrc.indexOf('findActiveRecurringSeries(database, {');
    expect(guardIdx).toBeGreaterThan(-1);
    // Guard runs BEFORE the scheduleUnits parent insert (whose row note is
    // 'Auto-scheduled from estimate #...') so no orphan first visit lands.
    const insertAfterGuard = converterSrc.indexOf('Auto-scheduled from estimate #', guardIdx);
    expect(insertAfterGuard).toBeGreaterThan(guardIdx);
    expect(converterSrc).toContain('duplicate-series guard failed (scheduling proceeds)');
  });

  test('admin POST /admin/schedule: 409 with the existing series listed + allowDuplicateSeries escape hatch', () => {
    expect(scheduleSrc).toContain("code: 'duplicate_recurring_series'");
    expect(scheduleSrc).toContain('req.body.allowDuplicateSeries === true');
    expect(scheduleSrc).toContain('allowDuplicateSeries override');
    expect(scheduleSrc).toContain('res.status(409).json({');
    expect(scheduleSrc).toContain('duplicate-series guard failed (booking proceeds)');
  });
});
