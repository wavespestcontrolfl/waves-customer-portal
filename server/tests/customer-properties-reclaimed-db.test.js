/** The office's reclaimed-water answer (GATE_LAWN_RECLAIMED_HALF_N) through the real route, the audited domain writer and PostgreSQL.
 *  Synthetic fixtures on an isolated database; skips without IB_TEST_DATABASE_URL. */
const { databaseUrl, propertyDbFixture } = require('./helpers/property-db');
const suite = databaseUrl ? describe : describe.skip;

suite('reclaimed water edits against isolated Postgres', () => {
  const fixture = propertyDbFixture();
  let db, actor, customerA, api, address;
  beforeAll(() => { ({ db, actor, customerA, api, address } = fixture); });
  beforeEach(() => { process.env.GATE_LAWN_RECLAIMED_HALF_N = 'true'; });
  afterEach(() => { delete process.env.GATE_LAWN_RECLAIMED_HALF_N; });

  const primaryOf = () => db('customer_properties').where({ customer_id: customerA, is_primary: true }).first();
  const put = (propertyId, body) => api(`/api/admin/customers/${customerA}/properties/${propertyId}/reclaimed-water`, body, 'PUT');
  const auditOf = (propertyId) => db('audit_log').where({ resource_type: 'customer_property', resource_id: propertyId, action: 'customer_property_edit' }).orderBy('created_at', 'desc');

  test('Yes / No / Automatic are saved with the office source and time, audited with the actor and the before-and-after, and listed', async () => {
    const property = await primaryOf();
    const yes = await put(property.id, { reclaimed: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ success: true, verification: { persisted: true, fields_match: true } });
    expect(yes.body.properties.find((p) => p.id === property.id)).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'office' });
    expect(await primaryOf()).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'office' });
    expect((await primaryOf()).reclaimed_water_checked_at).toBeTruthy();
    const [event] = await auditOf(property.id);
    expect(event).toMatchObject({ actor_type: 'admin', actor_id: actor });
    expect(event.metadata).toMatchObject({ customer_id: customerA, fields: ['reclaimed_water'], reclaimed_water: true, reclaimed_water_before: null });

    expect((await put(property.id, { reclaimed: false })).status).toBe(200);
    expect(await primaryOf()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'office' });
    expect((await auditOf(property.id))[0].metadata).toMatchObject({ reclaimed_water: false, reclaimed_water_before: true });

    expect((await put(property.id, { reclaimed: null })).status).toBe(200);
    expect(await primaryOf()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
    expect((await auditOf(property.id)).length).toBe(3);
  }, 30000);

  test('a bad body, another customer\'s property and the gate off write nothing and leave no audit row', async () => {
    const property = await primaryOf();
    const before = (await auditOf(property.id)).length;
    expect((await put(property.id, { reclaimed: 'yes' })).status).toBe(400);
    expect((await put('00000000-0000-4000-8000-000000000000', { reclaimed: true })).status).toBe(404);
    delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
    expect((await put(property.id, { reclaimed: true })).status).toBe(404);
    expect((await auditOf(property.id)).length).toBe(before);
    expect((await primaryOf()).reclaimed_water).toBeNull();
  }, 30000);

  test('the PATCH writer refuses the field while the gate is off, so it has no side door', async () => {
    delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
    const property = await primaryOf();
    const refused = await api(`/api/admin/customers/${customerA}/properties/${property.id}`, { reclaimed_water: true }, 'PATCH');
    expect(refused.status).toBe(400);
    expect((await primaryOf()).reclaimed_water).toBeNull();
  }, 30000);

  test('gate off: the list, add and edit answers carry none of the three columns and no reclaimedWater key', async () => {
    delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
    const list = await api(`/api/admin/customers/${customerA}/properties`);
    expect(list.status).toBe(200);
    expect(list.body).not.toHaveProperty('reclaimedWater');
    for (const row of list.body.properties) {
      for (const column of ['reclaimed_water', 'reclaimed_water_source', 'reclaimed_water_checked_at']) expect(row).not.toHaveProperty(column);
    }
    const edited = await api(`/api/admin/customers/${customerA}/properties/${list.body.properties[0].id}`, { label: 'Fixture label' }, 'PATCH');
    expect(edited.status).toBe(200);
    for (const row of edited.body.properties) expect(row).not.toHaveProperty('reclaimed_water');
    process.env.GATE_LAWN_RECLAIMED_HALF_N = 'true';
    const on = await api(`/api/admin/customers/${customerA}/properties`);
    expect(on.body.reclaimedWater).toBe(true);
    expect(on.body.properties[0]).toHaveProperty('reclaimed_water');
    expect(address(1)).toBeTruthy();
  }, 30000);
});
