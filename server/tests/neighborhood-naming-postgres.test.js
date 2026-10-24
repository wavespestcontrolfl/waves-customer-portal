// Real PostgreSQL transactions (rolled back). The county lookup, the plat
// lookup and the bell helpers are stubs; nothing reaches the network. All
// names, addresses and codes are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 0),
}));
const { randomUUID } = require('node:crypto');
const { sweepSavedGateCodes } = require('../services/neighborhood-access');
const { runNamingPass, linkFromCaller } = require('../services/neighborhood-naming');

jest.setTimeout(30000);
postgres('neighborhood naming pass', () => {
  let database;
  let trx;
  const OLD = { access: process.env.GATE_NEIGHBORHOOD_ACCESS, naming: process.env.GATE_NEIGHBORHOOD_NAMING };

  // A Manatee street address the county stub will "find" under the pin.
  const parcelFor = (street, extra = {}) => ({
    county: 'Manatee', subdivision: 'HERON POINTE PH I PB1/1', situsAddress: street.toUpperCase(), situsZip: '34202', ...extra,
  });
  const home = async ({
    street = '100 Synthetic Way', zip = '34202', code = null, checked = false, subdivision = null, neighborhoodId = null,
    source = null, pin = true, stage = 'active_customer', lat = 27.4,
  } = {}) => {
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${customerId}@example.invalid`, pipeline_stage: stage,
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: street, city: 'Lakewood Ranch', zip, latitude: pin ? lat : null, longitude: pin ? -82.35 : null,
      active: true, address_key: randomUUID(), county_subdivision: subdivision, neighborhood_id: neighborhoodId,
      neighborhood_source: source, neighborhood_checked_at: checked ? trx.fn.now() : null,
    });
    if (code) await trx('property_preferences').insert({ customer_id: customerId, neighborhood_gate_code: code });
    return { customerId, propertyId };
  };
  const callSaying = (customerId, words, { street = '100 Synthetic Way', zip = '34202', city, createdAt = new Date() } = {}) => trx('call_log').insert({
    id: randomUUID(), customer_id: customerId, direction: 'inbound', created_at: createdAt,
    ai_extraction_enriched: JSON.stringify({ property: { service_address: { street_line_1: street, postal_code: zip, city, subdivision_or_community: words } } }),
  });
  const neighborhood = async (name, { county = 'Manatee', source = 'county' } = {}) => {
    const [row] = await trx('neighborhoods').insert({ name, county, match_key: `${county.toLowerCase()}|${name.toLowerCase()}`, source }).returning('id');
    return row.id;
  };
  const prop = (id) => trx('customer_properties').where({ id }).first();
  const hoodOf = async (propertyId) => {
    const p = await prop(propertyId);
    const hood = p.neighborhood_id ? await trx('neighborhoods').where({ id: p.neighborhood_id }).first() : null;
    return { name: hood?.name || null, hoodSource: hood?.source || null, link: p.neighborhood_source, checked: Boolean(p.neighborhood_checked_at), p };
  };
  const accessRows = (id) => trx('neighborhood_access').where({ neighborhood_id: id }).select('code', 'status', 'source');
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    process.env.GATE_NEIGHBORHOOD_NAMING = 'true';
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    await trx.rollback();
    for (const [k, v] of [['GATE_NEIGHBORHOOD_ACCESS', OLD.access], ['GATE_NEIGHBORHOOD_NAMING', OLD.naming]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  afterAll(() => database.destroy());

  // The county stub answers each call from a queue (homes are asked in id order).
  const queue = (parcels) => {
    const list = [...parcels];
    return jest.fn(async () => list.shift());
  };
  const runPass = (lookup, platLookup) => runNamingPass({ lookup, platLookup: platLookup || (async () => []) });

  describe('county pass', () => {
    test('a home never checked is linked, stamped checked and filed under its community', async () => {
      const { propertyId } = await home({ street: '100 Synthetic Way' });
      const lookup = queue([parcelFor('100 Synthetic Way')]);
      const r = await runPass(lookup);
      expect(r.county).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Heron Pointe', hoodSource: 'county', link: 'county', checked: true });
      // The ZIP's one county goes along; the diag out-param is how an outage is told from a miss.
      expect(lookup).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), { county: 'Manatee', diag: { errors: [] } });
    });

    test('a pass asks about 20 homes and the next pass takes the rest', async () => {
      const ids = [];
      for (let i = 0; i < 25; i += 1) ids.push((await home({ street: `${100 + i} Synthetic Way` })).propertyId);
      const props = await trx('customer_properties').whereIn('id', ids).orderBy('id').select('id', 'address_line1');
      const order = props.map((p) => parcelFor(p.address_line1));
      const first = await runPass(queue(order));
      expect(first.county).toEqual({ linked: 20 });
      const second = await runPass(queue(order.slice(20)));
      expect(second.county).toEqual({ linked: 5 });
      expect((await runPass(queue([]))).county).toEqual({});
    });

    test('a Sarasota home is named from its plat number; phases fold into one community', async () => {
      const a = await home({ street: '10 Sample Cove', zip: '34233' });
      const b = await home({ street: '20 Sample Cove', zip: '34233' });
      const parcels = new Map([
        [a.propertyId, { county: 'Sarasota', subdivision: '3491', situsAddress: '10 SAMPLE COVE', situsZip: '34233' }],
        [b.propertyId, { county: 'Sarasota', subdivision: '3449', situsAddress: '20 SAMPLE COVE', situsZip: '34233' }],
      ]);
      const order = (await trx('customer_properties').whereIn('id', [a.propertyId, b.propertyId]).orderBy('id').pluck('id')).map((id) => parcels.get(id));
      const plat = jest.fn(async (n) => (n === '3491' ? ['WILD BLUE AT WATERSIDE PHASE 2A'] : ['WILD BLUE AT WATERSIDE PHASE 1', 'WILD BLUE AT WATERSIDE PHASE 3']));
      const r = await runPass(queue(order), plat);
      expect(r.county).toEqual({ linked: 2 });
      const ha = await hoodOf(a.propertyId);
      const hb = await hoodOf(b.propertyId);
      expect(ha.name).toBe('Wild Blue at Waterside');
      expect(hb.p.neighborhood_id).toBe(ha.p.neighborhood_id);
      // The raw roll value stays the number, for the estimator and for provenance.
      expect([ha.p.county_subdivision, hb.p.county_subdivision].sort()).toEqual(['3449', '3491']);
      expect(await trx('neighborhoods').where({ name: 'Wild Blue at Waterside' })).toHaveLength(1);
    });

    test('a checked home holding a bare plat number is looked at again and named; other unnamed homes are not', async () => {
      const numbered = await home({ street: '10 Sample Cove', zip: '34233', checked: true, subdivision: '3491' });
      await home({ street: '20 Sample Cove', zip: '34233', checked: true, subdivision: 'NOT IN SUBDIVISION 0/0' });
      await home({ street: '30 Sample Cove', zip: '34233', checked: true, subdivision: '0000' });
      const lookup = queue([{ county: 'Sarasota', subdivision: '3491', situsAddress: '10 SAMPLE COVE', situsZip: '34233' }]);
      const r = await runPass(lookup, async () => ['WILD BLUE AT WATERSIDE PHASE 2A']);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(r.county).toEqual({ linked: 1 });
      expect(await hoodOf(numbered.propertyId)).toMatchObject({ name: 'Wild Blue at Waterside', link: 'county' });
    });

    test('a plat the layer has no name for is answered once, then waits a day', async () => {
      await home({ street: '10 Sample Cove', zip: '34233', checked: true, subdivision: '3491' });
      const parcel = { county: 'Sarasota', subdivision: '3491', situsAddress: '10 SAMPLE COVE', situsZip: '34233' };
      const lookup = jest.fn(async () => parcel);
      const t0 = Date.now();
      expect((await runNamingPass({ lookup, platLookup: async () => [], now: t0 })).county).toEqual({ no_name: 1 });
      expect((await runNamingPass({ lookup, platLookup: async () => [], now: t0 + 3600e3 })).county).toEqual({});
      expect((await runNamingPass({ lookup, platLookup: async () => [], now: t0 + 25 * 3600e3 })).county).toEqual({ no_name: 1 });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    test('a county outage leaves the home unchecked, is not retried for an hour, and 3 in a row end the pass', async () => {
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push((await home({ street: `${100 + i} Synthetic Way` })).propertyId);
      const down = jest.fn(async (_lat, _lng, opts) => { opts.diag.errors.push({ error: 'down' }); return null; });
      const t0 = Date.now();
      const r = await runNamingPass({ lookup: down, platLookup: async () => [], now: t0 });
      expect(r.county).toEqual({ gis_error: 3 });
      expect(down).toHaveBeenCalledTimes(3);
      expect(await trx('customer_properties').whereIn('id', ids).whereNotNull('neighborhood_checked_at')).toHaveLength(0);
      // Next tick: the three that failed sit out; the other two are tried (and fail).
      const again = await runNamingPass({ lookup: down, platLookup: async () => [], now: t0 + 15 * 60e3 });
      expect(again.county).toEqual({ gis_error: 2 });
      // An hour later the first three are asked again.
      const later = await runNamingPass({ lookup: down, platLookup: async () => [], now: t0 + 61 * 60e3 });
      expect(later.county.gis_error).toBe(3);
    });

    test('a parcel found after an earlier county\'s error (a county-line ZIP) is an answer, not an outage', async () => {
      const { propertyId } = await home();
      const lookup = jest.fn(async (_lat, _lng, opts) => { opts.diag.errors.push({ error: 'first county down' }); return parcelFor('100 Synthetic Way'); });
      expect((await runPass(lookup)).county).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Heron Pointe', link: 'county' });
    });

    test('a plat layer failure is an outage too: the home is not stamped checked', async () => {
      const { propertyId } = await home({ street: '10 Sample Cove', zip: '34233' });
      const lookup = queue([{ county: 'Sarasota', subdivision: '3491', situsAddress: '10 SAMPLE COVE', situsZip: '34233' }]);
      const r = await runPass(lookup, async () => { throw new Error('plat layer down'); });
      expect(r.county).toEqual({ gis_error: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: null, checked: false });
    });

    test('an office pick is never looked up or overwritten, by the county or the caller', async () => {
      const office = await home({ checked: true, source: 'office' });
      await callSaying(office.customerId, 'Chelsea Oaks');
      const lookup = jest.fn();
      const r = await runPass(lookup);
      expect(lookup).not.toHaveBeenCalled();
      expect(r).toEqual({ county: {}, caller: {} });
      expect(await hoodOf(office.propertyId)).toMatchObject({ name: null, link: 'office' });
      // An office pick that carries a neighborhood keeps it.
      const n = await neighborhood('Office Pick');
      const picked = await home({ street: '5 Pick Ct', checked: true, source: 'office', neighborhoodId: n });
      await runPass(lookup);
      expect((await hoodOf(picked.propertyId)).name).toBe('Office Pick');
    });

    test('a pin that lands on another house links nothing', async () => {
      const { propertyId } = await home({ street: '100 Synthetic Way' });
      const r = await runPass(queue([parcelFor('900 Other Way')]));
      expect(r.county).toEqual({ situs_mismatch: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: null, checked: false });
    });

    test('a former customer, a deleted customer and a switched-off customer are not looked up', async () => {
      await home({ stage: 'churned' });
      const gone = await home({ street: '2 Gone Way' });
      await trx('customers').where({ id: gone.customerId }).update({ deleted_at: trx.fn.now() });
      const off = await home({ street: '3 Off Way' });
      await trx('customers').where({ id: off.customerId }).update({ active: false });
      const lookup = jest.fn();
      expect((await runPass(lookup)).county).toEqual({});
      expect(lookup).not.toHaveBeenCalled();
    });

    test('the county always wins over a caller link; a county with no name leaves it standing', async () => {
      const callerHood = await neighborhood('Chelsea Oaks', { source: 'customer' });
      const wins = await home({ street: '100 Synthetic Way', neighborhoodId: callerHood, source: 'caller' });
      const r = await runPass(queue([parcelFor('100 Synthetic Way')]));
      expect(r.county).toEqual({ linked: 1 });
      expect(await hoodOf(wins.propertyId)).toMatchObject({ name: 'Heron Pointe', link: 'county' });

      const stays = await home({ street: '200 Synthetic Way', neighborhoodId: callerHood, source: 'caller' });
      const none = await runPass(queue([parcelFor('200 Synthetic Way', { subdivision: 'NOT IN SUBDIVISION 0/0' })]));
      expect(none.county).toEqual({ no_name: 1 });
      expect(await hoodOf(stays.propertyId)).toMatchObject({ name: 'Chelsea Oaks', link: 'caller', checked: true });
    });

    test('more unnameable homes than a batch never starve a nameable one behind them, even across restarts', async () => {
      // 205 homes the county answers about with a mismatch (more than any
      // select window), then one nameable home with the highest id.
      const GOOD = 27.5;
      for (let i = 0; i < 205; i += 1) await home({ street: `${300 + i} Miss Way`, lat: 27.4 + (i + 1) / 1e6 });
      const good = await home({ street: '100 Synthetic Way', lat: GOOD });
      await trx('customer_properties').where({ id: good.propertyId }).update({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      const lookup = jest.fn(async (lat) => (Math.abs(lat - GOOD) < 1e-9 ? parcelFor('100 Synthetic Way') : parcelFor('900 Other Way')));
      const t0 = Date.now();
      let passes = 0;
      let linked = 0;
      // Nothing but the database carries a home's state from one pass to the next.
      while (!linked && passes < 12) {
        const r = await runNamingPass({ lookup, platLookup: async () => [], now: t0 + passes * 15 * 60e3 });
        linked += r.county.linked || 0;
        passes += 1;
      }
      expect(linked).toBe(1);
      expect(passes).toBeLessThanOrEqual(11); // 206 homes at 20 a pass
      expect(await hoodOf('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({ name: 'Heron Pointe' });
      // Every miss was asked exactly once and now waits a day.
      expect(lookup).toHaveBeenCalledTimes(206);
      const again = await runNamingPass({ lookup, platLookup: async () => [], now: t0 + 3 * 3600e3 });
      expect(again.county).toEqual({});
      const nextDay = await runNamingPass({ lookup, platLookup: async () => [], now: t0 + 26 * 3600e3 });
      expect(nextDay.county).toEqual({ situs_mismatch: 20 });
    });

    test('a home that moved is asked afresh; the old address\'s wait does not carry over', async () => {
      const { propertyId } = await home({ street: '100 Synthetic Way' });
      const t0 = Date.now();
      const miss = jest.fn(async () => parcelFor('900 Other Way'));
      expect((await runNamingPass({ lookup: miss, platLookup: async () => [], now: t0 })).county).toEqual({ situs_mismatch: 1 });
      expect((await runNamingPass({ lookup: miss, platLookup: async () => [], now: t0 + 3600e3 })).county).toEqual({});
      await trx('customer_properties').where({ id: propertyId }).update({ address_line1: '200 Synthetic Way' });
      const lookup = queue([parcelFor('200 Synthetic Way')]);
      expect((await runNamingPass({ lookup, platLookup: async () => [], now: t0 + 3600e3 })).county).toEqual({ linked: 1 });
    });
  });

  describe('caller pass', () => {
    test('a checked home the county could not name takes the community said on a call, new row marked customer', async () => {
      const { customerId, propertyId } = await home({ checked: true, subdivision: 'NOT IN SUBDIVISION 0/0' });
      await callSaying(customerId, 'Chelsea Oaks subdivision');
      const r = await runPass(jest.fn());
      expect(r.caller).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Chelsea Oaks', hoodSource: 'customer', link: 'caller' });
      const hood = await trx('neighborhoods').where({ name: 'Chelsea Oaks' }).first();
      expect(hood).toMatchObject({ county: 'Manatee', match_key: 'manatee|chelsea oaks' });
    });

    test('the words match the county\'s own entry of that name instead of adding a second row', async () => {
      const existing = await neighborhood('Chelsea Oaks');
      const { customerId, propertyId } = await home({ checked: true });
      await callSaying(customerId, 'chelsea oaks phase 2');
      await runPass(jest.fn());
      expect((await hoodOf(propertyId)).p.neighborhood_id).toBe(existing);
      expect(await trx('neighborhoods').where({ county: 'Manatee' })).toHaveLength(1);
    });

    test('the same words in another county never join the first county\'s row', async () => {
      const other = await neighborhood('Chelsea Oaks', { county: 'Sarasota' });
      const { customerId, propertyId } = await home({ checked: true });
      await callSaying(customerId, 'Chelsea Oaks');
      await runPass(jest.fn());
      const p = await prop(propertyId);
      expect(p.neighborhood_id).not.toBe(other);
      expect(await trx('neighborhoods').where({ name: 'Chelsea Oaks' })).toHaveLength(2);
    });

    test.each([
      ['a call about another address', (c) => callSaying(c, 'Chelsea Oaks', { street: '999 Elsewhere Ln' })],
      ['a call that gave another ZIP', (c) => callSaying(c, 'Chelsea Oaks', { zip: '34233' })],
      ['a town, not a community', (c) => callSaying(c, 'Lakewood Ranch')],
      ['a shrug', (c) => callSaying(c, 'not sure')],
      ['two calls naming two communities', async (c) => { await callSaying(c, 'Chelsea Oaks'); await callSaying(c, 'Heron Pointe'); }],
    ])('%s links nothing', async (_label, makeCalls) => {
      const { customerId, propertyId } = await home({ checked: true });
      await makeCalls(customerId);
      const r = await runPass(jest.fn());
      expect(r.caller).toEqual({ no_words: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: null, link: null });
    });

    test('a home the county named is never touched by the caller\'s words', async () => {
      const n = await neighborhood('Heron Pointe');
      const { customerId, propertyId } = await home({ checked: true, neighborhoodId: n, source: 'county' });
      await callSaying(customerId, 'Totally Different Estates');
      expect((await runPass(jest.fn())).caller).toEqual({});
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Heron Pointe', link: 'county' });
    });

    test('a plat-number home waits for its county re-check before the caller is heard; a county that answers with no name opens it', async () => {
      const { customerId, propertyId } = await home({ street: '10 Sample Cove', zip: '34233', checked: true, subdivision: '3491' });
      await callSaying(customerId, 'Cove Gardens', { street: '10 Sample Cove', zip: '34233' });
      // The county cannot be read this tick: the caller is not heard.
      const down = jest.fn(async (_a, _b, opts) => { opts.diag.errors.push({ error: 'down' }); return null; });
      const blocked = await runNamingPass({ lookup: down, platLookup: async () => [] });
      expect(blocked.caller).toEqual({});
      expect((await hoodOf(propertyId)).name).toBeNull();
      // The county answers: its plat has no name, so the caller's words stand.
      const lookup = queue([{ county: 'Sarasota', subdivision: '3491', situsAddress: '10 SAMPLE COVE', situsZip: '34233' }]);
      const r = await runNamingPass({ lookup, platLookup: async () => [], now: Date.now() + 2 * 3600e3 });
      expect(r).toEqual({ county: { no_name: 1 }, caller: { linked: 1 } });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Cove Gardens', link: 'caller' });
    });

    // Same house number and street in another town is another home.
    test.each([
      ['no ZIP, no city', { zip: null }, 'no_words'],
      ['a malformed ZIP and no city', { zip: '3420' }, 'no_words'],
      ['no ZIP and another city', { zip: null, city: 'Sarasota' }, 'no_words'],
      ['a malformed ZIP and another city', { zip: '3420', city: 'Sarasota' }, 'no_words'],
      ['another valid ZIP, the same city', { zip: '34233', city: 'Lakewood Ranch' }, 'no_words'],
      ['no ZIP and the same city', { zip: null, city: 'lakewood  ranch' }, 'linked'],
      ['a malformed ZIP and the same city', { zip: '3420', city: 'Lakewood Ranch' }, 'linked'],
      ['the same ZIP+4, another city', { zip: '34202-1234', city: 'Sarasota' }, 'linked'],
    ])('a call with %s', async (_label, where, outcome) => {
      const { customerId, propertyId } = await home({ checked: true });
      await callSaying(customerId, 'Chelsea Oaks', where);
      expect((await runPass(jest.fn())).caller).toEqual({ [outcome]: 1 });
      expect((await hoodOf(propertyId)).name).toBe(outcome === 'linked' ? 'Chelsea Oaks' : null);
    });

    test('more homes the caller cannot help than a batch never starve a nameable one behind them', async () => {
      for (let i = 0; i < 55; i += 1) {
        const miss = await home({ street: `${300 + i} Miss Way`, checked: true, subdivision: 'NOT IN SUBDIVISION 0/0' });
        await callSaying(miss.customerId, 'not sure', { street: `${300 + i} Miss Way` });
      }
      const good = await home({ street: '100 Synthetic Way', checked: true, subdivision: 'NOT IN SUBDIVISION 0/0' });
      await trx('customer_properties').where({ id: good.propertyId }).update({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
      await callSaying(good.customerId, 'Chelsea Oaks');
      const t0 = Date.now();
      const first = await runNamingPass({ lookup: jest.fn(), platLookup: async () => [], now: t0 });
      expect(first.caller).toEqual({ no_words: 50 });
      const second = await runNamingPass({ lookup: jest.fn(), platLookup: async () => [], now: t0 + 15 * 60e3 });
      expect(second.caller).toEqual({ no_words: 5, linked: 1 });
      expect(await hoodOf('ffffffff-ffff-4fff-8fff-ffffffffffff')).toMatchObject({ name: 'Chelsea Oaks', link: 'caller' });
      // All 55 now wait a day; then they are heard again (a new call may have come in).
      expect((await runNamingPass({ lookup: jest.fn(), platLookup: async () => [], now: t0 + 3600e3 })).caller).toEqual({});
      expect((await runNamingPass({ lookup: jest.fn(), platLookup: async () => [], now: t0 + 25 * 3600e3 })).caller).toEqual({ no_words: 50 });
    });

    test('an address edit between the evidence read and the link refuses the link', async () => {
      const { customerId, propertyId } = await home({ checked: true });
      const snapshot = await prop(propertyId);
      await callSaying(customerId, 'Chelsea Oaks');
      // The edit lands after the snapshot was read: the community was said about the OLD address.
      await trx('customer_properties').where({ id: propertyId }).update({ address_line1: '200 Synthetic Way', neighborhood_id: null, neighborhood_source: null });
      expect(await linkFromCaller(snapshot, 'Manatee', 'Chelsea Oaks')).toBe('address_changed');
      await trx('customer_properties').where({ id: propertyId }).update({ address_line1: snapshot.address_line1, zip: '34203' });
      expect(await linkFromCaller(snapshot, 'Manatee', 'Chelsea Oaks')).toBe('address_changed');
      expect(await hoodOf(propertyId)).toMatchObject({ name: null, link: null });
      expect(await trx('neighborhoods').where({ name: 'Chelsea Oaks' })).toHaveLength(0);
      // Unchanged: the same call links.
      await trx('customer_properties').where({ id: propertyId }).update({ zip: snapshot.zip });
      expect(await linkFromCaller(snapshot, 'Manatee', 'Chelsea Oaks')).toBe('linked');
    });

    test.each([
      ["St. Andrew's Preserve", 'St Andrews Preserve'],
      ['The Islands', 'Islands'],
    ])('a caller name matches the county community %s however it is written', async (countyName, said) => {
      const [hood] = await trx('neighborhoods').insert({ name: countyName, county: 'Manatee', match_key: `manatee|${countyName.toLowerCase()}`, subdivision_names: JSON.stringify([countyName.toUpperCase()]), source: 'county' }).returning('id');
      const { propertyId } = await home({ checked: true });
      const snapshot = await prop(propertyId);
      expect(await linkFromCaller(snapshot, 'Manatee', said)).toBe('linked');
      expect((await prop(propertyId)).neighborhood_id).toBe(hood.id);
      expect(await trx('neighborhoods').where({ county: 'Manatee' })).toHaveLength(1);
    });

    test('a caller-made community is reused when the county later names a home with another spelling', async () => {
      const first = await home({ checked: true });
      expect(await linkFromCaller(await prop(first.propertyId), 'Manatee', 'St Andrews Preserve')).toBe('linked');
      const second = await home({ street: '200 Synthetic Way' });
      const lookup = queue([parcelFor('200 Synthetic Way', { subdivision: "ST. ANDREW'S PRESERVE PH II PB2/2" })]);
      // The never-checked home is asked first; the caller-linked one is re-asked too (no parcel in the stub).
      expect((await runPass(lookup)).county).toEqual({ linked: 1, no_parcel: 1 });
      expect((await prop(second.propertyId)).neighborhood_id).toBe((await prop(first.propertyId)).neighborhood_id);
      expect(await trx('neighborhoods').where({ county: 'Manatee' })).toHaveLength(1);
    });

    test('no county name, then a caller link, then the county names the home: the county link replaces it', async () => {
      const { customerId, propertyId } = await home();
      const t0 = Date.now();
      const none = queue([parcelFor('100 Synthetic Way', { subdivision: 'NOT IN SUBDIVISION 0/0' })]);
      expect((await runNamingPass({ lookup: none, platLookup: async () => [], now: t0 })).county).toEqual({ no_name: 1 });
      await callSaying(customerId, 'Chelsea Oaks');
      expect((await runNamingPass({ lookup: jest.fn(), platLookup: async () => [], now: t0 + 15 * 60e3 })).caller).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Chelsea Oaks', link: 'caller' });
      // A day later the county is asked again and now names it.
      const named = queue([parcelFor('100 Synthetic Way', { subdivision: 'HERON POINTE PH I PB1/1' })]);
      const later = await runNamingPass({ lookup: named, platLookup: async () => [], now: t0 + 25 * 3600e3 });
      expect(later.county).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Heron Pointe', link: 'county' });
    });

    test('a home with no pin can still be named from a call', async () => {
      const { customerId, propertyId } = await home({ pin: false });
      await callSaying(customerId, 'Chelsea Oaks');
      expect((await runPass(jest.fn())).caller).toEqual({ linked: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: 'Chelsea Oaks', link: 'caller' });
    });

    test('a switched-off neighborhood is not re-linked', async () => {
      const n = await neighborhood('Chelsea Oaks');
      await trx('neighborhoods').where({ id: n }).update({ active: false });
      const { customerId, propertyId } = await home({ checked: true });
      await callSaying(customerId, 'Chelsea Oaks');
      expect((await runPass(jest.fn())).caller).toEqual({ switched_off: 1 });
      expect(await hoodOf(propertyId)).toMatchObject({ name: null });
    });

    test('a ZIP on a county line has no county to name a community in, so the words wait', async () => {
      const { customerId, propertyId } = await home({ zip: '34243', checked: true });
      await callSaying(customerId, 'Chelsea Oaks', { zip: '34243' });
      expect((await runPass(jest.fn())).caller).toEqual({ no_county: 1 });
      expect((await hoodOf(propertyId)).name).toBeNull();
    });
  });

  describe('through the sweep (the filing the owner asked for)', () => {
    test('a home named from a call files nothing: the link waits for the county or the office', async () => {
      const { customerId, propertyId } = await home({ code: '#4321', checked: true, subdivision: 'NOT IN SUBDIVISION 0/0' });
      await callSaying(customerId, 'Chelsea Oaks');
      const r = await sweepSavedGateCodes({ lookup: jest.fn(), platLookup: async () => [] });
      expect(r.naming.caller).toEqual({ linked: 1 });
      // The caller link stays (it names the community for the office to confirm); nothing is filed, listed or retried.
      expect(r.customers).toBe(0);
      const { p } = await hoodOf(propertyId);
      expect(p.neighborhood_source).toBe('caller');
      expect(await accessRows(p.neighborhood_id)).toEqual([]);
      expect(await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).toBeUndefined();
    });

    test('a saved code on a never-checked home is linked by the county pass and files active', async () => {
      const { propertyId } = await home({ code: '#5555' });
      const r = await sweepSavedGateCodes({ lookup: queue([parcelFor('100 Synthetic Way')]), platLookup: async () => [] });
      expect(r.naming.county).toEqual({ linked: 1 });
      expect(r.tally).toEqual({ filed: 1 });
      const { p } = await hoodOf(propertyId);
      expect(await accessRows(p.neighborhood_id)).toEqual([{ code: '#5555', status: 'active', source: 'profile' }]);
    });

    test('a caller-linked home saving a code adds no entry and demotes none; after the office confirms it, the code files', async () => {
      const n = await neighborhood('Chelsea Oaks', { source: 'customer' });
      await trx('neighborhood_access').insert({ neighborhood_id: n, access_type: 'keypad', code: '1111', status: 'active', source: 'office' });
      const { customerId, propertyId } = await home({ code: '2222', neighborhoodId: n, source: 'caller', checked: true });
      expect((await sweepSavedGateCodes({ lookup: jest.fn(), platLookup: async () => [] })).customers).toBe(0);
      expect(await accessRows(n)).toEqual([{ code: '1111', status: 'active', source: 'office' }]);
      // Office confirm is the existing pick: source 'office' on the same neighborhood.
      await trx('customer_properties').where({ id: propertyId }).update({ neighborhood_source: 'office' });
      const r = await sweepSavedGateCodes({ lookup: jest.fn(), platLookup: async () => [] });
      expect(r.tally).toEqual({ filed_conflict: 1 });
      expect((await accessRows(n)).map((x) => [x.code, x.status])).toEqual([['1111', 'needs_confirm'], ['2222', 'needs_confirm']]);
      expect((await trx('neighborhood_access_filings').where({ customer_id: customerId }).first()).neighborhood_id).toBe(n);
    });

    test('when the county later names a caller-linked home, its saved code files as for any county home', async () => {
      const callerHood = await neighborhood('Chelsea Oaks', { source: 'customer' });
      const { propertyId } = await home({ code: '#8888', neighborhoodId: callerHood, source: 'caller' });
      const r = await sweepSavedGateCodes({ lookup: queue([parcelFor('100 Synthetic Way')]), platLookup: async () => [] });
      expect(r.naming.county).toEqual({ linked: 1 });
      expect(r.tally).toEqual({ filed: 1 });
      const { p } = await hoodOf(propertyId);
      expect(p.neighborhood_source).toBe('county');
      expect(await accessRows(p.neighborhood_id)).toEqual([{ code: '#8888', status: 'active', source: 'profile' }]);
    });

    test('with GATE_NEIGHBORHOOD_NAMING off the sweep never runs the pass', async () => {
      process.env.GATE_NEIGHBORHOOD_NAMING = 'false';
      const { propertyId } = await home({ code: '#6666', checked: true });
      const lookup = jest.fn();
      const r = await sweepSavedGateCodes({ lookup });
      expect(r.naming).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      expect(await hoodOf(propertyId)).toMatchObject({ name: null });
    });

    test('a pass that crashes counts as a failed step and the filing still runs', async () => {
      const n = await neighborhood('Willow Grande');
      await home({ code: '#7777', neighborhoodId: n, source: 'county', checked: true });
      const spy = jest.spyOn(require('../services/neighborhood-naming'), 'runNamingPass').mockRejectedValue(new Error('boom'));
      const r = await sweepSavedGateCodes({ lookup: jest.fn() });
      spy.mockRestore();
      expect(r).toMatchObject({ failed: 1, tally: { filed: 1 } });
      expect(await accessRows(n)).toEqual([{ code: '#7777', status: 'active', source: 'profile' }]);
    });
  });
});
