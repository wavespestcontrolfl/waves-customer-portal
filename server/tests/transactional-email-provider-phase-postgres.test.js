const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const db = (...args) => mockDatabase(...args);
  db.transaction = (...args) => mockDatabase.transaction(...args);
  db.raw = (...args) => mockDatabase.raw(...args);
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: jest.fn(() => 222),
  clearBlockedAddress: jest.fn(async () => ({ cleared: true })),
  sendOne: jest.fn(),
  isDefiniteRejection: jest.fn((err) => [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(Number(err?.status))),
}));
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: jest.fn(async () => ({ template: { template_key: 'quote.request_received' } })),
  activeSuppressionFor: jest.fn(async () => null),
  redactEmailAddresses: jest.fn(String),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/visit-completion-summary', () => ({
  retrySummaryThroughHandoff: jest.fn(async (message, dispatch) => { await dispatch(); return { ok: true }; }),
  reconcileSummaryEmailRecovery: jest.fn(async () => ({ reconciled: true })),
  reconcileSummaryEmailBounce: jest.fn(async () => ({ reconciled: true })),
}));

const migration = require('../models/migrations/20260926000200_email_message_provider_handoff_phase');
const retry = require('../services/transactional-email-provider-retry');
const sendgrid = require('../services/sendgrid-mail');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `provider_phase_${randomUUID().replaceAll('-', '')}`;
let admin;

function row(overrides = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    template_key: 'quote.request_received',
    recipient_type: 'customer',
    recipient_email_snapshot: 'qa@example.invalid',
    subject_snapshot: 'QA provider phase',
    suppression_group_key_snapshot: 'service_operational',
    categories: JSON.stringify(['email_template']),
    has_attachments: false,
    status: 'failed',
    provider_retry_count: 0,
    provider_retry_next_at: now,
    provider_retry_exhausted_at: null,
    provider_message_id: null,
    sent_at: null,
    queued_at: now,
    send_attempt_token: randomUUID(),
    error_message: 'provider rejected',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

postgres('transactional provider send phase (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockDatabase = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    await mockDatabase.schema.createTable('email_messages', (table) => {
      table.uuid('id').primary();
      table.string('template_key');
      table.string('recipient_type');
      table.string('recipient_email_snapshot');
      table.string('from_email_snapshot');
      table.string('from_name_snapshot');
      table.string('reply_to_snapshot');
      table.string('subject_snapshot');
      table.text('html_snapshot');
      table.text('text_snapshot');
      table.string('suppression_group_key_snapshot');
      table.jsonb('categories');
      table.boolean('has_attachments').notNullable().defaultTo(false);
      table.string('status').notNullable();
      table.integer('provider_retry_count').notNullable().defaultTo(0);
      table.timestamp('provider_retry_next_at');
      table.timestamp('provider_retry_exhausted_at');
      table.string('provider_message_id');
      table.timestamp('sent_at');
      table.timestamp('queued_at');
      table.uuid('send_attempt_token');
      table.text('error_message');
      table.timestamp('created_at');
      table.timestamp('updated_at');
    });
  }, 30000);

  afterEach(async () => {
    sendgrid.sendOne.mockReset();
    await mockDatabase('email_messages').del();
  });

  afterAll(async () => {
    await mockDatabase?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  test('migration is idempotent, enforces the phase domain, and reverses symmetrically', async () => {
    await migration.up(mockDatabase);
    await migration.up(mockDatabase);
    expect(await mockDatabase.schema.hasColumn('email_messages', 'provider_handoff_phase')).toBe(true);
    await expect(mockDatabase('email_messages').insert(row({ provider_handoff_phase: 'unknown' })))
      .rejects.toMatchObject({ code: '23514' });

    await migration.down(mockDatabase);
    expect(await mockDatabase.schema.hasColumn('email_messages', 'provider_handoff_phase')).toBe(false);
    await migration.down(mockDatabase);
    await migration.up(mockDatabase);
    expect(await mockDatabase.schema.hasColumn('email_messages', 'provider_handoff_phase')).toBe(true);
  });

  test('stale pending is refunded while started, rolling-deploy rejected, and unmarked legacy claims are held uncertain', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const pending = row({ status: 'queued', provider_retry_count: 2, provider_retry_next_at: null,
      queued_at: old, provider_handoff_phase: 'pending' });
    const started = row({ status: 'queued', provider_retry_count: 2, provider_retry_next_at: null,
      queued_at: old, provider_handoff_phase: 'started' });
    const rollingDeploy = row({ status: 'queued', provider_retry_count: 2, provider_retry_next_at: null,
      queued_at: old, provider_handoff_phase: 'rejected' });
    const legacy = row({ status: 'queued', provider_retry_count: 2, provider_retry_next_at: null,
      queued_at: old, provider_handoff_phase: null });
    await mockDatabase('email_messages').insert([pending, started, rollingDeploy, legacy]);

    await expect(retry.recoverStaleClaims(new Date())).resolves.toBe(4);
    const rows = await mockDatabase('email_messages').whereIn('id', [pending.id, started.id, rollingDeploy.id, legacy.id]);
    const byId = Object.fromEntries(rows.map((item) => [item.id, item]));
    expect(byId[pending.id]).toMatchObject({ status: 'failed', provider_retry_count: 1, provider_handoff_phase: 'pending' });
    expect(byId[pending.id].provider_retry_next_at).not.toBeNull();
    for (const id of [started.id, rollingDeploy.id, legacy.id]) {
      expect(byId[id]).toMatchObject({ status: 'failed', provider_retry_count: 2 });
      expect(byId[id].provider_retry_next_at).toBeNull();
      expect(byId[id].provider_retry_exhausted_at).not.toBeNull();
    }
  });

  test('safe failures can cycle, while an ambiguous final request preserves started and consumes the claim', async () => {
    const original = row({ provider_handoff_phase: 'rejected' });
    await mockDatabase('email_messages').insert(original);

    let [claimed] = await retry.claimDueRetries(1, new Date(Date.now() + 1000));
    expect(claimed).toMatchObject({ provider_retry_count: 1, provider_handoff_phase: 'pending' });
    await retry.markRetryFailure(claimed, new Error('clear block failed'));
    let stored = await mockDatabase('email_messages').where({ id: original.id }).first();
    expect(stored).toMatchObject({ status: 'failed', provider_handoff_phase: 'pending', provider_retry_count: 1 });

    await mockDatabase('email_messages').where({ id: original.id }).update({ provider_retry_next_at: new Date() });
    [claimed] = await retry.claimDueRetries(1, new Date(Date.now() + 1000));
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    await retry.retryOne(claimed);
    stored = await mockDatabase('email_messages').where({ id: original.id }).first();
    expect(stored).toMatchObject({ status: 'failed', provider_handoff_phase: 'rejected', provider_retry_count: 2 });
    expect(stored.provider_retry_next_at).not.toBeNull();

    await mockDatabase('email_messages').where({ id: original.id }).update({ provider_retry_next_at: new Date() });
    [claimed] = await retry.claimDueRetries(1, new Date(Date.now() + 1000));
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('gateway failed'), { status: 500 }));
    await expect(retry.retryOne(claimed)).resolves.toMatchObject({ uncertain: true });
    stored = await mockDatabase('email_messages').where({ id: original.id }).first();
    expect(stored).toMatchObject({ status: 'failed', provider_handoff_phase: 'started', provider_retry_count: 3 });
    expect(stored.provider_retry_next_at).toBeNull();
    expect(stored.provider_retry_exhausted_at).not.toBeNull();
  });

  test('a token stolen before pending-to-started CAS prevents provider dispatch', async () => {
    const original = row({ provider_handoff_phase: 'rejected' });
    await mockDatabase('email_messages').insert(original);
    const [claimed] = await retry.claimDueRetries(1, new Date(Date.now() + 1000));
    await mockDatabase('email_messages').where({ id: original.id }).update({ send_attempt_token: randomUUID() });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'must-not-send' });

    await expect(retry.retryOne(claimed)).resolves.toEqual({ sent: false, stopped: true, reason: 'claim_lost' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await mockDatabase('email_messages').where({ id: original.id }).first()).provider_handoff_phase).toBe('pending');
  });

  test('concurrent claimers consume one due row once', async () => {
    const original = row({ provider_handoff_phase: 'rejected' });
    await mockDatabase('email_messages').insert(original);
    const now = new Date(Date.now() + 1000);

    const claims = await Promise.all([
      retry.claimDueRetries(1, now),
      retry.claimDueRetries(1, now),
    ]);

    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0]).toMatchObject({ id: original.id, status: 'queued',
      provider_retry_count: 1, provider_handoff_phase: 'pending' });
    const stored = await mockDatabase('email_messages').where({ id: original.id }).first();
    expect(stored).toMatchObject({ status: 'queued', provider_retry_count: 1,
      provider_handoff_phase: 'pending' });
  });

  test('legacy scheduled rows require exact positive pending evidence before claim', async () => {
    const unsafe = row({ provider_handoff_phase: null, error_message: 'timeout before marker persisted' });
    const compatible = row({ provider_handoff_phase: null, error_message: retry.HANDOFF_PENDING });
    await mockDatabase('email_messages').insert([unsafe, compatible]);

    await expect(retry.recoverStaleClaims(new Date(Date.now() + 1000))).resolves.toBe(1);
    const claimed = await retry.claimDueRetries(10, new Date(Date.now() + 1000));
    expect(claimed.map((item) => item.id)).toEqual([compatible.id]);
    const held = await mockDatabase('email_messages').where({ id: unsafe.id }).first();
    expect(held).toMatchObject({ status: 'failed', provider_retry_next_at: null });
    expect(held.provider_retry_exhausted_at).not.toBeNull();
  });
});
