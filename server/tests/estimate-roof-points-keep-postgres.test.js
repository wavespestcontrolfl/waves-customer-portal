const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. Owner follow-up "keep" (2026-11-21): the roof points copy a lead
// already holds stays on the estimate for the FIRST customer the estimate takes (migration 20261121210000,
// estimate-roof-points.js copyForHolder and keepOrFreeze). The roof read service and the roof points service run for
// real, on the real migrations in a unique schema dropped after the suite. Only the county image fetch, the model call
// and the price table are faked: no network and no model call.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockDb;
jest.mock('../models/db', () => new Proxy(function database() {}, {
  apply: (_t, _this, args) => mockDb(...args),
  get: (_t, prop) => mockDb[prop],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));
jest.mock('../services/llm-cost', () => {
  const actual = jest.requireActual('../services/llm-cost');
  return {
    ...actual,
    loadPrices: async () => ({ map: new Map([[actual.normalizeModelId(require('../config/models').TEXT_POLICIES.estimateVision.primary.model), { input: 0.3, output: 2.5, cacheRead: null, cacheWrite: null, reasoning: null, tiers: [] }]]) }),
  };
});

const svc = require('../services/roof-entry-read');
const { freezeRoofPointsForEstimate, roofPointsDocBlock } = require('../services/estimate-roof-points');

const MIGRATIONS = [
  '20261119140000_roof_entry_reads', '20261119150000_roof_entry_read_claims', '20261119160000_roof_entry_read_ctx_key',
  '20261119170000_roof_entry_read_rollback_guard', '20261120200000_roof_entry_read_tech_pins',
  '20261120220000_roof_entry_read_points_address', '20261120230000_roof_entry_read_hide_per_estimate',
  '20261120210000_estimate_roof_points', '20261121010000_estimate_roof_points_customer',
].map((name) => require(`../models/migrations/${name}`));
const keep = require('../models/migrations/20261121210000_roof_points_first_customer');

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('the roof points copy a lead holds and the estimate\'s first customer, on PostgreSQL', () => {
  let database;
  const schema = `roof_keep_${randomUUID().replaceAll('-', '')}`;
  const realFetch = global.fetch;

  const flags = () => Object.fromEntries(svc.ENTRY_TYPES.map((t) => [t, { likely: 'unsure', pins: [] }]));
  const PRIMARY_MODEL = require('../config/models').TEXT_POLICIES.estimateVision.primary.model;
  const goodAnswer = () => ({ ok: true, provider: 'gemini', model: PRIMARY_MODEL, json: { flags: flags(), tier: 'med' }, usage: { input_tokens: 1500, output_tokens: 600 } });
  const insertId = (table, extra = {}) => database(table).insert(extra).returning('id').then(([r]) => r.id);

  const ADDRESS = '12 Synthetic Way, Bradenton, FL 34203';
  const [T1, T2, T3] = ['2026-11-21T15:00:00.000Z', '2026-11-21T16:00:00.000Z', '2026-11-21T17:00:00.000Z'];
  const pin = (note) => [{ x: 0.2, y: 0.3, type: 'gable_vents', note }];
  const label = (note) => `${svc.PIN_LABELS.gable_vents}, ${note}`;
  const list = (pins) => ({ pins, crop: { lat: 27.46, lng: -82.57 }, address: ADDRESS, expectedPins: null, expectedHolder: null });
  // A roof read for an estimate with no customer, with the points a technician saved for that lead.
  const leadRead = async (est, note = 'front left') => {
    const read = (await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee', estimateId: est })).read;
    await svc.saveTechCount(read.id, list(pin(note)));
    return read;
  };
  const readCustomer = async (read) => (await database('roof_entry_reads').where({ id: read.id }).first('customer_id')).customer_id;
  const copyOf = (est) => database('estimate_roof_points').where({ estimate_id: est }).first('customer_id', 'read_id', 'lead_changes', 'delivered_at');
  // One statement, run once: a Knex builder runs again each time it is awaited, a promise does not.
  const link = async (est, customerId) => database('estimates').where({ id: est }).update({ customer_id: customerId });
  // The estimate as a route loads it: its whole row, with the time of its latest handoff (null: never sent).
  const row = async (est, lastDeliveredAt) => ({ ...(await database('estimates').where({ id: est }).first()), estimate_data: { deliveryState: { lastDeliveredAt } } });
  // A send handed off at `at`: the route gives the freeze the row it read before that handoff.
  const send = async (est, lastDeliveredAt, at) => freezeRoofPointsForEstimate(await row(est, lastDeliveredAt), { deliveredAt: at, knex: database });
  // What the customer page shows after the handoff at `lastDeliveredAt`.
  const shown = async (est, lastDeliveredAt) => (await roofPointsDocBlock(await row(est, lastDeliveredAt), { knex: database })).roofPoints?.pins.map((p) => p.label);

  beforeAll(async () => {
    // This suite creates a schema, runs migrations in it and drops it: only on the isolated CI database or on this
    // worktree's private QA database (the same check as estimate-roof-points-migration-postgres.test.js).
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its settings, so the pool gets the parts
    // checked above, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = knex({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      searchPath: [schema],
      pool: { min: 0, max: 5 },
    });
    mockDb = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid, address text)', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz, phone text)', [schema]);
    for (const m of [...MIGRATIONS, keep]) await m.up(database);
  });
  beforeEach(() => {
    mockDispatch.mockReset().mockImplementation(async () => goodAnswer());
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: (n) => (n === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Uint8Array.from([0xff, 0xd8, 1]); }()) }));
  });
  afterEach(async () => {
    global.fetch = realFetch;
    if (!database) return;
    await database('estimate_roof_points').del();
    await database('roof_entry_reads').del();
    await database('estimates').del();
    await database('customers').del();
  });
  afterAll(async () => {
    // A refused target opened no pool and made no schema.
    if (!database) return;
    await database.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await database.destroy();
  });

  test('the copy a lead holds stays for the first customer, a send to that customer keeps it, and a points save with a send makes it theirs', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    expect(await send(est, null, T1)).toBe('frozen');
    expect(await copyOf(est)).toMatchObject({ customer_id: null, read_id: read.id, lead_changes: 0 });
    expect(await shown(est, T1)).toEqual([label('front left')]);
    // The lead becomes customer A: no points save, no send. The page keeps the copy, and no row changes its owner.
    await link(est, custA);
    expect(await shown(est, T1)).toEqual([label('front left')]);
    expect([(await copyOf(est)).customer_id, await readCustomer(read)]).toEqual([null, null]);
    // A send to A while no points are saved for A keeps that copy, under the new handoff's time.
    expect(await send(est, T1, T2)).toBe('kept');
    expect(await copyOf(est)).toMatchObject({ customer_id: null, read_id: read.id, lead_changes: 0, delivered_at: new Date(T2) });
    expect(await shown(est, T2)).toEqual([label('front left')]);
    // Staff press Save points for A with an edit: the read is A's now. The page shows the lead's copy until the next send.
    await svc.saveTechCount(read.id, { ...list(pin('rear, edited')), expectedPins: pin('front left'), expectedHolder: custA });
    expect(await readCustomer(read)).toBe(custA);
    expect(await shown(est, T2)).toEqual([label('front left')]);
    // That send freezes A's own copy: it names A and carries no count.
    expect(await send(est, T2, T3)).toBe('frozen');
    expect(await copyOf(est)).toMatchObject({ customer_id: custA, read_id: read.id, lead_changes: null });
    expect(await shown(est, T3)).toEqual([label('rear, edited')]);
  });

  test('after the first customer no one sees the lead\'s copy: not a second customer, not the estimate with no customer again, not the customer after that', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates', { address: ADDRESS });
    await leadRead(est);
    await send(est, null, T1);
    await link(est, custA);
    expect(await shown(est, T1)).toEqual([label('front left')]);
    // A to B (another customer, or a duplicate merge of A into B).
    await link(est, custB);
    expect(await shown(est, T1)).toBeUndefined();
    // B to none: the estimate has no customer again, and the copy was sent to the lead before A.
    await link(est, null);
    expect(await shown(est, T1)).toBeUndefined();
    // None to A again: A is not the first customer since that send any more.
    await link(est, custA);
    expect(await shown(est, T1)).toBeUndefined();
    // Nothing was renamed or deleted on the way, and a send to this customer clears the copy as before.
    expect(await copyOf(est)).toMatchObject({ customer_id: null, lead_changes: 0 });
    expect(await send(est, T1, T2)).toBe('cleared');
    expect(await copyOf(est)).toBeUndefined();
  });

  test('a lead\'s copy from before the count is the lead\'s alone: the first customer does not see it and their send clears it', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    await leadRead(est);
    await send(est, null, T1);
    await database('estimate_roof_points').where({ estimate_id: est }).update({ lead_changes: null });
    expect(await shown(est, T1)).toEqual([label('front left')]);
    await link(est, custA);
    expect(await shown(est, T1)).toBeUndefined();
    expect(await send(est, T1, T2)).toBe('cleared');
  });

  test('a send that read the estimate before the first link and froze after it writes the count it read: the first customer sees it, a later holder never', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates', { address: ADDRESS });
    await leadRead(est);
    // The row a send to the lead read: no customer, count 0.
    const sendRow = await row(est, null);
    await link(est, custA);
    expect(await freezeRoofPointsForEstimate(sendRow, { deliveredAt: T1, knex: database })).toBe('frozen');
    expect(await copyOf(est)).toMatchObject({ customer_id: null, lead_changes: 0 });
    expect(await shown(est, T1)).toEqual([label('front left')]);
    // The same late freeze once the estimate lost that customer: the copy is the first lead's, and the estimate's
    // count moved on. Not shown with no customer, and not to the customer after that.
    await link(est, null);
    expect(await freezeRoofPointsForEstimate(sendRow, { deliveredAt: T2, knex: database })).toBe('frozen');
    expect(await copyOf(est)).toMatchObject({ customer_id: null, lead_changes: 0 });
    expect(await shown(est, T2)).toBeUndefined();
    await link(est, custB);
    expect(await shown(est, T2)).toBeUndefined();
  });

  test('a send to the first customer clears the lead\'s copy when the lead\'s points were cleared since that send', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    await send(est, null, T1);
    // Staff clear the lead's points and do not send again. The copy stays until the next send, as it does for a lead.
    await svc.saveTechCount(read.id, { pins: null, expectedPins: pin('front left') });
    await link(est, custA);
    expect(await shown(est, T1)).toEqual([label('front left')]);
    expect(await send(est, T1, T2)).toBe('cleared');
    expect([await copyOf(est), await shown(est, T2)]).toEqual([undefined, undefined]);
  });

  test('hidden points are hidden for the first customer at once, and their send clears the copy', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    await send(est, null, T1);
    await link(est, custA);
    await svc.saveTechCount(read.id, { hideOnEstimate: true });
    expect(await shown(est, T1)).toBeUndefined();
    expect(await send(est, T1, T2)).toBe('cleared');
  });

  test('a send to the first customer does not keep a copy that an earlier send could not replace', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    await leadRead(est);
    await send(est, null, T1);
    await link(est, custA);
    // A handoff at T2 whose freeze failed left the T1 copy behind: the page does not show it, and the send at T3
    // does not bring it back.
    expect(await shown(est, T2)).toBeUndefined();
    expect(await send(est, T2, T3)).toBe('cleared');
  });

  test('a points save for the first customer in flight during their send is waited for, and the send then freezes that customer\'s points', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    await send(est, null, T1);
    await link(est, custA);
    const stateAfter = (promise, ms) => Promise.race([promise.then(() => 'done'), new Promise((resolve) => { setTimeout(() => resolve('waiting'), ms); })]);
    // The save's own order (saveUnderEstimate): the estimate row first, then the read. It names the customer on the
    // lead's read, so until it commits the read is the lead's, and after it the customer's.
    const save = await database.transaction();
    let sending;
    try {
      await save('estimates').where({ id: est }).forUpdate().first('id');
      await save('roof_entry_reads').where({ id: read.id }).update({ customer_id: custA });
      sending = send(est, T1, T2);
      expect(await stateAfter(sending, 300)).toBe('waiting');
      await save.commit();
    } finally {
      if (!save.isCompleted()) await save.rollback();
    }
    expect(await sending).toBe('frozen');
    expect(await copyOf(est)).toMatchObject({ customer_id: custA, read_id: read.id, lead_changes: null, delivered_at: new Date(T2) });
    expect(await shown(est, T2)).toEqual([label('front left')]);
  });

  test('a send to the first customer that a later handoff overtook leaves the newer copy: it does not take its time back and does not delete it', async () => {
    const custA = await insertId('customers');
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    await send(est, null, T1);
    await link(est, custA);
    // The handoff at T3 kept the copy. A send handed off at T2 reaches its freeze after that.
    expect(await send(est, T1, T3)).toBe('kept');
    expect(await send(est, T1, T2)).toBe('skipped');
    expect(await copyOf(est)).toMatchObject({ read_id: read.id, lead_changes: 0, delivered_at: new Date(T3) });
    expect(await shown(est, T3)).toEqual([label('front left')]);
    // The same late send once staff hid the points: it has nothing to keep, and it does not delete the T3 copy.
    await svc.saveTechCount(read.id, { hideOnEstimate: true });
    expect(await send(est, T1, T2)).toBe('cleared');
    expect(await copyOf(est)).toMatchObject({ read_id: read.id, delivered_at: new Date(T3) });
    // A send at that handoff's time or later does clear it.
    expect(await send(est, T3, T3)).toBe('cleared');
    expect(await copyOf(est)).toBeUndefined();
  });

  test('any send that a later handoff overtook leaves the newer copy: it does not replace it and does not delete it', async () => {
    const est = await insertId('estimates', { address: ADDRESS });
    const read = await leadRead(est);
    // The handoff at T3 froze the lead's points. A send handed off at T2 reaches its freeze after that.
    expect(await send(est, null, T3)).toBe('frozen');
    await svc.saveTechCount(read.id, { ...list(pin('rear, edited')), expectedPins: pin('front left') });
    expect(await send(est, null, T2)).toBe('skipped');
    expect(await copyOf(est)).toMatchObject({ read_id: read.id, delivered_at: new Date(T3) });
    expect(await shown(est, T3)).toEqual([label('front left')]);
    // The same late send once the points are cleared: it does not delete the T3 copy.
    await svc.saveTechCount(read.id, { pins: null, expectedPins: pin('rear, edited') });
    expect(await send(est, null, T2)).toBe('cleared');
    expect(await copyOf(est)).toMatchObject({ read_id: read.id, delivered_at: new Date(T3) });
    // A send at that handoff's time or later does: a clear deletes the copy, and new points replace it.
    expect(await send(est, T3, T3)).toBe('cleared');
    expect(await copyOf(est)).toBeUndefined();
    await svc.saveTechCount(read.id, list(pin('side')));
    expect(await send(est, T3, T3)).toBe('frozen');
    await svc.saveTechCount(read.id, { ...list(pin('side, again')), expectedPins: pin('side') });
    expect(await send(est, T3, T3)).toBe('frozen');
    expect(await shown(est, T3)).toEqual([label('side, again')]);
  });

  test('the count of customer changes goes up by one with each change of the estimate\'s customer, and an UPDATE cannot write it', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const [est, other] = [await insertId('estimates'), await insertId('estimates')];
    const count = async (id = est) => (await database('estimates').where({ id }).first('customer_changes')).customer_changes;
    expect(await count()).toBe(0);
    // To a customer, the same customer written again, to another customer, to none, none written again.
    const steps = [[custA, 1], [custA, 1], [custB, 2], [null, 3], [null, 3]];
    for (const [customer, expected] of steps) {
      await link(est, customer);
      expect(await count()).toBe(expected);
    }
    // A write to another column is not a change of customer.
    await database('estimates').where({ id: est }).update({ address: ADDRESS });
    expect(await count()).toBe(3);
    // The count is the trigger's alone: a value an UPDATE sends is dropped, with and without a change of customer.
    await database('estimates').where({ id: est }).update({ customer_changes: 0 });
    expect(await count()).toBe(3);
    await database('estimates').where({ id: est }).update({ customer_id: custA, customer_changes: 0 });
    expect(await count()).toBe(4);
    // One statement, two estimates: only the row whose customer changes counts it.
    await database('estimates').whereIn('id', [est, other]).update({ customer_id: custA });
    expect([await count(), await count(other)]).toEqual([4, 1]);
  });

  test('the migration: up twice is a no-op, down drops the trigger, its function and the two columns, and up brings them back', async () => {
    const columns = async () => (await database.raw("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND (table_name, column_name) IN (('estimates', 'customer_changes'), ('estimate_roof_points', 'lead_changes'))")).rows[0].n;
    const triggers = async () => (await database.raw("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = to_regclass(current_schema() || '.estimates') ORDER BY tgname")).rows.map((r) => r.tgname);
    const functions = async () => (await database.raw("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = current_schema() AND p.proname = 'estimates_count_customer_change'")).rows[0].n;
    const state = async () => [await columns(), await triggers(), await functions()];
    const UP = [2, ['estimates_count_customer_change'], 1];
    await keep.up(database);
    expect(await state()).toEqual(UP);
    try {
      await keep.down(database);
      await keep.down(database);
      expect(await state()).toEqual([0, [], 0]);
      // Without the count an estimate still takes a customer.
      const est = await insertId('estimates');
      await link(est, await insertId('customers'));
    } finally {
      await keep.up(database);
      await keep.up(database);
    }
    expect(await state()).toEqual(UP);
    // The columns come back empty: a count of 0 on every estimate, no count on a copy.
    const est = await insertId('estimates');
    expect((await database('estimates').where({ id: est }).first('customer_changes')).customer_changes).toBe(0);
  });
});
