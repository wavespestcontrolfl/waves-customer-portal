// Real recovery behavior in a rollback-only transaction on disposable/owned PostgreSQL.
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
const suggest = require('../services/sms-suggest-mode');
const autoSend = require('../services/sms-auto-send');
const providerCoordination = require('../services/messaging/provider-handoff-reservation');
const { gratitudeThreadAdvanced } = require('../services/sms-gratitude-context');
jest.setTimeout(30000);

postgres('uncertain SMS reply holding recovery on PostgreSQL', () => {
  let database;
  let trx;
  let schema;
  const old = () => new Date(Date.now() - 2 * 60 * 60 * 1000);
  // Past the 72-hour ask-spacing window review-ask-history reads back to.
  const pastAskSpacingWindow = () => new Date(Date.now() - 73 * 60 * 60 * 1000);

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    schema = `sms_reply_recovery_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['sms_log', 'agent_decisions', 'message_drafts']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function decision({ workflow = suggest.SUGGEST_WORKFLOW, status = 'scheduled', message = 'Thanks for checking in.' } = {}) {
    const [row] = await trx('agent_decisions').insert({
      id: randomUUID(), workflow, agent_name: 'synthetic-recovery-test', decision_version: 'test-v1',
      mode: workflow === autoSend.AUTOSEND_WORKFLOW ? autoSend.AUTOSEND_MODE : 'suggest',
      status, entity_type: 'message_draft', source_channel: 'sms', suggested_message: message,
      idempotency_key: `${workflow}:${randomUUID()}`, created_at: old(), updated_at: old(),
    }).returning('*');
    return row;
  }

  async function uncertainReservation({ kind, used, parked }) {
    const id = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body: used.suggested_message,
      agentDecisionId: used.id, parkedDecisionIds: [parked.id], reservationKind: kind, uncertain: true,
    });
    await trx('sms_log').where({ id }).update({ created_at: old(), updated_at: old() });
    return id;
  }

  async function providerEvidence({ used, parked }) {
    await trx('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: used.suggested_message, twilio_sid: `SM${randomUUID().replaceAll('-', '')}`,
      status: 'sent', message_type: 'manual',
      metadata: { agent_decision_id: used.id, parked_decision_ids: [parked.id] },
    });
  }

  async function noCardManualReservation({ ageMinutes, wrapper }) {
    const id = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body: 'No linked suggestion.',
      reservationKind: 'manual', uncertain: true, manualWrapperReservation: wrapper,
    });
    const agedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
    await trx('sms_log').where({ id }).update({ created_at: agedAt, updated_at: agedAt });
    return id;
  }

  async function acceptedReservation({ kind, body, providerMessageId = null }) {
    const id = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body,
      reservationKind: kind, uncertain: true,
    });
    expect(await suggest.settleReplyHoldingReservation({
      reservationId: id,
      acceptedResult: providerMessageId ? { providerMessageId } : {},
    })).toBe(true);
    return id;
  }

  async function acceptedProviderHandle(body) {
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body, messageType: 'manual',
    });
    providerCoordination.recordProviderOutcome(prepared.handle, {
      deliveryOutcome: 'accepted', providerMessageId: `SM${'c'.repeat(32)}`, channel: 'sms',
    });
    return prepared.handle;
  }

  test('provider coordination preserves exact accepted SMS evidence when the ordinary provider row is missing', async () => {
    const adminUserId = randomUUID();
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '(202) 555-0101', fromNumber: '+19413529161', body: 'Draft body',
      messageType: 'estimate_service_details', adminUserId,
    });
    expect(prepared.blocked).not.toBe(true);
    const reservedAt = new Date(Date.now() - 10000);
    const inboundAt = new Date(Date.now() - 5000);
    const providerAcceptedAt = new Date(Date.now() - 1000);
    await trx('sms_log').where({ id: prepared.handle.reservationId }).update({ created_at: reservedAt });
    providerCoordination.captureProviderContext(prepared.handle, {
      to: '+12025550101', fromNumber: '+19413529161', body: 'Final normalized body',
      messageType: 'estimate_service_details', channel: 'sms', providerAcceptedAt,
      metadata: { pre_handoff_stamp: true },
    });
    const sid = `SM${'a'.repeat(32)}`;
    providerCoordination.recordProviderOutcome(prepared.handle, {
      deliveryOutcome: 'accepted', providerMessageId: sid, channel: 'sms',
    });
    expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);

    const row = await trx('sms_log').where({ id: prepared.handle.reservationId }).first();
    expect(row).toMatchObject({
      from_phone: '+19413529161', to_phone: '+12025550101', message_body: 'Final normalized body',
      message_type: 'estimate_service_details', status: 'sent', twilio_sid: sid, admin_user_id: adminUserId,
    });
    expect(row.created_at.getTime()).toBe(providerAcceptedAt.getTime());
    expect(row.created_at.getTime()).toBeGreaterThan(inboundAt.getTime());
    expect(row.metadata).toMatchObject({
      provider_handoff_reservation: true, provider_outcome: 'accepted',
      provider_channel: 'sms', pre_handoff_stamp: true,
    });
  });

  test('a caller-owned reservation is borrowed without duplication and receives the actual provider context', async () => {
    const adminUserId = randomUUID();
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body: 'Draft body',
      messageType: 'manual', adminUserId, reservationKind: 'manual', uncertain: true,
    });
    const handle = providerCoordination.borrowProviderHandoffReservation({
      reservationId, to: '+12025550101', fromNumber: '+19413529161', body: 'Draft body',
      messageType: 'manual', adminUserId,
    });
    const providerAcceptedAt = new Date(Date.now() - 1000);
    providerCoordination.captureProviderContext(handle, {
      to: '+12025550101', fromNumber: '+19413529161', body: 'Final normalized body',
      messageType: 'manual', channel: 'sms', providerAcceptedAt,
    });
    const sid = `SM${'d'.repeat(32)}`;
    providerCoordination.recordProviderOutcome(handle, {
      deliveryOutcome: 'accepted', providerMessageId: sid, channel: 'sms',
    });
    expect(await providerCoordination.settleProviderHandoffReservation(handle)).toBe(true);
    expect(await trx('sms_log').where({ id: reservationId }).first('status')).toMatchObject({ status: 'sending' });

    const acceptedResult = providerCoordination.attachReservationContext(handle, {
      sent: true, deliveryOutcome: 'accepted', providerMessageId: sid,
    });
    expect(Object.keys(acceptedResult)).not.toContain('reservationContext');
    expect(await suggest.settleReplyHoldingReservation({ reservationId, acceptedResult })).toBe(true);

    const rows = await trx('sms_log').where({ to_phone: '+12025550101' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: reservationId, status: 'sent', twilio_sid: sid, message_body: 'Final normalized body',
      from_phone: '+19413529161', message_type: 'manual', admin_user_id: adminUserId,
    });
    expect(rows[0].created_at.getTime()).toBe(providerAcceptedAt.getTime());
  });

  test('a failed accepted promotion retries inside the shared settlement attempt', async () => {
    const handle = await acceptedProviderHandle('Retry accepted promotion');
    const realSettle = suggest.settleReplyHoldingReservation;
    const settleSpy = jest.spyOn(suggest, 'settleReplyHoldingReservation');
    let failPromotion = true;
    settleSpy.mockImplementation((input) => {
      if (input.acceptedResult && failPromotion) {
        failPromotion = false;
        return Promise.resolve(false);
      }
      return realSettle(input);
    });
    try {
      expect(await providerCoordination.settleProviderHandoffReservation(handle)).toBe(true);
      expect(await trx('sms_log').where({ id: handle.reservationId }).first('status')).toMatchObject({ status: 'sent' });
      expect(settleSpy).toHaveBeenCalledTimes(3);
    } finally {
      settleSpy.mockRestore();
    }
  });

  test('concurrent settlement callers share one promotion and cleanup attempt', async () => {
    const handle = await acceptedProviderHandle('Concurrent settlement');
    const realSettle = suggest.settleReplyHoldingReservation;
    let releasePromotion;
    const settleSpy = jest.spyOn(suggest, 'settleReplyHoldingReservation')
      .mockImplementationOnce(input => new Promise((resolve) => {
        releasePromotion = () => realSettle(input).then(resolve);
      }))
      .mockImplementation(input => realSettle(input));
    try {
      const first = providerCoordination.settleProviderHandoffReservation(handle);
      const second = providerCoordination.settleProviderHandoffReservation(handle);
      expect(second).toBe(first);
      expect(settleSpy).toHaveBeenCalledTimes(1);
      releasePromotion();
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(settleSpy).toHaveBeenCalledTimes(2);
    } finally {
      settleSpy.mockRestore();
    }
  });

  test('a cleanup failure retries cleanup without re-promoting the accepted reservation', async () => {
    const handle = await acceptedProviderHandle('Retry accepted cleanup');
    const realSettle = suggest.settleReplyHoldingReservation;
    let failCleanup = true;
    let promotionCalls = 0;
    const settleSpy = jest.spyOn(suggest, 'settleReplyHoldingReservation').mockImplementation((input) => {
      if (input.acceptedResult) {
        promotionCalls += 1;
        return realSettle(input);
      }
      if (failCleanup) {
        failCleanup = false;
        return Promise.resolve(false);
      }
      return realSettle(input);
    });
    try {
      expect(await providerCoordination.settleProviderHandoffReservation(handle)).toBe(false);
      expect(await trx('sms_log').where({ id: handle.reservationId }).first('status')).toMatchObject({ status: 'sent' });
      expect(await providerCoordination.settleProviderHandoffReservation(handle)).toBe(true);
      expect(promotionCalls).toBe(1);
    } finally {
      settleSpy.mockRestore();
    }
  });

  test('provider coordination removes only a duplicate accepted SMS reservation', async () => {
    const sid = `MM${'b'.repeat(32)}`;
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body: 'Photo caption', messageType: 'manual',
    });
    await trx('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: 'Photo caption', message_type: 'manual', status: 'sent', twilio_sid: sid,
      metadata: {},
    });
    providerCoordination.captureProviderContext(prepared.handle, {
      to: '+12025550101', fromNumber: '+19413529161', body: 'Photo caption',
      messageType: 'manual', channel: 'sms',
    });
    providerCoordination.recordProviderOutcome(prepared.handle, {
      deliveryOutcome: 'accepted', providerMessageId: sid, channel: 'sms',
    });
    expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);
    expect(await trx('sms_log').where({ id: prepared.handle.reservationId }).first()).toBeUndefined();
  });

  test.each(['none', 'ordinary', 'scheduled', 'unmarked phone'])('accepted push coordination with %s proof preserves exactly one valid receipt', async (proofKind) => {
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body: 'Push body', messageType: 'receipt',
    });
    const providerAcceptedAt = new Date();
    if (proofKind !== 'none') {
      await trx('sms_log').insert({
        id: randomUUID(), direction: 'outbound', from_phone: proofKind === 'ordinary' ? 'push' : '+19413180000', to_phone: '+12025550101',
        message_body: 'Push body', message_type: 'receipt', status: 'sent', twilio_sid: null, created_at: providerAcceptedAt,
        metadata: { channel: 'push', providerAccepted: true,
          ...(proofKind === 'scheduled' ? { push_settled_without_proof: true } : {}) },
      });
    }
    providerCoordination.captureProviderContext(prepared.handle, {
      to: '+12025550101', fromNumber: 'push', body: 'Push body', messageType: 'receipt',
      channel: 'push', providerAcceptedAt, metadata: { channel: 'push', providerAccepted: true, provider_from_number: '+19413529161' },
    });
    providerCoordination.recordProviderOutcome(prepared.handle, {
      deliveryOutcome: 'accepted', providerMessageId: 'push:notification-1', channel: 'push',
    });
    expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);
    const reservation = await trx('sms_log').where({ id: prepared.handle.reservationId }).first();
    if (['ordinary', 'scheduled'].includes(proofKind)) expect(reservation).toBeUndefined();
    else expect(reservation).toMatchObject({ from_phone: 'push', status: 'sent', twilio_sid: null });
  });

  test.each(['ordinary proof', 'promoted sole receipt', 'scheduled fallback'].flatMap(kind => [
    [kind, 'after the inbound on the same thread', 60000, '+19413529161', '+12025550101', true],
    [kind, 'before the inbound', -60000, '+19413529161', '+12025550101', false],
    [kind, 'from another Waves endpoint', 60000, '+19413529162', '+12025550101', false],
    [kind, 'to another recipient', 60000, '+19413529161', '+12025550102', false],
  ]))('%s %s advances only the exact gratitude thread', async (
    kind, _case, proofOffsetMs, providerFromNumber, recipient, advanced,
  ) => {
    const inboundId = randomUUID();
    const inboundAt = new Date(Date.now() - 2 * 60 * 1000);
    await trx('sms_log').insert({
      id: inboundId, direction: 'inbound', from_phone: '+12025550101', to_phone: '+19413529161',
      message_body: 'Thank you!', message_type: 'inbound', status: 'received', created_at: inboundAt,
      metadata: {},
    });
    const proofAt = new Date(inboundAt.getTime() + proofOffsetMs);
    if (kind === 'ordinary proof') {
      await trx('sms_log').insert({
        id: randomUUID(), direction: 'outbound', from_phone: 'push', to_phone: recipient,
        message_body: 'Our pleasure!', message_type: 'receipt', status: 'sent', created_at: proofAt,
        metadata: {
          channel: 'push', providerAccepted: true, provider_from_number: providerFromNumber,
        },
      });
    } else if (kind === 'promoted sole receipt') {
      const prepared = await providerCoordination.prepareProviderHandoffReservation({
        to: recipient, fromNumber: providerFromNumber, body: 'Our pleasure!', messageType: 'receipt',
      });
      providerCoordination.captureProviderContext(prepared.handle, {
        to: recipient, fromNumber: 'push', body: 'Our pleasure!', messageType: 'receipt',
        channel: 'push', providerAcceptedAt: proofAt,
        metadata: { channel: 'push', providerAccepted: true, provider_from_number: providerFromNumber },
      });
      providerCoordination.recordProviderOutcome(prepared.handle, {
        deliveryOutcome: 'accepted', providerMessageId: `push:${randomUUID()}`, channel: 'push',
      });
      expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);
    } else {
      // When the ordinary proof insert fails, attemptPushFirst promotes the
      // existing scheduled row. Its queued From may differ from the endpoint
      // actually selected at delivery, so the trusted metadata is decisive.
      await trx('sms_log').insert({
        id: randomUUID(), direction: 'outbound', from_phone: '+19419999999', to_phone: recipient,
        message_body: 'Our pleasure!', message_type: 'receipt', status: 'sent', created_at: proofAt,
        metadata: {
          channel: 'push', providerAccepted: true, push_settled_without_proof: true,
          provider_from_number: providerFromNumber,
        },
      });
    }

    await expect(gratitudeThreadAdvanced(trx, {
      inboundId, fromPhone: '+12025550101', toPhone: '+19413529161',
    })).resolves.toBe(advanced);
  });

  test.each(['ordinary', 'scheduled'].flatMap(kind => [
    ['an older matching', 'notification-1', -60 * 60 * 1000, true],
    ['an older different', 'notification-2', -60 * 60 * 1000, false],
    ['a same-window different', 'notification-2', 0, false],
  ].map(values => [kind, ...values])))('a %s push proof with %s notification identity removes only a true dedup reservation', async (kind, _label, proofNotificationId, proofOffsetMs, removed) => {
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body: 'Deduped push body', messageType: 'receipt',
    });
    const reservationCreatedAt = new Date(Date.now() - 1000);
    await trx('sms_log').where({ id: prepared.handle.reservationId }).update({
      created_at: reservationCreatedAt,
      updated_at: reservationCreatedAt,
    });
    await trx('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: kind === 'ordinary' ? 'push' : '+19413180000', to_phone: '+12025550101',
      message_body: 'Deduped push body', message_type: 'receipt', status: 'sent', twilio_sid: null,
      created_at: new Date(reservationCreatedAt.getTime() + proofOffsetMs),
      metadata: { channel: 'push', providerAccepted: true, push_notification_id: proofNotificationId,
        ...(kind === 'scheduled' ? { push_settled_without_proof: true } : {}) },
    });
    providerCoordination.captureProviderContext(prepared.handle, {
      to: '+12025550101', fromNumber: 'push', body: 'Deduped push body', messageType: 'receipt',
      channel: 'push', metadata: { channel: 'push', providerAccepted: true, push_notification_id: 'notification-1' },
    });
    providerCoordination.recordProviderOutcome(prepared.handle, {
      deliveryOutcome: 'accepted', providerMessageId: 'push:notification-1', channel: 'push',
    });
    expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);
    expect(Boolean(await trx('sms_log').where({ id: prepared.handle.reservationId }).first())).toBe(!removed);
  });

  test.each([
    [23, true],
    [25, false],
  ])('provider uncertainty aged %sh is retained only inside the reconciliation window', async (hours, retained) => {
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body: 'Maybe sent', messageType: 'manual',
    });
    providerCoordination.recordProviderOutcome(prepared.handle, { deliveryOutcome: 'uncertain' });
    expect(await providerCoordination.settleProviderHandoffReservation(prepared.handle)).toBe(true);
    const agedAt = new Date(Date.now() - hours * 60 * 60 * 1000);
    await trx('sms_log').where({ id: prepared.handle.reservationId }).update({ created_at: agedAt, updated_at: agedAt });
    await suggest.recoverSuggestionHoldingStates();
    expect(await trx('sms_log').where({ id: prepared.handle.reservationId }).first()).toBeDefined();
    await expect(autoSend.reconcileAutoSendClaims()).resolves.toMatchObject({ reservationsCleared: retained ? 0 : 1 });
    expect(Boolean(await trx('sms_log').where({ id: prepared.handle.reservationId }).first())).toBe(retained);
  });

  async function agedAutoClaimReservation({ reservationAgeHours, accepted = false }) {
    const customerId = randomUUID();
    const inboundId = randomUUID();
    await trx('sms_log').insert({
      id: inboundId, customer_id: customerId, direction: 'inbound',
      from_phone: '+12025550101', to_phone: '+19413529161', message_body: 'Thanks!',
      status: 'received', metadata: {}, created_at: old(), updated_at: old(),
    });
    const used = await decision({ workflow: autoSend.AUTOSEND_WORKFLOW, status: autoSend.CLAIM_STATUS });
    await trx('agent_decisions').where({ id: used.id }).update({
      customer_id: customerId, sms_log_id: inboundId, updated_at: old(),
    });
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', customerId, fromNumber: '+19413529161', body: 'Our pleasure!',
      agentDecisionId: used.id, reservationKind: 'auto', uncertain: true,
    });
    if (accepted) {
      expect(await suggest.settleReplyHoldingReservation({
        reservationId,
        acceptedResult: { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'9'.repeat(32)}` },
      })).toBe(true);
    } else {
      const agedAt = new Date(Date.now() - reservationAgeHours * 60 * 60 * 1000);
      await trx('sms_log').where({ id: reservationId }).update({ created_at: agedAt, updated_at: agedAt });
    }
    return { customerId, reservationId };
  }

  test.each([
    ['a provider-uncertain reservation newer than 24 hours', { reservationAgeHours: 1 }, true],
    ['an accepted provider receipt', { reservationAgeHours: 1, accepted: true }, false],
    ['a provider-uncertain reservation older than 24 hours', { reservationAgeHours: 25 }, false],
  ])('%s controls an auto claim older than the five-minute fast window', async (_label, fixture, expected) => {
    const { customerId } = await agedAutoClaimReservation(fixture);
    await expect(autoSend.hasActiveAutoSendClaim(trx, {
      threadLast10: '2025550101', customerId,
    })).resolves.toBe(expected);
  });

  test('provider expiration keeps a live linked decision and accounts for cleanup only after release', async () => {
    const held = await decision();
    await trx('agent_decisions').where({ id: held.id }).update({ updated_at: new Date() });
    const prepared = await providerCoordination.prepareProviderHandoffReservation({
      to: '+12025550101', fromNumber: '+19413529161', body: 'Pending owner', messageType: 'manual',
    });
    const agedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await trx('sms_log').where({ id: prepared.handle.reservationId }).update({
      created_at: agedAt, updated_at: agedAt,
      metadata: { provider_handoff_reservation: true, provider_outcome_uncertain: true, agent_decision_id: held.id },
    });
    await suggest.recoverSuggestionHoldingStates();
    await expect(autoSend.reconcileAutoSendClaims()).resolves.toMatchObject({ reservationsCleared: 0 });
    expect(await trx('sms_log').where({ id: prepared.handle.reservationId }).first()).toBeDefined();
    await trx('agent_decisions').where({ id: held.id }).update({ status: 'pending_review' });
    await expect(autoSend.reconcileAutoSendClaims()).resolves.toMatchObject({ reservationsCleared: 1 });
    expect(await trx('sms_log').where({ id: prepared.handle.reservationId }).first()).toBeUndefined();
  });

  test.each([
    ['ordinary unmarked uncertainty keeps the old 30-minute cleanup behavior', 31, false, 1, false],
    ['wrapper uncertainty survives cleanup inside the 24-hour retry hold', 31, true, 0, true],
    ['wrapper uncertainty is released after the 24-hour retry hold', 25 * 60, true, 1, false],
  ])('%s', async (_label, ageMinutes, wrapper, reservationsCleared, survives) => {
    const reservationId = await noCardManualReservation({ ageMinutes, wrapper });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 }))
      .toMatchObject({ reservationsCleared });
    const row = await trx('sms_log').where({ id: reservationId }).first('id');
    expect(Boolean(row)).toBe(survives);
  });

  test('a sent reservation without accepted provider evidence remains cleanup eligible', async () => {
    const reservationId = await noCardManualReservation({ ageMinutes: 31, wrapper: false });
    await trx('sms_log').where({ id: reservationId }).update({ status: 'sent' });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 }))
      .toMatchObject({ reservationsCleared: 1 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });

  test.each([
    ['manual acceptance without a copied SID', 'manual', null],
    ['auto-send acceptance with an exact SID', 'auto', `SM${'a'.repeat(32)}`],
  ])('sole %s survives explicit cleanup and the sweep past 24 hours', async (_label, kind, providerMessageId) => {
    const reservationId = await acceptedReservation({
      kind, providerMessageId, body: `Sole accepted receipt ${kind}`,
    });

    await suggest.settleReplyHoldingReservation({ reservationId });
    expect(await trx('sms_log').where({ id: reservationId }).first('status', 'twilio_sid'))
      .toMatchObject({ status: 'sent', twilio_sid: providerMessageId });

    const agedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await trx('sms_log').where({ id: reservationId }).update({ created_at: agedAt, updated_at: agedAt });
    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30, uncertainReconciliationHours: 1 }))
      .toMatchObject({ reservationsCleared: 0 });
    expect(await trx('sms_log').where({ id: reservationId }).first('status'))
      .toMatchObject({ status: 'sent' });
  });

  test.each(['failed', 'undelivered', 'canceled'])(
    'a sole accepted reservation updated to %s by a callback survives explicit cleanup and reconciliation',
    async (status) => {
      const reservationId = await acceptedReservation({
        kind: 'manual', providerMessageId: `SM${'e'.repeat(32)}`, body: `Sole terminal receipt ${status}`,
      });
      await trx('sms_log').where({ id: reservationId }).update({ status, created_at: old() });

      await suggest.settleReplyHoldingReservation({ reservationId });
      expect(await trx('sms_log').where({ id: reservationId }).first('status'))
        .toMatchObject({ status });
      expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 }))
        .toMatchObject({ reservationsCleared: 0 });
      expect(await trx('sms_log').where({ id: reservationId }).first('status'))
        .toMatchObject({ status });
    }
  );

  test.each(['failed', 'undelivered', 'canceled'])(
    'reconciliation removes a %s reservation when a matching terminal provider row exists',
    async (status) => {
      const sidCharacter = { failed: 'f', undelivered: 'd', canceled: 'c' }[status];
      const providerSid = `SM${sidCharacter.repeat(32)}`;
      const reservationId = await acceptedReservation({
        kind: 'manual', providerMessageId: providerSid, body: `Duplicate terminal receipt ${status}`,
      });
      const providerId = randomUUID();
      await trx('sms_log').insert({
        id: providerId, direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
        message_body: `Duplicate terminal receipt ${status}`, twilio_sid: providerSid,
        status, message_type: 'manual', metadata: {},
      });
      await trx('sms_log').where({ id: reservationId }).update({ status, created_at: old() });

      expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 }))
        .toMatchObject({ reservationsCleared: 1 });
      expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
      expect(await trx('sms_log').where({ id: providerId }).first('status'))
        .toMatchObject({ status });
    }
  );

  test.each([
    ['exact provider SID despite normalized provider body', 'auto', `SM${'b'.repeat(32)}`, 'On my way… https://wavespestcontrol.com/pay', 'On my way... wavespestcontrol.com/pay'],
    ['exact MMS provider SID', 'auto', `MM${'c'.repeat(32)}`, 'Ordinary provider receipt auto', 'Ordinary provider receipt auto'],
    ['bounded endpoint/body fallback for legacy no-SID callers', 'manual', null, 'Ordinary provider receipt manual', 'Ordinary provider receipt manual'],
  ])('%s lets explicit cleanup remove only the duplicate reservation', async (_label, kind, reservationSid, reservationBody, providerBody) => {
    const body = reservationBody;
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body,
      reservationKind: kind, uncertain: true,
    });
    if (!reservationSid) {
      await trx('sms_log').where({ id: reservationId }).update({
        created_at: new Date(Date.now() - 2000),
      });
    }
    const reservation = await trx('sms_log').where({ id: reservationId }).first('created_at');
    const providerId = randomUUID();
    const providerSid = reservationSid || `SM${randomUUID().replaceAll('-', '')}`;
    const providerCreatedAt = new Date(new Date(reservation.created_at).getTime() + 1000);
    await trx('sms_log').insert({
      id: providerId, direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: providerBody, twilio_sid: providerSid, status: 'sent', message_type: kind === 'auto' ? 'ai_autosent' : 'manual',
      created_at: providerCreatedAt, metadata: {},
    });
    expect(await suggest.settleReplyHoldingReservation({
      reservationId,
      acceptedResult: reservationSid ? { providerMessageId: reservationSid } : {},
    })).toBe(true);

    await suggest.settleReplyHoldingReservation({ reservationId });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
    expect(await trx('sms_log').where({ id: providerId }).first('twilio_sid'))
      .toMatchObject({ twilio_sid: providerSid });
  });

  test('a later identical message cannot erase the sole no-SID accepted receipt', async () => {
    const body = 'Same reply sent on two different days';
    const reservationId = await acceptedReservation({ kind: 'manual', body });
    const reservation = await trx('sms_log').where({ id: reservationId }).first('updated_at');
    await trx('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: body, twilio_sid: `SM${'d'.repeat(32)}`, status: 'sent', message_type: 'manual',
      created_at: new Date(new Date(reservation.updated_at).getTime() + 24 * 60 * 60 * 1000), metadata: {},
    });

    await suggest.settleReplyHoldingReservation({ reservationId });
    expect(await trx('sms_log').where({ id: reservationId }).first('status'))
      .toMatchObject({ status: 'sent' });
  });

  test('a suppression sentinel cannot replace a sole accepted receipt', async () => {
    const body = 'Accepted provider receipt';
    const reservationId = await acceptedReservation({ kind: 'manual', body });
    const reservation = await trx('sms_log').where({ id: reservationId }).first('created_at');
    await trx('sms_log').insert({
      id: randomUUID(), direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: body, twilio_sid: 'gate-blocked', status: 'sent', message_type: 'manual',
      created_at: new Date(new Date(reservation.created_at).getTime() + 1000), metadata: {},
    });

    await suggest.settleReplyHoldingReservation({ reservationId });
    expect(await trx('sms_log').where({ id: reservationId }).first('status'))
      .toMatchObject({ status: 'sent' });
  });

  test('manual returned/thrown uncertainty survives both sweeps, then sent evidence settles used and parked decisions', async () => {
    const used = await decision();
    const parked = await decision({ message: 'A different suggestion.' });
    const reservationId = await uncertainReservation({ kind: 'manual', used, parked });

    expect(await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30 })).toBe(0);
    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reservationsCleared: 0 });
    expect((await trx('agent_decisions').whereIn('id', [used.id, parked.id])).map((row) => row.status).sort())
      .toEqual(['scheduled', 'scheduled']);

    await providerEvidence({ used, parked });
    await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30 });
    await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 });

    expect(await trx('agent_decisions').where({ id: used.id }).first('status')).toMatchObject({ status: 'accepted' });
    expect(await trx('agent_decisions').where({ id: parked.id }).first('status')).toMatchObject({ status: 'ignored' });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });

  test('an uncertain reservation past the reconciliation window reopens for operator visibility, without touching the reservation row or resending', async () => {
    const used = await decision();
    const parked = await decision({ message: 'A different suggestion.' });
    const reservationId = await uncertainReservation({ kind: 'manual', used, parked });
    // Simulate provider evidence never arriving: push the reservation's own
    // updated_at (not just the decisions') well past a short reconciliation
    // window passed to this call.
    await trx('sms_log').where({ id: reservationId }).update({ updated_at: new Date(Date.now() - 3 * 60 * 60 * 1000) });

    expect(await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30, uncertainReconciliationHours: 1 })).toBe(2);

    expect((await trx('agent_decisions').whereIn('id', [used.id, parked.id])).map((row) => row.status).sort())
      .toEqual(['pending_review', 'pending_review']);
    // Bounded terminal settlement, not a resend: the linked reservation row
    // itself is untouched (no SMS send, no Twilio call, no status change).
    expect(await trx('sms_log').where({ id: reservationId }).first('status')).toMatchObject({ status: 'sending' });
  });

  test('an uncertain reservation still within the reconciliation window keeps holding its linked decisions', async () => {
    const used = await decision();
    const parked = await decision({ message: 'A different suggestion.' });
    const reservationId = await uncertainReservation({ kind: 'manual', used, parked });

    expect(await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30, uncertainReconciliationHours: 24 })).toBe(0);

    expect((await trx('agent_decisions').whereIn('id', [used.id, parked.id])).map((row) => row.status).sort())
      .toEqual(['scheduled', 'scheduled']);
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toMatchObject({ id: reservationId });
  });

  test('an ordinary crashed pre-provider reservation still reopens after the orphan cutoff', async () => {
    const used = await decision();
    const parked = await decision({ message: 'A different suggestion.' });
    const reservationId = await suggest.createReplyHoldingReservation(trx, {
      to: '+12025550101', fromNumber: '+19413529161', body: used.suggested_message,
      agentDecisionId: used.id, parkedDecisionIds: [parked.id], reservationKind: 'manual',
    });
    await trx('sms_log').where({ id: reservationId }).update({ created_at: old(), updated_at: old() });

    expect(await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30 })).toBe(2);
    await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 });

    expect((await trx('agent_decisions').whereIn('id', [used.id, parked.id])).map((row) => row.status).sort())
      .toEqual(['pending_review', 'pending_review']);
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });

  test('auto-send uncertainty retains its claim and parked decision until provider evidence appears', async () => {
    const used = await decision({ workflow: autoSend.AUTOSEND_WORKFLOW, status: autoSend.CLAIM_STATUS });
    const parked = await decision({ message: 'Human review fallback.' });
    const reservationId = await uncertainReservation({ kind: 'auto', used, parked });

    await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30 });
    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ failed: 0, reservationsCleared: 0 });
    expect(await trx('agent_decisions').where({ id: used.id }).first('status')).toMatchObject({ status: autoSend.CLAIM_STATUS });
    expect(await trx('agent_decisions').where({ id: parked.id }).first('status')).toMatchObject({ status: 'scheduled' });

    // Simulate Twilio acceptance followed by failures in both its normal
    // sms_log insert and later decision bookkeeping: the pre-send reservation
    // itself must become sufficient accepted evidence for recovery.
    expect(await suggest.settleReplyHoldingReservation({
      reservationId,
      acceptedResult: { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` },
    })).toBe(true);
    await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30 });
    await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 });

    expect(await trx('agent_decisions').where({ id: used.id }).first('status')).toMatchObject({ status: autoSend.SENT_STATUS });
    expect(await trx('agent_decisions').where({ id: parked.id }).first('status')).toMatchObject({ status: 'ignored' });
    expect(await trx('sms_log').where({ id: reservationId }).first('status', 'twilio_sid'))
      .toMatchObject({ status: 'sent', twilio_sid: `SM${'a'.repeat(32)}` });
  });

  async function reviewReservation({ createdAt, status = 'sending' }) {
    const [row] = await trx('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: '+12025550101',
      message_body: 'Would you leave us a quick review?', status, message_type: 'manual',
      metadata: { manual_send_reservation: true, review_ask_reservation: true },
      created_at: createdAt, updated_at: createdAt,
    }).returning('id');
    return row.id;
  }

  test('a review-ask reservation still unresolved past its 72-hour hold window expires', async () => {
    const reservationId = await reviewReservation({ createdAt: pastAskSpacingWindow() });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reviewReservationsExpired: 1 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });

  test('a review-ask reservation still inside its 72-hour hold window survives the sweep', async () => {
    const reservationId = await reviewReservation({ createdAt: old() });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reviewReservationsExpired: 0 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toMatchObject({ id: reservationId });
  });

  test('a review-ask reservation already resolved to sent is never swept, however old', async () => {
    const reservationId = await reviewReservation({ createdAt: pastAskSpacingWindow(), status: 'sent' });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reviewReservationsExpired: 0 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toMatchObject({ id: reservationId });
  });

  test('a freshly reclaimed real scheduled review row survives the sweep even at the exact age cutoff (codex P1, review-ask-queued #4334)', async () => {
    // claimDueScheduledSms (scheduler.js) flips a due retry's status to
    // 'sending' WITHOUT touching created_at, so a real scheduled review-ask
    // row can land in this sweep's status='sending' + past-cutoff shape at
    // the exact moment it is reclaimed for its next attempt — age alone
    // can't tell it apart from an orphaned synthetic placeholder. Only its
    // scheduled_for column can: a synthetic reservation (review-request.js
    // #reserveReviewSms) never sets it, a real scheduled row always keeps
    // the one it was queued with. Losing this row here would strand its
    // retry and terminal-hook obligations.
    const reservationId = await reviewReservation({ createdAt: pastAskSpacingWindow() });
    await trx('sms_log').where({ id: reservationId }).update({ scheduled_for: new Date() });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reviewReservationsExpired: 0 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toMatchObject({ id: reservationId });
  });

  test('a synthetic placeholder reservation (no scheduled_for) still expires past its window', async () => {
    // Companion to the case above: confirms the scheduled_for guard narrows
    // the sweep rather than disabling it — an orphaned manual/inline
    // reservation (never carries scheduled_for) must still be swept.
    const reservationId = await reviewReservation({ createdAt: pastAskSpacingWindow() });
    expect(await trx('sms_log').where({ id: reservationId }).first('scheduled_for'))
      .toMatchObject({ scheduled_for: null });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30 })).toMatchObject({ reviewReservationsExpired: 1 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });

  test('an auto-send claim past the reconciliation window fails like any other orphan, freeing its reservation once the parked side reopens', async () => {
    const used = await decision({ workflow: autoSend.AUTOSEND_WORKFLOW, status: autoSend.CLAIM_STATUS });
    const parked = await decision({ message: 'Human review fallback.' });
    const reservationId = await uncertainReservation({ kind: 'auto', used, parked });
    // Provider evidence never arrives: push the reservation's own updated_at
    // well past a short reconciliation window passed to both sweeps.
    await trx('sms_log').where({ id: reservationId }).update({ updated_at: new Date(Date.now() - 3 * 60 * 60 * 1000) });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30, uncertainReconciliationHours: 1 }))
      .toMatchObject({ failed: 1 });
    expect(await trx('agent_decisions').where({ id: used.id }).first('status')).toMatchObject({ status: autoSend.FAILED_STATUS });

    // The parked sibling reopens through the existing suggestion sweep (same
    // bounded window); once both linked decisions are terminal/reopened, the
    // reservation row itself is no longer "live" and clears on the next pass.
    expect(await suggest.recoverSuggestionHoldingStates({ orphanMinutes: 30, uncertainReconciliationHours: 1 })).toBe(1);
    expect(await trx('agent_decisions').where({ id: parked.id }).first('status')).toMatchObject({ status: 'pending_review' });

    expect(await autoSend.reconcileAutoSendClaims({ orphanMinutes: 30, uncertainReconciliationHours: 1 }))
      .toMatchObject({ reservationsCleared: 1 });
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
  });
});
