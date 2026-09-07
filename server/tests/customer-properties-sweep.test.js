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
function installDb({ candidates = [], customersById = {}, props = {}, insertError = null } = {}) {
  const inserted = [];
  const chain = (table) => {
    const q = {
      _id: null,
      whereNull: () => q, whereRaw: () => q, whereNotExists: () => q, orderBy: () => q, limit: () => q, select: () => q,
      forUpdate: () => q,
      where: (arg) => { if (arg && typeof arg === 'object') q._id = arg.id || arg.customer_id || null; return q; },
      then: (resolve) => resolve(candidates.map((id) => ({ id }))),
      first: async () => {
        if (table === 'customers') return customersById[q._id] || null;
        return (props[q._id] || [])[0] || null;
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
  mockDb.transaction = async (fn) => fn(mockDb);
  return { inserted };
}

const live = (id, over = {}) => ({ id, deleted_at: null, address_line1: '100 Main St', city: 'Sampleville', state: 'FL', zip: '34200', latitude: 27.1, longitude: -82.1, contact_role: null, ...over });

describe('sweepMissingPrimaryProperties (daily primary backstop)', () => {
  beforeEach(() => { mockDb.mockReset(); logger.error.mockClear(); });

  test('creates the primary from the customers mirror for every row-less live customer', async () => {
    const { inserted } = installDb({ candidates: ['c1', 'c2'], customersById: { c1: live('c1'), c2: live('c2', { contact_role: 'property_manager' }) } });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 2, created: 2, skipped: 0, failed: 0 });
    expect(inserted.map((r) => [r.customer_id, r.is_primary, r.active, r.source, r.address_line1, r.latitude, r.occupancy_type])).toEqual([
      ['c1', true, true, 'backfill', '100 Main St', 27.1, 'owner_occupied'],
      ['c2', true, true, 'backfill', '100 Main St', 27.1, 'rental_investment'],
    ]);
  });

  test('re-checks under the lock: a row that appeared, a soft-delete, or a blanked address since selection is skipped', async () => {
    const { inserted } = installDb({
      candidates: ['gone', 'blank', 'raced'],
      customersById: { gone: live('gone', { deleted_at: new Date() }), blank: live('blank', { address_line1: '   ' }), raced: live('raced') },
      props: { raced: [{ id: 'p-existing', is_primary: true, active: true }] },
    });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 3, created: 0, skipped: 3, failed: 0 });
    expect(inserted).toHaveLength(0);
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

  test('nothing to do → zero counts and no log noise', async () => {
    installDb({ candidates: [] });
    expect(await sweepMissingPrimaryProperties()).toEqual({ checked: 0, created: 0, skipped: 0, failed: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('scheduler wiring', () => {
  test('a daily 3:20 AM ET tick runs the primary backstop under its own job_health name', () => {
    const src = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
    expect(src).toMatch(/cron\.schedule\('20 3 \* \* \*', async \(\) => \{[\s\S]{0,600}runExclusive\('primary-property-backstop', \(\) => sweepMissingPrimaryProperties\(\)\)/);
  });
});
