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
    expect(await trx('sms_log').where({ id: reservationId }).first('id')).toBeUndefined();
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
