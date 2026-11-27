'use strict';

/**
 * SMS multi-turn thread continuity (GATE_SMS_THREAD_CONTINUITY, dark by default).
 * Verifies every safeguard against the #8658 failure modes and Codex P1s:
 *  - short scheduling follow-ups ("Anytime works", "Tuesday afternoon") carry
 *    context from a confirmed sent/delivered staff appointment question or prior booking ask
 *  - non-scheduling messages ("I prefer email for invoices", "Thanks!") never carry
 *  - staff questions about callbacks/phone calls/invoices never carry appointment times
 *  - unsent/failed/scheduled/missing-status staff messages never carry or close the thread
 *  - automated reminder/confirmation texts are skipped
 *  - other phone numbers on the same customer account are strictly isolated
 *  - a staff reply that asks no scheduling question closes the thread and blocks older service context
 *  - single_upcoming + open estimate withholds as thread_ambiguous
 *  - carryReason is strictly null when not carried, and carried replies propagate schedulingIntent
 */

const {
  threadSchedulingFollowUp,
  resolveThreadSchedulingContext,
  buildThreadIdentityInput,
  disambiguateThreadIdentity,
  effectiveSchedulingIntent,
} = require('../services/sms-open-times-intent');
const { smsThreadContinuityLive } = require('../config/feature-gates');

const ME = '+19415550100';
const SPOUSE = '+19415550199';
const WAVES = '+19415550111';
const NOW = new Date('2026-11-27T16:00:00Z');
const minsAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

describe('smsThreadContinuityLive gate', () => {
  const OLD = process.env.GATE_SMS_THREAD_CONTINUITY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_SMS_THREAD_CONTINUITY;
    else process.env.GATE_SMS_THREAD_CONTINUITY = OLD;
  });

  test('defaults off and turns on only for strict "true"', () => {
    delete process.env.GATE_SMS_THREAD_CONTINUITY;
    expect(smsThreadContinuityLive()).toBe(false);
    process.env.GATE_SMS_THREAD_CONTINUITY = '1';
    expect(smsThreadContinuityLive()).toBe(false);
    process.env.GATE_SMS_THREAD_CONTINUITY = 'true';
    expect(smsThreadContinuityLive()).toBe(true);
  });
});

describe('threadSchedulingFollowUp', () => {
  test('carries short flexibility reply after confirmed staff scheduling question and preserves prior service context', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime is fine',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'Do you prefer morning or afternoon next week?', date: minsAgo(15), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we reschedule my lawn care visit?', date: minsAgo(25), type: null, status: 'received', fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(out.carried).toBe(true);
    expect(out.reason).toBe('staff_scheduling_question');
    expect(out.anchorText).toContain('reschedule my lawn care visit');
    expect(out.anchorText).toContain('morning or afternoon');
  });

  test('stops collecting older customer service context at an intervening staff closure', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best to come out?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'outbound', body: 'All set, your lawn care visit is finished.', date: minsAgo(60), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Thanks for doing my lawn care!', date: minsAgo(120), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(out.carried).toBe(true);
    expect(out.anchorText).not.toContain('lawn care');
  });

  test('carries named-day follow-up after prior customer booking ask', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Tuesday afternoon works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'inbound', body: 'Need to move my upcoming pest appointment', date: minsAgo(40), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(out.carried).toBe(true);
    expect(out.reason).toBe('prior_customer_booking_ask');
    expect(out.anchorText).toContain('move my upcoming pest appointment');
  });

  test.each([
    'What time works for a phone call about your invoice?',
    'When works best for me to give you a call back about billing?',
    'Morning or afternoon for a quick call about your payment?',
  ])('does NOT treat a callback/billing staff question as an appointment scheduling question: %s', (staffQuestion) => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: staffQuestion, date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(out.carried).toBe(false);
    expect(out.reason).toBe('staff_closed_thread');
  });

  test.each([
    'I prefer email for invoices please',
    'Thanks so much!',
    'Sounds good, please cancel my service',
    'Anytime you can send the receipt for my payment',
    'Morning! Still seeing ghost ants by the kitchen sink',
  ])('never hijacks non-scheduling message: %s', (msg) => {
    const out = threadSchedulingFollowUp({
      inboundMessage: msg,
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for your visit?', date: minsAgo(10), type: 'manual', status: 'sent', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(out.carried).toBe(false);
  });

  test('ignores unsent, failed, canceled, scheduled, or missing-status outbound staff texts', () => {
    for (const status of ['failed', 'undelivered', 'canceled', 'scheduled', 'draft', 'queued', null, undefined, '']) {
      const out = threadSchedulingFollowUp({
        inboundMessage: 'Anytime works',
        inboundPhone: ME,
        now: NOW,
        smsHistory: [
          { direction: 'outbound', body: 'What day works best for you?', date: minsAgo(10), type: 'manual', status, fromPhone: WAVES, toPhone: ME },
        ],
      });
      expect(out.carried).toBe(false);
    }
  });

  test('strictly isolates another household contact phone number', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for you?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: SPOUSE },
        { direction: 'inbound', body: 'Can we reschedule our visit?', date: minsAgo(20), fromPhone: SPOUSE, toPhone: WAVES },
      ],
    });
    expect(out.carried).toBe(false);
  });

  test('fails closed when inboundPhone is missing', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: '',
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best?', date: minsAgo(10), type: 'manual', status: 'sent', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(out).toEqual({ carried: false, reason: 'no_sender_phone', anchorText: '' });
  });

  test('a confirmed staff reply without a scheduling question closes the thread', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Sounds good',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'All set, we got you moved to Thursday 10-12.', date: minsAgo(5), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we move my visit?', date: minsAgo(30), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(out).toEqual({ carried: false, reason: 'staff_closed_thread', anchorText: '' });
  });

  test('skips automated appointment reminders when looking back for the human thread', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'Reminder: your visit is tomorrow between 9-11 AM.', date: minsAgo(5), type: 'appointment_reminder', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'outbound', body: 'What day works best to move your visit?', date: minsAgo(20), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(out.carried).toBe(true);
    expect(out.reason).toBe('staff_scheduling_question');
  });

  test('ignores messages older than 72 hours', () => {
    const out = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for you?', date: hoursAgo(80), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(out.carried).toBe(false);
  });

  test('carryReason is null on rejected checks, single_upcoming + open estimate withholds as thread_ambiguous, and carried replies set effectiveSchedulingIntent', () => {
    const rejected = resolveThreadSchedulingContext({
      frozen: false,
      liveOpenTimes: true,
      directTimesAsked: false,
      realAnswersOn: true,
      continuityOn: true,
      inboundMessage: 'Thanks!',
      inboundPhone: ME,
      context: { smsHistory: [] },
      asOf: NOW,
    });
    expect(rejected.carried).toBe(false);
    expect(rejected.carryReason).toBeNull();

    const ambiguous = disambiguateThreadIdentity(
      { carried: true },
      { serviceType: 'Quarterly Pest', certain: true, reason: 'single_upcoming' },
      { upcomingServices: [{ type: 'Quarterly Pest' }] },
      { id: 'est-open-1' },
    );
    expect(ambiguous).toEqual({ serviceType: null, certain: false, reason: 'thread_ambiguous' });

    expect(effectiveSchedulingIntent(false, { open_times_from_thread: 'staff_scheduling_question' })).toBe(true);
    expect(effectiveSchedulingIntent(false, {})).toBe(false);
    expect(effectiveSchedulingIntent(true, {})).toBe(true);
  });

  test('preserves prior service anchor when a short follow-up already triggers directTimesAsked ("Tuesday afternoon")', () => {
    const resolved = resolveThreadSchedulingContext({
      frozen: false,
      liveOpenTimes: true,
      directTimesAsked: true,
      realAnswersOn: true,
      continuityOn: true,
      inboundMessage: 'Tuesday afternoon',
      inboundPhone: ME,
      context: {
        smsHistory: [
          { direction: 'outbound', body: 'What day works best for your lawn care visit?', date: minsAgo(10), type: 'ai_approved', status: 'delivered', fromPhone: WAVES, toPhone: ME },
          { direction: 'inbound', body: 'Need to move my lawn care visit', date: minsAgo(20), fromPhone: ME, toPhone: WAVES },
        ],
      },
      asOf: NOW,
    });
    expect(resolved.timesAsked).toBe(true);
    expect(resolved.carried).toBe(false);
    expect(resolved.carryReason).toBeNull();
    expect(resolved.anchorText).toContain('lawn care visit');
    expect(buildThreadIdentityInput(resolved, 'Tuesday afternoon')).toContain('Need to move my lawn care visit');
    expect(buildThreadIdentityInput(resolved, 'Tuesday afternoon')).toContain('Customer follow-up: Tuesday afternoon');
  });

  test('recognizes ai_approved outbound turns as BOTH scheduling questions and thread closures', () => {
    const asked = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for your visit?', date: minsAgo(10), type: 'ai_approved', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(asked.carried).toBe(true);

    const closed = threadSchedulingFollowUp({
      inboundMessage: 'Sounds good',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'All set, we moved you to Thursday 10-12.', date: minsAgo(5), type: 'ai_approved', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we reschedule my visit?', date: minsAgo(20), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(closed).toEqual({ carried: false, reason: 'staff_closed_thread', anchorText: '' });
  });

  test('stops lookback at customer withdrawal or topic change, rejects verb "am", and excludes prior phone-call scheduling asks', () => {
    const withdrawn = threadSchedulingFollowUp({
      inboundMessage: 'Sounds good',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'inbound', body: 'Never mind, keep my visit as scheduled', date: minsAgo(10), fromPhone: ME, toPhone: WAVES },
        { direction: 'inbound', body: 'Can we reschedule my visit?', date: minsAgo(25), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(withdrawn).toEqual({ carried: false, reason: 'customer_changed_topic', anchorText: '' });

    const verbAm = threadSchedulingFollowUp({
      inboundMessage: 'I am still waiting for the report.',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for your visit?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(verbAm.carried).toBe(false);

    const clockAm = threadSchedulingFollowUp({
      inboundMessage: '9 am works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What time works best for your visit?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(clockAm.carried).toBe(true);

    const phoneCallAsk = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'inbound', body: 'Can we schedule a phone call to go over my account?', date: minsAgo(15), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(phoneCallAsk.carried).toBe(false);
  });

  test('uses live context.pendingEstimate when openEstimate arg is omitted (including zero upcoming + last_completed fallback)', () => {
    const ambiguousWithUpcoming = disambiguateThreadIdentity(
      { carried: true, anchorText: 'Can we reschedule?' },
      { serviceType: 'Quarterly Pest', certain: true, reason: 'single_upcoming' },
      { upcomingServices: [{ type: 'Quarterly Pest' }], pendingEstimate: { id: 'est-live-1', status: 'sent' } },
      null,
    );
    expect(ambiguousWithUpcoming).toEqual({ serviceType: null, certain: false, reason: 'thread_ambiguous' });

    const ambiguousWithZeroUpcoming = disambiguateThreadIdentity(
      { carried: true, anchorText: 'Can we schedule?' },
      { serviceType: 'Lawn Care', certain: true, reason: 'last_completed' },
      { upcomingServices: [], pendingEstimate: { id: 'est-live-2', status: 'sent' } },
      null,
    );
    expect(ambiguousWithZeroUpcoming).toEqual({ serviceType: null, certain: false, reason: 'thread_ambiguous' });
  });

  test('rejects current-reply withdrawal, preserves pest/service name inside explicit booking asks, and checks preceding customer subject on generic staff questions', () => {
    const currentWithdrawal = threadSchedulingFollowUp({
      inboundMessage: 'Never mind, either is fine',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best for your visit?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
      ],
    });
    expect(currentWithdrawal.carried).toBe(false);

    const mosquitoStandalone = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'inbound', body: 'Can we reschedule my mosquito treatment?', date: minsAgo(15), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(mosquitoStandalone.carried).toBe(true);
    expect(mosquitoStandalone.anchorText).toContain('mosquito treatment');

    const mosquitoBeforeStaff = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What day works best?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we reschedule my mosquito treatment?', date: minsAgo(20), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(mosquitoBeforeStaff.carried).toBe(true);
    expect(mosquitoBeforeStaff.anchorText).toContain('mosquito treatment');

    const genericStaffAfterCallAsk = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'What time works best?', date: minsAgo(10), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we schedule a phone call to discuss my account?', date: minsAgo(20), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(genericStaffAfterCallAsk).toEqual({ carried: false, reason: 'non_appointment_subject', anchorText: '' });

    // Codex P2: customer switching from a lawn reschedule to a phone-call request stops lookback
    const switchedToPhoneCall = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'inbound', body: 'Can we schedule a phone call?', date: minsAgo(10), fromPhone: ME, toPhone: WAVES },
        { direction: 'inbound', body: 'Can we reschedule my lawn visit?', date: minsAgo(20), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(switchedToPhoneCall).toEqual({ carried: false, reason: 'customer_changed_topic', anchorText: '' });

    // Codex P2: successive staff scheduling questions preserve the original service anchor
    const multiTurnServiceContext = threadSchedulingFollowUp({
      inboundMessage: 'Anytime works',
      inboundPhone: ME,
      now: NOW,
      smsHistory: [
        { direction: 'outbound', body: 'Morning or afternoon for your visit?', date: minsAgo(5), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Tuesday works', date: minsAgo(10), fromPhone: ME, toPhone: WAVES },
        { direction: 'outbound', body: 'What day works best?', date: minsAgo(15), type: 'manual', status: 'delivered', fromPhone: WAVES, toPhone: ME },
        { direction: 'inbound', body: 'Can we reschedule my lawn care visit?', date: minsAgo(25), fromPhone: ME, toPhone: WAVES },
      ],
    });
    expect(multiTurnServiceContext.carried).toBe(true);
    expect(multiTurnServiceContext.reason).toBe('staff_scheduling_question');
    expect(multiTurnServiceContext.anchorText).toContain('reschedule my lawn care visit');
    expect(multiTurnServiceContext.anchorText).toContain('Tuesday works');
    expect(multiTurnServiceContext.anchorText).toContain('Morning or afternoon for your visit?');
  });
});
