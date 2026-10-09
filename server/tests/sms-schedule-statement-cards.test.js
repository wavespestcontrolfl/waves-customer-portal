'use strict';

// Schedule-statement cards (owner ruling 2026-10-09, text agent fix plan D3).
// A scheduling-intent draft that offers NO new time may reach staff as a card,
// but only with a stored upcoming-schedule signature that every send seam
// re-reads. Regression guarded: 23 of 31 held-back drafts in the 14-day audit
// were scheduling answers with no card; and a card that sits while a rain-out
// moves the visit must not send the old window.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GATES = ['GATE_SMS_SCHEDULING_SUGGEST', 'GATE_SMS_REAL_ANSWERS', 'GATE_SMS_SUGGEST_MODE'];
const prior = {};
beforeEach(() => { for (const g of GATES) { prior[g] = process.env[g]; delete process.env[g]; } jest.resetModules(); });
afterEach(() => { for (const g of GATES) { if (prior[g] === undefined) delete process.env[g]; else process.env[g] = prior[g]; } });

const STAMP = { signature: 'sig-1', at: '2026-10-09T15:00:00.000Z' };
const base = { reply: 'You are on for Tuesday 9-11.', customerId: 'c1', smsLogId: 's1', intent: 'general_customer_sms_needs_review', schedulingIntent: true };

describe('suggestionEligible: a scheduling answer with no new time', () => {
  test('gate on + a stored signature: eligible; no signature, a malformed one, or gate off: not', () => {
    process.env.GATE_SMS_SCHEDULING_SUGGEST = 'true';
    const suggest = require('../services/sms-suggest-mode');
    expect(suggest.suggestionEligible({ ...base, scheduleFacts: STAMP })).toBe(true);
    expect(suggest.suggestionEligible({ ...base })).toBe(false);
    expect(suggest.suggestionEligible({ ...base, scheduleFacts: { signature: '', at: STAMP.at } })).toBe(false);
    expect(suggest.suggestionEligible({ ...base, scheduleFacts: { signature: 'x' } })).toBe(false);
    delete process.env.GATE_SMS_SCHEDULING_SUGGEST;
    expect(suggest.suggestionEligible({ ...base, scheduleFacts: STAMP })).toBe(false);
  });

  test('a draft with an open-times snapshot never takes the statement path, and an escalation intent stays locked', () => {
    process.env.GATE_SMS_SCHEDULING_SUGGEST = 'true';
    const suggest = require('../services/sms-suggest-mode');
    // a legacy zone-finder snapshot (no picker source): not a picker card, and not a statement either
    const legacy = { quotedWindows: [{ date: 'Tuesday, October 13', window: '9:00 AM - 11:00 AM' }], lookup: { city: 'Venice' } };
    expect(suggest.suggestionEligible({ ...base, openTimesSnapshot: legacy, scheduleFacts: STAMP })).toBe(false);
    expect(suggest.suggestionEligible({ ...base, intent: 'customer_issue_needs_review', scheduleFacts: STAMP })).toBe(false);
  });

  test('the auto-send and unanswered-reply eligibility calls pass no signature, so a scheduling draft stays ineligible there', () => {
    process.env.GATE_SMS_SCHEDULING_SUGGEST = 'true';
    const suggest = require('../services/sms-suggest-mode');
    expect(suggest.suggestionEligible({ reply: base.reply, customerId: 'c1', smsLogId: 's1', intent: base.intent, schedulingIntent: true })).toBe(false);
  });

  test('resolveDeliveryMode: a statement draft is a SUGGESTION at most, whatever the intent rung', async () => {
    process.env.GATE_SMS_SCHEDULING_SUGGEST = 'true';
    process.env.GATE_SMS_SUGGEST_MODE = 'true';
    jest.doMock('../models/db', () => jest.fn(() => ({ where: () => ({ first: async () => ({ mode: 'auto_send' }) }) })));
    jest.doMock('../config/feature-gates', () => ({
      ...jest.requireActual('../config/feature-gates'),
      isEnabled: (k) => k === 'smsSuggestMode' || k === 'smsAutoSend',
    }));
    const suggest = require('../services/sms-suggest-mode');
    expect(await suggest.resolveDeliveryMode({ ...base, scheduleFacts: STAMP })).toBe('suggest');
    expect(await suggest.resolveDeliveryMode({ ...base })).toBe('shadow');
  });
});

describe('scheduleStatementOnly (drafter): which replies the signature may back', () => {
  const load = () => { jest.doMock('../models/db', () => jest.fn()); return require('../services/sms-shadow-drafter'); };
  test('no offered times, no snapshot, actions none/escalate only', () => {
    const { scheduleStatementOnly } = load();
    const ok = { schedulingIntent: true, openTimesSnapshot: null };
    expect(scheduleStatementOnly({ ...ok, parsed: { offered_times: [], intended_actions: [{ type: 'none' }] } })).toBe(true);
    expect(scheduleStatementOnly({ ...ok, parsed: { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] } })).toBe(true);
    expect(scheduleStatementOnly({ ...ok, parsed: { offered_times: [{ date: 'Tuesday, October 13', window: '9:00 AM - 11:00 AM' }], intended_actions: [] } })).toBe(false);
    expect(scheduleStatementOnly({ ...ok, parsed: { intended_actions: [{ type: 'book_appointment' }] } })).toBe(false);
    expect(scheduleStatementOnly({ ...ok, parsed: { intended_actions: [{ type: 'send_payment_link' }] } })).toBe(false);
    expect(scheduleStatementOnly({ ...ok, openTimesSnapshot: { quotedWindows: [] }, parsed: { intended_actions: [] } })).toBe(false);
    expect(scheduleStatementOnly({ schedulingIntent: false, openTimesSnapshot: null, parsed: { intended_actions: [] } })).toBe(false);
  });

  test('draftScheduleFacts: both gates and a customer are needed; a failed read is null (no card)', async () => {
    const sig = jest.fn().mockResolvedValue('sig-9');
    jest.doMock('../services/context-aggregator', () => ({ upcomingScheduleSignature: (...a) => sig(...a) }));
    const { draftScheduleFacts } = load();
    expect(await draftScheduleFacts({ id: 'c1' })).toBeNull();
    expect(sig).not.toHaveBeenCalled();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_SCHEDULING_SUGGEST = 'true';
    const out = await draftScheduleFacts({ id: 'c1' });
    expect(out).toEqual({ signature: 'sig-9', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(await draftScheduleFacts(null)).toBeNull();
    sig.mockRejectedValue(new Error('db down'));
    expect(await draftScheduleFacts({ id: 'c1' })).toBeNull();
  });
});

describe('send seams: openLoopsBlockReason rechecks the stored schedule signature', () => {
  const load = (sigImpl) => {
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/context-aggregator', () => ({ upcomingScheduleSignature: sigImpl }));
    return require('../services/agent-decision-send-checks');
  };
  const decision = (snapshot) => ({ customer_id: 'c1', input_snapshot: JSON.stringify(snapshot) });

  test('unchanged schedule: no block; a moved, added or removed visit: schedule_changed', async () => {
    const same = load(async () => 'sig-1');
    expect(await same.openLoopsBlockReason({ decision: decision({ schedule_facts: STAMP }) })).toBeNull();
    jest.resetModules();
    const moved = load(async () => 'sig-2');
    expect(await moved.openLoopsBlockReason({ decision: decision({ schedule_facts: STAMP }) })).toBe('schedule_changed');
  });

  test('fail closed: no customer or an empty signature is schedule_unverifiable; an unreadable schedule is the retryable verdict', async () => {
    const ok = load(async () => 'sig-1');
    expect(await ok.openLoopsBlockReason({ decision: { customer_id: null, input_snapshot: JSON.stringify({ schedule_facts: STAMP }) } })).toBe('schedule_unverifiable');
    expect(await ok.openLoopsBlockReason({ decision: decision({ schedule_facts: { signature: '', at: STAMP.at } }) })).toBe('schedule_unverifiable');
    jest.resetModules();
    const failing = load(async () => { throw new Error('db down'); });
    expect(await failing.openLoopsBlockReason({ decision: decision({ schedule_facts: STAMP }) })).toBe('open_loops_recheck_failed');
  });

  test('a decision with no schedule_facts is untouched (no schedule read at all)', async () => {
    const sig = jest.fn();
    const checks = load(sig);
    expect(await checks.openLoopsBlockReason({ decision: decision({}) })).toBeNull();
    expect(sig).not.toHaveBeenCalled();
  });

  test('the immediate send path reports it through agentDecisionSendBlockReason', async () => {
    const moved = load(async () => 'sig-2');
    const reason = await moved.agentDecisionSendBlockReason({
      decision: { ...decision({ schedule_facts: STAMP }), suggested_message: base.reply, prompt_version: 'house_voice_v11' },
      outgoingBody: base.reply,
    });
    expect(reason).toBe('open-loop facts stale (schedule_changed)');
  });
});

describe('upcomingScheduleSignature (context-aggregator)', () => {
  const rowsDb = (rows) => {
    const q = { leftJoin: () => q, where: () => q, whereIn: () => q, whereNotIn: () => q, whereRaw: () => q, orderBy: () => q, select: async () => rows };
    return jest.fn(() => q);
  };
  const sigFor = async (rows) => {
    jest.resetModules();
    jest.dontMock('../services/context-aggregator'); // the real module (earlier tests mock it)
    jest.doMock('../models/db', () => rowsDb(rows));
    return require('../services/context-aggregator').upcomingScheduleSignature('c1');
  };
  const visit = (over = {}) => ({ id: 'v1', scheduled_date: '2026-10-13', window_start: '09:00:00', window_end: '11:00:00', window_display: null, time_window: null, service_type: 'Quarterly Pest', technician_name: 'Alex', ...over });

  test('stable for the same visits in any order; changes when a visit moves day or window, appears, or disappears', async () => {
    const a = await sigFor([visit(), visit({ id: 'v2', scheduled_date: '2027-01-13' })]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sigFor([visit({ id: 'v2', scheduled_date: '2027-01-13' }), visit()])).toBe(a);
    expect(await sigFor([visit({ scheduled_date: '2026-10-14' }), visit({ id: 'v2', scheduled_date: '2027-01-13' })])).not.toBe(a);
    expect(await sigFor([visit({ window_start: '13:00:00', window_end: '15:00:00' }), visit({ id: 'v2', scheduled_date: '2027-01-13' })])).not.toBe(a);
    // Codex r1: the service and the technician the draft names are part of it
    expect(await sigFor([visit({ technician_name: 'Sam' }), visit({ id: 'v2', scheduled_date: '2027-01-13' })])).not.toBe(a);
    expect(await sigFor([visit({ service_type: 'Lawn Fertilization' }), visit({ id: 'v2', scheduled_date: '2027-01-13' })])).not.toBe(a);
    // Codex r1: only the CUSTOMER-FACING window counts — an internal duration (window_end) edit changes nothing
    expect(await sigFor([visit({ window_end: '12:30:00' }), visit({ id: 'v2', scheduled_date: '2027-01-13' })])).toBe(a);
    expect(await sigFor([visit()])).not.toBe(a);
    expect(await sigFor([])).not.toBe(a);
  });

  test('no customer id: null, with no read', async () => {
    jest.resetModules();
    jest.dontMock('../services/context-aggregator');
    const db = rowsDb([]);
    jest.doMock('../models/db', () => db);
    expect(await require('../services/context-aggregator').upcomingScheduleSignature(null)).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });
});
