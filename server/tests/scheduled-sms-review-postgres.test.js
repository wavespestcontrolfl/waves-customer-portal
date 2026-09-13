// DB-gated CI verifies the actual JSONB attempt refund and atomic settlement.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../utils/cron-lock', () => ({
  runExclusive: async (_key, work) => work(),
  wasLockSkipped: () => false,
}));
const { randomUUID } = require('node:crypto');
const { dispatchScheduledSms, markScheduledSmsSent } = require('../services/scheduled-sms-delivery');
const { recoverStaleScheduledSmsClaims } = require('../services/scheduler');

postgres('queued review ask settlement against migrated PostgreSQL', () => {
  let database, trx, customerId;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree’s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
  });
  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function message(values) {
    const [row] = await trx('sms_log').insert({ customer_id: customerId, direction: 'outbound',
      from_phone: '+12025550101', to_phone: '+12025550102', message_body: 'Please leave a Google review.', ...values }).returning('*');
    return row;
  }

  test('a history hold refunds the claimed attempt while retaining unrelated metadata', async () => {
    const deliveredAt = new Date(Date.now() - 3600000);
    await message({ status: 'sent', created_at: deliveredAt });
    const row = await message({ status: 'sending', metadata: { scheduled_sms_attempts: 3, parked_decision_ids: ['synthetic-parked'] } });
    const send = jest.fn();
    expect(await dispatchScheduledSms(row, row.metadata, send)).toMatchObject({ scheduledHold: true, code: 'REVIEW_ASK_SPACING' });
    const saved = await trx('sms_log').where({ id: row.id }).first();
    expect(saved.status).toBe('scheduled');
    expect(saved.scheduled_for.getTime()).toBe(deliveredAt.getTime() + 72 * 3600000);
    expect(saved.metadata).toMatchObject({ scheduled_sms_attempts: 2, parked_decision_ids: ['synthetic-parked'] });
    expect(send).not.toHaveBeenCalled();
  });

  test('the sent stamp retains queue time, finalization obligation, and accepted SID', async () => {
    const queuedAt = new Date('2026-01-01T16:00:00Z');
    const row = await message({ status: 'sending', created_at: queuedAt, metadata: { entry_point: 'invoice_send_deferred' } });
    await markScheduledSmsSent(row, row.metadata, { sent: true, providerMessageId: 'SM-synthetic' });
    const saved = await trx('sms_log').where({ id: row.id }).first();
    expect(saved.status).toBe('sent');
    expect(saved.created_at.getTime()).toBeGreaterThan(queuedAt.getTime());
    expect(new Date(saved.metadata.queued_at)).toEqual(queuedAt);
    expect(saved.metadata).toMatchObject({ finalize_pending: true, provider_message_id: 'SM-synthetic', entry_point: 'invoice_send_deferred' });
  });

  test('crash recovery keeps an enqueue time an earlier pass already saved (codex #4334)', async () => {
    const now = new Date();
    const queuedAt = new Date('2026-01-01T16:00:00Z');
    // The dispatch path re-stamps created_at to send time and parks the real
    // enqueue time in metadata.queued_at. A crash between Twilio's accept and
    // markScheduledSmsSent leaves the row in exactly this shape.
    const dispatchedAt = new Date(now.getTime() - 45 * 60000);
    const row = await message({
      status: 'sending',
      created_at: dispatchedAt,
      scheduled_for: new Date(now.getTime() - 3600000),
      updated_at: new Date(now.getTime() - 31 * 60000),
      metadata: { queued_at: queuedAt, entry_point: 'invoice_send_deferred' },
    });
    // The provider row proving Twilio accepted it — what routes this row down
    // the settled branch rather than being re-scheduled or failed.
    await message({ status: 'sent', twilio_sid: 'SM-accepted',
      metadata: { scheduled_sms_log_id: String(row.id) } });

    await recoverStaleScheduledSmsClaims(now);

    const saved = await trx('sms_log').where({ id: row.id }).first();
    expect(saved.status).toBe('sent');
    // The original enqueue time survives; it is NOT overwritten with the
    // dispatch time that created_at was carrying.
    expect(new Date(saved.metadata.queued_at)).toEqual(queuedAt);
    expect(new Date(saved.metadata.queued_at).getTime()).not.toBe(dispatchedAt.getTime());
  });

  test('crash recovery falls back to created_at when no enqueue time was saved', async () => {
    const now = new Date();
    const queuedAt = new Date(now.getTime() - 45 * 60000);
    const row = await message({
      status: 'sending',
      created_at: queuedAt,
      scheduled_for: new Date(now.getTime() - 3600000),
      updated_at: new Date(now.getTime() - 31 * 60000),
      metadata: { entry_point: 'invoice_send_deferred' },
    });
    await message({ status: 'sent', twilio_sid: 'SM-accepted-2',
      metadata: { scheduled_sms_log_id: String(row.id) } });

    await recoverStaleScheduledSmsClaims(now);

    const saved = await trx('sms_log').where({ id: row.id }).first();
    expect(saved.status).toBe('sent');
    expect(new Date(saved.metadata.queued_at)).toEqual(queuedAt);
  });

  test('stale final-attempt uncertainty waits for its pre-provider safety deadline', async () => {
    const now = new Date();
    const safetyUntil = new Date(now.getTime() + 71 * 3600000);
    const row = await message({
      status: 'sending',
      scheduled_for: new Date(now.getTime() - 3600000),
      updated_at: new Date(now.getTime() - 31 * 60000),
      metadata: {
        scheduled_sms_attempts: 3,
        review_ask_reservation: true,
        review_delivery_uncertain_exhausted: true,
        review_delivery_safety_until: safetyUntil,
      },
    });

    await recoverStaleScheduledSmsClaims(now);

    const saved = await trx('sms_log').where({ id: row.id }).first();
    expect(saved.status).toBe('scheduled');
    expect(saved.scheduled_for).toEqual(safetyUntil);
    expect(saved.metadata).toMatchObject({
      scheduled_sms_attempts: 3,
      review_ask_reservation: true,
      review_delivery_uncertain_exhausted: true,
    });
    expect(saved.metadata.terminal_pending).toBeUndefined();
  });
});
