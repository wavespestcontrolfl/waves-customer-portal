/**
 * Cash forecast inputs: validation (pure) and the DB functions against a fake knex.
 * All numbers are synthetic.
 */
const inputs = require('../services/cash-forecast/inputs');

const {
  validateItemInput, validateSettingsInput, listItems, createItem, updateItem,
  deactivateItem, getSettings, saveSettings,
} = inputs;

const ID = '11111111-2222-4333-8444-555555555555';
const ACTOR = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const goodItem = () => ({
  kind: 'insurance', label: '  Truck policy ', amount_cents: 12345, cadence: 'monthly',
  first_date: '2026-12-01', last_date: '2027-06-01', active: true,
});

// A tiny chainable fake. Every call chain is recorded; `respond(call)` supplies the result.
function makeDb(respond) {
  const calls = [];
  const db = (table) => {
    const call = { table, ops: [] };
    calls.push(call);
    const b = {};
    ['where', 'orderBy', 'insert', 'update', 'returning', 'first', 'onConflict', 'merge'].forEach((name) => {
      b[name] = (...args) => { call.ops.push([name, args]); return b; };
    });
    b.then = (res, rej) => Promise.resolve().then(() => respond(call)).then(res, rej);
    return b;
  };
  db.fn = { now: () => 'NOW()' };
  db.calls = calls;
  return db;
}
const op = (call, name) => (call.ops.find((o) => o[0] === name) || [])[1];

describe('validateItemInput', () => {
  test('accepts a good item and trims the label', () => {
    const r = validateItemInput(goodItem());
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      kind: 'insurance', label: 'Truck policy', amount_cents: 12345, cadence: 'monthly',
      first_date: '2026-12-01', last_date: '2027-06-01', active: true,
    });
  });

  test('last_date and active are optional on create; last_date becomes null', () => {
    const { last_date: _lastDate, active: _active, ...rest } = goodItem();
    const r = validateItemInput(rest);
    expect(r.ok).toBe(true);
    expect(r.value.last_date).toBeNull();
    expect('active' in r.value).toBe(false);
  });

  test('ignores unknown keys', () => {
    const r = validateItemInput({ ...goodItem(), id: ID, entered_by: ACTOR, hack: 1 });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value)).not.toEqual(expect.arrayContaining(['id', 'entered_by', 'hack']));
  });

  test.each(['kind', 'label', 'amount_cents', 'cadence', 'first_date'])('create requires %s', (field) => {
    const i = goodItem();
    delete i[field];
    expect(validateItemInput(i).ok).toBe(false);
  });

  test('rejects a bad kind and a bad cadence', () => {
    expect(validateItemInput({ ...goodItem(), kind: 'rent' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), cadence: 'daily' }).ok).toBe(false);
  });

  test('accepts every listed kind and cadence', () => {
    inputs.KINDS.forEach((kind) => expect(validateItemInput({ ...goodItem(), kind }).ok).toBe(true));
    inputs.CADENCES.forEach((cadence) => expect(validateItemInput({ ...goodItem(), cadence }).ok).toBe(true));
  });

  test('label must be 1 to 120 characters after trimming', () => {
    expect(validateItemInput({ ...goodItem(), label: '   ' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), label: '' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), label: 5 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), label: 'x'.repeat(120) }).ok).toBe(true);
    expect(validateItemInput({ ...goodItem(), label: 'x'.repeat(121) }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), label: ` ${'x'.repeat(120)} ` }).ok).toBe(true);
  });

  test('amount_cents must be an integer from 1 to 100000000', () => {
    expect(validateItemInput({ ...goodItem(), amount_cents: 1 }).ok).toBe(true);
    expect(validateItemInput({ ...goodItem(), amount_cents: 100000000 }).ok).toBe(true);
    expect(validateItemInput({ ...goodItem(), amount_cents: 100000001 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: 0 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: -5 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: 12.5 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: NaN }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: Infinity }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: '12.50' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: 'abc' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), amount_cents: null }).ok).toBe(false);
  });

  test('amount_cents given as an integer string is accepted as a number', () => {
    const r = validateItemInput({ ...goodItem(), amount_cents: '2500' });
    expect(r.ok).toBe(true);
    expect(r.value.amount_cents).toBe(2500);
  });

  test('dates must be real YYYY-MM-DD calendar dates', () => {
    expect(validateItemInput({ ...goodItem(), first_date: '2026-02-30', last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), first_date: '2026-13-01', last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), first_date: '12/01/2026', last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), first_date: '2026-1-5', last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), first_date: new Date(), last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), first_date: '2028-02-29', last_date: null }).ok).toBe(true);
    expect(validateItemInput({ ...goodItem(), first_date: '2027-02-29', last_date: null }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), last_date: '2027-06-31' }).ok).toBe(false);
  });

  test('last_date must not be before first_date; equal is fine', () => {
    expect(validateItemInput({ ...goodItem(), last_date: '2026-11-30' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), last_date: '2026-12-01' }).ok).toBe(true);
  });

  test('active must be a boolean', () => {
    expect(validateItemInput({ ...goodItem(), active: 'yes' }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), active: 1 }).ok).toBe(false);
    expect(validateItemInput({ ...goodItem(), active: false }).value.active).toBe(false);
  });

  test('rejects a non-object input', () => {
    expect(validateItemInput(null).ok).toBe(false);
    expect(validateItemInput('x').ok).toBe(false);
    expect(validateItemInput([]).ok).toBe(false);
  });

  describe('partial', () => {
    test('accepts any subset and returns only the given fields', () => {
      expect(validateItemInput({ label: ' New ' }, { partial: true })).toEqual({ ok: true, value: { label: 'New' } });
      expect(validateItemInput({ amount_cents: 99 }, { partial: true }).value).toEqual({ amount_cents: 99 });
      expect(validateItemInput({}, { partial: true })).toEqual({ ok: true, value: {} });
    });

    test('still checks each field given', () => {
      expect(validateItemInput({ kind: 'nope' }, { partial: true }).ok).toBe(false);
      expect(validateItemInput({ amount_cents: 1.5 }, { partial: true }).ok).toBe(false);
      expect(validateItemInput({ first_date: '2026-02-30' }, { partial: true }).ok).toBe(false);
      expect(validateItemInput({ active: 'no' }, { partial: true }).ok).toBe(false);
    });

    test('an explicit null last_date clears it', () => {
      expect(validateItemInput({ last_date: null }, { partial: true }).value).toEqual({ last_date: null });
    });

    test('checks last >= first only against the fields given', () => {
      expect(validateItemInput({ last_date: '2020-01-01' }, { partial: true }).ok).toBe(true);
      expect(validateItemInput({ first_date: '2026-05-02', last_date: '2026-05-01' }, { partial: true }).ok).toBe(false);
      expect(validateItemInput({ first_date: '2026-05-01', last_date: '2026-05-01' }, { partial: true }).ok).toBe(true);
    });
  });
});

describe('validateSettingsInput', () => {
  test('floor_cents may be null or 0..100000000', () => {
    expect(validateSettingsInput({ floor_cents: null })).toEqual({ ok: true, value: { floor_cents: null } });
    expect(validateSettingsInput({ floor_cents: 0 }).ok).toBe(true);
    expect(validateSettingsInput({ floor_cents: 100000000 }).ok).toBe(true);
    expect(validateSettingsInput({ floor_cents: 100000001 }).ok).toBe(false);
    expect(validateSettingsInput({ floor_cents: -1 }).ok).toBe(false);
    expect(validateSettingsInput({ floor_cents: 10.5 }).ok).toBe(false);
    expect(validateSettingsInput({ floor_cents: 'abc' }).ok).toBe(false);
    expect(validateSettingsInput({ floor_cents: NaN }).ok).toBe(false);
  });

  test('last_year_receipts takes YYYY-MM keys and integer cents', () => {
    const r = validateSettingsInput({ last_year_receipts: { '2025-11': 500000, '2025-12': 0 } });
    expect(r).toEqual({ ok: true, value: { last_year_receipts: { '2025-11': 500000, '2025-12': 0 } } });
    expect(validateSettingsInput({ last_year_receipts: {} }).ok).toBe(true);
  });

  test('rejects a bad month key', () => {
    expect(validateSettingsInput({ last_year_receipts: { '2026-13': 1 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { '2026-00': 1 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { '2026-1': 1 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { nov: 1 } }).ok).toBe(false);
  });

  test('rejects a bad value', () => {
    expect(validateSettingsInput({ last_year_receipts: { '2026-01': 1.5 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { '2026-01': -1 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { '2026-01': 10000000001 } }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: { '2026-01': 10000000000 } }).ok).toBe(true);
    expect(validateSettingsInput({ last_year_receipts: { '2026-01': null } }).ok).toBe(false);
  });

  test('allows 48 months and rejects 49', () => {
    const make = (n) => {
      const o = {};
      for (let i = 0; i < n; i += 1) o[`${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`] = 100;
      return o;
    };
    expect(validateSettingsInput({ last_year_receipts: make(48) }).ok).toBe(true);
    expect(validateSettingsInput({ last_year_receipts: make(49) }).ok).toBe(false);
  });

  test('last_year_receipts must be a plain object', () => {
    expect(validateSettingsInput({ last_year_receipts: [] }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: null }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: 'x' }).ok).toBe(false);
    expect(validateSettingsInput({ last_year_receipts: new Date() }).ok).toBe(false);
  });

  test('needs at least one field; ignores unknown keys', () => {
    expect(validateSettingsInput({}).ok).toBe(false);
    expect(validateSettingsInput({ other: 1 }).ok).toBe(false);
    expect(validateSettingsInput(null).ok).toBe(false);
    expect(validateSettingsInput({ floor_cents: 5, other: 1 }).value).toEqual({ floor_cents: 5 });
  });
});

describe('listItems', () => {
  test('active only by default, ordered by first_date then label', async () => {
    const db = makeDb(() => [{ id: 'a', amount_cents: '500' }]);
    const rows = await listItems(db);
    const call = db.calls[0];
    expect(call.table).toBe('cash_forecast_items');
    expect(op(call, 'where')).toEqual([{ active: true }]);
    expect(op(call, 'orderBy')).toEqual([[
      { column: 'first_date', order: 'asc' },
      { column: 'label', order: 'asc' },
    ]]);
    expect(rows).toEqual([{ id: 'a', amount_cents: 500 }]);
  });

  test('includeInactive skips the active filter', async () => {
    const db = makeDb(() => []);
    await listItems(db, { includeInactive: true });
    expect(op(db.calls[0], 'where')).toBeUndefined();
    expect(op(db.calls[0], 'orderBy')).toBeDefined();
  });
});

describe('createItem', () => {
  test('inserts the validated item with entered_by and returns the row', async () => {
    const db = makeDb(() => [{ id: ID, label: 'Truck policy', amount_cents: '12345' }]);
    const row = await createItem(db, goodItem(), ACTOR);
    const call = db.calls[0];
    expect(call.table).toBe('cash_forecast_items');
    expect(op(call, 'insert')[0]).toMatchObject({
      kind: 'insurance', label: 'Truck policy', amount_cents: 12345, entered_by: ACTOR,
    });
    expect(op(call, 'returning')).toEqual(['*']);
    expect(row).toEqual({ id: ID, label: 'Truck policy', amount_cents: 12345 });
  });

  test('writes entered_by null when there is no actor', async () => {
    const db = makeDb(() => [{ id: ID, amount_cents: 1 }]);
    await createItem(db, goodItem());
    expect(op(db.calls[0], 'insert')[0].entered_by).toBeNull();
  });

  test('throws status 400 on invalid input and writes nothing', async () => {
    const db = makeDb(() => []);
    await expect(createItem(db, { ...goodItem(), amount_cents: 1.5 }, ACTOR))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('amount_cents') });
    expect(db.calls).toHaveLength(0);
  });
});

describe('updateItem', () => {
  test('rejects a bad uuid with 400', async () => {
    const db = makeDb(() => []);
    await expect(updateItem(db, 'not-a-uuid', { label: 'x' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(db, 5, { label: 'x' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(db.calls).toHaveLength(0);
  });

  test('rejects an invalid or empty patch with 400', async () => {
    const db = makeDb(() => []);
    await expect(updateItem(db, ID, { kind: 'nope' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(db, ID, {}, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(db.calls).toHaveLength(0);
  });

  test('returns null when no row has the id', async () => {
    const db = makeDb(() => []);
    expect(await updateItem(db, ID, { label: 'x' }, ACTOR)).toBeNull();
  });

  test('updates only the given fields, bumps updated_at, and never writes entered_by', async () => {
    const db = makeDb(() => [{ id: ID, label: 'New', amount_cents: '700' }]);
    const row = await updateItem(db, ID, { label: ' New ', entered_by: 'x', amount_cents: 700 }, ACTOR);
    const call = db.calls[0];
    expect(op(call, 'where')).toEqual([{ id: ID }]);
    expect(op(call, 'update')[0]).toEqual({ label: 'New', amount_cents: 700, updated_at: 'NOW()' });
    expect(row.amount_cents).toBe(700);
  });

  test('a patch moving one date checks the stored other date', async () => {
    const db = makeDb((call) => (op(call, 'first')
      ? { id: ID, first_date: '2026-12-01', last_date: '2027-06-01' }
      : [{ id: ID, amount_cents: '1' }]));
    await expect(updateItem(db, ID, { first_date: '2027-07-01' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(db, ID, { last_date: '2026-11-30' }, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(await updateItem(db, ID, { last_date: '2027-08-01' }, ACTOR)).toMatchObject({ id: ID });
  });

  test('moving first_date while clearing last_date never checks the stored end it clears', async () => {
    const db = makeDb((call) => (op(call, 'first')
      ? { id: ID, first_date: '2026-12-01', last_date: '2027-01-01' }
      : [{ id: ID, amount_cents: '1', first_date: new Date(Date.UTC(2027, 5, 1)), last_date: null }]));
    const row = await updateItem(db, ID, { first_date: '2027-06-01', last_date: null }, ACTOR);
    expect(db.calls.filter((c) => op(c, 'first'))).toHaveLength(0);
    expect(op(db.calls[0], 'update')[0]).toEqual({ first_date: '2027-06-01', last_date: null, updated_at: 'NOW()' });
    // a pg DATE (UTC-midnight Date) comes back as its day string
    expect(row).toMatchObject({ first_date: '2027-06-01', last_date: null });
  });

  test('a one-date patch on a missing row returns null', async () => {
    const db = makeDb(() => undefined);
    expect(await updateItem(db, ID, { first_date: '2027-07-01' }, ACTOR)).toBeNull();
  });
});

describe('deactivateItem', () => {
  test('sets active false and returns the row', async () => {
    const db = makeDb(() => [{ id: ID, active: false, amount_cents: '10' }]);
    const row = await deactivateItem(db, ID, ACTOR);
    expect(op(db.calls[0], 'where')).toEqual([{ id: ID }]);
    expect(op(db.calls[0], 'update')[0]).toEqual({ active: false, updated_at: 'NOW()' });
    expect(row).toEqual({ id: ID, active: false, amount_cents: 10 });
  });

  test('returns null for a missing id and 400 for a bad uuid', async () => {
    expect(await deactivateItem(makeDb(() => []), ID, ACTOR)).toBeNull();
    await expect(deactivateItem(makeDb(() => []), 'nope', ACTOR)).rejects.toMatchObject({ status: 400 });
  });
});

describe('getSettings', () => {
  test('returns defaults when the row does not exist', async () => {
    const db = makeDb(() => undefined);
    expect(await getSettings(db)).toEqual({ floor_cents: null, last_year_receipts: {}, updated_at: null });
    expect(db.calls[0].table).toBe('cash_forecast_settings');
    expect(op(db.calls[0], 'where')).toEqual([{ id: 1 }]);
  });

  test('turns bigint strings into numbers', async () => {
    const when = new Date('2026-11-05T12:00:00Z');
    const db = makeDb(() => ({
      id: 1, floor_cents: '2500000', last_year_receipts: { '2025-11': '400000' }, updated_at: when,
    }));
    expect(await getSettings(db)).toEqual({
      floor_cents: 2500000, last_year_receipts: { '2025-11': 400000 }, updated_at: when,
    });
  });

  test('keeps a NULL floor as null and parses a JSON string map', async () => {
    const db = makeDb(() => ({ floor_cents: null, last_year_receipts: '{"2025-01":"9"}', updated_at: null }));
    expect(await getSettings(db)).toEqual({ floor_cents: null, last_year_receipts: { '2025-01': 9 }, updated_at: null });
  });
});

describe('saveSettings', () => {
  test('upserts id 1 with only the field given, plus the actor', async () => {
    const db = makeDb(() => [{ id: 1, floor_cents: '300000', last_year_receipts: { '2025-11': '1' }, updated_at: null }]);
    const out = await saveSettings(db, { floor_cents: 300000 }, ACTOR);
    const call = db.calls[0];
    expect(call.table).toBe('cash_forecast_settings');
    expect(op(call, 'insert')[0]).toEqual({ id: 1, floor_cents: 300000, updated_by: ACTOR, updated_at: 'NOW()' });
    expect(op(call, 'onConflict')).toEqual(['id']);
    const merged = op(call, 'merge')[0];
    expect(merged).toEqual({ floor_cents: 300000, updated_by: ACTOR, updated_at: 'NOW()' });
    expect('last_year_receipts' in merged).toBe(false); // the other field is left alone
    expect(out).toEqual({ floor_cents: 300000, last_year_receipts: { '2025-11': 1 }, updated_at: null });
  });

  test('a given last_year_receipts replaces the whole map and leaves the floor alone', async () => {
    const db = makeDb(() => [{ floor_cents: '5', last_year_receipts: { '2025-12': '77' }, updated_at: null }]);
    await saveSettings(db, { last_year_receipts: { '2025-12': 77 } }, ACTOR);
    const merged = op(db.calls[0], 'merge')[0];
    expect(JSON.parse(merged.last_year_receipts)).toEqual({ '2025-12': 77 });
    expect('floor_cents' in merged).toBe(false);
  });

  test('can clear the floor with null', async () => {
    const db = makeDb(() => [{ floor_cents: null, last_year_receipts: {}, updated_at: null }]);
    await saveSettings(db, { floor_cents: null }, ACTOR);
    expect(op(db.calls[0], 'merge')[0].floor_cents).toBeNull();
  });

  test('throws status 400 on invalid input and writes nothing', async () => {
    const db = makeDb(() => []);
    await expect(saveSettings(db, {}, ACTOR)).rejects.toMatchObject({ status: 400 });
    await expect(saveSettings(db, { floor_cents: -1 }, ACTOR)).rejects.toMatchObject({ status: 400 });
    expect(db.calls).toHaveLength(0);
  });
});
