// cancel_queued_message / list_queued_messages against real PostgreSQL, in a
// rollback-only transaction on a private schema (same shape as
// sms-reply-holding-recovery-postgres.test.js). Skips cleanly with no
// DATABASE_URL. Synthetic customer only — no real names.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const { executeCommsTool } = require('../services/intelligence-bar/comms-tools');
jest.setTimeout(30000);

postgres('cancel_queued_message / list_queued_messages (real PostgreSQL)', () => {
  let database;
  let trx;
  let schema;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error("Use disposable CI or this worktree's private QA database");
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    schema = `cancel_queued_msg_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['sms_log', 'email_messages', 'customers']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function customer() {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture',
      phone: `941555${suffix.slice(0, 4)}`, email: `synthetic.${suffix}@example.com`,
      address_line1: '1 Synthetic Test Way', city: 'Bradenton', state: 'FL', zip: '34208',
    });
    return id;
  }

  async function scheduledSms(customerId, overrides = {}) {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: customerId, direction: 'outbound', from_phone: '+19413529161', to_phone: '+19415550100',
      message_body: 'Synthetic scheduled reminder', message_type: 'reminder', status: 'scheduled',
      scheduled_for: new Date(Date.now() + 3600000),
      ...overrides,
    });
    return id;
  }

  async function queuedEmail(customerId, overrides = {}) {
    const id = randomUUID();
    await trx('email_messages').insert({
      id, provider: 'sendgrid', template_key: 'synthetic.test_template', recipient_type: 'customer',
      recipient_id: String(customerId), recipient_email_snapshot: 'synthetic.fixture@example.com',
      subject_snapshot: 'Synthetic subject', status: 'queued', queued_at: new Date(),
      send_attempt_token: randomUUID(),
      ...overrides,
    });
    return id;
  }

  test('lists only queued/scheduled messages, never sent or cancelled ones', async () => {
    const custId = await customer();
    const queuedSmsId = await scheduledSms(custId);
    await scheduledSms(custId, { status: 'sent', scheduled_for: null });
    await scheduledSms(custId, { status: 'cancelled' });
    const queuedEmailId = await queuedEmail(custId);
    await queuedEmail(custId, { status: 'sent', send_attempt_token: randomUUID() });

    const out = await executeCommsTool('list_queued_messages', { customer_id: custId });
    expect(out.error).toBeUndefined();
    expect(out.total).toBe(2);
    expect(out.messages.map((m) => m.message_id).sort()).toEqual([queuedSmsId, queuedEmailId].sort());
    expect(out.messages.find((m) => m.channel === 'sms').masked_recipient).toBe('…0100');
    expect(out.messages.find((m) => m.channel === 'email').masked_recipient).toBe('s***@example.com');
  });

  test('channel filter narrows the list to one store', async () => {
    const custId = await customer();
    await scheduledSms(custId);
    await queuedEmail(custId);
    const out = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'email' });
    expect(out.total).toBe(1);
    expect(out.messages[0].channel).toBe('email');
  });

  test('cancels exactly one scheduled text and leaves a sibling untouched', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId);
    const siblingId = await scheduledSms(custId);

    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(preview).toMatchObject({ proposal: true, channel: 'sms', message_id: targetId, masked_recipient: '…0100' });
    expect(preview.scheduled_time).toBeTruthy();

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed).toMatchObject({ success: true, cancelled: true, channel: 'sms', message_id: targetId, messages_sent: false });

    expect((await trx('sms_log').where({ id: targetId }).first()).status).toBe('cancelled');
    expect((await trx('sms_log').where({ id: siblingId }).first()).status).toBe('scheduled');
  });

  test('cancels exactly one queued email and leaves a sibling untouched', async () => {
    const custId = await customer();
    const targetId = await queuedEmail(custId);
    const siblingId = await queuedEmail(custId);

    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'email' });
    expect(preview.proposal).toBe(true);

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'email', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed).toMatchObject({ success: true, cancelled: true, channel: 'email', message_id: targetId });

    expect((await trx('email_messages').where({ id: targetId }).first()).status).toBe('cancelled');
    expect((await trx('email_messages').where({ id: siblingId }).first()).status).toBe('queued');
  });

  test('refuses an sms already sent — it can never be recalled', async () => {
    const custId = await customer();
    const sentId = await scheduledSms(custId, { status: 'sent', scheduled_for: null });
    const out = await executeCommsTool('cancel_queued_message', { message_id: sentId, customer_id: custId, channel: 'sms' });
    expect(out.error).toMatch(/already been sent/i);
  });

  test('refuses an sms that already started sending (claimed by the worker)', async () => {
    const custId = await customer();
    const sendingId = await scheduledSms(custId, { status: 'sending' });
    const out = await executeCommsTool('cancel_queued_message', { message_id: sendingId, customer_id: custId, channel: 'sms' });
    expect(out.error).toBeTruthy();
  });

  test('refuses an email already sent — it can never be recalled', async () => {
    const custId = await customer();
    const sentId = await queuedEmail(custId, { status: 'sent' });
    const out = await executeCommsTool('cancel_queued_message', { message_id: sentId, customer_id: custId, channel: 'email' });
    expect(out.error).toMatch(/already been sent/i);
  });

  test('refuses when the sms was claimed (started sending) after the preview — the CAS catches the race', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });

    // The claim worker (claimDueScheduledSms, scheduler.js) grabs it between
    // the card being shown and Confirm.
    await trx('sms_log').where({ id: targetId }).update({ status: 'sending' });

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
    expect(confirmed.success).not.toBe(true);
    expect((await trx('sms_log').where({ id: targetId }).first()).status).toBe('sending');
  });

  test('refuses when the sms was rescheduled after the preview — the pinned scheduled_for no longer matches', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });

    const newTime = new Date(Date.now() + 7200000);
    await trx('sms_log').where({ id: targetId }).update({ scheduled_for: newTime });

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
    const row = await trx('sms_log').where({ id: targetId }).first();
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for.getTime()).toBe(newTime.getTime());
  });

  test('refuses when the email started its provider handoff after the preview — the CAS catches the race', async () => {
    const custId = await customer();
    const targetId = await queuedEmail(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'email' });

    // dispatchToProvider's own marker (email-template-library.js), stamped
    // immediately before the real SendGrid call.
    await trx('email_messages').where({ id: targetId }).update({ provider_handoff_phase: 'started' });

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'email', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
    expect((await trx('email_messages').where({ id: targetId }).first()).status).toBe('queued');
  });

  test('refuses when the email was reclaimed by a retry (a fresh send_attempt_token) after the preview', async () => {
    const custId = await customer();
    const targetId = await queuedEmail(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'email' });

    await trx('email_messages').where({ id: targetId }).update({ send_attempt_token: randomUUID() });

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'email', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
  });

  test('refuses when the message disappears between the preview and confirm — a failed re-check never reads as success', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });

    await trx('sms_log').where({ id: targetId }).delete();

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.error).toBeTruthy();
    expect(confirmed.success).not.toBe(true);
  });
});
