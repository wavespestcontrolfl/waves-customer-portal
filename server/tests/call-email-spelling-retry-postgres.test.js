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
const cryptoLib = require('crypto');
const express = require('express');

// The route verifies a signed body: a throwaway key pair for the HTTP-level tests below.
const sgKeys = cryptoLib.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = sgKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  // The real classifier: which HTTP statuses are a definite rejection (round 14).
  isDefiniteRejection: jest.requireActual('../services/sendgrid-mail').isDefiniteRejection,
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
  const created = { customers: [], templates: [], leads: [] };

  // The retry drip is the template KEY `new_lead` (RETRY_TEMPLATE_KEYS), a newsletter-group template. The seeded template keeps its row;
  // its steps are swapped for two synthetic ones for the run and restored afterwards (every test uses its own customer).
  let seededNewLeadSteps = [];
  async function installNewLeadFixture() {
    seededNewLeadSteps = await db('automation_steps').where({ template_key: 'new_lead' });
    await db('automation_steps').where({ template_key: 'new_lead' }).del();
    for (const order of [1, 2]) {
      await db('automation_steps').insert({
        template_key: 'new_lead', step_order: order, delay_hours: 0, subject: `Step ${order}`, html_body: `<p>Hello {{first_name}} ${order}</p>`, text_body: `Hello ${order}`,
      });
    }
  }
  async function restoreNewLeadFixture() {
    await db('automation_enrollments').where({ template_key: 'new_lead' }).del();
    await db('automation_steps').where({ template_key: 'new_lead' }).del();
    if (seededNewLeadSteps.length) await db('automation_steps').insert(seededNewLeadSteps);
  }

  beforeAll(async () => {
    db = require('../models/db');
    webhook = require('../routes/webhooks-sendgrid');
    runner = require('../services/automation-runner');
    sendgrid = require('../services/sendgrid-mail');
    bounceRecovery = require('../services/email-bounce-recovery');
    bounceRescue = require('../services/email-bounce-rescue');
    reverify = require('../services/email-bounce-reverify');
    NotificationService = require('../services/notification-service');
    await installNewLeadFixture();
  });

  async function cleanup() {
    for (const id of created.customers) {
      await db('call_email_spelling_retries').where({ customer_id: id }).del();
      await db('email_messages').where({ recipient_id: id }).del(); // cascades the bounce-recovery ledger
      await db('audit_log').where({ resource_id: id }).del();
      await db('call_log').where({ customer_id: id }).del();
      await db('estimates').where({ customer_id: id }).del();
      await db('notification_prefs').where({ customer_id: id }).del();
      await db('automation_enrollments').where({ customer_id: id }).del();
      await db('customers').where({ id }).del();
    }
    for (const key of created.templates) await db('automation_templates').where({ key }).del();
    for (const id of created.leads) await db('leads').where({ id }).del();
    created.leads = [];
    created.customers = [];
    created.templates = [];
    await db('email_suppressions').whereIn('email', [BOUNCED, OTHER, 'jon.doe@gmail.com', 'jondoe@gmail.com']).del();
    await db('sendgrid_webhook_events').where('event_id', 'like', 'ev-%').del();
  }

  afterEach(async () => {
    require('../services/call-email-spelling-retry').RETRY_TEMPLATE_KEYS.forEach((k) => { if (k !== 'new_lead') require('../services/call-email-spelling-retry').RETRY_TEMPLATE_KEYS.delete(k); });
    await cleanup();
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    else process.env.GATE_CALL_BOUNCE_OTHER_SPELLING = priorGate;
    await cleanup();
    await restoreNewLeadFixture();
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
  async function seedEnrollment({ asm = 'service', sent = 1, status = 'active', email = BOUNCED, role = null, customerId, templateKey = null, primary = false } = {}) {
    // primary: the retry drip itself (template key `new_lead`, the fixture's two steps). templateKey: reuse another seeded template
    // (its single enabled step) so its own pre-send checks (estimate accepted, termite bond) apply. Neither: a synthetic other
    // template (a sibling drip of the same customer).
    const key = templateKey || (primary ? 'new_lead' : `retry_${randomUUID().slice(0, 8)}`);
    const reuse = !!(templateKey || primary);
    const steps = [];
    if (reuse) steps.push(...await db('automation_steps').where({ template_key: key, enabled: true }).orderBy('step_order'));
    else await db('automation_templates').insert({ key, name: 'Synthetic lead welcome', asm_group: asm, enabled: true, trigger_type: 'manual' });
    if (!reuse) created.templates.push(key);
    for (const order of reuse ? [] : [1, 2]) {
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

  // A stray enrollment of the same customer that carries retry provenance (the way the old sibling-follow left one). The webhook now
  // ends every other enrollment at the bounced address instead, so these are built AFTER the bounce on purpose: they exercise the
  // release, binding and verdict machinery (and the allowlist, which a stray of another template must pass to be tested at all).
  async function followingSibling() {
    const seeded = await seedEnrollment({ customerId: ctx.customerId, sent: 0, email: OTHER });
    require('../services/call-email-spelling-retry').RETRY_TEMPLATE_KEYS.add(seeded.key);
    await db('automation_enrollments').where({ id: seeded.enrollment.id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ spelling_retry_email: OTHER })]),
    });
    return seeded;
  }

  async function setup(opts = {}) {
    const customerId = await seedCustomer(opts.customerEmail || BOUNCED);
    const callId = opts.call === false ? null : await seedCall(opts.callCustomerId || customerId, opts.call || {});
    const seeded = await seedEnrollment({ ...opts, customerId, primary: !opts.templateKey && opts.primary !== false });
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
    // new_lead is a newsletter-group template: today's path never runs the contact-rewriting rescue for it.
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
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

  test('any OTHER active enrollment to the bounced address is ended as a hard bounce would end it (a service drip is never repointed)', async () => {
    ctx = await setup({ sent: 1 });
    const second = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    const strangers = await seedCustomer(BOUNCED);
    const third = await seedEnrollment({ customerId: strangers, sent: 0 });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    for (const other of [second, third]) {
      expect(await enrollmentRow(other.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
      expect((await enrollmentRow(other.enrollment.id)).metadata.cancel_reason).toBe('hard_bounce');
      expect((await enrollmentRow(other.enrollment.id)).metadata.spelling_retry_email).toBeUndefined();
    }
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
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
    ['the template is not the allowlisted drip (a service-group treatment / renewal template)', { primary: false, asm: 'service' }],
    ['the template is not the allowlisted drip (another newsletter-group template)', { primary: false, asm: 'newsletter' }],
    ['the new_lead enrollment is older than the call', { olderEnrollment: true }],
    ['the new_lead enrollment\'s lead belongs to another call', { leadOtherCall: true }],
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
    if (opts.olderEnrollment) {
      await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ enrolled_at: new Date(Date.now() - 2 * 86400 * 1000) });
    }
    if (opts.leadOtherCall) {
      const [lead] = await db('leads').insert({ twilio_call_sid: `CA-other-${randomUUID().slice(0, 8)}` }).returning('id');
      created.leads.push(lead.id);
      await db('call_log').where({ id: ctx.callId }).update({ twilio_call_sid: `CA-this-${randomUUID().slice(0, 8)}` });
      await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ lead_id: lead.id })]),
      });
    }
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email });
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    // The rescue runs only for a service-group template; new_lead and every marketing-stream template never rescue (as before).
    expect(bounceRescue.rescueBouncedAddress).toHaveBeenCalledTimes(opts.primary === false && (opts.asm || 'service') === 'service' ? 1 : 0);
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    sendgrid.sendOne.mockRejectedValueOnce(new Error('provider down'));
    await runner.sendStep(sibling.enrollment.id); // the sibling's own first step, never bound
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: null });
  });

  // ── A rejected correction never leaves an enrollment mailing the retry address (P1-E, pre-push audit) ───────────────────
  const noProvenance = async (id) => expect((await enrollmentRow(id)).metadata.spelling_retry_email).toBeUndefined();

  test('email changed by hand before the queued retry step: enrollments are retargeted to the new email, provenance cleared, nothing goes to the retry address', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
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
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'retry-bounced-2');
    await webhook.handleEvent(bounce({ sendgrid_message_id: 'retry-bounced-2' }, OTHER));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'cancelled' });
    await noProvenance(sibling.enrollment.id);
  });

  // ── A failed bind never dispatches (P1-F) ─────────────────────────────────────────────────────────────────────────────
  test('the process stopped after the bind committed and before the dispatch: the next tick sends nothing unbound, the claim and enrollments end cleanly', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    // Simulate the dead process: the first retry send row exists, bound to the claim, queued, never dispatched.
    const [orphan] = await db('automation_step_sends').insert({
      enrollment_id: ctx.enrollment.id, step_id: ctx.last.id, step_order: 1, email: OTHER, status: 'queued',
    }).returning('*');
    await ledger(ctx.customerId).update({ retry_send_id: orphan.id });

    await runner.sendStep(ctx.enrollment.id);

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'not_bound' });
    for (const id of [ctx.enrollment.id, sibling.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'cancelled' });
      expect(await cancelReason(id)).toBe('hard_bounce');
      await noProvenance(id);
    }
    expect(await db('automation_step_sends').where({ id: orphan.id }).first()).toMatchObject({ status: 'blocked' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
  });

  test('a step deferred before dispatch (its queued row deleted) re-binds on the next tick and still settles', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    const [gone] = await db('automation_step_sends').insert({
      enrollment_id: ctx.enrollment.id, step_id: ctx.last.id, step_order: 1, email: OTHER, status: 'queued',
    }).returning('*');
    await ledger(ctx.customerId).update({ retry_send_id: gone.id });
    await db('automation_step_sends').where({ id: gone.id }).del(); // what a held step does: nothing was sent

    await runner.sendStep(ctx.enrollment.id);

    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const sent = await retrySendOf(ctx.enrollment.id, 'rebound-1');
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: sent.id });
    await delivered('rebound-1');
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
  });

  // ── The retry owns its outcomes: through handleEvent, no fallback may act behind it (P1-H) ─────────────────────────────
  const settleTicks = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));
  const sleepMs = settleTicks;
  test('outcome table, automation: a dead-domain "blocked" event on the BOUND retry send fails the claim, releases the enrollments, one alert, no card, no rescue', async () => {
    process.env.GATE_CALL_EMAIL_CHECKS = 'true';
    try {
      ctx = await setup({ sent: 1 });
      await webhook.handleEvent(bounce(ctx.send));
      const sibling = await followingSibling();
      await runner.sendStep(ctx.enrollment.id);
      await retrySendOf(ctx.enrollment.id, 'dead-domain-1');
      jest.clearAllMocks();
      await webhook.handleEvent({ event: 'blocked', email: OTHER, reason: 'unable to get mx info: no such domain', sg_event_id: `ev-${randomUUID()}`, sg_message_id: 'dead-domain-1.f' });
      await sleepMs();
      expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_no_mail_server' });
      expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'cancelled' });
      expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
      expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledWith(BOUNCED, expect.anything());
      expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
      expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_CALL_EMAIL_CHECKS;
    }
  });

  test('outcome table, automation: a dead-domain event on a send that is NOT the bound retry send keeps the alert and card (the claim is untouched)', async () => {
    process.env.GATE_CALL_EMAIL_CHECKS = 'true';
    try {
      ctx = await setup({ sent: 1 });
      await webhook.handleEvent(bounce(ctx.send));
      await runner.sendStep(ctx.enrollment.id);
      const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'dead-domain-2');
      jest.clearAllMocks();
      await webhook.handleEvent({ event: 'blocked', email: OTHER, reason: 'unable to get mx info: no such domain', sg_event_id: `ev-${randomUUID()}`, sg_message_id: `${stray.sendgrid_message_id}.f` });
      await sleepMs();
      expect((await ledger(ctx.customerId))[0].status).toBe('resending');
      expect(reverify.reverifyBouncedEmailFromCall).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.GATE_CALL_EMAIL_CHECKS;
    }
  });

  // ── Provenance never outlives its claim, in any enrollment status (P1-I) ─────────────────────────────────────────────────
  test('a final-step retry completes its enrollment before the delivery: the commit still clears the provenance, and a later re-enrollment sends normally', async () => {
    ctx = await setup({ sent: 2 }); // both steps sent: step 2 (the last) is the one that bounced
    await db('automation_step_sends').where({ id: ctx.send.id }).update({ step_id: ctx.steps[1].id, step_order: 2 });
    await webhook.handleEvent(bounce(ctx.send));
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
    await runner.sendStep(ctx.enrollment.id); // the retry of the final step completes the enrollment
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'completed' });
    await retrySendOf(ctx.enrollment.id, 'final-step-1');

    await delivered('final-step-1');

    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    const done = await enrollmentRow(ctx.enrollment.id);
    expect(done).toMatchObject({ status: 'completed', email: OTHER });
    expect(done.metadata.spelling_retry_email).toBeUndefined();

    // A later legitimate enrollment of the same template reuses the row and sends to the profile email.
    const template = await db('automation_templates').where({ key: ctx.key }).first();
    expect(template.enabled).toBe(true);
    const customer = await db('customers').where({ id: ctx.customerId }).first();
    const result = await runner.enrollCustomer({ templateKey: ctx.key, customer });
    expect(result.enrolled).toBe(true);
    jest.clearAllMocks();
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ next_send_at: new Date(Date.now() - 1000) });
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 1' }));
  });

  test('re-enrolling a terminal enrollment drops any retry provenance it carried (the new episode starts clean)', async () => {
    ctx = await setup({ sent: 2 });
    await db('call_email_spelling_retries').insert({ customer_id: ctx.customerId, bounced_email: BOUNCED, retry_email: OTHER, channel: 'automation', status: 'committed' });
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ spelling_retry_email: OTHER })]),
    });
    const customer = await db('customers').where({ id: ctx.customerId }).first();
    await runner.enrollCustomer({ templateKey: ctx.key, customer: { ...customer, email: OTHER } });
    const row = await enrollmentRow(ctx.enrollment.id);
    expect(row).toMatchObject({ status: 'active', email: OTHER });
    expect(row.metadata.spelling_retry_email).toBeUndefined();
  });

  test('a claim that does not commit clears the provenance from completed and failed enrollments too, and cancels only the active ones', async () => {
    ctx = await setup({ sent: 1 });
    const completed = await seedEnrollment({ customerId: ctx.customerId, sent: 2 });
    const failed = await seedEnrollment({ customerId: ctx.customerId, sent: 1, status: 'failed' });
    await webhook.handleEvent(bounce(ctx.send));
    const mark = (id) => db('automation_enrollments').where({ id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ spelling_retry_email: OTHER })]),
    });
    await mark(completed.enrollment.id);
    await mark(failed.enrollment.id);
    await seedCustomer(OTHER); // the live state really does say stop: someone else holds the address
    await require('../services/call-email-spelling-retry').stopRetry({ customerId: ctx.customerId, retryEmail: OTHER, reason: 'owned_by_other' });
    for (const id of [completed.enrollment.id, failed.enrollment.id, ctx.enrollment.id]) await noProvenance(id);
    expect(await enrollmentRow(completed.enrollment.id)).toMatchObject({ status: 'completed' });
    expect(await enrollmentRow(failed.enrollment.id)).toMatchObject({ status: 'failed' });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
  });

  test('the email fanout moving an enrollment off the retry address drops its provenance', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBe(OTHER);
    await db('customers').where({ id: ctx.customerId }).update({ email: OTHER });
    await require('../services/customer-email-fanout').propagateCustomerEmailChange({
      before: { id: ctx.customerId, email: OTHER }, after: { id: ctx.customerId, email: 'jonny.doe@example.com' }, source: 'test',
    });
    const row = await enrollmentRow(ctx.enrollment.id);
    expect(row.email).toBe('jonny.doe@example.com');
    expect(row.metadata.spelling_retry_email).toBeUndefined();
  });

  // ── Claim locked and re-checked in the transaction of its effect (P1-J) ──────────────────────────────────────────────────
  async function holdCustomerRow(customerId) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let locked;
    const lockedP = new Promise((resolve) => { locked = resolve; });
    const holder = db.transaction(async (trx) => {
      await trx('customers').where({ id: customerId }).forUpdate().first();
      locked();
      await held;
    });
    await lockedP;
    return { release, done: holder };
  }

  test('race, automation: a gate-off stop settling the claim while the delivery commit waits on the customer row cannot leave the email replaced and the claim skipped', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'race-1');
    const holder = await holdCustomerRow(ctx.customerId);

    const commit = delivered('race-1'); // locks the claim row, then waits for the customer row
    await sleepMs(500);
    const stop = require('../services/call-email-spelling-retry').stopRetry({ customerId: ctx.customerId, retryEmail: OTHER, reason: 'gate_off' });
    await sleepMs(400);
    holder.release();
    await Promise.all([holder.done, commit, stop]);

    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBeUndefined();
  });

  // ── A delivery racing the runner never cancels a recovered enrollment (P1-K) ─────────────────────────────────────────────
  test('race: the runner holds an enrollment with provenance, the delivery commits meanwhile: the next step goes to the recovered address, nothing is cancelled', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id); // the retry step goes to the other spelling; step 2 is next
    await retrySendOf(ctx.enrollment.id, 'k-1');
    await dueNow(ctx.enrollment.id);
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBe(OTHER);

    const prefs = require('../services/contact-notification-prefs');
    let entered;
    const enteredP = new Promise((resolve) => { entered = resolve; });
    let resume;
    const paused = new Promise((resolve) => { resume = resolve; });
    const spy = jest.spyOn(prefs, 'rerouteForContactEmailOptOut').mockImplementationOnce(async (_customerId, email) => {
      entered(); // the runner has READ the enrollment (provenance included) and holds the prep-send lock
      await paused;
      return { email, rerouted: false };
    });
    try {
      const runnerRun = runner.sendStep(ctx.enrollment.id);
      await enteredP;
      await delivered('k-1'); // the delivery commits the claim and clears the provenance behind the runner's back
      expect((await ledger(ctx.customerId))[0].status).toBe('committed');
      resume();
      await runnerRun;
    } finally {
      spy.mockRestore();
    }

    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 2' }));
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'completed', email: OTHER });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
  });

  test('a committed claim whose address IS the customer\'s current primary email never stops a send, even with a stale marker and the gate off', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'k-2');
    await delivered('k-2');
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ spelling_retry_email: OTHER })]), // a stale marker
    });
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenLastCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 2' }));
    expect(await enrollmentRow(ctx.enrollment.id)).not.toMatchObject({ status: 'cancelled' });
  });

  // ── A hard bounce for an address whose claim is still in flight is owned by that retry (P1-L) ──────────────────────────────
  test('through handleEvent: a second hard bounce for the same customer + address while the claim is resending raises no alert, no rescue, no card', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'inflight-1', BOUNCED); // a duplicate / sibling send to the bounced address
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
  });

  test.each(['failed', 'skipped', 'committed'])('through handleEvent: a hard bounce after the claim is %s is today\'s path (alert and rescue)', async (status) => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await ledger(ctx.customerId).update({ status });
    const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, `settled-${status}`, BOUNCED);
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled(); // new_lead is newsletter-group: no rescue, as before
  });

  // ── A terminal cancel of a provenance send settles its claim; a defer keeps it; a stale claim stops owning anything (P1-M) ──────
  test.each([
    ['estimate_accepted', 'estimate_sent', async (id) => { await db('estimates').insert({ customer_id: id, customer_email: BOUNCED, accepted_at: new Date(Date.now() + 5000) }); }],
    ['not_termite_bond', 'service_renewal', async () => {}],
  ])('a pre-send check cancels the retry (%s): the bound claim is skipped with that reason and the sibling is released', async (reason, templateKey, makeCause) => {
    // These pre-send checks belong to other templates: allowlist that one for this test so the terminal-cancel chokepoint is reached.
    require('../services/call-email-spelling-retry').RETRY_TEMPLATE_KEYS.add(templateKey);
    ctx = await setup({ sent: 1, templateKey });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    await makeCause(ctx.customerId);

    await runner.sendStep(ctx.enrollment.id);

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    const blocked = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).first();
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason, retry_send_id: blocked.id });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
    expect(await cancelReason(ctx.enrollment.id)).toBe(reason);
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'cancelled' });
    await noProvenance(sibling.enrollment.id);
    await noProvenance(ctx.enrollment.id);
    // The claim no longer owns the address: a later bounce of the original address is today's path.
    const stray = await strayAutomationSend(sibling.enrollment.id, sibling.steps[0].id, 'after-cancel-1', BOUNCED);
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
  });

  test('a genuinely deferred retry send (held at the provider boundary) keeps its claim resending and the enrollments live, then sends on the next tick', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    const prefs = require('../services/contact-notification-prefs');
    const spy = jest.spyOn(prefs, 'rerouteForContactEmailOptOut')
      .mockImplementationOnce(async (_c, email) => ({ email, rerouted: false })) // the early check
      .mockImplementationOnce(async () => ({ email: null, rerouted: true })); // the check at the provider boundary: held
    sendgrid.sendOne.mockImplementationOnce(async (args) => { await args.providerBoundaryCheck({ database: undefined }); return { messageId: 'must-not-send' }; });
    try {
      const held = await runner.sendStep(ctx.enrollment.id);
      expect(held).toMatchObject({ sent: false, deferred: true });
    } finally {
      spy.mockRestore();
    }
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1); // sendOne was entered and refused at its boundary check
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'active', email: OTHER });
    sendgrid.sendOne.mockClear();
    sendgrid.sendOne.mockImplementation(async () => ({ messageId: `retry-${randomUUID()}` }));
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const sent = await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER, status: 'sent' }).first();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending', retry_send_id: sent.id });
  });

  const ageClaim = (customerId, hours) => ledger(customerId).update({ created_at: new Date(Date.now() - hours * 3600 * 1000) });

  test('a stale claim (older than 72 h, still resending) no longer owns a bounce: today\'s path, and the claim fails as stale', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    await ageClaim(ctx.customerId, 80);
    const stray = await strayAutomationSend(sibling.enrollment.id, sibling.steps[0].id, 'stale-1', BOUNCED);
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'stale' });
    expect(await enrollmentRow(sibling.enrollment.id)).toMatchObject({ status: 'cancelled' });
    await noProvenance(ctx.enrollment.id);
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
    expect(bounceRescue.rescueBouncedAddress).toHaveBeenCalledTimes(1);
  });

  test('a fresh claim just inside the window still owns the bounce', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await ageClaim(ctx.customerId, 70);
    const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'fresh-1', BOUNCED);
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
  });

  test('a stale claim never lets a send through at the runner boundary', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await ageClaim(ctx.customerId, 80);
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'stale' });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
  });

  // ── An archived or merged-away customer is rejected at the commit (P1-N) ─────────────────────────────────────────────────
  test.each([
    ['archived', async (id) => { await db('customers').where({ id }).update({ deleted_at: new Date(), active: false }); }],
    ['merged away', async (id) => { // how customer-dedupe retires a merge loser
      await db('customers').where({ id }).update({ phone: `merged-${id.slice(0, 8)}`, email: null, active: false, deleted_at: new Date() });
    }],
  ])('delivery after the customer was %s: nothing is written, the claim is skipped as customer_gone, the enrollments are released', async (_label, retire) => {
    ctx = await setup({ sent: 1 });
    await db('estimates').insert({ customer_id: ctx.customerId, customer_email: BOUNCED });
    await webhook.handleEvent(bounce(ctx.send));
    const sibling = await followingSibling();
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'gone-1');
    await retire(ctx.customerId);
    const before = await db('customers').where({ id: ctx.customerId }).first();

    await delivered('gone-1');

    const after = await db('customers').where({ id: ctx.customerId }).first();
    expect(after.email).toBe(before.email); // not replaced by the retry address
    expect(after.email).not.toBe(OTHER);
    expect((await db('estimates').where({ customer_id: ctx.customerId }).first()).customer_email).toBe(BOUNCED); // no fanout
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'customer_gone' });
    expect(await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' })).toEqual([]);
    for (const id of [ctx.enrollment.id, sibling.enrollment.id]) {
      expect(await enrollmentRow(id)).toMatchObject({ status: 'cancelled' });
      await noProvenance(id);
    }
  });

  test('a customer archived before the queued retry step: the verdict stops the send and the claim is skipped', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await db('customers').where({ id: ctx.customerId }).update({ deleted_at: new Date(), active: false });
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0].status).toBe('skipped');
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled' });
  });

  test('an archived customer is never a retry candidate', async () => {
    ctx = await setup({ sent: 1 });
    await db('customers').where({ id: ctx.customerId }).update({ deleted_at: new Date(), active: false });
    jest.clearAllMocks();
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
  });

  // ── A failed delivery transaction asks SendGrid to redeliver (P1-O) ──────────────────────────────────────────────────────
  async function post(events) {
    const app = express();
    app.use('/api/webhooks/sendgrid', webhook);
    const server = app.listen(0, '127.0.0.1');
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      const body = JSON.stringify(events);
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = cryptoLib.sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), sgKeys.privateKey).toString('base64');
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/sendgrid/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': ts },
        body,
      });
      return res.status;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  // A REAL COMMIT failure: a deferred constraint trigger raises when the transaction commits, after every statement succeeded.
  async function failCommitWhen(table, whenSql) {
    await db.raw("CREATE OR REPLACE FUNCTION test_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected commit failure'; END $$");
    await db.raw(`CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (${whenSql}) EXECUTE FUNCTION test_fail_at_commit()`);
    return () => db.raw(`DROP TRIGGER IF EXISTS test_fail_at_commit ON ${table}`);
  }
  const deliveredEvent = (messageId, eventId) => ({ event: 'delivered', email: OTHER, sg_event_id: eventId, sg_message_id: `${messageId}.f` });
  const eventLedger = (eventId) => db('sendgrid_webhook_events').where({ event_id: eventId });

  async function boundRetryDelivery(messageId) {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, messageId);
  }
  async function expectNothingHalfWritten(eventId) {
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' })).toEqual([]);
    expect(await eventLedger(eventId)).toEqual([]); // the event ledger row went with the rollback
  }
  async function expectCommittedOnce(eventId) {
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    expect(await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' })).toHaveLength(1);
    expect(await eventLedger(eventId)).toHaveLength(1);
  }

  test('HTTP: a fanout failure while committing the delivered retry answers 500, writes nothing, and the redelivery commits exactly once', async () => {
    await boundRetryDelivery('http-1');
    const fanout = require('../services/customer-email-fanout');
    const spy = jest.spyOn(fanout, 'propagateCustomerEmailChange').mockRejectedValueOnce(new Error('fanout down'));
    try {
      expect(await post([deliveredEvent('http-1', 'ev-http-1')])).toBe(500);
    } finally {
      spy.mockRestore();
    }
    await expectNothingHalfWritten('ev-http-1');
    expect(await post([deliveredEvent('http-1', 'ev-http-1')])).toBe(200); // the redelivery
    await expectCommittedOnce('ev-http-1');
    expect(await post([deliveredEvent('http-1', 'ev-http-1')])).toBe(200); // a further delivery is a no-op
    await expectCommittedOnce('ev-http-1');
  });

  test('HTTP: an audit-insert failure answers 500 and the redelivery commits once', async () => {
    await boundRetryDelivery('http-2');
    const audit = require('../services/audit-log');
    const spy = jest.spyOn(audit, 'recordAuditEvent').mockRejectedValueOnce(new Error('audit down'));
    try {
      expect(await post([deliveredEvent('http-2', 'ev-http-2')])).toBe(500);
    } finally {
      spy.mockRestore();
    }
    await expectNothingHalfWritten('ev-http-2');
    expect(await post([deliveredEvent('http-2', 'ev-http-2')])).toBe(200);
    await expectCommittedOnce('ev-http-2');
  });

  test('HTTP: a COMMIT failure after the retry commit work answers 500, writes nothing, and the redelivery commits exactly once', async () => {
    await boundRetryDelivery('http-3');
    const undo = await failCommitWhen('call_email_spelling_retries', "NEW.status = 'committed'");
    try {
      expect(await post([deliveredEvent('http-3', 'ev-http-3')])).toBe(500);
    } finally {
      await undo();
    }
    await expectNothingHalfWritten('ev-http-3');
    expect(await post([deliveredEvent('http-3', 'ev-http-3')])).toBe(200);
    await expectCommittedOnce('ev-http-3');
  });

  test('HTTP, unchanged: a commit failure on a delivered event that touched no retry claim still answers 200 (today\'s contract)', async () => {
    ctx = await setup({ sent: 1 });
    const plain = await db('automation_step_sends').where({ id: ctx.send.id }).first();
    await db('automation_step_sends').where({ id: plain.id }).update({ sendgrid_message_id: 'http-4' });
    const undo = await failCommitWhen('automation_step_sends', "NEW.sendgrid_message_id = 'http-4' AND NEW.status = 'delivered'");
    try {
      expect(await post([{ event: 'delivered', email: BOUNCED, sg_event_id: 'ev-http-4', sg_message_id: 'http-4.f' }])).toBe(200);
    } finally {
      await undo();
    }
  });

  test('HTTP: a failure failing the claim of a bounced retry send is redelivered (bounce class) and nothing is half-written', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await runner.sendStep(ctx.enrollment.id);
    await retrySendOf(ctx.enrollment.id, 'http-5');
    const undo = await failCommitWhen('call_email_spelling_retries', "NEW.status = 'failed'");
    const event = { event: 'bounce', type: 'bounce', email: OTHER, reason: '550 5.1.1', sg_event_id: 'ev-http-5', sg_message_id: 'http-5.f' };
    try {
      expect(await post([event])).toBe(500);
    } finally {
      await undo();
    }
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(await eventLedger('ev-http-5')).toEqual([]);
    expect(await post([event])).toBe(200);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
  });

  test('a failure while STARTING a retry is swallowed in its savepoint: no claim is left behind and the bounce is handled as today', async () => {
    ctx = await setup({ sent: 1 });
    const spy = jest.spyOn(runner, 'rewindEnrollmentToStep').mockRejectedValueOnce(new Error('rewind down'));
    try {
      await webhook.handleEvent(bounce(ctx.send));
    } finally {
      spy.mockRestore();
    }
    await flush();
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
  });

  // ── Retry-critical is decided BEFORE the event's lookups and transaction (round 11 P1) ───────────────────────────────────
  async function failStatementWhen(table, event, whenSql) {
    await db.raw("CREATE OR REPLACE FUNCTION test_fail_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected statement failure'; END $$");
    await db.raw(`CREATE TRIGGER test_fail_statement BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${whenSql}) EXECUTE FUNCTION test_fail_statement()`);
    return () => db.raw(`DROP TRIGGER IF EXISTS test_fail_statement ON ${table}`);
  }
  async function renameTableAway(table) {
    await db.raw(`ALTER TABLE ${table} RENAME TO ${table}_away`);
    return () => db.raw(`ALTER TABLE ${table}_away RENAME TO ${table}`);
  }
  const injections = {
    'event-ledger insert': (messageId, eventId) => failStatementWhen('sendgrid_webhook_events', 'INSERT', `NEW.event_id = '${eventId}'`),
    'delivery update': (messageId) => failStatementWhen('automation_step_sends', 'UPDATE', `NEW.sendgrid_message_id = '${messageId}' AND NEW.status = 'delivered'`),
    'initial message lookup': () => renameTableAway('newsletter_send_deliveries'),
  };

  describe.each(Object.keys(injections))('failure before the retry hook: %s', (name) => {
    test('a delivery of the BOUND retry send answers 500, writes nothing, and the redelivery commits once', async () => {
      await boundRetryDelivery(`pre-${name.length}`);
      const eventId = `ev-pre-${name.length}`;
      const undo = await injections[name](`pre-${name.length}`, eventId);
      try {
        expect(await post([deliveredEvent(`pre-${name.length}`, eventId)])).toBe(500);
      } finally {
        await undo();
      }
      await expectNothingHalfWritten(eventId);
      expect(await post([deliveredEvent(`pre-${name.length}`, eventId)])).toBe(200);
      await expectCommittedOnce(eventId);
    });

    test('a delivery of an UNRELATED send (not bound to a pending claim) keeps the 200 contract', async () => {
      await boundRetryDelivery(`unrel-${name.length}`);
      const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, `stray-${name.length}`, OTHER);
      const eventId = `ev-stray-${name.length}`;
      const undo = await injections[name](stray.sendgrid_message_id, eventId);
      try {
        expect(await post([deliveredEvent(stray.sendgrid_message_id, eventId)])).toBe(200);
      } finally {
        await undo();
      }
      expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    });
  });

  test('the pre-check itself cannot be answered: the delivered event is treated as retry-critical (500) even for an unrelated send', async () => {
    await boundRetryDelivery('precheck-1');
    const stray = await strayAutomationSend(ctx.enrollment.id, ctx.last.id, 'precheck-stray', OTHER);
    const undo = await renameTableAway('call_email_spelling_retries');
    try {
      expect(await post([deliveredEvent(stray.sendgrid_message_id, 'ev-precheck-1')])).toBe(500);
    } finally {
      await undo();
    }
    expect(await post([deliveredEvent(stray.sendgrid_message_id, 'ev-precheck-1')])).toBe(200);
  });

  // ── A delivery that beats the runner's save of the message id (round 13 P1) ─────────────────────────────────────────────
  const SEND_ID_ARG = 'automation_step_send_id';
  const argEvent = (sendId, eventId, extra = {}) => ({
    event: 'delivered', email: OTHER, sg_event_id: eventId, sg_message_id: 'early-1.f', [SEND_ID_ARG]: sendId, ...extra,
  });
  // Re-queue the bounced step to the other spelling; the NEXT sendStep dispatches the bound retry send.
  async function queuedRetry() {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
  }
  // sendOne that runs `during(args)` (the webhook arriving) before it returns the message id.
  const sendOneDuring = (during, messageId = 'early-1') => sendgrid.sendOne.mockImplementationOnce(async (args) => {
    await args.providerBoundaryCheck?.({});
    await during(args);
    return { messageId };
  });
  const retryRow = () => db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, email: OTHER }).orderBy('created_at', 'desc').first();

  test('only the BOUND retry send carries its own row id as a custom arg; any other automation send is dispatched as before', async () => {
    await queuedRetry();
    await runner.sendStep(ctx.enrollment.id);
    const [args] = sendgrid.sendOne.mock.calls[0];
    expect(args.customArgs).toEqual({ [SEND_ID_ARG]: (await retryRow()).id });
    // A plain enrollment (no claim, no provenance): no custom args at all.
    jest.clearAllMocks();
    ctx = await setup({ sent: 1, call: false, customerEmail: 'jondoe-plain@example.com', email: 'jondoe-plain@example.com' });
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ next_send_at: new Date(Date.now() - 1000) });
    const plainResult = await runner.sendStep(ctx.enrollment.id);
    expect(plainResult).toMatchObject({ sent: true });
    expect(sendgrid.sendOne.mock.calls[0][0].customArgs).toBeUndefined();
  });

  test('a delivery processed BEFORE sendOne returns (message id not saved yet) commits the retry once, and the later save changes nothing', async () => {
    await queuedRetry();
    let status;
    sendOneDuring(async (args) => {
      status = await post([argEvent(args.customArgs[SEND_ID_ARG], 'ev-early-1')]);
    });
    await runner.sendStep(ctx.enrollment.id);
    expect(status).toBe(200);
    await expectCommittedOnce('ev-early-1');
    // The runner's save landed after the delivery: it saved the id and kept 'delivered' (never rewound to 'sent').
    expect(await retryRow()).toMatchObject({ sendgrid_message_id: 'early-1', status: 'delivered' });
    expect((await retryRow()).delivered_at).not.toBeNull();
    // Redelivery of the same event, and a second delivered event now found by the saved message id: no second commit.
    expect(await post([argEvent((await retryRow()).id, 'ev-early-1')])).toBe(200);
    expect(await post([deliveredEvent('early-1', 'ev-early-1b')])).toBe(200);
    expect(await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' })).toHaveLength(1);
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
  });

  test('that early delivery is retry-critical: a failing event transaction answers 500, writes nothing, and the redelivery commits once', async () => {
    await queuedRetry();
    const statuses = [];
    sendOneDuring(async (args) => {
      const id = args.customArgs[SEND_ID_ARG];
      const undo = await failStatementWhen('sendgrid_webhook_events', 'INSERT', "NEW.event_id = 'ev-early-2'");
      try {
        statuses.push(await post([argEvent(id, 'ev-early-2')]));
      } finally {
        await undo();
      }
      expect(await eventLedger('ev-early-2')).toEqual([]);
      expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
      statuses.push(await post([argEvent(id, 'ev-early-2')])); // SendGrid's redelivery
    });
    await runner.sendStep(ctx.enrollment.id);
    expect(statuses).toEqual([500, 200]);
    await expectCommittedOnce('ev-early-2');
  });

  test('an early BOUNCE of the retry send (message id not saved yet) fails the claim, and the later save does not rewrite the bounce', async () => {
    await queuedRetry();
    sendOneDuring(async (args) => {
      expect(await post([{
        event: 'bounce', type: 'bounce', email: OTHER, reason: '550 5.1.1', sg_event_id: 'ev-early-3', sg_message_id: 'early-1.f',
        [SEND_ID_ARG]: args.customArgs[SEND_ID_ARG],
      }])).toBe(200);
    });
    await runner.sendStep(ctx.enrollment.id);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect(await retryRow()).toMatchObject({ sendgrid_message_id: 'early-1', status: 'bounced' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
  });

  describe('a custom arg is never trusted past its recipient and claim binding', () => {
    // Each case sends the early event, then asserts the claim is untouched (the runner's own save and the event are both harmless).
    const early = (mutate) => async () => {
      await queuedRetry();
      let status;
      let sendId;
      sendOneDuring(async (args) => {
        sendId = args.customArgs[SEND_ID_ARG];
        status = await post([mutate({ sendId, stray: await strayAutomationSend(ctx.enrollment.id, ctx.last.id, null, OTHER) })]);
      });
      await runner.sendStep(ctx.enrollment.id);
      expect(status).toBe(200);
      expect((await ledger(ctx.customerId))[0].status).toBe('resending');
      expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
      expect(await db('audit_log').where({ resource_id: ctx.customerId, action: 'customer.email_replaced_after_bounce_retry' })).toEqual([]);
    };
    test('the event\'s recipient is not the send\'s recipient', early(({ sendId }) => argEvent(sendId, 'ev-forge-1', { email: BOUNCED })));
    test('a recipient that only differs from the claim\'s retry address', early(({ sendId }) => argEvent(sendId, 'ev-forge-2', { email: 'someoneelse@example.com' })));
    test('an event with no recipient', early(({ sendId }) => argEvent(sendId, 'ev-forge-3', { email: undefined })));
    test('a custom arg that is not a uuid', early(() => argEvent('not-a-uuid', 'ev-forge-4')));
    test('a custom arg naming a send no claim is bound to', early(({ stray }) => argEvent(stray.id, 'ev-forge-5')));
    test('a custom arg naming a row that does not exist', early(() => argEvent(randomUUID(), 'ev-forge-6')));
  });

  test('a custom arg naming a send already bound to a DIFFERENT message id is not trusted', async () => {
    await boundRetryDelivery('bound-other-1');
    const send = await retryRow();
    expect(await post([argEvent(send.id, 'ev-forge-7', { sg_message_id: 'someone-elses.f' })])).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(await retryRow()).toMatchObject({ sendgrid_message_id: 'bound-other-1' });
  });

  test('the pre-check does not mark a forged / mismatched custom arg retry-critical (today\'s 200 survives a failing event write)', async () => {
    await queuedRetry();
    let status;
    sendOneDuring(async (args) => {
      const undo = await failStatementWhen('sendgrid_webhook_events', 'INSERT', "NEW.event_id = 'ev-forge-8'");
      try {
        status = await post([argEvent(args.customArgs[SEND_ID_ARG], 'ev-forge-8', { email: BOUNCED })]);
      } finally {
        await undo();
      }
    });
    await runner.sendStep(ctx.enrollment.id);
    expect(status).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
  });

  test('gate off: a custom arg settles nothing', async () => {
    await queuedRetry();
    let status;
    sendOneDuring(async (args) => {
      delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
      status = await post([argEvent(args.customArgs[SEND_ID_ARG], 'ev-gateoff-arg')]);
    });
    await runner.sendStep(ctx.enrollment.id);
    expect(status).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('resending');
    expect(await eventLedger('ev-gateoff-arg')).toEqual([]);
  });

  // ── Ambiguous outcomes of the bound retry send stay settleable by the delivery webhook (round 14 P1) ────────────────────────
  // The request left (the provider boundary passed) and then failed: SendGrid may hold the message.
  const afterRequestLeft = (err) => sendgrid.sendOne.mockImplementationOnce(async (args) => {
    await args.providerBoundaryCheck?.({});
    throw err;
  });
  const httpError = (status) => Object.assign(new Error(`SendGrid ${status}: x`), { status });
  const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const retrySteps = () => sendgrid.sendOne.mock.calls.filter(([a]) => a.to === OTHER && a.subject === 'Step 1');
  const expectClaimOpen = async () => {
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending' });
    expect((await enrollmentRow(ctx.enrollment.id)).status).not.toBe('cancelled');
    expect((await enrollmentRow(ctx.enrollment.id)).status).not.toBe('failed');
  };

  test.each([
    ['a lost response (timeout after the request left)', timeoutError],
    ['a 5xx answer', () => httpError(503)],
    ['a 408 answer', () => httpError(408)],
    ['a network error', () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
  ])('ambiguous: %s keeps the claim open, cancels nothing, sends nothing again; the signed delivery then commits once', async (name, makeErr) => {
    await queuedRetry();
    afterRequestLeft(makeErr());
    const res = await runner.sendStep(ctx.enrollment.id);
    expect(res).not.toMatchObject({ error: expect.anything() });
    await expectClaimOpen();
    const row = await retryRow();
    expect(row).toMatchObject({ status: 'sent', sendgrid_message_id: null });
    expect((await ledger(ctx.customerId))[0].retry_send_id).toBe(row.id);
    // The enrollment moved past the step: the next tick does not repeat it.
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ next_send_at: new Date(Date.now() - 1000) });
    await runner.sendStep(ctx.enrollment.id);
    expect(retrySteps()).toHaveLength(1);
    // SendGrid did accept it after all: the delivery names the send by its custom arg only.
    expect(await post([argEvent(row.id, 'ev-amb-1', { sg_message_id: 'amb-1.f' })])).toBe(200);
    await expectCommittedOnce('ev-amb-1');
    expect(await db('automation_step_sends').where({ id: row.id }).first()).toMatchObject({ sendgrid_message_id: 'amb-1', status: 'delivered' });
    expect(retrySteps()).toHaveLength(1);
  });

  test('ambiguous, then the BOUNCE of the retry address arrives: the claim fails through the custom arg, no card', async () => {
    await queuedRetry();
    afterRequestLeft(timeoutError());
    await runner.sendStep(ctx.enrollment.id);
    const row = await retryRow();
    expect(await post([{
      event: 'bounce', type: 'bounce', email: OTHER, reason: '550 5.1.1', sg_event_id: 'ev-amb-2', sg_message_id: 'amb-2.f', [SEND_ID_ARG]: row.id,
    }])).toBe(200);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(BOUNCED);
  });

  test.each([['400', 400], ['401', 401], ['403', 403], ['404', 404], ['413', 413], ['422', 422], ['429', 429]])(
    'definite rejection (%s) after the request left: the claim fails as before (send_failed) and the enrollment stops',
    async (name, status) => {
      await queuedRetry();
      afterRequestLeft(httpError(status));
      const res = await runner.sendStep(ctx.enrollment.id);
      expect(res).toMatchObject({ sent: false });
      expect(await retryRow()).toMatchObject({ status: 'failed' });
      expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'send_failed' });
      expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'failed' });
    },
  );

  test('a request that never left (a provider boundary failure) is a definite non-send: the claim fails as before', async () => {
    await queuedRetry();
    sendgrid.sendOne.mockImplementationOnce(async () => { throw new Error('boundary lookup down'); }); // never reached the boundary
    expect(await runner.sendStep(ctx.enrollment.id)).toMatchObject({ sent: false });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'send_failed' });
  });

  test('post-acceptance DB failure at the message-id save: the claim stays open, the row is marked sent, nothing is sent again; the delivery commits once', async () => {
    await queuedRetry();
    sendgrid.sendOne.mockImplementationOnce(async (args) => {
      await args.providerBoundaryCheck?.({});
      return { messageId: 'acc-1' };
    });
    const undo = await failStatementWhen('automation_step_sends', 'UPDATE', "NEW.sendgrid_message_id = 'acc-1' AND NEW.status = 'sent'");
    let res;
    try {
      res = await runner.sendStep(ctx.enrollment.id);
    } finally {
      await undo();
    }
    expect(res).not.toMatchObject({ error: expect.anything() });
    await expectClaimOpen();
    const row = await retryRow();
    expect(row).toMatchObject({ status: 'sent', sendgrid_message_id: null });
    expect(retrySteps()).toHaveLength(1);
    expect(await post([argEvent(row.id, 'ev-acc-1', { sg_message_id: 'acc-1.f' })])).toBe(200);
    await expectCommittedOnce('ev-acc-1');
    expect(await db('automation_step_sends').where({ id: row.id }).first()).toMatchObject({ sendgrid_message_id: 'acc-1', status: 'delivered' });
    expect(retrySteps()).toHaveLength(1);
  });

  test('post-acceptance DB failure that also stops the row and the enrollment writes: the next tick only moves the cursor, never sends again', async () => {
    await queuedRetry();
    sendgrid.sendOne.mockImplementationOnce(async (args) => {
      await args.providerBoundaryCheck?.({});
      return { messageId: 'acc-2' };
    });
    const undoRow = await failStatementWhen('automation_step_sends', 'UPDATE', "NEW.status = 'sent'");
    await db.raw("CREATE OR REPLACE FUNCTION test_fail_enroll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enrollment failure'; END $$");
    await db.raw(`CREATE TRIGGER test_fail_enroll BEFORE UPDATE ON automation_enrollments FOR EACH ROW WHEN (OLD.id = '${ctx.enrollment.id}' AND NEW.current_step <> OLD.current_step) EXECUTE FUNCTION test_fail_enroll()`);
    try {
      await runner.sendStep(ctx.enrollment.id);
    } finally {
      await undoRow();
      await db.raw('DROP TRIGGER IF EXISTS test_fail_enroll ON automation_enrollments');
    }
    const row = await retryRow();
    expect(row.status).toBe('dispatching'); // handed off, outcome unrecorded
    await expectClaimOpen();
    const cursorBefore = (await enrollmentRow(ctx.enrollment.id)).current_step;
    await runner.sendStep(ctx.enrollment.id); // the next tick
    expect(retrySteps()).toHaveLength(1); // the retry step was NOT dispatched again
    expect((await enrollmentRow(ctx.enrollment.id)).current_step).toBeGreaterThan(cursorBefore);
    await expectClaimOpen();
    expect(await post([argEvent(row.id, 'ev-acc-2', { sg_message_id: 'acc-2.f' })])).toBe(200);
    await expectCommittedOnce('ev-acc-2');
  });

  // ── The episode marker outlives settlement: a crash between the send and the cursor advance (round 15 P1) ───────────────
  const STEP_MARKER = 'spelling_retry_step';
  const marker = async () => (await enrollmentRow(ctx.enrollment.id)).metadata[STEP_MARKER];
  // A runner "crash" after the provider took the request: the row and the cursor writes all fail, so the row stays `dispatching`.
  async function crashAfterAcceptance(messageId) {
    sendgrid.sendOne.mockImplementationOnce(async (args) => {
      await args.providerBoundaryCheck?.({});
      return { messageId };
    });
    const undoRow = await failStatementWhen('automation_step_sends', 'UPDATE', "NEW.status = 'sent'");
    await db.raw("CREATE OR REPLACE FUNCTION test_fail_enroll() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected enrollment failure'; END $$");
    await db.raw(`CREATE TRIGGER test_fail_enroll BEFORE UPDATE ON automation_enrollments FOR EACH ROW WHEN (OLD.id = '${ctx.enrollment.id}' AND NEW.current_step <> OLD.current_step) EXECUTE FUNCTION test_fail_enroll()`);
    try {
      await runner.sendStep(ctx.enrollment.id);
    } finally {
      await undoRow();
      await db.raw('DROP TRIGGER IF EXISTS test_fail_enroll ON automation_enrollments');
    }
    const row = await retryRow();
    expect(row.status).toBe('dispatching');
    return row;
  }

  test('the rewind writes the episode marker { step_id, origin_send_id } beside the provenance', async () => {
    await queuedRetry();
    expect(await marker()).toEqual({ step_id: String(ctx.last.id), origin_send_id: String(ctx.send.id) });
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBe(OTHER);
  });

  test('normal flow: the marker survives the send and settlement, and is cleared only when the cursor advances past its step', async () => {
    await queuedRetry();
    await runner.sendStep(ctx.enrollment.id); // dispatched, saved, cursor advanced in one go
    expect(await marker()).toBeUndefined();
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBe(OTHER); // provenance lives until the claim settles
    const row = await retryRow();
    expect(await post([argEvent(row.id, 'ev-ep-1', { sg_message_id: `${row.sendgrid_message_id}.f` })])).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
  });

  test('a delivery commit alone never clears the marker', async () => {
    await queuedRetry();
    await crashAfterAcceptance('ep-2');
    const row = await retryRow();
    expect(await post([argEvent(row.id, 'ev-ep-2', { sg_message_id: 'ep-2.f' })])).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    expect((await enrollmentRow(ctx.enrollment.id)).metadata.spelling_retry_email).toBeUndefined(); // provenance cleared
    expect(await marker()).toEqual({ step_id: String(ctx.last.id), origin_send_id: String(ctx.send.id) }); // the episode marker is not
  });

  test('crash after acceptance, then the delivery commits the claim and clears the provenance: the next tick advances only, sendOne ran once', async () => {
    await queuedRetry();
    const row = await crashAfterAcceptance('ep-3');
    const before = (await enrollmentRow(ctx.enrollment.id)).current_step;
    expect(await post([argEvent(row.id, 'ev-ep-3', { sg_message_id: 'ep-3.f' })])).toBe(200);
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
    expect(await db('automation_step_sends').where({ id: row.id }).first()).toMatchObject({ status: 'delivered' });
    await dueNow(ctx.enrollment.id);
    await runner.sendStep(ctx.enrollment.id); // the next tick
    expect(retrySteps()).toHaveLength(1);
    expect((await enrollmentRow(ctx.enrollment.id)).current_step).toBeGreaterThan(before);
    expect(await marker()).toBeUndefined(); // cleared by the advance
    expect(await db('automation_step_sends').where({ enrollment_id: ctx.enrollment.id, step_id: ctx.last.id, email: OTHER })).toHaveLength(1);
  });

  test('crash after acceptance, then the retry address BOUNCES (claim failed): nothing is sent again', async () => {
    await queuedRetry();
    const row = await crashAfterAcceptance('ep-4');
    expect(await post([{
      event: 'bounce', type: 'bounce', email: OTHER, reason: '550 5.1.1', sg_event_id: 'ev-ep-4', sg_message_id: 'ep-4.f', [SEND_ID_ARG]: row.id,
    }])).toBe(200);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'retry_address_bounced' });
    expect((await enrollmentRow(ctx.enrollment.id)).status).toBe('cancelled');
    await dueNow(ctx.enrollment.id);
    await runner.sendStep(ctx.enrollment.id).catch(() => null); // a cancelled enrollment is refused
    expect(retrySteps()).toHaveLength(1);
  });

  test('crash after acceptance, then a hand edit of the email and the delivery (claim skipped, enrollment retargeted and still active): the next tick advances only', async () => {
    await queuedRetry();
    const row = await crashAfterAcceptance('ep-5');
    await db('customers').where({ id: ctx.customerId }).update({ email: 'jonny.doe@example.com' });
    expect(await post([argEvent(row.id, 'ev-ep-5', { sg_message_id: 'ep-5.f' })])).toBe(200);
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'email_changed' });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'active', email: 'jonny.doe@example.com' });
    const before = (await enrollmentRow(ctx.enrollment.id)).current_step;
    await dueNow(ctx.enrollment.id);
    await runner.sendStep(ctx.enrollment.id);
    expect(retrySteps()).toHaveLength(1);
    expect(sendgrid.sendOne.mock.calls.filter(([a]) => a.to === 'jonny.doe@example.com' && a.subject === 'Step 1')).toHaveLength(0);
    expect((await enrollmentRow(ctx.enrollment.id)).current_step).toBeGreaterThan(before);
    expect(await marker()).toBeUndefined();
  });

  test('the marker alone sends nothing without a handed-off send of the episode: a never-dispatched step still goes out', async () => {
    await queuedRetry();
    expect(await marker()).toBeDefined();
    await runner.sendStep(ctx.enrollment.id);
    expect(retrySteps()).toHaveLength(1);
  });

  test('a definitely rejected send of the episode is NOT handed off: the marker does not hide a step that never went out', async () => {
    await queuedRetry();
    afterRequestLeft(httpError(400));
    await runner.sendStep(ctx.enrollment.id);
    const svc = require('../services/call-email-spelling-retry');
    expect(await svc.handedOffRetrySend({ enrollment: await enrollmentRow(ctx.enrollment.id), step: ctx.last })).toBeNull();
  });

  test('the originating send of an earlier episode never counts as the episode\'s hand-off', async () => {
    await queuedRetry();
    const svc = require('../services/call-email-spelling-retry');
    // ctx.send is the original (delivered-looking) first email of this very step, created before the rewind.
    await db('automation_step_sends').where({ id: ctx.send.id }).update({ status: 'delivered' });
    expect(await svc.handedOffRetrySend({ enrollment: await enrollmentRow(ctx.enrollment.id), step: ctx.last })).toBeNull();
  });

  test('re-enrolling a terminal enrollment drops the episode marker with the provenance', async () => {
    await queuedRetry();
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ status: 'cancelled' });
    const customer = await db('customers').where({ id: ctx.customerId }).first();
    await runner.enrollCustomer({ templateKey: ctx.key, customer: { ...customer, email: OTHER } });
    const row = await enrollmentRow(ctx.enrollment.id);
    expect(row).toMatchObject({ status: 'active' });
    expect(row.metadata[STEP_MARKER]).toBeUndefined();
    expect(row.metadata.spelling_retry_email).toBeUndefined();
  });

  // ── Exact template allowlist + the call's episode (security review P2) ─────────────────────────────────────────────────
  test('the retry drip is the template KEY new_lead (a newsletter-group template): bounce, suppression of the bounced address only, resend through the newsletter group, delivery commit; no alert, rescue or card', async () => {
    const svc = require('../services/call-email-spelling-retry');
    expect([...svc.RETRY_TEMPLATE_KEYS]).toEqual(['new_lead']);
    ctx = await setup({ sent: 1 });
    expect((await db('automation_templates').where({ key: ctx.key }).first()).asm_group).toBe('newsletter');
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending' });
    expect(bounceRecovery.alertBouncedContactAddress).not.toHaveBeenCalled();
    expect(bounceRescue.rescueBouncedAddress).not.toHaveBeenCalled();
    expect(reverify.reverifyBouncedEmailFromCall).not.toHaveBeenCalled();
    // The bounce suppresses the bounced address (as today); the retry address stays mailable.
    expect(await db('email_suppressions').whereRaw('LOWER(email) = ?', [BOUNCED]).where({ status: 'active' })).not.toHaveLength(0);
    expect(await db('email_suppressions').whereRaw('LOWER(email) = ?', [OTHER]).where({ status: 'active' })).toHaveLength(0);
    await runner.sendStep(ctx.enrollment.id);
    const newsletterTemplate = await db('automation_templates').where({ key: ctx.key }).first();
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({ to: OTHER, subject: 'Step 1', asmGroupId: runner.automationAsmGroupId(newsletterTemplate) }));
    const row = await retryRow();
    expect(await post([argEvent(row.id, 'ev-nl-1', { sg_message_id: `${row.sendgrid_message_id}.f` })])).toBe(200);
    expect((await ledger(ctx.customerId))[0].status).toBe('committed');
    expect((await db('customers').where({ id: ctx.customerId }).first()).email).toBe(OTHER);
  });

  test('a seeded SERVICE-group template (service_renewal) with a settled spelling gets no retry: today\'s path', async () => {
    ctx = await setup({ sent: 1, templateKey: 'service_renewal' });
    expect((await db('automation_templates').where({ key: 'service_renewal' }).first()).asm_group).not.toBe('newsletter');
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ status: 'active', completed_at: null });
    await webhook.handleEvent(bounce(ctx.send));
    await flush();
    expect(await ledger(ctx.customerId)).toEqual([]);
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'cancelled', email: BOUNCED });
    expect(bounceRecovery.alertBouncedContactAddress).toHaveBeenCalledTimes(1);
  });

  test('send boundary: an enrollment that is not the allowlisted drip of the call\'s episode is stopped, whatever carries the provenance', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    // A stray enrollment of another template pointed at the retry address with provenance: never mailed.
    const stray = await seedEnrollment({ customerId: ctx.customerId, sent: 0, email: OTHER });
    await db('automation_enrollments').where({ id: stray.enrollment.id }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ spelling_retry_email: OTHER })]),
    });
    await runner.sendStep(stray.enrollment.id);
    expect(sendgrid.sendOne.mock.calls.filter(([a]) => a.to === OTHER)).toHaveLength(0);
    expect(await enrollmentRow(stray.enrollment.id)).toMatchObject({ status: 'cancelled' });
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'template_not_allowed' });
  });

  test('send boundary: the allowlisted drip, once it is no longer the call\'s episode, is stopped too', async () => {
    ctx = await setup({ sent: 1 });
    await webhook.handleEvent(bounce(ctx.send));
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ enrolled_at: new Date(Date.now() - 2 * 86400 * 1000) });
    await runner.sendStep(ctx.enrollment.id);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'skipped', reason: 'template_not_allowed' });
  });

  test('a reactivated new_lead enrollment (enrolled_at reset) after the call IS the call\'s episode', async () => {
    ctx = await setup({ sent: 1 });
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ enrolled_at: new Date(Date.now() + 1000) });
    await webhook.handleEvent(bounce(ctx.send));
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'resending' });
  });

  test('a send sendOne RETURNED (accepted) is never a failure, whatever failed after it', async () => {
    await queuedRetry();
    sendgrid.sendOne.mockImplementationOnce(async () => ({ messageId: 'acc-3' })); // returned without passing through the boundary hook
    const undo = await failStatementWhen('automation_step_sends', 'UPDATE', "NEW.sendgrid_message_id = 'acc-3'");
    try {
      await runner.sendStep(ctx.enrollment.id);
    } finally {
      await undo();
    }
    await expectClaimOpen();
    expect(await retryRow()).toMatchObject({ status: 'sent' });
  });

  test('ambiguous and then no event for 72 h: the claim is stale -- it no longer owns a bounce and fails as stale', async () => {
    await queuedRetry();
    afterRequestLeft(timeoutError());
    await runner.sendStep(ctx.enrollment.id);
    await expectClaimOpen();
    const sibling = await seedEnrollment({ customerId: ctx.customerId, sent: 0 });
    await ageClaim(ctx.customerId, 80);
    const stray = await strayAutomationSend(sibling.enrollment.id, sibling.steps[0].id, 'amb-stale-1', BOUNCED);
    await webhook.handleEvent(bounce(stray, BOUNCED));
    await flush();
    expect((await ledger(ctx.customerId))[0]).toMatchObject({ status: 'failed', reason: 'stale' });
  });

  test('the classifier is the codebase\'s: sendgrid.isDefiniteRejection decides, and only for the bound retry send', async () => {
    // Any other automation send keeps today\'s handling: a timeout still fails the row and the enrollment.
    ctx = await setup({ sent: 1, call: false, customerEmail: 'jondoe-plain@example.com', email: 'jondoe-plain@example.com' });
    await db('automation_enrollments').where({ id: ctx.enrollment.id }).update({ next_send_at: new Date(Date.now() - 1000) });
    afterRequestLeft(timeoutError());
    expect(await runner.sendStep(ctx.enrollment.id)).toMatchObject({ sent: false });
    expect(await enrollmentRow(ctx.enrollment.id)).toMatchObject({ status: 'failed' });
  });

  test('gate off: the same ledger-insert failure on a delivery of the bound retry send keeps today\'s 200', async () => {
    await boundRetryDelivery('gateoff-1');
    delete process.env.GATE_CALL_BOUNCE_OTHER_SPELLING;
    const undo = await failStatementWhen('sendgrid_webhook_events', 'INSERT', "NEW.event_id = 'ev-gateoff-1'");
    try {
      expect(await post([deliveredEvent('gateoff-1', 'ev-gateoff-1')])).toBe(200);
    } finally {
      await undo();
    }
  });
});
