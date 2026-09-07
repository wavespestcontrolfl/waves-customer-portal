/** Real Postgres identity/version proof. Synthetic customers are rolled back;
 * no model, message adapter, or external provider is called. */
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const Context = require('../services/intelligence-bar/task-context');
const connection = process.env.IB_TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
let mockDb, database, customerId;
jest.setTimeout(30000);

suite('IB target validation against isolated PostgreSQL', () => {
  beforeAll(() => {
    const parsed = new URL(connection);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });
  beforeEach(async () => {
    mockDb = await database.transaction();
    customerId = randomUUID();
    await mockDb('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Targetfixture',
      phone: '+1555' + Date.now().toString().slice(-7), address_line1: '100 Test Street',
      updated_at: '2026-09-01T12:00:00.123456Z' });
  });
  afterEach(async () => { await mockDb?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('fresh page, explicit selection, full-name and single-name lookups preserve exact database versions', async () => {
    const { version } = await mockDb('customers').where('id', customerId).first(mockDb.raw('updated_at::text AS version'));
    expect(version).toContain('.123456');
    const requests = [
      { prompt: 'Update this customer', pageData: { customer_id: customerId } },
      { prompt: 'Update the customer', pageData: {}, selectedTarget: { customer_id: customerId } },
      { prompt: 'Send to Synthetic Targetfixture using this customer', pageData: {} },
      { prompt: 'Send a message to Targetfixture using this customer', pageData: {} },
    ];
    for (const request of requests) {
      const result = await Context.resolve(request);
      expect(result.target).toMatchObject({ customer_id: customerId, version });
      expect(await Context.validateRecordTarget({ customer_id: customerId.toUpperCase() }, result)).toBeNull();
    }
  });

  test('an unresolved prepositional name refuses the actual viewed customer after lookup', async () => {
    for (const prompt of ['Send to Targtefixture using this customer', 'Send an SMS to Targtefixture using this customer', 'Update customer Targtefixture using this customer', ...['Reschedule', 'Move', 'Call', 'Remind', 'Cancel', 'Book'].map(verb => `${verb} Targtefixture using this customer`)]) {
      const task = await Context.resolve({ prompt, pageData: { customer_id: customerId } });
      expect(task.page.customer.customer_id).toBe(customerId);
      expect(task.targets).toEqual([]);
      expect((await Context.validateRecordTarget({ customer_id: customerId }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
    }
  });

  test('this/that/selected property pins the persisted row, not another property of the same customer', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('customer_properties').insert(ids.map((id, i) => ({ id, customer_id: customerId,
      label: `Synthetic ${i}`, address_line1: `${100 + i} Test Street` })));
    for (const word of ['this', 'that', 'selected']) {
      const task = await Context.resolve({ prompt: `Update ${word} property label`, pageData: { property_id: ids[0] } });
      expect(await Context.validateRecordTarget({ property_id: ids[0] }, task)).toBeNull();
      expect(await Context.validateRecordTarget({ customer_id: customerId.toUpperCase(), property_id: ids[0].toUpperCase() }, task)).toBeNull();
      expect((await Context.validateRecordTarget({ property_id: ids[1] }, task)).code).toBe('target_clarification_required');
    }
    const missing = await Context.resolve({ prompt: 'Update this property label', pageData: { customer_id: customerId } });
    expect((await Context.validateRecordTarget({ property_id: ids[1] }, missing)).code).toBe('target_clarification_required');
    const explicit = await Context.resolve({ prompt: 'Update Synthetic Targetfixture property label', pageData: { property_id: ids[0] } });
    expect(await Context.validateRecordTarget({ property_id: ids[1] }, explicit)).toBeNull();
    const uppercase = await Context.resolve({ prompt: 'Update this property label', pageData: { property_id: ids[0].toUpperCase() } });
    expect(await Context.validateRecordTarget({ property_id: ids[0] }, uppercase)).toBeNull();
  });

  test('SMS name-only proposals refuse while canonical recipients use fresh phone data', async () => {
    const task = await Context.resolve({ prompt: 'Text this customer', pageData: { customer_id: customerId } });
    for (const customer_name of ['Synthetic Targetfixture', 'Synthetic Otherfixture', 'Targtefixture']) {
      expect((await Context.validateRecordTarget({ customer_name }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
    }
    const customer = await Context.customerById(customerId);
    const params = { customer_id: customerId, phone: customer.phone, message: 'Synthetic confirmation only' };
    expect(await Context.validateRecordTarget(params, task, { toolName: 'send_sms' })).toBeNull();
    await mockDb('customers').where('id', customerId).update({ phone: '+15550109876', updated_at: mockDb.fn.now() });
    expect((await Context.validateRecordTarget(params, task, { toolName: 'send_sms' })).code).toBe('target_relationship_mismatch');
  });

  test('an unlinked call requires an explicit current-request or viewed-call reference', async () => {
    const id = randomUUID();
    await mockDb('call_log').insert({ id, customer_id: null, twilio_call_sid: `fixture-${id}`,
      direction: 'inbound', from_phone: '+15550101234', to_phone: '+15550104321' });
    const unrelated = await Context.resolve({ prompt: 'Look up inventory', pageData: { call_id: id } });
    expect(await Context.validateRecordTarget({ call_id: id }, unrelated)).toMatchObject({ code: 'target_clarification_required' });
    for (const prompt of ['Read this call', `Read call ${id}`]) {
      const task = await Context.resolve({ prompt, pageData: { call_id: id } });
      expect(await Context.validateRecordTarget({ call_id: id }, task)).toBeNull();
    }
  });

  test('a customerless appointment requires a current-request selection and rejects siblings', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('scheduled_services').insert(ids.map(id => ({ id, customer_id: null, scheduled_date: '2099-01-01', service_type: 'Synthetic reservation' })));
    const params = id => ({ service_ids: [id] });
    const options = { toolName: 'move_stops_to_day' };
    const unrelated = await Context.resolve({ prompt: 'Look up inventory', pageData: { appointment_id: ids[0] } });
    expect(await Context.validateRecordTarget(params(ids[0]), unrelated, options)).toMatchObject({ code: 'target_clarification_required' });
    const body = await Context.resolve({ prompt: `Send a message to +15550101234 with the text check inventory and move appointment ${ids[0]}`, pageData: {} });
    expect(body.requestedRecords).toEqual({});
    expect(await Context.validateRecordTarget(params(ids[0]), body, options)).toMatchObject({ code: 'target_clarification_required' });
    for (const prompt of ['Move this appointment', `Move appointment ${ids[0]}`]) {
      const task = await Context.resolve({ prompt, pageData: { appointment_id: ids[0] } });
      expect(await Context.validateRecordTarget(params(ids[0]), task, options)).toBeNull();
      expect(await Context.validateRecordTarget(params(ids[1]), task, options)).toMatchObject({ code: 'target_clarification_required' });
    }
  });

  test('lead writes require canonical IDs and reject names unrelated to the current task', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('leads').insert(ids.map((id, index) => ({ id, first_name: 'Synthetic', last_name: `Leadfixture${index}` })));
    const task = await Context.resolve({ prompt: 'Update this lead', pageData: { lead_id: ids[0] } });
    const options = { toolName: 'update_lead_status' };
    expect(await Context.validateRecordTarget({ lead_name: 'Synthetic Leadfixture1' }, task, options)).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget({ lead_id: ids[1] }, task, options)).toMatchObject({ code: 'target_clarification_required' });
    expect(await Context.validateRecordTarget({ lead_id: ids[0] }, task, options)).toBeNull();
  });

  test('eleven explicit customer names cannot silently become ten approved targets', async () => {
    const customers = Array.from({ length: 11 }, (_, i) => ({ id: randomUUID(), first_name: 'Synthetic', last_name: `Cohortfixture${i}`,
      phone: `+15550000${String(i).padStart(3, '0')}` }));
    await mockDb('customers').insert(customers);
    const task = await Context.resolve({ prompt: `Update both ${customers.map(c => `${c.first_name} ${c.last_name}`).join(' and ')}`, pageData: {} });
    expect(task.candidates).toHaveLength(10);
    expect(task.targets).toEqual([]);
    expect(task.ambiguous).toBe(true);
    expect(await Context.validateRecordTarget({ customer_ids: task.candidates.map(c => c.customer_id) }, task)).toMatchObject({ code: 'target_clarification_required' });
    const incidental = await Context.resolve({ prompt: `Update both ${customers.map(c => `${c.first_name} ${c.last_name}`).join(' and ')} after checking with Synthetic Targetfixture`, pageData: {} });
    expect(incidental.targets).toEqual([]);
    expect(incidental.ambiguous).toBe(true);
  });

  test('a later compound estimate step preserves its own exact ID despite a message noun', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('estimates').insert(ids.map(id => ({ id, customer_id: customerId })));
    const task = await Context.resolve({ prompt: `Send a message to Synthetic Targetfixture and revise estimate ${ids[0]}`, pageData: { estimate_id: ids[1] } });
    expect(await Context.validateRecordTarget({ estimate_id: ids[0] }, task)).toBeNull();
    expect(await Context.validateRecordTarget({ estimate_id: ids[1] }, task)).toMatchObject({ code: 'target_clarification_required' });
  });

  test('child-only validation rechecks a deleted parent customer', async () => {
    const id = randomUUID();
    await mockDb('customer_properties').insert({ id, customer_id: customerId, address_line1: '100 Test Street' });
    const task = await Context.resolve({ prompt: 'Update this property', pageData: { property_id: id } });
    expect(await Context.validateRecordTarget({ property_id: id }, task)).toBeNull();
    await mockDb('customers').where('id', customerId).update({ deleted_at: mockDb.fn.now() });
    expect(await Context.validateRecordTarget({ property_id: id }, task)).toMatchObject({ code: 'record_unavailable' });
  });

  test('an address-only reply requires a unique current Gmail thread', async () => {
    const one = randomUUID(), two = randomUUID(), thread = randomUUID();
    const from = `${randomUUID()}@example.invalid`;
    const email = (id, gmail_thread_id) => ({ id, gmail_id: randomUUID(), gmail_thread_id, customer_id: customerId,
      from_address: from, subject: 'Synthetic thread', received_at: new Date() });
    await mockDb('emails').insert(email(one, thread));
    const task = await Context.resolve({ prompt: `Reply to ${from}`, pageData: {} });
    expect(await Context.validateRecordTarget({ email_id: one }, task, { toolName: 'send_email_reply' })).toBeNull();
    await mockDb('emails').insert(email(two, randomUUID()));
    expect(await Context.validateRecordTarget({ email_id: one }, task, { toolName: 'send_email_reply' })).toMatchObject({ code: 'target_clarification_required' });
    await mockDb('emails').where('id', two).update({ gmail_thread_id: thread });
    expect(await Context.validateRecordTarget({ email_id: one }, task, { toolName: 'send_email_reply' })).toBeNull();
    const viewed = await Context.resolve({ prompt: 'Reply to this email', pageData: { email_id: two } });
    expect(await Context.validateRecordTarget({ email_id: two }, viewed, { toolName: 'send_email_reply' })).toBeNull();
  });

  test('a converted email lead supplies fresh customer ownership', async () => {
    const lead = randomUUID(), email = randomUUID();
    await mockDb('leads').insert({ id: lead, customer_id: customerId, first_name: 'Synthetic', last_name: 'Converted' });
    await mockDb('emails').insert({ id: email, gmail_id: randomUUID(), gmail_thread_id: randomUUID(), lead_id: lead, from_address: 'converted@example.invalid',
      subject: 'Synthetic converted inquiry', received_at: new Date() });
    const task = await Context.resolve({ prompt: 'Text this customer', pageData: { email_id: email } });
    expect(task.target).toMatchObject({ customer_id: customerId });
    expect(await Context.validateRecordTarget({ email_id: email }, task)).toBeNull();
    await mockDb('leads').where('id', lead).update({ deleted_at: mockDb.fn.now() });
    expect(await Context.validateRecordTarget({ email_id: email }, task)).toMatchObject({ code: 'record_unavailable' });
  });

  test('an unavailable unrelated page hint does not block the explicitly viewed customer', async () => {
    const task = await Context.resolve({ prompt: 'Update this customer', pageData: { customer_id: customerId, appointment_id: randomUUID() } });
    expect(task.target).toMatchObject({ customer_id: customerId });
    expect(await Context.validateRecordTarget({ customer_id: customerId }, task)).toBeNull();
  });

  test('stored customer names use the same punctuation and whitespace normalization as the request', async () => {
    await mockDb('customers').where('id', customerId).update({ first_name: 'Synthetic', last_name: 'O’Neill, Jr.' });
    const task = await Context.resolve({ prompt: "Update Synthetic O'Neill Jr notes", pageData: {} });
    expect(task.target).toMatchObject({ customer_id: customerId });
  });

  test('a viewed call resolves its owner and cannot be swapped for a sibling call or body reference', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('call_log').insert(ids.map(id => ({ id, customer_id: customerId, twilio_call_sid: `fixture-${id}`,
      direction: 'inbound', from_phone: '+15550101234', to_phone: '+15550104321' })));
    for (const word of ['this', 'that', 'selected']) {
      const task = await Context.resolve({ prompt: `Update ${word} call`, pageData: { call_id: ids[0] } });
      expect(task.target.customer_id).toBe(customerId);
      expect(await Context.validateRecordTarget({ call_id: ids[0] }, task)).toBeNull();
      expect((await Context.validateRecordTarget({ call_id: ids[1] }, task)).code).toBe('target_clarification_required');
    }
    const content = await Context.resolve({ prompt: 'Add a note saying this call needs attention', pageData: { call_id: ids[0] } });
    expect(content.targets).toEqual([]);
    expect((await Context.validateRecordTarget({ call_id: ids[0] }, content)).code).toBe('target_clarification_required');
    await mockDb('customers').where('id', customerId).update({ deleted_at: mockDb.fn.now() });
    expect((await Context.resolve({ prompt: 'Update this call', pageData: { call_id: ids[0] } })).code).toBe('record_unavailable');
  });

  test.each([['lead', 'leads'], ['estimate', 'estimates']])('a fresh duplicate unlinked %s invalidates name authority for either model ID', async (noun, table) => {
    const ids = [randomUUID(), randomUUID()];
    const name = table === 'leads' ? { first_name: 'Synthetic', last_name: 'Duplicatefixture' }
      : { customer_name: 'Synthetic Duplicatefixture' };
    await mockDb(table).insert({ id: ids[0], ...name, customer_id: null });
    const task = await Context.resolve({ prompt: 'Update Synthetic Duplicatefixture', pageData: {} });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, task)).toBeNull();
    await mockDb(table).insert({ id: ids[1], ...name, customer_id: null });
    // Validation must re-read after resolution instead of retaining a unique-name claim.
    for (const id of ids) expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, task)).code).toBe('target_clarification_required');
    const selected = await Context.resolve({ prompt: `Update this ${noun}`, pageData: { [`${noun}_id`]: ids[0] } });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, selected)).toBeNull();
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: ids[1] }, selected)).code).toBe('target_clarification_required');
    if (table === 'leads') {
      await mockDb(table).where('id', ids[1]).update({ deleted_at: mockDb.fn.now() });
      expect(await Context.validateRecordTarget({ lead_id: ids[0] }, task)).toBeNull();
      await mockDb(table).where('id', ids[1]).update({ deleted_at: null, customer_id: customerId });
    } else await mockDb(table).where('id', ids[1]).update({ status: 'accepted', customer_id: customerId });
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, task)).code).toBe('target_clarification_required');
  });

  test.each([
    ["Synthetic O’Neill", "SYNTHETIC O'Neill"],
    ['Synthetic   Hyphen-Fixture', 'synthetic Hyphen-Fixture'],
    ['Synthetic, Punctuation', 'Synthetic Punctuation'],
    ["Synthetic Owner's", 'Synthetic Owner'],
    ['Synthetic José', 'synthetic José'],
    ['Synthetic\u00a0Spacefixture', 'Synthetic Spacefixture'],
  ])('equivalent normalized unlinked names cannot hide a duplicate: %s', async (first, second) => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('estimates').insert({ id: ids[0], customer_name: first });
    const task = await Context.resolve({ prompt: `Update ${first}`, pageData: {} });
    expect(await Context.validateRecordTarget({ estimate_id: ids[0] }, task)).toBeNull();
    await mockDb('estimates').insert({ id: ids[1], customer_name: second });
    for (const id of ids) expect((await Context.validateRecordTarget({ estimate_id: id }, task)).code).toBe('target_clarification_required');
  });

});
