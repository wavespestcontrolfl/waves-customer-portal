// A home linked from the customer's own words (neighborhood_source 'caller') is
// unconfirmed: its visitor pass is never shared with the neighborhood, and no
// pass is shared into a visit at such a home (access-code-capture neighborPasses).
// Real PostgreSQL transaction (rolled back). All names and links are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((name, work) => work()) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const { randomUUID } = require('node:crypto');
const access = require('../services/access-code-capture');

jest.setTimeout(30000);
postgres('caller-linked homes and shared visitor passes', () => {
  let database;
  let trx;
  const OLD_GATE = process.env.GATE_NEIGHBORHOOD_ACCESS;
  const LINK = 'https://pass.example.com/v/abc';

  const hood = async () => {
    const id = randomUUID();
    await trx('neighborhoods').insert({ id, name: 'Example Glen', county: 'Manatee', match_key: `manatee|example glen|${id}`, source: 'customer' });
    return id;
  };
  const homeIn = async (hoodId, source, house) => {
    const id = randomUUID();
    const propertyId = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Owner', phone: '+19415550142', email: `${id}@example.invalid` });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: id, label: 'Synthetic', occupancy_type: 'owner_occupied', is_primary: true,
      address_line1: `${house} Example Lane`, city: 'Lakewood Ranch', zip: '34202', active: true, address_key: randomUUID(),
      neighborhood_id: hoodId, neighborhood_source: source,
    });
    return { id, propertyId };
  };
  const standingPass = (c) => trx('customer_access_codes').insert({
    customer_id: c.id, property_id: c.propertyId, kind: 'pass', code: null, instructions: `View your pass: ${LINK}`, life: 'standing',
    status: 'active', source_type: 'staff', source_quote: 'q', value_hash: access.valueHash(null, `View your pass: ${LINK}`),
  });
  const codesAtVisit = async (c) => {
    const visitId = randomUUID();
    await trx('scheduled_services').insert({ id: visitId, customer_id: c.id, property_id: c.propertyId, scheduled_date: '2040-03-10', service_type: 'Pest Control', status: 'confirmed' });
    return (await access.listForVisit(trx, { techRole: 'admin' }, visitId)).codes.map((r) => r.instructions);
  };

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    process.env.GATE_NEIGHBORHOOD_ACCESS = 'true';
    trx = await database.transaction();
    mockConnection = trx;
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_NEIGHBORHOOD_ACCESS;
    else process.env.GATE_NEIGHBORHOOD_ACCESS = OLD_GATE;
  });
  afterAll(() => database.destroy());

  test('control: a pass on a county-linked home is shared with a county-linked neighbor', async () => {
    const h = await hood();
    await standingPass(await homeIn(h, 'county', '4455'));
    expect(await codesAtVisit(await homeIn(h, 'county', '4460'))).toEqual([`Visitor pass: ${LINK}`]);
  });

  test('a pass on a caller-linked home is not shared out to neighbors', async () => {
    const h = await hood();
    await standingPass(await homeIn(h, 'caller', '4455'));
    expect(await codesAtVisit(await homeIn(h, 'county', '4460'))).toEqual([]);
  });

  test('no pass is shared into a visit at a caller-linked home', async () => {
    const h = await hood();
    await standingPass(await homeIn(h, 'county', '4455'));
    expect(await codesAtVisit(await homeIn(h, 'caller', '4460'))).toEqual([]);
  });

  test('an office-picked neighbor still gets a county home\'s pass', async () => {
    const h = await hood();
    await standingPass(await homeIn(h, 'county', '4455'));
    expect(await codesAtVisit(await homeIn(h, 'office', '4460'))).toEqual([`Visitor pass: ${LINK}`]);
  });
});
