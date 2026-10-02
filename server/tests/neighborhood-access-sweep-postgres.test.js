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
const { sweepSavedGateCodes, VALUE_HASH_SQL } = require('../services/neighborhood-access');

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
  const customerWithCode = async (code, { neighborhoodId = null, properties = 1, street = '100 Synthetic Way', notes = null, pin = true } = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${id}@example.invalid` });
    for (let i = 0; i < properties; i += 1) {
      await trx('customer_properties').insert({
        id: randomUUID(), customer_id: id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: i === 0,
        address_line1: i === 0 ? street : `${200 + i} Other Way`, city: 'Lakewood Ranch', zip: '34202',
        latitude: pin ? 27.4 : null, longitude: pin ? -82.35 : null, active: true, address_key: randomUUID(),
        neighborhood_id: neighborhoodId, neighborhood_source: neighborhoodId ? 'county' : null,
      });
    }
    await trx('property_preferences').insert({ customer_id: id, neighborhood_gate_code: code, access_notes: notes });
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
    // Only this test's rows: every customer already coded counts as filed.
    await trx.raw(`INSERT INTO neighborhood_access_filings (customer_id, value_hash, neighborhood_id, outcome)
      SELECT pp.customer_id, ${VALUE_HASH_SQL},
        (SELECT CASE WHEN count(*) = 1 THEN (array_agg(p.neighborhood_id))[1] END
         FROM customer_properties p WHERE p.customer_id = pp.customer_id AND p.active), 'filed'
      FROM property_preferences pp WHERE btrim(coalesce(pp.neighborhood_gate_code, '')) <> ''
      ON CONFLICT (customer_id) DO NOTHING`);
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS;
    else process.env.GATE_NEIGHBORHOOD_ACCESS = OLD_GATE;
  });
  afterAll(() => database.destroy());

  test('off: nothing is read or written', async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'false';
    expect(await sweepSavedGateCodes()).toEqual({ skipped: 'gate_off' });
  });

  test('a saved code files once under a linked property\'s neighborhood, ledgered by hash', async () => {
    const n = await neighborhood('Oakwood Glen');
    const customerId = await customerWithCode('#1111', { neighborhoodId: n });
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ customers: 1, tally: { filed: 1 }, failed: 0, conflicts: 0 });
    expect(await accessRows(n)).toEqual([{ access_type: 'keypad', code: '#1111', instructions: null, status: 'active', source: 'profile' }]);
    expect(mockRaise).not.toHaveBeenCalled();
    const ledger = await trx('neighborhood_access_filings').where({ customer_id: customerId }).first();
    expect(ledger).toMatchObject({ neighborhood_id: n, outcome: 'filed' });
    expect(ledger.value_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain('1111');
    expect((await sweepSavedGateCodes()).customers).toBe(0);
  });

  test('a code with trailing whitespace is filed once, not every pass', async () => {
    const n = await neighborhood('Ashby Glen');
    await customerWithCode('1515\n', { neighborhoodId: n });
    expect((await sweepSavedGateCodes()).tally).toEqual({ filed: 1 });
    expect((await sweepSavedGateCodes()).customers).toBe(0);
  });

  test('an unrelated preference edit never re-files a code the office retired', async () => {
    const n = await neighborhood('Laurel North');
    const customerId = await customerWithCode('1212', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('neighborhood_access').where({ neighborhood_id: n }).update({ status: 'retired' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ pet_count: 2, updated_at: trx.fn.now() });
    expect((await sweepSavedGateCodes()).customers).toBe(0);
    expect((await accessRows(n)).map((r) => r.status)).toEqual(['retired']);
  });

  test('a new value for the same customer is filed again (a save that lands after a pass is seen next pass)', async () => {
    const n = await neighborhood('Blue Tern Lagoons');
    const customerId = await customerWithCode('1313', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: '1414' });
    const r = await sweepSavedGateCodes();
    expect(r.tally).toEqual({ filed_conflict: 1 });
  });

  test('a never-checked property is linked from the county roll first', async () => {
    await customerWithCode('2222#');
    const lookup = jest.fn(async () => ({ county: 'Manatee', subdivision: 'HERON POINTE PH I PB1/1', situsAddress: '100 SYNTHETIC WAY', situsZip: '34202' }));
    const r = await sweepSavedGateCodes({ lookup });
    expect(lookup).toHaveBeenCalledTimes(1);
    // The ZIP's one county goes along, so a slow earlier county cannot spend the shared deadline.
    expect(lookup).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), { county: 'Manatee' });
    expect(r.tally).toEqual({ filed: 1 });
    const n = await trx('neighborhoods').where('name', 'Heron Pointe').first('id');
    expect(await accessRows(n.id)).toEqual([expect.objectContaining({ code: '2222#', status: 'active' })]);
  });

  test('a second, different code flags both and raises ONE Customers bell for the neighborhood', async () => {
    const n = await neighborhood('Willow Grande');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '3333', status: 'active', source: 'backfill' });
    const customerId = await customerWithCode('4444', { neighborhoodId: n });
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ tally: { filed_conflict: 1 }, conflicts: 1 });
    expect((await accessRows(n)).map((x) => [x.code, x.status])).toEqual([['3333', 'needs_confirm'], ['4444', 'needs_confirm']]);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('customer');
    expect(headline).toBe('Customers — confirm a neighborhood gate code');
    expect(why).toBe("Willow Grande now has 2 different gate codes on file after Sample's update.");
    expect(opts).toMatchObject({ dedupeKey: `neighborhood-gate-conflict:${n}`, bellDefault: true, link: `/admin/customers?customerId=${customerId}` });
    // Top-level customerId: the internal-test-customer bell suppression reads it.
    expect(opts.metadata).toMatchObject({ customerId: String(customerId), neighborhoodId: n });
    expect(why).not.toMatch(/3333|4444/);
  });

  test.each([
    ['a new code', false],
    ['a copy of an active code', true],
  ])('a profile code marked unconfirmed files needs_confirm (%s)', async (_label, existing) => {
    const n = await neighborhood('Meadow Run');
    if (existing) await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '1616', status: 'active', source: 'backfill' });
    await customerWithCode('1616', { neighborhoodId: n, notes: '[10-01 from messages] Gate code 1616 is unconfirmed: confirm on site.' });
    await sweepSavedGateCodes();
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual([['1616', 'needs_confirm']]);
  });

  test('an old unconfirmed note does not doubt a replacement code', async () => {
    const n = await neighborhood('Meadow Brook');
    await customerWithCode('1717', { neighborhoodId: n, notes: '[10-01 from messages] Gate code 1616 is unconfirmed: confirm on site.' });
    await sweepSavedGateCodes();
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual([['1717', 'active']]);
  });

  test('a property with no pin never calls the county lookup, and stays pending', async () => {
    const customerId = await customerWithCode('1818', { pin: false });
    const lookup = jest.fn();
    const r = await sweepSavedGateCodes({ lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(r.tally).toEqual({ no_neighborhood: 1 });
    expect(await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).toBeUndefined();
  });

  test('a code carried to a re-linked property (address move, office fix) files for the office to confirm', async () => {
    const n1 = await neighborhood('Old Grove');
    const n2 = await neighborhood('New Grove');
    const customerId = await customerWithCode('1919', { neighborhoodId: n1 });
    await sweepSavedGateCodes();
    await trx('customer_properties').where({ customer_id: customerId }).update({ neighborhood_id: n2, neighborhood_source: 'office' });
    expect((await sweepSavedGateCodes()).tally).toEqual({ filed: 1 });
    // Carried over from the old neighborhood: the office confirms it, never active.
    expect((await accessRows(n2)).map((r) => [r.code, r.status])).toEqual([['1919', 'needs_confirm']]);
    expect((await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).neighborhood_id).toBe(n2);
    expect((await sweepSavedGateCodes()).customers).toBe(0);
  });

  test('a property re-linked back to the SAME neighborhood keeps its active code active', async () => {
    const n = await neighborhood('Same Grove');
    const customerId = await customerWithCode('2323', { neighborhoodId: n });
    await sweepSavedGateCodes();
    // An address correction cleared the link; the county roll resolves it back to the same place.
    await trx('customer_properties').where({ customer_id: customerId }).update({ neighborhood_id: null, neighborhood_source: null, neighborhood_checked_at: null });
    const lookup = jest.fn(async () => ({ county: 'Manatee', subdivision: 'SAME GROVE PH II PB2/2', situsAddress: '100 SYNTHETIC WAY', situsZip: '34202' }));
    const same = await trx('neighborhoods').where({ id: n }).first('match_key');
    await trx('neighborhoods').where({ id: n }).update({ match_key: 'manatee|same grove' });
    await sweepSavedGateCodes({ lookup });
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual([['2323', 'active']]);
    await trx('neighborhoods').where({ id: n }).update({ match_key: same.match_key });
  });

  test('a re-link back to the SAME neighborhood never re-files a code the office retired', async () => {
    const n = await neighborhood('Retired Grove');
    const customerId = await customerWithCode('2424', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('neighborhood_access').where({ neighborhood_id: n }).update({ status: 'retired' });
    await trx('customer_properties').where({ customer_id: customerId }).update({ neighborhood_id: null, neighborhood_source: null, neighborhood_checked_at: null });
    const lookup = jest.fn(async () => ({ county: 'Manatee', subdivision: 'RETIRED GROVE PH II PB2/2', situsAddress: '100 SYNTHETIC WAY', situsZip: '34202' }));
    const before = await trx('neighborhoods').where({ id: n }).first('match_key');
    await trx('neighborhoods').where({ id: n }).update({ match_key: 'manatee|retired grove' });
    await sweepSavedGateCodes({ lookup });
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual([['2424', 'retired']]);
    expect((await sweepSavedGateCodes()).customers).toBe(0);
    await trx('neighborhoods').where({ id: n }).update({ match_key: before.match_key });
  });

  test('the ledger seed keeps a code the office retired after the backfill from coming back', async () => {
    const seed = require('../models/migrations/20261002110000_neighborhood_access_filings_seed');
    const n = await neighborhood('Retired Gate');
    const customerId = await customerWithCode('2020', { neighborhoodId: n });
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '2020', status: 'retired', source: 'backfill', source_customer_id: customerId });
    await trx('neighborhood_access_filings').where({ customer_id: customerId }).del();
    await seed.up(trx);
    expect((await sweepSavedGateCodes()).customers).toBe(0);
    expect((await accessRows(n)).map((r) => r.status)).toEqual(['retired']);
  });

  test('maximum-length names still make a valid bell', async () => {
    const n = await neighborhood('Laurelwood Preserve at Cypress Banks West');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '2121', status: 'active', source: 'backfill' });
    const customerId = await customerWithCode('2222', { neighborhoodId: n });
    await trx('customers').where({ id: customerId }).update({ first_name: 'Maximiliana-Josephine' });
    await sweepSavedGateCodes();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const why = mockRaise.mock.calls[0][2];
    expect(why.length).toBeLessThanOrEqual(110);
    expect(why).toBe('Laurelwood Preserve at Cypress Banks now has 2 different gate codes on file.');
  });

  test.each([
    ['initials', 'A. J.', 'Oak Hollow', 'Oak Hollow now has 2 different gate codes on file.'],
    ['a bracketed community name', 'Sample', 'Oak Hollow [North]', 'A neighborhood now has 2 different gate codes on file.'],
  ])('a name the composer rejects (%s) still rings the bell', async (_label, firstName, name, expected) => {
    const n = await neighborhood(name);
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '2727', status: 'active', source: 'backfill' });
    const customerId = await customerWithCode('2828', { neighborhoodId: n });
    await trx('customers').where({ id: customerId }).update({ first_name: firstName });
    await sweepSavedGateCodes();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][2]).toBe(expected);
  });

  test('a filing whose neighborhood was deleted is filed again', async () => {
    const n = await neighborhood('Gone Grove');
    const customerId = await customerWithCode('2929', { neighborhoodId: n });
    await sweepSavedGateCodes();
    // The backfill rollback deletes the neighborhood: the ledger FK goes NULL with the property's link.
    await trx('customer_properties').where({ customer_id: customerId }).update({ neighborhood_id: null, neighborhood_source: null, neighborhood_checked_at: null });
    await trx('neighborhood_access').where({ neighborhood_id: n }).del();
    await trx('neighborhoods').where({ id: n }).del();
    expect((await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).neighborhood_id).toBeNull();
    const n2 = await neighborhood('New Grove');
    await trx('customer_properties').where({ customer_id: customerId }).update({ neighborhood_id: n2, neighborhood_source: 'office' });
    expect((await sweepSavedGateCodes()).customers).toBe(1);
    expect((await accessRows(n2)).map((r) => r.code)).toEqual(['2929']);
  });

  test('a keypad code resaved with different spacing is the same code: a retired copy stays retired', async () => {
    const n = await neighborhood('Spacing Grove');
    const customerId = await customerWithCode('#1234', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('neighborhood_access').where({ neighborhood_id: n }).update({ status: 'retired' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: ' # 1234 ' });
    expect((await sweepSavedGateCodes()).customers).toBe(0);
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual([['#1234', 'retired']]);
  });

  test('the canonical re-key drops a seed row that matched an instruction against a keypad code', async () => {
    const canonical = require('../models/migrations/20261002121500_neighborhood_access_filings_canonical');
    const n = await neighborhood('Spaced Pines');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '1234', status: 'active', source: 'backfill' });
    const spaced = await customerWithCode('12 34', { neighborhoodId: n });
    const keypad = await customerWithCode(' # 5678', { neighborhoodId: n });
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '#5678', status: 'retired', source: 'backfill' });
    // The old seed: btrim hash, either form matching.
    const oldHash = "encode(sha256(convert_to(btrim(pp.neighborhood_gate_code), 'UTF8')), 'hex')";
    await trx('neighborhood_access_filings').whereIn('customer_id', [spaced, keypad]).del();
    await trx.raw(`INSERT INTO neighborhood_access_filings (customer_id, value_hash, neighborhood_id, outcome)
      SELECT pp.customer_id, ${oldHash}, ?, 'filed' FROM property_preferences pp WHERE pp.customer_id = ANY(?)`, [n, [spaced, keypad]]);
    await canonical.up(trx);
    // "12 34" had no instruction row: unfiled again. " # 5678" = retired "#5678": re-keyed, stays filed.
    expect(await trx('neighborhood_access_filings').where({ customer_id: spaced }).first()).toBeUndefined();
    expect(await trx('neighborhood_access_filings').where({ customer_id: keypad }).first()).toBeDefined();
    const r = await sweepSavedGateCodes();
    expect(r.customers).toBe(1);
    expect((await accessRows(n)).map((x) => [x.code, x.instructions, x.status])).toEqual(expect.arrayContaining([
      [null, '12 34', 'needs_confirm'], ['#5678', null, 'retired'],
    ]));
  });

  test('a conflict bell that fails is counted for job health', async () => {
    const n = await neighborhood('Failing Bell');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '3131', status: 'active', source: 'backfill' });
    await customerWithCode('3232', { neighborhoodId: n });
    mockRaise.mockRejectedValueOnce(Object.assign(new Error('insert failed'), { code: 'EBELL' }));
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ failed: 0, conflicts: 1 });
    expect(r.bellsFailed).toBeGreaterThanOrEqual(1);
  });

  test('a code cleared and later restored files again (A → blank → A)', async () => {
    const n = await neighborhood('Cleared Grove');
    const customerId = await customerWithCode('4141', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('neighborhood_access').where({ neighborhood_id: n }).update({ status: 'retired' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: '' });
    await sweepSavedGateCodes();
    expect(await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).toBeUndefined();
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: '4141' });
    expect((await sweepSavedGateCodes()).customers).toBe(1);
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual(expect.arrayContaining([['4141', 'active'], ['4141', 'retired']]));
  });

  test('a code cleared and restored BETWEEN passes still files again (write-time reset)', async () => {
    const n = await neighborhood('Quick Restore');
    const customerId = await customerWithCode('4242', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('neighborhood_access').where({ neighborhood_id: n }).update({ status: 'retired' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: '' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: '4242' });
    expect((await sweepSavedGateCodes()).customers).toBe(1);
    expect((await accessRows(n)).map((r) => [r.code, r.status])).toEqual(expect.arrayContaining([['4242', 'active'], ['4242', 'retired']]));
  });

  test('a formatting-only resave or an unrelated edit keeps the filing (no reset)', async () => {
    const n = await neighborhood('Format Grove');
    const customerId = await customerWithCode('#4343', { neighborhoodId: n });
    await sweepSavedGateCodes();
    await trx('property_preferences').where({ customer_id: customerId }).update({ neighborhood_gate_code: ' # 4343 ' });
    await trx('property_preferences').where({ customer_id: customerId }).update({ access_notes: 'Dog in back yard.' });
    expect(await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).toBeDefined();
    expect((await sweepSavedGateCodes()).customers).toBe(0);
  });

  test('a duplicate that demotes an office code into a conflict rings the bell for that customer', async () => {
    const n = await neighborhood('Office Pair');
    await trx('neighborhood_access').insert([
      { neighborhood_id: n, access_type: 'keypad', code: '5151', status: 'active', source: 'office' },
      { neighborhood_id: n, access_type: 'keypad', code: '5252', status: 'active', source: 'office' },
    ]);
    const customerId = await customerWithCode('5151', { neighborhoodId: n, notes: 'Gate code 5151 is unconfirmed: confirm on site.' });
    const r = await sweepSavedGateCodes();
    expect(r).toMatchObject({ tally: { duplicate: 1 }, conflicts: 1 });
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][3]).toMatchObject({ link: `/admin/customers?customerId=${customerId}` });
  });

  test('the conflict bell opens the customer who updated last, not the last one filed', async () => {
    const n = await neighborhood('Two Saves');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '6060', status: 'active', source: 'backfill' });
    const a = await customerWithCode('6161', { neighborhoodId: n });
    const b = await customerWithCode('6262', { neighborhoodId: n });
    // The pass files in id order; make the id-last customer the OLDER update.
    const [first, last] = [a, b].sort();
    await trx('property_preferences').where({ customer_id: last }).update({ updated_at: trx.raw("now() - interval '1 hour'") });
    await trx('property_preferences').where({ customer_id: first }).update({ updated_at: trx.raw('now()') });
    await sweepSavedGateCodes();
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][3]).toMatchObject({ link: `/admin/customers?customerId=${first}` });
  });

  test('free text files for the office to confirm, with no bell', async () => {
    const n = await neighborhood('Pinebrook Village');
    await customerWithCode('Text the owner on arrival; north gate only', { neighborhoodId: n });
    await sweepSavedGateCodes();
    expect(await accessRows(n)).toEqual([expect.objectContaining({ access_type: 'instructions', status: 'needs_confirm' })]);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a profile with two properties is skipped — the code cannot say which one it belongs to', async () => {
    const n = await neighborhood('Stonefield');
    await customerWithCode('5555', { neighborhoodId: n, properties: 2 });
    const r = await sweepSavedGateCodes();
    expect(r.tally).toEqual({ multi_property: 1 });
    expect(await accessRows(n)).toEqual([]);
  });

  test('a standing conflict with no open bell (an earlier raise failed) is raised on the next pass', async () => {
    const n = await neighborhood('Fernleaf Hollow');
    const customerId = await customerWithCode('7777', { neighborhoodId: n });
    await trx('neighborhood_access').insert([
      { neighborhood_id: n, access_type: 'keypad', code: '7777', status: 'needs_confirm', source: 'profile', source_customer_id: customerId },
      { neighborhood_id: n, access_type: 'keypad', code: '8888', status: 'needs_confirm', source: 'backfill' },
    ]);
    await trx('neighborhood_access_filings').insert({ customer_id: customerId, value_hash: require('node:crypto').createHash('sha256').update('7777').digest('hex'), neighborhood_id: n, outcome: 'filed_conflict' });
    await sweepSavedGateCodes(); // the code is already filed; only the bell is missing
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][3]).toMatchObject({ dedupeKey: `neighborhood-gate-conflict:${n}`, link: `/admin/customers?customerId=${customerId}` });
    // An open (or person-dismissed) bell for it is left alone.
    mockRaise.mockClear();
    mockOpenKeys.mockResolvedValue([`neighborhood-gate-conflict:${n}`]);
    await sweepSavedGateCodes();
    mockOpenKeys.mockResolvedValue([]);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a county lookup that failed is retried on the next pass', async () => {
    const customerId = await customerWithCode('9999');
    const lookup = jest.fn(async () => null);
    expect((await sweepSavedGateCodes({ lookup })).tally).toEqual({ no_neighborhood: 1 });
    lookup.mockResolvedValue({ county: 'Manatee', subdivision: 'MEADOW AT CEDAR RANCH PH II PB60/1', situsAddress: '100 SYNTHETIC WAY', situsZip: '34202' });
    // Nothing was ledgered, so the customer is still pending.
    const r = await sweepSavedGateCodes({ lookup });
    expect(r.tally).toEqual({ filed: 1 });
    expect(lookup).toHaveBeenCalledTimes(2);
    const linked = await trx('customer_properties').where({ customer_id: customerId }).first('neighborhood_id');
    expect(linked.neighborhood_id).not.toBeNull();
  });

  test('a conflict the office resolved has its bell closed by the sweep', async () => {
    const n = await neighborhood('Ashby');
    await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '6666', status: 'active', source: 'office' });
    mockOpenKeys.mockResolvedValue([`neighborhood-gate-conflict:${n}`]);
    await sweepSavedGateCodes();
    mockOpenKeys.mockResolvedValue([]);
    expect(mockClose).toHaveBeenCalledWith(expect.anything(), [`neighborhood-gate-conflict:${n}`], 'gate_code_confirmed', expect.any(Object));
  });
});
