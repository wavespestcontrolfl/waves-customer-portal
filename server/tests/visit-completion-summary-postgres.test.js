/** Summary delivery recovery on a migrated, task-private PostgreSQL database. */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
// isScheduledTick/scheduleInterval arrive with the customer send lock main
// now wraps _runSequenceStep in (#4330): cron-lock reads isScheduledTick()
// for its default waitForSlot, so a mock without it throws inside the step.
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
  isScheduledTick: () => false, runAsScheduledTick: (fn) => fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => null) }));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => null) }));
jest.mock('../services/sendgrid-mail', () => ({
  sendOne: jest.fn(), clearBlockedAddress: jest.fn(async () => {}), serviceGroupId: () => null, newsletterGroupId: () => null,
  // The real rule: a 4xx the provider answered with is a proven refusal,
  // everything else (5xx, network) is ambiguous.
  isDefiniteRejection: (err) => [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(Number(err?.status)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const knex = require('knex');
const { randomUUID, createHash } = require('crypto');
const Summary = require('../services/visit-completion-summary');
const VisitGroups = require('../services/visit-groups');
const { sendOne } = require('../services/sendgrid-mail');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { ABORTED_BEFORE_DISPATCH } = require('../services/email-template-library');
const { etDateString } = require('../utils/datetime-et');
const { runVisitCompletionPacketEffects, enrollVisitCompletionReview } = require('../services/visit-completion-packets');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let fixture;
jest.setTimeout(90000);

function emailKey(email) {
  return `visit_summary:${fixture.visitId}:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
}

async function priorEmail(email, fields) {
  await mockPg('email_messages').insert({ template_key: 'service.visit_summary', recipient_id: fixture.customerId,
    recipient_email_snapshot: email, trigger_event_id: `visit_summary:${fixture.visitId}`,
    idempotency_key: emailKey(email), ...fields });
}

async function priorClaim(kind, fields) {
  await mockPg('visit_effects').insert({ visit_id: fixture.visitId, effect_type: kind,
    dedupe_key: `${fixture.visitId}:${kind}`, claim_token: 'old-owner',
    claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000), ...fields });
}

async function deliver() {
  return Summary.deliverVisitCompletionSummary(fixture.packetId, fixture.token);
}

// Both delivery legs already settled: the state a paid signal normally finds.
async function settledDelivery() {
  await priorClaim('completion_sms', { status: 'suppressed' });
  await priorClaim('completion_email', { status: 'sent', sent_at: new Date() });
}

// Emulates the canonical sender's locked handoff and the provider wrapper's
// contract: a throw before dispatch is a retryable block, a throw from the
// provider request itself is the (ambiguous) provider outcome.
function handoffSender(provider = async () => ({ sent: true })) {
  return async ({ withSmsHandoff }) => {
    let outcome;
    let dispatched = false;
    let verdict;
    try {
      verdict = await withSmsHandoff(async (_trx, onProviderStart) => {
        if (typeof onProviderStart === 'function') await onProviderStart();
        dispatched = true; outcome = await provider(); return { ok: true };
      });
    } catch (err) {
      if (dispatched) return { sent: false, retryable: true, code: 'PROVIDER_UNAVAILABLE', providerHttpStatus: err.providerHttpStatus };
      verdict = { ok: false, code: 'SMS_HANDOFF_CHECK_FAILED', reason: err.message, retryable: true };
    }
    if (verdict.ok !== true) return { sent: false, blocked: true, code: verdict.code, retryable: verdict.retryable === true };
    return outcome;
  };
}

// The scheduled worker's locked handoff for a queued summary.
function deferredHandoff(meta, dispatch = async () => ({ ok: true })) {
  return require('../services/messaging/deferred-replay-registry').deferredSmsHandoff('visit_summary_deferred', meta)(dispatch);
}

// The cadence gate is off in the test environment; a test that expects a
// parked cadence to resume turns it on for the sequence gate only.
function cadenceGateOn() {
  const gates = require('../config/feature-gates');
  const original = gates.isEnabled;
  jest.spyOn(gates, 'isEnabled').mockImplementation((name) => (name === 'reviewSequences' ? true : original(name)));
}

function providerFailure(providerHttpStatus) {
  return Object.assign(new Error('provider failure'), { providerHttpStatus });
}

postgres('visit summary recipient recovery', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.restoreAllMocks();
    sendOne.mockReset().mockImplementation(async () => ({ messageId: randomUUID() }));
    sendCustomerMessage.mockReset().mockImplementation(handoffSender());
    fixture = { customerId: randomUUID(), techId: randomUUID(), visitId: randomUUID(), packetId: randomUUID(),
      serviceIds: [randomUUID(), randomUUID()].sort(), recordIds: [randomUUID(), randomUUID()] };
    fixture.primaryEmail = `${fixture.customerId}@example.invalid`;
    fixture.serviceEmail = `${fixture.visitId}@example.invalid`;
    fixture.payload = { items: fixture.serviceIds.map((serviceId) => ({ serviceId, body: { sendCompletionSms: false } })) };
    const date = etDateString();
    await mockPg.transaction(async (trx) => {
      await trx('customers').insert({ id: fixture.customerId, first_name: 'Fixture', email: fixture.primaryEmail,
        phone: '+12025550123', service_contact_email: fixture.serviceEmail, service_contact_name: 'Service Fixture',
        service_contact_phone: '+12025550124', service_contacts_consent_at: trx.fn.now() });
      await trx('technicians').insert({ id: fixture.techId, name: 'Fixture Technician', role: 'technician', active: true });
      await trx('service_visits').insert({ id: fixture.visitId, customer_id: fixture.customerId, technician_id: fixture.techId,
        scheduled_date: date, window_start: '09:00', window_end: '11:00', status: 'closing',
        stop_base_key: VisitGroups.stopBaseKey({ customerId: fixture.customerId, scheduledDate: date }), created_by: 'test' });
      await trx('scheduled_services').insert(fixture.serviceIds.map((id, i) => ({ id, customer_id: fixture.customerId,
        technician_id: fixture.techId, visit_id: fixture.visitId, service_type: 'Fixture General Pest Control',
        scheduled_date: date, window_start: `${9 + i}:00`, window_end: `${10 + i}:00`, status: 'completed' })));
      await trx('service_records').insert(fixture.recordIds.map((id, i) => ({ id, customer_id: fixture.customerId,
        scheduled_service_id: fixture.serviceIds[i], service_type: 'Fixture General Pest Control', service_date: date,
        status: 'completed', report_view_token: (i ? 'b' : 'a').repeat(32),
        structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send' }) })));
      await trx('visit_completion_packets').insert({ id: fixture.packetId, visit_id: fixture.visitId,
        idempotency_key: randomUUID(), request_hash: 'a'.repeat(64), payload: JSON.stringify(fixture.payload), status: 'processing' });
      await trx('visit_completion_packet_items').insert(fixture.serviceIds.map((id, i) => ({ packet_id: fixture.packetId,
        scheduled_service_id: id, service_record_id: fixture.recordIds[i], derived_idempotency_key: randomUUID(), status: 'done' })));
    });
    fixture.token = await Summary.ensureVisitSummaryToken(fixture.packetId);
  });
  afterEach(async () => {
    await mockPg('sms_log').where({ customer_id: fixture.customerId }).del();
    await mockPg('email_messages').where({ recipient_id: fixture.customerId }).del();
    await mockPg('dispatch_alerts').where({ tech_id: fixture.techId }).del();
    await mockPg('customers').where({ id: fixture.customerId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
  });

  async function heldSummary() {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const nextAllowedAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, retryable: true,
      deferred: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    const queued = await mockPg('sms_log').where({ customer_id: fixture.customerId }).first();
    expect(queued).toMatchObject({ status: 'scheduled', message_type: 'visit_summary', to_phone: '+12025550124' });
    expect(new Date(queued.scheduled_for).toISOString()).toBe(nextAllowedAt);
    return queued;
  }

  test('quiet hours queue once and scheduled finalization dedupes packet replay', async () => {
    const queued = await heldSummary();
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log').where({ customer_id: fixture.customerId })).toHaveLength(1);
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: true });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: true });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: false });
    expect(await replay.finalizeDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: true });
    expect(await replay.finalizeDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: true });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('the actual scheduled worker retries finalization without resending the summary', async () => {
    const queued = await heldSummary();
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    const gates = require('../config/feature-gates');
    const isEnabled = gates.isEnabled;
    jest.spyOn(gates, 'logGateStatus').mockImplementation(() => {});
    jest.spyOn(gates, 'isEnabled').mockImplementation((gate) => gate === 'cronJobs' || isEnabled(gate));
    require('../services/scheduler').initScheduledJobs();
    const tick = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    sendCustomerMessage.mockImplementation(handoffSender(async () => ({ sent: true, providerMessageId: 'fixture-scheduled-provider-id' })));
    jest.spyOn(VisitGroups, 'finalizeVisitNotification').mockResolvedValueOnce({ ok: false });
    await tick();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(sendCustomerMessage.mock.calls[1][0]).toMatchObject({
      purpose: 'service_completion', to: '+12025550124', entryPoint: 'scheduled_sms_cron',
    });
    expect(await mockPg('sms_log').where({ id: queued.id }).first()).toMatchObject({
      status: 'scheduled', metadata: { finalize_only: true, finalize_pending: true },
    });
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(await mockPg('sms_log').where({ id: queued.id }).first()).toMatchObject({ status: 'sent' });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('an admin-cancelled scheduled summary settles without queuing or sending again', async () => {
    const queued = await heldSummary();
    await mockPg('sms_log').where({ id: queued.id, status: 'scheduled' }).del();
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed', last_error: 'scheduled_message_cancelled' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(await mockPg('sms_log').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test.each(['contact', 'consent', 'revocation'])('a queued summary suppresses after %s changes', async (change) => {
    const queued = await heldSummary();
    const replay = require('../services/messaging/deferred-replay-registry');
    if (change === 'contact') await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '+12025550125' });
    if (change === 'consent') await mockPg('customers').where({ id: fixture.customerId }).update({ service_contacts_consent_at: null });
    if (change === 'revocation') await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: false });
    expect(await replay.onTerminalDeferredReplay('visit_summary_deferred', queued.metadata)).toEqual({ ok: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test.each(['sms_enabled', 'service_completed'])('an immediate SMS rechecks %s after the sender validation and before its claim', async (toggle) => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let providerCalls = 0;
    const sender = handoffSender(async () => { providerCalls += 1; return { sent: true }; });
    sendCustomerMessage.mockImplementation(async (input) => {
      // The canonical sender already validated consent. The preference
      // writer commits before the handoff gets its row lock.
      await mockPg('notification_prefs').insert({ customer_id: fixture.customerId, [toggle]: false,
        seasonal_tips: null, marketing_offers: null }).onConflict('customer_id').merge({ [toggle]: false });
      return sender(input);
    });
    await deliver();
    expect(providerCalls).toBe(0);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
    // The email leg can need one recovery pass to observe the new shared toggle.
    expect(await deliver()).toEqual({ state: 'delivered' });
  });

  test.each(['sms_enabled', 'service_completed'])('a queued summary whose customer turned off %s is refused at the dispatch claim', async (toggle) => {
    const queued = await heldSummary();
    // The sender's own consent read happens before the claim callback; the
    // claim holds and re-reads the preference row itself.
    await mockPg('notification_prefs').insert({ customer_id: fixture.customerId, [toggle]: false })
      .onConflict('customer_id').merge({ [toggle]: false });
    try {
      const replay = require('../services/messaging/deferred-replay-registry');
      expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: false });
      expect(await replay.onTerminalDeferredReplay('visit_summary_deferred', queued.metadata)).toEqual({ ok: true });
    } finally {
      await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    }
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test('a revocation cannot slip between the replay validation and the dispatch claim: it waits on the held visit row', async () => {
    const queued = await heldSummary();
    // The claim runs on a transaction client, which inherits the prototype.
    const execute = mockPg.client.constructor.prototype._query;
    let attempted = false;
    let blockedCode = null;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function revokeBeforeClaim(connection, query) {
      if (!attempted && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        attempted = true;
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
        }).catch((err) => { blockedCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: true });
    expect(attempted).toBe(true);
    expect(blockedCode).toBe('55P03');
    // Once the claim commits, the revocation lands and the next replay is refused.
    jest.restoreAllMocks();
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
    expect(await require('../services/messaging/deferred-replay-registry').recheckDeferredReplay('visit_summary_deferred', queued.metadata))
      .toMatchObject({ eligible: false, reason: 'visit_summary_unavailable' });
  });

  test('an ambiguous scheduled provider handoff cannot resend and reaches office review', async () => {
    const queued = await heldSummary();
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: true });
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: false });
    expect(await replay.onTerminalDeferredReplay('visit_summary_deferred', queued.metadata)).toEqual({ ok: true });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a formatting-only edit of the queued recipient number keeps the deferred summary eligible', async () => {
    const queued = await heldSummary();
    await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '(202) 555-0124' });
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: true });
    await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '+12025550199' });
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: false, reason: 'visit_summary_recipient_changed' });
  });

  test('an archived visit customer is refused at replay reauthorization', async () => {
    const queued = await heldSummary();
    await mockPg('customers').where({ id: fixture.customerId }).update({ deleted_at: new Date() });
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: false, reason: 'visit_summary_unavailable' });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: false });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a retryable provider block leaves the summary with the retry rail instead of reopening it', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    await mockPg.transaction(async (trx) => {
      await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'bounce', type: 'blocked', reason: 'IP blocked', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID(), email: delivered.recipient_email_snapshot }, delivered, trx);
    });
    expect(await mockPg('email_messages').where({ id: delivered.id }).first()).toMatchObject({ status: 'failed' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'sent' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
  });

  test.each(['unsubscribed address', 'group unsubscribe', 'spam reporting address'])('a drop for an opted-out recipient (%s) settles the summary as suppressed, not as a bounce for review', async (reason) => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    const recipients = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` });
    await mockPg.transaction(async (trx) => {
      await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'dropped', reason, timestamp: Math.floor(Date.now() / 1000),
        sg_event_id: randomUUID(), email: delivered.recipient_email_snapshot, asm_group_id: '1' }, delivered, trx);
    });
    expect(await mockPg('email_messages').where({ id: delivered.id }).first()).toMatchObject({ status: 'dropped', error_message: reason });
    // One recipient declined, the other holds the summary: still sent, no review.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'sent' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    // Every recipient declined: the aggregate settles as suppressed, still no review.
    for (const other of recipients.filter((row) => row.id !== delivered.id)) {
      await mockPg.transaction(async (trx) => {
        await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'dropped', reason, timestamp: Math.floor(Date.now() / 1000),
          sg_event_id: randomUUID(), email: other.recipient_email_snapshot, asm_group_id: '1' }, other, trx);
      });
    }
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'suppressed' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    // The same drop for an unreachable address is a bounce for review.
    await mockPg('email_messages').where({ id: delivered.id }).update({ bounced_at: null });
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).update({ status: 'sent' });
    await mockPg.transaction(async (trx) => {
      await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'dropped', reason: 'Bounced Address', timestamp: Math.floor(Date.now() / 1000),
        sg_event_id: randomUUID(), email: delivered.recipient_email_snapshot }, { ...delivered, bounced_at: null }, trx);
    });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'unknown_delivery' });
  });

  test('a retry refused after a provider block settles a still-sent summary as suppressed', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'sent' });
    // The block left the effect with the retry rail; the refused retry is the ledger's last word.
    await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).update({ status: 'blocked', error_message: 'Suppressed before retry: do_not_email' });
    expect(await Summary.reconcileSummaryEmailRecovery({ ...delivered, status: 'blocked' })).toEqual({ reconciled: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'suppressed', sent_at: null });
    // A delivery event on an already-sent aggregate changes nothing.
    await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).update({ status: 'delivered' });
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).update({ status: 'sent' });
    expect(await Summary.reconcileSummaryEmailRecovery({ ...delivered, status: 'delivered' })).toEqual({ reconciled: false });
  });

  test('a provider block that exhausts the retries reopens the summary for delivery review', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const rows = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` });
    await mockPg('email_messages').whereIn('id', rows.map((row) => row.id)).update({ provider_retry_count: 99 });
    for (const row of rows) {
      await mockPg.transaction(async (trx) => {
        await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'bounce', type: 'blocked', reason: 'IP blocked',
          timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID(), email: row.recipient_email_snapshot }, { ...row, provider_retry_count: 99 }, trx);
      });
    }
    expect(await mockPg('email_messages').where({ id: rows[0].id }).first()).toMatchObject({ status: 'failed' });
    expect((await mockPg('email_messages').where({ id: rows[0].id }).first()).provider_retry_exhausted_at).not.toBeNull();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
  });

  test('a definitive provider rejection of the summary text settles as suppressed, not as unknown', async () => {
    sendCustomerMessage.mockImplementation(handoffSender(async () => ({ sent: false, blocked: false, terminal: true, retryable: false, code: 'PROVIDER_FAILURE' })));
    fixture.payload.items.forEach((item) => { item.body.sendCompletionSms = true; item.body.requestReview = false; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await deliver();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'suppressed' });
  });

  test('a multi-address writer takes every email key in one global order', async () => {
    const { lockAssignedCustomerEmails, customerEmailLockKeys } = require('../utils/customer-comms-lock');
    const keys = [];
    const onQuery = (query) => { if (/pg_advisory_xact_lock/.test(query.sql)) keys.push(query.bindings[0]); };
    mockPg.on('query', onQuery);
    try {
      await mockPg.transaction((trx) => lockAssignedCustomerEmails(trx, { email: 'john.doe+a@gmail.com', service_contact_email: 'aaa@example.invalid', billing_email: 'johndoe@gmail.com' }));
    } finally {
      mockPg.off('query', onQuery);
    }
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(keys).toEqual(['customer-email:aaa@example.invalid', 'customer-email:john.doe+a@gmail.com', 'customer-email:johndoe@gmail.com', 'customer-mailbox:johndoe@gmail.com']);
    expect(customerEmailLockKeys('john.doe@gmail.com')).toEqual(['customer-email:john.doe@gmail.com', 'customer-mailbox:johndoe@gmail.com']);
  });

  test('an abandoned handoff row is settled before the reclaim, so a crash between them cannot strand it', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    const [queued] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: fixture.primaryEmail,
      idempotency_key: `visit_summary:${fixture.visitId}:${randomUUID()}`, status: 'queued', queued_at: new Date(Date.now() - 3600000),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com', categories: JSON.stringify(['email_template']),
    }).returning('*');
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: `handoff_pending:${queued.id}` });
    // The reclaim dies: the abandoned row must already be settled as a pre-dispatch abort.
    const originalClaim = VisitGroups.claimVisitNotification;
    const claim = jest.spyOn(VisitGroups, 'claimVisitNotification').mockImplementation(async (row, kind) => {
      if (kind === 'completion_email') throw new Error('lost before the claim committed');
      return originalClaim(row, kind);
    });
    try {
      await deliver().catch(() => {});
    } finally {
      claim.mockRestore();
    }
    expect(await mockPg('email_messages').where({ id: queued.id }).first()).toMatchObject({ status: 'failed', error_message: ABORTED_BEFORE_DISPATCH });
    // The marker is still on the effect for the next owner to reclaim.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: `handoff_pending:${queued.id}` });
    await mockPg('visit_effects').where({ visit_id: fixture.visitId }).del();
  });

  test('an abandoned-row settlement re-reads the marker under the effect row and yields to a provider start', async () => {
    const [queued] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: fixture.primaryEmail,
      idempotency_key: `visit_summary:${fixture.visitId}:${randomUUID()}`, status: 'queued', queued_at: new Date(Date.now() - 3600000),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com', categories: JSON.stringify(['email_template']),
    }).returning('*');
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: `handoff_pending:${queued.id}` });
    try {
      const settle = await Summary._settleAbandonedSummaryEmailRow(fixture.visitId, mockPg);
      expect(typeof settle).toBe('function');
      // The delayed owner reached its provider start between the read and the settlement.
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).update({ last_error: null });
      expect(await settle()).toBe(0);
      expect(await mockPg('email_messages').where({ id: queued.id }).first()).toMatchObject({ status: 'queued' });
      // With the marker intact the row settles.
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).update({ last_error: `handoff_pending:${queued.id}` });
      expect(await settle()).toBe(1);
      expect(await mockPg('email_messages').where({ id: queued.id }).first()).toMatchObject({ status: 'failed', error_message: ABORTED_BEFORE_DISPATCH });
    } finally {
      await mockPg('visit_effects').where({ visit_id: fixture.visitId }).del();
    }
  });

  test('a billing-email save assigning the recovery destination waits for the held retry handoff', async () => {
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary', recipient_email_snapshot: fixture.primaryEmail };
    const destination = `${randomUUID()}@example.invalid`;
    let blockedCode = null;
    expect(await Summary.retrySummaryThroughHandoff(message, async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('notification_prefs').where({ customer_id: fixture.customerId }).forUpdate().first('customer_id');
        await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, { billing_email: destination });
      }).catch((err) => { blockedCode = err.code; });
      return { ok: true };
    }, { destination })).toEqual({ ok: true });
    expect(blockedCode).toBe('55P03');
  });

  test('a queued summary carries its recorded member so the replay applies the same per-property toggles', async () => {
    const queued = await heldSummary();
    expect(fixture.serviceIds).toContain(queued.metadata.scheduled_service_id);
  });

  test('a per-property toggle write attempted during the summary handoff waits for it to commit', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let blockedCode = null;
    sendCustomerMessage.mockImplementation(handoffSender(async () => {
      // savePropertyToggles commits under the customer-comms lock.
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await require('../utils/customer-comms-lock').lockCustomerComms(trx, fixture.customerId);
      }).catch((err) => { blockedCode = err.code; });
      return { sent: true };
    }));
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(blockedCode).toBe('55P03');
  });

  test('a worker that dies between the SMS dispatch mark and its provider request leaves a reclaimable summary', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const member = await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first();
    const claim = await VisitGroups.claimVisitNotification(member, 'completion_sms');
    expect(claim.state).toBe('owner');
    expect(await VisitGroups.beginVisitNotificationDispatch(fixture.visitId, 'completion_sms', claim.token)).toBe(true);
    // The process is lost here: the mark is durable and no provider request was made.
    const effect = () => mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first();
    expect(await effect()).toMatchObject({ status: 'unknown_delivery', last_error: 'handoff_pending' });
    // Within the lease the mark is a live handoff: nothing resends and the packet stays pending.
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' })
      .update({ claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000) });
    // Past the lease the marker proves the request never went out: reclaimed and sent once.
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(await effect()).toMatchObject({ status: 'sent', last_error: null });
  });

  test('a mark whose pre-provider marker was cleared is never reclaimed, even past the lease', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const member = await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first();
    const claim = await VisitGroups.claimVisitNotification(member, 'completion_sms');
    expect(await VisitGroups.beginVisitNotificationDispatch(fixture.visitId, 'completion_sms', claim.token)).toBe(true);
    expect(await VisitGroups.markVisitNotificationProviderStart(fixture.visitId, 'completion_sms', claim.token)).toBe(true);
    // The clear is one-shot: a mark without its marker is a request that may have gone out.
    expect(await VisitGroups.markVisitNotificationProviderStart(fixture.visitId, 'completion_sms', claim.token)).toBe(false);
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' })
      .update({ claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000) });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a worker that dies between the email dispatch mark and its provider request leaves the queued row recoverable', async () => {
    // Emulated through the real library: the durable mark commits, then every
    // write the graceful paths would make (the pre-provider clear, the unmark,
    // the library's abort, the finalize, a further recipient's ledger row) is lost.
    const execute = mockPg.client.constructor.prototype._query;
    let marked = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function crash(connection, query) {
      const bindings = (query.bindings || []).map((value) => String(value));
      const lost = () => Promise.reject(new Error('Synthetic process loss before the provider request'));
      if (query.sql.startsWith('update "visit_effects"') && bindings.includes('unknown_delivery') && bindings.some((value) => value.startsWith('handoff_pending:'))) {
        if (marked) return lost();
        marked = true;
      } else if (marked && (
        (query.sql.startsWith('update "visit_effects"') && bindings.includes('handoff_pending%'))
        || (query.sql.startsWith('update "email_messages"') && bindings.includes(ABORTED_BEFORE_DISPATCH))
        || (query.sql.startsWith('insert into "visit_effects"') && bindings.includes('completion_email'))
        || query.sql.startsWith('insert into "email_messages"'))) {
        return lost();
      }
      return execute.call(this, connection, query);
    });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    jest.restoreAllMocks();
    expect(marked).toBe(true);
    expect(sendOne).not.toHaveBeenCalled();
    const effect = await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first();
    expect(effect).toMatchObject({ status: 'unknown_delivery' });
    expect(effect.last_error).toMatch(/^handoff_pending:/);
    const abandoned = await mockPg('email_messages').where({ id: effect.last_error.split(':')[1] }).first();
    expect(abandoned).toMatchObject({ status: 'queued', provider_message_id: null, sent_at: null });
    // Within the lease nothing resends; past it the queued row is settled as a
    // pre-dispatch abort and the replay finishes every recipient.
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendOne).not.toHaveBeenCalled();
    await mockPg('visit_effects').where({ id: effect.id }).update({ claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000) });
    expect(await deliver()).toEqual({ state: 'delivered' });
    // The settled row (a pre-dispatch abort) is the one the library retries under its idempotency key: sent once.
    expect(await mockPg('email_messages').where({ id: abandoned.id }).first()).toMatchObject({ status: 'sent' });
    const sent = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}`, status: 'sent' });
    expect(sent.filter((row) => row.recipient_email_snapshot === abandoned.recipient_email_snapshot)).toHaveLength(1);
    expect(await mockPg('visit_effects').where({ id: effect.id }).first()).toMatchObject({ status: 'sent', last_error: null });
  });

  // A contact correction locks the customer row and then takes the address
  // key; a handoff taking the key first would deadlock against it.
  async function rowThenKeyWriter(email) {
    return mockPg.transaction(async (trx) => {
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await require('../utils/customer-comms-lock').lockCustomerEmail(trx, email);
      await trx('customers').where({ id: fixture.customerId }).update({ updated_at: trx.fn.now() });
      return 'committed';
    });
  }

  test('the email summary handoff takes the customer row before the address key, so a row-first writer never deadlocks it', async () => {
    const writer = rowThenKeyWriter(fixture.primaryEmail);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const delivery = deliver();
    await expect(writer).resolves.toBe('committed');
    expect(await delivery).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalled();
  });

  test('a save assigning a Gmail dot/tag variant of the recovery destination waits for the held retry handoff', async () => {
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary', recipient_email_snapshot: fixture.primaryEmail };
    const destination = `john.doe.${randomUUID().slice(0, 8)}@gmail.com`;
    const alias = `${destination.split('@')[0].replace(/\./g, '')}+billing@googlemail.com`;
    let blockedCode = null;
    expect(await Summary.retrySummaryThroughHandoff(message, async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, { email: alias });
      }).catch((err) => { blockedCode = err.code; });
      return { ok: true };
    }, { destination })).toEqual({ ok: true });
    expect(blockedCode).toBe('55P03');
  });

  test('a provider event for the recipient takes the address key before touching the message row', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary', recipient_email_snapshot: delivered.recipient_email_snapshot };
    let blockedCode = null;
    let rowTouched = null;
    // The retry handoff holds the destination key; a bounce webhook for that row must wait on the key first, not hold the row while waiting.
    expect(await Summary.retrySummaryThroughHandoff(message, async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await require('../routes/webhooks-sendgrid').handleEmailMessageEvent({ event: 'bounce', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID(), email: delivered.recipient_email_snapshot }, delivered, trx);
      }).catch((err) => { blockedCode = err.code; });
      rowTouched = (await mockPg('email_message_events').where({ email_message_id: delivered.id })).length;
      return { ok: true };
    })).toEqual({ ok: true });
    expect(blockedCode).toBe('55P03');
    expect(rowTouched).toBe(0);
  });

  test('a formatting-only edit of the recipient number between resolution and the locked recheck still sends the summary SMS', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const execute = mockPg.client.constructor.prototype._query;
    let edited = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function resaveDuringClaim(connection, query) {
      if (!edited && query.sql.includes('pg_advisory_xact_lock') && String(query.bindings?.[0] || '').startsWith('customer-comms:')) {
        edited = true;
        await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '(202) 555-0124' });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await deliver()).toEqual({ state: 'delivered' });
      expect(edited).toBe(true);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'sent' });
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('a service-contact save assigning the recovery destination waits for the held retry handoff', async () => {
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary', recipient_email_snapshot: fixture.primaryEmail };
    const destination = `${randomUUID()}@example.invalid`;
    let blockedCode = null;
    expect(await Summary.retrySummaryThroughHandoff(message, async () => {
      // The contact-route save: customer row FOR UPDATE, then the key for every assigned address.
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, { service_contact2_email: destination });
      }).catch((err) => { blockedCode = err.code; });
      return { ok: true };
    }, { destination })).toEqual({ ok: true });
    expect(blockedCode).toBe('55P03');
  });

  test('the retry handoff takes the customer row before the address key, so a row-first writer never deadlocks it', async () => {
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary', recipient_email_snapshot: fixture.primaryEmail };
    const writer = rowThenKeyWriter(fixture.primaryEmail);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const handoff = Summary.retrySummaryThroughHandoff(message, async () => ({ ok: true }));
    await expect(writer).resolves.toBe('committed');
    expect(await handoff).toEqual({ ok: true });
  });

  test('a proven provider-boundary quiet-hours hold can retry its pending scheduled handoff', async () => {
    const queued = await heldSummary();
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: true });
    const effect = await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first();
    const heldMeta = { ...queued.metadata, quiet_hours_hold_at: new Date(effect.claimed_at).toISOString() };
    expect(await deferredHandoff(heldMeta)).toMatchObject({ ok: true });
    // The retry re-claimed the effect after the hold stamp; make that gap
    // real rather than relying on the two claims landing >1 ms apart.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await mockPg('visit_effects').where({ id: effect.id }).first()).toMatchObject({ status: 'unknown_delivery' });
    expect(await deferredHandoff(heldMeta)).toMatchObject({ ok: false });
  });

  test.each([
    ['a provider refusal (429) after the scheduled handoff is ambiguous and stays on office review', 429],
    ['an ambiguous provider timeout on the scheduled handoff stays on office review', undefined],
  ])('%s', async (_label, providerHttpStatus) => {
    const queued = await heldSummary();
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    const gates = require('../config/feature-gates');
    const isEnabled = gates.isEnabled;
    jest.spyOn(gates, 'logGateStatus').mockImplementation(() => {});
    jest.spyOn(gates, 'isEnabled').mockImplementation((gate) => gate === 'cronJobs' || isEnabled(gate));
    require('../services/scheduler').initScheduledJobs();
    const tick = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    let providerCalls = 0;
    sendCustomerMessage.mockImplementation(handoffSender(async () => {
      providerCalls += 1;
      if (providerCalls === 1) throw providerFailure(providerHttpStatus);
      return { sent: true, providerMessageId: 'fixture-scheduled-provider-id' };
    }));
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(providerCalls).toBe(1);
    expect(await mockPg('sms_log').where({ id: queued.id }).first()).toMatchObject({ status: 'scheduled' });
    // The provider may hold the text: the worker's own retry cannot re-claim it.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(providerCalls).toBe(1);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
  });

  test('an initial consent lookup failure retries the requested SMS instead of suppressing it', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED' });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'failed' });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('omitting the optional SMS field preserves the canonical no-SMS default', async () => {
    for (const item of fixture.payload.items) delete item.body.sendCompletionSms;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an issued summary with no effects is distinguished from a legacy group with no summary', async () => {
    const { loadCloseoutInputs } = require('../services/closeout-status');
    const pending = await loadCloseoutInputs(fixture.serviceIds[0]);
    expect(pending.visitSummaryLookupFailed).toBe(false);
    expect(pending.visitSummaryEffects).toEqual([]);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_issued_at: null });
    const legacy = await loadCloseoutInputs(fixture.serviceIds[0]);
    expect(legacy.visitSummaryLookupFailed).toBe(false);
    expect(legacy.visitSummaryEffects).toBeUndefined();
  });

  test('a transient final scheduled recheck remains retryable until the summary sends', async () => {
    const queued = await heldSummary();
    const cron = require('../utils/scheduled-cron');
    cron.schedule.mockClear();
    const gates = require('../config/feature-gates');
    const isEnabled = gates.isEnabled;
    jest.spyOn(gates, 'logGateStatus').mockImplementation(() => {});
    jest.spyOn(gates, 'isEnabled').mockImplementation((gate) => gate === 'cronJobs' || isEnabled(gate));
    require('../services/scheduler').initScheduledJobs();
    const tick = cron.schedule.mock.calls.find(([, callback]) => String(callback).includes('claimDueScheduledSms'))[1];
    // The final recheck runs on the claim transaction's client (prototype-inherited).
    const execute = mockPg.client.constructor.prototype._query;
    let checkingFinal = false;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failFinalRead(connection, query) {
      if (checkingFinal && !interrupted && query.sql.startsWith('select "id" from "service_visits"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic final recheck outage'));
      }
      return execute.call(this, connection, query);
    });
    let providerCalls = 0;
    const sender = handoffSender(async () => { providerCalls += 1; return { sent: true, providerMessageId: 'fixture-scheduled-provider-id' }; });
    sendCustomerMessage.mockImplementation(async (input) => {
      checkingFinal = true;
      try { return await sender(input); } finally { checkingFinal = false; }
    });
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    require('../services/logger').error.mockClear();
    await tick();
    expect(providerCalls).toBe(0);
    expect(require('../services/logger').error.mock.calls).toEqual([]);
    expect(await mockPg('sms_log').where({ id: queued.id }).first()).toMatchObject({
      status: 'scheduled', metadata: { provider_retry_code: 'SMS_HANDOFF_CHECK_FAILED' },
    });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'pending' });
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    await tick();
    expect(providerCalls).toBe(1);
    expect(await deliver()).toEqual({ state: 'delivered' });
  });

  test('an interrupted first delivery resumes only the missing recipient and fully dedupes replay', async () => {
    await priorEmail(fixture.serviceEmail, { status: 'sent', provider_message_id: 'fixture-provider-id', sent_at: new Date() });
    await priorClaim('completion_email', { status: 'unknown_delivery' });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0][0].to).toBe(fixture.primaryEmail);
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['queued', 'failed'])('an uncertain %s recipient is skipped while later recipients finish', async (status) => {
    await priorEmail(fixture.serviceEmail, { status, error_message: 'provider outcome unavailable', queued_at: new Date(0) });
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0][0].to).toBe(fixture.primaryEmail);
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(1);
  });

  test('a fresh provider handoff remains pending until its owner finishes', async () => {
    await priorClaim('completion_email', { status: 'unknown_delivery', claimed_at: new Date() });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendOne).not.toHaveBeenCalled();
  });

  test('a pending ledger row never reports summary delivery as complete', async () => {
    await priorClaim('completion_email', { status: 'pending' });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendOne).not.toHaveBeenCalled();
  });

  test('a durable pre-dispatch abort can retry without duplicating a delivered recipient', async () => {
    await priorEmail(fixture.serviceEmail, { status: 'failed', error_message: ABORTED_BEFORE_DISPATCH });
    await priorEmail(fixture.primaryEmail, { status: 'sent', sent_at: new Date() });
    await priorClaim('completion_email', { status: 'failed' });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0][0].to).toBe(fixture.serviceEmail);
  });

  test.each(['failed', 'bounced', 'dropped'])('provider acceptance on an old %s email does not prove delivery or permit retry', async (status) => {
    await priorEmail(fixture.serviceEmail, { status, provider_message_id: 'fixture-accepted-id',
      sent_at: new Date(), error_message: ABORTED_BEFORE_DISPATCH });
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0][0].to).toBe(fixture.primaryEmail);
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(1);
  });

  test('an old owner cannot dispatch a later recipient after aggregate recovery', async () => {
    let recoveredToken;
    // Recovery cannot take the aggregate while a recipient's handoff holds
    // it; it lands between the first recipient's commit and the second
    // recipient's claim (its queued row is written before that claim).
    const execute = mockPg.client.constructor.prototype._query;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function recoverBetweenRecipients(connection, query) {
      if (!recoveredToken && query.sql.startsWith('insert into "email_messages"') && query.bindings.includes(fixture.primaryEmail)) {
        recoveredToken = 'pending';
        await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' })
          .update({ claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000) });
        const member = await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first();
        recoveredToken = (await VisitGroups.claimVisitNotification(member, 'completion_email')).token;
      }
      return execute.call(this, connection, query);
    });
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(recoveredToken).toBeTruthy();
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(await mockPg('email_messages').where({ idempotency_key: emailKey(fixture.primaryEmail) }).first())
      .toMatchObject({ status: 'failed', error_message: ABORTED_BEFORE_DISPATCH });
    await VisitGroups.finalizeVisitNotification(fixture.visitId, 'completion_email', 'retry', new Date(), recoveredToken);
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('a pre-provider template failure retries both recipients', async () => {
    const templates = require('../services/email-template-library');
    jest.spyOn(templates, 'sendTemplate').mockRejectedValueOnce(new Error('template temporarily unavailable'));
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('a provider timeout does not prevent the next recipient and is never resent', async () => {
    sendOne.mockRejectedValueOnce(new Error('provider response unavailable'));
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('one bounced recipient reopens review even when another recipient was sent', async () => {
    expect(await deliver()).toEqual({ state: 'delivered' });
    const message = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).first();
    await mockPg('email_messages').where({ id: message.id }).update({ status: 'bounced' });
    expect(await mockPg.transaction((trx) => Summary.reconcileSummaryEmailBounce(message, trx)))
      .toEqual({ reconciled: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
  });

  test('one delivered recipient cannot clear another recipient with uncertain delivery', async () => {
    sendOne.mockRejectedValueOnce(new Error('provider response unavailable'));
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId });
    const sent = messages.find((message) => message.status === 'sent');
    expect(await Summary.reconcileSummaryEmailRecovery(sent)).toEqual({ reconciled: false });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    const uncertain = messages.find((message) => message.id !== sent.id);
    await mockPg('email_messages').where({ id: uncertain.id }).update({ status: 'delivered' });
    expect(await Summary.reconcileSummaryEmailRecovery(uncertain)).toEqual({ reconciled: true });
  });

  test('a successful replacement settles only its own original summary recipient', async () => {
    sendOne.mockRejectedValueOnce(new Error('provider response unavailable'));
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId });
    const uncertain = messages.find((message) => message.status !== 'sent');
    const replacementId = randomUUID();
    await priorEmail('replacement@example.invalid', { id: replacementId, status: 'delivered' });
    await mockPg('email_bounce_recoveries').insert({ original_message_id: uncertain.id,
      recovery_message_id: replacementId, bounced_email: uncertain.recipient_email_snapshot,
      corrected_email: 'replacement@example.invalid', customer_id: fixture.customerId, status: 'delivered' });
    const replacement = await mockPg('email_messages').where({ id: replacementId }).first();
    expect(await Summary.reconcileSummaryEmailRecovery(replacement)).toEqual({ reconciled: true });
  });

  test.each(['delivered', 'queued'])('packet replay respects a %s corrected-address recovery while finishing another recipient', async (status) => {
    const originalId = randomUUID();
    const recoveryId = randomUUID();
    const corrected = `${fixture.visitId}-corrected@example.invalid`;
    await priorEmail(fixture.serviceEmail, { id: originalId, status: 'bounced' });
    await priorEmail(corrected, { id: recoveryId, status, idempotency_key: `bounce_recovery:${originalId}` });
    await mockPg('email_bounce_recoveries').insert({ original_message_id: originalId,
      recovery_message_id: recoveryId, bounced_email: fixture.serviceEmail,
      corrected_email: corrected, customer_id: fixture.customerId, status: status === 'delivered' ? 'delivered' : 'resent' });
    await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_email: corrected });
    await priorClaim('completion_email', { status: 'failed' });

    expect(await deliver()).toEqual({ state: status === 'delivered' ? 'delivered' : 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(sendOne.mock.calls[0][0].to).toBe(fixture.primaryEmail);
    expect(await mockPg('email_messages').where({ recipient_id: fixture.customerId })).toHaveLength(3);
    expect(await mockPg('email_messages').where({ id: originalId }).first('status')).toEqual({ status: 'bounced' });
    await deliver();
    expect(sendOne).toHaveBeenCalledTimes(1);
  });

  test('a hidden service cannot enable SMS for a visible service that opted out', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').where({ id: fixture.recordIds[0] }).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'internal_only' }),
    });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await Summary.getVisitCompletionSummary(fixture.token)).services).toHaveLength(1);
  });

  test('SMS recipient honors service-contact consent and its ambiguous handoff is never reclaimed', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('customers').where({ id: fixture.customerId }).update({ service_contacts_consent_at: null });
    sendCustomerMessage.mockImplementationOnce(async ({ withSmsHandoff }) => {
      await withSmsHandoff(async (_trx, onProviderStart) => { await onProviderStart(); throw new Error('provider response unavailable'); });
    });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage.mock.calls[0][0].to).toBe('+12025550123');
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).update({ claimed_at: new Date(0) });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('pending email work survives another channel needing office review', async () => {
    await priorClaim('completion_sms', { status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    jest.spyOn(require('../services/email-template-library'), 'sendTemplate')
      .mockRejectedValueOnce(new Error('template temporarily unavailable'));
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('a contact edit cannot slip between the replay recheck and the dispatch claim', async () => {
    const queued = await heldSummary();
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function editDuringClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        raced = true;
        // The customer row is held by the claim transaction: an edit that
        // would swap the authorized number waits instead of interleaving.
        await expect(mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '+12025550125' });
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return execute.call(this, connection, query);
    });
    expect(await deferredHandoff(queued.metadata)).toMatchObject({ ok: true });
    expect(raced).toBe(true);
  });

  test('the summary SMS keeps its own message type so no push-routing layer converts the bearer link', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({ channel: 'sms', purpose: 'service_completion',
      metadata: { original_message_type: 'visit_summary' } });
    const { APP_FIRST_TYPES } = require('../services/messaging/push-channel-routing');
    expect(APP_FIRST_TYPES.has('visit_summary')).toBe(false);
  });

  test('a claim read failure on the immediate SMS keeps the request retryable', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    jest.spyOn(VisitGroups, 'beginVisitNotificationDispatch').mockRejectedValueOnce(new Error('Synthetic claim read outage'));
    // The provider wrapper converts a handoff that throws before dispatch
    // into a retryable SMS_HANDOFF_CHECK_FAILED block.
    let providerCalls = 0;
    sendCustomerMessage.mockImplementation(handoffSender(async () => { providerCalls += 1; return { sent: true }; }));
    expect(await deliver()).toEqual({ state: 'delivery_pending' });
    expect(providerCalls).toBe(0);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'failed' });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(2);
  });

  test('a packet that retained terminal members still publishes its one recorded service', async () => {
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId, scheduled_service_id: fixture.serviceIds[1] }).del();
    await mockPg('service_records').where({ id: fixture.recordIds[1] }).del();
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ status: 'cancelled' });
    const summary = await Summary.getVisitCompletionSummary(fixture.token);
    expect(summary.services.map((service) => service.id)).toEqual([fixture.recordIds[0]]);
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test.each(['sms', 'email'])('an immediate %s recipient edited after resolution is refused at the dispatch claim', async (channel) => {
    fixture.payload.items[0].body.sendCompletionSms = channel === 'sms';
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const execute = mockPg.client.constructor.prototype._query;
    let edited = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function editBeforeClaim(connection, query) {
      // Inside the claim transaction the customer row is held, so the edit
      // is applied through the same connection's snapshot boundary: it waits
      // for the lock, which is exactly the fence — prove it by timing out.
      if (!edited && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        edited = true;
        await expect(mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('customers').where({ id: fixture.customerId })
            .update(channel === 'sms' ? { service_contact_phone: '+12025550125' } : { service_contact_email: 'moved@example.invalid' });
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return execute.call(this, connection, query);
    });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(edited).toBe(true);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: `completion_${channel}` }).first())
      .toMatchObject({ status: 'sent' });
  });

  test('a bounce that lands before the library returns keeps the aggregate out of delivered', async () => {
    sendOne.mockImplementationOnce(async ({ customArgs }) => {
      // The fast webhook: the row is terminal before sendTemplate returns sent.
      await mockPg('email_messages').where({ id: customArgs.email_message_id })
        .update({ status: 'bounced', bounced_at: new Date(), error_message: 'mailbox unavailable' });
      return { messageId: randomUUID() };
    });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
  });

  test('an archived summary template suppresses the email leg instead of retrying it forever', async () => {
    await mockPg('email_templates').where({ template_key: 'service.visit_summary' }).update({ status: 'archived' });
    try {
      expect(await deliver()).toEqual({ state: 'delivered' });
    } finally {
      await mockPg('email_templates').where({ template_key: 'service.visit_summary' }).update({ status: 'active' });
    }
    expect(sendOne).not.toHaveBeenCalled();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test.each(['email_enabled', 'service_completed'])('a customer who turned off %s receives no summary email', async (toggle) => {
    await mockPg('notification_prefs').insert({ customer_id: fixture.customerId, [toggle]: false });
    try {
      expect(await deliver()).toEqual({ state: 'delivered' });
    } finally {
      await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    }
    expect(sendOne).not.toHaveBeenCalled();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test('an email opt-out that lands after recipient resolution is refused at the dispatch claim', async () => {
    const execute = mockPg.client.constructor.prototype._query;
    let optedOut = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function optOutBeforeClaim(connection, query) {
      if (!optedOut && query.sql.includes('from "customers"') && query.sql.includes('for share')) {
        optedOut = true;
        await mockPg('notification_prefs').insert({ customer_id: fixture.customerId, email_enabled: false });
      }
      return execute.call(this, connection, query);
    });
    try {
      // Refused at the claim: the leg retries, and the retry re-resolves the
      // recipients with the opt-out in place.
      expect(await deliver()).toEqual({ state: 'delivery_pending' });
      expect(optedOut).toBe(true);
      expect(await deliver()).toEqual({ state: 'delivered' });
    } finally {
      await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    }
    expect(sendOne).not.toHaveBeenCalled();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test.each([
    ['a provider refusal (429) after the immediate SMS handoff is ambiguous and stays on office review', 429],
    ['a provider 5xx after the immediate SMS handoff is ambiguous and stays on office review', 503],
    ['an ambiguous provider timeout on the immediate SMS stays on office review', undefined],
  ])('%s', async (_label, providerHttpStatus) => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    sendCustomerMessage.mockImplementationOnce(handoffSender(async () => { throw providerFailure(providerHttpStatus); }));
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    // The recovery sweep never re-sends a text the provider may hold.
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a sender refusal inside the locked handoff leaves no dispatch mark behind', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    // The canonical sender's own rechecks (consent, suppression) run on the
    // held rows and refuse before any provider request.
    sendCustomerMessage.mockImplementationOnce(async ({ withSmsHandoff }) => {
      const verdict = await withSmsHandoff(async () => ({ ok: false, code: 'SMS_OPTED_OUT' }));
      expect(verdict).toEqual({ ok: false, code: 'SMS_OPTED_OUT' });
      return { sent: false, blocked: true, code: verdict.code };
    });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed', last_error: null });
  });

  test('the dispatch mark is durable before the provider request and survives a lost process', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let markDuringRequest;
    sendCustomerMessage.mockImplementationOnce(async ({ withSmsHandoff }) => {
      await withSmsHandoff(async (_trx, onProviderStart) => {
        // Read on another connection while the handoff transaction is open.
        markDuringRequest = await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first('status');
        await onProviderStart();
        throw Object.assign(new Error('process lost mid-request'), { providerHttpStatus: undefined });
      });
    });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(markDuringRequest).toMatchObject({ status: 'unknown_delivery' });
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).update({ claimed_at: new Date(0) });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test.each(['immediate', 'scheduled'])('a read failure between the durable mark and the %s provider request restores the claim', async (rail) => {
    const queued = rail === 'scheduled' ? await heldSummary() : null;
    if (rail === 'immediate') {
      fixture.payload.items[0].body.sendCompletionSms = true;
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    }
    // The second held transaction's first lock read fails, after the mark committed.
    const execute = mockPg.client.constructor.prototype._query;
    let locks = 0;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failSecondLock(connection, query) {
      if (!interrupted && query.sql.includes('from "customers"') && query.sql.includes('for share') && query.sql.includes('"id"')) {
        locks += 1;
        if (locks === 2) { interrupted = true; return Promise.reject(new Error('Synthetic re-authorization outage')); }
      }
      return execute.call(this, connection, query);
    });
    let providerCalls = 0;
    if (rail === 'scheduled') {
      await expect(deferredHandoff(queued.metadata, async () => { providerCalls += 1; return { ok: true }; })).rejects.toThrow('Synthetic re-authorization outage');
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'pending' });
      jest.restoreAllMocks();
      expect(await deferredHandoff(queued.metadata, async () => { providerCalls += 1; return { ok: true }; })).toMatchObject({ ok: true });
    } else {
      sendCustomerMessage.mockImplementation(handoffSender(async () => { providerCalls += 1; return { sent: true }; }));
      expect(await deliver()).toEqual({ state: 'delivery_pending' });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'failed' });
      jest.restoreAllMocks();
      sendCustomerMessage.mockImplementation(handoffSender(async () => { providerCalls += 1; return { sent: true }; }));
      expect(await deliver()).toEqual({ state: 'delivered' });
    }
    expect(interrupted).toBe(true);
    expect(providerCalls).toBe(1);
  });

  test('a link revoked between the durable mark and the provider request is refused at the held re-authorization', async () => {
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const execute = mockPg.client.constructor.prototype._query;
    let locks = 0;
    let revoked = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function revokeAfterMark(connection, query) {
      if (!revoked && query.sql.includes('from "customers"') && query.sql.includes('for share') && query.sql.includes('"id"')) {
        locks += 1;
        if (locks === 2) {
          revoked = true;
          await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
        }
      }
      return execute.call(this, connection, query);
    });
    let providerCalls = 0;
    sendCustomerMessage.mockImplementation(handoffSender(async () => { providerCalls += 1; return { sent: true }; }));
    await deliver();
    expect(revoked).toBe(true);
    expect(providerCalls).toBe(0);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test('an unreadable account primary fails delivery for retry instead of settling as no recipient', async () => {
    const primaryId = randomUUID();
    const accountId = randomUUID();
    await mockPg('customer_accounts').insert({ id: accountId, first_name: 'Primary' });
    await mockPg('customers').insert({ id: primaryId, first_name: 'Primary', phone: '+12025550199',
      email: `${primaryId}@example.invalid`, account_id: accountId, is_primary_profile: true });
    await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: accountId, is_primary_profile: false });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failPrimaryRead(connection, query) {
      if (!interrupted && query.sql.includes('"is_primary_profile" = ')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic account primary outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      await expect(deliver()).rejects.toThrow('Synthetic account primary outage');
      expect(interrupted).toBe(true);
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId })).toHaveLength(0);
      jest.restoreAllMocks();
      expect(await deliver()).toEqual({ state: 'delivered' });
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: null });
      await mockPg('customers').where({ id: primaryId }).del();
      await mockPg('customer_accounts').where({ id: accountId }).del();
    }
  });

  test.each(['sms', 'email', 'retry'])('a revocation during the %s provider request waits for the handoff to commit', async (rail) => {
    fixture.payload.items[0].body.sendCompletionSms = rail === 'sms';
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let blockedCode = null;
    const revokeDuringRequest = async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
      }).catch((err) => { blockedCode = err.code; });
    };
    if (rail === 'sms') {
      sendCustomerMessage.mockImplementation(handoffSender(async () => { await revokeDuringRequest(); return { sent: true }; }));
      expect(await deliver()).toEqual({ state: 'delivered' });
    } else if (rail === 'email') {
      sendOne.mockImplementation(async () => { await revokeDuringRequest(); return { messageId: randomUUID() }; });
      expect(await deliver()).toEqual({ state: 'delivered' });
    } else {
      const stored = { template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
        recipient_email_snapshot: fixture.serviceEmail };
      expect(await Summary.retrySummaryThroughHandoff(stored, revokeDuringRequest)).toEqual({ ok: true });
    }
    expect(blockedCode).toBe('55P03');
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ summary_token_revoked_at: null });
  });

  test('an email suppression added after queuing is rechecked at the held handoff', async () => {
    const execute = mockPg.client.constructor.prototype._query;
    let locks = 0;
    let suppressed = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function suppressAfterMark(connection, query) {
      if (!suppressed && query.sql.includes('from "customers"') && query.sql.includes('for share') && query.sql.includes('"id"')) {
        locks += 1;
        if (locks === 2) {
          suppressed = true;
          await mockPg('email_suppressions').insert({ email: fixture.serviceEmail, status: 'active', suppression_type: 'do_not_email' });
        }
      }
      return execute.call(this, connection, query);
    });
    try {
      // The suppressed recipient is refused at the handoff; the other recipient still sends.
      expect(await deliver()).toEqual({ state: 'delivery_pending' });
      expect(suppressed).toBe(true);
      expect(sendOne.mock.calls.map((call) => call[0].to)).not.toContain(fixture.serviceEmail);
      jest.restoreAllMocks();
      sendOne.mockImplementation(async () => ({ messageId: randomUUID() }));
      expect(await deliver()).toEqual({ state: 'delivered' });
      expect(sendOne.mock.calls.map((call) => call[0].to)).not.toContain(fixture.serviceEmail);
    } finally {
      await mockPg('email_suppressions').where({ email: fixture.serviceEmail }).del();
    }
  });

  test('a suppressed retry settles a summary whose ledger has no remaining provider work', async () => {
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    await priorEmail(fixture.primaryEmail, { status: 'sent', provider_message_id: 'fixture-provider-id', sent_at: new Date() });
    await priorEmail(fixture.serviceEmail, { status: 'blocked', error_message: 'Suppressed before retry: visit_summary_recipient_changed' });
    const blocked = await mockPg('email_messages').where({ idempotency_key: emailKey(fixture.serviceEmail) }).first();
    expect(await Summary.reconcileSummaryEmailRecovery(blocked)).toEqual({ reconciled: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' })
      .update({ status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    await mockPg('email_messages').where({ idempotency_key: emailKey(fixture.primaryEmail) }).update({ status: 'blocked', sent_at: null, provider_message_id: null });
    expect(await Summary.reconcileSummaryEmailRecovery(blocked)).toEqual({ reconciled: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'suppressed', last_error: null });
  });

  test('a queued replay whose account-primary read fails stays retryable instead of discarding the summary', async () => {
    const primaryId = randomUUID();
    const accountId = randomUUID();
    await mockPg('customer_accounts').insert({ id: accountId, first_name: 'Primary' });
    await mockPg('customers').insert({ id: primaryId, first_name: 'Primary', phone: '+12025550124',
      email: `${primaryId}@example.invalid`, account_id: accountId, is_primary_profile: true });
    const queued = await heldSummary();
    await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: accountId, is_primary_profile: false,
      phone: '', service_contact_phone: null, service_contacts_consent_at: null });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failPrimaryRead(connection, query) {
      if (!interrupted && query.sql.includes('"is_primary_profile" = ')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic account primary outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      const replay = require('../services/messaging/deferred-replay-registry');
      const verdict = await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata);
      expect(interrupted).toBe(true);
      expect(verdict.reason).not.toBe('visit_summary_recipient_changed');
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'pending' });
      jest.restoreAllMocks();
      expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: true });
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: null });
      await mockPg('customers').where({ id: primaryId }).del();
      await mockPg('customer_accounts').where({ id: accountId }).del();
    }
  });

  test('a corrected-address recovery judges suppression on its destination, not the bounced original', async () => {
    const stored = { template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_email_snapshot: fixture.serviceEmail };
    await mockPg('email_suppressions').insert({ email: fixture.serviceEmail, status: 'active', suppression_type: 'bounce' });
    try {
      let dispatched = 0;
      expect(await Summary.retrySummaryThroughHandoff(stored, async () => { dispatched += 1; }, { destination: 'corrected@example.invalid' }))
        .toEqual({ ok: true });
      expect(dispatched).toBe(1);
      // The same-address retry rail is still refused by the bounce suppression.
      expect(await Summary.retrySummaryThroughHandoff(stored, async () => { dispatched += 1; }))
        .toEqual({ ok: false, reason: 'visit_summary_recipient_suppressed' });
      expect(dispatched).toBe(1);
    } finally {
      await mockPg('email_suppressions').where({ email: fixture.serviceEmail }).del();
    }
  });

  test.each(['immediate', 'scheduled'])('a sender recheck failure inside the %s handoff, before the provider request, restores the claim', async (rail) => {
    const queued = rail === 'scheduled' ? await heldSummary() : null;
    if (rail === 'immediate') {
      fixture.payload.items[0].body.sendCompletionSms = true;
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    }
    let providerCalls = 0;
    // The canonical sender's consent recheck throws on the held connection before onProviderStart.
    const failingRecheck = async () => { throw new Error('consent recheck outage'); };
    if (rail === 'scheduled') {
      await expect(deferredHandoff(queued.metadata, failingRecheck)).rejects.toThrow('consent recheck outage');
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'pending' });
      expect(await deferredHandoff(queued.metadata, async (_trx, onProviderStart) => { await onProviderStart(); providerCalls += 1; return { ok: true }; })).toMatchObject({ ok: true });
    } else {
      sendCustomerMessage.mockImplementationOnce(async ({ withSmsHandoff }) => {
        try { await withSmsHandoff(failingRecheck); } catch (err) { return { sent: false, blocked: true, code: 'SMS_HANDOFF_CHECK_FAILED', retryable: true, reason: err.message }; }
        return { sent: true };
      });
      expect(await deliver()).toEqual({ state: 'delivery_pending' });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first()).toMatchObject({ status: 'failed' });
      sendCustomerMessage.mockImplementation(handoffSender(async () => { providerCalls += 1; return { sent: true }; }));
      expect(await deliver()).toEqual({ state: 'delivered' });
    }
    expect(providerCalls).toBe(1);
  });

  test.each(['immediate', 'scheduled'])('a STOP suppression write during the %s SMS provider request waits on the per-phone consent lock', async (rail) => {
    const queued = rail === 'scheduled' ? await heldSummary() : null;
    if (rail === 'immediate') {
      fixture.payload.items[0].body.sendCompletionSms = true;
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    }
    let blockedCode = null;
    const stopDuringRequest = async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await require('../utils/customer-comms-lock').lockSmsPhone(trx, '+12025550124');
      }).catch((err) => { blockedCode = err.code; });
      return { ok: true };
    };
    if (rail === 'scheduled') {
      expect(await deferredHandoff(queued.metadata, async (_trx, onProviderStart) => { await onProviderStart(); return stopDuringRequest(); })).toMatchObject({ ok: true });
    } else {
      sendCustomerMessage.mockImplementation(handoffSender(async () => { await stopDuringRequest(); return { sent: true }; }));
      expect(await deliver()).toEqual({ state: 'delivered' });
    }
    expect(blockedCode).toBe('55P03');
  });

  test.each(['immediate', 'retry'])('an email suppression or address write during the %s provider request waits on the per-address lock', async (rail) => {
    let blockedCode = null;
    const writeDuringRequest = async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await require('../utils/customer-comms-lock').lockCustomerEmail(trx, fixture.serviceEmail);
      }).catch((err) => { blockedCode = err.code; });
    };
    if (rail === 'immediate') {
      sendOne.mockImplementation(async ({ to }) => { if (to === fixture.serviceEmail) await writeDuringRequest(); return { messageId: randomUUID() }; });
      expect(await deliver()).toEqual({ state: 'delivered' });
    } else {
      const stored = { template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
        recipient_email_snapshot: fixture.serviceEmail };
      expect(await Summary.retrySummaryThroughHandoff(stored, writeDuringRequest)).toEqual({ ok: true });
    }
    expect(blockedCode).toBe('55P03');
  });

  test('the email retry rail holds the recipient rows through its provider request', async () => {
    const stored = { template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_email_snapshot: fixture.serviceEmail };
    let blockedCode = null;
    let dispatched = 0;
    expect(await Summary.retrySummaryThroughHandoff(stored, async () => {
      dispatched += 1;
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('customers').where({ id: fixture.customerId }).update({ service_contact_email: 'moved@example.invalid' });
      }).catch((err) => { blockedCode = err.code; });
    })).toEqual({ ok: true });
    expect(dispatched).toBe(1);
    expect(blockedCode).toBe('55P03');
    await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_email: 'moved@example.invalid' });
    expect(await Summary.retrySummaryThroughHandoff(stored, async () => { dispatched += 1; }))
      .toEqual({ ok: false, reason: 'visit_summary_recipient_changed' });
    expect(dispatched).toBe(1);
  });

  test('an account-primary contact edit during the provider request waits for the handoff to commit', async () => {
    // A secondary profile with blank contact fields resolves its SMS
    // recipient from the account primary; that row is held too.
    const primaryId = randomUUID();
    const accountId = randomUUID();
    await mockPg('customer_accounts').insert({ id: accountId, first_name: 'Primary' });
    await mockPg('customers').insert({ id: primaryId, first_name: 'Primary', phone: '+12025550199',
      email: `${primaryId}@example.invalid`, account_id: accountId, is_primary_profile: true });
    await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: accountId, is_primary_profile: false,
      phone: '', service_contact_phone: null, service_contacts_consent_at: null });
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let blockedCode = null;
    sendCustomerMessage.mockImplementation(handoffSender(async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('customers').where({ id: primaryId }).update({ phone: '+12025550198' });
      }).catch((err) => { blockedCode = err.code; });
      return { sent: true };
    }));
    try {
      expect(await deliver()).toEqual({ state: 'delivered' });
      expect(sendCustomerMessage.mock.calls[0][0].to).toBe('+12025550199');
      expect(blockedCode).toBe('55P03');
      expect(await mockPg('customers').where({ id: primaryId }).first()).toMatchObject({ phone: '+12025550199' });
    } finally {
      await mockPg('customers').where({ id: primaryId }).del();
      await mockPg('customers').where({ id: fixture.customerId }).update({ account_id: null });
      await mockPg('customer_accounts').where({ id: accountId }).del();
    }
  });

  test.each(['sms', 'email'])('a contact edit during the %s provider request waits for the handoff to commit', async (channel) => {
    fixture.payload.items[0].body.sendCompletionSms = channel === 'sms';
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    let blockedCode = null;
    const editDuringProviderRequest = async () => {
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await trx('customers').where({ id: fixture.customerId })
          .update(channel === 'sms' ? { service_contact_phone: '+12025550125' } : { service_contact_email: 'moved@example.invalid' });
      }).catch((err) => { blockedCode = err.code; });
    };
    if (channel === 'sms') {
      sendCustomerMessage.mockImplementation(handoffSender(async () => { await editDuringProviderRequest(); return { sent: true }; }));
    } else {
      sendOne.mockImplementation(async () => { await editDuringProviderRequest(); return { messageId: randomUUID() }; });
    }
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(blockedCode).toBe('55P03');
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: `completion_${channel}` }).first())
      .toMatchObject({ status: 'sent' });
    // The held rows were released only after the accepted handoff committed.
    expect(await mockPg('customers').where({ id: fixture.customerId }).first())
      .toMatchObject(channel === 'sms' ? { service_contact_phone: '+12025550124' } : { service_contact_email: fixture.serviceEmail });
  });

  test.each([
    ['sms', 'sms_enabled'], ['sms', 'service_completed'],
    ['email', 'email_enabled'], ['email', 'service_completed'],
  ])('a missing preference row serializes an immediate %s %s opt-out with dispatch', async (channel, toggle) => {
    expect(await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).first()).toBeUndefined();
    if (channel === 'sms') {
      fixture.payload.items[0].body.sendCompletionSms = true;
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    }
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    let optOutCode = null;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function optOutDuringClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        raced = true;
        // STOP and the preference route may create a missing row. Even an
        // upsert must wait until the authorized provider handoff commits.
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('notification_prefs').insert({ customer_id: fixture.customerId, [toggle]: false,
            seasonal_tips: null, marketing_offers: null }).onConflict('customer_id').merge({ [toggle]: false });
        }).catch((err) => { optOutCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(raced).toBe(true);
    expect(optOutCode).toBe('55P03');
    expect(await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).first())
      .toMatchObject({ seasonal_tips: null, marketing_offers: null });
    if (channel === 'sms') expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    else expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test.each(['sms_enabled', 'service_completed'])('a missing preference row serializes a deferred %s opt-out with dispatch', async (toggle) => {
    const queued = await heldSummary();
    await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    let optOutCode = null;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function optOutDuringDeferredClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        raced = true;
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('notification_prefs').insert({ customer_id: fixture.customerId, [toggle]: false,
            seasonal_tips: null, marketing_offers: null }).onConflict('customer_id').merge({ [toggle]: false });
        }).catch((err) => { optOutCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    expect(await Summary.beginDeferredSummarySms(queued.metadata, async () => ({ ok: true }))).toEqual({ ok: true });
    expect(raced).toBe(true);
    expect(optOutCode).toBe('55P03');
    expect(await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).first())
      .toMatchObject({ seasonal_tips: null, marketing_offers: null });
  });

  test.each(['cancelled', 'rescheduled'])('delivery belongs to the recorded member when the first child is %s history', async (status) => {
    const retainedId = fixture.serviceIds[0];
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId, scheduled_service_id: retainedId }).del();
    await mockPg('scheduled_services').where({ id: retainedId }).update({ status, technician_id: null });
    fixture.payload.items = fixture.payload.items.filter((item) => item.serviceId !== retainedId);
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    expect(await deliver()).toEqual({ state: 'delivered' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId }).orderBy('effect_type'))
      .toMatchObject([{ effect_type: 'completion_email', status: 'sent' }, { effect_type: 'completion_sms', status: 'sent' }]);
  });

  test('a preference edit cannot slip between the recipient recheck and the dispatch claim', async () => {
    await mockPg('notification_prefs').insert({ customer_id: fixture.customerId, email_enabled: true });
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function editPrefsDuringClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        raced = true;
        await expect(mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('notification_prefs').where({ customer_id: fixture.customerId }).update({ email_enabled: false });
        })).rejects.toMatchObject({ code: '55P03' });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await deliver()).toEqual({ state: 'delivered' });
    } finally {
      await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    }
    expect(raced).toBe(true);
    expect(sendOne).toHaveBeenCalledTimes(2);
  });


  test('an internal-only packet closes without minting a summary link or needing the key', async () => {
    await mockPg('service_records').whereIn('id', fixture.recordIds)
      .update({ structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'internal_only' }) });
    await mockPg('service_visits').where({ id: fixture.visitId })
      .update({ summary_token_hash: null, summary_token_enc: null, summary_token_issued_at: null });
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    const key = process.env.DATA_HYGIENE_VAULT_KEY;
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({
        status: 200, body: { state: 'done', delivery: { state: 'delivered' }, summaryUrl: null },
      });
    } finally {
      process.env.DATA_HYGIENE_VAULT_KEY = key;
    }
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first())
      .toMatchObject({ status: 'closed', summary_token_hash: null, summary_token_issued_at: null });
    expect((await mockPg('visit_effects').where({ visit_id: fixture.visitId }).whereIn('effect_type', ['completion_sms', 'completion_email']))
      .map((effect) => effect.status)).toEqual(['suppressed', 'suppressed']);
    expect(sendOne).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a bounce on either summary recipient reopens delivery for office review, once', async () => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    expect(messages).toHaveLength(2);
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    const bounce = (message) => handleEmailMessageEvent({ event: 'bounce', reason: 'mailbox unavailable',
      timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, message);
    await bounce(messages[0]);
    // The other recipient's accepted send cannot hide this bounce.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    await bounce(messages[1]);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    const { getCloseoutStatus } = require('../services/closeout-status');
    expect((await getCloseoutStatus(fixture.serviceIds[0])).facts.reportDelivery).toMatchObject({ state: 'unknown' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' })).toHaveLength(1);
    // A redelivered bounce cannot raise a second alert.
    await bounce({ ...messages[1], bounced_at: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' })).toHaveLength(1);
  });

  test('a provider block stays with the retry rail; only an exhausted recipient reopens the summary, and a later delivery to the other cannot settle it', async () => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    expect(messages).toHaveLength(2);
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    for (const message of messages) {
      // A provider block (not a bad mailbox): the webhook schedules the
      // existing transactional retry instead of suppressing the address.
      await handleEmailMessageEvent({ event: 'blocked', reason: '550 temporarily deferred', type: 'blocked',
        timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, message);
    }
    // Both recipients are on the rail: the summary still reads delivered and
    // nothing asks the office yet.
    expect((await mockPg('email_messages').whereIn('id', messages.map((m) => m.id)).orderBy('id')).map((m) => m.status)).toEqual(['failed', 'failed']);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    const { MAX_RETRIES, runDueRetries } = require('../services/transactional-email-provider-retry');
    const { clearBlockedAddress } = require('../services/sendgrid-mail');
    // The second recipient's final attempt cannot clear the provider block:
    // the rail exhausts it, and that terminal failure reopens the summary.
    await mockPg('email_messages').where({ id: messages[1].id })
      .update({ provider_retry_count: MAX_RETRIES - 1, provider_retry_next_at: new Date(Date.now() - 1000) });
    await mockPg('email_messages').where({ id: messages[0].id }).update({ provider_retry_next_at: null });
    sendOne.mockClear();
    clearBlockedAddress.mockRejectedValueOnce(new Error('SendGrid blocks endpoint unavailable'));
    expect(await runDueRetries()).toMatchObject({ claimed: 1, sent: 0 });
    expect(sendOne).not.toHaveBeenCalled();
    const exhausted = await mockPg('email_messages').where({ id: messages[1].id }).first();
    expect(exhausted).toMatchObject({ status: 'failed', provider_retry_count: MAX_RETRIES, provider_retry_next_at: null });
    expect(exhausted.provider_retry_exhausted_at).not.toBeNull();
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    const { getCloseoutStatus } = require('../services/closeout-status');
    expect((await getCloseoutStatus(fixture.serviceIds[0])).facts.reportDelivery).toMatchObject({ state: 'unknown' });
    // The rail resends the other recipient and the provider accepts it. The
    // inline reconciliation after the resend fails transiently: the message
    // is sent and off the rail, so the delivery webhook is the durable retry.
    await mockPg('email_messages').where({ id: messages[0].id }).update({ provider_retry_next_at: new Date(Date.now() - 1000) });
    jest.spyOn(Summary, 'reconcileSummaryEmailRecovery').mockRejectedValueOnce(new Error('Synthetic reconcile outage'));
    expect(await runDueRetries()).toMatchObject({ claimed: 1, sent: 1 });
    expect(require('../services/logger').warn.mock.calls.filter(([m]) => /summary recovery/.test(m))).toHaveLength(1);
    const resent = await mockPg('email_messages').where({ id: messages[0].id }).first();
    expect(resent).toMatchObject({ status: 'sent' });
    await handleEmailMessageEvent({ event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, resent);
    // One recipient's delivery cannot settle the exhausted one: the leg stays
    // with the office and the closeout still reads uncertain.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    expect((await getCloseoutStatus(fixture.serviceIds[0])).facts.reportDelivery).toMatchObject({ state: 'unknown' });
  });

  test.each([
    ['opt_out', async () => mockPg('notification_prefs').insert({ customer_id: fixture.customerId, email_enabled: false }).onConflict('customer_id').merge({ email_enabled: false })],
    ['revocation', async () => mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() })],
    ['contact', async () => mockPg('customers').where({ id: fixture.customerId })
      .update({ email: 'replaced@example.invalid', service_contact_email: 'replaced-service@example.invalid' })],
  ])('the provider-retry rail re-authorizes a blocked summary recipient before resending (%s)', async (change, apply) => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    for (const message of messages) {
      await handleEmailMessageEvent({ event: 'blocked', reason: '550 temporarily deferred', type: 'blocked',
        timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, message);
    }
    // A retryable block leaves the delivered summary with the rail.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    await mockPg('email_messages').where({ id: messages[0].id }).update({ provider_retry_next_at: new Date(Date.now() - 1000) });
    await mockPg('email_messages').where({ id: messages[1].id }).update({ provider_retry_next_at: null });
    sendOne.mockClear();
    await apply();
    try {
      expect(await require('../services/transactional-email-provider-retry').runDueRetries()).toMatchObject({ claimed: 1, sent: 0 });
    } finally {
      await mockPg('notification_prefs').where({ customer_id: fixture.customerId }).del();
    }
    expect(sendOne).not.toHaveBeenCalled();
    expect(await mockPg('email_messages').where({ id: messages[0].id }).first())
      .toMatchObject({ status: 'blocked', error_message: expect.stringMatching(/^Suppressed before retry: visit_summary_/) });
    // A refused retry is a suppression, not a failed delivery: the summary
    // was never reopened, so nothing changes and the office is not asked.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
  });

  test('a recovery delivery keeps the coordinator alert while the SMS leg is still uncertain', async () => {
    await priorClaim('completion_sms', { status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    sendOne.mockImplementation(async ({ customArgs }) => {
      await mockPg('email_messages').where({ id: customArgs.email_message_id })
        .update({ status: 'bounced', bounced_at: new Date(), error_message: 'mailbox unavailable' });
      return { messageId: randomUUID() };
    });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    const [original] = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    const [recovery] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: 'corrected@example.invalid',
      idempotency_key: `bounce_recovery:${original.id}`, status: 'sent', sent_at: new Date(), provider_message_id: randomUUID(),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com',
      categories: JSON.stringify(['email_template', 'bounce_recovery']),
    }).returning('*');
    await mockPg('email_bounce_recoveries').insert({ original_message_id: original.id,
      recovery_message_id: recovery.id, bounced_email: original.recipient_email_snapshot,
      corrected_email: recovery.recipient_email_snapshot, customer_id: fixture.customerId, status: 'resent' });
    await mockPg('email_messages').where({ recipient_id: fixture.customerId }).whereNotIn('id', [original.id, recovery.id])
      .update({ status: 'delivered' });
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    await handleEmailMessageEvent({ event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, recovery);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    // The email leg settled, but the SMS leg is terminal-uncertain: the office still owns this visit.
    const open = await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at');
    expect(open).toHaveLength(1);
    expect(open[0].payload).toMatchObject({ delivery: 'delivery_review' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' })).toHaveLength(1);
  });

  test.each([
    ['backfill members mint the card silently and earn no referral', { backfill: true }, { card: { suppressIssuedEmail: true }, referral: false }],
    ['an internal-only report posture keeps both the card and the referral', { typedReportDelivery: 'internal_only' }, { card: { suppressIssuedEmail: false }, referral: true }],
    ['an internal-only consultation mints no card but keeps the referral', { internalOnlyCompletion: true, typedReportDelivery: 'disabled' }, { card: null, referral: true }],
  ])('%s', async (_label, notes, expected) => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ is_recurring: true });
    await mockPg('service_records').whereIn('id', fixture.recordIds)
      .update({ structured_notes: JSON.stringify({ visitOutcome: 'completed', ...notes }) });
    const card = require('../services/customer-card').ensureCardForCompletion.mockClear();
    const referral = require('../services/referral-engine').creditReferralOnFirstService.mockClear();
    expect((await runVisitCompletionPacketEffects(fixture.packetId)).status).toBe(200);
    if (expected.card) {
      expect(card).toHaveBeenCalledTimes(1);
      expect(card.mock.calls[0][0]).toMatchObject({ customerId: fixture.customerId, ...expected.card });
      if (notes.backfill) expect(card.mock.calls[0][0].firstVisitAt).toBeInstanceOf(Date);
    } else expect(card).not.toHaveBeenCalled();
    if (expected.referral) expect(referral).toHaveBeenCalledWith({ customerId: fixture.customerId, serviceId: fixture.serviceIds[0] });
    else expect(referral).not.toHaveBeenCalled();
  });

  test('a packet with one recorded member still enrolls its requested review', async () => {
    await settledDelivery();
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId, scheduled_service_id: fixture.serviceIds[1] }).del();
    await mockPg('service_records').where({ id: fixture.recordIds[0] })
      .update({ structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }) });
    const enroll = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: true });
    expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ serviceRecordId: fixture.recordIds[0] }));
  });

  test('a prerequisite read failure during paid-invoice review enrollment reopens the done packet', async () => {
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done' });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failVisitRead(connection, query) {
      if (!interrupted && query.sql.startsWith('select * from "service_visits"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic visit read outage'));
      }
      return execute.call(this, connection, query);
    });
    expect(await require('../services/review-request').enrollForPaidInvoice({ id: randomUUID(), visit_completion_packet_id: fixture.packetId }))
      .toMatchObject({ enrolled: false, retryable: true, reason: 'error' });
    expect(interrupted).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first())
      .toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
  });

  test('a corrected-address recovery delivery settles a hard-bounced summary', async () => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    // Only this recipient bounces; the other remains accepted.
    await handleEmailMessageEvent({ event: 'bounce', type: 'bounce', reason: 'mailbox unavailable',
      timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, messages[0]);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    // The bounce-recovery rail's resend keeps the trigger identity (unit-tested
    // in email-bounce-recovery) and the corrected address accepts it.
    const [recovery] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: 'corrected@example.invalid',
      idempotency_key: `bounce_recovery:${messages[0].id}`, status: 'sent', sent_at: new Date(), provider_message_id: randomUUID(),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com',
      categories: JSON.stringify(['email_template', 'bounce_recovery']),
    }).returning('*');
    await mockPg('email_bounce_recoveries').insert({ original_message_id: messages[0].id,
      recovery_message_id: recovery.id, bounced_email: messages[0].recipient_email_snapshot,
      corrected_email: recovery.recipient_email_snapshot, customer_id: fixture.customerId, status: 'resent' });
    await handleEmailMessageEvent({ event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, recovery);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
  });

  test('a paid invoice projection applies the whole packet review policy before representative-record enrollment', async () => {
    await settledDelivery();
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'paid', visit_completion_packet_id: fixture.packetId });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', requestReview: true, typedReportDelivery: 'auto_send' }),
    });
    await mockPg('service_records').where({ id: fixture.recordIds[1] }).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', requestReview: false, typedReportDelivery: 'auto_send' }),
    });
    const Review = require('../services/review-request');
    const enroll = jest.spyOn(Review, 'enrollPostService').mockResolvedValue({ started: true });
    try {
      const projection = { id: invoiceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0] };
      expect(await Review.enrollForPaidInvoice(projection)).toMatchObject({ enrolled: false, reason: 'visit_outcome' });
      expect(enroll).not.toHaveBeenCalled();
      await mockPg('service_records').where({ id: fixture.recordIds[1] }).update({
        structured_notes: JSON.stringify({ visitOutcome: 'completed', requestReview: true, typedReportDelivery: 'auto_send' }),
      });
      expect(await Review.enrollForPaidInvoice(projection)).toMatchObject({ enrolled: true });
      expect(enroll).toHaveBeenCalledWith(expect.objectContaining({ serviceRecordId: fixture.recordIds[0] }));
    } finally { await mockPg('invoices').where({ id: invoiceId }).del(); }
  });

  test.each(['cancelled', 'rescheduled'])('the coordinator collects through a recorded member beside %s history', async (status) => {
    const retainedId = fixture.serviceIds[0];
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId, scheduled_service_id: retainedId }).del();
    await mockPg('scheduled_services').where({ id: retainedId }).update({ status, technician_id: null });
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: {
        state: 'done', payment: { state: 'payment_needed', invoiceId }, delivery: { state: 'delivered' },
      } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled', total: '120.00' });
    } finally { await mockPg('invoices').where({ id: invoiceId }).del(); }
  });

  test('a coordinator replay after the invoice was scheduled closes again without re-entering collection under held member rows', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', payment: { state: 'payment_needed', invoiceId } } });
      const scheduled = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(scheduled).toMatchObject({ status: 'scheduled' });
      // The process died between scheduling the send and closing the packet:
      // the recovery sweep runs the coordinator again over the scheduled invoice.
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'processing', error: null });
      const Payment = require('../services/visit-completion-payment');
      const collect = jest.spyOn(Payment, 'collectVisitCompletionInvoice');
      try {
        expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', payment: { state: 'payment_needed', invoiceId } } });
        // One collection read up front; the ownership transaction decides the
        // rest itself instead of calling the collector on its held rows.
        expect(collect).toHaveBeenCalledTimes(1);
        expect(Boolean(collect.mock.calls[0][1]?.isTransaction)).toBe(false);
      } finally { collect.mockRestore(); }
      expect(await mockPg('invoices').where({ id: invoiceId }).first())
        .toMatchObject({ status: 'scheduled', scheduled_send_at: scheduled.scheduled_send_at, scheduled_send_error: null });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
    } finally { await mockPg('invoices').where({ id: invoiceId }).del(); }
  });

  test.each(['customer', 'member'])('a third-party payer assigned to the %s after the self-pay invoice was minted holds the visit instead of scheduling a homeowner pay link', async (target) => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    if (target === 'customer') await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    else await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: payer.id });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: {
        state: 'office_required', payment: { state: 'office_required', reason: 'payer_assigned', payerId: payer.id },
      } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true, close_reason: 'office_review' });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: null });
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a payer assigned between scheduling and delivery suppresses the homeowner send at delivery', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { payment: { state: 'payment_needed' } } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled' });
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
      expect(await require('../services/invoice').sendViaSMSAndEmail(invoiceId)).toMatchObject({ ok: false, code: 'payer_billed' });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_at: null });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(sendCustomerMessage.mock.calls.every((call) => call[0].purpose !== 'payment_link')).toBe(true);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('the SMS-only send path re-judges Bill-To ownership for a combined-visit invoice too', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    try {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
      expect(await require('../services/invoice').sendViaSMS(invoiceId)).toMatchObject({ sent: false, code: 'payer_billed' });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test.each(['excluded member', 'self-pay override'])('the live Bill-To check honors per-job precedence: %s', async (scenario) => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    fixture.payload.billingSnapshot = { billedServiceIds: [fixture.serviceIds[0]] };
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    if (scenario === 'excluded member') {
      // The unbilled member carries a per-job payer the invoice never consulted.
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ payer_id: payer.id });
    } else {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ self_pay_override: true });
    }
    try {
      expect(await require('../services/visit-completion-packets').liveThirdPartyPayerForPacket(fixture.packetId)).toBeNull();
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', payment: { state: 'payment_needed' } } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled' });
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ payer_id: null, self_pay_override: false });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('an unrelated uncertain tracker effect does not keep a recovered summary from reopening the review', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    await mockPg('visit_effects').insert({ visit_id: fixture.visitId, effect_type: 'tracker_en_route', dedupe_key: `${fixture.visitId}:tracker_en_route`,
      status: 'unknown_delivery', last_error: 'provider_outcome_unknown', claim_token: 'old-tracker', claimed_at: new Date(0) });
    sendOne.mockImplementationOnce(async () => { throw new Error('provider response unavailable'); });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    const uncertain = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}`, status: 'failed' }).first();
    await mockPg('email_messages').where({ id: uncertain.id }).update({ status: 'sent', sent_at: new Date(), provider_message_id: 'recovered', error_message: null });
    expect(await Summary.reconcileSummaryEmailRecovery({ ...uncertain, status: 'sent' })).toEqual({ reconciled: true });
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
  });

  test('a summary that bounces after the review was enrolled parks the outreach until the recovery settles it', async () => {
    cadenceGateOn();
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', delivery: { state: 'delivered' } } });
    expect(reviews).toHaveBeenCalledTimes(1);
    // The cadence enrolled a sequence and the legacy path a pending ask for the recorded record.
    await mockPg('review_sequences').insert({ id: randomUUID(), customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'active', plan: JSON.stringify({ touches: [] }) });
    await mockPg('review_requests').insert({ id: randomUUID(), customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'pending', token: randomUUID().replace(/-/g, '') });
    expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId, status: 'active' })).toHaveLength(1);
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'bounced' });
    await mockPg.transaction(async (trx) => {
      expect(await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx)).toEqual({ reconciled: true });
    });
    expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId, status: 'active' })).toHaveLength(0);
    expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId }).first()).toMatchObject({ status: 'stopped', stop_reason: 'visit_summary_bounced' });
    expect(await mockPg('review_requests').where({ customer_id: fixture.customerId, status: 'pending' })).toHaveLength(0);
    // The recovery settles the summary: the parked sequence resumes instead of a fresh enrollment.
    await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'sent', sent_at: new Date(), provider_message_id: 'recovered' });
    expect(await Summary.reconcileSummaryEmailRecovery({ ...delivered, status: 'sent' })).toEqual({ reconciled: true });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(reviews).toHaveBeenCalledTimes(1);
    expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId }).first()).toMatchObject({ status: 'active', stop_reason: null });
    await mockPg('review_sequences').where({ customer_id: fixture.customerId }).del();
    await mockPg('review_requests').where({ customer_id: fixture.customerId }).del();
  });

  test('a bounce that races the packet close parks the outreach and closes for office review', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    jest.spyOn(require('../services/review-request'), 'enrollPostService').mockImplementation(async ({ serviceRecordId }) => {
      await mockPg('review_sequences').insert({ id: randomUUID(), customer_id: fixture.customerId, service_record_id: serviceRecordId,
        status: 'active', plan: JSON.stringify({ touches: [] }) });
      return { started: true };
    });
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function bounceBeforeClose(connection, query) {
      if (!raced && query.sql.startsWith('select * from "visit_completion_packets"') && query.sql.includes('for update')) {
        raced = true;
        const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
        await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'bounced' });
        await mockPg.transaction(async (trx) => {
          expect(await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx)).toEqual({ reconciled: true });
        });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', delivery: { state: 'delivery_review' } } });
      expect(raced).toBe(true);
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done', error: expect.stringContaining('delivery_review') });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId }).first()).toMatchObject({ status: 'stopped', stop_reason: 'visit_summary_bounced' });
    } finally {
      await mockPg('review_sequences').where({ customer_id: fixture.customerId }).del();
    }
  });

  test('a payer assignment attempted during the fenced invoice claim waits for the claim to commit', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    const execute = mockPg.client.constructor.prototype._query;
    let blockedCode = null;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function assignDuringClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "invoices"') && query.bindings.includes('sending')) {
        raced = true;
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        }).catch((err) => { blockedCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    try {
      await require('../services/invoice').claimPacketInvoiceForSend(invoiceId, fixture.packetId);
      expect(raced).toBe(true);
      expect(blockedCode).toBe('55P03');
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sending' });
    } finally {
      jest.restoreAllMocks();
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a zero-due packet invoice stays settled after the packet claim reports nothing to deliver', async () => {
    const Invoice = require('../services/invoice');
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({
      id: invoiceId,
      token: randomUUID().replace(/-/g, ''),
      invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId,
      scheduled_service_id: fixture.serviceIds[0],
      visit_completion_packet_id: fixture.packetId,
      status: 'draft',
      total: 0,
      credit_applied: 0,
    });
    try {
      await expect(Invoice.claimPacketInvoiceForSend(invoiceId, fixture.packetId))
        .rejects.toMatchObject({ code: 'zero_due' });
      expect(await mockPg('invoices').where({ id: invoiceId }).first())
        .toMatchObject({ status: 'prepaid', prepaid_by: 'system:zero_balance' });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });


  test('a reschedule that lands between the worker\'s due read and its claim keeps the invoice queued for later', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'scheduled', total: 120, visit_completion_packet_id: fixture.packetId,
      scheduled_send_at: new Date(Date.now() - 60000) });
    const later = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const execute = mockPg.client.constructor.prototype._query;
    let rescheduled = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function rescheduleAfterDueRead(connection, query) {
      if (!rescheduled && query.sql.startsWith('select "visit_id", "payload" from "visit_completion_packets"')) {
        rescheduled = true;
        await mockPg('invoices').where({ id: invoiceId, status: 'scheduled' }).update({ scheduled_send_at: later, scheduled_send_attempts: 0 });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await require('../services/invoice').claimPacketInvoiceForSend(invoiceId, fixture.packetId, { requireDue: true }))
        .toMatchObject({ payerBilled: false, claim: null });
      expect(rescheduled).toBe(true);
      const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(invoice.status).toBe('scheduled');
      expect(new Date(invoice.scheduled_send_at).getTime()).toBe(later.getTime());
    } finally {
      jest.restoreAllMocks();
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('a payer deactivation that follows a withdrawal returns the invoice to its queue and lifts the hold', async () => {
    const Invoice = require('../services/invoice');
    const Payer = require('../services/payer');
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'scheduled', total: 120, visit_completion_packet_id: fixture.packetId,
      scheduled_send_at: new Date(Date.now() - 60000) });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    try {
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done', error: null });
      expect(await Invoice.claimPacketInvoiceForSend(invoiceId, fixture.packetId, { requireDue: true })).toMatchObject({ payerBilled: true, payerId: payer.id });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      // The late withdrawal is office review, like the coordinator's own payer finding: packet error + one alert.
      const closed = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first();
      expect(JSON.parse(closed.error)).toMatchObject({ payment: 'office_required', reason: 'payer_assigned' });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      expect(await Invoice.claimPacketInvoiceForSend(invoiceId, fixture.packetId)).toMatchObject({ payerBilled: true });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      // The deactivation that was waiting on the claim's payer lock lands next: ownership is self-pay again.
      expect(await Payer.updatePayer(payer.id, { active: false })).toMatchObject({ payer: { active: false } });
      const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(invoice).toMatchObject({ status: 'scheduled', scheduled_send_error: null, scheduled_send_attempts: 0 });
      expect(invoice.scheduled_send_at).not.toBeNull();
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done', error: null });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a payer the coordinator finds records the shared office-review state, which a Bill-To change lifts through the same reconciliation', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', payment: { state: 'office_required', reason: 'payer_assigned' } } });
      const closed = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first();
      expect(JSON.parse(closed.error)).toMatchObject({ payment: 'office_required', reason: 'payer_assigned', payerId: payer.id });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payer.id}:hold` });
      const alerts = await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at');
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload).toMatchObject({ reason: 'payer_assigned', payerId: payer.id });
      // The customer's payer link is cleared (the Customer-360 writer's transition): self-pay again.
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        expect(await require('../services/visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId })).toBe(1);
      });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done', error: null });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test.each(['sent', 'viewed', 'overdue'])('a payer found after the homeowner already holds the %s pay link records a withdrawal marker the Bill-To reconciliation can lift', async (status) => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status, total: 120, visit_completion_packet_id: fixture.packetId, sent_at: new Date() });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', payment: { state: 'office_required', reason: 'payer_assigned', payerId: payer.id } } });
      // The link cannot be recalled: the row keeps its state and only carries the marker.
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status, scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(JSON.parse((await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).error)).toMatchObject({ payment: 'office_required', reason: 'payer_assigned', payerId: payer.id });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        expect(await require('../services/visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId })).toBe(1);
      });
      // Released, never requeued: the homeowner already has the link.
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status, scheduled_send_error: null });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done', error: null });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
      expect(sendCustomerMessage.mock.calls.every((call) => call[0].purpose !== 'payment_link')).toBe(true);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawn draft that was voided in the meantime is never requeued', async () => {
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'void', total: 120, visit_completion_packet_id: fixture.packetId, scheduled_send_error: `payer_billed:${payer.id}` });
    try {
      await mockPg.transaction(async (trx) => {
        expect(await require('../services/visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { payerId: payer.id })).toBe(0);
      });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'void' });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawal stamp follows the payer that still owns the packet, and the last removal requeues', async () => {
    const invoiceId = randomUUID();
    const [payerA] = await mockPg('payers').insert({ display_name: 'Fixture Payer A', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    const [payerB] = await mockPg('payers').insert({ display_name: 'Fixture Payer B', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId, scheduled_send_error: `payer_billed:${payerA.id}` });
    // The customer default is payer B; the stamp names A (a job payer since removed).
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payerB.id });
    try {
      await mockPg.transaction(async (trx) => {
        expect(await require('../services/visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { payerId: payerA.id })).toBe(0);
      });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payerB.id}` });
      const Payer = require('../services/payer');
      expect(await Payer.updatePayer(payerB.id, { active: false })).toMatchObject({ payer: { active: false } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').whereIn('id', [payerA.id, payerB.id]).del();
    }
  });

  test('lifting the payer portion of an office review keeps an uncertain summary delivery on review', async () => {
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId, scheduled_send_error: `payer_billed:${payer.id}` });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done',
      error: JSON.stringify({ payment: 'office_required', delivery: 'delivery_review', reason: 'payer_assigned', payerId: payer.id }) });
    const member = await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first();
    await require('../services/dispatch-alerts').createAlert({ type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id,
      payload: { visitId: fixture.visitId, packetId: fixture.packetId, payment: 'office_required', delivery: 'delivery_review', reason: 'payer_assigned', payerId: payer.id } });
    try {
      await mockPg.transaction(async (trx) => {
        expect(await require('../services/visit-completion-packets').reconcileWithdrawnPacketInvoices(trx, { payerId: payer.id })).toBe(1);
      });
      const packet = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first();
      expect(JSON.parse(packet.error)).toEqual({ payment: 'payment_needed', delivery: 'delivery_review' });
      const kept = await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at');
      expect(kept).toHaveLength(1);
      // Rewritten to the delivery-only state the packet error holds, so the recovery can resolve it.
      expect(kept[0].payload).toMatchObject({ payment: 'payment_needed', delivery: 'delivery_review' });
      expect(kept[0].payload.reason).toBeUndefined();
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a draft voided before the coordinator schedules it closes for office review, not cleanly', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const execute = mockPg.client.constructor.prototype._query;
    let voided = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function voidBeforeScheduling(connection, query) {
      if (!voided && query.sql.startsWith('update "invoices"') && query.bindings.includes('scheduled')) {
        voided = true;
        await mockPg('invoices').where({ id: invoiceId, status: 'draft' }).update({ status: 'void' });
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', payment: { state: 'office_required' } } });
      expect(voided).toBe(true);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'void' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
    } finally {
      jest.restoreAllMocks();
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('payer writers see an in-flight combined-visit send for the customer and for a billed service', async () => {
    const { packetInvoiceSendInFlight } = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sending', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: false }).returning('id');
    try {
      expect(await packetInvoiceSendInFlight({ customerId: fixture.customerId })).toBe(true);
      expect(await packetInvoiceSendInFlight({ scheduledServiceId: fixture.serviceIds[0] })).toBe(true);
      expect(await packetInvoiceSendInFlight({ scheduledServiceId: randomUUID() })).toBe(false);
      // An automatic collection in flight (the coordinator's live visit_payment claim) is the same window.
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'draft' });
      expect(await packetInvoiceSendInFlight({ customerId: fixture.customerId })).toBe(false);
      await mockPg('visit_effects').insert({ visit_id: fixture.visitId, effect_type: 'visit_payment', dedupe_key: `${fixture.visitId}:visit_payment`,
        status: 'claimed', attempts: 0, claimed_at: new Date(), claim_token: randomUUID().replace(/-/g, '') });
      expect(await packetInvoiceSendInFlight({ customerId: fixture.customerId })).toBe(true);
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).del();
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sending' });
      // The activation writer sees the send through the customer default and through a billed member's per-job payer.
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
      expect(await packetInvoiceSendInFlight({ payerId: payer.id })).toBe(true);
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      expect(await packetInvoiceSendInFlight({ payerId: payer.id })).toBe(false);
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: payer.id });
      expect(await packetInvoiceSendInFlight({ payerId: payer.id })).toBe(true);
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent' });
      expect(await packetInvoiceSendInFlight({ customerId: fixture.customerId })).toBe(false);
      expect(await packetInvoiceSendInFlight({ payerId: payer.id })).toBe(false);
      // A bank debit already captured on the packet invoice is money moving:
      // settlement never re-resolves ownership, so a Bill-To transition taken
      // now would commit over the homeowner's funds (Codex r27 P1).
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'processing', stripe_payment_intent_id: 'pi_fixture_processing' });
      expect(await packetInvoiceSendInFlight({ customerId: fixture.customerId })).toBe(true);
      expect(await packetInvoiceSendInFlight({ payerId: payer.id })).toBe(true);
      // …and the fence reaches it through ANY billed member of the packet,
      // not only the member the invoice is anchored to.
      expect(await packetInvoiceSendInFlight({ scheduledServiceId: fixture.serviceIds[fixture.serviceIds.length - 1] })).toBe(true);
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent', stripe_payment_intent_id: null });
    } finally {
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a review SMS handoff shares the packet row so a bounce reconciliation waits for the send', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    let blockedCode = null;
    // The legacy ask this send belongs to, and one that has not reached a provider.
    const inFlightAsk = randomUUID();
    const idleAsk = randomUUID();
    await mockPg('review_requests').insert([
      { id: inFlightAsk, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', token: randomUUID().replace(/-/g, '') },
      { id: idleAsk, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', token: randomUUID().replace(/-/g, '') },
    ]);
    expect(await Summary.reviewSendThroughSummaryHandoff(fixture.recordIds[0], async () => {
      await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'bounced' });
      await mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '200ms'");
        await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx);
      }).catch((err) => { blockedCode = err.code; });
      return { ok: true };
    }, undefined, { requestId: inFlightAsk })).toEqual({ ok: true });
    expect(blockedCode).toBe('55P03');
    // Once the bounce lands, the ask whose handoff started is kept for its own sender's bookkeeping; the idle ask is parked away.
    await mockPg.transaction(async (trx) => { await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx); });
    expect(await mockPg('review_requests').where({ id: inFlightAsk }).first()).toMatchObject({ status: 'sending' });
    expect(await mockPg('review_requests').where({ id: idleAsk }).first()).toBeUndefined();
    await mockPg('review_requests').where({ customer_id: fixture.customerId }).del();
    // The next review handoff is refused.
    expect(await Summary.reviewSendThroughSummaryHandoff(fixture.recordIds[0], async () => ({ ok: true }))).toMatchObject({ ok: false, code: 'VISIT_SUMMARY_UNCERTAIN' });
    expect(await Summary.reviewSendThroughSummaryHandoff(randomUUID(), async () => ({ ok: true }))).toEqual({ ok: true });
  });

  test('recovery resumes one parked sequence per customer and retires the rest', async () => {
    cadenceGateOn();
    const first = randomUUID();
    const second = randomUUID();
    await mockPg('review_sequences').insert([
      { id: first, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'stopped', stop_reason: 'visit_summary_bounced',
        plan: JSON.stringify({ touches: [] }), updated_at: new Date(Date.now() - 60000) },
      { id: second, customer_id: fixture.customerId, service_record_id: fixture.recordIds[1], status: 'stopped', stop_reason: 'visit_summary_bounced',
        plan: JSON.stringify({ touches: [] }), updated_at: new Date() },
    ]);
    try {
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(1);
      expect(await mockPg('review_sequences').where({ id: second }).first()).toMatchObject({ status: 'active', stop_reason: null });
      expect(await mockPg('review_sequences').where({ id: first }).first()).toMatchObject({ status: 'stopped', stop_reason: 'summary_park_superseded' });
      // A second recovery pass finds the active sequence and resumes nothing more.
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(0);
    } finally {
      await mockPg('review_sequences').where({ customer_id: fixture.customerId }).del();
    }
  });

  test('a pre-provider refusal inside the review handoff returns the ask to pending in the same transaction', async () => {
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', token: randomUUID().replace(/-/g, '') });
    try {
      let seenDuringDispatch = null;
      expect(await Summary.reviewSendThroughSummaryHandoff(fixture.recordIds[0], async (trx) => {
        seenDuringDispatch = (await trx('review_requests').where({ id: askId }).first('status')).status;
        return { ok: false, code: 'NO_CONSENT_RECORD', reason: 'refused before the request' };
      }, undefined, { requestId: askId })).toMatchObject({ ok: false, code: 'NO_CONSENT_RECORD' });
      expect(seenDuringDispatch).toBe('sending');
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'pending', claimed_at: null });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('the review handoff stamps its pre-provider mark with the claim time', async () => {
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', token: randomUUID().replace(/-/g, '') });
    try {
      let seen = null;
      expect(await Summary.reviewSendThroughSummaryHandoff(fixture.recordIds[0], async (trx) => {
        seen = await trx('review_requests').where({ id: askId }).first('status', 'claimed_at');
        return { ok: true };
      }, undefined, { requestId: askId })).toEqual({ ok: true });
      expect(seen.status).toBe('sending');
      expect(seen.claimed_at).not.toBeNull();
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sending', claimed_at: seen.claimed_at });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test.each([
    ['proven by the outbound log', 'log', 'legacy'],
    ['proven by the provider', 'provider', 'legacy'],
    ['positively unsent (legacy ask)', 'none', 'legacy'],
    ['positively unsent (cadence touch)', 'none', 'sequence'],
    ['unknown at the provider', 'unavailable', 'legacy'],
  ])('a review ask left sending after its provider request is reconciled: %s', async (_label, proof, kind) => {
    const Review = require('../services/review-request');
    const Twilio = require('../services/twilio');
    const token = randomUUID().replace(/-/g, '');
    const askId = randomUUID();
    const sequenceId = kind === 'sequence' ? randomUUID() : null;
    if (sequenceId) {
      await mockPg('review_sequences').insert({ id: sequenceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'active', plan: JSON.stringify({ touches: [] }) });
    }
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending', token,
      claimed_at: new Date(Date.now() - 11 * 60 * 1000), sequence_id: sequenceId, sequence_step: sequenceId ? 0 : null, channel: 'sms' });
    // A fresh mark inside the claim window is never judged.
    const freshId = randomUUID();
    await mockPg('review_requests').insert({ id: freshId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[1], status: 'sending',
      token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'sms' });
    if (proof === 'log') {
      await mockPg('sms_log').insert({ customer_id: fixture.customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
        status: 'sent', message_type: 'review_request', message_body: `Thanks! Leave a review: https://example.invalid/r/${token}` });
    }
    const provider = jest.spyOn(Twilio, 'findOutboundMessageSince').mockResolvedValue(
      proof === 'provider' ? { found: true } : proof === 'unavailable' ? { unavailable: true } : { found: false });
    try {
      const outcome = await Review.reconcileStrandedSends();
      const row = await mockPg('review_requests').where({ id: askId }).first();
      if (proof === 'log' || proof === 'provider') {
        expect(outcome).toEqual({ finished: 1, released: 0 });
        expect(row).toMatchObject({ status: 'sent' });
        expect(row.sms_sent_at).not.toBeNull();
        expect(Boolean(row.sent_at)).toBe(kind === 'sequence');
        expect(provider).toHaveBeenCalledTimes(proof === 'provider' ? 1 : 0);
      } else if (proof === 'none') {
        expect(outcome).toEqual({ finished: 0, released: 1 });
        expect(row).toMatchObject(kind === 'sequence' ? { status: 'deferred', claimed_at: null } : { status: 'pending', claimed_at: null });
        if (kind !== 'sequence') expect(row.scheduled_for).not.toBeNull();
        expect(row.sms_sent_at).toBeNull();
      } else {
        expect(outcome).toEqual({ finished: 0, released: 0 });
        expect(row).toMatchObject({ status: 'sending' });
      }
      expect(await mockPg('review_requests').where({ id: freshId }).first()).toMatchObject({ status: 'sending' });
    } finally {
      provider.mockRestore();
      await mockPg('sms_log').where({ customer_id: fixture.customerId }).del();
      await mockPg('review_requests').whereIn('id', [askId, freshId]).del();
      if (sequenceId) await mockPg('review_sequences').where({ id: sequenceId }).del();
    }
  });

  test('the provider is asked about the beneficiary number before the billing number', async () => {
    const Review = require('../services/review-request');
    const Twilio = require('../services/twilio');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending',
      token: randomUUID().replace(/-/g, ''), claimed_at: new Date(Date.now() - 11 * 60 * 1000), channel: 'sms' });
    const provider = jest.spyOn(Twilio, 'findOutboundMessageSince').mockImplementation(async ({ to }) => ({ found: to === '+12025550124' }));
    try {
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 1, released: 0 });
      expect(provider.mock.calls[0][0]).toMatchObject({ to: '+12025550124' });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sent' });
    } finally {
      provider.mockRestore();
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test.each([
    ['proven by the email record', 'sent'],
    ['positively unsent (no record)', null],
    ['positively unsent (aborted before dispatch)', 'aborted'],
    ['still inside the library in-flight window', 'queued'],
    ['failed after a possible acceptance', 'failed'],
  ])('an email touch left sending after its provider request is reconciled: %s', async (_label, recorded) => {
    const Review = require('../services/review-request');
    const sequenceId = randomUUID();
    const askId = randomUUID();
    await mockPg('review_sequences').insert({ id: sequenceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'active',
      current_step: 1, touches_sent: 1, started_at: new Date(Date.now() - 4 * 86400000), next_run_at: null,
      plan: JSON.stringify([{ day: 0, channel: 'sms' }, { day: 4, channel: 'email' }]) });
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending',
      token: randomUUID().replace(/-/g, ''), claimed_at: new Date(Date.now() - 11 * 60 * 1000), sequence_id: sequenceId, sequence_step: 1, channel: 'email' });
    if (recorded) {
      await mockPg('email_messages').insert({
        provider: 'sendgrid', template_key: 'review_request_email', recipient_type: 'customer', recipient_id: fixture.customerId,
        recipient_email_snapshot: fixture.serviceEmail, idempotency_key: `review_seq:${sequenceId}:1`, status: recorded === 'aborted' ? 'failed' : recorded,
        error_message: recorded === 'aborted' ? ABORTED_BEFORE_DISPATCH : recorded === 'failed' ? 'socket hang up' : null,
        queued_at: new Date(), sent_at: recorded === 'sent' ? new Date() : null, provider_message_id: recorded === 'sent' ? randomUUID() : null,
        send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
        from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com', categories: JSON.stringify(['review_request']),
      });
    }
    const Twilio = require('../services/twilio');
    const provider = jest.spyOn(Twilio, 'findOutboundMessageSince').mockResolvedValue({ found: false });
    try {
      const outcome = await Review.reconcileStrandedSends();
      const row = await mockPg('review_requests').where({ id: askId }).first();
      const seq = await mockPg('review_sequences').where({ id: sequenceId }).first();
      expect(provider).not.toHaveBeenCalled();
      if (recorded === 'sent') {
        expect(outcome).toEqual({ finished: 1, released: 0 });
        expect(row).toMatchObject({ status: 'sent' });
        expect(row.sent_at).not.toBeNull();
        expect(row.sms_sent_at).toBeNull();
        // The last planned step went out: the sequence completes as the runner would have completed it.
        expect(seq).toMatchObject({ status: 'completed', stop_reason: 'completed', current_step: 2, touches_sent: 2, next_run_at: null });
      } else if (recorded === 'queued' || recorded === 'failed') {
        expect(outcome).toEqual({ finished: 0, released: 0 });
        expect(row).toMatchObject({ status: 'sending' });
        expect(seq).toMatchObject({ status: 'active', next_run_at: null });
      } else {
        expect(outcome).toEqual({ finished: 0, released: 1 });
        expect(row).toMatchObject({ status: 'deferred', claimed_at: null });
        // The runner's claim had unscheduled the sequence; the release puts it back on the cron's rail.
        expect(seq.status).toBe('active');
        expect(seq.next_run_at).not.toBeNull();
      }
    } finally {
      provider.mockRestore();
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('review_sequences').where({ id: sequenceId }).del();
    }
  });

  test('a cadence touch proven sent advances its sequence to the next step at its schedule', async () => {
    const Review = require('../services/review-request');
    const sequenceId = randomUUID();
    const askId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const startedAt = new Date();
    await mockPg('review_sequences').insert({ id: sequenceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'active',
      current_step: 0, touches_sent: 0, started_at: startedAt, next_run_at: null, plan: JSON.stringify([{ day: 0 }, { day: 4 }]) });
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending', token,
      claimed_at: new Date(Date.now() - 11 * 60 * 1000), sequence_id: sequenceId, sequence_step: 0, channel: 'sms' });
    await mockPg('sms_log').insert({ customer_id: fixture.customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'sent', message_type: 'review_request', message_body: `Thanks! Leave a review: https://example.invalid/r/${token}` });
    try {
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 1, released: 0 });
      const seq = await mockPg('review_sequences').where({ id: sequenceId }).first();
      expect(seq).toMatchObject({ status: 'active', current_step: 1, touches_sent: 1 });
      expect(seq.last_touch_at).not.toBeNull();
      expect(new Date(seq.next_run_at).getTime()).toBeGreaterThanOrEqual(startedAt.getTime() + 4 * 86400000 - 1000);
      // A second pass has nothing left to judge and never advances twice.
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 0, released: 0 });
      expect(await mockPg('review_sequences').where({ id: sequenceId }).first()).toMatchObject({ current_step: 1, touches_sent: 1 });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('review_sequences').where({ id: sequenceId }).del();
    }
  });

  test('parking removes the automatic pending asks and keeps a manual one for the scheduler to defer', async () => {
    const autoId = randomUUID();
    const manualId = randomUUID();
    await mockPg('review_requests').insert([
      { id: autoId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', triggered_by: 'auto', token: randomUUID().replace(/-/g, '') },
      { id: manualId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[1], status: 'pending', triggered_by: 'admin', token: randomUUID().replace(/-/g, '') },
    ]);
    try {
      expect(await Summary.parkVisitReviewOutreach(fixture.packetId)).toEqual({ parked: 1 });
      expect(await mockPg('review_requests').where({ id: autoId }).first()).toBeUndefined();
      expect(await mockPg('review_requests').where({ id: manualId }).first()).toMatchObject({ status: 'pending', triggered_by: 'admin' });
    } finally {
      await mockPg('review_requests').whereIn('id', [autoId, manualId]).del();
    }
  });

  test('a delivered ask gets no follow-up while its visit summary is parked as uncertain', async () => {
    const Review = require('../services/review-request');
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: 'provider_bounce' });
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sent',
      triggered_by: 'auto', token: randomUUID().replace(/-/g, ''), sms_sent_at: new Date(Date.now() - 3 * 86400000), followup_sent: false });
    try {
      await Review.processFollowups();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sent', followup_sent: false });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('visit_effects').where({ visit_id: fixture.visitId }).del();
    }
  });

  test('a withdrawal finding the invoice already settled records no hold and reports nothing withdrawn', async () => {
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'paid', visit_completion_packet_id: fixture.packetId });
    try {
      const withdrawn = await mockPg.transaction((trx) => Packets.withdrawPacketInvoiceForPayer(trx, {
        packetId: fixture.packetId, invoiceId, visit: { id: fixture.visitId }, billed: [], payerId: randomUUID() }));
      expect(withdrawn).toBe(false);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'paid', scheduled_send_error: null });
      expect((await mockPg('service_visits').where({ id: fixture.visitId }).first('billing_hold')).billing_hold).toBeFalsy();
      expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).first()).toBeUndefined();
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('the pre-provider mark outlives a handoff whose request threw, and is lifted when the throw came first', async () => {
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', token: randomUUID().replace(/-/g, '') });
    try {
      // The dispatch reports the PROVIDER BOUNDARY (the callback the send
      // layer fires immediately before the Twilio request) and then throws —
      // the outcome the reconciliation exists for.
      await expect(Summary.reviewSendThroughSummaryHandoff(
        fixture.recordIds[0],
        async (trx, onProviderStart) => { onProviderStart(); throw new Error('socket hang up'); },
        undefined,
        { requestId: askId },
      )).rejects.toThrow('socket hang up');
      // The provider may hold the message: the row stays marked for the reconciliation.
      const marked = await mockPg('review_requests').where({ id: askId }).first();
      expect(marked).toMatchObject({ status: 'sending' });
      expect(marked.claimed_at).not.toBeNull();
      // A throw before any request (an unreadable summary state) is provably unsent.
      await mockPg('review_requests').where({ id: askId }).update({ status: 'pending', claimed_at: null });
      const execute = mockPg.client.constructor.prototype._query;
      const spy = jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function (connection, obj) {
        if (/visit_completion_packet_items/.test(obj.sql)) return Promise.reject(new Error('packet items unreadable'));
        return execute.call(this, connection, obj);
      });
      try {
        await expect(Summary.reviewSendThroughSummaryHandoff(fixture.recordIds[0], async () => ({ ok: true }), undefined, { requestId: askId }))
          .rejects.toThrow('packet items unreadable');
      } finally {
        spy.mockRestore();
      }
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'pending', claimed_at: null });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a stranded ask whose claim was stamped at database precision is still judged', async () => {
    const Review = require('../services/review-request');
    const token = randomUUID().replace(/-/g, '');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending', token,
      claimed_at: mockPg.raw("NOW() - interval '11 minutes' + interval '123 microseconds'"), channel: 'sms' });
    await mockPg('sms_log').insert({ customer_id: fixture.customerId, direction: 'outbound', from_phone: '+12025550100', to_phone: '+12025550124',
      status: 'sent', message_type: 'review_request', message_body: `Thanks! Leave a review: https://example.invalid/r/${token}` });
    try {
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 1, released: 0 });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sent' });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a stranded no-link check-in is proved by its stamp and never released on a silent body search', async () => {
    // resolution_check / satisfaction_confirm render with NO review link, so
    // a token/short-URL body search can never match them. Releasing on that
    // silence re-texts a customer who already got the check-in (round-24 P1).
    const Review = require('../services/review-request');
    const askId = randomUUID();
    const insertStranded = () => mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId,
      service_record_id: fixture.recordIds[0], status: 'sending', token: randomUUID().replace(/-/g, ''),
      claimed_at: new Date(Date.now() - 11 * 60 * 1000), channel: 'sms', template_key: 'resolution_check' });
    const Twilio = require('../services/twilio');
    // The provider positively reports none — which for this template proves
    // nothing, because the body it would search for carries no link.
    const finder = jest.spyOn(Twilio, 'findOutboundMessageSince').mockResolvedValue({ found: false });
    await insertStranded();
    try {
      // No stamp yet: UNKNOWN, so the row is left alone rather than re-sent.
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 0, released: 0 });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sending' });

      // The send-time stamp proves it left, with no link to search for.
      await mockPg('sms_log').insert({ customer_id: fixture.customerId, direction: 'outbound', from_phone: '+12025550100',
        to_phone: '+12025550124', status: 'sent', message_type: 'review_request',
        message_body: 'Hi Jamie, Adam with Waves. Just making sure everything has been taken care of.',
        metadata: JSON.stringify({ review_request_id: askId }) });
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 1, released: 0 });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sent' });

      // An ASK template is unchanged: no link found anywhere is still a
      // positive none, and the row goes back to the scheduler.
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('sms_log').whereRaw("metadata->>'review_request_id' = ?", [askId]).del();
      await insertStranded();
      await mockPg('review_requests').where({ id: askId }).update({ template_key: 'friendly_ask' });
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 0, released: 1 });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'pending' });
    } finally {
      finder.mockRestore();
      await mockPg('sms_log').whereRaw("metadata->>'review_request_id' = ?", [askId]).del();
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a one-off email touch positively unsent fails for the operator instead of waiting on the text scheduler', async () => {
    const Review = require('../services/review-request');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending',
      token: randomUUID().replace(/-/g, ''), claimed_at: new Date(Date.now() - 11 * 60 * 1000), channel: 'email', triggered_by: 'admin' });
    try {
      expect(await Review.reconcileStrandedSends()).toEqual({ finished: 0, released: 1 });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'failed', claimed_at: null });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('an ask refused at the provider boundary is removed when automatic and deferred when manual', async () => {
    const Review = require('../services/review-request');
    const autoId = randomUUID();
    const manualId = randomUUID();
    const claimedId = randomUUID();
    const claimedAt = new Date();
    await mockPg('review_requests').insert([
      { id: autoId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', triggered_by: 'auto', token: randomUUID().replace(/-/g, '') },
      { id: manualId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'pending', triggered_by: 'tech', token: randomUUID().replace(/-/g, '') },
      // Another sender's live claim: a park must not touch it.
      { id: claimedId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending', triggered_by: 'auto', token: randomUUID().replace(/-/g, ''), claimed_at: claimedAt },
    ]);
    try {
      await Review._parkAskAtProviderBoundary({ id: autoId, triggered_by: 'auto' });
      await Review._parkAskAtProviderBoundary({ id: manualId, triggered_by: 'tech' });
      await Review._parkAskAtProviderBoundary({ id: claimedId, triggered_by: 'auto' });
      expect(await mockPg('review_requests').where({ id: autoId }).first()).toBeUndefined();
      const manual = await mockPg('review_requests').where({ id: manualId }).first();
      expect(manual).toMatchObject({ status: 'pending' });
      expect(new Date(manual.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
      // The claimed row survives: its own sender parks it after the handoff
      // has returned it to `pending`, and the stranded reconciliation owns it
      // if that sender is lost.
      const claimed = await mockPg('review_requests').where({ id: claimedId }).first();
      expect(claimed).toMatchObject({ status: 'sending' });
      expect(new Date(claimed.claimed_at).getTime()).toBe(claimedAt.getTime());
    } finally {
      await mockPg('review_requests').whereIn('id', [autoId, manualId, claimedId]).del();
    }
  });

  test('an email recovery does not reopen a packet closed for office review of its payment', async () => {
    await priorClaim('completion_email', { status: 'unknown_delivery', last_error: 'provider_bounce' });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId })
      .update({ status: 'done', error: JSON.stringify({ payment: 'office_required', reason: 'payer_assigned', payerId: randomUUID() }) });
    const [message] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: fixture.primaryEmail,
      idempotency_key: `visit_summary:${fixture.visitId}:${randomUUID()}`, status: 'sent', sent_at: new Date(), provider_message_id: randomUUID(),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com', categories: JSON.stringify(['email_template']),
    }).returning('*');
    try {
      expect(await Summary.reconcileSummaryEmailRecovery(message)).toEqual({ reconciled: true });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first()).toMatchObject({ status: 'sent' });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done' });
    } finally {
      await mockPg('visit_effects').where({ visit_id: fixture.visitId }).del();
    }
  });

  test('a withdrawal reconciled on a failed packet clears the marker and keeps the hold and the draft', async () => {
    const Packets = require('../services/visit-completion-packets');
    const payerId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'failed', error: 'immutable_member_rejected' });
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: true });
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', visit_completion_packet_id: fixture.packetId, scheduled_send_error: `payer_billed:${payerId}` });
    try {
      expect(await mockPg.transaction((trx) => Packets.reconcileWithdrawnPacketInvoices(trx, { payerId }))).toBe(0);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: null });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  // The packet error column also carries the plain review-enrollment retry
  // sentinel; a release must read it as "no office-review state", not throw
  // and abort the Bill-To writer's transaction with the invoice still withdrawn.
  test('a withdrawal released on a packet holding the plain review-retry sentinel requeues the invoice', async () => {
    const Packets = require('../services/visit-completion-packets');
    const payerId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'processing', error: 'review_enrollment_pending' });
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', visit_completion_packet_id: fixture.packetId, scheduled_send_error: `payer_billed:${payerId}` });
    try {
      expect(await mockPg.transaction((trx) => Packets.reconcileWithdrawnPacketInvoices(trx, { payerId }))).toBe(1);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('a withdrawal on a visit already held for another reason leaves that hold when the payer is removed', async () => {
    const Packets = require('../services/visit-completion-packets');
    const payerId = randomUUID();
    const invoiceId = randomUUID();
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: true });
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', visit_completion_packet_id: fixture.packetId });
    try {
      expect(await mockPg.transaction((trx) => Packets.withdrawPacketInvoiceForPayer(trx, {
        packetId: fixture.packetId, invoiceId, visit: { id: fixture.visitId }, billed: [], payerId }))).toBe(true);
      // The stamp carries no hold flag: the hold was not this withdrawal's.
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payerId}` });
      expect(await mockPg.transaction((trx) => Packets.reconcileWithdrawnPacketInvoices(trx, { payerId }))).toBe(1);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      // The same withdrawal on an unheld visit owns its hold and lifts it.
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'draft' });
      await mockPg.transaction((trx) => Packets.withdrawPacketInvoiceForPayer(trx, { packetId: fixture.packetId, invoiceId, visit: { id: fixture.visitId }, billed: [], payerId }));
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ scheduled_send_error: `payer_billed:${payerId}:hold` });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(await mockPg.transaction((trx) => Packets.reconcileWithdrawnPacketInvoices(trx, { payerId }))).toBe(1);
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('a review enrollment whose recovery write also fails is reported as unrecorded', async () => {
    const Packets = require('../services/visit-completion-packets');
    const down = Object.assign(() => { throw new Error('db down'); }, { fn: { now: () => new Date() } });
    expect(await Packets.enrollVisitCompletionReview(fixture.packetId, down)).toMatchObject({ enrolled: false, retryable: true, reopened: false, recorded: false });
  });

  test('an office reassignment during member effects closes the packet for office review instead of retrying forever', async () => {
    const Packets = require('../services/visit-completion-packets');
    const otherTech = randomUUID();
    await mockPg('technicians').insert({ id: otherTech, name: 'Other Technician', role: 'technician', active: true });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({
      payload: JSON.stringify({ ...fixture.payload, actor: { role: 'technician', technicianId: fixture.techId } }) });
    await mockPg('visit_completion_packet_items').where({ packet_id: fixture.packetId, scheduled_service_id: fixture.serviceIds[0] }).update({ status: 'processing' });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ technician_id: otherTech });
    try {
      const result = await Packets.runVisitCompletionPacketMemberEffects(fixture.packetId);
      expect(result).toMatchObject({ status: 200, body: { state: 'office_required', code: 'service_reassigned' } });
      expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'failed' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(await mockPg('dispatch_alerts').where({ tech_id: otherTech, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      // The sweep's next pass finds an owned packet, not a refusal to repeat.
      expect(await Packets.runVisitCompletionPacketMemberEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    } finally {
      await mockPg('dispatch_alerts').where({ tech_id: otherTech }).del();
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ technician_id: fixture.techId });
      await mockPg('technicians').where({ id: otherTech }).del();
    }
  });

  test('a payer assignment withdraws a self-pay invoice the homeowner already holds', async () => {
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done', error: null });
    try {
      // Self-pay: nothing to withdraw.
      expect(await mockPg.transaction((trx) => Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId }))).toEqual([]);
      // The customer's default payer assigned in the same transaction as the withdrawal.
      expect(await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      })).toHaveLength(1);
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'sent', scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
      expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
      // Already withdrawn: not withdrawn twice.
      expect(await mockPg.transaction((trx) => Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId }))).toEqual([]);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawn invoice the homeowner still holds is no longer collectible at any money seam', async () => {
    // The withdrawal cannot recall a pay link already in the customer's
    // hands: the row keeps a collectible status and a NULL payer_id, and
    // records the withdrawal only in its stamp. Every collection path funnels
    // through assertInvoiceCollectible, so the stamp is read there once
    // rather than re-derived by each seam (round-24 P1: POST
    // /api/pay/:token/setup checked neither the stamp nor the billing hold).
    const Packets = require('../services/visit-completion-packets');
    const { assertInvoiceCollectible } = require('../services/invoice-helpers');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done', error: null });
    try {
      // Before the withdrawal the homeowner's link collects normally.
      const beforeWithdrawal = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(() => assertInvoiceCollectible(beforeWithdrawal)).not.toThrow();
      expect(await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      })).toHaveLength(1);
      const withdrawn = await mockPg('invoices').where({ id: invoiceId }).first();
      // Still `sent` with no payer_id — the state every seam used to read as payable.
      expect(withdrawn).toMatchObject({ status: 'sent', payer_id: null, scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(() => assertInvoiceCollectible(withdrawn)).toThrow(/third-party payer/);
      // There is no status-only shape to fall back to: a caller that hands
      // over just the status is refused outright rather than collecting a
      // payer-owned invoice because the stamp was invisible to it.
      expect(() => assertInvoiceCollectible(withdrawn.status)).toThrow(/requires the invoice row/);

      // Ownership back to self-pay: the reconciliation clears the stamp and
      // the same seam collects again.
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        return Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId });
      });
      const released = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(released.scheduled_send_error).toBeNull();
      expect(() => assertInvoiceCollectible(released)).not.toThrow();
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('reactivating a payer fences combined payments of every referencing customer and withdraws their self-pay invoices', async () => {
    const Payer = require('../services/payer');
    const PayCombined = require('../services/pay-combined');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: false }).returning('id');
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const fence = jest.spyOn(PayCombined, 'releaseUnconfirmedCombinedSessionsForCustomers').mockResolvedValue({ released: 0, inFlight: 1 });
    try {
      expect(await Payer.updatePayer(payer.id, { active: true })).toMatchObject({ conflict: true, code: 'combined_payment_in_flight' });
      // One fence call carrying EVERY referencing customer: a conflict on
      // any of them must be known before a session belonging to another is
      // cancelled (a Stripe cancel does not roll back with the refusal).
      expect(fence).toHaveBeenCalledTimes(1);
      expect(fence).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([String(fixture.customerId)]));
      expect(await mockPg('payers').where({ id: payer.id }).first()).toMatchObject({ active: false });
      fence.mockResolvedValue({ released: 0, inFlight: 0 });
      expect(await Payer.updatePayer(payer.id, { active: true })).toMatchObject({ payer: { active: true } });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
    } finally {
      fence.mockRestore();
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawal preserves a parked ambiguous send instead of re-queueing it later', async () => {
    // The stale-send recovery parks an invoice whose provider handoff may
    // have succeeded (scheduled, no send time, its evidence in the error).
    // Turning that into a draft and later re-queueing it sends the customer a
    // second copy of an invoice they may already hold.
    const Packets = require('../services/visit-completion-packets');
    const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'scheduled', total: 120, visit_completion_packet_id: fixture.packetId,
      scheduled_send_at: null, scheduled_send_attempts: 3, scheduled_send_error: STALE_SEND_PARK_ERROR });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      const withdrawn = await mockPg('invoices').where({ id: invoiceId }).first();
      // Still parked — not a draft, and no send time it could be picked up on.
      expect(withdrawn).toMatchObject({ status: 'scheduled', scheduled_send_at: null, scheduled_send_attempts: 3 });
      expect(withdrawn.scheduled_send_error).toMatch(/^payer_billed:\d+:park/);

      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        return Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId });
      });
      const released = await mockPg('invoices').where({ id: invoiceId }).first();
      // Back to the park it came from, evidence restored — never queued.
      expect(released).toMatchObject({ status: 'scheduled', scheduled_send_at: null, scheduled_send_attempts: 3, scheduled_send_error: STALE_SEND_PARK_ERROR });
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('an unavailable-summary deferral is reported only when the retry is actually scheduled', async () => {
    // This branch keeps the row and schedules its own retry, so a swallowed
    // failure leaves a pending ask with a NULL scheduled_for — processScheduled
    // never picks it up and packet recovery cannot re-create a manual ask.
    const Review = require('../services/review-request');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'pending', token: randomUUID().replace(/-/g, ''), channel: 'sms', triggered_by: 'manual' });
    try {
      const nextAllowedAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      expect(await Review._deferAskForUnavailableSummary({ id: askId }, nextAllowedAt)).toBe(true);
      const row = await mockPg('review_requests').where({ id: askId }).first('status', 'scheduled_for');
      expect(row.status).toBe('pending');
      expect(new Date(row.scheduled_for).getTime()).toBe(new Date(nextAllowedAt).getTime());
      // A failed write is reported as such, so the caller retries now instead
      // of trusting a schedule that was never written.
      expect(await Review._deferAskForUnavailableSummary({ id: askId }, 'not-a-date')).toBe(false);
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('scheduling a send cannot clear a withdrawal stamp', async () => {
    // The stamp is the ONLY record that this invoice's Bill-To moved to a
    // payer while the homeowner already held its link. A scheduler write that
    // cleared it would make the invoice collectible from the homeowner again
    // and queue it for delivery to them.
    const Packets = require('../services/visit-completion-packets');
    const { invoiceWithdrawnFromCustomer } = require('../services/invoice-helpers');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      expect(invoiceWithdrawnFromCustomer(await mockPg('invoices').where({ id: invoiceId }).first())).toBe(true);

      // The schedule-send predicate refuses a stamped row outright.
      const scheduled = await mockPg('invoices').where({ id: invoiceId })
        .whereIn('status', ['draft', 'scheduled'])
        .whereRaw("(scheduled_send_error IS NULL OR scheduled_send_error NOT LIKE 'payer_billed:%')")
        .update({ status: 'scheduled', scheduled_send_at: new Date(), scheduled_send_error: null });
      expect(scheduled).toBe(0);

      // …and a writer that DOES clear the column keeps the stamp.
      const { preserveWithdrawalStamp } = require('../services/invoice-helpers');
      await mockPg('invoices').where({ id: invoiceId }).update({ scheduled_send_error: preserveWithdrawalStamp(mockPg) });
      expect(invoiceWithdrawnFromCustomer(await mockPg('invoices').where({ id: invoiceId }).first())).toBe(true);
      // A row with an ordinary send error still clears to NULL.
      await mockPg('invoices').where({ id: invoiceId }).update({ scheduled_send_error: 'Twilio 30003 unreachable' });
      await mockPg('invoices').where({ id: invoiceId }).update({ scheduled_send_error: preserveWithdrawalStamp(mockPg) });
      expect((await mockPg('invoices').where({ id: invoiceId }).first()).scheduled_send_error).toBeNull();
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a definitively rejected sequence email releases its claim instead of stranding it', async () => {
    // A 4xx SendGrid refusal proves the message was not accepted. Left
    // `sending`, the row is stranded for good: the evidence reader treats the
    // failed email record as unavailable, so the reconciliation never
    // releases it and the sequence step keeps a NULL next_run_at.
    const Review = require('../services/review-request');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'email', triggered_by: 'sequence' });
    try {
      const rejection = Object.assign(new Error('Bad Request'), { status: 400 });
      const outcome = await Review._outreachEmailThrowOutcome({ request: { id: askId }, manageRetryVia: 'sequence', dispatched: true, err: rejection });
      expect(outcome).toMatchObject({ ok: false, retryable: true, channel: 'email' });
      expect(outcome.uncertain).toBeUndefined();
      const row = await mockPg('review_requests').where({ id: askId }).first('status', 'claimed_at');
      expect(row.status).not.toBe('sending');
      expect(row.claimed_at).toBeNull();
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('the stranded-send sweep pages past claims whose evidence never resolves', async () => {
    // An ask with no provable evidence is left alone by design. Taking only
    // the oldest 20 meant a head of such rows monopolized every sweep and no
    // later stranded send was ever examined.
    const Review = require('../services/review-request');
    const base = Date.now() - 60 * 60 * 1000;
    // More than one run's budget (5 pages of 20) so the second run has
    // somewhere new to go.
    const rows = Array.from({ length: 110 }, (unused, i) => ({
      id: randomUUID(), customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(base + i * 1000),
      channel: 'sms', triggered_by: 'auto',
    }));
    const ids = rows.map((row) => row.id);
    try {
      await mockPg('review_requests').insert(rows);
      const seen = [];
      const evidence = jest.spyOn(Review, '_inlineSendEvidence').mockImplementation(async (row) => {
        seen.push(row.id);
        return { unavailable: true };
      });
      try {
        await Review.reconcileStrandedSends();
      } finally {
        evidence.mockRestore();
      }
      // A full run's budget was spent paging, not stuck on the first 20.
      expect(seen).toHaveLength(100);
      expect(seen.slice(0, 100)).toEqual(ids.slice(0, 100));

      // …and the NEXT run resumes past what this one judged rather than
      // re-reading the same unresolvable head forever.
      seen.length = 0;
      const evidenceAgain = jest.spyOn(Review, '_inlineSendEvidence').mockImplementation(async (row) => {
        seen.push(row.id);
        return { unavailable: true };
      });
      try {
        await Review.reconcileStrandedSends();
      } finally {
        evidenceAgain.mockRestore();
      }
      expect(seen[0]).toBe(ids[100]);
      expect(seen).toHaveLength(10);

      // The backlog ended, so the cursor resets and the run after that starts
      // from the front again — nothing is examined only once.
      seen.length = 0;
      const evidenceThird = jest.spyOn(Review, '_inlineSendEvidence').mockImplementation(async (row) => {
        seen.push(row.id);
        return { unavailable: true };
      });
      try {
        await Review.reconcileStrandedSends();
      } finally {
        evidenceThird.mockRestore();
      }
      expect(seen[0]).toBe(ids[0]);
    } finally {
      await mockPg('review_requests').whereIn('id', ids).del();
    }
  });

  test('restoring a voided withdrawn invoice re-judges its stamp against live ownership', async () => {
    // A withdrawn invoice that was voided is invisible to the Bill-To
    // reconciliation (void is terminal), so a payer cleared while it was void
    // would leave the restored draft stamped — unpayable and unschedulable.
    const Packets = require('../services/visit-completion-packets');
    const { invoiceWithdrawnFromCustomer } = require('../services/invoice-helpers');
    const InvoiceService = require('../services/invoice');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      expect(invoiceWithdrawnFromCustomer(await mockPg('invoices').where({ id: invoiceId }).first())).toBe(true);

      // Voided while withdrawn, then the Bill-To is cleared: the
      // reconciliation cannot see a terminal row.
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'void' });
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });

      await InvoiceService.unvoidInvoice(invoiceId);
      const restored = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(restored.status).toBe('scheduled');
      expect(invoiceWithdrawnFromCustomer(restored)).toBe(false);

      // …and the opposite sequence: voided BEFORE any payer existed, so the
      // withdrawal skipped the terminal row and no stamp was ever written.
      // Restoring it while a payer owns the packet must withdraw it now, not
      // hand the homeowner a collectible link (local audit P0).
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'void', scheduled_send_error: null });
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
      await InvoiceService.unvoidInvoice(invoiceId);
      const rejudged = await mockPg('invoices').where({ id: invoiceId }).first();
      expect(invoiceWithdrawnFromCustomer(rejudged)).toBe(true);
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawal pauses dunning and drops the invoice from the reminder sweep', async () => {
    // The follow-up sequence and the legacy overdue reminder both text/email
    // the homeowner a pay link, and both guard on payer_id — which a
    // withdrawal deliberately leaves NULL.
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId,
      due_date: new Date(Date.now() - 30 * 86400000) });
    await mockPg('invoice_followup_sequences').insert({ invoice_id: invoiceId, customer_id: fixture.customerId,
      status: 'active', step_index: 0, next_touch_at: new Date() });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      const sequence = await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).first('status', 'next_touch_at');
      expect(sequence).toMatchObject({ status: 'paused' });
      expect(sequence.next_touch_at).toBeNull();
      // …and the legacy overdue sweep's own predicate no longer matches it.
      const overdue = await mockPg('invoices').where({ id: invoiceId })
        .whereIn('status', ['sent', 'viewed', 'overdue'])
        .whereNull('payer_id')
        .where(function whereNotWithdrawn() {
          this.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%');
        })
        .first('id');
      expect(overdue).toBeUndefined();

      // Ownership back to self-pay: the debt is collectible again, so the
      // pause the withdrawal set is lifted (an admin pause would not be).
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        return Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId });
      });
      const resumed = await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).first('status', 'paused_reason', 'next_touch_at');
      expect(resumed).toMatchObject({ status: 'active', paused_reason: null });
      expect(resumed.next_touch_at).not.toBeNull();
    } finally {
      await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).del();
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a withdrawal returns the homeowner credit already applied to the invoice', async () => {
    // The payer-attach path refuses to transfer ownership without returning
    // applied credit; a withdrawal is the same transfer by another route.
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, credit_applied: 20, visit_completion_packet_id: fixture.packetId });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      const withdrawn = await mockPg('invoices').where({ id: invoiceId }).first('credit_applied', 'scheduled_send_error');
      expect(Number(withdrawn.credit_applied || 0)).toBe(0);
      expect(withdrawn.scheduled_send_error).toMatch(/^payer_billed:/);
      // …and the customer's balance carries the returned credit.
      const ledger = await mockPg('customer_credit_ledger').where({ customer_id: fixture.customerId, invoice_id: invoiceId })
        .orderBy('created_at', 'desc').first('delta', 'source');
      expect(Number(ledger?.delta || 0)).toBe(20);
    } finally {
      await mockPg('customer_credit_ledger').where({ customer_id: fixture.customerId }).del();
      await mockPg('customers').where({ id: fixture.customerId }).update({ account_credits: 0 });
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('the public save-a-method predicate sees a payer on ANY billed member', async () => {
    // /consent and /setup-complete call this before they persist anything:
    // the representative-service resolver cannot see a payer assigned to a
    // sibling member of a combined packet, and a withdrawn invoice keeps a
    // NULL payer_id.
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId,
      // anchored to the FIRST member; the payer lands on the second.
      scheduled_service_id: fixture.serviceIds[0] });
    try {
      expect(await Packets.invoicePayerOwnedNow(invoiceId)).toBe(false);

      // A payer on a SIBLING billed member is what the representative-service
      // resolver misses.
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[fixture.serviceIds.length - 1] }).update({ payer_id: payer.id });
      expect(await Packets.invoicePayerOwnedNow(invoiceId)).toBe(true);
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[fixture.serviceIds.length - 1] }).update({ payer_id: null });

      // …and the withdrawal stamp, on a row whose payer_id stays NULL.
      await mockPg('invoices').where({ id: invoiceId }).update({ scheduled_send_error: `payer_billed:${payer.id}:hold` });
      expect(await Packets.invoicePayerOwnedNow(invoiceId)).toBe(true);

      // An unreadable invoice is never "self-pay".
      expect(await Packets.invoicePayerOwnedNow(randomUUID())).toBe(true);
    } finally {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a Bill-To assignment during delivery closes the packet for office review', async () => {
    // The withdrawal stamps the invoice and holds the visit, but a packet
    // still `processing` has no office review to record against — so the
    // close must re-derive the payment verdict under its own locks or the
    // packet completes clean and the withdrawn debt leaves the sweep with no
    // billing alert.
    const Packets = require('../services/visit-completion-packets');
    const { invoiceWithdrawnFromCustomer } = require('../services/invoice-helpers');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      expect(invoiceWithdrawnFromCustomer(await mockPg('invoices').where({ id: invoiceId }).first())).toBe(true);
      // The withdrawal on a still-processing packet records no alert…
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' })
        .whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'processing', error: null });

      // …so the close is what has to notice it.
      const result = await runVisitCompletionPacketEffects(fixture.packetId);
      expect(result.body.state).toBe('office_required');
      const closed = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('status', 'error');
      expect(closed.status).toBe('done');
      expect(JSON.parse(closed.error)).toMatchObject({ payment: 'office_required', reason: 'payer_assigned' });
      const alert = await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
        .whereRaw("payload->>'packetId' = ?", [fixture.packetId]).first('payload');
      expect(alert).toBeDefined();
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a blocked or bounced review email is not evidence the ask was sent', async () => {
    // The library's dedupe set answers "would a re-send duplicate?", which is
    // true for blocked/dropped/bounced — none of which reached the customer.
    // Marking those sent would advance the cadence and spend the ask
    // allowance on an email nobody received.
    const Review = require('../services/review-request');
    const askId = randomUUID();
    const sequenceId = randomUUID();
    const key = `review_seq:${sequenceId}:0`;
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'email',
      triggered_by: 'sequence', sequence_id: sequenceId, sequence_step: 0 });
    const row = { id: askId, sequence_id: sequenceId, sequence_step: 0, channel: 'email' };
    try {
      for (const status of ['blocked', 'dropped', 'bounced']) {
        await mockPg('email_messages').where({ idempotency_key: key }).del();
        await mockPg('email_messages').insert({ idempotency_key: key, status,
          recipient_email_snapshot: fixture.primaryEmail, template_key: 'review.outreach' });
        expect(await Review._emailSendEvidence(row)).toEqual({ found: false });
      }
      // Delivery — or a recipient ACTION on the delivered mail — is evidence.
      for (const status of ['delivered', 'opened', 'unsubscribed']) {
        await mockPg('email_messages').where({ idempotency_key: key }).del();
        await mockPg('email_messages').insert({ idempotency_key: key, status,
          recipient_email_snapshot: fixture.primaryEmail, template_key: 'review.outreach' });
        expect(await Review._emailSendEvidence(row)).toEqual({ found: true });
      }
    } finally {
      await mockPg('email_messages').where({ idempotency_key: key }).del();
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a withdrawal on a packet already in payment review keeps that review when the payer leaves', async () => {
    // The visit is already held for a NON-payer billing problem. Relabelling
    // the review `payer_assigned` and then lifting it on a Bill-To clear would
    // leave the office a held visit with no signal for the original problem.
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId });
    // Closed for a payment problem of its own, with the visit already held.
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({
      status: 'done',
      error: JSON.stringify({ payment: 'office_required', reason: 'charge_failed' }),
    });
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: true });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      const withdrawn = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('error');
      // The payer verdict is recorded, and the original provenance survives.
      expect(JSON.parse(withdrawn.error)).toMatchObject({ reason: 'payer_assigned', priorPaymentReason: 'charge_failed' });

      // A REPEATED withdrawal (a coordinator replay) keeps it too: by now the
      // original reason lives in priorPaymentReason, not in `reason`.
      await mockPg.transaction((trx) => Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId }));
      expect(JSON.parse((await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('error')).error))
        .toMatchObject({ reason: 'payer_assigned', priorPaymentReason: 'charge_failed' });

      // Bill-To cleared: the payer verdict lifts, the original one does not.
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: null });
        return Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId });
      });
      const lifted = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('error');
      expect(JSON.parse(lifted.error)).toMatchObject({ payment: 'office_required', reason: 'charge_failed' });
      const alert = await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
        .whereRaw("payload->>'packetId' = ?", [fixture.packetId]).first('payload');
      const payload = typeof alert?.payload === 'string' ? JSON.parse(alert.payload) : alert?.payload;
      expect(payload?.reason).toBe('charge_failed');
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done', error: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a payer-to-payer handoff moves the office review to the payer that owes it now', async () => {
    // The stamp, the packet error and the open alert all name the AP account
    // the office must bill; a second payer taking the packet over has to move
    // all three, or staff bill the payer that no longer owes it.
    const Packets = require('../services/visit-completion-packets');
    const invoiceId = randomUUID();
    const [first] = await mockPg('payers').insert({ display_name: 'Fixture AP One', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    const [second] = await mockPg('payers').insert({ display_name: 'Fixture AP Two', ap_email: `${randomUUID()}@example.invalid`, active: true }).returning('id');
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sent', total: 120, visit_completion_packet_id: fixture.packetId });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done', error: null });
    try {
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: first.id });
        return Packets.withdrawPacketInvoicesForOwner(trx, { customerId: fixture.customerId });
      });
      const packetAfterWithdrawal = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('error');
      expect(JSON.parse(packetAfterWithdrawal.error)).toMatchObject({ reason: 'payer_assigned', payerId: first.id });
      const alert = await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
        .whereRaw("payload->>'packetId' = ?", [fixture.packetId]).first('id', 'payload');
      expect(alert).toBeDefined();

      // The customer's Bill-To moves to a different payer: the packet is still
      // payer-owned, so nothing is released — the identity is repointed.
      await mockPg.transaction(async (trx) => {
        await trx('customers').where({ id: fixture.customerId }).update({ payer_id: second.id });
        return Packets.reconcileWithdrawnPacketInvoices(trx, { customerId: fixture.customerId });
      });
      expect(await mockPg('invoices').where({ id: invoiceId }).first('scheduled_send_error'))
        .toMatchObject({ scheduled_send_error: `payer_billed:${second.id}:hold` });
      const packetAfterHandoff = await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first('error');
      expect(JSON.parse(packetAfterHandoff.error)).toMatchObject({ payment: 'office_required', reason: 'payer_assigned', payerId: second.id });
      const repointed = await mockPg('dispatch_alerts').where({ id: alert.id }).first('payload', 'resolved_at');
      expect(repointed.resolved_at).toBeNull();
      const payload = typeof repointed.payload === 'string' ? JSON.parse(repointed.payload) : repointed.payload;
      expect(String(payload.payerId)).toBe(String(second.id));
    } finally {
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereRaw("payload->>'packetId' = ?", [fixture.packetId]).del();
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ billing_hold: false });
      await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ error: null });
      await mockPg('payers').whereIn('id', [first.id, second.id]).del();
    }
  });

  test('a resumed cadence keeps an empty schedule while its step is still sending', async () => {
    // The parked sequence can hold a request the sender left `sending` with
    // its outcome unproven. Scheduling it now would let the runner build a
    // SECOND request for the same step (a no-link check-in bypasses ask
    // spacing) and strand the first, which the stranded-send reconciliation
    // can only advance while the sequence has no schedule.
    cadenceGateOn();
    const sequenceId = randomUUID();
    const askId = randomUUID();
    await mockPg('review_sequences').insert({ id: sequenceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'stopped', stop_reason: Summary.PARKED_REVIEW_REASON, current_step: 1, next_run_at: null, plan: JSON.stringify([{ day: 0 }, { day: 4 }]) });
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'sms',
      triggered_by: 'sequence', sequence_id: sequenceId, sequence_step: 1 });
    try {
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(1);
      const held = await mockPg('review_sequences').where({ id: sequenceId }).first('status', 'next_run_at');
      expect(held).toMatchObject({ status: 'active' });
      expect(held.next_run_at).toBeNull();

      // Once that send resolves, a later resume schedules normally.
      await mockPg('review_requests').where({ id: askId }).update({ status: 'sent', sms_sent_at: new Date() });
      await mockPg('review_sequences').where({ id: sequenceId }).update({ status: 'stopped', stop_reason: Summary.PARKED_REVIEW_REASON });
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(1);
      const scheduled = await mockPg('review_sequences').where({ id: sequenceId }).first('status', 'next_run_at');
      expect(scheduled.status).toBe('active');
      expect(scheduled.next_run_at).not.toBeNull();
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('review_sequences').where({ id: sequenceId }).del();
    }
  });

  test('a parked cadence is not resumed while the sequence gate is off', async () => {
    const gates = require('../config/feature-gates');
    await mockPg('review_sequences').insert({ id: randomUUID(), customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'stopped', stop_reason: 'visit_summary_bounced', plan: JSON.stringify([]) });
    const gate = jest.spyOn(gates, 'isEnabled').mockImplementation((name) => name !== 'reviewSequences');
    try {
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(0);
      expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId }).first()).toMatchObject({ status: 'stopped', stop_reason: 'visit_summary_bounced' });
      gate.mockImplementation(() => true);
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(1);
    } finally {
      gate.mockRestore();
      await mockPg('review_sequences').where({ customer_id: fixture.customerId }).del();
    }
  });

  test('a RETURNED provider failure after dispatch is as uncertain as a thrown one', async () => {
    // The Twilio adapter catches provider errors and reports them as
    // `sent: false` / PROVIDER_FAILURE instead of raising, so the throw
    // branch never sees them (pre-push P1). With the durable row still
    // `sending`, the request was made and its response was lost — applying
    // retry bookkeeping would release it for a second send on top of a
    // delivered one.
    const Review = require('../services/review-request');
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'sms', triggered_by: 'auto' });
    const send = require('../services/messaging/send-customer-message').sendCustomerMessage;
    const args = {
      request: { id: askId },
      customer: { id: fixture.customerId },
      contact: { phone: '+12025550123' },
      vars: { first: 'Pat', review_url: 'https://waves.test/r/abc' },
      templateId: null,
      customBody: 'How did we do? {review_url}',
      manageRetryVia: 'cron',
    };
    try {
      send.mockImplementationOnce(async () => ({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', reason: 'connection reset', retryable: true }));
      expect(await Review._sendOutreachSms(args)).toMatchObject({ ok: false, uncertain: true, retryable: false, reason: 'provider_uncertain' });
      // The claim is left standing for the stranded-send reconciliation.
      expect(await mockPg('review_requests').where({ id: askId }).first('status')).toMatchObject({ status: 'sending' });

      // The same returned failure on a row the handoff already released is an
      // ordinary retryable failure — nothing was stranded.
      await mockPg('review_requests').where({ id: askId }).update({ status: 'pending', claimed_at: null });
      send.mockImplementationOnce(async () => ({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', reason: 'connection reset', retryable: true }));
      expect(await Review._sendOutreachSms(args)).not.toMatchObject({ uncertain: true });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a provider throw after dispatch leaves the ask sending and the sequence step claimed', async () => {
    const Review = require('../services/review-request');
    const askId = randomUUID();
    const sequenceId = randomUUID();
    await mockPg('review_sequences').insert({ id: sequenceId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'active',
      current_step: 0, touches_sent: 0, started_at: new Date(), next_run_at: null, plan: JSON.stringify([{ day: 0, channel: 'email' }, { day: 4 }]) });
    // The handoff marked the row and the request was made (the mark survives the throw).
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0], status: 'sending',
      token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), sequence_id: sequenceId, sequence_step: 0, channel: 'email', triggered_by: 'sequence' });
    try {
      const outcome = await Review._outreachEmailThrowOutcome({ request: { id: askId }, manageRetryVia: 'sequence', dispatched: true, err: new Error('socket hang up') });
      expect(outcome).toMatchObject({ ok: false, uncertain: true, reason: 'provider_uncertain' });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'sending' });
      // The runner leaves the step claimed for the reconciliation.
      const touch = jest.spyOn(Review, 'sendOutreachTouch').mockResolvedValue(outcome);
      const customer = await mockPg('customers').where({ id: fixture.customerId }).first();
      jest.spyOn(Review, 'manualReviewAskSentRecently').mockResolvedValue(false);
      // The UNLOCKED runner: main now wraps _runSequenceStep in the
      // per-customer send lock (#4330), which fails fast without a lock slot
      // in this suite's environment and would report a deferral instead of
      // the step's own verdict. The wrapper itself is covered in
      // review-sequences.test.js; what this test asserts is the step's
      // handling of an uncertain provider outcome.
      const ran = await Review._runSequenceStepUnlocked(sequenceId).catch((err) => ({ threw: err.message }));
      touch.mockRestore();
      expect(ran).toMatchObject({ ran: false, uncertain: true });
      expect(await mockPg('review_sequences').where({ id: sequenceId }).first()).toMatchObject({ status: 'active', current_step: 0, next_run_at: null });
      expect(customer.id).toBe(fixture.customerId);
      // A throw before any request (the row already back to pending) still fails the row.
      await mockPg('review_requests').where({ id: askId }).update({ status: 'pending', claimed_at: null });
      expect(await Review._outreachEmailThrowOutcome({ request: { id: askId }, manageRetryVia: 'sequence', dispatched: false, err: new Error('dns') }))
        .toMatchObject({ ok: false, retryable: true });
      expect(await mockPg('review_requests').where({ id: askId }).first()).toMatchObject({ status: 'failed' });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
      await mockPg('review_sequences').where({ id: sequenceId }).del();
    }
  });

  test('the retry rail exhausting a recipient reconciles the summary under a held packet row, like a webhook bounce', async () => {
    // The rail reconciles with the root handle. The packet and effect locks
    // must outlive their SELECTs: a review handoff that takes the packet row
    // meanwhile has to wait for the flip and see the parked outcome, never
    // the stale sent effect.
    fixture.payload.items.forEach((item) => { item.body.requestReview = false; });
    expect(await deliver()).toEqual({ state: 'delivered' });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'failed', provider_retry_exhausted_at: new Date() });
    let probe = null;
    const onQuery = (query) => {
      if (probe || !/"visit_effects".*for update/i.test(query.sql)) return;
      // Another connection's review handoff, started while the reconciliation is between its read and its flip.
      probe = mockPg.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '5s'");
        await trx('visit_completion_packets').where({ id: fixture.packetId }).forShare().first('id');
        return (await trx('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first('status')).status;
      });
    };
    mockPg.on('query', onQuery);
    try {
      expect(await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'failed' })).toEqual({ reconciled: true });
      expect(probe).not.toBeNull();
      expect(await probe).toBe('unknown_delivery');
    } finally {
      mockPg.off('query', onQuery);
      if (probe) await probe.catch(() => {});
    }
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
  });

  test('a manual stop recorded while a step was running is not overwritten by parking', async () => {
    await mockPg('review_sequences').insert({ id: randomUUID(), customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'stopped', stop_reason: 'manual', plan: JSON.stringify({ touches: [] }) });
    try {
      await Summary.parkVisitReviewOutreach(fixture.packetId);
      expect(await mockPg('review_sequences').where({ customer_id: fixture.customerId }).first()).toMatchObject({ status: 'stopped', stop_reason: 'manual' });
      expect(await Summary.resumeVisitReviewOutreach(fixture.packetId)).toBe(0);
    } finally {
      await mockPg('review_sequences').where({ customer_id: fixture.customerId }).del();
    }
  });

  test('a failed packet is not reopened by a paid-invoice lookup failure', async () => {
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'failed', error: 'immutable_member_rejected' });
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'paid', visit_completion_packet_id: fixture.packetId });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failLookup(connection, query) {
      if (!interrupted && query.sql.startsWith('select "visit_completion_packet_id" from "invoices"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic invoice read outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      // The office owns the failed packet: the paid signal must not fall
      // through to the legacy representative-record ask.
      expect(await require('../services/visit-completion-packets').enrollVisitCompletionReviewForInvoice(invoiceId))
        .toMatchObject({ enrolled: false, reason: 'packet_owned', packetId: fixture.packetId, packetStatus: 'failed' });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
    expect(interrupted).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'failed' });
    // The direct wrapper (a full invoice projection from manual payment or credit settlement) keeps a failed packet terminal too.
    jest.restoreAllMocks();
    const readExecute = mockPg.client.constructor.prototype._query;
    let failedOnce = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failPacketRead(connection, query) {
      if (!failedOnce && query.sql.startsWith('select * from "visit_completion_packets"')) {
        failedOnce = true;
        return Promise.reject(new Error('Synthetic packet read outage'));
      }
      return readExecute.call(this, connection, query);
    });
    try {
      expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: false, reason: 'packet_owned' });
    } finally {
      jest.restoreAllMocks();
    }
    expect(failedOnce).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'failed' });
  });

  test('a payer reactivation waits for the fenced invoice claim and is refused while the send is in flight', async () => {
    const Invoice = require('../services/invoice');
    const Payer = require('../services/payer');
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'draft', total: 120, visit_completion_packet_id: fixture.packetId });
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active: false }).returning('id');
    await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: payer.id });
    const execute = mockPg.client.constructor.prototype._query;
    let blockedCode = null;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function reactivateDuringClaim(connection, query) {
      if (!raced && query.sql.startsWith('update "invoices"') && query.bindings.includes('sending')) {
        raced = true;
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await trx('payers').where({ id: payer.id }).forUpdate().first();
        }).catch((err) => { blockedCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    try {
      // An inactive payer is self-pay, so the claim goes through — holding the payer row.
      expect(await Invoice.claimPacketInvoiceForSend(invoiceId, fixture.packetId)).toMatchObject({ payerBilled: false, claim: { claimed: true } });
      expect(raced).toBe(true);
      expect(blockedCode).toBe('55P03');
      jest.restoreAllMocks();
      // With the send in flight, the activation is refused like a payer_id write.
      expect(await Payer.updatePayer(payer.id, { active: true })).toMatchObject({ conflict: true, code: 'invoice_send_in_flight' });
      expect(await mockPg('payers').where({ id: payer.id }).first()).toMatchObject({ active: false });
      // A full-form save that read the payer as active before a concurrent
      // deactivation is judged on the locked row, not on its snapshot.
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sending' });
      let deactivatedAfterSnapshot = false;
      jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function deactivateAfterSnapshot(connection, query) {
        const result = await execute.call(this, connection, query);
        if (!deactivatedAfterSnapshot && query.sql.startsWith('select * from "payers"') && !/for update/i.test(query.sql)) {
          deactivatedAfterSnapshot = true;
          await mockPg('payers').where({ id: payer.id }).update({ active: false });
        }
        return result;
      });
      expect(await Payer.updatePayer(payer.id, { active: true, displayName: 'Fixture Property Management' })).toMatchObject({ conflict: true, code: 'invoice_send_in_flight' });
      jest.restoreAllMocks();
      expect(deactivatedAfterSnapshot).toBe(true);
      expect(await mockPg('payers').where({ id: payer.id }).first()).toMatchObject({ active: false });
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent' });
      expect(await Payer.updatePayer(payer.id, { active: true })).toMatchObject({ payer: { id: payer.id, active: true } });
      // An already-active payer's full-form save carrying active: true is not an activation and is never fenced.
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sending' });
      expect(await Payer.updatePayer(payer.id, { active: true, notes: 'unchanged' })).toMatchObject({ payer: { id: payer.id, active: true } });
    } finally {
      jest.restoreAllMocks();
      await mockPg('customers').where({ id: fixture.customerId }).update({ payer_id: null });
      await mockPg('invoices').where({ id: invoiceId }).del();
      await mockPg('payers').where({ id: payer.id }).del();
    }
  });

  test('a transient Bill-To re-judge failure leaves the preclaim for its token-owning worker to restore', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'sending', total: 120, visit_completion_packet_id: fixture.packetId,
      scheduled_send_at: new Date(Date.now() - 60000) });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failPacketRead(connection, query) {
      if (!interrupted && query.sql.startsWith('select "visit_id", "payload" from "visit_completion_packets"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic packet read outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      expect(await require('../services/invoice').sendViaSMSAndEmail(invoiceId, { allowClaimed: true })).toMatchObject({ ok: false, code: 'bill_to_fence_failed' });
      expect(interrupted).toBe(true);
      const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
      // sendViaSMSAndEmail does not own the scheduled worker's claim token;
      // processScheduledSends performs the guarded restore after this result.
      expect(invoice.status).toBe('sending');
      expect(invoice.scheduled_send_at).not.toBeNull();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(sendOne).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
  });

  test('a handoff whose claim moves no row never reaches the provider', async () => {
    // The pre-provider mark IS the send permit (audit P1): a row already
    // `sending` under another sender, or suppressed/deleted since it was
    // batched, must not produce a second provider request.
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'sms', triggered_by: 'auto' });
    try {
      let dispatched = false;
      const verdict = await Summary.reviewSendThroughSummaryHandoff(
        fixture.recordIds[0],
        async () => { dispatched = true; return { ok: true }; },
        undefined,
        { requestId: askId },
      );
      expect(verdict).toMatchObject({ ok: false, code: 'REVIEW_CLAIM_LOST' });
      expect(dispatched).toBe(false);
      // The other sender's claim is left exactly as it was.
      expect(await mockPg('review_requests').where({ id: askId }).first('status')).toMatchObject({ status: 'sending' });
    } finally {
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a claim taken over while the packet row was awaited never reaches the provider', async () => {
    // Waiting on the packet row can outlast the stranded-send window: the
    // reconciliation then releases this `sending` mark and another worker
    // claims the ask. The mark performed BEFORE the wait proves nothing by
    // then, so the exact claim is re-verified inside the transaction — and a
    // lost one is left to its new holder, never released back to pending.
    const askId = randomUUID();
    const reclaimedAt = new Date(Date.now() + 1000);
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'pending', token: randomUUID().replace(/-/g, ''), channel: 'sms', triggered_by: 'auto' });
    let releaseLock;
    const lockReleased = new Promise((resolve) => { releaseLock = resolve; });
    let lockHeld;
    const lockTaken = new Promise((resolve) => { lockHeld = resolve; });
    // Hold the packet row so the handoff's FOR SHARE blocks exactly where a
    // slow lock wait would, and take the ask over while it waits.
    const blocker = mockPg.transaction(async (trx) => {
      await trx('visit_completion_packets').where({ id: fixture.packetId }).forUpdate().first('id');
      lockHeld();
      await lockReleased;
    });
    try {
      await lockTaken;
      let dispatched = false;
      const handoff = Summary.reviewSendThroughSummaryHandoff(
        fixture.recordIds[0],
        async () => { dispatched = true; return { ok: true }; },
        undefined,
        { requestId: askId },
      );
      // The pre-provider mark runs before the transaction, so it has landed
      // by the time the handoff is blocked on the packet row.
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      expect(await mockPg('review_requests').where({ id: askId }).first('status')).toMatchObject({ status: 'sending' });
      await mockPg('review_requests').where({ id: askId }).update({ status: 'sending', claimed_at: reclaimedAt });
      releaseLock();
      await blocker;
      expect(await handoff).toMatchObject({ ok: false, code: 'REVIEW_CLAIM_LOST' });
      expect(dispatched).toBe(false);
      const row = await mockPg('review_requests').where({ id: askId }).first('status', 'claimed_at');
      expect(row.status).toBe('sending');
      expect(new Date(row.claimed_at).getTime()).toBe(reclaimedAt.getTime());
    } finally {
      releaseLock();
      await blocker.catch(() => {});
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a sender without the claim is told so even when the summary is uncertain', async () => {
    // Two workers loaded the same pending ask: the first marked it `sending`.
    // If the summary turns uncertain before the second reaches its handoff,
    // reporting a PARK would let the loser delete the winner's durable
    // marker — and the winner may already have reached the provider.
    const askId = randomUUID();
    await mockPg('review_requests').insert({ id: askId, customer_id: fixture.customerId, service_record_id: fixture.recordIds[0],
      status: 'sending', token: randomUUID().replace(/-/g, ''), claimed_at: new Date(), channel: 'sms', triggered_by: 'auto' });
    await mockPg('visit_effects').insert({ visit_id: fixture.visitId, effect_type: 'completion_sms',
      dedupe_key: `${fixture.visitId}:completion_sms:claimtest`, status: 'unknown_delivery', attempts: 1 });
    try {
      let dispatched = false;
      const verdict = await Summary.reviewSendThroughSummaryHandoff(
        fixture.recordIds[0],
        async () => { dispatched = true; return { ok: true }; },
        undefined,
        { requestId: askId },
      );
      expect(verdict).toMatchObject({ ok: false, code: 'REVIEW_CLAIM_LOST' });
      expect(dispatched).toBe(false);
      // The winner's claim is untouched — not released, not deleted.
      expect(await mockPg('review_requests').where({ id: askId }).first('status')).toMatchObject({ status: 'sending' });
    } finally {
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).del();
      await mockPg('review_requests').where({ id: askId }).del();
    }
  });

  test('a review email handoff shares the packet row so a bounce reconciliation waits for the send', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const ReviewService = require('../services/review-request');
    jest.spyOn(ReviewService, 'enrollPostService').mockResolvedValue({ started: true });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
    let blockedCode = null;
    // The library runs the provider request through the caller's handoff; the
    // bounce lands mid-request and must wait on the held packet row.
    jest.spyOn(require('../services/email-template-library'), 'sendTemplate').mockImplementation(async (opts) => {
      const verdict = await opts.withProviderHandoff(async () => {
        await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'bounced' });
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx);
        }).catch((err) => { blockedCode = err.code; });
        opts.onQueued?.({ id: randomUUID() });
      });
      return verdict.ok === true ? { sent: true } : { sent: false, blocked: true, code: verdict.code, reason: verdict.reason };
    });
    const request = { id: randomUUID(), service_record_id: fixture.recordIds[0], sequence_id: randomUUID(), sequence_step: 1 };
    // The handoff's pre-provider claim is a real pending→sending transition,
    // so the ask needs its durable row: a requestId that claims nothing is
    // refused before the provider (audit P1).
    await mockPg('review_requests').insert({ id: request.id, customer_id: fixture.customerId, service_record_id: request.service_record_id,
      status: 'pending', token: randomUUID().replace(/-/g, ''), channel: 'email', triggered_by: 'auto' });
    const args = { request, customer: { id: fixture.customerId, first_name: 'Fixture' }, contact: { email: fixture.primaryEmail, name: 'Fixture' },
      reviewUrl: 'https://portal.test/r', techName: 'Fixture', manageRetryVia: 'sequence' };
    expect(await ReviewService._sendOutreachEmail(args)).toMatchObject({ ok: true, sent: true, channel: 'email' });
    expect(blockedCode).toBe('55P03');
    // Once the bounce lands, the next email handoff parks the ask instead of
    // sending it. The row is put back to pending first: the send above
    // consumed the claim, and a second attempt in production is a fresh
    // pending ask, not a re-send of a claimed one.
    await mockPg('review_requests').where({ id: request.id }).update({ status: 'pending', claimed_at: null });
    await mockPg.transaction(async (trx) => { await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx); });
    expect(await ReviewService._sendOutreachEmail(args)).toMatchObject({ ok: false, deferred: true, reason: 'visit_summary_parked', channel: 'email' });
    // The suite's per-test cleanup drops the fixture customer; this ask row
    // holds a foreign key onto it.
    await mockPg('review_requests').where({ id: request.id }).del();
  });

  test('a bounce reconciliation serializes behind the packet close and alerts on the closed packet', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    const execute = mockPg.client.constructor.prototype._query;
    let blockedCode = null;
    let raced = false;
    let delivered;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function bounceDuringClose(connection, query) {
      if (!raced && query.sql.startsWith('update "visit_completion_packets"') && query.bindings.includes('done')) {
        raced = true;
        delivered = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}` }).first();
        await mockPg('email_messages').where({ id: delivered.id }).update({ status: 'bounced' });
        await mockPg.transaction(async (trx) => {
          await trx.raw("SET LOCAL lock_timeout = '200ms'");
          await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx);
        }).catch((err) => { blockedCode = err.code; });
      }
      return execute.call(this, connection, query);
    });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(raced).toBe(true);
    expect(blockedCode).toBe('55P03');
    jest.restoreAllMocks();
    // After the close commits, the bounce lands on the done packet: alert and parked outreach.
    await mockPg.transaction(async (trx) => {
      expect(await Summary.reconcileSummaryEmailBounce({ ...delivered, status: 'bounced' }, trx)).toEqual({ reconciled: true });
    });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    expect(await Summary.visitSummaryUncertainForRecord(fixture.recordIds[0])).toBe(true);
    expect(await Summary.visitSummaryUncertainForRecord(randomUUID())).toBe(false);
  });

  test('a recovery that settles the summary before the packet closes keeps the packet on recovery', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    sendOne.mockImplementationOnce(async () => { throw new Error('provider response unavailable'); });
    // The recovery lands after the delivery read and before the closing lock.
    const execute = mockPg.client.constructor.prototype._query;
    let raced = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(async function recoverBeforeClose(connection, query) {
      if (!raced && query.sql.startsWith('select * from "visit_completion_packets"') && query.sql.includes('for update')) {
        raced = true;
        const uncertain = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}`, status: 'failed' }).first();
        await mockPg('email_messages').where({ id: uncertain.id }).update({ status: 'sent', sent_at: new Date(), provider_message_id: 'recovered', error_message: null });
        expect(await Summary.reconcileSummaryEmailRecovery({ ...uncertain, status: 'sent' })).toEqual({ reconciled: true });
      }
      return execute.call(this, connection, query);
    });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 202, body: { state: 'effects_pending', delivery: { state: 'delivery_review' } } });
    expect(raced).toBe(true);
    expect(reviews).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', delivery: { state: 'delivered' } } });
    expect(require('../services/review-request').enrollPostService).toHaveBeenCalledTimes(1);
  });

  test('a recovery pass over an already closed visit preserves its original closure', async () => {
    const closedAt = new Date('2026-09-01T15:00:00Z');
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ status: 'closed', closed_at: closedAt, close_reason: 'completed' });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'processing', error: 'review_enrollment_pending' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ status: 'closed', closed_at: closedAt, close_reason: 'completed' });
  });

  test('a failed packet lookup for a paid invoice reopens the packet through the invoice link', async () => {
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ status: 'done' });
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'paid', visit_completion_packet_id: fixture.packetId });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failLookup(connection, query) {
      if (!interrupted && query.sql.startsWith('select "visit_completion_packet_id" from "invoices"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic invoice read outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      // The Stripe path passes the narrow projection without the packet link.
      expect(await require('../services/review-request').enrollForPaidInvoice({ id: invoiceId, customer_id: fixture.customerId }))
        .toMatchObject({ enrolled: false, retryable: true, reason: 'error', reopened: true });
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
    expect(interrupted).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first())
      .toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
  });

  test('a recovery delivery settles an in-flight bounce that finalized as unknown', async () => {
    sendOne.mockImplementationOnce(async ({ customArgs }) => {
      await mockPg('email_messages').where({ id: customArgs.email_message_id })
        .update({ status: 'bounced', bounced_at: new Date(), error_message: 'mailbox unavailable' });
      return { messageId: randomUUID() };
    });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_outcome_unknown' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    const original = await mockPg('email_messages').where({ recipient_id: fixture.customerId, status: 'bounced' }).first();
    const [recovery] = await mockPg('email_messages').insert({
      provider: 'sendgrid', template_key: 'service.visit_summary', trigger_event_id: `visit_summary:${fixture.visitId}`,
      recipient_type: 'customer', recipient_id: fixture.customerId, recipient_email_snapshot: 'corrected@example.invalid',
      idempotency_key: `bounce_recovery:${original.id}`, status: 'sent', sent_at: new Date(), provider_message_id: randomUUID(),
      send_attempt_token: randomUUID(), subject_snapshot: 'S', from_email_snapshot: 'contact@wavespestcontrol.com',
      from_name_snapshot: 'Waves', reply_to_snapshot: 'contact@wavespestcontrol.com',
      categories: JSON.stringify(['email_template', 'bounce_recovery']),
    }).returning('*');
    await mockPg('email_bounce_recoveries').insert({ original_message_id: original.id,
      recovery_message_id: recovery.id, bounced_email: original.recipient_email_snapshot,
      corrected_email: recovery.recipient_email_snapshot, customer_id: fixture.customerId, status: 'resent' });
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    await handleEmailMessageEvent({ event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, recovery);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
  });

  test('the full coordinator closes the visit and replay preserves one email per recipient', async () => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({
      status: 200, body: { state: 'done', payment: { state: 'no_charge' }, delivery: { state: 'delivered' } },
    });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first())
      .toMatchObject({ status: 'closed', close_reason: 'completed' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test('the coordinator records one office alert for uncertain delivery', async () => {
    sendOne.mockRejectedValueOnce(new Error('provider response unavailable'));
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required' } });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' })).toHaveLength(1);
    expect(sendOne).toHaveBeenCalledTimes(2);
  });

  test.each([undefined, false])('the canonical review default preserves an omitted field but honors %s', async (requested) => {
    await settledDelivery();
    for (const item of fixture.payload.items) item.body.requestReview = requested;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: requested !== false });
    expect(reviews).toHaveBeenCalledTimes(requested === false ? 0 : 1);
  });

  test('a thrown legacy review enrollment reopens a done packet for recovery', async () => {
    await settledDelivery();
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({
      status: 'done', payload: JSON.stringify(fixture.payload),
    });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    jest.spyOn(require('../services/review-request'), 'enrollPostService')
      .mockRejectedValueOnce(new Error('legacy database temporarily unavailable')).mockResolvedValue({ started: true });
    expect(await require('../services/review-request').enrollForPaidInvoice({ visit_completion_packet_id: fixture.packetId }))
      .toMatchObject({ retryable: true, reason: 'error' });
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first())
      .toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
  });

  test('review enrollment waits for a pending summary leg and never runs ahead of it', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 202, body: { state: 'effects_pending', delivery: { state: 'delivery_pending' } } });
    expect(reviews).not.toHaveBeenCalled();
    // The paid signal cannot enroll ahead of the summary either.
    expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: false, retryable: true, reason: 'delivery_pending' });
    expect(reviews).not.toHaveBeenCalled();
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', delivery: { state: 'delivered' } } });
    expect(reviews).toHaveBeenCalledTimes(1);
  });

  test('an uncertain summary delivery closes for office review without enrolling the review', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    fixture.payload.items[0].body.sendCompletionSms = true;
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    sendCustomerMessage.mockImplementationOnce(handoffSender(async () => { throw providerFailure(503); }));
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', delivery: { state: 'delivery_review' } } });
    expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: false, reason: 'delivery_review' });
    expect(reviews).not.toHaveBeenCalled();
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done' });
  });

  test('a paid signal before any delivery effect exists keeps the review behind the summary', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await require('../services/review-request').enrollForPaidInvoice({ visit_completion_packet_id: fixture.packetId }))
      .toMatchObject({ enrolled: false, retryable: true, reason: 'delivery_pending' });
    expect(reviews).not.toHaveBeenCalled();
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first())
      .toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(reviews).toHaveBeenCalledTimes(1);
  });

  test('a recovered summary email reopens the closed packet so the deferred review enrolls', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService').mockResolvedValue({ started: true });
    // One recipient's handoff is uncertain: the packet closes for office review without a review ask.
    sendOne.mockImplementationOnce(async () => { throw new Error('provider response unavailable'); });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'office_required', delivery: { state: 'delivery_review' } } });
    expect(reviews).not.toHaveBeenCalled();
    // The provider-retry rail later resends that recipient and reconciles it.
    const uncertain = await mockPg('email_messages').where({ trigger_event_id: `visit_summary:${fixture.visitId}`, status: 'failed' }).first();
    await mockPg('email_messages').where({ id: uncertain.id }).update({ status: 'sent', sent_at: new Date(), provider_message_id: 'recovered', error_message: null });
    expect(await Summary.reconcileSummaryEmailRecovery({ ...uncertain, status: 'sent' })).toEqual({ reconciled: true });
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first())
      .toMatchObject({ status: 'processing', error: 'review_enrollment_pending' });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done', delivery: { state: 'delivered' } } });
    expect(reviews).toHaveBeenCalledTimes(1);
  });

  test('an archived customer settles review enrollment instead of retrying it on every sweep', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    await mockPg('customers').where({ id: fixture.customerId }).update({ deleted_at: new Date() });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService');
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(await enrollVisitCompletionReview(fixture.packetId)).toEqual({ enrolled: false, reason: 'customer_archived' });
    expect(reviews).not.toHaveBeenCalled();
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'done', error: null });
  });

  test('a failed packet lookup for a legacy completion invoice preserves the representative-record enrollment', async () => {
    const invoiceId = randomUUID();
    await mockPg('invoices').insert({ id: invoiceId, token: randomUUID().replace(/-/g, ''), invoice_number: `FIX-${invoiceId.slice(0, 8)}`,
      customer_id: fixture.customerId, status: 'paid' });
    const execute = mockPg.client.constructor.prototype._query;
    let interrupted = false;
    jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function failLookup(connection, query) {
      if (!interrupted && query.sql.startsWith('select "visit_completion_packet_id" from "invoices"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic invoice read outage'));
      }
      return execute.call(this, connection, query);
    });
    try {
      // null hands the paid signal to the legacy path; no packet was reopened.
      expect(await require('../services/visit-completion-packets').enrollVisitCompletionReviewForInvoice(invoiceId)).toBeNull();
    } finally {
      await mockPg('invoices').where({ id: invoiceId }).del();
    }
    expect(interrupted).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: fixture.packetId }).first()).toMatchObject({ status: 'processing', error: null });
  });

  test('review enrollment retries through the saved packet and stays suppressed for partial outcomes', async () => {
    fixture.payload.items.forEach((item) => { item.body.requestReview = true; });
    await mockPg('visit_completion_packets').where({ id: fixture.packetId }).update({ payload: JSON.stringify(fixture.payload) });
    await mockPg('service_records').whereIn('id', fixture.recordIds).update({
      structured_notes: JSON.stringify({ visitOutcome: 'completed', typedReportDelivery: 'auto_send', requestReview: true }),
    });
    const reviews = jest.spyOn(require('../services/review-request'), 'enrollPostService')
      .mockResolvedValueOnce({ started: false, reason: 'plan_resolution_failed' }).mockResolvedValue({ started: true });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 202, body: { state: 'effects_pending' } });
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    expect(sendOne).toHaveBeenCalledTimes(2);
    expect(reviews).toHaveBeenCalledWith(expect.objectContaining({ serviceRecordId: fixture.recordIds[0] }));
    await mockPg('service_records').where({ id: fixture.recordIds[1] }).update({
      structured_notes: JSON.stringify({ visitOutcome: 'incomplete', requestReview: false }),
    });
    expect(await enrollVisitCompletionReview(fixture.packetId)).toMatchObject({ enrolled: false, reason: 'visit_outcome' });
    expect(reviews).toHaveBeenCalledTimes(2);
  });

  // Codex #4303 r6 P2: the handoff's pre-provider marker clears before the
  // provider request, so a throw from the request itself (the only way a
  // deferred SMS reaches this hook parked at unknown_delivery) leaves no
  // further proof recorded on the row. A synchronous, definitive Twilio
  // rejection (a terminal code) is proof the scheduler already has; the
  // hook must accept it instead of leaving the leg unknown forever.
  test('the deferred SMS terminal hook leaves an unknown-delivery leg unknown without proof of a definitive rejection', async () => {
    await priorClaim('completion_sms', { status: 'unknown_delivery', claim_token: 'claim-no-proof', last_error: 'provider_outcome_unknown' });
    await Summary.terminalDeferredSummarySms({ visit_id: fixture.visitId, visit_summary_claim_token: 'claim-no-proof' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
  });

  test('the deferred SMS terminal hook settles as suppressed when the scheduler proves a synchronous terminal provider rejection', async () => {
    await priorClaim('completion_sms', { status: 'unknown_delivery', claim_token: 'claim-terminal', last_error: 'provider_outcome_unknown' });
    await Summary.terminalDeferredSummarySms({ visit_id: fixture.visitId, visit_summary_claim_token: 'claim-terminal', provider_terminal_rejection: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  // Codex #4303 r6 P2: a recipient-generated event (unsubscribe, group
  // unsubscribe, spam report) proves the recipient received the message —
  // the same sent evidence as opened/clicked — so a still-bounced sibling
  // recipient's later correction can settle the aggregate.
  test.each(['unsubscribed', 'spam_report'])('a recipient %s after delivery counts as sent evidence, letting a sibling bounce correction settle the aggregate', async (postDeliveryStatus) => {
    const bounced = fixture.primaryEmail;
    const other = fixture.serviceEmail;
    await priorEmail(bounced, { status: 'sent', sent_at: new Date() });
    await priorEmail(other, { status: postDeliveryStatus });
    const [effect] = await mockPg('visit_effects').insert({ visit_id: fixture.visitId, effect_type: 'completion_email',
      dedupe_key: `${fixture.visitId}:completion_email`, claim_token: 'owner', status: 'sent', sent_at: new Date() }).returning('*');
    // The bounce reopens the aggregate exactly as reconcileSummaryEmailBounce does.
    await mockPg('email_messages').where({ recipient_email_snapshot: bounced, trigger_event_id: `visit_summary:${fixture.visitId}` })
      .update({ status: 'bounced', bounced_at: new Date() });
    await mockPg('visit_effects').where({ id: effect.id }).update({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    // The bounce is now corrected — a delivery event proves the recipient received it.
    await mockPg('email_messages').where({ recipient_email_snapshot: bounced, trigger_event_id: `visit_summary:${fixture.visitId}` })
      .update({ status: 'delivered', delivered_at: new Date() });
    const message = { trigger_event_id: `visit_summary:${fixture.visitId}`, template_key: 'service.visit_summary',
      recipient_id: fixture.customerId, recipient_email_snapshot: bounced };
    expect(await Summary.reconcileSummaryEmailRecovery(message)).toEqual({ reconciled: true });
    expect(await mockPg('visit_effects').where({ id: effect.id }).first()).toMatchObject({ status: 'sent', last_error: null });
  });
});
