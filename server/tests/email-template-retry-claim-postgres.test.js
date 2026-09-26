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
const { handleEmailMessageEvent, handleEvent } = require('../routes/webhooks-sendgrid');
const providerRetry = require('../services/transactional-email-provider-retry');
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
      t.string('suppression_group_key');
      t.jsonb('allowed_variables'); t.jsonb('required_variables');
    });
    await mockPg.schema.createTable('email_template_versions', (t) => {
      t.uuid('id').primary(); t.string('subject'); t.jsonb('blocks');
    });
    await mockPg.schema.createTable('email_suppressions', (t) => {
      t.string('email'); t.string('status'); t.string('suppression_type'); t.string('group_key');
      t.string('source'); t.jsonb('metadata');
      ['suppressed_at', 'created_at', 'updated_at'].forEach((name) => t.timestamp(name));
    });
    await mockPg.schema.createTable('email_message_events', (t) => {
      t.uuid('email_message_id'); t.string('provider'); t.string('provider_event_id');
      t.string('event_type'); t.jsonb('raw_event'); t.timestamp('occurred_at');
    });
    await mockPg.schema.createTable('sendgrid_webhook_events', (t) => {
      t.string('event_id').primary(); t.string('event_type'); t.string('message_id');
      t.string('email'); t.string('status'); t.timestamp('processed_at'); t.timestamp('updated_at');
    });
    await mockPg.schema.createTable('newsletter_send_deliveries', (t) => {
      t.uuid('id').primary(); t.string('provider_message_id'); t.string('email');
    });
    await mockPg.schema.createTable('automation_step_sends', (t) => {
      t.uuid('id').primary(); t.string('sendgrid_message_id');
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
    await mockPg('email_message_events').delete();
    await mockPg('sendgrid_webhook_events').delete();
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

  test('cannot replay a definitely-unsent exhaustion after its evidence becomes uncertain', async () => {
    const firstExhaustedAt = new Date(Date.now() - 60000);
    await mockPg('email_messages').where({ id: messageId }).update({ provider_retry_count: 3,
      provider_retry_exhausted_at: firstExhaustedAt, error_message: 'Provider request not started: unblock failed' });
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId }).update({
      error_message: 'Provider outcome unknown: connection closed after request',
    });

    await expect(send()).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ provider_retry_exhausted_at: firstExhaustedAt,
        error_message: 'Provider outcome unknown: connection closed after request' });
  });

  test('stale-claim recovery refunds a claim without erasing prior uncertainty', async () => {
    const now = new Date();
    await mockPg('email_messages').where({ id: messageId }).update({
      status: 'queued', provider_retry_count: 1, provider_retry_next_at: null,
      provider_retry_exhausted_at: null, provider_message_id: null, sent_at: null,
      queued_at: new Date(now.getTime() - 60 * 60 * 1000),
      error_message: 'Provider outcome unknown: prior request timed out',
    });

    await expect(providerRetry.recoverStaleClaims(now)).resolves.toBe(1);
    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'failed', provider_retry_count: 0, provider_retry_next_at: now,
      error_message: 'Provider outcome unknown: prior request timed out',
    });
  });

  test('reports the accepted winner without overwriting or sending again', async () => {
    mockAfterSnapshot = () => mockPg('email_messages').where({ id: messageId }).update({
      status: 'sent', send_attempt_token: 'accepted-attempt', provider_message_id: 'winner-provider-id' });
    await expect(send()).resolves.toMatchObject({ sent: true, deduped: true,
      message: { provider_message_id: 'winner-provider-id', send_attempt_token: 'accepted-attempt' } });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test.each([null, 'prior-attempt'])('a late webhook cannot schedule a newer accepted attempt (old token %s)', async (token) => {
    await mockPg('email_messages').where({ id: messageId }).update({ send_attempt_token: token });
    const resolvedBeforeClaim = await mockPg('email_messages').where({ id: messageId }).first();
    await expect(send()).resolves.toMatchObject({ sent: true });
    await expect(mockPg.transaction((trx) => handleEmailMessageEvent({
      event: 'blocked', email: 'fixture@example.com', sg_event_id: 'qa-stale-block',
      response: 'Fixture provider block', timestamp: Math.floor(Date.now() / 1000),
    }, resolvedBeforeClaim, trx))).resolves.toBe(false);
    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'sent', provider_message_id: 'qa-provider-acceptance', provider_retry_next_at: null,
    });
    expect(await mockPg('email_message_events').where({ provider_event_id: 'qa-stale-block' }))
      .toHaveLength(1);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });

  test('a lost attempt mutation still records the address opt-out', async () => {
    const resolvedBeforeClaim = await mockPg('email_messages').where({ id: messageId }).first();
    await send();
    await expect(mockPg.transaction((trx) => handleEmailMessageEvent({
      event: 'unsubscribe', email: 'fixture@example.com', sg_event_id: 'qa-stale-opt-out',
      timestamp: Math.floor(Date.now() / 1000),
    }, { ...resolvedBeforeClaim, suppression_group_key_snapshot: 'transactional_required' }, trx)))
      .resolves.toBe(false);
    expect(await mockPg('email_suppressions').where({ email: 'fixture@example.com' }).first())
      .toMatchObject({ status: 'active', suppression_type: 'unsubscribe', group_key: null });
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ status: 'sent', provider_message_id: 'qa-provider-acceptance' });
  });

  test.each([
    ['unsubscribe', 'unsubscribe', null, null, 'service_operational', null],
    ['group unsubscribe', 'group_unsubscribe', 'service_operational', null, 'service_operational', null],
    ['spam report', 'spamreport', null, null, 'service_operational', null],
    ['unsubscribe after a recipient rewrite', 'unsubscribe', null, 'new-destination@example.com', 'service_operational', null],
    ['precise marketing group unsubscribe', 'group_unsubscribe', 'marketing_referral', null, 'marketing_referral', 'qa-newsletter'],
  ])('a stale custom-arg %s records only its address suppression after retry rebinding',
  async (_label, event, groupKey, newDestination, snapshotGroup, asmGroupId) => {
    await send();
    await mockPg('email_messages').where({ id: messageId }).update({
      suppression_group_key_snapshot: snapshotGroup,
      ...(newDestination ? { recipient_email_snapshot: newDestination } : {}),
    });

    const priorNewsletterGroup = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
    if (asmGroupId) process.env.SENDGRID_ASM_GROUP_NEWSLETTER = asmGroupId;
    try {
      await expect(handleEvent({
        event, email: 'fixture@example.com', sg_event_id: `qa-old-attempt-${event}-${snapshotGroup}`,
        sg_message_id: 'old-provider-id.filter', email_message_id: messageId, asm_group_id: asmGroupId,
        send_attempt_token: 'prior-attempt', timestamp: Math.floor(Date.now() / 1000),
      })).resolves.toBeUndefined();
    } finally {
      if (priorNewsletterGroup === undefined) delete process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
      else process.env.SENDGRID_ASM_GROUP_NEWSLETTER = priorNewsletterGroup;
    }

    expect(await mockPg('email_suppressions').where({ email: 'fixture@example.com' }).first())
      .toMatchObject({ status: 'active', suppression_type: event === 'spamreport' ? 'spam_complaint' : 'unsubscribe',
        group_key: groupKey });
    if (newDestination) expect(await mockPg('email_suppressions').where({ email: newDestination }).first()).toBeUndefined();
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ status: 'sent', provider_message_id: 'qa-provider-acceptance',
        recipient_email_snapshot: newDestination || 'fixture@example.com' });
    expect(await mockPg('email_message_events').where({ provider_event_id: `qa-old-attempt-${event}-${snapshotGroup}` }))
      .toHaveLength(0);
  });

  test.each([null, 'prior-attempt'])('still retries an unowned failed row with prior token %s', async (token) => {
    await mockPg('email_messages').where({ id: messageId }).update({ send_attempt_token: token });
    await expect(send()).resolves.toMatchObject({ sent: true });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(await mockPg('email_messages').where({ id: messageId }).first())
      .toMatchObject({ status: 'sent', provider_message_id: 'qa-provider-acceptance' });
  });
});
