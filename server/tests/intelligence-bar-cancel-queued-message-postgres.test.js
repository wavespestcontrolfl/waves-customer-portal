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

  // Owner ruling 2026-09-28: the bar cancels only STANDALONE messages. A
  // deferred-replay entry point with an onTerminal hook is workflow-owned
  // (a bare cancel would strand that workflow's obligation) — excluded from
  // the list, refused by name in the preview, pointed at the Communications
  // inbox instead.
  test('a workflow-owned sms_log row is excluded from the list and refused in the preview, but an ordinary sibling still lists and cancels', async () => {
    const { TERMINAL_HOOK_ENTRY_POINTS } = require('../services/messaging/deferred-replay-registry');
    const entryPoint = TERMINAL_HOOK_ENTRY_POINTS[0];
    const custId = await customer();
    const workflowOwnedId = await scheduledSms(custId, { metadata: { entry_point: entryPoint } });
    const ordinaryId = await scheduledSms(custId);

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages.map((m) => m.message_id)).toEqual([ordinaryId]);

    const refused = await executeCommsTool('cancel_queued_message', { message_id: workflowOwnedId, customer_id: custId, channel: 'sms' });
    expect(refused.error).toMatch(/workflow/i);
    expect(refused.error).toMatch(/communications inbox/i);

    const preview = await executeCommsTool('cancel_queued_message', { message_id: ordinaryId, customer_id: custId, channel: 'sms' });
    expect(preview.proposal).toBe(true);
    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: ordinaryId, customer_id: custId, channel: 'sms', confirmed: true, _verified_message_version: preview._version,
    });
    expect(confirmed.success).toBe(true);
    // The workflow-owned row is completely untouched.
    expect((await trx('sms_log').where({ id: workflowOwnedId }).first()).status).toBe('scheduled');
  });

  // Claude fallback auditor P1 on #5224 (round 2): "Recruiting threads are
  // answered from Recruiting only" — a recruiting-typed row with NO
  // entry_point at all (so the deferred-replay terminal-hook check above
  // never catches it) must still be excluded/refused, via the SAME
  // message_type-keyed guard (excludeRecruitingSmsLog) every other sms_log
  // reader in comms-tools.js already applies.
  test('a recruiting-typed scheduled text (job_* message_type, no entry_point) is excluded from the list and refused in the preview', async () => {
    const custId = await customer();
    const recruitingId = await scheduledSms(custId, { message_type: 'job_application_received', metadata: {} });
    const ordinaryId = await scheduledSms(custId);

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages.map((m) => m.message_id)).toEqual([ordinaryId]);

    const refused = await executeCommsTool('cancel_queued_message', { message_id: recruitingId, customer_id: custId, channel: 'sms' });
    expect(refused.proposal).not.toBe(true);
    expect(refused.error).toBeTruthy();

    // Completely untouched — not merely refused-but-mutated.
    expect((await trx('sms_log').where({ id: recruitingId }).first()).status).toBe('scheduled');
  });

  test.each([
    ['finalize_only', { finalize_only: true }],
    ['review_delivery_uncertain_exhausted', { review_delivery_uncertain_exhausted: true }],
  ])('a %s sms_log row is excluded from the list and refused as already-delivered', async (_label, metaFlag) => {
    const custId = await customer();
    const alreadyDeliveredId = await scheduledSms(custId, { metadata: metaFlag });

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages).toEqual([]);

    const out = await executeCommsTool('cancel_queued_message', { message_id: alreadyDeliveredId, customer_id: custId, channel: 'sms' });
    expect(out.error).toMatch(/already reached the provider/i);
    expect((await trx('sms_log').where({ id: alreadyDeliveredId }).first()).status).toBe('scheduled'); // untouched
  });

  // Codex round 1 on #5224 (P1): status alone cannot tell a truly-idle
  // queued email from one whose SendGrid request is in flight RIGHT NOW —
  // provider_handoff_phase is the real marker, and it must be checked at
  // PREVIEW time too, not only inside the commit CAS.
  test('an email whose provider handoff already started is refused at the preview, never proposable', async () => {
    const custId = await customer();
    const sendingId = await queuedEmail(custId, { provider_handoff_phase: 'started' });
    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'email' });
    expect(listed.messages).toEqual([]);
    const out = await executeCommsTool('cancel_queued_message', { message_id: sendingId, customer_id: custId, channel: 'email' });
    expect(out.proposal).not.toBe(true);
    expect(out.error).toMatch(/currently being sent/i);
  });

  test('cancels exactly one scheduled text (physically deleted, the shared inbox workflow\'s ordinary case) and leaves a sibling untouched', async () => {
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

    // scheduled-sms-cancel.js's ordinary case physically deletes the row
    // (the same shared workflow the admin SMS inbox's DELETE route uses).
    expect(await trx('sms_log').where({ id: targetId }).first()).toBeUndefined();
    expect((await trx('sms_log').where({ id: siblingId }).first()).status).toBe('scheduled');
  });

  // Owner ruling / Codex round 1 on #5224: the IB cancel must run the SAME
  // shared workflow the admin SMS inbox uses — proven here by the exact
  // review-ask-reservation-in-place special case that workflow exists for.
  // A bare status flip (this tool's pre-fix behavior) would have deleted
  // this row, erasing the 72h ask-spacing evidence review-ask-history's
  // lastManualAskAt reads regardless of status.
  test('cancels a review-ask-reservation-marked scheduled text IN PLACE, preserving the reservation as spacing evidence', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId, {
      metadata: { review_ask_reservation: true, scheduled_sms_attempts: 3 },
    });

    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(preview.proposal).toBe(true);

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed).toMatchObject({ success: true, cancelled: true, channel: 'sms', message_id: targetId });

    const row = await trx('sms_log').where({ id: targetId }).first();
    expect(row).toBeDefined();
    expect(row.status).toBe('canceled'); // single L — scheduled-sms-cancel.js's in-place marker, not a delete
    expect(row.metadata).toMatchObject({ review_ask_reservation: true, scheduled_sms_attempts: 3 });
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
