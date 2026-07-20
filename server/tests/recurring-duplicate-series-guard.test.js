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
 * Round 3 (codex P0): the lock keys now cover BOTH dimensions of the
 * OR-matcher. A family-only key let two creators with the SAME service_id but
 * differently-normalized labels take different locks and both seed;
 * checkActiveSeriesLocked now acquires one lock per dimension it carries
 * ('<cust>:family:<bucket>' + '<cust>:svc:<serviceId>'), sorted before
 * acquisition so overlapping creators can never swap-deadlock.
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
// lock raw calls, and backs findActiveRecurringSeries with a mutable shared
// parents array — so a "committed" insert from the first creator is visible
// to the second creator's in-lock re-check, exactly like the real lock +
// READ COMMITTED interplay.
//
// Round 3: locks are modelled PER KEY, not as one global mutex. A single
// mutex serialized every creator regardless of key, so it could not tell a
// real fix from the bug — two creators taking DIFFERENT locks would still
// have appeared serialized. Here each distinct lock key has its own FIFO wait
// queue, and (like pg_advisory_xact_lock) a key is re-entrant within a
// transaction and every key a transaction took is released only when that
// TOP-LEVEL transaction ends — savepoints inherit the same holder context.
// Two creators overlap only if they actually request a common key.
function makeLockEnv({ parents = [], upcomingByParent = {}, columns = COLS, rawError = null } = {}) {
  const rawCalls = [];
  const state = { parents: [...parents] };
  const locks = new Map(); // lock key → tail of that key's wait queue
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
  const build = (isTransaction, holder) => {
    const fn = () => buildTable();
    fn.isTransaction = isTransaction;
    fn.raw = (sql, bindings) => {
      rawCalls.push([sql, bindings]);
      if (rawError) return Promise.reject(rawError);
      if (!holder || !/pg_advisory_xact_lock/.test(sql)) return Promise.resolve();
      const key = String(bindings.join('|'));
      if (holder.held.has(key)) return Promise.resolve(); // re-entrant, as pg is
      holder.held.add(key);
      // Queue behind whoever holds this key; publish our own release as the
      // new tail so the next waiter blocks until this transaction ends.
      const prev = locks.get(key) || Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      locks.set(key, prev.then(() => mine));
      holder.releases.push(release);
      return prev;
    };
    fn.transaction = (cb) => {
      // Savepoint: same holder context, so locks taken inside it survive the
      // savepoint release and hold to the top-level commit.
      if (isTransaction) return Promise.resolve().then(() => cb(build(true, holder)));
      const ctx = { held: new Set(), releases: [] };
      return Promise.resolve()
        .then(() => cb(build(true, ctx)))
        .finally(() => { for (const r of ctx.releases) r(); });
    };
    return fn;
  };
  return { db: build(false, null), rawCalls, state };
}

// Lock keys recorded by makeLockEnv, in acquisition order.
const lockKeysFrom = (rawCalls) => rawCalls
  .filter(([sql]) => /pg_advisory_xact_lock/.test(sql))
  .map(([, bindings]) => bindings[1]);

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
    // creators of the same program contend on the same lock. No serviceId was
    // supplied, so the svc dimension contributes no key.
    expect(rawCalls[0][1]).toEqual([
      'recurring-series-create',
      `5:family:${serviceKeyFor({ service_type: 'Quarterly Pest Control' })}`,
    ]);
  });

  test('locks BOTH matcher dimensions when the caller carries service_id AND a label', async () => {
    const { db, rawCalls } = makeLockEnv({ parents: [] });
    await db.transaction((trx) => checkActiveSeriesLocked(trx, {
      customerId: 5, serviceId: 'cat-7', serviceType: 'Quarterly Pest Control',
    }));
    // The guard matches on service_id equality OR family equality, so a
    // single key can never cover every path that matches — one lock per
    // dimension does.
    expect(lockKeysFrom(rawCalls)).toEqual([
      `5:family:${serviceKeyFor({ service_type: 'Quarterly Pest Control' })}`,
      '5:svc:cat-7',
    ].sort());
  });

  test('lock keys are acquired in sorted order regardless of the caller (no swap deadlock)', async () => {
    // Two creators sharing both dimensions must request them in IDENTICAL
    // order — otherwise each could hold one and wait on the other's forever.
    const keysFor = async (opts) => {
      const { db, rawCalls } = makeLockEnv({ parents: [] });
      await db.transaction((trx) => checkActiveSeriesLocked(trx, opts));
      return lockKeysFrom(rawCalls);
    };
    // Same two dimensions reached from different labels/ids: every caller
    // emits the same sorted sequence, so acquisition order is a property of
    // the key set, never of the call site.
    const a = await keysFor({ customerId: 5, serviceId: 'cat-7', serviceType: 'Quarterly Pest Control' });
    const b = await keysFor({ customerId: 5, serviceId: 'aaa-1', serviceType: 'General Pest Control Service' });
    expect(a).toEqual([...a].sort());
    expect(b).toEqual([...b].sort());
    // 'Quarterly Pest Control' and 'General Pest Control Service' normalize to
    // one family, so both callers put the SAME family key first.
    expect(a[0]).toBe(b[0]);
  });

  test('scopes the lock to the customer — a different customer never contends', async () => {
    const { db, rawCalls } = makeLockEnv({ parents: [] });
    await db.transaction((trx) => checkActiveSeriesLocked(trx, { customerId: 5, serviceId: 'cat-7' }));
    await db.transaction((trx) => checkActiveSeriesLocked(trx, { customerId: 6, serviceId: 'cat-7' }));
    expect(lockKeysFrom(rawCalls)).toEqual(['5:svc:cat-7', '6:svc:cat-7']);
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

  // Runs two creators concurrently against the keyed-lock env and reports how
  // many series ended up seeded. Each mirrors production: locked re-check in
  // the same transaction as the insert, seed only when the guard is empty.
  async function raceTwoCreators(optsA, optsB) {
    const { db, state, rawCalls } = makeLockEnv({ parents: [] });
    const createSeries = (opts) => db.transaction(async (trx) => {
      const { matches, guardError } = await checkActiveSeriesLocked(trx, opts);
      expect(guardError).toBeNull();
      if (matches.length > 0) return { kept: matches[0] };
      await trx('scheduled_services').insert({
        customer_id: opts.customerId, service_type: opts.serviceType,
        service_id: opts.serviceId ?? null,
        is_recurring: true, recurring_ongoing: true,
        scheduled_date: FUTURE, status: 'pending',
      });
      return { seeded: true };
    });
    const [a, b] = await Promise.all([createSeries(optsA), createSeries(optsB)]);
    return { seeded: [a.seeded, b.seeded].filter(Boolean).length, state, rawCalls };
  }

  test('P0: SAME service_id but differently-normalized labels still mint exactly ONE series', async () => {
    // The bug: keyed only on the family, these two took DIFFERENT locks, so
    // neither blocked, both re-checks came back empty, and the customer got
    // two billable series for one catalog service. The svc-dimension lock is
    // the only thing they share.
    expect(serviceKeyFor({ service_type: 'Quarterly Pest Control' }))
      .not.toBe(serviceKeyFor({ service_type: 'Mosquito Control' }));
    const { seeded, state, rawCalls } = await raceTwoCreators(
      { customerId: 5, serviceId: 'cat-7', serviceType: 'Quarterly Pest Control' },
      { customerId: 5, serviceId: 'cat-7', serviceType: 'Mosquito Control' },
    );
    expect(seeded).toBe(1);
    expect(state.parents).toHaveLength(1);
    // Both creators requested the shared svc key — that is what serialized
    // them despite the family keys diverging.
    expect(lockKeysFrom(rawCalls).filter((k) => k === '5:svc:cat-7')).toHaveLength(2);
  });

  test('different service_ids in ONE family still mint exactly one series (family dimension holds)', async () => {
    const { seeded, state } = await raceTwoCreators(
      { customerId: 5, serviceId: 'cat-1', serviceType: 'Quarterly Pest Control' },
      { customerId: 5, serviceId: 'cat-2', serviceType: 'General Pest Control Service' },
    );
    expect(seeded).toBe(1);
    expect(state.parents).toHaveLength(1);
  });

  test('genuinely unrelated programs share no lock and both seed', async () => {
    // The locks must not over-serialize: nothing about mosquito and pest
    // control should make one creator wait on — or be skipped by — the other.
    const { seeded, state } = await raceTwoCreators(
      { customerId: 5, serviceId: 'cat-1', serviceType: 'Quarterly Pest Control' },
      { customerId: 5, serviceId: 'cat-9', serviceType: 'Mosquito Control' },
    );
    expect(seeded).toBe(2);
    expect(state.parents).toHaveLength(2);
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
    // The POST preflight, the POST backstop, AND the update-details spawn
    // backstop each present the SAME 409 payload.
    expect((scheduleSrc.match(/res\.status\(409\)\.json\(duplicateSeriesConflictBody\(/g) || []).length).toBe(3);
  });

  test('admin PUT /:id/update-details spawn: locked backstop inside the spawn trx, before the child insert, with the same escape hatch + 409', () => {
    // The fourth series creator. The spawn branch preloads existing CHILDREN
    // of THIS parent for date-dedup, but that only dedupes rows already
    // attached to this parent — it never checks for a DIFFERENT active
    // same-family series, nor serializes against concurrent creators. The
    // shared locked guard closes that gap.
    const spawnGuard = scheduleSrc.indexOf('[schedule/update-details] locked duplicate-series guard failed');
    expect(spawnGuard).toBeGreaterThan(-1);
    // The guard runs on `trx` — the SAME transaction that spawns the children,
    // so the advisory lock covers the child inserts to commit.
    const spawnGuardCall = scheduleSrc.lastIndexOf('checkActiveSeriesLocked(trx, {', spawnGuard);
    expect(spawnGuardCall).toBeGreaterThan(-1);
    // Keys off the SAME service_type/service_id the matcher (and the spawned
    // children) use, and excludes the row being made recurring from matching
    // itself.
    const spawnGuardBlock = scheduleSrc.slice(spawnGuardCall, spawnGuard);
    expect(spawnGuardBlock).toContain('serviceType: parent.service_type');
    expect(spawnGuardBlock).toContain('serviceId: parent.service_id || null');
    expect(spawnGuardBlock).toContain('excludeParentId: parent.id');
    // Guard runs BEFORE the first child insert of the spawn branch.
    const firstChildInsert = scheduleSrc.indexOf("trx('scheduled_services').insert(childData)", spawnGuard);
    expect(firstChildInsert).toBeGreaterThan(spawnGuard);
    // Escape hatch bypasses it exactly as on the POST path (logged override).
    expect(scheduleSrc).toContain('[schedule/update-details] allowDuplicateSeries override');
    // A hit throws the same tagged error the update-details catch maps to 409.
    expect(scheduleSrc).toContain("if (Array.isArray(err.duplicateRecurringSeries)) {");
  });
});
