// Real PostgreSQL transaction (rolled back). All names, addresses and codes
// are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
const { randomUUID } = require('node:crypto');
const { neighborhoodGateEntriesForVisits } = require('../services/neighborhood-access');

jest.setTimeout(30000);
postgres('neighborhood gate entries for the day feed', () => {
  let database;
  let trx;

  const neighborhood = async (name) => {
    const [row] = await trx('neighborhoods')
      .insert({ name, county: 'Manatee', match_key: `manatee|${name.toLowerCase()} ${randomUUID()}`, source: 'county' })
      .returning('id');
    return row.id;
  };
  const customer = async (neighborhoodIds) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+12025550177', email: `${id}@example.invalid` });
    const propertyIds = [];
    for (const [i, n] of neighborhoodIds.entries()) {
      const propertyId = randomUUID();
      await trx('customer_properties').insert({
        id: propertyId, customer_id: id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: i === 0,
        address_line1: `${100 + i} Synthetic Way`, city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
        neighborhood_id: n, neighborhood_source: n ? 'county' : null,
      });
      propertyIds.push(propertyId);
    }
    return { id, propertyIds };
  };
  const entry = (neighborhoodId, fields) => trx('neighborhood_access')
    .insert({ neighborhood_id: neighborhoodId, access_type: 'keypad', source: 'office', ...fields });

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(() => database.destroy());

  test("a visit's stamped property, else the customer's one active property; several = none", async () => {
    const n1 = await neighborhood('Stamped Grove');
    const n2 = await neighborhood('Single Grove');
    await entry(n1, { code: '1212', status: 'active' });
    await entry(n2, { code: '3434', status: 'active' });
    const stamped = await customer([n2, n1]);
    const single = await customer([n2]);
    const several = await customer([n1, n2]);
    const map = await neighborhoodGateEntriesForVisits(trx, [
      { id: 'v1', customer_id: stamped.id, property_id: stamped.propertyIds[1] },
      { id: 'v2', customer_id: single.id, property_id: null },
      { id: 'v3', customer_id: several.id, property_id: null },
    ]);
    expect(map.get('v1').map((e) => e.code)).toEqual(['1212']);
    expect(map.get('v2').map((e) => e.code)).toEqual(['3434']);
    expect(map.has('v3')).toBe(false);
  });

  test('confirmed entries and unconfirmed keypad codes only; never an unconfirmed instruction or a retired code', async () => {
    const n = await neighborhood('Mixed Grove');
    await entry(n, { code: '2566', status: 'active' });
    await entry(n, { code: '2556', status: 'needs_confirm' });
    await entry(n, { code: '1999', status: 'retired' });
    await entry(n, { access_type: 'instructions', code: null, instructions: 'Text me at the gate', status: 'needs_confirm' });
    await entry(n, { access_type: 'guard', code: null, instructions: 'Give the guard the address', gate_label: 'Guard', status: 'active' });
    const c = await customer([n]);
    const map = await neighborhoodGateEntriesForVisits(trx, [{ id: 'v', customer_id: c.id, property_id: c.propertyIds[0] }]);
    expect(map.get('v').map((e) => [e.status, e.code || e.instructions])).toEqual([
      ['active', 'Give the guard the address'],
      ['active', '2566'],
      ['needs_confirm', '2556'],
    ]);
  });

  test('a visit stamped at another address with no property link gets no fallback; at the same address it does', async () => {
    const n = await neighborhood('Stamp Check');
    await entry(n, { code: '5656', status: 'active' });
    const c = await customer([n]);
    const map = await neighborhoodGateEntriesForVisits(trx, [
      { id: 'elsewhere', customer_id: c.id, property_id: null, service_address_line1: '900 Rental Road', service_address_zip: '34202' },
      { id: 'same', customer_id: c.id, property_id: null, service_address_line1: '100 Synthetic Way', service_address_zip: '34202-1234' },
      { id: 'other-zip', customer_id: c.id, property_id: null, service_address_line1: '100 Synthetic Way', service_address_zip: '34211' },
    ]);
    expect(map.has('elsewhere')).toBe(false);
    expect(map.get('same').map((e) => e.code)).toEqual(['5656']);
    expect(map.has('other-zip')).toBe(false);
  });

  test('no neighborhood link = no entry', async () => {
    const c = await customer([null]);
    const map = await neighborhoodGateEntriesForVisits(trx, [{ id: 'v', customer_id: c.id, property_id: c.propertyIds[0] }]);
    expect(map.size).toBe(0);
  });
});
