// Real PostgreSQL proof for SendGrid webhook attempt fencing and stale-event suppression.
let mockPg;
let mockAfterEmailMessageRead;
jest.mock('../models/db', () => {
  const database = (table) => {
    const query = mockPg(table);
    if (table === 'email_messages') {
      const first = query.first.bind(query);
      query.first = async (...args) => {
        const row = await first(...args);
        const after = mockAfterEmailMessageRead;
        mockAfterEmailMessageRead = null;
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
  newsletterGroupId: () => 101,
  serviceGroupId: () => 202,
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/email-bounce-recovery', () => ({
  isHardBounceEvent: jest.fn((ev) => ev?.event === 'bounce' && (!ev.type || ev.type === 'hard')),
  attemptRecovery: jest.fn(),
  alertBouncedContactAddress: jest.fn(),
  commitRecoveryOnDelivery: jest.fn(),
  isRecoveryMessage: jest.fn(() => false),
}));
jest.mock('../services/email-bounce-rescue', () => ({ rescueBouncedAddress: jest.fn() }));

const { randomUUID } = require('node:crypto');
const knex = require('knex');
const bounceRecovery = require('../services/email-bounce-recovery');
const bounceRescue = require('../services/email-bounce-rescue');
const { handleEmailMessageEvent, handleEvent } = require('../routes/webhooks-sendgrid');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `email_webhook_${randomUUID().replaceAll('-', '')}`;
const messageId = randomUUID();
let admin;

postgres('SendGrid webhook attempt fence (PostgreSQL)', () => {
  const priorNewsletterGroup = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
  const priorServiceGroup = process.env.SENDGRID_ASM_GROUP_SERVICE;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');
    process.env.SENDGRID_ASM_GROUP_NEWSLETTER = '101';
    process.env.SENDGRID_ASM_GROUP_SERVICE = '202';
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    await mockPg.schema.createTable('email_messages', (t) => {
      t.uuid('id').primary();
      ['provider_message_id', 'template_key', 'send_attempt_token', 'status', 'recipient_email_snapshot',
        'subject_snapshot', 'suppression_group_key_snapshot', 'error_message'].forEach((name) => t.string(name));
      t.integer('provider_retry_count').notNullable().defaultTo(0);
      t.boolean('has_attachments').notNullable().defaultTo(false);
      ['updated_at', 'delivered_at', 'opened_at', 'clicked_at', 'bounced_at', 'complained_at',
        'provider_retry_next_at', 'provider_retry_exhausted_at'].forEach((name) => t.timestamp(name));
    });
    await mockPg.schema.createTable('email_message_events', (t) => {
      t.uuid('email_message_id'); t.string('provider'); t.string('provider_event_id');
      t.string('event_type'); t.jsonb('raw_event'); t.timestamp('occurred_at');
    });
    await mockPg.schema.createTable('email_suppressions', (t) => {
      t.string('email'); t.string('status'); t.string('suppression_type'); t.string('group_key');
      t.string('source'); t.jsonb('metadata');
      ['suppressed_at', 'created_at', 'updated_at'].forEach((name) => t.timestamp(name));
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
  }, 30000);

  beforeEach(async () => {
    jest.clearAllMocks(); mockAfterEmailMessageRead = null;
    await mockPg('email_suppressions').delete();
    await mockPg('email_message_events').delete();
    await mockPg('sendgrid_webhook_events').delete();
    await mockPg('email_messages').delete();
    await mockPg('email_messages').insert({
      id: messageId,
      provider_message_id: 'provider-old',
      template_key: 'billing.notice',
      send_attempt_token: 'attempt-old',
      status: 'sent',
      recipient_email_snapshot: 'old@example.com',
      subject_snapshot: 'Billing notice',
      suppression_group_key_snapshot: 'service_operational',
      provider_retry_count: 3,
    });
  });

  afterAll(async () => {
    if (priorNewsletterGroup === undefined) delete process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
    else process.env.SENDGRID_ASM_GROUP_NEWSLETTER = priorNewsletterGroup;
    if (priorServiceGroup === undefined) delete process.env.SENDGRID_ASM_GROUP_SERVICE;
    else process.env.SENDGRID_ASM_GROUP_SERVICE = priorServiceGroup;
    await mockPg?.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  test('a stale blocked event cannot mutate a newly claimed attempt', async () => {
    const resolved = await mockPg('email_messages').where({ id: messageId }).first();
    await mockPg('email_messages').where({ id: messageId }).update({
      provider_message_id: 'provider-new', send_attempt_token: 'attempt-new', status: 'sent',
    });

    await expect(mockPg.transaction((trx) => handleEmailMessageEvent({
      event: 'blocked', email: 'old@example.com', response: 'provider reputation block',
      sg_event_id: 'stale-block', timestamp: Math.floor(Date.now() / 1000),
    }, resolved, trx))).resolves.toBe(false);

    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'sent', provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
      provider_retry_next_at: null,
    });
    expect(await mockPg('email_message_events').where({ provider_event_id: 'stale-block' })).toHaveLength(1);
  });

  test('a same-attempt blocked event retains normal mutation', async () => {
    const resolved = await mockPg('email_messages').where({ id: messageId }).first();
    await expect(mockPg.transaction((trx) => handleEmailMessageEvent({
      event: 'blocked', email: 'old@example.com', response: 'provider reputation block',
      sg_event_id: 'current-block', timestamp: Math.floor(Date.now() / 1000),
    }, resolved, trx))).resolves.toBe(true);
    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'failed', send_attempt_token: 'attempt-old', provider_retry_next_at: null,
      provider_retry_exhausted_at: expect.any(Date),
    });
  });

  test('a lost attempt mutation still records its address suppression', async () => {
    const resolved = await mockPg('email_messages').where({ id: messageId }).first();
    await mockPg('email_messages').where({ id: messageId }).update({ send_attempt_token: 'attempt-new' });
    await expect(mockPg.transaction((trx) => handleEmailMessageEvent({
      event: 'spamreport', email: 'old@example.com', sg_event_id: 'stale-spam',
      timestamp: Math.floor(Date.now() / 1000),
    }, resolved, trx))).resolves.toBe(false);
    expect(await mockPg('email_suppressions').where({ email: 'old@example.com' }).first())
      .toMatchObject({ suppression_type: 'spam_complaint', group_key: null, status: 'active' });
    expect((await mockPg('email_messages').where({ id: messageId }).first()).status).toBe('sent');
  });

  test('a claim won after resolution suppresses the address without recovery or attempt mutation', async () => {
    mockAfterEmailMessageRead = () => mockPg('email_messages').where({ id: messageId }).update({
      provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
    });
    await expect(handleEvent({
      event: 'bounce', type: 'hard', email: 'old@example.com', sg_event_id: 'claim-race-bounce',
      sg_message_id: 'provider-old.filter', send_attempt_token: 'attempt-old',
      timestamp: Math.floor(Date.now() / 1000),
    })).resolves.toBeUndefined();

    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'sent', provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
    });
    expect(await mockPg('email_suppressions').where({ email: 'old@example.com' }).first())
      .toMatchObject({ suppression_type: 'bounce', status: 'active' });
    expect(await mockPg('email_message_events').where({ provider_event_id: 'claim-race-bounce' })).toHaveLength(1);
    expect(bounceRecovery.attemptRecovery).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
  });

  test.each([
    ['bounce', 'bounced_at'],
    ['delivered', 'delivered_at'],
  ])('a stale no-op %s event cannot trigger recovery for a new attempt', async (event, timestampField) => {
    await mockPg('email_messages').where({ id: messageId }).update({ [timestampField]: new Date() });
    bounceRecovery.isRecoveryMessage.mockReturnValue(true);
    mockAfterEmailMessageRead = () => mockPg('email_messages').where({ id: messageId }).update({
      provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
    });
    await expect(handleEvent({
      event, type: 'hard', email: 'old@example.com', sg_event_id: `claim-race-no-op-${event}`,
      sg_message_id: 'provider-old.filter', send_attempt_token: 'attempt-old',
      timestamp: Math.floor(Date.now() / 1000),
    })).resolves.toBeUndefined();
    expect(bounceRecovery.attemptRecovery).not.toHaveBeenCalled();
    expect(bounceRecovery.commitRecoveryOnDelivery).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect((await mockPg('email_messages').where({ id: messageId }).first()).send_attempt_token).toBe('attempt-new');
  });

  test('a matching no-op delivery still retries uncommitted address recovery', async () => {
    await mockPg('email_messages').where({ id: messageId }).update({ delivered_at: new Date() });
    bounceRecovery.isRecoveryMessage.mockReturnValue(true);
    bounceRecovery.commitRecoveryOnDelivery.mockResolvedValue({ committed: true });
    await expect(handleEvent({
      event: 'delivered', email: 'old@example.com', sg_event_id: 'same-attempt-no-op-delivery',
      sg_message_id: 'provider-old.filter', send_attempt_token: 'attempt-old',
      timestamp: Math.floor(Date.now() / 1000),
    })).resolves.toBeUndefined();
    expect(bounceRecovery.commitRecoveryOnDelivery).toHaveBeenCalledTimes(1);
    expect(bounceRecovery.commitRecoveryOnDelivery).toHaveBeenCalledWith(expect.objectContaining({
      id: messageId, send_attempt_token: 'attempt-old',
    }));
  });

  test.each([
    ['precise marketing group', 'group_unsubscribe', 'marketing_referral', 101, 'marketing_referral', null],
    ['no-ASM snapshot with signed service group', 'group_unsubscribe', 'transactional_required', 202, 'service_operational', null],
    ['rewritten recipient', 'unsubscribe', 'service_operational', null, null, 'new@example.com'],
    ['hard bounce', 'bounce', 'service_operational', null, null, null],
  ])('a rebound stale %s event records suppression only', async (
    label, event, snapshotGroup, asmGroupId, expectedGroup, newRecipient,
  ) => {
    await mockPg('email_messages').where({ id: messageId }).update({
      provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
      suppression_group_key_snapshot: snapshotGroup,
      ...(newRecipient ? { recipient_email_snapshot: newRecipient } : {}),
    });
    await expect(handleEvent({
      event, type: event === 'bounce' ? 'hard' : undefined,
      email: 'old@example.com', asm_group_id: asmGroupId,
      sg_event_id: `stale-${event}-${label}`, sg_message_id: 'provider-old.filter',
      email_message_id: messageId, send_attempt_token: 'attempt-old',
      timestamp: Math.floor(Date.now() / 1000),
    })).resolves.toBeUndefined();

    expect(await mockPg('email_suppressions').where({ email: 'old@example.com' }).first()).toMatchObject({
      suppression_type: event === 'bounce' ? 'bounce' : 'unsubscribe', group_key: expectedGroup, status: 'active',
    });
    if (newRecipient) expect(await mockPg('email_suppressions').where({ email: newRecipient }).first()).toBeUndefined();
    expect(await mockPg('email_messages').where({ id: messageId }).first()).toMatchObject({
      status: 'sent', provider_message_id: 'provider-new', send_attempt_token: 'attempt-new',
    });
    expect(await mockPg('email_message_events').where({ email_message_id: messageId })).toHaveLength(0);
    expect(bounceRecovery.attemptRecovery).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
  });
});
