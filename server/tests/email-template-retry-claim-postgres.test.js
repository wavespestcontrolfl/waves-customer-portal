// Deterministic read/update races on synthetic rows in an isolated schema.
let mockPg;
let mockAfterSnapshot;
jest.mock('../models/db', () => {
  const database = (table) => {
    const query = mockPg(table);
    if (table === 'email_messages') {
      const first = query.first.bind(query);
      query.first = async (...args) => {
        const row = await first(...args);
        const after = mockAfterSnapshot;
        mockAfterSnapshot = null;
        if (after) await after(row);
        return row;
      };
    }
    return query;
  };
  database.raw = (...args) => mockPg.raw(...args);
  database.transaction = (...args) => mockPg.transaction(...args);
  return database;
});
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: () => 101, serviceGroupId: () => 202, sendOne: jest.fn(),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const { sendTemplate } = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `email_claim_${randomUUID().replaceAll('-', '')}`;
const templateId = randomUUID();
const versionId = randomUUID();
const messageId = randomUUID();
const key = `qa:claim:${messageId}`;
let admin;

postgres('email template retry claims (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('email_templates', (t) => {
      t.uuid('id').primary(); t.uuid('active_version_id'); t.string('template_key');
      t.string('name'); t.string('mode'); t.string('send_stream');
      t.jsonb('allowed_variables'); t.jsonb('required_variables');
    });
    await mockPg.schema.createTable('email_template_versions', (t) => {
      t.uuid('id').primary(); t.string('subject'); t.jsonb('blocks');
    });
    await mockPg.schema.createTable('email_suppressions', (t) => {
      t.string('email'); t.string('status'); t.string('suppression_type'); t.string('group_key');
    });
    await mockPg.schema.createTable('email_messages', (t) => {
      t.uuid('id').primary(); t.uuid('template_id'); t.uuid('template_version_id');
      ['provider', 'provider_message_id', 'template_key', 'send_attempt_token', 'status',
        'recipient_type', 'recipient_id', 'recipient_email_snapshot', 'from_name_snapshot',
        'from_email_snapshot', 'reply_to_snapshot', 'subject_snapshot', 'idempotency_key',
        'automation_run_id', 'trigger_event_id', 'suppression_group_key_snapshot'].forEach((name) => t.string(name));
      t.text('html_snapshot'); t.text('text_snapshot'); t.text('error_message');
      t.jsonb('payload_snapshot'); t.jsonb('categories');
      t.boolean('has_attachments').notNullable().defaultTo(false);
      t.integer('provider_retry_count').notNullable().defaultTo(0);
      ['queued_at', 'sent_at', 'updated_at', 'provider_retry_next_at', 'provider_retry_exhausted_at']
        .forEach((name) => t.timestamp(name));
      t.unique('idempotency_key');
    });
    await mockPg('email_templates').insert({ id: templateId, active_version_id: versionId,
      template_key: 'billing.notice', name: 'Fixture notice', mode: 'service', send_stream: 'service_operational',
      allowed_variables: JSON.stringify(['first_name']), required_variables: JSON.stringify(['first_name']) });
    await mockPg('email_template_versions').insert({ id: versionId, subject: 'Notice for {{first_name}}',
      blocks: JSON.stringify([{ type: 'paragraph', content: 'A fixture notice.' }]) });
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks(); mockAfterSnapshot = null;
    sendgrid.sendOne.mockResolvedValue({ messageId: 'qa-provider-acceptance' });
    await mockPg('email_messages').delete();
    await mockPg('email_suppressions').delete();
    await mockPg('email_messages').insert({ id: messageId, template_id: templateId,
      template_version_id: versionId, template_key: 'billing.notice', idempotency_key: key,
      recipient_email_snapshot: 'fixture@example.com', status: 'failed', send_attempt_token: 'prior-attempt',
      subject_snapshot: 'Original snapshot', queued_at: new Date(Date.now() - 3600000) });
  });

  afterAll(async () => {
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  const send = () => sendTemplate({ templateKey: 'billing.notice', to: 'fixture@example.com',
    payload: { first_name: 'Fixture' }, idempotencyKey: key });

  test.each([false, true])('cannot overwrite a worker claim after reading the old row (suppressed=%s)', async (suppressed) => {
    if (suppressed) await mockPg('email_suppressions').insert({
      email: 'fixture@example.com', status: 'active', suppression_type: 'do_not_email' });
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId }).update({
      status: 'queued', send_attempt_token: 'worker-attempt', provider_retry_count: 1,
      error_message: 'provider_handoff_pending' });
    await expect(send()).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'queued', send_attempt_token: 'worker-attempt', subject_snapshot: 'Original snapshot',
      error_message: 'provider_handoff_pending' });
  });

  test('a new attempt token fences a winner that has already failed again', async () => {
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId })
      .update({ send_attempt_token: 'newer-failed-attempt' });
    await expect(send()).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('cannot steal a provider schedule committed after its snapshot read', async () => {
    const scheduled = new Date(Date.now() + 600000);
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId })
      .update({ provider_retry_next_at: scheduled });
    await expect(send()).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ status: 'failed', provider_retry_next_at: scheduled, subject_snapshot: 'Original snapshot' });
  });

  test('reports the accepted winner without overwriting or sending again', async () => {
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId }).update({
      status: 'sent', send_attempt_token: 'accepted-attempt', provider_message_id: 'winner-provider-id' });
    await expect(send()).resolves.toMatchObject({ sent: true, deduped: true,
      message: { provider_message_id: 'winner-provider-id', send_attempt_token: 'accepted-attempt' } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test.each([null, 'prior-attempt'])('still retries an unowned failed row with prior token %s', async (token) => {
    await mockPg('email_messages').where({ id: messageId }).update({ send_attempt_token: token });
    await expect(send()).resolves.toMatchObject({ sent: true });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ status: 'sent', provider_message_id: 'qa-provider-acceptance' });
  });
});
