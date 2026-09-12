/** Synthetic fixtures on isolated PostgreSQL; no live providers. */
const crypto = require('crypto');
const { databaseUrl, propertyDbFixture } = require('./helpers/property-db');
const suite = databaseUrl ? describe : describe.skip;
suite('saved-property operations against isolated Postgres', () => {
  const fixture = propertyDbFixture();
  let db, actor, customerA, customerB, api, address;
  beforeAll(() => { ({ db, actor, customerA, customerB, api, address } = fixture); });

  test('primary change refuses invoice-lock contention without waiting on a billing customer lock', async () => {
    const service = require('../services/customer-properties');
    const invoiceId = crypto.randomUUID();
    await db('invoices').insert({ id: invoiceId, customer_id: customerB, token: crypto.randomBytes(32).toString('hex'), invoice_number: `QA-${invoiceId.slice(0, 8)}` });
    const saved = await service.addManualProperty(customerB, address(600), { actorId: actor });
    const preview = await service.previewManualPropertyChange(customerB, 'primary', {}, saved.propertyId);
    const billing = await db.transaction();
    try {
      await billing('invoices').where('id', invoiceId).forUpdate().first();
      // Independent connection: this used to hold customers while blocking on
      // the locked invoice. NOWAIT must refuse before billing needs customers.
      await expect(service.changePrimaryProperty(customerB, saved.propertyId, { actorId: actor, expectedVersion: preview._version }))
        .rejects.toMatchObject({ code: 'property_busy' });
      await billing.raw("SET LOCAL lock_timeout = '2s'");
      await billing('customers').where('id', customerB).forUpdate().first();
      expect((await billing('customers').where('id', customerB).first()).address_line1).toBe('200 Example Grove');
    } finally { await billing.rollback(); }
    const changed = await service.changePrimaryProperty(customerB, saved.propertyId, { actorId: actor, expectedVersion: preview._version });
    expect(changed.verification.persisted).toBe(true);
  }, 30000);

  test('manual primary waits for preferences before holding comms or customer locks', async () => {
    const service = require('../services/customer-properties');
    const saved = await service.addManualProperty(customerB, address(1300), { actorId: actor });
    const preview = await service.previewManualPropertyChange(customerB, 'primary', {}, saved.propertyId);
    const preferences = await db.transaction();
    let pending;
    try {
      await preferences.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(customerB)]);
      pending = service.changePrimaryProperty(customerB, saved.propertyId, { actorId: actor, expectedVersion: preview._version });
      // Wait for the actual lock waiter, rather than assuming the write started.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await db.raw("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = hashtext(?)::oid AND objid = hashtext(?)::oid", ['property-preferences', String(customerB)]);
        waiting = result.rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await preferences.raw("SET LOCAL lock_timeout = '2s'");
      await require('../utils/customer-comms-lock').lockCustomerComms(preferences, customerB);
      await preferences('customers').where('id', customerB).forUpdate().first();
    } finally { await preferences.rollback(); }
    expect((await pending).verification.persisted).toBe(true);
  }, 30000);

  test('property editor eligibility matches preview guards and updates after occupancy changes', async () => {
    const service = require('../services/customer-properties');
    const saved = await service.addManualProperty(customerB, address(1400), { actorId: actor });
    for (const changes of [
      { occupancy_type: 'rental_investment' }, { occupancy_type: 'commercial' }, { occupancy_type: 'seasonal' }, { occupancy_type: 'vacant' },
      { occupancy_type: 'unknown', property_type: 'office' }, { property_type: null, city: '' },
    ]) {
      await db('customer_properties').where('id', saved.propertyId).update(changes);
      const listed = await api(`/api/admin/customers/${customerB}/properties`);
      const row = listed.body.properties.find(p => p.id === saved.propertyId);
      expect(row.primary_change_eligible).toBe(false);
      expect(row.primary_change_unavailable).toBeTruthy();
      const preview = await api(`/api/admin/customers/${customerB}/properties/${saved.propertyId}/primary-preview`);
      expect(preview.status).toBe(409);
    }
    await db('customer_properties').where('id', saved.propertyId).update({ city: 'Sarasota' });
    const updated = await api(`/api/admin/customers/${customerB}/properties/${saved.propertyId}`, { occupancy_type: 'owner_occupied' }, 'PATCH');
    expect(updated.body.properties.find(p => p.id === saved.propertyId).primary_change_eligible).toBe(true);
    expect((await api(`/api/admin/customers/${customerB}/properties/${saved.propertyId}/primary-preview`)).status).toBe(200);
  }, 30000);

  test('unregistered old account address is preserved; an addressless account gets an accurately verified first property', async () => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID(), emptyCustomer = crypto.randomUUID(), propertyId = crypto.randomUUID(), visitId = crypto.randomUUID();
    await db('customers').insert([
      { id: customerId, first_name: 'Synthetic', last_name: 'Unregistered', phone: `+15551${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, address_line1: '700 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' },
      { id: emptyCustomer, first_name: 'Synthetic', last_name: 'Firstproperty', phone: `+15552${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` },
    ]);
    await db('customer_properties').insert({ id: propertyId, customer_id: customerId, ...address(800), active: true, is_primary: false, address_key: service.addressKey(address(800)) });
    const completedId = crypto.randomUUID();
    await db('scheduled_services').insert([
      { id: visitId, customer_id: customerId, scheduled_date: require('../utils/datetime-et').etDateString(new Date()), service_type: 'General Pest Control', status: 'pending' },
      // A settled, non-recurring visit with no saved service address: its report renders from the account address.
      { id: completedId, customer_id: customerId, scheduled_date: '2026-08-01', service_type: 'General Pest Control', status: 'completed' },
    ]);
    const preview = await service.previewManualPropertyChange(customerId, 'primary', {}, propertyId);
    expect(preview.previous_primary).toMatchObject({ id: null, address: '700 Example Grove, Sarasota, FL, 34201' });
    expect(await db('customer_properties').where({ customer_id: customerId }).count('* as count').first()).toEqual({ count: '1' });
    await service.changePrimaryProperty(customerId, propertyId, { actorId: actor, expectedVersion: preview._version });
    const visit = await db('scheduled_services').where({ id: visitId }).first();
    expect(visit.service_address_line1).toBe('700 Example Grove');
    expect(visit.property_id).not.toBe(propertyId);
    const completed = await db('scheduled_services').where({ id: completedId }).first();
    expect(completed).toMatchObject({ service_address_line1: '700 Example Grove', service_address_city: 'Sarasota', service_address_zip: '34201', property_id: visit.property_id });
    const firstPreview = await service.previewManualPropertyChange(emptyCustomer, 'add', address(900));
    expect(firstPreview.changes.label).toBe('Primary');
    const first = await service.addManualProperty(emptyCustomer, address(900), { actorId: actor, expectedVersion: firstPreview._version });
    expect(first.verification).toMatchObject({ persisted: true, fields_match: true });
    expect(await db('customers').where({ id: emptyCustomer }).first('address_line1')).toEqual({ address_line1: '900 Example Grove' });
  }, 30000);

  test('a rental, family-home or client-managed relationship is ineligible for primary even while occupancy is unknown', async () => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID(), rentalId = crypto.randomUUID(), managedId = crypto.randomUUID(), familyId = crypto.randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Relationshipfixture', phone: `+15553${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, address_line1: '1000 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' });
    await db('customer_properties').insert([
      { id: rentalId, customer_id: customerId, ...address(1100), relationship: 'rental_owned', active: true, is_primary: false, address_key: service.addressKey(address(1100)) },
      { id: managedId, customer_id: customerId, ...address(1200), relationship: 'managed_for_client', active: true, is_primary: false, address_key: service.addressKey(address(1200)) },
      { id: familyId, customer_id: customerId, ...address(1250), relationship: 'family_home', active: true, is_primary: false, address_key: service.addressKey(address(1250)) },
    ]);
    for (const id of [rentalId, managedId, familyId]) {
      await expect(service.previewManualPropertyChange(customerId, 'primary', {}, id)).rejects.toMatchObject({ code: 'primary_role_unavailable' });
      const { relationship } = await db('customer_properties').where({ id }).first('relationship');
      await db('customer_properties').where({ id }).update({ relationship: 'own_home' });
      const preview = await service.previewManualPropertyChange(customerId, 'primary', {}, id);
      await db('customer_properties').where({ id }).update({ relationship });
      await expect(service.changePrimaryProperty(customerId, id, { actorId: actor, expectedVersion: preview._version }))
        .rejects.toMatchObject({ code: 'primary_role_unavailable' });
    }
    for (const row of await service.listProperties(customerId)) expect(row).toMatchObject({ primary_change_eligible: false, primary_change_unavailable: expect.stringContaining('relationship') });
    expect(await db('customers').where({ id: customerId }).first('address_line1')).toEqual({ address_line1: '1000 Example Grove' });
    // Correcting the relationship restores eligibility.
    await db('customer_properties').where({ id: rentalId }).update({ relationship: 'own_home' });
    expect((await service.previewManualPropertyChange(customerId, 'primary', {}, rentalId)).primary_property.id).toBe(rentalId);
  }, 30000);

  test('tenant accounts refuse primary promotion in the list, preview and confirmation even with unknown occupancy', async () => {
    const service = require('../services/customer-properties');
    const saved = await service.addManualProperty(customerA, address(1800), { actorId: actor });
    const beforeCustomer = await db('customers').where({ id: customerA }).first();
    const beforeProperty = await db('customer_properties').where({ id: saved.propertyId }).first();
    const preview = await service.previewManualPropertyChange(customerA, 'primary', {}, saved.propertyId);
    await db('customers').where({ id: customerA }).update({ contact_role: 'tenant', updated_at: db.fn.now() });
    try {
      const listed = await api(`/api/admin/customers/${customerA}/properties`);
      expect(listed.body.properties.find(p => p.id === saved.propertyId)).toMatchObject({ primary_change_eligible: false,
        primary_change_unavailable: expect.stringContaining('tenant') });
      expect(await api(`/api/admin/customers/${customerA}/properties/${saved.propertyId}/primary-preview`))
        .toMatchObject({ status: 409, body: { code: 'primary_role_unavailable' } });
      expect(await api(`/api/admin/customers/${customerA}/properties/${saved.propertyId}/primary`, { expectedVersion: preview._version }))
        .toMatchObject({ status: 409, body: { code: 'primary_role_unavailable' } });
      expect(await db('customer_properties').where({ id: saved.propertyId }).first()).toEqual(beforeProperty);
      expect((await db('customers').where({ id: customerA }).first()).address_line1).toBe(beforeCustomer.address_line1);
    } finally { await db('customers').where({ id: customerA }).update({ contact_role: beforeCustomer.contact_role, updated_at: db.fn.now() }); }
  }, 30000);

  test.each([['itself', true], ['another property', false]])('a legacy account row saved as non-primary supports selecting %s', async (_choice, selectAccountRow) => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID(), savedAccountRow = crypto.randomUUID(), targetId = crypto.randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Legacyrowfixture', phone: `+15554${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`, address_line1: '1300 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' });
    await db('customer_properties').insert([
      { id: savedAccountRow, customer_id: customerId, ...address(1300, 'Home'), active: true, is_primary: false, address_key: service.addressKey(address(1300)) },
      { id: targetId, customer_id: customerId, ...address(1400), active: true, is_primary: false, address_key: service.addressKey(address(1400)) },
    ]);
    const selectedId = selectAccountRow ? savedAccountRow : targetId;
    const preview = await service.previewManualPropertyChange(customerId, 'primary', {}, selectedId);
    const changed = await service.changePrimaryProperty(customerId, selectedId, { actorId: actor, expectedVersion: preview._version });
    expect(changed.verification).toMatchObject({ persisted: true, fields_match: true });
    expect(await db('customers').where({ id: customerId }).first('address_line1')).toEqual({ address_line1: selectAccountRow ? '1300 Example Grove' : '1400 Example Grove' });
    expect(await db('customer_properties').where({ customer_id: customerId }).count('* as count').first()).toEqual({ count: '2' });
    expect(await db('customer_properties').where({ id: savedAccountRow }).first('is_primary', 'label')).toEqual({ is_primary: selectAccountRow, label: 'Home' });
    expect(await db('customer_properties').where({ id: targetId }).first('is_primary')).toEqual({ is_primary: !selectAccountRow });
    expect((await db('customer_properties').where({ id: selectedId }).first()).occupancy_type).toBe('owner_occupied');
  }, 30000);

  test('a primary change preserves linked unstamped completed visits without rewriting saved or other-property addresses', async () => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Linkedreportfixture',
      phone: `+15555${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
      address_line1: '1500 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201' });
    await service.ensurePrimaryProperty(customerId);
    const oldPrimary = await db('customer_properties').where({ customer_id: customerId, is_primary: true }).first();
    const target = await service.addManualProperty(customerId, address(1600), { actorId: actor });
    const unstamped = crypto.randomUUID(), stamped = crypto.randomUUID(), otherProperty = crypto.randomUUID();
    const legacyVisits = [
      { address: '1600 Example Grove, Sarasota, FL 34201', preserved: false },
      { address: '1500 Example Grove Unit 5', preserved: false },
      { address: '1500 Example Grove, Sarasota, FL 34201', preserved: true },
      { address: null, preserved: true },
    ].map(row => ({ ...row, estimateId: crypto.randomUUID(), visitId: crypto.randomUUID() }));
    await db('estimates').insert(legacyVisits.map(row => ({ id: row.estimateId, customer_id: customerId, address: row.address, property_id: null })));
    await db('scheduled_services').insert([
      { id: unstamped, property_id: oldPrimary.id },
      { id: stamped, property_id: oldPrimary.id, service_address_line1: '1550 Saved Address', service_address_city: 'Sarasota' },
      { id: otherProperty, property_id: target.propertyId },
      ...legacyVisits.map(row => ({ id: row.visitId, source_estimate_id: row.estimateId, property_id: null })),
    ].map(row => ({ customer_id: customerId, scheduled_date: '2026-08-01', service_type: 'General Pest Control', status: 'completed', ...row })));
    const preview = await api(`/api/admin/customers/${customerId}/properties/${target.propertyId}/primary-preview`);
    expect(preview.status).toBe(200);
    const changed = await api(`/api/admin/customers/${customerId}/properties/${target.propertyId}/primary`, { expectedVersion: preview.body._version });
    expect(changed.status).toBe(200);
    expect(await db('scheduled_services').where({ id: unstamped }).first()).toMatchObject({
      property_id: oldPrimary.id, service_address_line1: '1500 Example Grove', service_address_city: 'Sarasota', service_address_zip: '34201',
    });
    expect(await db('scheduled_services').where({ id: stamped }).first()).toMatchObject({ property_id: oldPrimary.id, service_address_line1: '1550 Saved Address' });
    expect(await db('scheduled_services').where({ id: otherProperty }).first()).toMatchObject({ property_id: target.propertyId, service_address_line1: null });
    for (const row of legacyVisits) {
      expect(await db('scheduled_services').where({ id: row.visitId }).first()).toMatchObject({
        property_id: row.preserved ? oldPrimary.id : null,
        service_address_line1: row.preserved ? oldPrimary.address_line1 : null,
      });
    }
    expect(await db('customers').where({ id: customerId }).first('address_line1')).toEqual({ address_line1: '1600 Example Grove' });
  }, 30000);

  test('the portal refuses a duplicate of a same-street partial primary before completing its address', async () => {
    const customerC = crypto.randomUUID(), primaryC = crypto.randomUUID();
    // Legacy data: the account and its primary carry the street but no city or ZIP.
    await db('customers').insert({ id: customerC, first_name: 'Fixture', last_name: `Cedar${customerC.slice(0, 8)}`, address_line1: '700 Example Grove',
      city: '', state: 'FL', zip: '', phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` });
    const properties = require('../services/customer-properties');
    await db('customer_properties').insert({ id: primaryC, customer_id: customerC, address_line1: '700 Example Grove', city: '', state: 'FL', zip: '',
      is_primary: true, active: true, occupancy_type: 'unknown', source: 'manual', address_key: properties.addressKey({ address_line1: '700 Example Grove' }) });
    expect((await api(`/api/admin/customers/${customerC}/properties`, address(700))).status).toBe(409);
    // The refused preview completed nothing and saved nothing.
    expect(await db('customer_properties').where({ customer_id: customerC })).toHaveLength(1);
    expect((await db('customers').where('id', customerC).first()).city).toBe('');
    // A genuinely different street on the same customer still previews.
    expect((await api(`/api/admin/customers/${customerC}/properties`, address(710))).status).toBe(201);
  }, 30000);

  test.each(['Unit 4', null])('a primary change completes compatible partial settled addresses without replacing saved components or conflicting addresses (old unit: %s)', async (line2) => {
    const service = require('../services/customer-properties');
    const customerId = crypto.randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Partialstampfixture',
      phone: `+15556${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`,
      address_line1: '2100 Example Court', address_line2: line2, city: 'Sarasota', state: 'FL', zip: '34201' });
    await service.ensurePrimaryProperty(customerId);
    const oldPrimary = await db('customer_properties').where({ customer_id: customerId, is_primary: true }).first();
    const target = await service.addManualProperty(customerId, { ...address(2200), address_line2: 'Unit 9', city: 'Bradenton', zip: '34212' }, { actorId: actor });
    const compatible = [
      { property_id: oldPrimary.id, service_address_line1: '2100 Example Ct', service_address_line2: line2 ? 'Apt 4' : '', lat: '0.000000', lng: '0.000000' },
      { property_id: null, service_address_line1: '2100 Example Court', service_address_city: 'Sarasota', service_address_zip: '34201-1234' },
    ].map(row => ({ id: crypto.randomUUID(), ...row }));
    const conflicts = [
      { service_address_line1: '2150 Other Court' },
      { service_address_line1: '2100 Example Court Unit 5' },
      { service_address_line1: '2100 Example Court', service_address_line2: 'Unit 5' },
      { service_address_line1: '2100 Example Court', service_address_city: 'Bradenton' },
      { service_address_line1: '2100 Example Court', service_address_state: 'GA' },
      { service_address_line1: '2100 Example Court', service_address_zip: '34212' },
      { service_address_city: 'Bradenton' },
    ].map(row => ({ id: crypto.randomUUID(), property_id: oldPrimary.id, ...row }));
    await db('scheduled_services').insert([...compatible, ...conflicts].map(row => ({ customer_id: customerId,
      scheduled_date: '2026-08-01', service_type: 'General Pest Control', status: 'completed', ...row })));
    const untouched = await db('scheduled_services').whereIn('id', conflicts.map(row => row.id)).orderBy('id');
    const preview = await service.previewManualPropertyChange(customerId, 'primary', {}, target.propertyId);
    await service.changePrimaryProperty(customerId, target.propertyId, { actorId: actor, expectedVersion: preview._version });
    for (const row of compatible) {
      expect(await db('scheduled_services').where({ id: row.id }).first()).toMatchObject({
        service_address_line2: line2 || '', service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34201',
        ...row, property_id: oldPrimary.id,
      });
    }
    expect(await db('scheduled_services').whereIn('id', conflicts.map(row => row.id)).orderBy('id')).toEqual(untouched);
    expect(await db('customers').where({ id: customerId }).first('city', 'zip')).toEqual({ city: 'Bradenton', zip: '34212' });
  }, 30000);

});
