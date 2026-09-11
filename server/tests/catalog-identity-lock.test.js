/**
 * Catalog-identity advisory lock (scheduling/catalog-lock.js) — closes the
 * ABSENT-match race (codex #4344 P1, posted after merge): a duration-authority
 * catalog read that matches no row holds nothing, so an admin could activate
 * or map a longer-duration row between that read and the outer commit and a
 * version-2 hold on the 60-minute fallback would graduate against it.
 *
 *   - helper: shared by default, exclusive on request, transaction required
 *   - reader (catalogLinkForProfile): duration authorities take it SHARED
 *     before any services read; identity-only callers stay lock-free
 *   - writers (service-library create/update/archive): EXCLUSIVE before the
 *     services write, and before the archive path's FOR UPDATE
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({
  auditServiceCatalogChange: jest.fn(async () => ({})),
  auditServicePackageChange: jest.fn(async () => ({})),
  recordAuditEvent: jest.fn(async () => ({})),
}));
jest.mock('../services/service-catalog-names', () => ({ refreshCatalogNames: jest.fn(async () => {}) }));

const db = require('../models/db');
const { lockCatalogIdentity, CATALOG_LOCK_NAMESPACE, CATALOG_LOCK_KEY } = require('../services/scheduling/catalog-lock');
const { _internals } = require('../services/slot-reservation');
const serviceLibrary = require('../services/service-library');

const SHARED = 'SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?::text))';
const EXCLUSIVE = 'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))';
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

  test('default call is SHARED on the fixed namespace/key (same family as the closure lock, distinct key)', async () => {
    const trx = fakeTrx();
    await lockCatalogIdentity(trx);
    expect(trx.raw).toHaveBeenCalledTimes(1);
    expect(trx.raw.mock.calls[0]).toEqual([SHARED, [CATALOG_LOCK_NAMESPACE, CATALOG_LOCK_KEY]]);
    expect([CATALOG_LOCK_NAMESPACE, CATALOG_LOCK_KEY]).toEqual(['slot-reserve', 'catalog-identity']);
  });

  test('exclusive: true is the blocking form on the same key', async () => {
    const trx = fakeTrx();
    await lockCatalogIdentity(trx, { exclusive: true });
    expect(trx.raw.mock.calls[0]).toEqual([EXCLUSIVE, ['slot-reserve', 'catalog-identity']]);
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
    builder.raw = jest.fn(async (sql) => { events.push(sql === SHARED ? 'shared-lock' : sql); });
    if (isTransaction) builder.isTransaction = true;
    return { conn: builder, events };
  }
  const profile = { services: [{ service: 'pest_control', engineKey: 'unmapped_engine_key', durationMinutes: 60 }] };

  test('a duration authority takes the SHARED lock BEFORE the services read and still returns null on a miss', async () => {
    const { conn, events } = absentConn();
    const link = await catalogLinkForProfile(conn, profile, { preserveCapacity: true, validateAllowance: true });
    expect(link).toBeNull();
    expect(conn.raw).toHaveBeenCalledWith(SHARED, ['slot-reserve', 'catalog-identity']);
    expect(events.indexOf('shared-lock')).toBeGreaterThan(-1);
    expect(events.indexOf('shared-lock')).toBeLessThan(events.indexOf('services-read'));
    expect(conn.raw).toHaveBeenCalledTimes(1);
  });

  test('a duration authority under the live gate (no preserveCapacity) takes it too', async () => {
    const previous = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      const { conn } = absentConn();
      await catalogLinkForProfile(conn, profile, { validateAllowance: true });
      expect(conn.raw).toHaveBeenCalledWith(SHARED, ['slot-reserve', 'catalog-identity']);
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

describe('service-library catalog writers take the EXCLUSIVE lock before writing', () => {
  function servicesQuery(before, after, events) {
    const query = {
      where: jest.fn(() => query),
      forUpdate: jest.fn(() => { events.push('for-update'); return query; }),
      first: jest.fn(async () => before),
      insert: jest.fn(() => ({ returning: jest.fn(async () => { events.push('write'); return [after]; }) })),
      update: jest.fn(() => ({ returning: jest.fn(async () => { events.push('write'); return [after]; }) })),
    };
    return query;
  }
  function countQuery() {
    const query = {
      join: jest.fn(() => query), where: jest.fn(() => query), whereNull: jest.fn(() => query),
      orWhere: jest.fn(() => query), orWhereNot: jest.fn(() => query), whereNotIn: jest.fn(() => query),
      whereRaw: jest.fn(() => query), count: jest.fn(() => query), first: jest.fn(async () => ({ count: 0 })),
    };
    return query;
  }
  const row = { id: 'service-1', service_key: 'general_pest', name: 'General Pest Control', category: 'pest_control',
    billing_type: 'recurring', pricing_type: 'fixed', is_active: true, is_archived: false,
    min_duration_minutes: 60, default_duration_minutes: 60, max_duration_minutes: 120 };
  let events;
  beforeEach(() => {
    jest.clearAllMocks();
    events = [];
    db.isTransaction = true;
    db.raw = jest.fn(async (sql) => { events.push(sql === EXCLUSIVE ? 'exclusive-lock' : sql); });
    db.transaction = jest.fn(async (callback) => callback(db));
    db.mockImplementation((table) => (table === 'services' ? servicesQuery(row, row, events) : countQuery()));
  });

  test('createService', async () => {
    await serviceLibrary.createService({ name: 'New Lane', service_key: 'new_lane', category: 'pest_control',
      billing_type: 'one_time', pricing_type: 'fixed', base_price: 100 });
    expect(events).toEqual(['exclusive-lock', 'write']);
    expect(db.raw).toHaveBeenCalledWith(EXCLUSIVE, ['slot-reserve', 'catalog-identity']);
  });

  test('updateService (activation / mapping / duration edits go through here)', async () => {
    await serviceLibrary.updateService('service-1', { is_active: true, engine_keys: ['pest_general'] });
    expect(events).toEqual(['exclusive-lock', 'write']);
  });

  test('deactivateService takes the lock BEFORE its FOR UPDATE (lock-then-row order)', async () => {
    await serviceLibrary.deactivateService('service-1');
    expect(events).toEqual(['exclusive-lock', 'for-update', 'write']);
  });
});
