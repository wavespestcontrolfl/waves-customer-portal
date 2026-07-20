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
 * Round 2 (codex P0s): the guard is now RACE-SAFE and covers EVERY converter
 * seeding path. checkActiveSeriesLocked serializes creators per
 * customer + service family on a pg advisory xact lock and re-runs the guard
 * inside the same transaction that inserts the parent/follow-ups — so two
 * concurrent creators can no longer both see "no series" and both seed. The
 * converter's reserved-slot accept (the common public path) and the
 * standalone-bait block are guarded too, not just the auto-schedule branch.
 *
 * Unit tests drive the helpers with a scripted fake connection; source
 * guards pin the consumer call sites + the admin escape hatch.
 */
const fs = require('fs');
const path = require('path');

const { checkActiveSeriesLocked, findActiveRecurringSeries, serviceKeyFor } = require('../services/recurring-appointment-seeder');
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

// Fake knex-ish environment for the locked-guard tests: callable AS a
// transaction (`.transaction(cb)` invokes cb with a trx-shaped conn; a nested
// call from inside one is a SAVEPOINT and runs inline), records the advisory
// lock raw calls, serializes TOP-LEVEL transactions on a shared mutex (= the
// per-customer/family advisory lock), and backs findActiveRecurringSeries
// with a mutable shared parents array — so a "committed" insert from the
// first creator is visible to the second creator's in-lock re-check, exactly
// like the real lock + READ COMMITTED interplay.
function makeLockEnv({ parents = [], upcomingByParent = {}, columns = COLS, rawError = null } = {}) {
  const rawCalls = [];
  const state = { parents: [...parents] };
  const mutex = { tail: Promise.resolve() };
  const buildTable = () => {
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
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereNull', 'whereNot', 'orderBy', 'select', 'limit']) {
      b[m] = record(m);
    }
    b.columnInfo = () => Promise.resolve(columns);
    b.first = (...args) => {
      calls.push(['first', ...args]);
      const scoped = calls.find(([n]) => n === 'whereFn');
      const parentId = scoped?.[1]?.find(([n, cond]) => n === 'where' && cond && cond.recurring_parent_id)?.[1]?.recurring_parent_id;
      return Promise.resolve(upcomingByParent[parentId]);
    };
    b.insert = (data) => {
      const row = { id: 900 + state.parents.length, ...data };
      state.parents.push(row);
      return {
        returning: () => Promise.resolve([row]),
        then: (res, rej) => Promise.resolve([row.id]).then(res, rej),
      };
    };
    b.then = (res, rej) => Promise.resolve(state.parents).then(res, rej);
    return b;
  };
  const build = (isTransaction) => {
    const fn = () => buildTable();
    fn.isTransaction = isTransaction;
    fn.raw = (sql, bindings) => {
      rawCalls.push([sql, bindings]);
      return rawError ? Promise.reject(rawError) : Promise.resolve();
    };
    fn.transaction = (cb) => {
      const exec = () => Promise.resolve().then(() => cb(build(true)));
      if (isTransaction) return exec(); // savepoint — runs under the held lock
      const prev = mutex.tail;
      let release;
      mutex.tail = new Promise((r) => { release = r; });
      return prev.then(exec).finally(() => release());
    };
    return fn;
  };
  return { db: build(false), rawCalls, state };
}

describe('checkActiveSeriesLocked — race-safe guard (P0: check-then-insert race)', () => {
  test('takes the per-customer/family advisory lock, then re-runs the guard under it', async () => {
    const { db, rawCalls } = makeLockEnv({
      parents: [{ id: 1, service_id: null, service_type: 'Quarterly Pest Control', recurring_ongoing: true, scheduled_date: '2026-01-01', status: 'pending' }],
    });
    const result = await db.transaction((trx) => checkActiveSeriesLocked(trx, {
      customerId: 5, serviceType: 'General Pest Control Service',
    }));
    expect(result.guardError).toBeNull();
    expect(result.matches).toHaveLength(1);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0][0]).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
    // Key = customerId + the NORMALIZED family key, so differently-labeled
    // creators of the same program contend on the same lock.
    expect(rawCalls[0][1]).toEqual([
      'recurring-series-create',
      `5:${serviceKeyFor({ service_type: 'Quarterly Pest Control' })}`,
    ]);
  });

  test('fail-open: a lock/query failure returns guardError and NEVER throws', async () => {
    const boom = new Error('lock timeout');
    const { db } = makeLockEnv({ rawError: boom });
    const result = await db.transaction((trx) => checkActiveSeriesLocked(trx, {
      customerId: 5, serviceType: 'Quarterly Pest Control',
    }));
    expect(result.matches).toEqual([]);
    expect(result.guardError).toBe(boom);
  });

  test('two concurrent creators mint exactly ONE series (loser re-reads under the lock and skips)', async () => {
    const { db, state, rawCalls } = makeLockEnv({ parents: [] });
    // Each creator mirrors the production shape: one transaction that runs
    // the locked guard re-check and only inserts the parent when it comes
    // back empty. The shared mutex plays the advisory lock: the second
    // creator's guard cannot run until the first's transaction finishes.
    const createSeries = () => db.transaction(async (trx) => {
      const { matches, guardError } = await checkActiveSeriesLocked(trx, {
        customerId: 5, serviceType: 'Quarterly Pest Control',
      });
      expect(guardError).toBeNull();
      if (matches.length > 0) return { kept: matches[0] };
      await trx('scheduled_services').insert({
        customer_id: 5, service_type: 'Quarterly Pest Control',
        is_recurring: true, recurring_ongoing: true,
        scheduled_date: FUTURE, status: 'pending', service_id: null,
      });
      return { seeded: true };
    });
    const [a, b] = await Promise.all([createSeries(), createSeries()]);
    expect(state.parents).toHaveLength(1);
    // One seeded, one kept — order-independent.
    expect([a.seeded, b.seeded].filter(Boolean)).toHaveLength(1);
    expect([a.kept, b.kept].filter(Boolean)).toHaveLength(1);
    expect(rawCalls).toHaveLength(2);
  });
});

describe('the series creators consume the guard (source guards)', () => {
  test('booking.js self-book: locked guard + seeding share one transaction; skip-with-note, booked visit kept, self-row excluded', () => {
    expect(bookingSrc).toContain('checkActiveSeriesLocked(trx, {');
    expect(bookingSrc).toContain('excludeParentId: serviceRow.id');
    expect(bookingSrc).toContain("action: 'recurring_series_skipped'");
    // Seeding rides the SAME transaction as the locked re-check — that is
    // what closes the check-then-insert race.
    expect(bookingSrc).toContain('seedFollowUpsForParent(trx, serviceRow, {');
    // Fail-open: guard errors must not change seeding.
    expect(bookingSrc).toContain('duplicate-series guard failed (seeding proceeds)');
  });

  test('estimate-converter: ALL THREE seeding paths (auto-schedule, reserved-slot, standalone bait) run the locked guard', () => {
    expect((converterSrc.match(/checkActiveSeriesLocked\(trx, \{/g) || []).length).toBe(3);
    // Reserved-slot accept (the common public path, codex P0-1): the freshly
    // reserved row must never match itself — only OTHER active series block
    // the follow-up seeding.
    expect(converterSrc).toContain('excludeParentId: reservedStart.id');
    expect(converterSrc).toContain('seedRecurringFollowUpsForParent(trx, reservedStart, seedSvc, {');
    // Standalone-bait creator: guard runs before its parent insert inside
    // the same transaction — a duplicate skips the WHOLE unit, no orphan
    // first visit.
    const baitGuard = converterSrc.indexOf('serviceType: standaloneRow.service_type');
    const baitInsert = converterSrc.indexOf("trx('scheduled_services').insert(standaloneRow)");
    expect(baitGuard).toBeGreaterThan(-1);
    expect(baitInsert).toBeGreaterThan(baitGuard);
    // Auto-schedule branch: guard inside the transaction, before the parent
    // insert, so no orphan first visit lands there either.
    const autoGuard = converterSrc.lastIndexOf('checkActiveSeriesLocked(trx, {');
    const autoInsert = converterSrc.indexOf("trx('scheduled_services').insert(row)", autoGuard);
    expect(autoInsert).toBeGreaterThan(autoGuard);
    // Skip-with-note on every guarded path; fail-open log retained.
    expect((converterSrc.match(/action: 'recurring_series_skipped'/g) || []).length).toBe(3);
    expect(converterSrc).toContain('duplicate-series guard failed (scheduling proceeds)');
    // A caller-provided transaction is reused (the lock then holds to THEIR
    // commit); otherwise each seeding step opens its own.
    expect(converterSrc).toContain('const seedsInOwnTransaction = !database.isTransaction;');
  });

  test('admin POST /admin/schedule: preflight 409 + in-transaction locked backstop + allowDuplicateSeries escape hatch', () => {
    // Route-entry preflight (fast, unlocked) still rejects the common case.
    expect(scheduleSrc).toContain('findActiveRecurringSeries(db, {');
    expect(scheduleSrc).toContain("code: 'duplicate_recurring_series'");
    expect(scheduleSrc).toContain('req.body.allowDuplicateSeries === true');
    expect(scheduleSrc).toContain('allowDuplicateSeries override');
    expect(scheduleSrc).toContain('duplicate-series guard failed (booking proceeds)');
    // Race-safe backstop: locked re-check INSIDE the series-creating
    // transaction, before the parent insert; the escape hatch bypasses it
    // exactly as it bypasses the preflight.
    const backstop = scheduleSrc.indexOf('checkActiveSeriesLocked(trx, {');
    const parentInsert = scheduleSrc.indexOf("[svc] = await trx('scheduled_services').insert(insertData)");
    expect(backstop).toBeGreaterThan(-1);
    expect(parentInsert).toBeGreaterThan(backstop);
    expect(scheduleSrc).toContain('req.body.allowDuplicateSeries !== true');
    expect(scheduleSrc).toContain('dupErr.duplicateRecurringSeries = matches;');
    // Both rejection paths present the SAME 409 payload.
    expect((scheduleSrc.match(/res\.status\(409\)\.json\(duplicateSeriesConflictBody\(/g) || []).length).toBe(2);
  });
});
