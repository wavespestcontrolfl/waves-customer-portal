/**
 * scheduling/expected-service-minutes.js — the ONE lookup that turns a
 * service identity into "how long the tech is actually expected to be on
 * site" for the travel-gap padding formula (owner ruling 2026-09-23):
 * midpoint of min/max duration when both are set, else the catalog default,
 * else the window length itself (no signal -> zero padding, legacy gap).
 * Always clamped to <= the window length.
 */
const {
  expectedServiceMinutes, expectedMinutesSync, ensureCatalogLoaded, clearExpectedServiceMinutesCache,
} = require('../services/scheduling/expected-service-minutes');

function fakeConn(rows) {
  const fn = (table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    return { select: async () => rows };
  };
  return fn;
}

beforeEach(() => clearExpectedServiceMinutesCache());

describe('expectedMinutesSync — no catalog loaded', () => {
  test('falls back to the window length (zero padding, legacy gap)', () => {
    expect(expectedMinutesSync({ serviceKey: 'quarterly_pest', windowMinutes: 60 })).toBe(60);
    expect(expectedMinutesSync({ windowMinutes: 45 })).toBe(45);
  });

  test('a non-finite/absent windowMinutes defaults to 60', () => {
    expect(expectedMinutesSync({})).toBe(60);
    expect(expectedMinutesSync({ windowMinutes: 0 })).toBe(60);
    expect(expectedMinutesSync({ windowMinutes: -5 })).toBe(60);
  });
});

describe('expectedServiceMinutes — catalog midpoint / default / clamp', () => {
  test('midpoint of min/max when both are set (quarterly pest 30-60 -> 45)', async () => {
    const conn = fakeConn([
      { service_key: 'quarterly_pest', name: 'Pest Control (Quarterly)', min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null },
    ]);
    const minutes = await expectedServiceMinutes(conn, { serviceKey: 'quarterly_pest', windowMinutes: 60 });
    expect(minutes).toBe(45);
  });

  test('falls back to default_duration_minutes when min/max are not both set', async () => {
    const conn = fakeConn([
      { service_key: 'lawn_basic', name: 'Lawn Care', min_duration_minutes: null, max_duration_minutes: null, default_duration_minutes: 40 },
    ]);
    expect(await expectedServiceMinutes(conn, { serviceKey: 'lawn_basic', windowMinutes: 60 })).toBe(40);
    clearExpectedServiceMinutesCache();
    // Only one of min/max set is treated as "not both set".
    const conn2 = fakeConn([
      { service_key: 'half_set', name: 'Half Set', min_duration_minutes: 30, max_duration_minutes: null, default_duration_minutes: 50 },
    ]);
    expect(await expectedServiceMinutes(conn2, { serviceKey: 'half_set', windowMinutes: 60 })).toBe(50);
  });

  test('falls back to the window length when neither midpoint nor default resolve', async () => {
    const conn = fakeConn([
      { service_key: 'bare', name: 'Bare Service', min_duration_minutes: null, max_duration_minutes: null, default_duration_minutes: null },
    ]);
    expect(await expectedServiceMinutes(conn, { serviceKey: 'bare', windowMinutes: 60 })).toBe(60);
  });

  test('a catalog default longer than the window clamps to the window length (never negative padding)', async () => {
    const conn = fakeConn([
      { service_key: 'long_default', name: 'Long', min_duration_minutes: null, max_duration_minutes: null, default_duration_minutes: 120 },
    ]);
    expect(await expectedServiceMinutes(conn, { serviceKey: 'long_default', windowMinutes: 60 })).toBe(60);
    clearExpectedServiceMinutesCache();
    const conn2 = fakeConn([
      { service_key: 'wide_midpoint', name: 'Wide', min_duration_minutes: 90, max_duration_minutes: 150, default_duration_minutes: null },
    ]);
    // midpoint 120, window 60 -> clamped to 60
    expect(await expectedServiceMinutes(conn2, { serviceKey: 'wide_midpoint', windowMinutes: 60 })).toBe(60);
  });

  test('resolves by serviceKey first, then by services.name = serviceType', async () => {
    const conn = fakeConn([
      { service_key: 'quarterly_pest', name: 'Pest Control (Quarterly)', min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null },
    ]);
    // Exact serviceKey match.
    expect(await expectedServiceMinutes(conn, { serviceKey: 'quarterly_pest', windowMinutes: 60 })).toBe(45);
    clearExpectedServiceMinutesCache();
    // No serviceKey given (or no match) -> falls back to a case-insensitive
    // services.name = serviceType match.
    expect(await expectedServiceMinutes(conn, { serviceType: 'pest control (quarterly)', windowMinutes: 60 })).toBe(45);
    clearExpectedServiceMinutesCache();
    expect(await expectedServiceMinutes(conn, { serviceKey: 'no_such_key', serviceType: 'Pest Control (Quarterly)', windowMinutes: 60 })).toBe(45);
  });

  test('no match at all falls back to the window length', async () => {
    const conn = fakeConn([
      { service_key: 'quarterly_pest', name: 'Pest Control (Quarterly)', min_duration_minutes: 30, max_duration_minutes: 60, default_duration_minutes: null },
    ]);
    expect(await expectedServiceMinutes(conn, { serviceKey: 'unknown', serviceType: 'Unknown Service', windowMinutes: 60 })).toBe(60);
  });

  test('a failing catalog read fails open to the window length, never throws', async () => {
    const conn = () => { throw new Error('boom'); };
    await expect(expectedServiceMinutes(conn, { serviceKey: 'x', windowMinutes: 60 })).resolves.toBe(60);
  });

  test('no db handle at all -> sync fallback, no query attempted', async () => {
    expect(await expectedServiceMinutes(null, { serviceKey: 'x', windowMinutes: 60 })).toBe(60);
  });

  test('ensureCatalogLoaded caches — a second call within TTL does not re-query', async () => {
    let calls = 0;
    const conn = (table) => {
      calls += 1;
      return { select: async () => [{ service_key: 'k', name: 'K', min_duration_minutes: 20, max_duration_minutes: 40, default_duration_minutes: null }] };
    };
    await ensureCatalogLoaded(conn);
    await ensureCatalogLoaded(conn);
    expect(calls).toBe(1);
    expect(expectedMinutesSync({ serviceKey: 'k', windowMinutes: 60 })).toBe(30);
  });
});

describe('ensureCatalogLoaded inside a transaction (CI combined-visit capacity failure)', () => {
  // A failed read INSIDE a caller's transaction aborts that transaction —
  // "fails open" via try/catch is not open at all once every later
  // statement (the commit itself) errors with "current transaction is
  // aborted". Under a trx the read runs in a SAVEPOINT (knex nests a
  // transaction on a trx as one) so a failed preload rolls back to the
  // savepoint and the caller's transaction stays usable.
  test('a failing read under a trx runs inside a savepoint and still falls back to the window length', async () => {
    const calls = [];
    const trx = (table) => {
      calls.push(`select:${table}`);
      return { select: async () => { throw new Error('column "min_duration_minutes" does not exist'); } };
    };
    trx.isTransaction = true;
    trx.transaction = async (fn) => {
      calls.push('savepoint');
      const savepoint = (table) => trx(table);
      savepoint.isTransaction = true;
      return fn(savepoint);
    };
    expect(await expectedServiceMinutes(trx, { serviceKey: 'quarterly_pest', windowMinutes: 60 })).toBe(60);
    expect(calls).toEqual(['savepoint', 'select:services']);
  });

  test('a plain (non-transaction) connection reads directly — no savepoint', async () => {
    const calls = [];
    const conn = (table) => {
      calls.push(`select:${table}`);
      return { select: async () => [{ service_key: 'quarterly_pest', name: 'Pest', min_duration_minutes: 30, max_duration_minutes: 60 }] };
    };
    conn.transaction = async () => { throw new Error('must not be called'); };
    expect(await expectedServiceMinutes(conn, { serviceKey: 'quarterly_pest', windowMinutes: 60 })).toBe(45);
    expect(calls).toEqual(['select:services']);
  });

  test('a successful read under a trx also goes through the savepoint', async () => {
    const calls = [];
    const trx = (table) => {
      calls.push(`select:${table}`);
      return { select: async () => [{ service_key: 'quarterly_pest', name: 'Pest', min_duration_minutes: 30, max_duration_minutes: 60 }] };
    };
    trx.isTransaction = true;
    trx.transaction = async (fn) => { calls.push('savepoint'); return fn(trx); };
    expect(await expectedServiceMinutes(trx, { serviceKey: 'quarterly_pest', windowMinutes: 60 })).toBe(45);
    expect(calls).toEqual(['savepoint', 'select:services']);
  });
});

describe('expectedMinutesForServices — a whole visit sums every service (push-audit P1)', () => {
  const conn = () => fakeConn([
    { service_key: 'quarterly_pest', name: 'Pest', min_duration_minutes: 30, max_duration_minutes: 60 },
    { service_key: 'lawn_basic', name: 'Lawn Care', default_duration_minutes: 40 },
  ]);
  const { expectedMinutesForServices } = require('../services/scheduling/expected-service-minutes');

  test('a 120-minute combined pest+lawn visit is expected at 45 + 40 = 85, not the primary alone (45)', async () => {
    const services = [
      { catalogServiceKey: 'quarterly_pest', label: 'Pest', durationMinutes: 60 },
      { catalogServiceKey: 'lawn_basic', label: 'Lawn Care', durationMinutes: 60 },
    ];
    expect(await expectedMinutesForServices(conn(), services, 120)).toBe(85);
  });

  test('a member with no catalog match contributes its full own duration (zero padding for that member)', async () => {
    const services = [
      { catalogServiceKey: 'quarterly_pest', label: 'Pest', durationMinutes: 60 },
      { label: 'Mystery add-on', durationMinutes: 60 },
    ];
    expect(await expectedMinutesForServices(conn(), services, 120)).toBe(105);
  });

  test('members without their own duration are clamped to the visit window and the sum never exceeds it', async () => {
    const services = [{ catalogServiceKey: 'quarterly_pest', label: 'Pest' }, { label: 'Mystery' }];
    expect(await expectedMinutesForServices(conn(), services, 60)).toBe(60);
  });

  test('a single service is the plain lookup', async () => {
    expect(await expectedMinutesForServices(conn(), [{ catalogServiceKey: 'quarterly_pest', durationMinutes: 60 }], 60)).toBe(45);
    expect(await expectedMinutesForServices(conn(), [], 60)).toBe(60);
  });
});

describe('ambiguous catalog names (Codex #4664 r2 P1)', () => {
  test('a services.name shared by two rows resolves to NOTHING by name — window-length fallback', async () => {
    const conn = fakeConn([
      { service_key: 'lawn_a', name: 'Lawn Care', min_duration_minutes: 20, max_duration_minutes: 30 },
      { service_key: 'lawn_b', name: 'Lawn Care', min_duration_minutes: 50, max_duration_minutes: 60 },
      { service_key: 'pest', name: 'Pest', min_duration_minutes: 30, max_duration_minutes: 60 },
    ]);
    expect(await expectedServiceMinutes(conn, { serviceType: 'Lawn Care', windowMinutes: 60 })).toBe(60);
    // The key lookups still resolve; the unique name still resolves.
    expect(expectedMinutesSync({ serviceKey: 'lawn_a', windowMinutes: 60 })).toBe(25);
    expect(expectedMinutesSync({ serviceType: 'pest', windowMinutes: 60 })).toBe(45);
  });
});
