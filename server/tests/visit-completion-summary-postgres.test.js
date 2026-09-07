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
jest.mock('../services/sendgrid-mail', () => ({ sendOne: jest.fn(), serviceGroupId: () => null, newsletterGroupId: () => null }));
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

postgres('visit summary recipient recovery', () => {
  beforeAll(async () => {
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(new URL(connection).pathname)) throw new Error('Use a task-private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.restoreAllMocks();
    sendOne.mockReset().mockImplementation(async () => ({ messageId: randomUUID() }));
    sendCustomerMessage.mockReset().mockImplementation(async ({ preDispatchCheck }) => ({ sent: (await preDispatchCheck()).ok }));
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
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: true });
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: false });
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
    sendCustomerMessage.mockImplementation(async ({ preDispatchCheck }) => ({
      sent: (await preDispatchCheck()).ok, providerMessageId: 'fixture-scheduled-provider-id',
    }));
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
    if (change === 'contact') await mockPg('customers').where({ id: fixture.customerId }).update({ service_contact_phone: '+12025550125' });
    if (change === 'consent') await mockPg('customers').where({ id: fixture.customerId }).update({ service_contacts_consent_at: null });
    if (change === 'revocation') await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: false });
    expect(await replay.onTerminalDeferredReplay('visit_summary_deferred', queued.metadata)).toEqual({ ok: true });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test('revocation between replay validation and the atomic dispatch claim still blocks sending', async () => {
    const queued = await heldSummary();
    const execute = mockPg.client._query;
    let revoked = false;
    jest.spyOn(mockPg.client, '_query').mockImplementation(async function revokeBeforeClaim(connection, query) {
      if (!revoked && query.sql.startsWith('update "visit_effects"') && query.bindings.includes('unknown_delivery')) {
        revoked = true;
        await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_revoked_at: new Date() });
      }
      return execute.call(this, connection, query);
    });
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: false });
    expect(revoked).toBe(true);
  });

  test('an ambiguous scheduled provider handoff cannot resend and reaches office review', async () => {
    const queued = await heldSummary();
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: true });
    expect(await replay.recheckDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ eligible: false });
    expect(await replay.onTerminalDeferredReplay('visit_summary_deferred', queued.metadata)).toEqual({ ok: true });
    expect(await deliver()).toEqual({ state: 'delivery_review' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a proven provider-boundary quiet-hours hold can retry its pending scheduled handoff', async () => {
    const queued = await heldSummary();
    const replay = require('../services/messaging/deferred-replay-registry');
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', queued.metadata)).toMatchObject({ ok: true });
    const effect = await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).first();
    const heldMeta = { ...queued.metadata, quiet_hours_hold_at: new Date(new Date(effect.claimed_at).getTime() + 1).toISOString() };
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', heldMeta)).toMatchObject({ ok: true });
    expect(await replay.preDispatchDeferredReplay('visit_summary_deferred', heldMeta)).toMatchObject({ ok: false });
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
    const execute = mockPg.client._query;
    let checkingFinal = false;
    let interrupted = false;
    jest.spyOn(mockPg.client, '_query').mockImplementation(function failFinalRead(connection, query) {
      if (checkingFinal && !interrupted && query.sql.startsWith('select "id" from "service_visits"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic final recheck outage'));
      }
      return execute.call(this, connection, query);
    });
    let providerCalls = 0;
    sendCustomerMessage.mockImplementation(async ({ preDispatchCheck }) => {
      checkingFinal = true;
      const verdict = await preDispatchCheck();
      checkingFinal = false;
      if (!verdict.ok) return { sent: false, blocked: true, code: verdict.code, retryable: verdict.retryable };
      providerCalls += 1;
      return { sent: true, providerMessageId: 'fixture-scheduled-provider-id' };
    });
    await mockPg('sms_log').where({ id: queued.id }).update({ scheduled_for: new Date(0) });
    require('../services/logger').error.mockClear();
    await tick();
    expect(providerCalls).toBe(0);
    expect(require('../services/logger').error.mock.calls).toEqual([]);
    expect(await mockPg('sms_log').where({ id: queued.id }).first()).toMatchObject({
      status: 'scheduled', metadata: { provider_retry_code: 'DEFERRED_RECHECK_FAILED' },
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
    sendOne.mockImplementationOnce(async () => {
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' })
        .update({ claimed_at: new Date(Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS - 1000) });
      const member = await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first();
      recoveredToken = (await VisitGroups.claimVisitNotification(member, 'completion_email')).token;
      return { messageId: 'fixture-first-recipient' };
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
    sendCustomerMessage.mockImplementationOnce(async ({ preDispatchCheck }) => {
      expect((await preDispatchCheck()).ok).toBe(true);
      throw new Error('provider response unavailable');
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
