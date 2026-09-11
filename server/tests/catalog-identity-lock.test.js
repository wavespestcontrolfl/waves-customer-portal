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
 *   - reader (catalogLinkForProfile): every capacity-transaction read takes it
 *     as the first statement of its savepoint and requests NO row lock (a row
 *     lock alongside the table lock deadlocks against writers that pre-lock
 *     rows, codex #4369 r2); non-capacity reads stay lock-free
 *   - the engine-key migrations' explicit table lock is a mode that conflicts
 *     with SHARE (source-level pin — the DB-enforced guarantee rests on it)
 */
const fs = require('fs');
const path = require('path');
const { lockCatalogIdentity, lockCatalogForWrite, CATALOG_SHARE_LOCK_SQL, CATALOG_WRITE_LOCK_SQL } = require('../services/scheduling/catalog-lock');
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

describe('catalogLinkForProfile — table SHARE lock replaces catalog row locks', () => {
  // A transactional conn whose lookups find NO row. Records every services
  // read and whether FOR SHARE was requested on it.
  function absentConn({ isTransaction = true } = {}) {
    const events = [];
    const chain = () => ({
      andWhere: () => chain(), limit: () => chain(),
      forShare: () => { events.push('FOR SHARE'); return chain(); },
      modify: async (fn) => { const q = { forShare: () => events.push('FOR SHARE') }; fn?.(q); events.push('services-read'); return []; },
      select: () => { events.push('services-read'); const c = chain(); c.then = (resolve) => resolve([]); return c; },
    });
    const builder = () => ({ where: () => chain(), whereRaw: () => chain() });
    builder.transaction = async (cb) => { events.push('savepoint'); return cb(builder); };
    builder.raw = jest.fn(async (sql) => { events.push(sql === CATALOG_SHARE_LOCK_SQL ? 'share-lock' : sql); });
    if (isTransaction) builder.isTransaction = true;
    return { conn: builder, events };
  }
  const profile = { services: [{ service: 'pest_control', engineKey: 'unmapped_engine_key', durationMinutes: 60 }] };

  test('a duration authority takes the SHARE lock as the FIRST statement of the lookup savepoint and returns null on a miss', async () => {
    const { conn, events } = absentConn();
    const link = await catalogLinkForProfile(conn, profile, { preserveCapacity: true, validateAllowance: true });
    expect(link).toBeNull();
    expect(conn.raw).toHaveBeenCalledTimes(1);
    expect(conn.raw).toHaveBeenCalledWith(CATALOG_SHARE_LOCK_SQL);
    expect(events.slice(0, 2)).toEqual(['savepoint', 'share-lock']);
    expect(events.indexOf('share-lock')).toBeLessThan(events.indexOf('services-read'));
    expect(events).not.toContain('FOR SHARE');
  });

  test('identity-only and strict readers inside a capacity transaction take the same table lock — never a row lock', async () => {
    let { conn, events } = absentConn();
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true })).toBeNull();
    expect(conn.raw).toHaveBeenCalledWith(CATALOG_SHARE_LOCK_SQL);
    expect(events).not.toContain('FOR SHARE');
    ({ conn, events } = absentConn());
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true, strictAllowanceRead: true })).toBeNull();
    expect(conn.raw).toHaveBeenCalledWith(CATALOG_SHARE_LOCK_SQL);
    expect(events).not.toContain('FOR SHARE');
  });

  test('under the live gate (no preserveCapacity) the lock is taken too', async () => {
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

  test('outside a transaction, or with capacity off, no catalog lock of any kind is attempted (legacy fail-open read)', async () => {
    let { conn } = absentConn({ isTransaction: false });
    expect(await catalogLinkForProfile(conn, profile, { preserveCapacity: true, validateAllowance: true })).toBeNull();
    expect(conn.raw).not.toHaveBeenCalled();
    ({ conn } = absentConn());
    expect(await catalogLinkForProfile(conn, profile, {})).toBeNull();
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('no catalog reader in the capacity transactions requests a services row lock any more (source-level)', () => {
    const slotSrc = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');
    expect(slotSrc).not.toMatch(/lockCatalog\) query\.forShare/);
    const converterSrc = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    expect(converterSrc).not.toMatch(/catalogQuery\.forShare\(\)/);
    // Three protected reads + the top-of-transaction acquisition.
    expect(converterSrc.match(/lockCatalogIdentity\((database|trx)\)/g)).toHaveLength(4);
  });
});

describe('lock order: catalog SHARE lock precedes scheduled_services row locks (codex #4369 r3)', () => {
  test('commitReservation takes it after the day fences and before its hold row FOR UPDATE', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');
    const start = src.indexOf('async function commitReservation(');
    const body = src.slice(start, src.indexOf("const row = await client('scheduled_services')", start));
    const lockIdx = body.indexOf("require('./scheduling/catalog-lock').lockCatalogIdentity(client)");
    expect(lockIdx).toBeGreaterThan(body.lastIndexOf('await lockTechDays(client'));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(body.slice(lockIdx)).not.toContain('.forUpdate()');
    expect(body).toContain("capacityEnabled() || preRow.reservation_policy_version === 2");
  });

  test('convertEstimate takes it right after loading the estimate, before any row lock', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/estimate-converter.js'), 'utf8');
    const start = src.indexOf('async convertEstimate(estimateId');
    const lockIdx = src.indexOf("require('./scheduling/catalog-lock').lockCatalogIdentity(database)", start);
    expect(lockIdx).toBeGreaterThan(-1);
    const before = src.slice(start, lockIdx);
    expect(before).toContain("const estimate = await database('estimates').where({ id: estimateId }).first();");
    expect(before).not.toContain('.forUpdate()');
    expect(before).not.toContain('database.transaction(');
    expect(src.slice(lockIdx - 400, lockIdx)).toContain("reservation_policy_version: 2 }).first('id')");
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
    // The only catalog-lock reference is the writer-side TABLE lock in
    // deactivateService, the one path that pre-locks a services row (codex
    // #4369 r4 P1) — still no advisory-lock convention anywhere.
    expect(src).not.toContain('pg_advisory');
    expect(src.match(/require\('\.\/scheduling\/catalog-lock'\)/g)).toHaveLength(1);
    expect(src).toContain('lockCatalogForWrite(trx)');
    expect(src).toMatch(/trx\('services'\)\.insert\(/);
    expect(src).toMatch(/trx\('services'\)\.where\(\{ id \}\)\.update\(/);
  });
});

describe('the one row-prelocking catalog writer takes its table lock first (codex #4369 r4)', () => {
  test('lockCatalogForWrite issues ROW EXCLUSIVE (conflicts with the readers\' SHARE) and needs a transaction', async () => {
    await expect(lockCatalogForWrite(undefined)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
    const trx = fakeTrx();
    await lockCatalogForWrite(trx);
    expect(trx.raw).toHaveBeenCalledWith(CATALOG_WRITE_LOCK_SQL);
    expect(CATALOG_WRITE_LOCK_SQL).toBe('LOCK TABLE services IN ROW EXCLUSIVE MODE');
  });

  test('deactivateService locks the table before its services row FOR UPDATE (source-level)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/service-library.js'), 'utf8');
    const start = src.indexOf('async function deactivateService');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const lock = body.indexOf("lockCatalogForWrite(trx)");
    const rowLock = body.indexOf(".forUpdate()");
    expect(lock).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(lock);
  });

  test('commitReservation pre-reads reservation_policy_version so a persisted V2 hold keeps the early lock after gate shutdown (source-level)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/slot-reservation.js'), 'utf8');
    expect(src).toContain(".first('scheduled_date', 'technician_id', 'reservation_policy_version')");
    const pre = src.indexOf(".first('scheduled_date', 'technician_id', 'reservation_policy_version')");
    const decision = src.indexOf('preRow.reservation_policy_version === 2', pre);
    expect(decision).toBeGreaterThan(pre);
  });
});
