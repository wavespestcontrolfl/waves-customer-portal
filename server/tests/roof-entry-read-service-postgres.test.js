const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. The roof read service runs for real (claim insert with ON CONFLICT DO
// NOTHING, the millisecond claim renewal and its conditional completion, the copy index, the stale takeover) against the
// four migrations in a unique schema dropped after the suite. Only the county image fetch, the model call and the price
// table are faked: no network and no model call.
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

const m1 = require('../models/migrations/20261119140000_roof_entry_reads');
const m2 = require('../models/migrations/20261119150000_roof_entry_read_claims');
const m3 = require('../models/migrations/20261119160000_roof_entry_read_ctx_key');
const m4 = require('../models/migrations/20261119170000_roof_entry_read_rollback_guard');

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('roof entry read service on PostgreSQL', () => {
  let database;
  const schema = `roof_svc_${randomUUID().replaceAll('-', '')}`;
  const realFetch = global.fetch;

  const flags = () => Object.fromEntries(svc.ENTRY_TYPES.map((t) => [t, { likely: 'unsure', pins: [] }]));
  const PRIMARY_MODEL = require('../config/models').TEXT_POLICIES.estimateVision.primary.model;
  const goodAnswer = () => ({ ok: true, provider: 'gemini', model: PRIMARY_MODEL, json: { flags: flags(), tier: 'med' }, usage: { input_tokens: 1500, output_tokens: 600 } });
  const home = (extra = {}) => ({ lat: 27.46, lng: -82.57, county: 'Manatee', ...extra });
  const rows = () => database('roof_entry_reads').orderBy('created_at');
  const insertId = (table, extra = {}) => database(table).insert(extra).returning('id').then(([r]) => r.id);

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 5 } });
    mockDb = database;
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid)', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz, phone text)', [schema]);
    for (const m of [m1, m2, m3, m4]) await m.up(database);
  });
  beforeEach(() => {
    mockDispatch.mockReset().mockImplementation(async () => goodAnswer());
    global.fetch = jest.fn(async () => ({ ok: true, headers: { get: (n) => (n === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Uint8Array.from([0xff, 0xd8, 1]); }()) }));
  });
  afterEach(async () => {
    global.fetch = realFetch;
    await database('roof_entry_reads').del();
    await database('estimates').del();
    await database('customers').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  test('a paid read: the claim, the millisecond renewal and the conditional write all land, the row ends done at the priced cost', async () => {
    const out = await svc.runRoofEntryRead(home());
    expect(out).toEqual(expect.objectContaining({ status: 'ok', cached: false }));
    const all = await rows();
    expect(all).toHaveLength(1);
    // 'done' proves the completion's `claimed_at = <renewed value>` matched the stored (ms-truncated) timestamp.
    expect(all[0]).toEqual(expect.objectContaining({ status: 'done', ai_tier: 'med', model: PRIMARY_MODEL, county: 'manatee', image_source: 'manatee_2025_rgb', context_key: 'c:', source_id: null }));
    expect(all[0].cost_estimate_cents).toBe(1);
    expect(all[0].claimed_at).toBeInstanceOf(Date);
    expect(all[0].ai_flags).toEqual(flags());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a second request reuses it; another estimate gets one cost-0 copy that names its source', async () => {
    const cust = await insertId('customers');
    const est = await insertId('estimates', { customer_id: cust });
    const first = await svc.runRoofEntryRead(home());
    expect((await svc.runRoofEntryRead(home())).read.id).toBe(first.read.id);
    const copy = await svc.runRoofEntryRead(home({ estimateId: est, customerId: cust }));
    expect(copy.cached).toBe(true);
    expect(copy.read.id).not.toBe(first.read.id);
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === copy.read.id)).toEqual(expect.objectContaining({ source_id: first.read.id, cost_estimate_cents: 0, status: 'done', context_key: `e:${est}` }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('two requests copying the same read for the same new context write one row and return the same id', async () => {
    const est = await insertId('estimates');
    await svc.runRoofEntryRead(home());
    const [a, b] = await Promise.all([svc.runRoofEntryRead(home({ estimateId: est })), svc.runRoofEntryRead(home({ estimateId: est.toUpperCase() }))]);
    expect(a.read.id).toBe(b.read.id);
    expect(await rows()).toHaveLength(2);
  });

  test('two different contexts on a fresh crop make one paid call between them', async () => {
    const [e1, e2] = [await insertId('estimates'), await insertId('estimates')];
    const results = await Promise.all([svc.runRoofEntryRead(home({ estimateId: e1 })), svc.runRoofEntryRead(home({ estimateId: e2 }))]);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'ok' && !r.cached)).toHaveLength(1);
    expect((await rows()).filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  test('a pending claim blocks a second request (in_progress, no fetch, no call); a stale one is taken over', async () => {
    await database('roof_entry_reads').insert({
      lookup_key: svc.lookupKey({ source: 'manatee_2025_rgb', lat: 27.46, lng: -82.57 }), county: 'manatee', image_source: 'manatee_2025_rgb', image_year: 2025,
      model: 'm', ai_flags: '{}', ai_tier: 'pending', status: 'pending', context_key: 'c:', cost_estimate_cents: 5, claimed_at: database.fn.now(),
    });
    const blocked = await svc.runRoofEntryRead(home());
    expect(blocked).toEqual({ status: 'in_progress', cached: false, read: null });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();

    await database('roof_entry_reads').update({ claimed_at: database.raw("now() - interval '6 minutes'") });
    const taken = await svc.runRoofEntryRead(home());
    expect(taken.status).toBe('ok');
    const all = await rows();
    expect(all.map((r) => r.status).sort()).toEqual(['done', 'failed']);
    expect(all.find((r) => r.status === 'failed')).toEqual(expect.objectContaining({ ai_tier: 'unknown', cost_estimate_cents: 5 }));
  });

  test('a worker that lost its claim during the call overwrites nothing', async () => {
    mockDispatch.mockImplementation(async () => {
      await database('roof_entry_reads').update({ status: 'failed' });
      return goodAnswer();
    });
    expect(await svc.runRoofEntryRead(home())).toEqual({ status: 'in_progress', cached: false, read: null });
    const [row] = await rows();
    expect(row).toEqual(expect.objectContaining({ status: 'failed', ai_tier: 'pending', cost_estimate_cents: 5 }));
    expect(row.ai_flags).toEqual({});
  });

  test('a call that failed with unknown spend keeps a failed row at the ceiling; a confirmed-unbilled failure deletes the claim', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [{ provider: 'gemini', model: 'm', reason: 'gemini_timeout' }] });
    expect((await svc.runRoofEntryRead(home())).status).toBe('model_failed');
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', cost_estimate_cents: 5 })]);
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [{ provider: 'gemini', model: 'm', reason: 'gemini_401' }] });
    expect((await svc.runRoofEntryRead(home())).status).toBe('model_failed');
    expect((await rows()).filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
  });

  test('an estimate that belongs to another customer is refused (400 code) before any row, fetch or call; same customer in any case passes', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates', { customer_id: custA });
    await expect(svc.runRoofEntryRead(home({ estimateId: est, customerId: custB }))).rejects.toMatchObject({ code: 'reference_mismatch' });
    expect(await rows()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    await expect(svc.runRoofEntryRead(home({ estimateId: est.toUpperCase(), customerId: custA.toUpperCase() }))).resolves.toEqual(expect.objectContaining({ status: 'ok' }));
    // An estimate with no customer, or a customer alone, is never a mismatch.
    const lead = await insertId('estimates');
    await expect(svc.runRoofEntryRead(home({ estimateId: lead, customerId: custB }))).resolves.toBeTruthy();
  });

  test('a customer merge repoints customer_id on the rows and the estimates: the copy is still found, its technician count kept', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates', { customer_id: custA });
    await svc.runRoofEntryRead(home());
    const estimateCopy = await svc.runRoofEntryRead(home({ estimateId: est, customerId: custA }));
    const customerCopy = await svc.runRoofEntryRead(home({ customerId: custA }));
    await database('roof_entry_reads').where({ id: estimateCopy.read.id }).update({ tech_final_count: 4 });
    // What customer-dedupe does: repoint the customer, never the context key.
    await database('roof_entry_reads').where({ customer_id: custA }).update({ customer_id: custB });
    await database('estimates').where({ customer_id: custA }).update({ customer_id: custB });
    const before = (await rows()).length;
    const again = await svc.runRoofEntryRead(home({ estimateId: est, customerId: custB }));
    expect(again.read).toEqual(expect.objectContaining({ id: estimateCopy.read.id, tech_final_count: 4, customer_id: custB }));
    const customerAgain = await svc.runRoofEntryRead(home({ customerId: custB }));
    expect(customerAgain.read.id).toBe(customerCopy.read.id);
    expect(await rows()).toHaveLength(before);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('a merge that lands between the first check and the insert is caught by the lock on the estimate: reference_mismatch, no row', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates', { customer_id: custA });
    // The merge transaction holds the estimate row, uncommitted. The request's first check (no lock) still sees custA, then
    // its claim insert (FOR SHARE on that row) waits for the merge to commit and rechecks.
    const merge = await database.transaction();
    await merge('estimates').where({ id: est }).update({ customer_id: custB });
    const pending = svc.runRoofEntryRead(home({ estimateId: est, customerId: custA }));
    const settled = pending.then((v) => ({ v }), (e) => ({ e }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await merge.commit();
    const outcome = await settled;
    expect(outcome.e).toMatchObject({ code: 'reference_mismatch' });
    expect(await rows()).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('two customers on one estimate with no customer get two rows with their own technician counts', async () => {
    const [custA, custB] = [await insertId('customers'), await insertId('customers')];
    const est = await insertId('estimates');
    const a = await svc.runRoofEntryRead(home({ estimateId: est, customerId: custA }));
    const b = await svc.runRoofEntryRead(home({ estimateId: est, customerId: custB }));
    expect(a.read.id).not.toBe(b.read.id);
    await database('roof_entry_reads').where({ id: a.read.id }).update({ tech_final_count: 3 });
    await database('roof_entry_reads').where({ id: b.read.id }).update({ tech_final_count: 5 });
    expect((await svc.runRoofEntryRead(home({ estimateId: est, customerId: custA }))).read).toEqual(expect.objectContaining({ id: a.read.id, tech_final_count: 3 }));
    expect((await svc.runRoofEntryRead(home({ estimateId: est, customerId: custB }))).read).toEqual(expect.objectContaining({ id: b.read.id, tech_final_count: 5 }));
    expect((await rows()).map((r) => r.context_key).sort()).toEqual([`e:${est}|c:${custA}`, `e:${est}|c:${custB}`].sort());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('saveTechCount merges flags in one statement and writes the count only when sent', async () => {
    const first = await svc.runRoofEntryRead(home());
    const id = first.read.id;
    expect((await svc.saveTechCount(id, { flags: { gable_vents: 'unsure' } })).tech_final_flags).toEqual({ gable_vents: 'unsure' });
    await svc.saveTechCount(id, { count: 3 });
    const merged = await svc.saveTechCount(id, { flags: { chimney_or_flue: 'yes', gable_vents: 'no' } });
    expect(merged).toEqual(expect.objectContaining({ tech_final_count: 3, tech_final_flags: { gable_vents: 'no', chimney_or_flue: 'yes' } }));
    const [stored] = await rows();
    expect(stored.tech_final_flags).toEqual({ gable_vents: 'no', chimney_or_flue: 'yes' });
  });

  test('a customer retired by a duplicate merge (deleted_at + merged- phone) is refused; an archived one is not', async () => {
    const [survivor, loser, archived] = [await insertId('customers'), await insertId('customers'), await insertId('customers')];
    await svc.runRoofEntryRead(home());
    const copy = await svc.runRoofEntryRead(home({ customerId: loser }));
    // What customer-dedupe does to the loser: soft-delete with the merge sentinel phone, repoint the rows.
    await database('customers').where({ id: loser }).update({ deleted_at: database.fn.now(), phone: 'merged-9415550100' });
    await database('roof_entry_reads').where({ customer_id: loser }).update({ customer_id: survivor });
    await database('customers').where({ id: archived }).update({ deleted_at: database.fn.now(), phone: '+19415550101' });
    const before = (await rows()).length;
    await expect(svc.runRoofEntryRead(home({ customerId: loser }))).rejects.toMatchObject({ code: 'unknown_reference' });
    expect(await rows()).toHaveLength(before);
    expect((await svc.runRoofEntryRead(home({ customerId: survivor }))).read.id).toBe(copy.read.id);
    await expect(svc.runRoofEntryRead(home({ customerId: archived }))).resolves.toEqual(expect.objectContaining({ status: 'ok' }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('deleting an estimate keeps the paid row and its copies (foreign key set null)', async () => {
    const est = await insertId('estimates');
    const paid = await svc.runRoofEntryRead(home({ estimateId: est }));
    await database('estimates').where({ id: est }).del();
    const [row] = await rows();
    expect(row).toEqual(expect.objectContaining({ id: paid.read.id, estimate_id: null, status: 'done', context_key: `e:${est}` }));
  });
});
