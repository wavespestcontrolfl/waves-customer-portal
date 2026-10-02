// Real PostgreSQL transactions (rolled back) behind the admin gate-code routes;
// auth and the bell helpers are stubs. All names, addresses and codes are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => {
  const database = (...args) => mockConnection(...args);
  database.transaction = (...args) => mockConnection.transaction(...args);
  database.raw = (...args) => mockConnection.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
const mockOpenKeys = jest.fn(async () => []);
const mockClose = jest.fn(async () => 0);
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ rang: false })),
  openAdminAlertKeys: (...args) => mockOpenKeys(...args),
  closeAdminAlertKeys: (...args) => mockClose(...args),
}));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-neighborhood-access');
const logger = require('../services/logger');

jest.setTimeout(30000);
postgres('admin neighborhood gate-code routes', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_NEIGHBORHOOD_ACCESS;
  const MONTHS_AGO = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d; };

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const neighborhood = async (name, { active = true, subdivisions = [] } = {}) => {
    const [row] = await trx('neighborhoods')
      .insert({
        name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()} ${randomUUID()}`, source: 'office',
        active, subdivision_names: JSON.stringify(subdivisions),
      })
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
  const property = async (neighborhoodId, { active = true } = {}) => {
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${customerId}@example.invalid` });
    await trx('customer_properties').insert({
      id: randomUUID(), customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '100 Synthetic Way', city: 'Lakewood Ranch', zip: '34202', active, address_key: randomUUID(),
      neighborhood_id: neighborhoodId, neighborhood_source: 'office',
    });
  };
  const list = async (query = '') => {
    const r = await call('GET', `/${query}`);
    return r;
  };
  const byName = (r, name) => r.body.neighborhoods.find((n) => n.name === name);

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
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    // Only this test's rows: park everything already in the scratch database.
    await trx('neighborhoods').update({ active: false });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS;
    else process.env.GATE_NEIGHBORHOOD_ACCESS = OLD_GATE;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
  });

  test('gate off: every route answers 404 enabled:false', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'false';
    const n = await neighborhood('Gate Off Glen');
    const id = await entry(n);
    expect(await call('GET', '/')).toEqual({ status: 404, body: { enabled: false } });
    expect(await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '5555' })).toEqual({ status: 404, body: { enabled: false } });
    expect(await call('PATCH', `/entries/${id}`, { action: 'confirm' })).toEqual({ status: 404, body: { enabled: false } });
  });

  test('list: neighborhoods with a live entry or a linked active property, retired hidden unless asked', async () => {
    const withEntry = await neighborhood('Alder Run');
    await entry(withEntry, { code: '1111' });
    await entry(withEntry, { code: '2222', status: 'retired', gate_label: 'Old gate' });
    const withProperty = await neighborhood('Birch Hollow');
    await property(withProperty);
    await property(withProperty);
    await property(withProperty, { active: false });
    await neighborhood('Cedar Empty'); // nothing linked, nothing filed
    const onlyRetired = await neighborhood('Dogwood Retired');
    await entry(onlyRetired, { status: 'retired' });
    const inactive = await neighborhood('Elm Parked', { active: false });
    await entry(inactive);

    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.neighborhoods.map((n) => n.name)).toEqual(['Alder Run', 'Birch Hollow']);
    expect(r.body.total).toBe(2);
    const alder = byName(r, 'Alder Run');
    expect(alder).toMatchObject({ county: 'Manatee', propertyCount: 0, hasConflict: false });
    expect(alder.entries).toHaveLength(1);
    expect(alder.entries[0]).toMatchObject({ code: '1111', status: 'active', accessType: 'keypad', stale: false, conflict: false });
    expect(byName(r, 'Birch Hollow')).toMatchObject({ propertyCount: 2, entries: [] });

    const withRetired = await list('?include_retired=1');
    expect(byName(withRetired, 'Alder Run').entries.map((e) => e.status).sort()).toEqual(['active', 'retired']);
  });

  test('list: ?q= matches the name and the county subdivision aliases, case-insensitively', async () => {
    const a = await neighborhood('Fern Crossing', { subdivisions: ['FERN XING PH II'] });
    await entry(a);
    const b = await neighborhood('Gum Landing');
    await entry(b, { code: '7777' });
    const c = await neighborhood('Hickory 100% Club');
    await entry(c, { code: '8888' });

    expect((await list('?q=gum')).body.neighborhoods.map((n) => n.name)).toEqual(['Gum Landing']);
    expect((await list('?q=XING')).body.neighborhoods.map((n) => n.name)).toEqual(['Fern Crossing']);
    // LIKE wildcards in the search are literal text.
    expect((await list(`?q=${encodeURIComponent('%')}`)).body.neighborhoods.map((n) => n.name)).toEqual(['Hickory 100% Club']);
    expect((await list('?q=nothing-here')).body).toMatchObject({ neighborhoods: [], total: 0 });
  });

  test('list: needs_confirm filter = needs_confirm entry, two live codes, or a stale active entry', async () => {
    const clean = await neighborhood('Ivy Clean');
    await entry(clean, { code: '1010' });
    const flagged = await neighborhood('Juniper Flagged');
    await entry(flagged, { code: '2020', status: 'needs_confirm', last_confirmed_at: null });
    const conflict = await neighborhood('Kestrel Conflict');
    await entry(conflict, { code: '3030' });
    await entry(conflict, { code: '4040', gate_label: 'Back gate' });
    const stale = await neighborhood('Laurel Stale');
    await entry(stale, { code: '5050', last_confirmed_at: MONTHS_AGO(7) });
    const staleByCreated = await neighborhood('Magnolia Never');
    await entry(staleByCreated, { code: '6060', last_confirmed_at: null, created_at: MONTHS_AGO(8) });
    const fresh = await neighborhood('Nettle Fresh');
    await entry(fresh, { code: '7070', last_confirmed_at: MONTHS_AGO(5) });

    const r = await list('?filter=needs_confirm');
    expect(r.body.neighborhoods.map((n) => n.name)).toEqual(['Juniper Flagged', 'Kestrel Conflict', 'Laurel Stale', 'Magnolia Never']);

    const all = await list();
    expect(byName(all, 'Laurel Stale').entries[0].stale).toBe(true);
    expect(byName(all, 'Magnolia Never').entries[0]).toMatchObject({ stale: true, lastConfirmedAt: null });
    expect(byName(all, 'Nettle Fresh').entries[0].stale).toBe(false);
    expect(byName(all, 'Juniper Flagged').entries[0]).toMatchObject({ status: 'needs_confirm', stale: false });
    const k = byName(all, 'Kestrel Conflict');
    expect(k.hasConflict).toBe(true);
    expect(k.entries.every((e) => e.conflict)).toBe(true);
  });

  test('list: paginates', async () => {
    for (const name of ['Pine A', 'Pine B', 'Pine C']) await entry(await neighborhood(name), { code: String(Math.floor(Math.random() * 9000) + 1000) });
    const first = await list('?limit=2');
    expect(first.body.neighborhoods.map((n) => n.name)).toEqual(['Pine A', 'Pine B']);
    expect(first.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect((await list('?limit=2&offset=2')).body.neighborhoods.map((n) => n.name)).toEqual(['Pine C']);
  });

  test('add: validation', async () => {
    const n = await neighborhood('Quince Court');
    const post = (body) => call('POST', `/${n}/entries`, body);
    expect((await post({ access_type: 'nonsense', code: '1234' })).status).toBe(400);
    expect((await post({ access_type: 'keypad' })).status).toBe(400);
    expect((await post({ access_type: 'keypad', code: 'ask the guard' })).status).toBe(400);
    expect((await post({ access_type: 'keypad', code: '12' })).status).toBe(400);
    expect((await post({ access_type: 'guard' })).status).toBe(400);
    expect((await post({ access_type: 'pass', code: '1234', instructions: 'Visitor pass' })).status).toBe(400);
    expect((await post({ access_type: 'guard', instructions: 'x'.repeat(1001) })).status).toBe(400);
    expect((await post({ access_type: 'guard', instructions: 'Stop at the booth', gate_label: 'g'.repeat(61) })).status).toBe(400);
    expect((await post({ access_type: 'keypad', code: `#${'1'.repeat(120)}` })).status).toBe(400);
    expect((await post({ access_type: 'keypad', code: 1234 })).status).toBe(400);
    expect((await post({ access_type: 'keypad', code: '1234', gate_label: '   ' })).status).toBe(400);
    expect(await trx('neighborhood_access').where({ neighborhood_id: n })).toHaveLength(0);
    expect((await call('POST', `/${randomUUID()}/entries`, { access_type: 'keypad', code: '1234' })).status).toBe(404);
    expect((await call('POST', '/not-a-uuid/entries', { access_type: 'keypad', code: '1234' })).status).toBe(404);
  });

  test('add: stores a keypad code without inner spaces, office source, confirmed now; duplicate live code is 409', async () => {
    const n = await neighborhood('Rowan Bend');
    const ok = await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '# 4821', gate_label: 'North gate' });
    expect(ok.status).toBe(201);
    const row = await trx('neighborhood_access').where({ id: ok.body.id }).first();
    expect(row).toMatchObject({
      neighborhood_id: n, gate_label: 'North gate', access_type: 'keypad', code: '#4821', instructions: null, status: 'active', source: 'office',
    });
    expect(Date.now() - new Date(row.last_confirmed_at).getTime()).toBeLessThan(60000);

    const dupe = await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '#4821' });
    expect(dupe.status).toBe(409);
    expect(await trx('neighborhood_access').where({ neighborhood_id: n })).toHaveLength(1);

    // A retired copy of the code does not block a new live one.
    await call('PATCH', `/entries/${ok.body.id}`, { action: 'retire' });
    expect((await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '#4821' })).status).toBe(201);

    const guard = await call('POST', `/${n}/entries`, { access_type: 'guard', instructions: 'Give your name at the booth' });
    expect(guard.status).toBe(201);
    expect(await trx('neighborhood_access').where({ id: guard.body.id }).first()).toMatchObject({ code: null, instructions: 'Give your name at the booth' });
  });

  test("add: the office's new code is confirmed and the neighborhood's other live codes now need confirming", async () => {
    const n = await neighborhood('Willow Fork');
    const old = await entry(n, { code: '1111' });
    const guard = await entry(n, { access_type: 'guard', code: null, instructions: 'Wave at the booth', gate_label: 'Guard' });
    const added = await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '2222' });
    expect(added.status).toBe(201);
    expect((await trx('neighborhood_access').where({ id: old }).first()).status).toBe('needs_confirm');
    expect((await trx('neighborhood_access').where({ id: guard }).first()).status).toBe('active');
    expect((await trx('neighborhood_access').where({ id: added.body.id }).first()).status).toBe('active');
  });

  test('edit: a new value counts as confirmed; a label-only edit keeps the status and date', async () => {
    const n = await neighborhood('Yaupon Glen');
    const stale = MONTHS_AGO(9);
    const a = await entry(n, { code: '3141', status: 'needs_confirm', last_confirmed_at: stale });
    const relabeled = await call('PATCH', `/entries/${a}`, { gate_label: 'Front gate' });
    expect(relabeled).toMatchObject({ status: 200, body: { status: 'needs_confirm' } });
    const kept = await trx('neighborhood_access').where({ id: a }).first();
    expect(kept.status).toBe('needs_confirm');
    expect(new Date(kept.last_confirmed_at).getTime()).toBe(stale.getTime());
    const recoded = await call('PATCH', `/entries/${a}`, { code: '3142' });
    expect(recoded).toMatchObject({ status: 200, body: { status: 'active' } });
    const row = await trx('neighborhood_access').where({ id: a }).first();
    expect(row.status).toBe('active');
    expect(Date.now() - new Date(row.last_confirmed_at).getTime()).toBeLessThan(60000);
  });

  test('confirm: active again, confirmed now, bell helper called; retire hides it', async () => {
    const n = await neighborhood('Sumac Ridge');
    const id = await entry(n, { code: '9191', status: 'needs_confirm', last_confirmed_at: MONTHS_AGO(9) });
    const confirmed = await call('PATCH', `/entries/${id}`, { action: 'confirm' });
    expect(confirmed).toMatchObject({ status: 200, body: { id, status: 'active' } });
    const row = await trx('neighborhood_access').where({ id }).first();
    expect(row.status).toBe('active');
    expect(Date.now() - new Date(row.last_confirmed_at).getTime()).toBeLessThan(60000);
    expect(mockOpenKeys).toHaveBeenCalled();

    const retired = await call('PATCH', `/entries/${id}`, { action: 'retire' });
    expect(retired).toMatchObject({ status: 200, body: { status: 'retired' } });
    expect((await trx('neighborhood_access').where({ id }).first()).status).toBe('retired');
    expect((await list()).body.neighborhoods).toEqual([]);
    expect(byName(await list('?include_retired=1'), 'Sumac Ridge')).toBeUndefined(); // no linked property: still not listed
    // A retired entry cannot be confirmed or edited back to life.
    expect((await call('PATCH', `/entries/${id}`, { action: 'confirm' })).status).toBe(409);
    expect((await call('PATCH', `/entries/${id}`, { gate_label: 'Renamed' })).status).toBe(409);
    expect((await call('PATCH', `/entries/${id}`, { action: 'explode' })).status).toBe(400);
    expect((await call('PATCH', `/entries/${randomUUID()}`, { action: 'confirm' })).status).toBe(404);
  });

  test('a failing bell close never fails the save', async () => {
    const n = await neighborhood('Tamarind Park');
    const id = await entry(n, { code: '1357', status: 'needs_confirm' });
    mockOpenKeys.mockRejectedValueOnce(Object.assign(new Error('boom 1357'), { code: 'XX000' }));
    expect((await call('PATCH', `/entries/${id}`, { action: 'confirm' })).status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('XX000'));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('1357');
  });

  test('edit: validates the merged entry, rejects a duplicate live code, never logs the value', async () => {
    const n = await neighborhood('Ulmus Pointe');
    const a = await entry(n, { code: '2468' });
    await entry(n, { code: '1357', gate_label: 'Side gate' });

    const renamed = await call('PATCH', `/entries/${a}`, { gate_label: 'Main entrance' });
    expect(renamed.status).toBe(200);
    expect(await trx('neighborhood_access').where({ id: a }).first()).toMatchObject({ gate_label: 'Main entrance', code: '2468' });

    const clash = await call('PATCH', `/entries/${a}`, { code: '1357' });
    expect(clash.status).toBe(409);
    expect((await call('PATCH', `/entries/${a}`, { code: 'not a code' })).status).toBe(400);
    expect((await call('PATCH', `/entries/${a}`, { access_type: 'guard' })).status).toBe(400); // needs instructions

    const toGuard = await call('PATCH', `/entries/${a}`, { access_type: 'guard', instructions: 'Check in at the booth' });
    expect(toGuard.status).toBe(200);
    expect(await trx('neighborhood_access').where({ id: a }).first()).toMatchObject({ access_type: 'guard', code: null, instructions: 'Check in at the booth' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/2468|1357|booth/);
  });
});
