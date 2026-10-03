// A move inside the 21-day new-sod window (lawn report rebuild P35). sod_laid_on sits
// on the customer-level preference row, which survives an address change, a merge
// and a primary-property promotion; the ONE move writer (markSprinklerSettingsMoved)
// clears it in the same transaction. After the move, the next visit at the new address
// gets the normal report and the watering text is NOT suppressed. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { propagateCustomerAddressChange, markSprinklerSettingsMoved } = require('../services/customer-address-fanout');
const { resolveNewSodVerdict } = require('../services/service-report/lawn-new-sod-visit');
const { sendLawnWateringSms } = require('../services/service-report/lawn-watering-sms');
const { etDateString, addETDays } = require('../utils/datetime-et');

// A stateful fake: ONE preference row that the move writer updates and the new-sod
// resolver reads, so the test proves the date really is gone for the next reader.
function makeStore(prefs) {
  const store = { prefs, raws: [], newTx: 0 };
  const db = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereRaw', 'leftJoin', 'join', 'select']) q[m] = () => q;
    q.update = async (patch) => { if (table === 'property_preferences' && store.prefs) { Object.assign(store.prefs, patch); return 1; } return 0; };
    q.insert = (row) => { q.__row = row; return q; };
    q.onConflict = () => q;
    q.merge = async (patch) => { store.prefs = { ...(q.__row || {}), ...patch }; return [1]; };
    q.first = async () => {
      if (table === 'property_preferences') return store.prefs;
      const home = store.home || HOME;
      // The visit is stamped at the customer's CURRENT primary address (the mirror follows a move).
      if (table === 'service_records as sr') return { service_date: store.visitDay, scheduled_service_id: 'ss-1', customer_id: 'cust-1' };
      if (table === 'scheduled_services as ss') {
        return {
          id: 'ss-1', customer_id: 'cust-1', scheduled_date: store.visitDay, property_id: null, source_estimate_id: null,
          service_address_line1: home.address_line1, service_address_line2: null, service_address_city: home.city, service_address_zip: home.zip,
        };
      }
      if (table === 'customers as c') return { ...home, address_line2: null, has_multi_home: false };
      return null;
    };
    // Lead / estimate fan-out reads: nothing to propagate.
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  };
  db.raw = (sql, bindings) => { store.raws.push({ sql, bindings }); return { __raw: sql }; };
  store.db = db;
  return store;
}

const today = () => etDateString(new Date());
const daysAgo = (n) => etDateString(addETDays(new Date(), -n));
const HOME = { id: 'cust-1', address_line1: '100 Example Court', city: 'Bradenton', state: 'FL', zip: '34201' };
const NEW_HOME = { id: 'cust-1', address_line1: '200 Sample Lane', city: 'Bradenton', state: 'FL', zip: '34202' };

describe('a move inside the new-sod window', () => {
  const KEYS = ['GATE_LAWN_WATERING_SMS', 'GATE_LAWN_WATERING_RULE', 'GATE_LAWN_NEW_SOD_MODE'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.GATE_LAWN_WATERING_SMS = 'true';
    process.env.GATE_LAWN_WATERING_RULE = 'true';
    process.env.GATE_LAWN_NEW_SOD_MODE = 'true';
  });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  const textFor = async (store) => {
    const sendCustomerMessage = jest.fn(async () => ({ sent: true }));
    const out = await sendLawnWateringSms({
      record: { id: 'rec-1', structured_notes: {} },
      svc: { id: 'ss-1', customer_id: 'cust-1', cust_phone: '+19415550100' },
      notes: { lawnWateringFreeze: { wateringInstruction: { state: 'hold', lines: ['Skip watering until 8:00 PM tonight.'], completedAt: new Date().toISOString() } } },
      isBackfill: false, deliveryMode: 'auto_send', internalOnly: false, completionTextRequested: true,
    }, {
      db: store.db, sendCustomerMessage, getTemplate: async (k, v) => `Watering: ${v.watering_lines}`, mergeNotes: async () => {}, throwIfDeliveryUnverified: (r) => r,
    });
    return { out, sendCustomerMessage };
  };

  test('before the move: new-sod is active and the watering text is suppressed (the control)', async () => {
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5) });
    store.visitDay = today();
    expect(await resolveNewSodVerdict(store.db, { customerId: 'cust-1', serviceRecordId: 'sr-1' })).toMatchObject({ active: true });
    const { out, sendCustomerMessage } = await textFor(store);
    expect(out).toEqual({ status: 'skip_new_sod' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an address move clears the date in the fan-out, and the next visit gets the normal report and the normal text', async () => {
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5), irrigation_run_minutes: 20 });
    store.visitDay = today();
    const counts = await propagateCustomerAddressChange({ before: HOME, after: NEW_HOME }, store.db);
    expect(counts.property_preferences).toBe(1);
    expect(store.prefs.sod_laid_on).toBeNull();
    store.home = NEW_HOME; // the customer row now mirrors the new primary; the next visit is stamped there
    // Only the move guard changed; the customer's sprinkler settings are untouched.
    expect(store.prefs.irrigation_run_minutes).toBe(20);
    expect(store.prefs.irrigation_home_changed_at).toBeInstanceOf(Date);
    // The same advisory lock the prefs PUT serializes on was taken first (same transaction).
    expect(store.raws[0].sql).toMatch(/pg_advisory_xact_lock/);

    expect(await resolveNewSodVerdict(store.db, { customerId: 'cust-1', serviceRecordId: 'sr-1' })).toMatchObject({ active: false, reason: 'no_date' });
    // Why the clearing matters: the new-home visit would otherwise PASS the property proof
    // (stamp and primary agree on the new address) and inherit the old home's date.
    const kept = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5) });
    kept.visitDay = today();
    kept.home = NEW_HOME;
    expect(await resolveNewSodVerdict(kept.db, { customerId: 'cust-1', serviceRecordId: 'sr-1' })).toMatchObject({ active: true });
    const { out, sendCustomerMessage } = await textFor(store);
    expect(out).toEqual({ status: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('removing the address also clears it', async () => {
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5) });
    await propagateCustomerAddressChange({ before: HOME, after: { ...HOME, address_line1: '' } }, store.db);
    expect(store.prefs.sod_laid_on).toBeNull();
  });

  test('a formatting-only correction of the same home is not a move and keeps the date', async () => {
    const date = daysAgo(5);
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: date });
    await propagateCustomerAddressChange({ before: HOME, after: { ...HOME, address_line1: '100 EXAMPLE CT.' } }, store.db);
    expect(store.prefs.sod_laid_on).toBe(date);
  });

  test('the primary-residence promotion, the different-homes merge and the fan-out all clear it through the one writer', async () => {
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5) });
    await markSprinklerSettingsMoved('cust-1', store.db);
    expect(store.prefs.sod_laid_on).toBeNull();
    // With no preference row yet, the minimal upserted row carries a null date too.
    const empty = makeStore(null);
    await markSprinklerSettingsMoved('cust-1', empty.db);
    expect(empty.prefs.sod_laid_on).toBeNull();
    const fs = require('fs');
    const path = require('path');
    expect(fs.readFileSync(path.join(__dirname, '../services/property-role-proposals.js'), 'utf8')).toMatch(/markSprinklerSettingsMoved\(customerId, trx\)/);
    expect(fs.readFileSync(path.join(__dirname, '../services/customer-dedupe.js'), 'utf8')).toMatch(/fanout\.markSprinklerSettingsMoved\(winnerId, sp\)/);
  });

  test('a date entered AFTER the move (the office sets it for the new home) is honored', async () => {
    const store = makeStore({ customer_id: 'cust-1', sod_laid_on: daysAgo(5) });
    store.visitDay = today();
    await markSprinklerSettingsMoved('cust-1', store.db);
    store.prefs.sod_laid_on = daysAgo(1);
    expect(await resolveNewSodVerdict(store.db, { customerId: 'cust-1', serviceRecordId: 'sr-1' })).toMatchObject({ active: true, laidOn: daysAgo(1) });
  });
});
