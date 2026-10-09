// A move clears the new-sod record. sod_laid_on, sod_covers, sod_area and sod_rooted_on sit on
// the customer-level preference row, which survives an address change, a merge and a primary-
// property promotion; the ONE move writer (markSprinklerSettingsMoved) clears all four in the
// same transaction. The merge deliberately does not (no before-image for the stamp): it keeps the
// winner's record and journals a clear of a moved-whole loser row. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { propagateCustomerAddressChange, markSprinklerSettingsMoved } = require('../services/customer-address-fanout');
const { NEW_SOD_COLUMNS } = require('../services/lawn-sod-holds');

// A stateful fake: ONE preference row that the move writer updates, so the test proves the
// record is really gone for the next reader.
function makeStore(prefs) {
  const store = { prefs, raws: [] };
  const db = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select']) q[m] = () => q;
    q.update = async (patch) => { if (table === 'property_preferences' && store.prefs) { Object.assign(store.prefs, patch); return 1; } return 0; };
    q.insert = (row) => { q.__row = row; return q; };
    q.onConflict = () => q;
    q.merge = async (patch) => { store.prefs = { ...(q.__row || {}), ...patch }; return [1]; };
    q.first = async () => (table === 'property_preferences' ? store.prefs : null);
    // Lead / estimate fan-out reads: nothing to propagate.
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  };
  db.raw = (sql, bindings) => { store.raws.push({ sql, bindings }); return { __raw: sql }; };
  store.db = db;
  return store;
}

const HOME = { id: 'cust-1', address_line1: '100 Example Court', city: 'Bradenton', state: 'FL', zip: '34201' };
const NEW_HOME = { id: 'cust-1', address_line1: '200 Sample Lane', city: 'Bradenton', state: 'FL', zip: '34202' };
const record = () => ({ customer_id: 'cust-1', sod_laid_on: '2026-10-01', sod_covers: 'part', sod_area: 'back lawn', sod_rooted_on: '2026-10-25', irrigation_run_minutes: 20 });
const sodOf = (prefs) => Object.fromEntries(NEW_SOD_COLUMNS.map((c) => [c, prefs[c]]));
const CLEARED = { sod_laid_on: null, sod_covers: null, sod_area: null, sod_rooted_on: null };

describe('a move clears the whole new-sod record', () => {
  test('an address move clears all four columns in the fan-out and leaves the sprinkler settings alone', async () => {
    const store = makeStore(record());
    const counts = await propagateCustomerAddressChange({ before: HOME, after: NEW_HOME }, store.db);
    expect(counts.property_preferences).toBe(1);
    expect(sodOf(store.prefs)).toEqual(CLEARED);
    expect(store.prefs.irrigation_run_minutes).toBe(20);
    expect(store.prefs.irrigation_home_changed_at).toBeInstanceOf(Date);
    // The same advisory lock the prefs PUT serializes on was taken first (same transaction).
    expect(store.raws[0].sql).toMatch(/pg_advisory_xact_lock/);
  });

  test('removing the address also clears it', async () => {
    const store = makeStore(record());
    await propagateCustomerAddressChange({ before: HOME, after: { ...HOME, address_line1: '' } }, store.db);
    expect(sodOf(store.prefs)).toEqual(CLEARED);
  });

  test('a formatting-only correction of the same home is not a move and keeps the record', async () => {
    const store = makeStore(record());
    await propagateCustomerAddressChange({ before: HOME, after: { ...HOME, address_line1: '100 EXAMPLE CT.' } }, store.db);
    expect(sodOf(store.prefs)).toEqual(sodOf(record()));
  });

  test('the primary-residence promotion and the fan-out clear it through the one writer; a missing row gets a minimal row with nulls', async () => {
    const store = makeStore(record());
    await markSprinklerSettingsMoved('cust-1', store.db);
    expect(sodOf(store.prefs)).toEqual(CLEARED);
    const empty = makeStore(null);
    await markSprinklerSettingsMoved('cust-1', empty.db);
    expect(sodOf(empty.prefs)).toEqual(CLEARED);
    expect(fs.readFileSync(path.join(__dirname, '../services/property-role-proposals.js'), 'utf8')).toMatch(/markSprinklerSettingsMoved\(customerId, trx\)/);
  });

  test('the merge path stamps the move WITHOUT clearing the record, so an undo returns the row with it', async () => {
    const store = makeStore(record());
    await markSprinklerSettingsMoved('cust-1', store.db, { clearNewSod: false });
    expect(store.prefs.irrigation_home_changed_at).toBeInstanceOf(Date); // the sprinkler-settings guard still applies
    expect(sodOf(store.prefs)).toEqual(sodOf(record())); // nothing to restore on an undo: nothing was cleared
  });

  test('the merge executor passes clearNewSod:false from one premise test, and every other caller keeps the default', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '../services', f), 'utf8');
    expect(read('customer-dedupe.js')).toMatch(/markSprinklerSettingsMoved\(winnerId, sp, \{ clearNewSod: false \}\)/);
    // One premise test, decided once: the preferences fill and the move stamp read the same value.
    expect(read('customer-dedupe.js')).toMatch(/copyNewSod: !mergeDifferentHomes/);
    expect(read('customer-dedupe.js')).toMatch(/if \(mergeDifferentHomes\) \{\s*try \{/);
    expect(read('property-role-proposals.js')).toMatch(/markSprinklerSettingsMoved\(customerId, trx\)/);
    expect(read('customer-address-fanout.js').match(/markSprinklerSettingsMoved\(customerId, conn\)/g)).toHaveLength(2);
  });

  test('no call site lists the sod columns by hand', () => {
    for (const file of ['customer-dedupe.js', 'customer-address-fanout.js']) {
      const source = fs.readFileSync(path.join(__dirname, '../services', file), 'utf8');
      expect(source).not.toMatch(/sod_covers|sod_area|sod_rooted_on/);
    }
  });
});
