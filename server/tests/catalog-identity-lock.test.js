/**
 * Catalog table SHARE lock (scheduling/catalog-lock.js) — closes the
 * ABSENT-match race (codex #4344 P1, posted after merge): a duration-authority
 * catalog read that matches no row holds nothing, so a writer could activate
 * or map a longer-duration row between that read and the outer commit and a
 * version-2 hold on the 60-minute fallback would graduate against it.
 *
 * Enforced by the database (codex #4369 r1 P1): `LOCK TABLE services IN SHARE
 * MODE` conflicts with the ROW EXCLUSIVE lock every INSERT/UPDATE/DELETE takes
 * and with the SHARE ROW EXCLUSIVE lock the engine-key migrations take, so
 * admin writes and pre-deploy migrations alike wait out an in-flight
 * certification — no advisory-lock convention for a writer to forget.
 *
 *   - helper: the exact SHARE-mode statement, transaction required
 *   - reader (catalogLinkForProfile): duration authorities take it before any
 *     services read; identity-only callers stay lock-free
 *   - the engine-key migrations' explicit table lock is a mode that conflicts
 *     with SHARE (source-level pin — the DB-enforced guarantee rests on it)
 */
const fs = require('fs');
const path = require('path');
const { lockCatalogIdentity, CATALOG_SHARE_LOCK_SQL } = require('../services/scheduling/catalog-lock');
const { _internals } = require('../services/slot-reservation');

const { catalogLinkForProfile } = _internals;

function fakeTrx() {
  const raw = jest.fn().mockResolvedValue(undefined);
  const trx = (...args) => raw(...args);
  trx.raw = raw;
  trx.isTransaction = true;
  return trx;
}

describe('lockCatalogIdentity', () => {
  test('rejects a connection that is not a transaction', async () => {
    await expect(lockCatalogIdentity(undefined)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
    await expect(lockCatalogIdentity(() => {})).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
  });

  test('issues the services table SHARE lock (conflicts with ROW EXCLUSIVE writers, not with other SHARE readers)', async () => {
    const trx = fakeTrx();
    await lockCatalogIdentity(trx);
    expect(trx.raw).toHaveBeenCalledTimes(1);
    expect(trx.raw).toHaveBeenCalledWith('LOCK TABLE services IN SHARE MODE');
    expect(CATALOG_SHARE_LOCK_SQL).toBe('LOCK TABLE services IN SHARE MODE');
  });
});

describe('catalogLinkForProfile — absent match serialization', () => {
  // A transactional conn whose containment lookup finds NO row.
  function absentConn({ isTransaction = true } = {}) {
    const events = [];
    const chain = () => ({ andWhere: () => chain(), limit: () => chain(), select: () => ({ modify: async () => { events.push('services-read'); return []; } }) });
    const builder = () => ({
      where: () => chain(),
      whereRaw: () => { events.push('services-read'); return chain(); },
    });
    builder.transaction = async (cb) => cb(builder);
    builder.raw = jest.fn(async (sql) => { events.push(sql === CATALOG_SHARE_LOCK_SQL ? 'share-lock' : sql); });
    if (isTransaction) builder.isTransaction = true;
    return { conn: builder, events };
  }
  const profile = { services: [{ service: 'pest_control', engineKey: 'unmapped_engine_key', durationMinutes: 60 }] };

  test('a duration authority takes the SHARE lock BEFORE the services read and still returns null on a miss', async () => {
    const { conn, events } = absentConn();
    const link = await catalogLinkForProfile(conn, profile, { preserveCapacity: true, validateAllowance: true });
    expect(link).toBeNull();
    expect(conn.raw).toHaveBeenCalledTimes(1);
    expect(conn.raw).toHaveBeenCalledWith(CATALOG_SHARE_LOCK_SQL);
    expect(events.indexOf('share-lock')).toBeGreaterThan(-1);
    expect(events.indexOf('share-lock')).toBeLessThan(events.indexOf('services-read'));
  });

  test('a duration authority under the live gate (no preserveCapacity) takes it too', async () => {
    const previous = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      const { conn } = absentConn();
      await catalogLinkForProfile(conn, profile, { validateAllowance: true });
      expect(conn.raw).toHaveBeenCalledWith(CATALOG_SHARE_LOCK_SQL);
    } finally {
      if (previous === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = previous;
    }
  });

  test('identity-only callers (no validateAllowance) stay lock-free and fail open', async () => {
    const { conn } = absentConn();
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true })).toBeNull();
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true, strictAllowanceRead: true })).toBeNull();
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('outside a transaction no catalog lock of any kind is attempted (matches the FOR SHARE contract)', async () => {
    const { conn } = absentConn({ isTransaction: false });
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true, validateAllowance: true })).toBeNull();
    expect(conn.raw).not.toHaveBeenCalled();
  });
});

describe('catalog writers need no convention: their locks conflict with SHARE at the database', () => {
  const migrationsDir = path.join(__dirname, '../models/migrations');

  test('every migration that takes an explicit services table lock uses a mode that conflicts with SHARE', () => {
    // SHARE conflicts with ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE ROW
    // EXCLUSIVE, EXCLUSIVE and ACCESS EXCLUSIVE. It does NOT conflict with
    // ACCESS SHARE, ROW SHARE or SHARE — a migration locking in one of those
    // and then writing would still take ROW EXCLUSIVE for the write itself,
    // but pin the explicit modes anyway so a weaker lock never reads as a
    // serialization guarantee.
    const explicit = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.js'))
      .flatMap((f) => {
        const src = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
        return [...src.matchAll(/LOCK TABLE services IN ([A-Z ]+?) MODE/g)].map((m) => ({ file: f, mode: m[1].trim() }));
      });
    expect(explicit.length).toBeGreaterThan(0);
    for (const { file, mode } of explicit) {
      expect({ file, mode }).toEqual({ file, mode: expect.stringMatching(/^(ROW EXCLUSIVE|SHARE UPDATE EXCLUSIVE|SHARE ROW EXCLUSIVE|EXCLUSIVE|ACCESS EXCLUSIVE)$/) });
    }
  });

  test('service-library writes go through knex insert/update on `services` (implicit ROW EXCLUSIVE) — no advisory convention to keep in step', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-library.js'), 'utf8');
    expect(src).not.toContain('catalog-lock');
    expect(src).toMatch(/trx\('services'\)\.insert\(/);
    expect(src).toMatch(/trx\('services'\)\.where\(\{ id \}\)\.update\(/);
  });
});
