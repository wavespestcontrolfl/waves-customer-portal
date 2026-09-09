/** Real Postgres identity/version proof. Synthetic customers are rolled back;
 * no model, message adapter, or external provider is called. */
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
const mockDraft = jest.fn(async () => ({ content: [{ type: 'text', text: 'Synthetic draft' }] }));
jest.mock('@anthropic-ai/sdk', () => function () { return { messages: { create: mockDraft } }; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { executeEmailTool } = require('../services/intelligence-bar/email-tools');
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const Context = require('../services/intelligence-bar/task-context');
const connection = process.env.IB_TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
let mockDb, database, customerId;
jest.setTimeout(30000);

suite('IB target resolution against isolated PostgreSQL', () => {
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
      { prompt: 'Update Synthetic Targetfixture', pageData: {}, selectedTarget: { customer_id: customerId } },
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
      expect((await Context.validateRecordTarget({ property_id: ids[1] }, task)).code).toBe('target_clarification_required');
    }
    const missing = await Context.resolve({ prompt: 'Update this property label', pageData: { customer_id: customerId } });
    expect((await Context.validateRecordTarget({ property_id: ids[1] }, missing)).code).toBe('target_clarification_required');
    const explicit = await Context.resolve({ prompt: 'Update Synthetic Targetfixture property label', pageData: { property_id: ids[0] } });
    expect(await Context.validateRecordTarget({ property_id: ids[1] }, explicit)).toBeNull();
  });

  test('scoped email lookup selects the allowed older thread and its latest unlinked reply before drafting', async () => {
    const foreignId = randomUUID();
    await mockDb('customers').insert({ id: foreignId, first_name: 'Synthetic', last_name: 'Foreign', phone: '+1555' + (Date.now()+1).toString().slice(-7) });
    const owned = randomUUID(), foreign = randomUUID(), mixed = randomUUID(), latest = randomUUID();
    const email = (customer_id, thread, age, id = randomUUID()) => ({ id, gmail_id: randomUUID(), gmail_thread_id: thread,
      customer_id, from_address: 'fixture@example.invalid', from_name: 'Synthetic Sender', subject: 'Synthetic Match',
      body_text: 'Synthetic thread content', received_at: new Date(Date.now() - age) });
    await mockDb('emails').insert([
      email(customerId, owned, 4000), email(null, owned, 3000, latest),
      email(foreignId, foreign, 2000), email(customerId, mixed, 1000), email(foreignId, mixed, 0),
    ]);
    const scope = { readCustomerIds: [customerId] };
    const found = await executeEmailTool('get_email_thread', { from_name: 'Synthetic Sender' }, scope);
    expect(found).toMatchObject({ thread_id: owned, message_count: 2 });
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-controlled-adapter';
    mockDraft.mockClear();
    try {
      const draft = await executeEmailTool('draft_email_reply', { from_name: 'Synthetic Sender' }, scope);
      expect(draft).toMatchObject({ draft: true, email_id: latest, thread_id: owned, reply_draft: 'Synthetic draft' });
      expect(mockDraft).toHaveBeenCalledTimes(1);
      const refusal = await executeEmailTool('draft_email_reply', { thread_id: mixed }, scope);
      expect(refusal.code).toBe('target_clarification_required');
      expect(mockDraft).toHaveBeenCalledTimes(1);
      expect((await executeEmailTool('get_email_thread', { thread_id: foreign }, scope)).code).toBe('target_clarification_required');
    } finally {
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });

  test('converted-lead email ownership scopes search, thread reads and drafts, including mixed and changed links', async () => {
    const foreignId = randomUUID(), ownLead = randomUUID(), foreignLead = randomUUID();
    await mockDb('customers').insert({ id: foreignId, first_name: 'Synthetic', last_name: 'Leadmail', phone: '+15550109877' });
    await mockDb('leads').insert([{ id: ownLead, customer_id: customerId }, { id: foreignLead, customer_id: foreignId }]);
    const owned = randomUUID(), mixed = randomUUID(), conflicting = randomUUID();
    const ownEmail = randomUUID();
    const email = (thread, customer_id, lead_id, id = randomUUID()) => ({ id, gmail_id: randomUUID(), gmail_thread_id: thread,
      customer_id, lead_id, from_address: 'fixture@example.invalid', from_name: 'Synthetic Lead Sender', subject: 'Synthetic lead-linked email',
      body_text: thread === owned ? 'Owned converted-lead content' : 'Foreign converted-lead content', received_at: new Date() });
    await mockDb('emails').insert([
      email(owned, null, ownLead, ownEmail), email(owned, null, null),
      email(mixed, customerId, null), email(mixed, null, foreignLead),
      email(conflicting, customerId, foreignLead),
    ]);
    const scope = { readCustomerIds: [customerId] };
    const search = () => executeEmailTool('search_emails', { from: 'Synthetic Lead Sender' }, scope);
    expect((await search()).results.map(row => row.gmail_thread_id)).toEqual([owned, owned]);
    expect(await executeEmailTool('get_email_thread', { thread_id: owned }, scope)).toMatchObject({ thread_id: owned, message_count: 2 });
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'synthetic-controlled-adapter';
    mockDraft.mockClear();
    try {
      expect(await executeEmailTool('draft_email_reply', { email_id: ownEmail }, scope)).toMatchObject({ draft: true, reply_draft: 'Synthetic draft' });
      expect(mockDraft).toHaveBeenCalledTimes(1);
      for (const thread_id of [mixed, conflicting]) {
        expect(await executeEmailTool('get_email_thread', { thread_id }, scope)).toMatchObject({ code: 'target_clarification_required' });
        expect(await executeEmailTool('draft_email_reply', { thread_id }, scope)).toMatchObject({ code: 'target_clarification_required' });
      }
      // Even a task containing both customers cannot bless contradictory links.
      expect(await executeEmailTool('get_email_thread', { thread_id: conflicting }, { readCustomerIds: [customerId, foreignId] }))
        .toMatchObject({ code: 'target_clarification_required' });
      for (const changes of [{ customer_id: foreignId }, { customer_id: customerId, deleted_at: new Date() }]) {
        await mockDb('leads').where('id', ownLead).update(changes);
        expect((await search()).results).toEqual([]);
        expect(await executeEmailTool('get_email_thread', { thread_id: owned }, scope)).toMatchObject({ code: 'target_clarification_required' });
        expect(await executeEmailTool('draft_email_reply', { email_id: ownEmail }, scope)).toMatchObject({ code: 'target_clarification_required' });
      }
      expect(mockDraft).toHaveBeenCalledTimes(1);
    } finally {
      if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });


  test('selector-free call history inherits the resolved customer and reads only its persisted calls', async () => {
    const foreignId = randomUUID(), ownCall = randomUUID(), foreignCall = randomUUID();
    await mockDb('customers').insert({ id: foreignId, first_name: 'Synthetic', last_name: 'Foreigncalls',
      phone: '+1555' + (Date.now()+3).toString().slice(-7) });
    await mockDb('call_log').insert([
      { id: ownCall, customer_id: customerId, twilio_call_sid: `fixture-${ownCall}`, direction: 'inbound', from_phone: '+15550101234', to_phone: '+15550104321', transcription: 'Owned synthetic call' },
      { id: foreignCall, customer_id: foreignId, twilio_call_sid: `fixture-${foreignCall}`, direction: 'inbound', from_phone: '+15550105678', to_phone: '+15550104321', transcription: 'Foreign synthetic call' },
    ]);
    const comms = require('../services/intelligence-bar/comms-tools');
    const schema = comms.COMMS_TOOLS.find(tool => tool.name === 'get_call_log').input_schema;
    const task = await Context.resolve({ prompt: "Show this customer's calls", pageData: { customer_id: customerId } });
    const prepared = await Context.prepareReadInput({ days_back: 7 }, task, { toolName: 'get_call_log', schema });
    expect(prepared.input).toEqual({ days_back: 7, customer_id: customerId });
    const result = await comms.executeCommsTool('get_call_log', prepared.input);
    expect(result.calls.map(call => call.id)).toEqual([ownCall]);
    expect(result.calls[0].transcript_excerpt).toBe('Owned synthetic call');
  });

  test('a real alternate customer named inside message content cannot replace the viewed recipient', async () => {
    const recipientId = randomUUID();
    await mockDb('customers').insert({ id: recipientId, first_name: 'Synthetic', last_name: 'Recipientfixture',
      phone: '+1555' + (Date.now()+2).toString().slice(-7) });
    for (const prefix of ['Text this customer', 'Email this customer', 'Send this customer a text', 'Update this customer and text them', 'Remind this customer', 'Notify this customer', 'Tell this customer']) {
      const task = await Context.resolve({ prompt: `${prefix} that customer Synthetic Targetfixture canceled`,
        pageData: { customer_id: recipientId } });
      expect(task.target.customer_id).toBe(recipientId);
      expect((await Context.validateRecordTarget({ customer_id: customerId }, task)).code).toBe('target_clarification_required');
    }
  });

  test('selector-free message search includes current unlinked history without crossing linked accounts', async () => {
    const foreignId = randomUUID();
    const ownPhone = (await mockDb('customers').where('id', customerId).first('phone')).phone;
    await mockDb('customers').insert({ id: foreignId, first_name: 'Synthetic', last_name: 'Foreignmessages', phone: '+15550108888' });
    const ids = Array.from({ length: 4 }, () => randomUUID());
    await mockDb('sms_log').insert([
      { id: ids[0], customer_id: customerId, from_phone: ownPhone },
      { id: ids[1], customer_id: null, from_phone: ownPhone },
      { id: ids[2], customer_id: foreignId, from_phone: ownPhone },
      { id: ids[3], customer_id: null, from_phone: '+15550109999' },
    ].map(row => ({ ...row, to_phone: '+15550101111', direction: 'inbound', message_body: 'Synthetic search fixture', message_type: 'manual' })));
    const comms = require('../services/intelligence-bar/comms-tools');
    const schema = comms.COMMS_TOOLS.find(tool => tool.name === 'search_messages').input_schema;
    const task = await Context.resolve({ prompt: "Show this customer's messages", pageData: { customer_id: customerId } });
    const prepared = await Context.prepareReadInput({ search: 'Synthetic search fixture' }, task, { toolName: 'search_messages', schema });
    expect(prepared.input.customer_id).toBe(customerId);
    const result = await comms.executeCommsTool('search_messages', prepared.input);
    expect(result.messages.map(message => message.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect((await comms.executeCommsTool('search_messages', { customer_id: customerId, phone: '+15550109999' })).code).toBe('target_relationship_mismatch');
    await mockDb('customers').where('id', customerId).update({ phone: '+15550109999' });
    expect((await comms.executeCommsTool('search_messages', prepared.input)).messages.map(message => message.id).sort()).toEqual([ids[0], ids[3]].sort());
    expect((await comms.executeCommsTool('search_messages', { ...prepared.input, phone: '+15550109999' })).messages.map(message => message.id)).toEqual([ids[3]]);
    expect((await comms.executeCommsTool('search_messages', { customer_id: customerId, phone: ownPhone })).code).toBe('target_relationship_mismatch');
    await mockDb('customers').where('id', customerId).update({ deleted_at: mockDb.fn.now() });
    expect((await comms.executeCommsTool('search_messages', prepared.input)).code).toBe('record_unavailable');
  });

});
