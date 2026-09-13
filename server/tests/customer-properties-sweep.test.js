// Daily primary-property backstop (scheduler 3:20 AM ET): live, addressed
// customers with NO customer_properties row get the lazily-created primary
// within the day — the customer-insert paths never create one.
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { sweepMissingPrimaryProperties } = require('../services/customer-properties');
const logger = require('../services/logger');

// Fake knex: `customers as c` list → candidates; `customers` by id → the
// mirror row (FOR UPDATE is a no-op); `customer_properties` reads answer
// from `props`; insert appends. transaction(fn) hands back the same fake
// (top-level and the core's nested savepoint alike).
// `appearOnLock`: rows that land for a customer BETWEEN candidate selection
// and the FOR UPDATE (a concurrent lazy read committing its primary) — the
// re-check must see them, the selection must not.
function installDb({ candidates = [], customersById = {}, props = {}, insertError = null, appearOnLock = {} } = {}) {
  const inserted = [];
  const chain = (table) => {
    const q = {
      _id: null, _excluded: [], _limit: Infinity, _primaryOnly: false,
      whereNull: () => q, whereRaw: () => q, whereNotExists: () => q, orderBy: () => q, select: () => q,
      modify: (cb) => { cb(q); return q; },
      whereNotIn: (col, ids) => { q._excluded = ids; return q; },
      limit: (n) => { q._limit = n; return q; },
      forUpdate: () => { if (appearOnLock[q._id]) props[q._id] = appearOnLock[q._id]; return q; },
      where: (arg) => {
        if (arg && typeof arg === 'object') { q._id = arg.id || arg.customer_id || null; q._primaryOnly = arg.is_primary === true; }
        return q;
      },
      // Candidate list mirrors the real predicate: a customer that now HAS a
      // property row (created this run) drops out; excluded ids drop out.
      then: (resolve) => resolve(
        candidates.filter((id) => !(props[id] || []).length && !q._excluded.includes(id)).slice(0, q._limit).map((id) => ({ id })),
      ),
      // `first()` honours a `{ is_primary: true }` filter: the core's own
      // guard only sees primaries, so a NON-primary row that appeared under
      // the lock is skipped by the sweep's any-row re-check alone.
      first: async () => {
        if (table === 'customers') return customersById[q._id] || null;
        return (props[q._id] || []).find((p) => !q._primaryOnly || p.is_primary) || null;
      },
      insert: (row) => ({
        returning: async () => {
          if (insertError) throw insertError;
          const id = `p-${inserted.length + 1}`;
          inserted.push({ ...row, id });
          (props[row.customer_id] = props[row.customer_id] || []).push({ id, is_primary: true, active: true });
          return [{ id }];
        },
      }),
    };
    return q;
  };
  mockDb.mockImplementation((table) => chain(table));
  mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
  return { inserted };
}

const live = (id, over = {}) => ({ id, deleted_at: null, address_line1: '100 Main St', city: 'Sampleville', state: 'FL', zip: '34200', latitude: 27.1, longitude: -82.1, contact_role: null, ...over });

describe('sweepMissingPrimaryProperties (daily primary backstop)', () => {
  beforeEach(() => { mockDb.mockReset(); logger.error.mockClear(); logger.warn.mockClear(); });

  test('creates the primary from the customers mirror for every row-less live customer', async () => {
    const { inserted } = installDb({ candidates: ['c1', 'c2'], customersById: { c1: live('c1'), c2: live('c2', { contact_role: 'property_manager' }) } });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 2, created: 2, skipped: 0, failed: 0 });
    expect(inserted.map((r) => [r.customer_id, r.is_primary, r.active, r.source, r.address_line1, r.latitude, r.occupancy_type])).toEqual([
      ['c1', true, true, 'backfill', '100 Main St', 27.1, 'owner_occupied'],
      ['c2', true, true, 'backfill', '100 Main St', 27.1, 'rental_investment'],
    ]);
  });

  test('re-checks under the lock: a row that appeared, a soft-delete, or a blanked address since selection is skipped', async () => {
    // `raced` lands a NON-primary row under the lock: ensurePrimaryCore's
    // primary-only guard would still insert, so only the sweep's any-row
    // re-check can skip it — delete that re-check and this case goes red.
    const { inserted } = installDb({
      candidates: ['gone', 'blank', 'raced'],
      customersById: { gone: live('gone', { deleted_at: new Date() }), blank: live('blank', { address_line1: '   ' }), raced: live('raced') },
      appearOnLock: { raced: [{ id: 'p-existing', is_primary: false, active: true }] },
    });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 3, created: 0, skipped: 3, failed: 0 });
    expect(inserted).toHaveLength(0);
    // One transaction per candidate row (the lock, the re-check and the
    // core share it) — the docstring's contract.
    expect(mockDb.transaction).toHaveBeenCalledTimes(3);
  });

  test('a failing insert is counted, logged by code only, every row is still attempted, and the sweep then rejects so job_health records the failure', async () => {
    const err = Object.assign(new Error("insert into customer_properties (address_line1) values ('100 Main St')"), { code: '42P01' });
    installDb({ candidates: ['c1', 'c2'], customersById: { c1: live('c1'), c2: live('c2') }, insertError: err });
    let thrown = null;
    try { await sweepMissingPrimaryProperties(); } catch (e) { thrown = e; }
    expect(thrown).not.toBeNull();
    expect(thrown.message).toBe('primary backstop sweep: 2 of 2 row(s) failed');
    expect(thrown.results).toEqual({ checked: 2, created: 0, skipped: 0, failed: 2 });
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[0][0]).toContain('42P01');
    expect(logger.error.mock.calls[0][0]).not.toContain('Main St');
  });

  test('a backlog larger than one batch is drained in one run, and failed ids are not re-selected', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const customersById = Object.fromEntries(ids.map((id) => [id, live(id)]));
    const { inserted } = installDb({ candidates: ids, customersById });
    expect(await sweepMissingPrimaryProperties({ batchSize: 100 })).toEqual({ checked: 250, created: 250, skipped: 0, failed: 0 });
    expect(inserted).toHaveLength(250);
    expect(new Set(inserted.map((r) => r.customer_id)).size).toBe(250);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('maxRows caps a runaway run, and says so: a capped run is not a drained one', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    installDb({ candidates: ids, customersById: Object.fromEntries(ids.map((id) => [id, live(id)])) });
    expect((await sweepMissingPrimaryProperties({ batchSize: 10, maxRows: 25 })).checked).toBe(25);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('maxRows guard (25)');
  });

  test('a backlog that ends exactly on the guard is reported as capped, not drained', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    installDb({ candidates: ids, customersById: Object.fromEntries(ids.map((id) => [id, live(id)])) });
    expect((await sweepMissingPrimaryProperties({ batchSize: 10, maxRows: 20 })).checked).toBe(20);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('nothing to do → zero counts and no log noise', async () => {
    installDb({ candidates: [] });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 0, created: 0, skipped: 0, failed: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('scheduler wiring', () => {
  test('a daily 3:20 AM ET tick runs the primary backstop under its own job_health name', () => {
    const src = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
    expect(src).toMatch(/cron\.schedule\('20 3 \* \* \*', async \(\) => \{[\s\S]{0,600}runExclusive\('primary-property-backstop', \(\) => sweepMissingPrimaryProperties\(\)\)[\s\S]{0,200}timezone: 'America\/New_York'/);
  });
});
