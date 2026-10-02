// The unanswered-text sweep against real SQL, in a rollback-only transaction on disposable/owned PostgreSQL.
// Observable behavior: a suggested reply nobody acted on for two open hours is sent once, its card is
// labeled answered (never a staff decision), and anything that moved on the thread leaves the card alone.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-shadow-drafter', () => ({
  reserviceBookedReferenceBlock: jest.fn(async () => null),
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
  currentPromptVersion: jest.fn(() => 'house_voice_v11'),
  findEtaMinutesClaims: jest.fn(() => []),
  bodyMentionsArrival: jest.fn(() => false),
  bodyHasTimedArrivalPhrase: jest.fn(() => false),
  bodyHasUnclassifiedArrivalDigit: jest.fn(() => false),
  findGroundedMinutesFigures: jest.fn(() => []),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const { randomUUID } = require('node:crypto');
const db = require('../models/db');
const suggest = require('../services/sms-suggest-mode');
const autoSend = require('../services/sms-auto-send');
const graduation = require('../services/sms-graduation');
const unanswered = require('../services/sms-unanswered-reply');
const gratitudeContext = require('../services/sms-gratitude-context');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
jest.setTimeout(30000);

// Tuesday 2026-10-06, 2:00 PM ET: inside the send window, an ordinary open day.
const NOW = new Date('2026-10-06T18:00:00Z');
const at = (iso) => new Date(iso);
const INBOUND_AT = at('2026-10-06T15:00:00Z'); // 11:00 AM ET, three open hours before NOW
const CUSTOMER_PHONE = '+12025550101';
const WAVES_LINE = '+19413521572'; // a location line; tech lines never get automated replies
const REPLY = 'Your next visit is this Thursday. We will text you the morning of.';

postgres('unanswered-text reply sweep on PostgreSQL', () => {
  let database;
  let trx;
  let customerId;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!local && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    process.env.GATE_SMS_UNANSWERED_REPLY = 'true';
    // The send-window rechecks read the real clock; pin only Date to the fixture's
    // Tuesday 2 PM ET so timers, I/O and the pg driver run normally.
    jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
    trx = await database.transaction();
    const schema = `sms_unanswered_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['sms_log', 'agent_decisions', 'message_drafts', 'call_log', 'scheduled_services', 'customers', 'estimates', 'invoices']) {
      await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    }
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
    db.connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Tester', phone: CUSTOMER_PHONE, active: true });
    jest.spyOn(graduation, 'evaluateJudgeBackstop').mockResolvedValue({ clear: true, blockers: [] });
    jest.spyOn(gratitudeContext, 'gratitudeRolloutSettled').mockReturnValue(true);
    sendCustomerMessage.mockReset();
    sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` });
  });

  afterEach(async () => {
    delete process.env.GATE_SMS_UNANSWERED_REPLY;
    jest.useRealTimers();
    jest.restoreAllMocks();
    await trx?.rollback();
  });
  afterAll(async () => { await database?.destroy(); });

  // One waiting suggestion: inbound text → verified draft (stamped) → pending card.
  async function waitingSuggestion({
    inboundAt = INBOUND_AT, intent = 'general_customer_sms_needs_review', reply = REPLY, phone = CUSTOMER_PHONE,
    stamp = {}, actions = [], snapshot = {}, missingInfo = null, media = [], promptVersion = 'house_voice_v11',
    inboundText = 'When is my next visit?',
  } = {}) {
    const inboundId = randomUUID();
    const draftId = randomUUID();
    const decisionId = randomUUID();
    const draftedAt = new Date(inboundAt.getTime() + 5000);
    await trx('sms_log').insert({
      id: inboundId, customer_id: customerId, direction: 'inbound', from_phone: phone, to_phone: WAVES_LINE,
      message_body: inboundText, status: 'received', created_at: inboundAt, updated_at: inboundAt,
      metadata: JSON.stringify(media === null ? {} : { media }), // null = no media list recorded
    });
    await trx('message_drafts').insert({
      id: draftId, sms_log_id: inboundId, customer_id: customerId, inbound_message: inboundText,
      draft_response: reply, intent, status: 'suggested', model: 'synthetic-model', prompt_version: promptVersion,
      scheduling_intent: false, created_at: draftedAt,
      intended_actions: JSON.stringify({
        actions,
        missing_info: missingInfo,
        verify: { passes: 2, converged: true },
        voice_profile_version: null,
        unanswered: {
          policy_version: unanswered.STAMP_VERSION, actions_verified_safe: true, require_review: false,
          lint_pass: true, verifier_enabled: true, ...stamp,
        },
      }),
    });
    await trx('agent_decisions').insert({
      id: decisionId, workflow: suggest.SUGGEST_WORKFLOW, agent_name: 'synthetic-unanswered-test', decision_version: 'test-v1',
      mode: 'suggest', status: 'pending_review', entity_type: 'message_draft', entity_id: draftId, customer_id: customerId,
      source_channel: 'sms', sms_log_id: inboundId, detected_intent: intent, suggested_message: reply,
      input_snapshot: JSON.stringify({ sms: { body: inboundText }, draft_id: draftId, facts_generated_at: draftedAt.toISOString(), ...snapshot }),
      prompt_version: promptVersion, idempotency_key: `${suggest.SUGGEST_WORKFLOW}:draft:${draftId}`,
      created_at: draftedAt, updated_at: draftedAt,
    });
    return { inboundId, draftId, decisionId };
  }

  const card = (id) => trx('agent_decisions').where({ id }).first();
  const draft = (id) => trx('message_drafts').where({ id }).first();
  const claimFor = (inboundId) => trx('agent_decisions')
    .where({ idempotency_key: `${autoSend.AUTOSEND_WORKFLOW}:inbound:${inboundId}` }).first();
  const sweep = () => unanswered.processUnansweredReplyCandidates({ now: NOW });

  async function expectUntouched(s, totals, reason) {
    expect(totals.sent).toBe(0);
    if (reason) expect(totals.refused[reason]).toBe(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await card(s.decisionId)).status).toBe('pending_review');
    expect((await draft(s.draftId)).status).toBe('suggested');
  }

  test('a suggestion nobody acted on for two open hours is sent once and labeled answered', async () => {
    const s = await waitingSuggestion();
    const totals = await sweep();

    expect(totals).toMatchObject({ scanned: 1, attempted: 1, sent: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
      to: CUSTOMER_PHONE, body: REPLY, customerId, entryPoint: 'sms_auto_send_executor',
    });

    // The card is answered, with no human verdict: never a staff decision or a correction.
    expect(await card(s.decisionId)).toMatchObject({ status: unanswered.ANSWERED_STATUS, human_verdict: null, reviewed_by: 'auto' });
    expect((await draft(s.draftId)).status).toBe(autoSend.DRAFT_SENT_STATUS);
    const claim = await claimFor(s.inboundId);
    expect(claim.status).toBe(autoSend.SENT_STATUS);
    expect(claim.input_snapshot.unanswered_reply).toEqual({ suggestion_id: s.decisionId, wait_open_minutes: 120 });

    // A second tick finds nothing to do.
    const again = await sweep();
    expect(again.scanned).toBe(0);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('graduation outcome counts ignore an answered card', async () => {
    const s = await waitingSuggestion();
    await sweep();
    const outcomes = await graduation.fetchSuggestOutcomes({
      intent: 'general_customer_sms_needs_review', cohortVersions: null, voiceProfileVersion: null,
    });
    expect(outcomes).toEqual({ accepted: 0, corrected: 0, ignored: 0 });
    expect((await card(s.decisionId)).status).toBe(unanswered.ANSWERED_STATUS);
  });

  test('gate off: nothing is scanned or sent', async () => {
    const s = await waitingSuggestion();
    delete process.env.GATE_SMS_UNANSWERED_REPLY;
    const totals = await sweep();
    expect(totals).toMatchObject({ scanned: 0, sent: 0, reason: 'gate_off' });
    await expectUntouched(s, totals);
  });

  test('outside 8 AM to 8 PM ET nothing is sent', async () => {
    const s = await waitingSuggestion();
    const totals = await unanswered.processUnansweredReplyCandidates({ now: at('2026-10-07T01:30:00Z') }); // 9:30 PM ET
    expect(totals.reason).toBe('outside_send_window');
    await expectUntouched(s, totals);
  });

  test('a text that has waited under two open hours stays with staff', async () => {
    // 6:30 AM ET text: 7.5 wall hours old at 2 PM... so use a clock where open time is short.
    const s = await waitingSuggestion({ inboundAt: at('2026-10-06T10:30:00Z') }); // 6:30 AM ET
    const totals = await unanswered.processUnansweredReplyCandidates({ now: at('2026-10-06T13:30:00Z') }); // 9:30 AM ET: 1.5 open hours
    await expectUntouched(s, totals, 'not_due');
  });

  test('a reply drafted yesterday evening is never sent the next day', async () => {
    const s = await waitingSuggestion({ inboundAt: at('2026-10-05T22:30:00Z') }); // Monday 6:30 PM ET
    const totals = await sweep();
    await expectUntouched(s, totals, 'not_same_day');
  });

  test('only ordinary intents are candidates', async () => {
    const s = await waitingSuggestion({ intent: 'billing_question_needs_review' });
    const totals = await sweep();
    expect(totals.scanned).toBe(0);
    await expectUntouched(s, totals);
  });

  test('a draft without the stamp (drafted while the gate was off) is not a candidate', async () => {
    const s = await waitingSuggestion({ stamp: { policy_version: 'none' } });
    const totals = await sweep();
    expect(totals.scanned).toBe(0);
    await expectUntouched(s, totals);
  });

  test.each([
    ['review_required', { stamp: { require_review: true } }],
    ['lint_flagged', { stamp: { lint_pass: false } }],
    ['lint_flagged', { snapshot: { comms_lint: [{ rule: 'plan_total' }] } }],
    ['not_verified', { stamp: { verifier_enabled: false } }],
    ['action_required', { stamp: { actions_verified_safe: false } }],
    ['action_required', { actions: [{ type: 'escalate' }] }],
    ['price_quote', { reply: 'Your total is $89 for this visit.' }],
    ['redaction_placeholder', { reply: 'Hello [name], your visit is Thursday.' }],
    ['missing_info', { missingInfo: 'the exact arrival window' }],
    ['media_or_unknown', { media: [{ url: 'https://example.invalid/photo.jpg', contentType: 'image/jpeg' }] }],
    ['media_or_unknown', { media: null }],
    ['prompt_cohort_mismatch', { promptVersion: 'house_voice_v9' }],
    ['sensitive_topic', { inboundText: "You'll hear from my lawyer about this." }],
    ['sensitive_topic', { inboundText: 'My dog got sick after the spray, is that normal?' }],
    ['sensitive_topic', { inboundText: 'Why was I charged twice?' }],
    ['sensitive_topic', { inboundText: 'Please cancel my service.' }],
    ['sensitive_topic', { inboundText: 'The tech never showed, really disappointed.' }],
    ['sensitive_topic', { inboundText: 'Can my kids go outside after you sprayed?' }],
    ['sensitive_topic', { inboundText: 'Is it still pending?' }],
    ['sensitive_topic', { reply: 'Your payment is still processing and should clear soon.' }],
    ['label_grounded', { snapshot: { label_facts_snapshot: { product: 'synthetic', reentry: 'until dry' } } }],
  ])('%s keeps the card for a person', async (reason, overrides) => {
    const s = await waitingSuggestion(overrides);
    const totals = await sweep();
    await expectUntouched(s, totals, reason);
  });

  test.each([
    ['the phone now belongs to a different customer', async () => {
      await trx('customers').where({ id: customerId }).update({ phone: '+12025550199' });
      await trx('customers').insert({ id: randomUUID(), first_name: 'Other', last_name: 'Person', phone: CUSTOMER_PHONE, active: true });
    }],
    ['two live customers share the phone', async () => {
      await trx('customers').insert({ id: randomUUID(), first_name: 'Other', last_name: 'Person', phone: CUSTOMER_PHONE, active: true });
    }],
    ['the customer was deactivated', async () => {
      await trx('customers').where({ id: customerId }).update({ active: false });
    }],
  ])('%s: nothing is sent', async (_label, change) => {
    const s = await waitingSuggestion();
    await change();
    const totals = await sweep();
    await expectUntouched(s, totals, 'customer_untrusted');
  });

  test('a text to a technician\'s own line never gets an automated reply', async () => {
    const s = await waitingSuggestion();
    await trx('sms_log').where({ id: s.inboundId }).update({ to_phone: '+19413529161' }); // Tech line 1
    const totals = await sweep();
    await expectUntouched(s, totals, 'tech_line_thread');
  });

  test('the phone changing hands after the claim is caught at the provider boundary', async () => {
    const s = await waitingSuggestion();
    sendCustomerMessage.mockImplementation(async (input) => {
      await trx('customers').where({ id: customerId }).update({ active: false });
      const verdict = await input.providerPreSendCheck({ dbi: trx });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.customer_untrusted).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
  });

  test('a lost answered-card label is still repaired after a rollback to false', async () => {
    const s = await waitingSuggestion();
    await sweep();
    await trx('agent_decisions').where({ id: s.decisionId }).update({ status: 'ignored', human_verdict: 'ignored', reviewed_by: 'Admin' });
    process.env.GATE_SMS_UNANSWERED_REPLY = 'false';
    jest.setSystemTime(at('2026-10-07T01:30:00Z')); // 9:30 PM ET, outside the window too
    const totals = await unanswered.processUnansweredReplyCandidates({ now: new Date() });
    expect(totals.reason).toBe('gate_off');
    expect(await card(s.decisionId)).toMatchObject({ status: unanswered.ANSWERED_STATUS, human_verdict: null });
  });

  test('a judge backstop that is not clear blocks the send', async () => {
    graduation.evaluateJudgeBackstop.mockResolvedValue({ clear: false, blockers: ['Needs 30 more live judged drafts'] });
    const s = await waitingSuggestion();
    const totals = await sweep();
    await expectUntouched(s, totals, 'backstop_not_clear');
  });

  test('a visit that changed after the facts were read blocks the send', async () => {
    const s = await waitingSuggestion();
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: '2026-10-08', service_type: 'Pest Control',
      updated_at: at('2026-10-06T16:00:00Z'),
    });
    const totals = await sweep();
    await expectUntouched(s, totals, 'visit_changed');
  });

  test.each([
    ['estimate_changed', 'estimates', () => ({ id: randomUUID(), customer_id: customerId, updated_at: at('2026-10-06T16:00:00Z') })],
    ['invoice_changed', 'invoices', () => ({
      id: randomUUID(), customer_id: customerId, token: randomUUID(), invoice_number: `QA-${Date.now()}`,
      updated_at: at('2026-10-06T16:00:00Z'),
    })],
  ])('%s after the facts were read blocks the send', async (reason, table, row) => {
    const s = await waitingSuggestion({ inboundText: 'Can I still accept that estimate?' });
    await trx(table).insert(row());
    const totals = await sweep();
    await expectUntouched(s, totals, reason);
  });

  test.each([
    ['declined (only declined_at stamped)', { status: 'declined', declined_at: at('2026-10-06T16:00:00Z'), updated_at: at('2026-10-06T14:00:00Z') }],
    ['viewed (only last_viewed_at stamped)', { last_viewed_at: at('2026-10-06T16:30:00Z'), updated_at: at('2026-10-06T14:00:00Z') }],
    ['expired during the wait', { expires_at: at('2026-10-06T17:00:00Z'), updated_at: at('2026-10-06T14:00:00Z') }],
  ])('an estimate %s blocks the send', async (_label, fields) => {
    const s = await waitingSuggestion({ inboundText: 'Is the proposal still available?' });
    await trx('estimates').insert({ id: randomUUID(), customer_id: customerId, ...fields });
    const totals = await sweep();
    await expectUntouched(s, totals, 'estimate_changed');
  });

  test('an estimate that expires later, untouched since the facts, does not block', async () => {
    await waitingSuggestion({ inboundText: 'Is the proposal still available?' });
    await trx('estimates').insert({ id: randomUUID(), customer_id: customerId, expires_at: at('2026-10-20T17:00:00Z'), updated_at: at('2026-10-06T14:00:00Z') });
    expect((await sweep()).sent).toBe(1);
  });

  test('an estimate that changes after the claim is caught at the provider boundary', async () => {
    const s = await waitingSuggestion();
    sendCustomerMessage.mockImplementation(async (input) => {
      await trx('estimates').insert({ id: randomUUID(), customer_id: customerId, updated_at: at('2026-10-06T17:59:30Z') });
      const verdict = await input.providerPreSendCheck({ dbi: trx });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.estimate_changed).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
  });

  test('a staff reply after the text blocks the send', async () => {
    const s = await waitingSuggestion();
    await trx('sms_log').insert({
      id: randomUUID(), customer_id: customerId, direction: 'outbound', from_phone: WAVES_LINE, to_phone: CUSTOMER_PHONE,
      message_body: 'Thursday morning.', status: 'delivered', message_type: 'manual', created_at: at('2026-10-06T16:00:00Z'),
    });
    const totals = await sweep();
    await expectUntouched(s, totals, 'guarded_or_claimed');
    expect(await claimFor(s.inboundId)).toBeUndefined();
  });

  test('the customer texting again blocks the send', async () => {
    const s = await waitingSuggestion();
    await trx('sms_log').insert({
      id: randomUUID(), customer_id: customerId, direction: 'inbound', from_phone: CUSTOMER_PHONE, to_phone: WAVES_LINE,
      message_body: 'Never mind, found it.', status: 'received', created_at: at('2026-10-06T16:00:00Z'),
    });
    const totals = await sweep();
    await expectUntouched(s, totals, 'guarded_or_claimed');
  });

  test.each([
    ['by customer', (id) => ({ customer_id: id, from_phone: WAVES_LINE, to_phone: '+12025550199' })],
    ['by phone', () => ({ customer_id: null, from_phone: CUSTOMER_PHONE, to_phone: WAVES_LINE })],
  ])('a call since the text (%s) blocks the send', async (_label, callRow) => {
    const s = await waitingSuggestion();
    await trx('call_log').insert({ id: randomUUID(), direction: 'inbound', created_at: at('2026-10-06T16:30:00Z'), ...callRow(customerId) });
    const totals = await sweep();
    await expectUntouched(s, totals, 'guarded_or_claimed');
  });

  test('a call BEFORE the text does not block it', async () => {
    await waitingSuggestion();
    await trx('call_log').insert({
      id: randomUUID(), direction: 'inbound', customer_id: customerId, from_phone: CUSTOMER_PHONE, to_phone: WAVES_LINE,
      created_at: at('2026-10-06T14:00:00Z'),
    });
    expect((await sweep()).sent).toBe(1);
  });

  test('a text that lands after the claim is caught at the provider boundary and the card returns', async () => {
    const s = await waitingSuggestion();
    sendCustomerMessage.mockImplementation(async (input) => {
      await trx('sms_log').insert({
        id: randomUUID(), customer_id: customerId, direction: 'inbound', from_phone: CUSTOMER_PHONE, to_phone: WAVES_LINE,
        message_body: 'Actually, call me.', status: 'received', created_at: at('2026-10-06T17:59:00Z'),
      });
      const verdict = await input.providerPreSendCheck({ dbi: trx });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.newer_inbound).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
    expect((await draft(s.draftId)).status).toBe('suggested');
    // One try per inbound: the failed claim holds the send-once key.
    expect((await claimFor(s.inboundId)).status).toBe(autoSend.FAILED_STATUS);
    sendCustomerMessage.mockClear();
    expect((await sweep()).scanned).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a reschedule after the claim is caught at the provider boundary and the card returns', async () => {
    const s = await waitingSuggestion();
    sendCustomerMessage.mockImplementation(async (input) => {
      await trx('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, scheduled_date: '2026-10-09', service_type: 'Pest Control',
        updated_at: at('2026-10-06T17:59:30Z'),
      });
      const verdict = await input.providerPreSendCheck({ dbi: trx });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.visit_changed).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
  });

  test('a rolling enable claims nothing until every instance reads the gate', async () => {
    const s = await waitingSuggestion();
    gratitudeContext.gratitudeRolloutSettled.mockReturnValue(false);
    expect(await sweep()).toMatchObject({ attempted: 0, reason: 'rollout_settling' });
    await expectUntouched(s, { sent: 0, refused: {} });
  });

  test('a staff reply while the unanswered claim is mid-send backs off', async () => {
    const s = await waitingSuggestion();
    let staff;
    sendCustomerMessage.mockImplementation(async () => {
      staff = await suggest.reserveHumanReply({ to: CUSTOMER_PHONE, customerId, fromNumber: WAVES_LINE, body: 'Thursday, see you then.' });
      return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}` };
    });
    expect((await sweep()).sent).toBe(1);
    expect(staff.autoSendInFlight).toBe(true);
    expect(staff.reservationId).toBeNull();
  });

  test('a dashboard/assistant/leads reply (manual-send wrapper) while the claim is mid-send is refused, not sent', async () => {
    await waitingSuggestion();
    const { sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms');
    let staff;
    sendCustomerMessage.mockImplementation(async (input) => {
      if (input.entryPoint === 'sms_auto_send_executor') {
        staff = await sendManualCustomerSms({
          to: CUSTOMER_PHONE, body: 'Thursday, see you then.', channel: 'sms', audience: 'customer',
          purpose: 'conversational', customerId, entryPoint: 'admin_dashboard_ops_inbox_reply',
          metadata: { original_message_type: 'manual', fromNumber: WAVES_LINE },
        });
      }
      return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'c'.repeat(32)}` };
    });
    expect((await sweep()).sent).toBe(1);
    expect(staff).toMatchObject({ sent: false, code: 'AUTO_REPLY_IN_FLIGHT' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a staff reply in flight before the sweep keeps the card for the person', async () => {
    const s = await waitingSuggestion();
    const staff = await suggest.reserveHumanReply({ to: CUSTOMER_PHONE, customerId, fromNumber: WAVES_LINE, body: 'Thursday, see you then.' });
    expect(staff.autoSendInFlight).toBe(false);
    expect(staff.reservationId).toBeTruthy();
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await claimFor(s.inboundId)).toBeUndefined();
  });

  test('the staff-reply interlock stays on after a rollback to false', () => {
    process.env.GATE_SMS_UNANSWERED_REPLY = 'false';
    expect(unanswered.unansweredReplyLive()).toBe(false);
    expect(unanswered.unansweredClaimsPossible()).toBe(true);
    delete process.env.GATE_SMS_UNANSWERED_REPLY;
    expect(unanswered.unansweredClaimsPossible()).toBe(false);
  });

  test('a database error in the boundary check refuses the send and logs no message text', async () => {
    const s = await waitingSuggestion();
    const logger = require('../services/logger');
    sendCustomerMessage.mockImplementation(async (input) => {
      const verdict = await input.providerPreSendCheck({ dbi: Object.assign(() => { throw new Error(`select ... ${CUSTOMER_PHONE}`); }, { raw: () => { throw new Error(CUSTOMER_PHONE); } }) });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.handoff_check_failed).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(CUSTOMER_PHONE.slice(-10));
  });

  test('closing time between the claim and the provider call holds the send and the card returns', async () => {
    const s = await waitingSuggestion();
    sendCustomerMessage.mockImplementation(async (input) => {
      jest.setSystemTime(at('2026-10-07T00:01:00Z')); // 8:01 PM ET
      const verdict = await input.providerPreSendCheck({ dbi: trx });
      return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code, reason: verdict.reason };
    });
    const totals = await sweep();
    expect(totals.sent).toBe(0);
    expect(totals.refused.outside_send_window).toBe(1);
    expect((await card(s.decisionId)).status).toBe('pending_review');
    expect((await draft(s.draftId)).status).toBe('suggested');
  });

  test('a sweep that reaches closing time stops before the next page', async () => {
    await waitingSuggestion();
    jest.setSystemTime(at('2026-10-07T00:01:00Z'));
    // `now` says 2 PM (the tick's start); the real clock says 8:01 PM.
    expect(await sweep()).toMatchObject({ sent: 0, attempted: 0, reason: 'outside_send_window' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a full page of refused candidates does not starve a newer eligible one', async () => {
    for (let i = 0; i < unanswered.SWEEP_LIMIT; i += 1) {
      // 8:00–9:39 AM ET, all held for a person's review.
      await waitingSuggestion({
        inboundAt: new Date(at('2026-10-06T12:00:00Z').getTime() + i * 60 * 1000),
        phone: `+1202555${String(1000 + i).padStart(4, '0')}`,
        stamp: { require_review: true },
      });
    }
    const s = await waitingSuggestion();
    const totals = await sweep();
    expect(totals).toMatchObject({ scanned: unanswered.SWEEP_LIMIT + 1, attempted: 1, sent: 1 });
    expect(totals.refused.review_required).toBe(unanswered.SWEEP_LIMIT);
    expect((await card(s.decisionId)).status).toBe(unanswered.ANSWERED_STATUS);
  });

  test('the thread\'s other waiting cards resolve as passed over, the answered one as answered', async () => {
    const older = await waitingSuggestion({ inboundAt: at('2026-10-06T14:00:00Z'), intent: 'billing_question_needs_review' });
    // The older card belongs to an earlier text on the same thread; the newest inbound is the one answered.
    const newest = await waitingSuggestion({ inboundAt: at('2026-10-06T15:30:00Z') });
    const totals = await sweep();
    expect(totals.sent).toBe(1);
    expect((await card(newest.decisionId)).status).toBe(unanswered.ANSWERED_STATUS);
    expect(await card(older.decisionId)).toMatchObject({ status: 'ignored', reviewed_by: 'auto' });
  });

  test('an answered card left mislabeled by a crash is repaired by the next sweep', async () => {
    const s = await waitingSuggestion();
    await sweep();
    // What crash recovery leaves: the card ignored as if staff had replied, the draft back in the judge pool.
    await trx('agent_decisions').where({ id: s.decisionId }).update({ status: 'ignored', human_verdict: 'ignored', reviewed_by: 'Admin' });
    await trx('message_drafts').where({ id: s.draftId }).update({ status: 'shadow' });

    const later = new Date(Date.now() + 5 * 60 * 1000);
    expect(await unanswered.settleAnsweredSuggestions({ now: later })).toBe(1);
    expect(await card(s.decisionId)).toMatchObject({ status: unanswered.ANSWERED_STATUS, human_verdict: null, reviewed_by: 'auto' });
    expect((await draft(s.draftId)).status).toBe(autoSend.DRAFT_SENT_STATUS);
    expect(await unanswered.settleAnsweredSuggestions({ now: later })).toBe(0);
  });

  test('an ordinary Phase E claim (no unanswered marker) is never relabeled', async () => {
    const s = await waitingSuggestion();
    await trx('agent_decisions').insert({
      id: randomUUID(), workflow: autoSend.AUTOSEND_WORKFLOW, agent_name: 'synthetic', decision_version: 'test-v1',
      mode: autoSend.AUTOSEND_MODE, status: autoSend.SENT_STATUS, entity_type: 'message_draft', entity_id: s.draftId,
      source_channel: 'sms', sms_log_id: s.inboundId, input_snapshot: JSON.stringify({ draft_id: s.draftId }),
      idempotency_key: `${autoSend.AUTOSEND_WORKFLOW}:inbound:${s.inboundId}`,
      created_at: at('2026-10-06T15:01:00Z'), updated_at: at('2026-10-06T15:01:00Z'),
    });
    expect(await unanswered.settleAnsweredSuggestions({ now: new Date() })).toBe(0);
    expect((await card(s.decisionId)).status).toBe('pending_review');
  });
});
