/** Synthetic fixtures on isolated PostgreSQL; no live providers. */
const crypto = require('crypto');
const { databaseUrl, propertyDbFixture } = require('./helpers/property-db');
const suite = databaseUrl ? describe : describe.skip;
suite('property UI and Intelligence Bar against isolated Postgres', () => {
  const fixture = propertyDbFixture();
  let db, actor, customerA, customerB, api, propose, confirm, address, call, mockModel, sessionId;
  beforeAll(() => { ({ db, actor, customerA, customerB, api, propose, confirm, address, call, mockModel, sessionId } = fixture); });

  test('two properties, relabel, primary change preserve billing and service locations; B is untouched', async () => {
    const beforeB = await db('customers').where({ id: customerB }).first();
    const beforeBProperties = await db('customer_properties').where({ customer_id: customerB });
    const oldPrimary = await db('customer_properties').where({ customer_id: customerA, is_primary: true }).first();
    const visits = [crypto.randomUUID(), crypto.randomUUID()];
    const historyId = crypto.randomUUID(), invoiceId = crypto.randomUUID(), invoiceToken = crypto.randomBytes(32).toString('hex');
    const date = require('../utils/datetime-et').etDateString(new Date());
    await db('scheduled_services').insert([
      { id: visits[0], customer_id: customerA, scheduled_date: date, service_type: 'General Pest Control', status: 'pending' },
      { id: visits[1], customer_id: customerA, scheduled_date: date, service_type: 'General Pest Control', status: 'completed', is_recurring: true, recurring_ongoing: true },
    ]);
    await db('service_records').insert({ id: historyId, customer_id: customerA, service_date: date, service_type: 'General Pest Control' });
    await db('invoices').insert({ id: invoiceId, customer_id: customerA, token: invoiceToken,
      invoice_number: `QA-${invoiceId.slice(0, 8)}`, status: 'paid', total: 89, subtotal: 89, paid_at: new Date(), line_items: JSON.stringify([]) });
    const historyBefore = await db('service_records').where({ id: historyId }).first();
    const invoiceBefore = await db('invoices').where({ id: invoiceId }).first();
    const first = await propose('add_customer_property', { customer_id: customerA, ...address(300, 'Family') }, 'Add a saved property at 300 Example Grove, Sarasota FL 34201');
    expect(first.body.taskTarget.customer_id).toBe(customerA);
    expect((await db('customer_properties').where({ customer_id: customerA })).length).toBe(1);
    const added = await confirm(first);
    expect(added.body).toMatchObject({ success: true, outcome: 'completed', result: { verification: { persisted: true } } });
    const propertyId = added.body.result.propertyId;
    const second = await confirm(await propose('add_customer_property', { customer_id: customerA, ...address(400, 'Rental') }, 'Add a saved property at 400 Example Grove, Sarasota FL 34201'));
    expect(second.body.success).toBe(true);
    expect((await db('customer_properties').where({ customer_id: customerA })).length).toBe(3);
    const relabeled = await confirm(await propose('update_customer_property', { customer_id: customerA, property_id: oldPrimary.id, label: 'Former residence' }, 'Relabel the current primary Former residence'));
    expect(relabeled.body.success).toBe(true);
    const primary = await propose('set_primary_property', { customer_id: customerA, property_id: propertyId }, 'Make the saved 300 Example Grove property primary');
    const changed = await confirm(primary);
    expect(changed.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await db('customers').where({ id: customerA }).first('address_line1')).toEqual({ address_line1: '300 Example Grove' });
    expect(await db('customer_properties').where({ id: oldPrimary.id }).first('label', 'is_primary')).toEqual({ label: 'Former residence', is_primary: false });
    for (const id of visits) expect(await db('scheduled_services').where({ id }).first('property_id', 'service_address_line1'))
      .toEqual({ property_id: oldPrimary.id, service_address_line1: '100 Example Grove' });
    expect(await db('service_records').where({ id: historyId }).first()).toEqual(historyBefore);
    const invoiceAfter = await db('invoices').where({ id: invoiceId }).first();
    expect(invoiceAfter).toEqual({ ...invoiceBefore, customer_address_snapshot: expect.objectContaining({ address_line1: '100 Example Grove' }) });
    const Invoice = require('../services/invoice');
    expect((await Invoice.getById(invoiceId)).customer.address_line1).toBe('100 Example Grove');
    expect((await Invoice.getByToken(invoiceToken)).customer.address_line1).toBe('100 Example Grove');
    const receipt = await api(`/api/receipt/${invoiceToken}`);
    expect(receipt.status).toBe(200);
    expect(JSON.stringify(receipt.body)).toContain('100 Example Grove');
    expect(JSON.stringify(receipt.body)).not.toContain('300 Example Grove');
    expect(await db('customers').where({ id: customerB }).first()).toEqual(beforeB);
    expect(await db('customer_properties').where({ customer_id: customerB })).toEqual(beforeBProperties);
    const replay = await confirm(primary);
    expect(replay.status).toBe(409);
    expect(await db('audit_log').where({ action: 'customer_property_primary', resource_id: propertyId }).count('* as count').first()).toEqual({ count: '1' });
  }, 60000);

  test('portal and IB preserve and clear property relationships independently of occupancy', async () => {
    const beforeB = await db('customer_properties').where({ customer_id: customerB });
    const input = { ...address(650, 'Family residence'), relationship: 'family_home', occupancy_type: 'owner_occupied' };
    const proposed = await propose('add_customer_property', { customer_id: customerA, ...input },
      'Add the family home property at 650 Example Grove, Sarasota FL 34201 with owner-occupied occupancy');
    expect(proposed.body.pendingActions[0].contract.effects).toContainEqual(expect.objectContaining({ label: 'relationship: family home' }));
    const added = await confirm(proposed);
    expect(added.body.success).toBe(true);
    const propertyId = added.body.result.propertyId;
    expect(await db('customer_properties').where('id', propertyId).first('relationship', 'occupancy_type'))
      .toEqual({ relationship: 'family_home', occupancy_type: 'owner_occupied' });
    const portal = await api(`/api/admin/customers/${customerA}/properties`, { ...input, ...address(660), relationship: 'family_home' });
    expect(portal.status).toBe(201);
    expect((await db('customer_properties').where('id', portal.body.propertyId).first()).relationship).toBe('family_home');
    const changed = await confirm(await propose('update_customer_property', { customer_id: customerA, property_id: propertyId,
      relationship: 'rental_owned' }, 'Change the saved 650 Example Grove property relationship to rental owned'));
    expect(changed.body.success).toBe(true);
    const cleared = await api(`/api/admin/customers/${customerA}/properties/${propertyId}`, { relationship: null }, 'PATCH');
    expect(cleared.status).toBe(200);
    expect(await db('customer_properties').where('id', propertyId).first('relationship', 'occupancy_type'))
      .toEqual({ relationship: null, occupancy_type: 'owner_occupied' });
    const blankCustomer = crypto.randomUUID();
    await db('customers').insert({ id: blankCustomer, first_name: 'Synthetic', last_name: 'Manager', contact_role: 'property_manager',
      phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` });
    const service = require('../services/customer-properties');
    const firstInput = { ...address(670), relationship: null };
    const preview = await service.previewManualPropertyChange(blankCustomer, 'add', firstInput);
    expect(preview.changes.relationship).toBe('managed_for_client');
    const saved = await service.addManualProperty(blankCustomer, firstInput, { actorId: actor, expectedVersion: preview._version });
    expect(saved.verification.persisted).toBe(true);
    expect((await db('customer_properties').where('id', saved.propertyId).first()).relationship).toBe('managed_for_client');
    expect(await db('customer_properties').where({ customer_id: customerB })).toEqual(beforeB);
  }, 60000);

  test('billing contention is a confirmed failure through portal and IB, never an unknown outcome', async () => {
    const service = require('../services/customer-properties');
    const saved = await service.addManualProperty(customerA, address(1500), { actorId: actor });
    const invoiceId = crypto.randomUUID();
    await db('invoices').insert({ id: invoiceId, customer_id: customerA, token: crypto.randomBytes(32).toString('hex'), invoice_number: `QA-${invoiceId.slice(0, 8)}` });
    // Include the invoice in the preview; contention is the only failure.
    const refreshed = await propose('set_primary_property', { customer_id: customerA, property_id: saved.propertyId }, 'Make the saved 1500 Example Grove property primary');
    const livePreview = await service.previewManualPropertyChange(customerA, 'primary', {}, saved.propertyId);
    const billing = await db.transaction();
    try {
      await billing('invoices').where('id', invoiceId).forUpdate().first();
      const portal = await api(`/api/admin/customers/${customerA}/properties/${saved.propertyId}/primary`, { expectedVersion: livePreview._version });
      expect(portal).toMatchObject({ status: 409, body: { code: 'property_busy' } });
      const ib = await confirm(refreshed);
      expect(ib.body).toMatchObject({ success: false, outcome: 'failed', result: { code: 'property_busy' } });
      expect((await db('customer_properties').where('id', saved.propertyId).first()).is_primary).toBe(false);
    } finally { await billing.rollback(); }
  }, 60000);

  test('tenant accounts refuse primary promotion in the list, preview and confirmation even with unknown occupancy', async () => {
    const service = require('../services/customer-properties');
    const saved = await service.addManualProperty(customerA, address(1800), { actorId: actor });
    const beforeCustomer = await db('customers').where({ id: customerA }).first();
    const beforeProperty = await db('customer_properties').where({ id: saved.propertyId }).first();
    const preview = await service.previewManualPropertyChange(customerA, 'primary', {}, saved.propertyId);
    const proposed = await propose('set_primary_property', { customer_id: customerA, property_id: saved.propertyId }, 'Make the saved 1800 Example Grove property primary');
    await db('customers').where({ id: customerA }).update({ contact_role: 'tenant', updated_at: db.fn.now() });
    try {
      const listed = await api(`/api/admin/customers/${customerA}/properties`);
      expect(listed.body.properties.find(p => p.id === saved.propertyId)).toMatchObject({ primary_change_eligible: false,
        primary_change_unavailable: expect.stringContaining('tenant') });
      expect(await api(`/api/admin/customers/${customerA}/properties/${saved.propertyId}/primary-preview`))
        .toMatchObject({ status: 409, body: { code: 'primary_role_unavailable' } });
      expect(await api(`/api/admin/customers/${customerA}/properties/${saved.propertyId}/primary`, { expectedVersion: preview._version }))
        .toMatchObject({ status: 409, body: { code: 'primary_role_unavailable' } });
      expect(await confirm(proposed)).toMatchObject({ status: 409, body: { code: 'target_changed' } });
      const refused = await propose('set_primary_property', { customer_id: customerA, property_id: saved.propertyId }, 'Make the saved 1800 Example Grove property primary');
      expect(refused.body.pendingActions || []).toHaveLength(0);
      expect(await db('customer_properties').where({ id: saved.propertyId }).first()).toEqual(beforeProperty);
      expect((await db('customers').where({ id: customerA }).first()).address_line1).toBe(beforeCustomer.address_line1);
    } finally { await db('customers').where({ id: customerA }).update({ contact_role: beforeCustomer.contact_role, updated_at: db.fn.now() }); }
  }, 30000);

  test('a same-street partial primary is a duplicate at preview time in the portal and the bar', async () => {
    const customerC = crypto.randomUUID(), primaryC = crypto.randomUUID();
    const nameC = `Fixture Cedar${customerC.slice(0, 8)}`;
    // Legacy data: the account and its primary carry the street but no city or ZIP.
    await db('customers').insert({ id: customerC, first_name: 'Fixture', last_name: `Cedar${customerC.slice(0, 8)}`, address_line1: '700 Example Grove',
      city: '', state: 'FL', zip: '', phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` });
    const properties = require('../services/customer-properties');
    await db('customer_properties').insert({ id: primaryC, customer_id: customerC, address_line1: '700 Example Grove', city: '', state: 'FL', zip: '',
      is_primary: true, active: true, occupancy_type: 'unknown', source: 'manual', address_key: properties.addressKey({ address_line1: '700 Example Grove' }) });
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(call('discover_capabilities', { query: 'add customer property' }, 'discover'))
      .mockResolvedValueOnce(call('add_customer_property', { customer_id: customerC, ...address(700) }, 'property'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'That address is already saved.' }], usage: {} });
    const proposed = await api('/api/admin/intelligence-bar/query', { prompt: `Add 700 Example Grove, Sarasota FL 34201 as a saved property for ${nameC}`,
      context: 'estimates', session_id: sessionId, request_key: crypto.randomUUID(), pageData: { route: '/admin/estimates', customerId: customerB } });
    expect(proposed.status).toBe(200);
    expect(proposed.body.taskTarget.customer_id).toBe(customerC);
    expect(proposed.body.pendingActions).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'property');
    expect(JSON.parse(result.content)).toMatchObject({ success: false, code: 'property_exists' });
    expect((await api(`/api/admin/customers/${customerC}/properties`, address(700))).status).toBe(409);
    // The refused preview completed nothing and saved nothing.
    expect(await db('customer_properties').where({ customer_id: customerC })).toHaveLength(1);
    expect((await db('customers').where('id', customerC).first()).city).toBe('');
    // A genuinely different street on the same customer still previews.
    expect((await api(`/api/admin/customers/${customerC}/properties`, address(710))).status).toBe(201);
  }, 30000);

  test('portal and bar add/edit produce equivalent domain outcomes and audit; foreign property and stale approval refuse', async () => {
    const ui = await api(`/api/admin/customers/${customerB}/properties`, address(500, 'Family'));
    expect(ui.status).toBe(201);
    const ib = await confirm(await propose('add_customer_property', { customer_id: customerA, ...address(500, 'Family') }, 'Add 500 Example Grove, Sarasota FL 34201 as a saved property'));
    expect(ib.body.success).toBe(true);
    const fields = ['address_line1', 'city', 'state', 'zip', 'occupancy_type', 'label', 'is_primary', 'source'];
    expect(await db('customer_properties').where('id', ui.body.propertyId).first(fields))
      .toEqual(await db('customer_properties').where('id', ib.body.result.propertyId).first(fields));
    const uiEdit = await api(`/api/admin/customers/${customerB}/properties/${ui.body.propertyId}`, { label: 'Family home' }, 'PATCH');
    expect(uiEdit.status).toBe(200);
    const ibEdit = await confirm(await propose('update_customer_property', { customer_id: customerA, property_id: ib.body.result.propertyId, label: 'Family home' }, 'Relabel the saved 500 Example Grove property Family home'));
    expect(ibEdit.body.success).toBe(true);
    const audits = await db('audit_log').whereIn('resource_id', [ui.body.propertyId, ib.body.result.propertyId]).orderBy('action').select('actor_id', 'action', 'resource_id');
    expect(audits).toHaveLength(4);
    expect(new Set(audits.map(a => a.actor_id))).toEqual(new Set([actor]));
    const foreign = await propose('update_customer_property', { customer_id: customerA, property_id: ui.body.propertyId, label: 'Wrong target' }, 'Relabel the saved property');
    expect(foreign.body.pendingActions).toHaveLength(0);
    const stale = await propose('update_customer_property', { customer_id: customerA, property_id: ib.body.result.propertyId, label: 'Old instruction' }, 'Relabel the saved 500 Example Grove property Old instruction');
    await db('customer_properties').where('id', ib.body.result.propertyId).update({ label: 'New operator edit', updated_at: db.fn.now() });
    expect(await confirm(stale)).toMatchObject({ status: 409, body: { code: 'target_changed' } });
    expect((await db('customer_properties').where('id', ib.body.result.propertyId).first()).label).toBe('New operator edit');
    const missingPreview = await api(`/api/admin/customers/${customerB}/properties/${ui.body.propertyId}/primary`, {});
    expect(missingPreview.status).toBe(409);
    const duplicate = await api(`/api/admin/customers/${customerB}/properties`, address(500));
    expect(duplicate.status).toBe(409);
  }, 60000);
});
