// Synthetic PostgreSQL fixtures only; discovered by CI's serial DB-gated step.
const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const knex = require('knex');
let mockDb;
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { mineVoiceCorpus, mineEmailPairs } = require('../services/sms-voice-corpus-miner');
const { distillVoiceProfile } = require('../services/voice-profile-distiller');
const { fetchVoiceExemplars } = require('../services/sms-shadow-drafter');
const mailboxAddress = 'contact@wavespestcontrol.com';
jest.setTimeout(30000);

suite('reviewed email corpus PostgreSQL contract', () => {
  let database, customer, inbound, reply, selection, now, previousGate;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && url.hostname === 'localhost' && url.pathname === '/waves_test';
    if (!ci && !(process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname))) {
      throw new Error('Select the task-owned synthetic development database');
    }
    database = knex({ client: 'pg', connection: url.href, pool: { min: 0, max: 1 } });
  });
  beforeEach(async () => {
    previousGate = process.env.GATE_VOICE_CORPUS_EMAIL_SOURCE;
    process.env.GATE_VOICE_CORPUS_EMAIL_SOURCE = 'true';
    mockDb = await database.transaction();
    now = new Date();
    [customer] = await mockDb('customers').insert({ id: randomUUID(), first_name: 'Corpus',
      last_name: 'Synthetic', phone: '+15555550123', email: `fixture-${randomUUID()}@example.test`,
      active: true, pipeline_stage: 'active_customer' }).returning('*');
    [inbound] = await mockDb('emails').insert({ gmail_id: randomUUID(), gmail_thread_id: randomUUID(),
      from_address: customer.email, to_address: mailboxAddress, customer_id: customer.id,
      authentication_results: 'mx.google.com; dkim=pass header.d=example.test',
      received_at: new Date(now - 7200000), body_text: 'When is our next service?',
      classification: 'customer_request', label_ids: JSON.stringify(['INBOX']) }).returning('*');
    [reply] = await mockDb('emails').insert({ gmail_id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id,
      from_address: mailboxAddress, to_address: customer.email, customer_id: customer.id,
      received_at: new Date(now - 3600000), body_text: 'Corpus, your next service is Friday morning.',
      auto_action: 'outbound_skipped', label_ids: JSON.stringify(['SENT']) }).returning('*');
    selection = { version: 1, reviewedBy: randomUUID(), reviewedAt: now.toISOString(), replyIds: [reply.id],
      heldOutCustomerIds: [], heldOutThreadIds: [] };
    await saveSelection();
  });
  afterEach(async () => {
    await mockDb?.rollback();
    if (previousGate === undefined) delete process.env.GATE_VOICE_CORPUS_EMAIL_SOURCE;
    else process.env.GATE_VOICE_CORPUS_EMAIL_SOURCE = previousGate;
  });
  afterAll(async () => { await database?.destroy(); });
  async function saveSelection() {
    const value = JSON.stringify(selection);
    await mockDb('system_settings').insert({ key: 'email_voice_corpus_selection', value })
      .onConflict('key').merge({ value });
  }
  const collect = () => mineEmailPairs({ database: mockDb, mailboxAddress,
    since: new Date(now - 86400000), until: new Date(now.getTime() + 1000), skipped: {} });

  test('the nightly miner persists redacted reviewed pairs once and leaves source mail untouched', async () => {
    const before = await mockDb('emails').whereIn('id', [inbound.id, reply.id]).orderBy('id');
    expect(await mineVoiceCorpus()).toMatchObject({ emailPairsFound: 1, inserted: 1 });
    expect(await mineVoiceCorpus()).toMatchObject({ emailPairsFound: 1, inserted: 0 });
    const rows = await mockDb('voice_corpus_examples').where({ source: 'email_human_reply', source_id: reply.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_id: customer.id, admin_user_id: null });
    expect(rows[0].inbound_text).toContain('next service');
    expect(rows[0].reply_text).not.toContain('Corpus');
    expect(await mockDb('emails').whereIn('id', [inbound.id, reply.id]).orderBy('id')).toEqual(before);
  });

  test('SENT alone is not human-authorship evidence', async () => {
    selection.replyIds = [];
    await saveSelection();
    expect(await collect()).toEqual([]);
  });

  test.each(['heldOutCustomerIds', 'heldOutThreadIds'])('excludes the entire %s holdout', async (key) => {
    selection[key] = [key === 'heldOutCustomerIds' ? customer.id.toUpperCase() : reply.gmail_thread_id];
    await saveSelection();
    expect(await collect()).toEqual([]);
  });

  test.each([
    { customer_id: randomUUID() },
    { to_address: 'unrelated@example.test' },
    { label_ids: JSON.stringify(['SENT', 'DRAFT']) },
  ])('rejects conflicting or ineligible reviewed mail: %p', async (change) => {
    // The foreign-key mismatch is represented by a second valid customer.
    if (change.customer_id) await mockDb('customers').insert({ id: change.customer_id, first_name: 'Other', phone: '+15555550124', active: true });
    await mockDb('emails').where('id', reply.id).update(change);
    expect(await collect()).toEqual([]);
  });

  test('shared active sender identities are ambiguous even with a reviewed reply ID', async () => {
    await mockDb('customers').insert({ first_name: 'Other', phone: '+15555550125', email: customer.email, active: true });
    expect(await collect()).toEqual([]);
  });

  test('does not reuse an inbound already followed by another sent message', async () => {
    await mockDb('emails').insert({ gmail_id: randomUUID(), gmail_thread_id: inbound.gmail_thread_id,
      from_address: mailboxAddress, to_address: customer.email, customer_id: customer.id,
      received_at: new Date(now - 5400000), body_text: 'An earlier reply already answered this question.',
      label_ids: JSON.stringify(['SENT']) });
    expect(await collect()).toEqual([]);
  });

  test('an unavailable email query does not abort the surrounding transaction', async () => {
    await mockDb.schema.alterTable('emails', (table) => table.renameColumn('body_text', 'fixture_hidden_body'));
    expect(await collect()).toEqual([]);
    expect(await mockDb('customers').where('id', customer.id).first('id')).toEqual({ id: customer.id });
  });

  test.each(['pending', 'approved'])('email rows cannot retrigger a %s shared voice profile', async (status) => {
    await mockDb('voice_profiles').del();
    await mockDb('voice_profiles').insert({ version: 1, status, profile_text: 'Synthetic style profile',
      created_at: new Date(now.getTime() + 3600000) });
    await mockDb('voice_corpus_examples').insert({ source: 'email_human_reply', source_id: reply.id,
      customer_id: customer.id, inbound_text: 'Question', reply_text: 'Synthetic answer',
      created_at: new Date(now.getTime() + 7200000) });
    const anthropicClient = { messages: { create: jest.fn() } };
    expect(await distillVoiceProfile({ dbi: mockDb, anthropicClient }))
      .toEqual({ skipped: status === 'pending' ? 'pending_review' : 'no_new_corpus' });
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  test('SMS exemplar lookup never reads email examples', async () => {
    const intent = `fixture_${randomUUID().slice(0, 8)}`;
    await mockDb('voice_corpus_examples').insert([
      { source: 'email_human_reply', source_id: reply.id, intent,
        inbound_text: 'Email question', reply_text: 'Email-only answer', occurred_at: now },
      { source: 'sms_human_reply', source_id: randomUUID(), intent,
        inbound_text: 'SMS question', reply_text: 'SMS-only answer', occurred_at: now },
    ]);
    expect(await fetchVoiceExemplars({ intent, dbi: mockDb }))
      .toEqual([{ inbound_text: 'SMS question', reply_text: 'SMS-only answer' }]);
  });
});
