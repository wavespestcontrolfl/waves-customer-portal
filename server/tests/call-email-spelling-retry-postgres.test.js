/**
 * Automation path of the resend to the other spelling (owner 2026-11-05, GATE_CALL_BOUNCE_OTHER_SPELLING): the first email a
 * new lead gets goes out through automation-runner (automation_step_sends). On a true hard bounce of a call-captured
 * address whose other spelling the call settled, the webhook re-queues the bounced step to the other spelling instead of
 * cancelling, with no alert, no transcript rescue and no read-back card; a DELIVERED send to that address replaces the
 * customer email through the canonical fanout; a bounce of the retry address cancels and fails the ledger row.
 * Real PostgreSQL (the migrated database): the cursor rewind, the once-only ledger and the savepoint are SQL behavior.
 * All names and addresses synthetic.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const { randomUUID } = require('node:crypto');

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'retry-message-1' })),
  newsletterGroupId: () => 101,
  serviceGroupId: () => 202,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The two outputs the owner ruled out on this path are spies; everything else in the recovery module is real.
jest.mock('../services/email-bounce-recovery', () => ({
  ...jest.requireActual('../services/email-bounce-recovery'),
  alertBouncedContactAddress: jest.fn(async () => ({ alerted: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/email-bounce-rescue', () => ({ rescueBouncedAddress: jest.fn(async () => ({})) }));
jest.mock('../services/email-bounce-reverify', () => ({
  ...jest.requireActual('../services/email-bounce-reverify'),
  reverifyBouncedEmailFromCall: jest.fn(async () => ({})),
}));
jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('automation hard bounce: resend to the other spelling the call settled (Postgres)', () => {
  jest.setTimeout(30000);
  const BOUNCED = 'jondoe@example.com';
  const OTHER = 'jondoh@example.com';
  let db;
  let webhook;
  let runner;
  let sendgrid;
  let bounceRecovery;
  let bounceRescue;
  let reverify;
  let NotificationService;
  let ctx;
  const priorGate = process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
  const created = { customers: [], templates: [] };

  beforeAll(() => {
    db = require('../models/db');
    webhook = require('../routes/webhooks-sendgrid');
    runner = require('../services/automation-runner');
    sendgrid = require('../services/sendgrid-mail');
    bounceRecovery = require('../services/email-bounce-recovery');
    bounceRescue = require('../services/email-bounce-rescue');
    reverify = require('../services/email-bounce-reverify');
    NotificationService = require('../services/notification-service');
  });

  async function cleanup() {
    for (const id of created.customers) {
      await db('call_email_spelling_retries').where({ customer_id: id }).del();
      await db('email_messages').where({ recipient_id: id }).del(); // cascades the bounce-recovery ledger
      await db('audit_log').where({ resource_id: id }).del();
      await db('call_log').where({ customer_id: id }).del();
      await db('estimates').where({ customer_id: id }).del();
      await db('automation_enrollments').where({ customer_id: id }).del();
      await db('customers').where({ id }).del();
    }
    for (const key of created.templates) await db('automation_templates').where({ key }).del();
    created.customers = [];
    created.templates = [];
    await db('email_suppressions').whereIn('email', [BOUNCED, OTHER, 'jon.doe@gmail.com', 'jondoe@gmail.com']).del();
    await db('sendgrid_webhook_events').where('event_id', 'like', 'ev-%').del();
  }

  afterEach(cleanup);

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    else process.env.GATE_CALL_BOUNCE_OTHER_SPELLING = priorGate;
    await cleanup();
    await db.destroy();
  });

  async function seedCustomer(email) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Jon', last_name: 'Doe', email, active: true, pipeline_stage: 'new_lead',
      phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`,
    });
    created.customers.push(id);
    return id;
  }

  async function seedCall(customerId, { email = BOUNCED, other = OTHER, settled = true } = {}) {
    const extraction = { email, ...(settled ? { email_spelling_settled: { email, other_spelling: other } } : {}) };
    const [row] = await db('call_log').insert({ customer_id: customerId, ai_extraction: JSON.stringify(extraction) }).returning('id');
    return row.id;
  }

  // Two enabled steps with no delay. `sent` = how many the enrollment already passed (the runner sends, then the bounce lands).
  async function seedEnrollment({ asm = 'service', sent = 1, status = 'active', email = BOUNCED, role = null, customerId } = {}) {
    const key = `retry_${randomUUID().slice(0, 8)}`;
    await db('automation_templates').insert({ key, name: 'Synthetic lead welcome', asm_group: asm, enabled: true, trigger_type: 'manual' });
    created.templates.push(key);
    const steps = [];
    for (const order of [1, 2]) {
      const [step] = await db('automation_steps').insert({
        template_key: key, step_order: order, delay_hours: 0, subject: `Step ${order}`, html_body: `<p>Hello {{first_name}} ${order}</p>`, text_body: `Hello ${order}`,
      }).returning('*');
      steps.push(step);
    }
    const passed = steps.slice(0, sent);
    const last = passed[passed.length - 1] || null;
    const done = sent >= steps.length;
    const [enrollment] = await db('automation_enrollments').insert({
      template_key: key, customer_id: customerId, email, first_name: 'Jon', last_name: 'Doe',
      status: done && status === 'active' ? 'completed' : status,
      current_step: Math.min(sent, steps.length),
      completed_at: done ? new Date() : null,
      last_sent_at: new Date(),
      next_send_at: done ? null : new Date(Date.now() + (last ? 3600 * 1000 : -1000)),
      metadata: JSON.stringify({
        ...(last ? { passed_step_order: last.step_order, passed_step_id: String(last.id), passed_step_ids: passed.map((s) => String(s.id)) } : {}),
        ...(role ? { recipient_role: role } : {}),
      }),
    }).returning('*');
    if (!last) return { key, steps, enrollment, send: null, last };
    const [send] = await db('automation_step_sends').insert({
      enrollment_id: enrollment.id, step_id: last.id, step_order: last.step_order, email, status: 'sent',
      sendgrid_message_id: `msg-${randomUUID()}`, sent_at: new Date(),
    }).returning('*');
    return { key, steps, enrollment, send, last };
  }

  async function setup(opts = {}) {
    const customerId = await seedCustomer(opts.customerEmail || BOUNCED);
    const callId = opts.call === false ? null : await seedCall(opts.callCustomerId || customerId, opts.call || {});
    const seeded = await seedEnrollment({ ...opts, customerId });
    return { customerId, callId, ...seeded };
  }

  const bounce = (send, email = send.email) => ({
    event: 'bounce', type: 'bounce', email, reason: '550 5.1.1 user unknown', sg_event_id: `ev-${randomUUID()}`, sg_message_id: `${send.sendgrid_message_id}.filter0`,
  });
  const ledger = (customerId) => db('call_email_spelling_retries').where({ customer_id: customerId });
  const enrollmentRow = (id) => db('automation_enrollments').where({ id }).first();
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_CALL_BOUNCE_OTHER_SPELLING = 'true';
    sendgrid.sendOne.mockImplementation(async () => ({ messageId: `retry-${randomUUID()}` }));
  });

  test('gate off: the bounce cancels the enrollment, alerts and runs the rescue exactly as before', async () => {
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    expect(bounceRescue.rescueBouncedAddress).toHaveBeenCalledTimes(1);
  });

  test('a settled other spelling: the enrollment is repointed and the same step is sent again once; no cancel, no alert, no rescue, no card', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();

    const enrollment = await enrollmentRow(ctx.enrollment.id);
    expect(enrollment).toMatchObject({ status: 'active', email: OTHER, current_step: 0, completed_at: null });
    expect(new Date(enrollment.next_send_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(enrollment.metadata.passed_step_ids).toEqual([]);
    const rows = await ledger(ctx.customerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'resending', bounced_email: BOUNCED, retry_email: OTHER, channel: 'automation', source_call_id: ctx.callId, origin_send_id: ctx.send.id,
    });
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    // The bounced address itself stays suppressed.
    expect(await db('email_suppressions').whereRaw('LOWER(email) = ?', [BOUNCED]).where({ status: 'active' }).first()).toBeTruthy();

    // The next runner tick sends step 1 again, to the other spelling, and moves on to step 2; a second tick sends step 2 only.
    await runner.sendStep(enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 1' }));
    const resends = await db('automation_step_sends').where({ enrollment_id: enrollment.id, step_id: ctx.last.id }).orderBy('created_at');
    expect(resends.map((r) => [r.email, r.status])).toEqual([[BOUNCED, 'bounced'], [OTHER, 'sent']]);
    expect(await enrollmentRow(enrollment.id)).toMatchObject({ status: 'active', current_step: 1 });
    await runner.sendStep(enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 2' }));
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(2);
    expect(await enrollmentRow(enrollment.id)).toMatchObject({ status: 'completed' });
  });

  test('a single-step sequence already completed when the bounce lands is reactivated for the one resend', async () => {
    ctx = await setup({ sent: 2 });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'completed' });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: OTHER, current_step: 1, completed_at: null });
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 2' }));
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'completed' });
  });

  test('the customer\'s other live enrollment to the same address follows it (no step re-sent for it)', async () => {
    ctx = await setup({ sent: 1 });
    const second = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await enrollmentRow(second.enrollment.id)).toMatchObject({ status: 'active', email: OTHER, current_step: 0 });
  });

  test('delivered to the other spelling: the customer email is replaced through the fanout, the row is committed, one audit row is written, no bell', async () => {
    ctx = await setup({ sent: 1 });
    await db('estimates').insert({ customer_id: ctx.customerId, customer_email: BOUNCED });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    const retrySend = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    await db('automation_step_sends').where({ id: retrySend.id }).update({ sendgrid_message_id: 'retry-delivered-1' });

    await webhook.handleEvent({ event: 'delivered', email: OTHER, sg_event_id: `ev-${randomUUID()}`, sg_message_id: 'retry-delivered-1.filter0' });

    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect((await db('estimates').where({ customer_id: ctx.customerId }).first()).customer_email).toBe(OTHER);
    const [row] = await ledger(ctx.customerId);
    expect(row).toMatchObject({ status: 'committed', retry_send_id: retrySend.id });
    expect(row.committed_at).toBeTruthy();
    const audits = await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ bounced_email: BOUNCED, retry_email: OTHER, channel: 'automation', source_call_id: ctx.callId });
    expect(audits[0].action.length).toBeLessThanOrEqual(96);
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
  });

  test('delivered: a hand edit of the email in between wins, nothing is overwritten, the row is skipped', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await db('customers').where({ id: ctx.customerId }).update({ email: 'jonny.doe@example.com' });
    const retrySend = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    await db('automation_step_sends').where({ id: retrySend.id }).update({ sendgrid_message_id: 'retry-delivered-2' });
    await webhook.handleEvent({ event: 'delivered', email: OTHER, sg_event_id: `ev-${randomUUID()}`, sg_message_id: 'retry-delivered-2.filter0' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe('jonny.doe@example.com');
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'email_changed', retry_send_id: retrySend.id });
  });

  test('delivered with the gate off (kill switch): nothing is replaced', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    await db('automation_step_sends').insert({
      enrollment_id: ctx.enrollment.id, step_id: ctx.last.id, step_order: 1, email: OTHER, status: 'sent', sendgrid_message_id: 'retry-delivered-3',
    });
    await webhook.handleEvent({ event: 'delivered', email: OTHER, sg_event_id: `ev-${randomUUID()}`, sg_message_id: 'retry-delivered-3.filter0' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending' });
  });

  test('the other spelling bounces too: the enrollment is cancelled, the row fails, the one existing alert fires for the address on file, no rescue and no card', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    const retrySend = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    await db('automation_step_sends').where({ id: retrySend.id }).update({ sendgrid_message_id: 'retry-bounced-1' });
    jest.clearAllMocks();

    await webhook.handleEvent({ ...bounce({ sendgrid_message_id: 'retry-bounced-1' }, OTHER) });
    await flush();

    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced', retry_send_id: retrySend.id });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledWith(BOUNCED, expect.objectContaining({ reason: expect.stringContaining('other spelling') }));
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
  });

  test.each(['blocked', 'dropped'])('a %s event never starts the retry (only a true hard bounce does)', async (event) => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent({ event, email: BOUNCED, reason: 'Bounced Address', sg_event_id: `ev-${randomUUID()}`, sg_message_id: `${ctx.send.sendgrid_message_id}.filter0` });
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: BOUNCED, current_step: 1 });
  });

  // Every case below must behave exactly as today: the enrollment is cancelled and no retry row says it was re-sent.
  const noRetryCases = [
    ['the other spelling is the same Gmail inbox', {
      customerEmail: 'jon.doe@gmail.com', email: 'jon.doe@gmail.com', call: { email: 'jon.doe@gmail.com', other: 'jondoe@gmail.com' },
    }],
    ['the call settled nothing (no email_spelling_settled)', { call: { settled: false } }],
    ['no call at all', { call: false }],
    ['the call belongs to another customer', { callOther: true }],
    ['the other spelling is suppressed', { suppressOther: true }],
    ['another customer already holds the other spelling', { ownedByOther: true }],
    ['the template is a marketing-stream (newsletter) automation', { asm: 'newsletter' }],
    ['the step is addressed to an on-location contact', { role: 'service_contact_1' }],
    ['the customer no longer has the bounced address as primary email', { customerEmail: 'jonny.doe@example.com' }],
    ['the enrollment is not linked to a customer', { unlinked: true }],
  ];
  test.each(noRetryCases)('no retry when %s: cancelled as today, alert and rescue as today, no ledger row', async (_name, opts) => {
    const email = opts.email || BOUNCED;
    ctx = await setup({ ...opts, email });
    if (opts.callOther) {
      const stranger = await seedCustomer('stranger.doe@example.com');
      await db('call_log').where({ id: ctx.callId }).update({ customer_id: stranger });
    }
    if (opts.suppressOther) {
      await db('email_suppressions').insert({ email: OTHER, status: 'active', suppression_type: 'bounce', source: 'test', suppressed_at: new Date() });
    }
    if (opts.ownedByOther) await seedCustomer(OTHER);
    if (opts.unlinked) await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ customer_id: null });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email });
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    // The rescue stays withheld for marketing-stream automations, as before.
    expect(bounceRescue.rescueBouncedAddress).toHaveBeenCalledTimes(opts.asm === 'newsletter' ? 0 : 1);
  });

  test('never twice: a second bounce of the same customer + address starts nothing', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    // A sibling send to the same address bounces later; the enrollment (now on the other spelling) is untouched.
    const [sibling] = await db('automation_step_sends').insert({
      enrollment_id: ctx.enrollment.id, step_id: ctx.last.id, step_order: 1, email: BOUNCED, status: 'sent', sendgrid_message_id: `sib-${randomUUID()}`,
    }).returning('*');
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ email: BOUNCED });
    await webhook.handleEvent(bounce(sibling));
    await flush();
    expect(await ledger(ctx.customerId)).toHaveLength(1);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
  });

  test('a later step already went out: nothing is rewound, the row is skipped and the enrollment is cancelled as today', async () => {
    ctx = await setup({ sent: 2, status: 'active' });
    // The bounced send is for step 1 but the enrollment passed step 2 too.
    await db('automation_step_sends').where({ id: ctx.send.id }).update({ step_id: ctx.steps[0].id, step_order: 1 });
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ status: 'active', completed_at: null });
    await webhook.handleEvent(bounce({ ...ctx.send, email: BOUNCED }));
    await flush();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'sequence_cursor_moved' });
  });

  // ── The tracked email_messages path shares ONE claim with the automation path (P1, pre-push audit) ──────────────────────
  async function seedBouncedMessage(customerId, over = {}) {
    const [row] = await db('email_messages').insert({
      id: randomUUID(), provider: 'sendgrid', recipient_type: 'customer', recipient_id: customerId, recipient_email_snapshot: BOUNCED,
      subject_snapshot: 'Your estimate', html_snapshot: '<p>Hello</p>', text_snapshot: 'Hello', categories: JSON.stringify(['email_template']),
      suppression_group_key_snapshot: 'service_operational', status: 'bounced', idempotency_key: `orig-${randomUUID()}`, ...over,
    }).returning('*');
    return row;
  }
  const hardBounce = { event: 'bounce', type: 'bounce', sg_event_id: 'ev-tracked' };
  const trackedClaim = (customerId) => db('call_email_spelling_retries').where({ customer_id: customerId, channel: 'email_message' });
  const recoveryRows = (messageId) => db('email_bounce_recoveries').where({ original_message_id: messageId });

  test('tracked path: a settled other spelling is resent once under an email_message claim; the commit on delivery replaces the customer email and settles the claim', async () => {
    const customerId = await seedCustomer(BOUNCED);
    const callId = await seedCall(customerId);
    const original = await seedBouncedMessage(customerId);
    const res = await bounceRecovery.attemptRecovery(original, hardBounce);
    expect(res).toMatchObject({ resent: true, corrected: OTHER, rule: 'call_other_spelling' });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER }));
    const [claim] = await trackedClaim(customerId);
    expect(claim).toMatchObject({ status: 'resending', bounced_email: BOUNCED, retry_email: OTHER, origin_send_id: original.id, source_call_id: callId });

    const [rec] = await recoveryRows(original.id);
    const recoveryMessage = await db('email_messages').where({ id: rec.recovery_message_id }).first();
    await bounceRecovery.commitRecoveryOnDelivery(recoveryMessage);
    expect((await db('customers').where({ id: customerId }).first()).email).toBe(OTHER);
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'committed', retry_send_id: recoveryMessage.id });
  });

  test('tracked path, kill switch: the gate switched off between the resend and its delivery overwrites nothing and runs no fanout', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    await db('estimates').insert({ customer_id: customerId, customer_email: BOUNCED });
    const original = await seedBouncedMessage(customerId);
    await bounceRecovery.attemptRecovery(original, hardBounce);
    const [rec] = await recoveryRows(original.id);
    const recoveryMessage = await db('email_messages').where({ id: rec.recovery_message_id }).first();

    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    await bounceRecovery.commitRecoveryOnDelivery(recoveryMessage);

    expect((await db('customers').where({ id: customerId }).first()).email).toBe(BOUNCED);
    expect((await db('estimates').where({ customer_id: customerId }).first()).customer_email).toBe(BOUNCED);
    expect((await recoveryRows(original.id))[0]).toMatchObject({ status: 'delivered', record_updated: false });
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'skipped', reason: 'gate_off' });
  });

  test('tracked path: when the resend bounces too, the claim fails, the existing alert fires and no call-audio card is raised', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const original = await seedBouncedMessage(customerId);
    await bounceRecovery.attemptRecovery(original, hardBounce);
    const [rec] = await recoveryRows(original.id);
    const recoveryMessage = await db('email_messages').where({ id: rec.recovery_message_id }).first();
    jest.clearAllMocks();
    await bounceRecovery.handleRecoveryBounce(recoveryMessage, { event: 'bounce', type: 'bounce' });
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect((await recoveryRows(original.id))[0]).toMatchObject({ status: 'redelivered_bounced' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
  });

  test('an automation claim blocks the tracked path: nothing is sent, no alert, no card, a quiet ledger status', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    expect(await ledger(ctx.customerId)).toHaveLength(1);
    jest.clearAllMocks();

    const original = await seedBouncedMessage(ctx.customerId);
    const res = await bounceRecovery.attemptRecovery(original, hardBounce);

    expect(res).toEqual({ skipped: 'other_spelling_already_tried' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await db('email_messages').where({ recipient_email_snapshot: OTHER, recipient_id: ctx.customerId })).toEqual([]);
    expect((await recoveryRows(original.id))[0]).toMatchObject({ status: 'other_spelling_already_tried', correction_rule: 'call_other_spelling' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    expect(await ledger(ctx.customerId)).toHaveLength(1);
  });

  test('a tracked claim blocks the automation path: the bounce cancels, alerts and rescues as today, no second resend', async () => {
    ctx = await setup({ sent: 1 });
    const original = await seedBouncedMessage(ctx.customerId);
    await bounceRecovery.attemptRecovery(original, hardBounce);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(await trackedClaim(ctx.customerId)).toHaveLength(1);
    jest.clearAllMocks();

    await webhook.handleEvent(bounce(ctx.send));
    await flush();

    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
    expect(await ledger(ctx.customerId)).toHaveLength(1);
    expect((await ledger(ctx.customerId))[0].channel).toBe('email_message');
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a claim in ANY status blocks a later try: a failed automation retry stops the tracked path too', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await db('call_email_spelling_retries').where({ customer_id: ctx.customerId }).update({ status: 'failed', reason: 'retry_address_bounced' });
    const original = await seedBouncedMessage(ctx.customerId);
    expect(await bounceRecovery.attemptRecovery(original, hardBounce)).toEqual({ skipped: 'other_spelling_already_tried' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('two different bounced messages for the same customer + address race: exactly one resend, one claim row', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const first = await seedBouncedMessage(customerId);
    const second = await seedBouncedMessage(customerId);
    const results = await Promise.all([
      bounceRecovery.attemptRecovery(first, { ...hardBounce, sg_event_id: 'ev-r1' }),
      bounceRecovery.attemptRecovery(second, { ...hardBounce, sg_event_id: 'ev-r2' }),
    ]);
    expect(results.filter((r) => r.resent)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === 'other_spelling_already_tried')).toHaveLength(1);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(await trackedClaim(customerId)).toHaveLength(1);
  });

  test('a recovery resumed from a dispute-hold park keeps its own claim (same original message), a different message does not', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const claims = require('../services/call-email-spelling-retry');
    const mine = randomUUID();
    const args = { customerId, bouncedEmail: BOUNCED, retryEmail: OTHER, channel: 'email_message', originId: mine };
    expect((await claims.claimRetry({ ...args, resumeOriginId: mine }, db)).claimed).toBe(true);
    expect((await claims.claimRetry({ ...args, resumeOriginId: mine }, db)).claimed).toBe(true);
    expect((await claims.claimRetry({ ...args, originId: randomUUID(), resumeOriginId: randomUUID() }, db)).claimed).toBe(false);
    expect(await trackedClaim(customerId)).toHaveLength(1);
  });

  // ── Kill switch at the runner's send boundary (P1-A, pre-push audit) ─────────────────────────────────────────────────
  const dueNow = (enrollmentId) => db('automation_enrollments').where({ id: enrollmentId }).update({ next_send_at: new Date(Date.now() - 1000) });
  const cancelReason = async (id) => (await enrollmentRow(id)).metadata.cancel_reason;

  test('gate switched off after the rewind and before the next tick: the rewound enrollment sends nothing, is cancelled like a hard bounce, the claim is skipped', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;

    await runner.sendStep(ctx.enrollment.id);

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
    expect(await cancelReason(ctx.enrollment.id)).toBe('hard_bounce');
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'gate_off', retry_send_id: null }); // gate off: never bound
    expect((await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }))[0]).toMatchObject({ status: 'blocked' });
  });

  test('gate switched off: a repointed sibling enrollment is stopped too (whichever is reached first ends both)', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;

    await runner.sendStep(sibling.enrollment.id);

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    for (const id of [sibling.enrollment.id, ctx.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'cancelled' });
      expect(await cancelReason(id)).toBe('hard_bounce');
    }
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'gate_off' });
  });

  test('gate off after a COMMIT: the enrollment kept the retry address (now the profile email), lost its provenance, and its next step goes out', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id); // step 1 to the other spelling
    await retrySendOf(ctx.enrollment.id, 'commit-clears-1');
    await delivered('commit-clears-1');
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    const after = await enrollmentRow(ctx.enrollment.id);
    expect(after).toMatchObject({ status: 'active', email: OTHER });
    expect(after.metadata.spelling_retry_email).toBeUndefined();
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 2' }));
  });

  test('gate switched off at the provider boundary itself (after the early check): nothing is sent, the retry ends', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    sendgrid.sendOne.mockImplementationOnce(async (args) => {
      delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING; // flipped while the request was being prepared
      await args.providerBoundaryCheck(); // the real sendOne awaits this immediately before the request and lets a throw escape
      return { messageId: 'must-not-send' };
    });
    await runner.sendStep(ctx.enrollment.id);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'gate_off' });
    expect((await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }))[0]).toMatchObject({ status: 'blocked' });
  });

  // ── Serialized with the runner's prep-send lock (P1-B, pre-push audit) ───────────────────────────────────────────────
  const until = async (check, ms = 4000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('condition not reached');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  test('the runner is already sending step 2 when step 1\'s bounce arrives: the webhook waits for the lock, then finds the cursor moved, rewinds nothing and re-sends nothing', async () => {
    ctx = await setup({ sent: 1 });
    await dueNow(ctx.enrollment.id);
    let release;
    sendgrid.sendOne.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ messageId: 'step-2-message' }); }));
    const runnerRun = runner.sendStep(ctx.enrollment.id); // holds the customer's prep-send lock across the provider request
    await until(() => sendgrid.sendOne.mock.calls.length === 1);

    let hookDone = false;
    const hook = webhook.handleEvent(bounce(ctx.send)).then(() => { hookDone = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(hookDone).toBe(false); // waiting on the lock, not racing the cursor
    expect(await ledger(ctx.customerId)).toEqual([]);

    release();
    await Promise.all([runnerRun, hook]);
    await flush();

    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1); // step 2 once; step 1 is not sent again
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Step 2' }));
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'completed', email: BOUNCED });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'sequence_cursor_moved' });
  });

  test('the webhook has rewound but not committed when the runner ticks: the tick skips on the lock, and after the commit step 1 goes out once to the other spelling', async () => {
    ctx = await setup({ sent: 1 });
    await dueNow(ctx.enrollment.id);
    const sendRow = await db('automation_step_sends').where({ id: ctx.send.id }).first();
    let tickDuring;
    await db.transaction(async (trx) => {
      await webhook.handleAutomationEvent(bounce(ctx.send), sendRow, trx);
      tickDuring = await runner.sendStep(ctx.enrollment.id); // another connection: the prep-send lock is held by this transaction
    });
    expect(tickDuring).toMatchObject({ sent: false, skipped: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();

    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 1' }));
  });

  // ── Settlement is bound to the actual retry SEND (P1-D, pre-push audit) ───────────────────────────────────────────────
  const delivered = (messageId) => webhook.handleEvent({ event: 'delivered', email: OTHER, sg_event_id: `ev-${randomUUID()}`, sg_message_id: `${messageId}.filter0` });
  async function retrySendOf(enrollmentId, messageId) {
    const send = await db('automation_step_sends').where({ enrollment_id: enrollmentId, email: OTHER }).orderBy('created_at', 'desc').first();
    await db('automation_step_sends').where({ id: send.id }).update({ sendgrid_message_id: messageId });
    return send;
  }
  const strayAutomationSend = async (enrollmentId, stepId, messageId, email = OTHER) => (await db('automation_step_sends').insert({
    enrollment_id: enrollmentId, step_id: stepId, step_order: 1, email, status: 'sent', sendgrid_message_id: messageId,
  }).returning('*'))[0];

  test('the retry send is recorded on the claim by the same transaction that creates its send row', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    expect((await ledger(ctx.customerId))[0].retry_send_id).toBeNull(); // re-queued, not sent yet
    await runner.sendStep(ctx.enrollment.id);
    const sent = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: sent.id });
  });

  test('an older delivery to the same address does not commit; only the bound retry send does', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    const bound = await retrySendOf(ctx.enrollment.id, 'bound-retry-1');
    await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'older-send-1'); // an older, unrelated send to the same address

    await delivered('older-send-1');
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: bound.id });

    await delivered('bound-retry-1');
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'committed', retry_send_id: bound.id });
  });

  test('a bounce of a send that is not the bound retry send does not fail the claim', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    const bound = await retrySendOf(ctx.enrollment.id, 'bound-retry-2');
    const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'older-send-2');
    await webhook.handleEvent(bounce(stray, OTHER));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: bound.id });
  });

  test('another customer\'s pending claim on the same alternate address is untouched by this customer\'s delivery, and cannot hijack it', async () => {
    ctx = await setup({ sent: 1 });
    const stranger = await setup({ sent: 1, customerEmail: 'stranger.doe@example.com', email: 'stranger.doe@example.com', call: { email: 'stranger.doe@example.com', other: OTHER } });
    const strangerSend = await strayAutomationSend(stranger.enrollment.id, stranger.last.id, 'stranger-send-1');
    await db('call_email_spelling_retries').insert({
      customer_id: stranger.customerId, bounced_email: 'stranger.doe@example.com', retry_email: OTHER, channel: 'automation', status: 'resending', retry_send_id: strangerSend.id,
    });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'bound-retry-3');

    await delivered('bound-retry-3');

    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    expect((await ledger(stranger.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: strangerSend.id });
    expect((await db('customers').where({ id: stranger.customerId }).first()).email).toBe('stranger.doe@example.com');
  });

  test('a sibling repointed without a re-send never binds or settles the claim', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(sibling.enrollment.id); // the sibling sends ITS first step to the retry address
    expect((await ledger(ctx.customerId))[0].retry_send_id).toBeNull();
    const siblingSend = await retrySendOf(sibling.enrollment.id, 'sibling-send-1');
    await delivered('sibling-send-1');
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: null });
    await webhook.handleEvent(bounce(siblingSend, OTHER));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending' });
  });

  // ── Tracked path: the same chokepoints (P1-C) ─────────────────────────────────────────────────────────────────────────
  test('tracked path: gate off right before the provider handoff sends nothing, blocks the staged message, skips the claim, tells nobody', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const original = await seedBouncedMessage(customerId);
    sendgrid.sendOne.mockImplementationOnce(async (args) => {
      delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING; // flipped while the request was being prepared
      await args.providerBoundaryCheck({ database: undefined });
      return { messageId: 'must-not-send' };
    });
    jest.clearAllMocks();
    const res = await bounceRecovery.attemptRecovery(original, hardBounce);
    expect(res).toEqual({ skipped: 'gate_off' });
    const [rec] = await recoveryRows(original.id);
    expect(rec.status).toBe('other_spelling_not_sent');
    const staged = await db('email_messages').where({ id: rec.recovery_message_id }).first();
    expect(staged).toMatchObject({ status: 'blocked', error_message: 'gate_off' });
    expect(staged.provider_message_id).toBeNull();
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'skipped', reason: 'gate_off' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
  });

  test('tracked path: the claim is bound to the staged recovery message, and a delivery of a message it is not bound to commits nothing', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const original = await seedBouncedMessage(customerId);
    await bounceRecovery.attemptRecovery(original, hardBounce);
    const [rec] = await recoveryRows(original.id);
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: rec.recovery_message_id });

    await trackedClaim(customerId).update({ retry_send_id: randomUUID() }); // the claim belongs to some other send
    const recoveryMessage = await db('email_messages').where({ id: rec.recovery_message_id }).first();
    await bounceRecovery.commitRecoveryOnDelivery(recoveryMessage);
    expect((await db('customers').where({ id: customerId }).first()).email).toBe(BOUNCED);
    expect((await recoveryRows(original.id))[0]).toMatchObject({ status: 'delivered', record_updated: false });
    expect((await trackedClaim(customerId))[0].status).toBe('resending');
  });

  // ── A provider failure of the BOUND retry send (not a bounce) settles the claim failed / send_failed ───────────────────
  test('automation: the bound retry send fails at the provider: the claim fails through the send id, the enrollment is left as any failed send, nobody is told', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    jest.clearAllMocks();
    sendgrid.sendOne.mockRejectedValueOnce(new Error('provider down'));

    const res = await runner.sendStep(ctx.enrollment.id);

    expect(res).toMatchObject({ sent: false, error: 'provider down' });
    const failedSend = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    expect(failedSend).toMatchObject({ status: 'failed' });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'send_failed', retry_send_id: failedSend.id });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'failed' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    // A late delivery event for that send settles nothing: the claim is no longer resending.
    await db('automation_step_sends').where({ id: failedSend.id }).update({ sendgrid_message_id: 'failed-send-1' });
    await delivered('failed-send-1');
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
  });

  test('automation: a provider failure of a send that is NOT the bound retry send leaves the claim alone', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    sendgrid.sendOne.mockRejectedValueOnce(new Error('provider down'));
    await runner.sendStep(sibling.enrollment.id); // the sibling's own first step, never bound
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: null });
  });

  test('tracked: the staged recovery message fails at the provider after the bind: the claim fails through the message id', async () => {
    const customerId = await seedCustomer(BOUNCED);
    await seedCall(customerId);
    const original = await seedBouncedMessage(customerId);
    sendgrid.sendOne.mockRejectedValueOnce(new Error('provider down'));
    const res = await bounceRecovery.attemptRecovery(original, hardBounce);
    expect(res).toMatchObject({ error: expect.any(String) });
    const [rec] = await recoveryRows(original.id);
    expect(rec.status).toBe('send_failed');
    expect((await trackedClaim(customerId))[0]).toMatchObject({ status: 'failed', reason: 'send_failed', retry_send_id: rec.recovery_message_id });
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
  });

  // ── A rejected correction never leaves an enrollment mailing the retry address (P1-E, pre-push audit) ───────────────────
  const noProvenance = async (id) => expect((await enrollmentRow(id)).metadata.spelling_retry_email).toBeUndefined();

  test('email changed by hand before the queued retry step: enrollments are retargeted to the new email, provenance cleared, nothing goes to the retry address', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await db('customers').where({ id: ctx.customerId }).update({ email: 'jonny.doe@example.com' });

    const first = await runner.sendStep(ctx.enrollment.id);

    expect(first).toMatchObject({ sent: false, deferred: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'email_changed' });
    for (const id of [ctx.enrollment.id, sibling.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'active', email: 'jonny.doe@example.com' });
      await noProvenance(id);
    }
    // The bounced step is still due: the next tick sends it to the hand-set email.
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'jonny.doe@example.com', subject: 'Step 1' }));
  });

  test('email changed by hand between the retry send and its delivery: the commit is rejected and the sibling follows the new email', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'changed-1');
    await db('customers').where({ id: ctx.customerId }).update({ email: 'jonny.doe@example.com' });

    await delivered('changed-1');

    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe('jonny.doe@example.com');
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'email_changed' });
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'active', email: 'jonny.doe@example.com' });
    await noProvenance(sibling.enrollment.id);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ email: 'jonny.doe@example.com' });
  });

  test('owned by another customer at the commit: the commit is rejected and every provenance enrollment is cancelled like a hard bounce', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'owned-1');
    await seedCustomer(OTHER); // someone else claimed the address after the send

    await delivered('owned-1');

    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'owned_by_other' });
    for (const id of [sibling.enrollment.id, ctx.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'cancelled' });
      expect(await cancelReason(id)).toBe('hard_bounce');
      await noProvenance(id);
    }
  });

  test.each([
    ['owned_by_other', async () => { await seedCustomer(OTHER); }],
    ['suppressed', async () => { await db('email_suppressions').insert({ email: OTHER, status: 'active', suppression_type: 'bounce', source: 'test', suppressed_at: new Date() }); }],
  ])('%s found right before the queued retry send: nothing is sent, the claim is skipped, every provenance enrollment is cancelled', async (reason, makeProblem) => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await makeProblem();

    await runner.sendStep(ctx.enrollment.id);

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason });
    for (const id of [ctx.enrollment.id, sibling.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'cancelled' });
      expect(await cancelReason(id)).toBe('hard_bounce');
      await noProvenance(id);
    }
  });

  test.each(['skipped', 'failed', 'committed'])('a %s claim never lets a provenance-marked send through', async (status) => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await ledger(ctx.customerId).update({ status }); // settled behind the enrollment's back
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
    await noProvenance(ctx.enrollment.id);
  });

  test('the other spelling bounces too: a sibling still pointed at it is cancelled and loses its provenance', async () => {
    ctx = await setup({ sent: 1 });
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'retry-bounced-2');
    await webhook.handleEvent(bounce({ sendgrid_message_id: 'retry-bounced-2' }, OTHER));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'cancelled' });
    await noProvenance(sibling.enrollment.id);
  });
});
