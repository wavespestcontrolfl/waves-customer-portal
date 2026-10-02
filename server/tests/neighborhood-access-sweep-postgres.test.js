// Real PostgreSQL transactions (rolled back); the county lookup and the bell
// helpers are stubs. All names, addresses and codes are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
const mockRaise = jest.fn(async () => ({ id: 'n1', rang: true }));
const mockOpenKeys = jest.fn(async () => []);
const mockClose = jest.fn(async () => 0);
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: (...args) => mockRaise(...args),
  openAdminAlertKeys: (...args) => mockOpenKeys(...args),
  closeAdminAlertKeys: (...args) => mockClose(...args),
}));
const { randomUUID } = require('node:crypto');
const { sweepSavedGateCodes } = require('../services/neighborhood-access');

jest.setTimeout(30000);
postgres('neighborhood gate-code filing sweep', () => {
  let database;
  let trx;
  const OLD_GATE = process.env.GATE_NEIGHBORHOOD_ACCESS;

  const neighborhood = async (name) => {
    const [row] = await trx('neighborhoods')
      .insert({ name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()} ${randomUUID()}`, source: 'county' })
      .returning('id');
    return row.id;
  };
  const customerWithCode = async (code, { neighborhoodId = null, properties = 1, street = '100 Synthetic Way' } = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${id}@example.invalid` });
    for (let i = 0; i < properties; i += 1) {
      await trx('customer_properties').insert({
        id: randomUUID(), customer_id: id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: i === 0,
        address_line1: i === 0 ? street : `${200 + i} Other Way`, city: 'Lakewood Ranch', zip: '34202',
        latitude: 27.4, longitude: -82.35, active: true, address_key: randomUUID(),
        neighborhood_id: neighborhoodId, neighborhood_source: neighborhoodId ? 'county' : null,
      });
    }
    await trx('property_preferences').insert({ customer_id: id, neighborhood_gate_code: code });
    return id;
  };
  const accessRows = (neighborhoodId) => trx('neighborhood_access').where({ neighborhood_id: neighborhoodId })
    .orderBy(['access_type', 'code']).select('access_type', 'code', 'instructions', 'status', 'source');

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    // Only this test's rows: everything already coded is behind the watermark.
    await trx('system_settings').insert({ key: 'neighborhood_access.sweep_watermark', value: '2999-01-01 00:00:00+00' })
      .onConflict('key').merge();
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS;
    else process.env.GATE_NEIGHBORHOOD_ACCESS = OLD_GATE;
  });
  afterAll(() => database.destroy());

  // Rows written in this transaction share its start time, so a watermark at
  // that instant picks them (>=) and nothing older.
  const openWindow = async () => {
    const { rows } = await trx.raw('SELECT now()::text AS t');
    await trx('system_settings').where({ key: 'neighborhood_access.sweep_watermark' }).update({ value: rows[0].t });
  };

  test('off: nothing is read or written', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'false';
    expect(await sweepSavedGateCodes()).toEqual({ skipped: 'gate_off' });
  });

  test('a saved code files under a linked property\'s neighborhood, and the watermark moves', async () => {
    const n = await neighborhood('Oakwood Glen');
    await customerWithCode('#1111', { neighborhoodId: n });
    await openWindow();
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ customers: 1, tally: { filed: 1 }, failed: 0, conflicts: 0 });
    expect(await accessRows(n)).toEqual([{ access_type: 'keypad', code: '#1111', instructions: null, status: 'active', source: 'profile' }]);
    expect(mockRaise).not.toHaveBeenCalled();
    const { value } = await trx('system_settings').where({ key: 'neighborhood_access.sweep_watermark' }).first('value');
    expect(value).not.toBe('2999-01-01 00:00:00+00');
  });

  test('a never-checked property is linked from the county roll first', async () => {
    await customerWithCode('2222#');
    await openWindow();
    const lookup = jest.fn(async () => ({ county: 'Manatee', subdivision: 'HERON POINTE PH I PB1/1', situsAddress: '100 SYNTHETIC WAY', situsZip: '34202' }));
    const r = await sweepSavedGateCodes({ lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(r.tally).toEqual({ filed: 1 });
    const n = await trx('neighborhoods').where('name', 'Heron Pointe').first('id');
    expect(await accessRows(n.id)).toEqual([expect.objectContaining({ code: '2222#', status: 'active' })]);
  });

  test('a second, different code flags both and raises ONE Customers bell for the neighborhood', async () => {
    const n = await neighborhood('Willow Grande');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '3333', status: 'active', source: 'backfill' });
    const customerId = await customerWithCode('4444', { neighborhoodId: n });
    await openWindow();
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ tally: { filed_conflict: 1 }, conflicts: 1 });
    expect((await accessRows(n)).map((x) => [x.code, x.status])).toEqual([['3333', 'needs_confirm'], ['4444', 'needs_confirm']]);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('customer');
    expect(headline).toBe('Customers — confirm a neighborhood gate code');
    expect(why).toBe("Willow Grande now has 2 different gate codes on file after Sample's update.");
    expect(opts).toMatchObject({ dedupeKey: `neighborhood-gate-conflict:${n}`, bellDefault: true, link: `/admin/customers?customerId=${customerId}` });
    expect(why).not.toMatch(/3333|4444/);
  });

  test('free text files for the office to confirm, with no bell', async () => {
    const n = await neighborhood('Pinebrook Village');
    await customerWithCode('Text the owner on arrival; north gate only', { neighborhoodId: n });
    await openWindow();
    await sweepSavedGateCodes();
    expect(await accessRows(n)).toEqual([expect.objectContaining({ access_type: 'instructions', status: 'needs_confirm' })]);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a profile with two properties is skipped — the code cannot say which one it belongs to', async () => {
    const n = await neighborhood('Stonefield');
    await customerWithCode('5555', { neighborhoodId: n, properties: 2 });
    await openWindow();
    const r = await sweepSavedGateCodes();
    expect(r.tally).toEqual({ multi_property: 1 });
    expect(await accessRows(n)).toEqual([]);
  });

  test('a conflict the office resolved has its bell closed by the sweep', async () => {
    const n = await neighborhood('Ashby');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '6666', status: 'active', source: 'office' });
    mockOpenKeys.mockResolvedValueOnce([`neighborhood-gate-conflict:${n}`]);
    await sweepSavedGateCodes();
    expect(mockClose).toHaveBeenCalledWith(expect.anything(), [`neighborhood-gate-conflict:${n}`], 'gate_code_confirmed', expect.any(Object));
  });
});
