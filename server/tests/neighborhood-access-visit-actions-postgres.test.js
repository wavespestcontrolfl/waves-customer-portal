// A technician's add / mark-wrong on a visit's neighborhood gate codes
// (owner ruling 2026-10-03), over real PostgreSQL transactions (rolled back).
// Auth is a stub that sets the role under test. All names, addresses and codes
// are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
let mockStaff;
jest.mock('../models/db', () => {
  const database = (...args) => mockConnection(...args);
  database.transaction = (...args) => mockConnection.transaction(...args);
  database.raw = (...args) => mockConnection.raw(...args);
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.techRole = mockStaff.role;
    req.technicianId = mockStaff.id;
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const mockEmit = jest.fn(async () => null);
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: (...args) => mockEmit(...args) }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const router = require('../routes/admin-neighborhood-access');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { compilePropertyAlerts } = require('../services/nextstop-alerts');
const { neighborhoodGateEntriesForVisits, gateActionVisitIds } = require('../services/neighborhood-access');

jest.setTimeout(30000);
postgres('neighborhood gate codes from a visit', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  let tech;
  let otherTech;
  let admin;
  const OLD = { access: process.env.GATE_NEIGHBORHOOD_ACCESS, actions: process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS };
  const TODAY = etDateString(new Date());

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const staff = async (name, role) => {
    const [row] = await trx('technicians')
      .insert({ name, role, employment_status: 'active', auth_token_version: 1 }).returning('id');
    return { id: row.id, role };
  };
  const neighborhood = async (name, { active = true } = {}) => {
    const [row] = await trx('neighborhoods').insert({
      name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()} ${randomUUID()}`, source: 'office',
      active, subdivision_names: JSON.stringify([]),
    }).returning('id');
    return row.id;
  };
  const entry = async (neighborhoodId, fields = {}) => {
    const [row] = await trx('neighborhood_access').insert({
      neighborhood_id: neighborhoodId, gate_label: 'Main gate', access_type: 'keypad', code: '1234',
      status: 'active', source: 'office', last_confirmed_at: new Date(), ...fields,
    }).returning('id');
    return row.id;
  };
  // A visit at a property in the neighborhood (null = a property with none).
  const visit = async (neighborhoodId, fields = {}) => {
    const customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${customerId}@example.invalid`,
    });
    const propertyId = randomUUID();
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: '100 Synthetic Way', city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      neighborhood_id: neighborhoodId, neighborhood_source: neighborhoodId ? 'office' : null,
    });
    const [row] = await trx('scheduled_services').insert({
      customer_id: customerId, property_id: propertyId, technician_id: tech.id, scheduled_date: TODAY,
      service_type: 'Quarterly Pest Control', status: 'confirmed', ...fields,
    }).returning('*');
    return row;
  };
  const rows = (neighborhoodId) => trx('neighborhood_access').where({ neighborhood_id: neighborhoodId }).orderBy('code');

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
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS = 'true';
    mockEmit.mockClear();
    trx = await database.transaction();
    mockConnection = trx;
    tech = await staff('Synthetic Tech', 'technician');
    otherTech = await staff('Synthetic Other', 'technician');
    admin = await staff('Synthetic Admin', 'admin');
    mockStaff = tech;
  });
  afterEach(async () => {
    await trx.rollback();
    for (const [key, value] of [['GATE_NEIGHBORHOOD_ACCESS', OLD.access], ['GATE_NEIGHBORHOOD_TECH_ACTIONS', OLD.actions]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await database.destroy();
  });

  test('either gate off: both routes answer 404 enabled:false and write nothing', async () => {
    const n = await neighborhood('Gate Off Glen');
    const id = await entry(n);
    const v = await visit(n);
    for (const key of ['GATE_NEIGHBORHOOD_TECH_ACTIONS', 'GATE_NEIGHBORHOOD_ACCESS']) {
      process.env[key] = 'false';
      expect(await call('POST', `/visits/${v.id}/entries`, { code: '5555' })).toEqual({ status: 404, body: { enabled: false } });
      expect(await call('POST', `/visits/${v.id}/entries/${id}/wrong`)).toEqual({ status: 404, body: { enabled: false } });
      process.env[key] = 'true';
    }
    expect((await rows(n)).map((r) => [r.code, r.status])).toEqual([['1234', 'active']]);
  });

  test('a technician adds a code on their own visit: live at once, recorded as theirs, the other code needs confirming', async () => {
    const n = await neighborhood('Alder Run');
    await entry(n, { code: '1111' });
    const v = await visit(n);
    const r = await call('POST', `/visits/${v.id}/entries`, { code: ' #2222 ' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('active');
    const all = await rows(n);
    const old = all.find((e) => e.code === '1111');
    const added = all.find((e) => e.code === '#2222');
    expect(old.status).toBe('needs_confirm');
    expect(added).toMatchObject({
      id: r.body.id, code: '#2222', status: 'active', source: 'tech', source_technician_id: tech.id,
      access_type: 'keypad', gate_label: 'Main gate',
    });
    expect(added.last_confirmed_at).not.toBeNull();
    // Other open route screens are told to refetch; a refused write tells no one.
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ jobId: v.id, actorId: tech.id });
    await call('POST', `/visits/${v.id}/entries`, { code: 'nope' });
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  test('adding a code already on file confirms it and clears a wrong report, keeping who filed it', async () => {
    const n = await neighborhood('Birch Hollow');
    const reported = await entry(n, {
      code: '3333', status: 'needs_confirm', source: 'customer_sms', flagged_wrong_at: new Date(), flagged_wrong_by: otherTech.id,
    });
    await entry(n, { code: '4444' });
    const v = await visit(n);
    const r = await call('POST', `/visits/${v.id}/entries`, { code: '3333' });
    expect(r).toEqual({ status: 200, body: { id: reported, status: 'active' } });
    const [kept, other] = await rows(n);
    expect(kept).toMatchObject({ code: '3333', status: 'active', source: 'customer_sms', flagged_wrong_at: null, flagged_wrong_by: null, source_technician_id: null });
    expect([other.code, other.status]).toEqual(['4444', 'needs_confirm']);
  });

  test('marking a code wrong flags it for the office and never retires it', async () => {
    const n = await neighborhood('Cedar Point');
    const id = await entry(n, { code: '5555' });
    const v = await visit(n);
    expect(await call('POST', `/visits/${v.id}/entries/${id}/wrong`)).toEqual({ status: 200, body: { id, status: 'needs_confirm' } });
    const [row] = await rows(n);
    expect(row).toMatchObject({ code: '5555', status: 'needs_confirm', flagged_wrong_by: tech.id });
    expect(row.flagged_wrong_at).not.toBeNull();
    // The schedule still shows it, tagged confirm on site and already reported.
    const feed = await neighborhoodGateEntriesForVisits(trx, [v]);
    const alerts = compilePropertyAlerts({ neighborhoodGate: feed.get(v.id), neighborhoodActions: true });
    expect(alerts).toEqual([{
      type: 'gate', text: 'Gate: 5555 (neighborhood, confirm on site)', neighborhoodEntryId: id, reportedWrong: true,
    }]);
    // The office sees who reported it, and confirming clears the report.
    mockStaff = admin;
    const listed = (await call('GET', '/')).body.neighborhoods.find((h) => h.id === n).entries[0];
    expect(listed).toMatchObject({ markedWrongBy: 'Synthetic Tech', addedBy: null });
    expect(listed.markedWrongAt).toEqual(expect.any(String));
    expect((await call('PATCH', `/entries/${id}`, { action: 'confirm' })).status).toBe(200);
    expect((await rows(n))[0]).toMatchObject({ status: 'active', flagged_wrong_at: null, flagged_wrong_by: null });
    // Retiring a reported code answers the report too.
    mockStaff = tech;
    expect((await call('POST', `/visits/${v.id}/entries/${id}/wrong`)).status).toBe(200);
    mockStaff = admin;
    expect((await call('PATCH', `/entries/${id}`, { action: 'retire' })).status).toBe(200);
    expect((await rows(n))[0]).toMatchObject({ status: 'retired', flagged_wrong_at: null, flagged_wrong_by: null });
  });

  test('a technician reaches only a visit on their own route', async () => {
    const n = await neighborhood('Dune Walk');
    const id = await entry(n, { code: '6666' });
    const notMine = await visit(n, { technician_id: otherTech.id });
    const cancelled = await visit(n, { status: 'cancelled' });
    const old = await visit(n, { scheduled_date: etDateString(addETDays(new Date(), -30)), status: 'completed' });
    for (const v of [notMine, cancelled, old]) {
      expect(await call('POST', `/visits/${v.id}/entries`, { code: '7777' })).toEqual({ status: 404, body: { error: 'Visit not found' } });
      expect(await call('POST', `/visits/${v.id}/entries/${id}/wrong`)).toEqual({ status: 404, body: { error: 'Visit not found' } });
    }
    expect((await rows(n)).map((r) => [r.code, r.status])).toEqual([['6666', 'active']]);
    // A visit completed this week is still theirs to report from.
    const done = await visit(n, { status: 'completed' });
    expect((await call('POST', `/visits/${done.id}/entries/${id}/wrong`)).status).toBe(200);
    // An admin is not tied to the assignment.
    mockStaff = admin;
    const r = await call('POST', `/visits/${notMine.id}/entries`, { code: '7777' });
    expect(r.status).toBe(201);
    expect(await trx('neighborhood_access').where({ id: r.body.id }).first('source', 'source_technician_id'))
      .toEqual({ source: 'office', source_technician_id: admin.id });
  });

  test('the rest of the directory stays admin-only for a technician', async () => {
    const n = await neighborhood('Elm Court');
    const id = await entry(n);
    expect((await call('GET', '/')).status).toBe(403);
    expect((await call('POST', `/${n}/entries`, { access_type: 'keypad', code: '8888' })).status).toBe(403);
    expect((await call('PATCH', `/entries/${id}`, { action: 'retire' })).status).toBe(403);
    expect((await rows(n)).map((r) => [r.code, r.status])).toEqual([['1234', 'active']]);
  });

  test('only a code of the visit\'s own neighborhood can be marked wrong, and never an instruction or a retired one', async () => {
    const mine = await neighborhood('Fern Ridge');
    const elsewhere = await neighborhood('Glade Park');
    const foreign = await entry(elsewhere, { code: '9999' });
    const retired = await entry(mine, { code: '1010', status: 'retired' });
    const guard = await entry(mine, { access_type: 'guard', code: null, instructions: 'Give the stop name at the gatehouse' });
    const v = await visit(mine);
    for (const id of [foreign, retired, guard, randomUUID(), 'not-an-id']) {
      expect(await call('POST', `/visits/${v.id}/entries/${id}/wrong`)).toEqual({ status: 404, body: { error: 'Gate code not found' } });
    }
    expect(await trx('neighborhood_access').whereIn('id', [foreign, retired, guard]).whereNotNull('flagged_wrong_at')).toEqual([]);
  });

  test('a stop with no neighborhood, or a switched-off one, takes no code; the feed offers none', async () => {
    const off = await neighborhood('Heron Bay', { active: false });
    const offEntry = await entry(off, { code: '2020' });
    const none = await visit(null);
    const inOff = await visit(off);
    const on = await visit(await neighborhood('Ibis Landing'));
    for (const v of [none, inOff]) {
      const r = await call('POST', `/visits/${v.id}/entries`, { code: '3030' });
      expect([r.status, r.body.code]).toEqual([409, 'no_neighborhood']);
    }
    expect((await call('POST', `/visits/${inOff.id}/entries/${offEntry}/wrong`)).status).toBe(409);
    expect(await trx('neighborhood_access').where({ code: '3030' })).toEqual([]);
    expect([...(await gateActionVisitIds(trx, [none, inOff, on]))]).toEqual([on.id]);
  });

  test('a code must be a keypad code', async () => {
    const n = await neighborhood('Jasmine Key');
    const v = await visit(n);
    for (const body of [{}, { code: '' }, { code: 'call the guard' }, { code: '12' }, { code: 123456 }, { code: '4040', gateLabel: 7 }]) {
      expect((await call('POST', `/visits/${v.id}/entries`, body)).status).toBe(400);
    }
    expect(await rows(n)).toEqual([]);
    const r = await call('POST', `/visits/${v.id}/entries`, { code: '4040', gateLabel: ' Back gate ' });
    expect(r.status).toBe(201);
    expect((await rows(n))[0]).toMatchObject({ code: '4040', gate_label: 'Back gate' });
  });
});
