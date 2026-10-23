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
    expect(event.metadata).toMatchObject({ customer_id: customerA, fields: ['reclaimed_water'], values: { reclaimed_water: true }, before: { reclaimed_water: null } });

    expect((await put(property.id, { reclaimed: false })).status).toBe(200);
    expect(await primaryOf()).toMatchObject({ reclaimed_water: false, reclaimed_water_source: 'office' });
    expect((await auditOf(property.id))[0].metadata).toMatchObject({ values: { reclaimed_water: false }, before: { reclaimed_water: true } });

    expect((await put(property.id, { reclaimed: null })).status).toBe(200);
    expect(await primaryOf()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
    expect((await auditOf(property.id)).length).toBe(3);
  }, 30000);

  test('a merged-away copy\'s office answer counts until the office answers this home; then "Automatic" really returns it to the county', async () => {
    const { isReclaimedService } = require('../services/lawn-reclaimed-water');
    const property = await primaryOf();
    expect((await put(property.id, { reclaimed: null })).status).toBe(200);
    // What a customer merge leaves: the loser's copy of the same address, deactivated, its columns not moved.
    const { id: _id, created_at: _c, updated_at: _u, ...copy } = property;
    const [merged] = await db('customer_properties').insert({
      ...copy, is_primary: false, active: false, reclaimed_water: true, reclaimed_water_source: 'office', reclaimed_water_checked_at: new Date(),
    }).returning('id');
    const mergedId = merged.id || merged;
    const visit = { id: 'svc-merged', property_id: property.id, customer_id: customerA };
    try {
      expect(await isReclaimedService(db, visit)).toBe(true);
      // The panel shows the answer the plan uses, marked as inherited, so the office can see it and reset it.
      const listed = (await api(`/api/admin/customers/${customerA}/properties`)).body.properties.find((p) => p.id === property.id);
      expect(listed).toMatchObject({ reclaimed_water: true, reclaimed_water_source: 'office', reclaimed_water_inherited: true });
      const reset = await put(property.id, { reclaimed: null });
      expect(reset.status).toBe(200);
      expect(reset.body.properties.find((p) => p.id === property.id)).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
      expect(reset.body.properties.find((p) => p.id === property.id)).not.toHaveProperty('reclaimed_water_inherited');
      expect(await db('customer_properties').where({ id: mergedId }).first()).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
      expect(await isReclaimedService(db, visit)).toBe(false);
    } finally {
      await db('customer_properties').where({ id: mergedId }).del();
    }
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

  describe('a staff-added service address keeps the picker\'s coordinates', () => {
    const post = (body) => api(`/api/admin/customers/${customerA}/properties`, body, 'POST');
    const rowOf = (id) => db('customer_properties').where({ id }).first();
    let n = 7000;
    const next = () => ({ ...address((n += 1)), state: 'FL' });

    test('valid coordinates are stored (7 decimals); the insert does not trip the coordinate-change trigger, and a later pin move still clears a county verdict', async () => {
      const res = await post({ ...next(), latitude: 27.58211234, longitude: '-82.42763456' });
      expect(res.status).toBe(201);
      const row = await rowOf(res.body.propertyId);
      expect(Number(row.latitude)).toBeCloseTo(27.5821123, 6);
      expect(Number(row.longitude)).toBeCloseTo(-82.4276346, 6);
      // BEFORE UPDATE trigger only: an insert leaves the three reclaimed columns as the insert wrote them (NULL).
      expect(row).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null, reclaimed_water_checked_at: null });
      // A later pin move on a county-judged row does clear the verdict (the trigger works on rows born with coordinates too).
      await db('customer_properties').where({ id: row.id }).update({ reclaimed_water: true, reclaimed_water_source: 'county_meter', reclaimed_water_checked_at: new Date() });
      await db('customer_properties').where({ id: row.id }).update({ latitude: 27.6, longitude: -82.4 });
      expect(await rowOf(row.id)).toMatchObject({ reclaimed_water: null, reclaimed_water_source: null });
    });

    test('GATE_LAWN_RECLAIMED_HALF_N off: valid picker coordinates are not stored (the old insert)', async () => {
      delete process.env.GATE_LAWN_RECLAIMED_HALF_N;
      const res = await post({ ...next(), latitude: 27.58211234, longitude: -82.42763456 });
      expect(res.status).toBe(201);
      const row = await rowOf(res.body.propertyId);
      expect(row.latitude).toBeNull();
      expect(row.longitude).toBeNull();
    });

    test.each([
      ['no coordinates', {}],
      ['only a latitude', { latitude: 27.5 }],
      ['not numbers', { latitude: 'north', longitude: 'west' }],
      ['out of range', { latitude: 127.5, longitude: -82.4 }],
      ['null, zero and booleans', { latitude: 0, longitude: 0 }],
      ['booleans', { latitude: true, longitude: false }],
    ])('%s: the address is saved without coordinates', async (_label, coords) => {
      const res = await post({ ...next(), ...coords });
      expect(res.status).toBe(201);
      const row = await rowOf(res.body.propertyId);
      expect(row.latitude).toBeNull();
      expect(row.longitude).toBeNull();
    });
  });
});
