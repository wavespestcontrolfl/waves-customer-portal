/** Summary delivery recovery on a migrated, task-private PostgreSQL database. */
jest.mock('../models/marker-db', () => () => require('../models/db'));
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

});
