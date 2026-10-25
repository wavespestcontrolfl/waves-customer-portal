// Real PostgreSQL transactions (rolled back) behind the neighborhood merge
// routes (GATE_NEIGHBORHOOD_MERGE, owner ruling 2026-10-25); auth is a stub.
// All names, addresses and codes are synthetic.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => {
  const database = (...args) => mockConnection(...args);
  database.transaction = (...args) => mockConnection.transaction(...args);
  database.raw = (...args) => mockConnection.raw(...args);
  database.fn = { now: () => mockConnection.fn.now() };
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockActor = '00000000-0000-4000-8000-0000000000a1';
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = mockActor; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => null) }));
const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-neighborhood-access');
const { upsertNeighborhood, lockCommunity } = require('../services/neighborhood-access');
const logger = require('../services/logger');

jest.setTimeout(30000);
postgres('neighborhood merge routes', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const GATES = ['GATE_NEIGHBORHOOD_ACCESS', 'GATE_NEIGHBORHOOD_MERGE'];
  const OLD = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
  const tag = randomUUID().slice(0, 8);

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  // Synthetic community names, unique per run so the county-wide community
  // match never meets another suite's rows.
  const hoodName = (base) => `${base} ${tag}`;
  const neighborhood = async (base, { county = 'Manatee', active = true } = {}) => {
    const name = hoodName(base);
    const [row] = await trx('neighborhoods')
      .insert({ name, county, match_key: `${county.toLowerCase()}|${name.toLowerCase()}`, source: 'county', active, subdivision_names: JSON.stringify([]) })
      .returning('id');
    return row.id;
  };
  const entry = async (neighborhoodId, fields = {}) => {
    const [row] = await trx('neighborhood_access').insert({
      neighborhood_id: neighborhoodId, gate_label: 'Main gate', access_type: 'keypad', code: '1234',
      status: 'active', source: 'office', last_confirmed_at: new Date(), ...fields,
    }).returning('id');
    return row.id;
  };
  const home = async (neighborhoodId, { active = true } = {}) => {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${customerId}@example.invalid`,
    });
    const propertyId = randomUUID();
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '100 Synthetic Way', city: 'Lakewood Ranch', zip: '34202', active, address_key: randomUUID(),
      neighborhood_id: neighborhoodId, neighborhood_source: neighborhoodId ? 'county' : null,
    });
    return { customerId, propertyId };
  };
  const filing = async (customerId, neighborhoodId) => {
    await trx('neighborhood_access_filings').insert({ customer_id: customerId, value_hash: 'f'.repeat(64), neighborhood_id: neighborhoodId, outcome: 'filed' });
  };
  const hoodRow = (id) => trx('neighborhoods').where({ id }).first('active', 'merged_into_id');
  const entryRow = (id) => trx('neighborhood_access').where({ id }).first('neighborhood_id', 'gate_label', 'status');
  const homeHood = async (propertyId) => (await trx('customer_properties').where({ id: propertyId }).first('neighborhood_id')).neighborhood_id;
  const merge = (sourceId, into, extra = {}) => call('POST', `/${sourceId}/merge`, { into, ...extra });

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    for (const g of GATES) process.env[g] = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    // Only this test's rows: park everything already in the scratch database.
    await trx('neighborhoods').update({ active: false });
  });
  afterEach(async () => {
    await trx.rollback();
    for (const g of GATES) {
      if (OLD[g] === undefined) delete process.env[g];
      else process.env[g] = OLD[g];
    }
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
  });

  test('gate off: both merge routes answer 404 enabled:false and the list carries no merge data', async () => {
    delete process.env.GATE_NEIGHBORHOOD_MERGE;
    const a = await neighborhood('Gateoff A');
    const b = await neighborhood('Gateoff B');
    await home(a);
    expect(await merge(a, b)).toEqual({ status: 404, body: { enabled: false } });
    expect((await call('POST', `/merges/${randomUUID()}/undo`)).status).toBe(404);
    const list = await call('GET', '/');
    expect(list.body.mergeEnabled).toBe(false);
    expect(list.body.neighborhoods.every((n) => !('mergedIn' in n))).toBe(true);
    expect(await hoodRow(a)).toEqual({ active: true, merged_into_id: null });
  });

  test('merge: homes, entries and ledger rows move; the source becomes an inactive pointer; the list and search follow', async () => {
    const source = await neighborhood('Country Lane Lwr');
    const target = await neighborhood('Country Lane at Sample Ranch');
    const live = await home(source);
    const gone = await home(source, { active: false });
    const stays = await home(target);
    await filing(live.customerId, source);
    const sourceCode = await entry(source, { code: '4455', status: 'needs_confirm' });
    const sourceOld = await entry(source, { code: '9999', status: 'retired' });
    const targetCode = await entry(target, { code: '1111' });

    const r = await merge(source, target);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ homes: 1, entries: 1, duplicatesRetired: 0, relabeled: 1, dryRun: false });
    expect(r.body.mergeId).toEqual(expect.any(String));

    expect(await homeHood(live.propertyId)).toBe(target);
    expect(await homeHood(gone.propertyId)).toBe(target);
    expect(await homeHood(stays.propertyId)).toBe(target);
    // The target keeps a live code of its own: the moved one names where it came from; status unchanged.
    expect(await entryRow(sourceCode)).toEqual({ neighborhood_id: target, gate_label: `Main gate (${hoodName('Country Lane Lwr')})`, status: 'needs_confirm' });
    expect(await entryRow(sourceOld)).toEqual({ neighborhood_id: target, gate_label: 'Main gate', status: 'retired' });
    expect(await entryRow(targetCode)).toEqual({ neighborhood_id: target, gate_label: 'Main gate', status: 'active' });
    expect((await trx('neighborhood_access_filings').where({ customer_id: live.customerId }).first('neighborhood_id')).neighborhood_id).toBe(target);
    expect(await hoodRow(source)).toEqual({ active: false, merged_into_id: target });
    const row = await trx('neighborhood_merges').where({ id: r.body.mergeId }).first();
    expect(row).toMatchObject({ source_id: source, target_id: target, merged_by: mockActor, undone_at: null });
    expect(row.journal.properties.map((h) => h.id).sort()).toEqual([live.propertyId, gone.propertyId].sort());

    const list = await call('GET', '/');
    expect(list.body.mergeEnabled).toBe(true);
    expect(list.body.neighborhoods.map((n) => n.id)).toEqual([target]);
    expect(list.body.neighborhoods[0]).toMatchObject({ propertyCount: 2, mergedIn: [{ mergeId: r.body.mergeId, name: hoodName('Country Lane Lwr') }] });
    const found = await call('GET', `/?q=${encodeURIComponent('lane lwr')}`);
    expect(found.body.neighborhoods.map((n) => n.id)).toEqual([target]);
    // Nothing logged carries a code.
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/4455|1111|9999/);
  });

  test('merge: a code both hold is kept once, the more recently confirmed copy; an empty target relabels nothing', async () => {
    const source = await neighborhood('Dup Source');
    const target = await neighborhood('Dup Target');
    const newer = await entry(source, { code: '#2468', last_confirmed_at: new Date() });
    const older = await entry(target, { code: '#2468', last_confirmed_at: new Date('2026-01-01T00:00:00Z') });
    const r = await merge(source, target);
    expect(r.body).toMatchObject({ entries: 1, duplicatesRetired: 1, relabeled: 0 });
    expect(await entryRow(newer)).toEqual({ neighborhood_id: target, gate_label: 'Main gate', status: 'active' });
    expect(await entryRow(older)).toEqual({ neighborhood_id: target, gate_label: 'Main gate', status: 'retired' });

    const source2 = await neighborhood('Dup Source Two');
    const kept = await entry(target, { code: '7777', last_confirmed_at: new Date() });
    const stale = await entry(source2, { code: '7777', last_confirmed_at: new Date('2026-01-01T00:00:00Z') });
    const r2 = await merge(source2, target);
    expect(r2.body).toMatchObject({ entries: 0, duplicatesRetired: 1 });
    expect((await entryRow(kept)).status).toBe('active');
    expect(await entryRow(stale)).toMatchObject({ neighborhood_id: target, status: 'retired' });
  });

  test('merge: the copy with the gate pin is the one kept, even when the other was confirmed later', async () => {
    const source = await neighborhood('Pin Source');
    const target = await neighborhood('Pin Target');
    const fresh = await entry(source, { code: '5656', last_confirmed_at: new Date() });
    const pinnedOld = await entry(target, { code: '5656', last_confirmed_at: new Date('2026-01-01T00:00:00Z'), gate_lat: 27.4, gate_lng: -82.4 });
    expect((await merge(source, target)).body).toMatchObject({ duplicatesRetired: 1 });
    expect((await entryRow(pinnedOld)).status).toBe('active');
    expect((await entryRow(fresh)).status).toBe('retired');

    const source2 = await neighborhood('Pin Source Two');
    const target2 = await neighborhood('Pin Target Two');
    const pinnedMoved = await entry(source2, { code: '5757', last_confirmed_at: new Date('2026-01-01T00:00:00Z'), gate_lat: 27.5, gate_lng: -82.5 });
    const freshTarget = await entry(target2, { code: '5757', last_confirmed_at: new Date() });
    await merge(source2, target2);
    expect(await entryRow(pinnedMoved)).toMatchObject({ neighborhood_id: target2, status: 'active' });
    expect((await entryRow(freshTarget)).status).toBe('retired');
  });

  test('dry run: the same counts, and nothing is written', async () => {
    const source = await neighborhood('Dry Source');
    const target = await neighborhood('Dry Target');
    const h = await home(source);
    await entry(source, { code: '5151' });
    const r = await merge(source, target, { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ homes: 1, entries: 1, duplicatesRetired: 0, dryRun: true, mergeId: null });
    expect(await homeHood(h.propertyId)).toBe(source);
    expect(await hoodRow(source)).toEqual({ active: true, merged_into_id: null });
    expect(await trx('neighborhood_merges').where({ source_id: source }).first('id')).toBeUndefined();
  });

  test('refusals: bad ids, the same entry, another county, a merged or switched-off entry, two gate pins', async () => {
    const a = await neighborhood('Refuse A');
    const b = await neighborhood('Refuse B');
    expect((await call('POST', '/not-a-uuid/merge', { into: b })).status).toBe(404);
    expect((await merge(a, 'nope')).status).toBe(400);
    expect((await merge(randomUUID(), b)).body.code).toBe('not_found');
    expect((await merge(a, randomUUID())).body.code).toBe('not_found');
    expect((await merge(a, a)).body.code).toBe('same');
    const sarasota = await neighborhood('Refuse S', { county: 'Sarasota' });
    expect((await merge(a, sarasota)).body.code).toBe('county');
    const off = await neighborhood('Refuse Off', { active: false });
    expect((await merge(a, off)).body.code).toBe('not_live');
    await entry(a, { code: '1212', gate_lat: 27.4, gate_lng: -82.4 });
    await entry(b, { code: '3434', gate_lat: 27.5, gate_lng: -82.5 });
    const pins = await merge(a, b);
    expect(pins).toMatchObject({ status: 409, body: { code: 'pins' } });
    const c = await neighborhood('Refuse C');
    expect((await merge(c, b)).status).toBe(201);
    expect((await merge(c, a)).body.code).toBe('not_live');
    expect((await merge(a, c)).body.code).toBe('not_live');
  });

  test('a new home with the merged-away name lands on the target: the county upsert and the office create follow the pointer', async () => {
    const source = await neighborhood('Rose Hill');
    const target = await neighborhood('Rose Hill Estates');
    await merge(source, target);
    const raw = `${hoodName('Rose Hill').toUpperCase()} PH 2 PB 12/34`;
    const up = await upsertNeighborhood(trx, { county: 'Manatee', subdivision: raw });
    expect(up.id).toBe(target);
    const names = (await trx('neighborhoods').where({ id: target }).first('subdivision_names')).subdivision_names;
    expect(names).toContain(raw);

    const h = await home(null);
    const link = await call('PUT', `/properties/${h.propertyId}/neighborhood`, { create: { name: hoodName('Rose Hill'), county: 'Manatee' } });
    expect(link.status).toBe(200);
    expect(link.body.neighborhood.id).toBe(target);
  });

  test('undo: puts back what nobody changed since, restores labels and a retired copy, and switches the source on', async () => {
    const source = await neighborhood('Undo Source');
    const target = await neighborhood('Undo Target');
    const h = await home(source);
    const picked = await home(source);
    await filing(h.customerId, source);
    await filing(picked.customerId, source);
    const moved = await entry(source, { code: '6060' });
    const edited = await entry(source, { code: '7070', gate_label: 'Side gate' });
    const dupSource = await entry(source, { code: '8080', last_confirmed_at: new Date('2026-01-01T00:00:00Z') });
    const dupTarget = await entry(target, { code: '8080', last_confirmed_at: new Date() });
    const targetOwn = await entry(target, { code: '9090' });
    const r = await merge(source, target);
    expect(r.body).toMatchObject({ entries: 2, duplicatesRetired: 1, relabeled: 2 });
    // The office edits one moved entry after the merge: it stays on the target.
    await trx('neighborhood_access').where({ id: edited }).update({ updated_at: trx.raw("now() + interval '1 minute'") });
    // …and picks the kept entry for one moved home by hand: that home stays too.
    expect((await call('PUT', `/properties/${picked.propertyId}/neighborhood`, { neighborhoodId: target })).status).toBe(200);
    await trx('customer_properties').where({ id: picked.propertyId }).update({ neighborhood_checked_at: trx.raw("now() + interval '1 minute'") });

    const u = await call('POST', `/merges/${r.body.mergeId}/undo`);
    expect(u).toEqual({ status: 200, body: { homes: 1, homesKept: 1, entries: 2, entriesKept: 1 } });
    expect(await homeHood(picked.propertyId)).toBe(target);
    // Its filing stays with it, so the sweep sees the home and its filing together.
    expect((await trx('neighborhood_access_filings').where({ customer_id: picked.customerId }).first('neighborhood_id')).neighborhood_id).toBe(target);
    expect(await entryRow(moved)).toEqual({ neighborhood_id: source, gate_label: 'Main gate', status: 'active' });
    expect(await entryRow(dupSource)).toEqual({ neighborhood_id: source, gate_label: 'Main gate', status: 'active' });
    expect(await entryRow(edited)).toMatchObject({ neighborhood_id: target, gate_label: `Side gate (${hoodName('Undo Source')})` });
    expect(await entryRow(dupTarget)).toMatchObject({ neighborhood_id: target, status: 'active' });
    expect(await entryRow(targetOwn)).toMatchObject({ neighborhood_id: target, status: 'active' });
    expect(await homeHood(h.propertyId)).toBe(source);
    expect((await trx('neighborhood_access_filings').where({ customer_id: h.customerId }).first('neighborhood_id')).neighborhood_id).toBe(source);
    expect(await hoodRow(source)).toEqual({ active: true, merged_into_id: null });
    expect(await trx('neighborhood_merges').where({ id: r.body.mergeId }).first('undone_by')).toEqual({ undone_by: mockActor });

    expect(await call('POST', `/merges/${r.body.mergeId}/undo`)).toMatchObject({ status: 409, body: { code: 'undone' } });
    expect((await call('POST', `/merges/${randomUUID()}/undo`)).status).toBe(404);
    // The source can be merged again after its undo.
    expect((await merge(source, target)).status).toBe(201);
  });

  test('undo: the target copy a merge retired comes back when the moved twin is gone again', async () => {
    const source = await neighborhood('Twin Source');
    const target = await neighborhood('Twin Target');
    const newer = await entry(source, { code: '3131', last_confirmed_at: new Date() });
    const older = await entry(target, { code: '3131', last_confirmed_at: new Date('2026-01-01T00:00:00Z') });
    const r = await merge(source, target);
    expect((await entryRow(older)).status).toBe('retired');
    await call('POST', `/merges/${r.body.mergeId}/undo`);
    expect(await entryRow(newer)).toMatchObject({ neighborhood_id: source, status: 'active' });
    expect(await entryRow(older)).toMatchObject({ neighborhood_id: target, status: 'active' });
  });

  test('a chain: A into B, then B into C; undo of A into B waits for the later one, and the pointer chain reaches C', async () => {
    const a = await neighborhood('Chain A');
    const b = await neighborhood('Chain B');
    const c = await neighborhood('Chain C');
    const ha = await home(a);
    const ea = await entry(a, { code: '4141' });
    await entry(b, { code: '4242' });
    await entry(c, { code: '4343' });
    const before = (await trx('neighborhood_access').where({ id: ea }).first(trx.raw('updated_at::text AS t'))).t;
    const first = await merge(a, b);
    // The test runs in one transaction, so now() never moves: date the first
    // merge (and the rows it stamped) an hour back, as if made earlier.
    await trx('neighborhood_merges').where({ id: first.body.mergeId }).update({ merged_at: trx.raw("merged_at - interval '1 hour'") });
    await trx('neighborhood_access').where({ id: ea }).update({ updated_at: trx.raw("updated_at - interval '1 hour'") });
    const second = await merge(b, c);
    expect(await entryRow(ea)).toMatchObject({ neighborhood_id: c, gate_label: `Main gate (${hoodName('Chain A')}) (${hoodName('Chain B')})` });
    // A's old name finds C down the chain, with no county upsert in between.
    const found = await call('GET', `/?q=${encodeURIComponent(hoodName('Chain A'))}`);
    expect(found.body.neighborhoods.map((n) => n.id)).toEqual([c]);
    expect(await homeHood(ha.propertyId)).toBe(c);
    const up = await upsertNeighborhood(trx, { county: 'Manatee', subdivision: hoodName('Chain A').toUpperCase() });
    expect(up.id).toBe(c);

    const blocked = await call('POST', `/merges/${first.body.mergeId}/undo`);
    expect(blocked).toEqual({ status: 409, body: { error: `Undo the later merge into ${hoodName('Chain C')} first`, code: 'later' } });
    expect((await call('POST', `/merges/${second.body.mergeId}/undo`)).status).toBe(200);
    expect(await homeHood(ha.propertyId)).toBe(b);
    expect(await entryRow(ea)).toMatchObject({ neighborhood_id: b, gate_label: `Main gate (${hoodName('Chain A')})` });
    const back = await call('POST', `/merges/${first.body.mergeId}/undo`);
    expect(back.body).toMatchObject({ homes: 1, homesKept: 0, entries: 1, entriesKept: 0 });
    expect(await homeHood(ha.propertyId)).toBe(a);
    expect(await entryRow(ea)).toEqual({ neighborhood_id: a, gate_label: 'Main gate', status: 'active' });
    // Every undo wrote back the stamp the row had before: A's code reads untouched.
    expect((await trx('neighborhood_access').where({ id: ea }).first(trx.raw('updated_at::text AS t'))).t).toBe(before);
  });
});

// Committed rows on two connections: the merge-of-the-target race that one
// rolled-back transaction cannot show. The rows are removed afterwards.
postgres('lockCommunity while the entry it points to is being merged', () => {
  let database;
  const raceTag = randomUUID().slice(0, 8);
  const names = { a: `Race A ${raceTag}`, b: `Race B ${raceTag}`, c: `Race C ${raceTag}` };
  const ids = {};

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 3 } });
    const add = async (key, fields = {}) => {
      const [row] = await database('neighborhoods').insert({
        name: names[key], county: 'Manatee', match_key: `manatee|${names[key].toLowerCase()}`, source: 'county',
        subdivision_names: JSON.stringify([]), ...fields,
      }).returning('id');
      ids[key] = row.id;
    };
    await add('c');
    await add('b');
    await add('a', { active: false, merged_into_id: ids.b });
  });
  afterAll(async () => {
    await database('neighborhoods').whereIn('id', Object.values(ids)).update({ merged_into_id: null });
    await database('neighborhoods').whereIn('id', Object.values(ids)).del();
    await database.destroy();
  });

  test('B is merged into C while a new home with A\'s name resolves: the answer is C, never the inactive B', async () => {
    const merging = await database.transaction();
    await merging('neighborhoods').where({ id: ids.b }).forUpdate().first('id');
    await merging('neighborhoods').where({ id: ids.b }).update({ active: false, merged_into_id: ids.c });
    const upsert = await database.transaction();
    const pending = lockCommunity(upsert, 'Manatee', names.a);
    // Give the resolver time to reach B and wait on the merge's row lock.
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    await merging.commit();
    const row = await pending;
    await upsert.rollback();
    expect(row).toMatchObject({ id: ids.c, active: true, merged_into_id: null });
  });
});
