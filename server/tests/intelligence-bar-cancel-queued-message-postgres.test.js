// cancel_queued_message / list_queued_messages against real PostgreSQL, in a
// rollback-only transaction on a private schema (same shape as
// sms-reply-holding-recovery-postgres.test.js). Skips cleanly with no
// DATABASE_URL. Synthetic customer only — no real names.
//
// SMS-ONLY (owner ruling 2026-09-28): an email_messages 'queued' row is an
// in-flight send (sendTemplate hands it to SendGrid within seconds), not a
// scheduled email to hold and cancel — cancelling it always races the
// sender at one producer site or another. Only a genuinely held sms_log row
// (quiet hours, an uncertain-delivery retry) is ever listed or cancelable.
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

postgres('cancel_queued_message / list_queued_messages (real PostgreSQL, SMS-only)', () => {
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
    for (const table of ['sms_log', 'customers']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const STAFF_ID = randomUUID();

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
      // Staff-scheduled by default — the bar's simple-only allowlist.
      admin_user_id: STAFF_ID,
      scheduled_for: new Date(Date.now() + 3600000),
      ...overrides,
    });
    return id;
  }

  test('lists only scheduled texts, never sent or cancelled ones', async () => {
    const custId = await customer();
    const queuedSmsId = await scheduledSms(custId);
    await scheduledSms(custId, { status: 'sent', scheduled_for: null });
    await scheduledSms(custId, { status: 'cancelled' });

    const out = await executeCommsTool('list_queued_messages', { customer_id: custId });
    expect(out.error).toBeUndefined();
    expect(out.total).toBe(1);
    expect(out.messages[0].message_id).toBe(queuedSmsId);
    expect(out.messages[0].channel).toBe('sms');
    expect(out.messages[0].masked_recipient).toBe('…0100');
  });

  test('a channel of "email" is rejected by the tool — there is no scheduled-email store to check', async () => {
    const custId = await customer();
    await scheduledSms(custId);
    const out = await executeCommsTool('cancel_queued_message', {
      message_id: randomUUID(), customer_id: custId, channel: 'email',
    });
    expect(out.error).toMatch(/channel must be "sms"/i);
  });

  // Owner ruling 2026-09-28: the bar cancels only STANDALONE messages,
  // refused OUTRIGHT — never redirected to the Communications inbox. A
  // deferred-replay entry point (with or without an onTerminal hook) is
  // workflow-owned; a bare cancel — including the inbox's own, which calls
  // the SAME shared writer — would strand that workflow's obligation.
  test('a workflow-owned sms_log row is excluded from the list and refused outright (no inbox pointer), but an ordinary sibling still lists and cancels', async () => {
    const { TERMINAL_HOOK_ENTRY_POINTS } = require('../services/messaging/deferred-replay-registry');
    const entryPoint = TERMINAL_HOOK_ENTRY_POINTS[0];
    const custId = await customer();
    const workflowOwnedId = await scheduledSms(custId, { metadata: { entry_point: entryPoint } });
    const ordinaryId = await scheduledSms(custId);

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages.map((m) => m.message_id)).toEqual([ordinaryId]);

    const refused = await executeCommsTool('cancel_queued_message', { message_id: workflowOwnedId, customer_id: custId, channel: 'sms' });
    expect(refused.error).toMatch(/managed by the/i);
    expect(refused.error).not.toMatch(/communications inbox/i);

    const preview = await executeCommsTool('cancel_queued_message', { message_id: ordinaryId, customer_id: custId, channel: 'sms' });
    expect(preview.proposal).toBe(true);
    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: ordinaryId, customer_id: custId, channel: 'sms', confirmed: true, _verified_message_version: preview._version,
    });
    expect(confirmed.success).toBe(true);
    // The workflow-owned row is completely untouched.
    expect((await trx('sms_log').where({ id: workflowOwnedId }).first()).status).toBe('scheduled');
  });

  test('a deferred-replay row WITHOUT a terminal hook (invoice_send_deferred holds its invoice claim) is refused too, with no inbox pointer', async () => {
    const custId = await customer();
    const id = await scheduledSms(custId, { message_type: 'invoice', metadata: { entry_point: 'invoice_send_deferred' } });
    const out = await executeCommsTool('cancel_queued_message', { message_id: id, customer_id: custId, channel: 'sms' });
    expect(out.error).toMatch(/managed by the invoice send deferred workflow/i);
    expect(out.error).not.toMatch(/communications inbox/i);
    expect((await trx('sms_log').where({ id }).first()).status).toBe('scheduled');
  });

  // "Recruiting threads are answered from Recruiting only" — a recruiting-
  // typed row with NO entry_point at all (so the deferred-replay check
  // never catches it) must still be excluded/refused, via message_type.
  test('a recruiting-typed scheduled text (job_* message_type, no entry_point) is excluded from the list and refused outright, with no inbox pointer', async () => {
    const custId = await customer();
    const recruitingId = await scheduledSms(custId, { message_type: 'job_application_received', metadata: {} });
    const ordinaryId = await scheduledSms(custId);

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages.map((m) => m.message_id)).toEqual([ordinaryId]);

    const refused = await executeCommsTool('cancel_queued_message', { message_id: recruitingId, customer_id: custId, channel: 'sms' });
    expect(refused.error).toMatch(/managed by the Recruiting workflow/i);
    expect(refused.error).not.toMatch(/communications inbox/i);

    // Completely untouched — not merely refused-but-mutated.
    expect((await trx('sms_log').where({ id: recruitingId }).first()).status).toBe('scheduled');
  });

  test('a finalize_only sms_log row is excluded from the list and refused as already-delivered', async () => {
    const custId = await customer();
    const alreadyDeliveredId = await scheduledSms(custId, { metadata: { finalize_only: true } });

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages).toEqual([]);

    const out = await executeCommsTool('cancel_queued_message', { message_id: alreadyDeliveredId, customer_id: custId, channel: 'sms' });
    expect(out.error).toMatch(/already reached the provider/i);
    expect((await trx('sms_log').where({ id: alreadyDeliveredId }).first()).status).toBe('scheduled'); // untouched
  });

  // Codex round 3 on #5224, P1: dispatch() (scheduled-sms-delivery.js)
  // stamps review_ask_reservation BEFORE every review-ask provider call and
  // does NOT clear it when an ambiguous attempt is held back to 'scheduled'
  // for its next retry (holdUncertainReservation) — only when delivery is
  // later proven accepted or definitely not sent. review_delivery_uncertain_
  // exhausted is stamped only on the FINAL such attempt, so a row can carry
  // review_ask_reservation alone, well before exhaustion, while Twilio may
  // already have accepted an earlier attempt. Both states must refuse.
  test.each([
    ['review_ask_reservation alone (an earlier ambiguous attempt, held for retry)', { review_ask_reservation: true, scheduled_sms_attempts: 1 }],
    ['review_ask_reservation + review_delivery_uncertain_exhausted (the final ambiguous attempt)', { review_ask_reservation: true, review_delivery_uncertain_exhausted: true, scheduled_sms_attempts: 3 }],
  ])('a %s sms_log row is excluded from the list and refused as possibly-already-sent, completely untouched', async (_label, metaFlag) => {
    const custId = await customer();
    const targetId = await scheduledSms(custId, { message_type: 'review_request', metadata: metaFlag });

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    expect(listed.messages).toEqual([]);

    const out = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(out.error).toMatch(/may already have reached the provider/i);

    // Never reaches the shared cancel workflow — status AND metadata (the
    // 72h ask-spacing evidence) are completely untouched, not merely
    // "cancelled but marker preserved."
    const row = await trx('sms_log').where({ id: targetId }).first();
    expect(row.status).toBe('scheduled');
    expect(row.metadata).toMatchObject(metaFlag);
  });

  // Codex round 2 on #5224, P2: a bounded body preview rides both the list
  // output and the cancel preview, and is pinned into `_version` so an
  // edited body between the card and Confirm refuses.
  test('a body preview rides the list and the preview, and is pinned — a body edit between preview and confirm refuses', async () => {
    const custId = await customer();
    const longBody = 'Hi there,    this   is a synthetic reminder body that runs well past one hundred and sixty characters so the preview truncation logic actually has something real to cut off before the end.';
    const targetId = await scheduledSms(custId, { message_body: longBody });

    const listed = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms' });
    const collapsed = longBody.replace(/\s+/g, ' ').trim();
    expect(listed.messages[0].body_preview).toBe(`${collapsed.slice(0, 160)}…`);

    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(preview.body_preview).toBe(`${collapsed.slice(0, 160)}…`);
    expect(preview._version.body_preview).toBe(preview.body_preview);

    // The body changes (a reviewer edited the draft) after the card, before Confirm.
    await trx('sms_log').where({ id: targetId }).update({ message_body: 'Completely different edited wording' });
    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
    expect(confirmed.success).not.toBe(true);
    expect((await trx('sms_log').where({ id: targetId }).first()).status).toBe('scheduled'); // untouched
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

  // scheduled-sms-cancel.js's review-ask-reservation-in-place special case
  // (cancel without erasing the marker, preserving 72h ask-spacing evidence)
  // still exists and is still exercised — but only via the admin SMS inbox
  // route directly now (admin-communications-scheduled-cancel.test.js),
  // never via this IB tool: Codex round 3 on #5224, P1, closed the gap
  // where the tool's OWN preview let a review_ask_reservation row through
  // to that in-place cancel at all, since Twilio may already have accepted
  // an earlier attempt on this exact row. See the test.each above.
  test('a review-ask-reservation-marked scheduled text is refused outright by the IB tool, completely untouched (not cancelled in place)', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId, {
      message_type: 'review_request',
      metadata: { review_ask_reservation: true, scheduled_sms_attempts: 3 },
    });

    const out = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(out.proposal).not.toBe(true);
    expect(out.error).toMatch(/may already have reached the provider/i);

    const row = await trx('sms_log').where({ id: targetId }).first();
    expect(row.status).toBe('scheduled'); // never flipped to 'canceled' — the row is untouched, not cancelled in place
    expect(row.metadata).toMatchObject({ review_ask_reservation: true, scheduled_sms_attempts: 3 });
  });

  // Codex round 3 on #5224, P2: customer-contact-fanout.js can rewrite a
  // still-'scheduled' row's to_phone (a customer phone edit) without
  // touching status or scheduled_for. The tool pins to_phone into _version
  // alongside scheduled_for, so a recipient change between the card and
  // Confirm refuses instead of cancelling a text now addressed to someone
  // else's old number.
  test('refuses when the recipient phone was rewritten after the preview — the pinned to_phone no longer matches', async () => {
    const custId = await customer();
    const targetId = await scheduledSms(custId);
    const preview = await executeCommsTool('cancel_queued_message', { message_id: targetId, customer_id: custId, channel: 'sms' });
    expect(preview._version.to_phone).toBe('+19415550100');

    // customer-contact-fanout.js rewrites to_phone on a phone edit, leaving
    // status and scheduled_for untouched.
    await trx('sms_log').where({ id: targetId }).update({ to_phone: '+19415550199' });

    const confirmed = await executeCommsTool('cancel_queued_message', {
      message_id: targetId, customer_id: custId, channel: 'sms', confirmed: true,
      _verified_message_version: preview._version,
    });
    expect(confirmed.preview_changed).toBe(true);
    expect(confirmed.success).not.toBe(true);

    const row = await trx('sms_log').where({ id: targetId }).first();
    expect(row.status).toBe('scheduled'); // untouched
    expect(row.to_phone).toBe('+19415550199'); // the rewrite itself is never reverted
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

  // Codex rounds 6-7 on #5224: the simple-only rule is enforced in the SAME
  // statement that cancels, not just in the preview — a claim marker or an
  // Agent Review decision landing between the fresh re-read and the DELETE
  // still refuses. Driven at the writer so the race window is deterministic.
  test.each([
    ['a worker claim marker', { scheduled_sms_claimed_at: '2099-01-01T11:40:00Z' }],
    ['an AI-reply provider_retry marker', { provider_retry: true }],
    ['an agent decision', { agent_decision_id: 'dec-synthetic-1' }],
    ['parked decisions', { parked_decision_ids: ['dec-synthetic-2'] }],
    ['an automated producer entry_point (deposit-receipt requeue)', { entry_point: 'estimate_deposit_receipt_requeue' }],
  ])('the writer\'s simpleOnly CAS refuses a row carrying %s', async (_label, metadata) => {
    const { cancelScheduledSmsRow } = require('../services/scheduled-sms-cancel');
    const custId = await customer();
    const targetId = await scheduledSms(custId, { metadata });
    const result = await cancelScheduledSmsRow({ id: targetId, techRole: 'admin', simpleOnly: true });
    expect(result.cancelled).toBe(false);
    expect((await trx('sms_log').where({ id: targetId }).first()).status).toBe('scheduled');
  });

  test('the writer refuses when customer ownership moved (customer-dedupe repoint) — expectedCustomerId pin', async () => {
    const { cancelScheduledSmsRow } = require('../services/scheduled-sms-cancel');
    const custId = await customer();
    const otherId = await customer();
    const targetId = await scheduledSms(custId);
    await trx('sms_log').where({ id: targetId }).update({ customer_id: otherId });
    const result = await cancelScheduledSmsRow({ id: targetId, techRole: 'admin', expectedCustomerId: custId, simpleOnly: true });
    expect(result.cancelled).toBe(false);
    expect((await trx('sms_log').where({ id: targetId }).first()).status).toBe('scheduled');
  });

  test('list_queued_messages pages by cursor across equal and NULL scheduled_for values without skipping or repeating', async () => {
    const custId = await customer();
    const same = new Date(Date.now() + 3600000);
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(await scheduledSms(custId, { scheduled_for: same }));
    ids.push(await scheduledSms(custId, { scheduled_for: null }));
    const seen = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await executeCommsTool('list_queued_messages', { customer_id: custId, channel: 'sms', limit: 1, ...(cursor ? { cursor } : {}) });
      expect(page.error).toBeUndefined();
      seen.push(...page.messages.map((m) => m.message_id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen[seen.length - 1]).toBe(ids[3]); // NULL scheduled_for sorts last
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
