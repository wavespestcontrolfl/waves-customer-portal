/** Summary delivery recovery on a migrated, task-private PostgreSQL database. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => null) }));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => null) }));
jest.mock('../services/sendgrid-mail', () => ({ sendOne: jest.fn(), clearBlockedAddress: jest.fn(async () => {}), serviceGroupId: () => null, newsletterGroupId: () => null }));
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
        if (typeof onProviderStart === 'function') onProviderStart();
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
      await withSmsHandoff(async (_trx, onProviderStart) => { onProviderStart(); throw new Error('provider response unavailable'); });
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
        onProviderStart();
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
      expect(await deferredHandoff(queued.metadata, async (_trx, onProviderStart) => { onProviderStart(); providerCalls += 1; return { ok: true }; })).toMatchObject({ ok: true });
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

  test('a resend from the provider-retry rail settles a bounced summary back to delivered', async () => {
    expect(await runVisitCompletionPacketEffects(fixture.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const messages = await mockPg('email_messages').where({ recipient_id: fixture.customerId }).orderBy('id');
    const { handleEmailMessageEvent } = require('../routes/webhooks-sendgrid');
    for (const message of messages) {
      // A provider block (not a bad mailbox): the webhook schedules the
      // existing transactional retry instead of suppressing the address.
      await handleEmailMessageEvent({ event: 'blocked', reason: '550 temporarily deferred', type: 'blocked',
        timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, message);
    }
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    // The existing rail retries one blocked recipient and the provider accepts it.
    expect(await mockPg('email_messages').where({ id: messages[0].id }).first()).toMatchObject({ status: 'failed' });
    await mockPg('email_messages').where({ id: messages[0].id }).update({ provider_retry_next_at: new Date(Date.now() - 1000) });
    await mockPg('email_messages').where({ id: messages[1].id }).update({ provider_retry_next_at: null });
    sendOne.mockClear();
    // The inline reconciliation after the resend fails transiently: the
    // message is sent and off the rail, so the delivery webhook must settle it.
    jest.spyOn(Summary, 'reconcileSummaryEmailRecovery').mockRejectedValueOnce(new Error('Synthetic reconcile outage'));
    expect(await require('../services/transactional-email-provider-retry').runDueRetries()).toMatchObject({ claimed: 1, sent: 1 });
    expect(require('../services/logger').warn.mock.calls.filter(([m]) => /summary recovery/.test(m))).toHaveLength(1);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    const resent = await mockPg('email_messages').where({ id: messages[0].id }).first();
    await handleEmailMessageEvent({ event: 'delivered', timestamp: Math.floor(Date.now() / 1000), sg_event_id: randomUUID() }, resent);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
    await mockPg('email_messages').where({ id: messages[1].id }).update({ provider_retry_next_at: new Date(Date.now() - 1000) });
    expect(await require('../services/transactional-email-provider-retry').runDueRetries()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(0);
    const { getCloseoutStatus } = require('../services/closeout-status');
    expect((await getCloseoutStatus(fixture.serviceIds[0])).facts.reportDelivery).toMatchObject({ state: 'done' });
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
    // The leg stays on office review: the bounce alert and the reopened effect remain.
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
      .toMatchObject({ status: 'unknown_delivery', last_error: 'provider_bounce' });
    expect(await mockPg('dispatch_alerts').where({ tech_id: fixture.techId, type: 'visit_closeout_review' }).whereNull('resolved_at')).toHaveLength(1);
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
});
