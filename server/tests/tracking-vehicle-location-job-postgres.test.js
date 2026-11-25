/**
 * resolveFreshTechPosition({ requireCurrentJobIds }) on real PostgreSQL (a visit text recipient's tracker link).
 *
 * The recipient's truck is read in ONE statement: technicians LEFT JOIN tech_status, where the tech_status row joins only while its
 * current_job_id is one of the named visits. So the job condition and the coordinates come out of the same SELECT: a technician whose
 * active job is another visit (a grouped visit's sibling included) yields no fix, with no second read to race. Synthetic data only.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));

(SKIP ? describe.skip : describe)('resolveFreshTechPosition with requireCurrentJobIds on PostgreSQL', () => {
  let db;
  let resolveFreshTechPosition;
  let techId;
  let customerId;
  let visitA;
  let visitB;

  beforeAll(() => {
    db = require('../models/db');
    ({ resolveFreshTechPosition } = require('../services/tracking-vehicle-location'));
  });
  afterAll(async () => { await db.destroy(); });

  beforeEach(async () => {
    [{ id: customerId }] = await db('customers').insert({ first_name: 'Phyllis', last_name: 'Roe', phone: `+1941${String(Math.floor(1e7 + Math.random() * 8e7)).slice(0, 7)}` }).returning('id');
    [{ id: techId }] = await db('technicians').insert({ name: 'Pat Zztech' }).returning('id');
    [visitA, visitB] = (await db('scheduled_services').insert([
      { customer_id: customerId, scheduled_date: '2031-03-14', service_type: 'Pest Control', status: 'en_route' },
      { customer_id: customerId, scheduled_date: '2031-03-14', service_type: 'Lawn Care', status: 'en_route' },
    ]).returning('id')).map((r) => r.id);
    await db('tech_status').insert({
      tech_id: techId, status: 'en_route', lat: 27.2, lng: -82.2, current_job_id: visitB,
      location_updated_at: new Date(), location_received_at: new Date(),
    });
  });
  afterEach(async () => {
    await db('tech_status').where({ tech_id: techId }).del();
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
    await db('technicians').where({ id: techId }).del();
  });

  const ask = (ids, extra = {}) => resolveFreshTechPosition({ techId, allowBouncieFallback: false, strict: true, requireCurrentJobIds: ids, ...extra });

  test('the fix comes back only while current_job_id is exactly the asked visit', async () => {
    expect(await ask([visitB])).toMatchObject({ lat: 27.2, lng: -82.2, source: 'tech_status' });
    expect(await ask([visitA])).toBeNull();
    // a grouped visit's focus moved to the sibling: the first visit asks for its own id only and gets nothing
    expect(await ask([visitA, '00000000-0000-0000-0000-000000000000'])).toBeNull();
  });

  test('no technician job at all (null), or a stale job, is no fix; the default read is unchanged', async () => {
    await db('tech_status').where({ tech_id: techId }).update({ current_job_id: null });
    expect(await ask([visitA])).toBeNull();
    expect(await ask([visitB])).toBeNull();
    // without the option the cached fix is served as before (a holder's tracker)
    expect(await resolveFreshTechPosition({ techId, allowBouncieFallback: false })).toMatchObject({ lat: 27.2 });
  });

  test('the condition is in the SQL of the one statement', async () => {
    const queries = [];
    const onQuery = (q) => queries.push(q.sql);
    db.on('query', onQuery);
    try { await ask([visitB]); } finally { db.removeListener('query', onQuery); }
    const selects = queries.filter((sql) => /from "technicians"/i.test(sql));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatch(/ts\.current_job_id::text = ANY/);
  });
});
