/**
 * Texting AI gap 1 (owner 2026-11-26 "BUILD 1-6"): the shadow drafter withholds OPEN TIMES less often.
 *  - A short follow-up ("Anytime is fine", "Yes, please!") to the thread's booking talk gets OPEN TIMES.
 *  - A day the customer named joins the first three days, from the same picker read.
 *  - Why a draft had no OPEN TIMES is stored on the draft row (intended_actions.open_times_withheld).
 * Synthetic names and numbers only.
 */
const { threadBookingIntent, namedDayMatcher, _internals } = require('../services/sms-open-times-intent');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const ME = '+19415550100';
const OTHER = '+19415550199';
const NOW = new Date('2026-11-26T15:00:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const IDENTITY_NONE = { ok: true, json: { about: 'none', visit: null, service: null } };

function intent(inboundMessage, smsHistory, phone = ME) {
  return threadBookingIntent({ smsHistory, inboundMessage, inboundPhone: phone, now: NOW });
}

describe('threadBookingIntent: a follow-up carries the thread booking talk', () => {
  const staffAsk = { direction: 'outbound', type: 'manual', body: 'We have Monday at 9 a.m. open. Would this work for you?', date: ago(2) };

  test.each([
    'Anytime is fine',
    'Yes, please!',
    'Totally flexible. We both work from home.',
    "That's fine",
    'Mornings works better. Earlier if possible',
  ])('"%s" after a staff booking question is carried', (text) => {
    expect(intent(text, [staffAsk])).toEqual({ carried: true, reason: 'staff_asked' });
  });

  test('the current text logged as the first row is skipped once', () => {
    expect(intent('Yes, please!', [{ direction: 'inbound', fromPhone: ME, body: 'Yes, please!', date: ago(0) }, staffAsk]).carried).toBe(true);
  });

  test("the customer's own earlier booking ask carries a follow-up", () => {
    const rows = [{ direction: 'inbound', fromPhone: ME, body: 'Can you come out and do the ants again?', date: ago(1) }];
    expect(intent('Anytime is fine', rows)).toEqual({ carried: true, reason: 'prior_inbound' });
  });

  test('an earlier text with only a time word is not a booking ask', () => {
    const rows = [{ direction: 'inbound', fromPhone: ME, body: 'Thanks for coming today', date: ago(1) }];
    expect(intent('ok', rows).carried).toBe(false);
  });

  test('an automated reminder never carries it; the walk goes past it to the human reply', () => {
    const reminder = { direction: 'outbound', type: 'appointment_reminder', body: 'Reminder: your visit is tomorrow. Reply C to confirm or R to reschedule?', date: ago(1) };
    expect(intent('Yes', [reminder]).carried).toBe(false);
    expect(intent('Yes', [reminder, staffAsk]).carried).toBe(true);
  });

  test('a staff reply that asks nothing ends the booking talk', () => {
    const done = { direction: 'outbound', type: 'manual', body: 'You are all set for Monday at 9.', date: ago(1) };
    expect(intent('ok', [done, staffAsk]).carried).toBe(false);
  });

  test('a staff question about something else does not carry it', () => {
    const q = { direction: 'outbound', type: 'manual', body: 'Any roach sightings since the visit?', date: ago(1) };
    expect(intent('Yes', [q]).carried).toBe(false);
  });

  test("another number's booking ask is not this sender's thread", () => {
    const rows = [{ direction: 'inbound', fromPhone: OTHER, body: 'Can we reschedule?', date: ago(1) }];
    expect(intent('Anytime is fine', rows).carried).toBe(false);
  });

  test('old or undated rows end the walk', () => {
    expect(intent('Anytime is fine', [{ ...staffAsk, date: ago(80) }]).carried).toBe(false);
    expect(intent('Anytime is fine', [{ ...staffAsk, date: 'not a date' }]).carried).toBe(false);
  });

  test('only the last four earlier texts are read', () => {
    const filler = Array.from({ length: 4 }, () => ({ direction: 'outbound', type: 'reminder', body: 'Reminder text', date: ago(1) }));
    expect(intent('Anytime is fine', [...filler, staffAsk]).carried).toBe(false);
  });

  test('not a follow-up shape: long text, reaction, no reply words, no sender phone', () => {
    expect(intent(`Yes ${'x'.repeat(200)}`, [staffAsk]).carried).toBe(false);
    expect(intent('Liked “We have Monday at 9 a.m. open. Would this work for you?”', [staffAsk]).carried).toBe(false);
    expect(intent("Haven't seen any.", [staffAsk]).carried).toBe(false);
    expect(intent('Anytime is fine', [staffAsk], null).carried).toBe(false);
  });
});

describe('namedDayMatcher', () => {
  test('weekday names, abbreviations and plurals', () => {
    const m = namedDayMatcher('I can only do Mondays or Fri.');
    expect(m('Monday, November 30')).toEqual(['weekday:monday']);
    expect(m('Friday, December 4')).toEqual(['weekday:friday']);
    expect(m('Tuesday, December 1')).toEqual([]);
  });

  test('month-day, numeric and ordinal dates', () => {
    expect(namedDayMatcher('How about Dec 3?')('Thursday, December 3')).toEqual(['date:12/3']);
    expect(namedDayMatcher('12/3 works')('Thursday, December 3')).toEqual(['date:12/3']);
    expect(namedDayMatcher("I'm looking at the 19th")('Saturday, December 19')).toEqual(['day:19']);
    expect(namedDayMatcher('Dec 3')('Thursday, November 3')).toEqual([]);
  });

  test('no named day, or a word that is not a day', () => {
    expect(namedDayMatcher('Anytime is fine')).toBeNull();
    expect(namedDayMatcher('I sat outside in the sun on mon')).toBeNull();
    expect(namedDayMatcher('13/45')).toBeNull();
  });

  test('an unreadable label answers nothing', () => {
    expect(namedDayMatcher('Thursday')('2026-12-03')).toEqual([]);
    expect(_internals.parseLabel('Thursday, Smarch 3')).toBeNull();
  });
});

describe('fetchOpenTimesData: a named day past the first three', () => {
  const day = (iso, label, start = '09:00') => ({ date: iso, fullDate: label, slots: [{ startTime24: start }] });
  const DAYS = [
    day('2026-11-30', 'Monday, November 30'),
    day('2026-12-01', 'Tuesday, December 1'),
    day('2026-12-02', 'Wednesday, December 2'),
    day('2026-12-03', 'Thursday, December 3'),
    day('2026-12-04', 'Friday, December 4'),
    day('2026-12-07', 'Monday, December 7'),
    day('2026-12-10', 'Thursday, December 10'),
  ];
  function fresh(days = DAYS) {
    jest.resetModules();
    process.env[GATE] = 'true';
    jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => ({ days })) }));
    return require('../services/sms-shadow-drafter');
  }
  afterEach(() => {
    jest.dontMock('../services/availability');
    jest.resetModules();
    delete process.env[GATE];
  });

  test('no named day: the first three days, as before', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, namedDay: namedDayMatcher('Anytime') });
    expect(r.days.map((x) => x.date)).toEqual(['Monday, November 30', 'Tuesday, December 1', 'Wednesday, December 2']);
    expect(r.withheld).toBeUndefined();
  });

  test('"Thursday or Friday": the first Thursday and the first Friday join, once each', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, namedDay: namedDayMatcher('Thursday or Friday works') });
    expect(r.days.map((x) => x.date)).toEqual([
      'Monday, November 30', 'Tuesday, December 1', 'Wednesday, December 2', 'Thursday, December 3', 'Friday, December 4',
    ]);
    expect(r.block).toContain('- Friday, December 4: 9:00 AM - 11:00 AM');
  });

  test('a named day already among the first three adds nothing', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, namedDay: namedDayMatcher('Monday please') });
    expect(r.days).toHaveLength(3);
  });

  test('at most two named days join', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, namedDay: namedDayMatcher('Thursday, Friday or Dec 10') });
    expect(r.days).toHaveLength(5);
  });

  test('a named day the picker does not offer is never invented', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, namedDay: namedDayMatcher('Saturday?') });
    expect(r.days).toHaveLength(3);
    expect(r.block).not.toContain('Saturday');
  });

  test('the picker offers no window: withheld no_open_days; a failed read: fetch_failed', async () => {
    let d = fresh([]);
    expect((await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true })).withheld).toBe('no_open_days');
    jest.resetModules();
    jest.doMock('../services/availability', () => ({ getAvailableSlots: jest.fn(async () => { throw new Error('down'); }) }));
    d = require('../services/sms-shadow-drafter');
    expect((await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true })).withheld).toBe('fetch_failed');
  });

  test('a /book offer with no funnel service is withheld no_book_service, no picker read', async () => {
    const d = fresh();
    const r = await d.fetchOpenTimesData({ city: 'Venice', customerId: 'c1', schedulingIntent: true, schedulerOffer: { source: 'book', serviceKey: '' } });
    expect(r).toEqual({ block: null, days: [], withheld: 'no_book_service' });
  });

  test('a named day the send-time recheck still finds: the recheck reads every picker day', async () => {
    const d = fresh();
    const r = await d.openTimesStillOffered({ city: 'Venice', customerId: 'c1', quotedWindows: [{ date: 'Thursday, December 10', window: '9:00 AM - 11:00 AM' }] });
    expect(r).toEqual({ ok: true });
  });
});

describe('draftShadowReply: thread follow-ups get OPEN TIMES; the withhold reason is stored', () => {
  async function runDraft({ gateOn = true, inboundMessage, smsHistory = [], schedulingIntent = false, city = 'Venice', days } = {}) {
    jest.resetModules();
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    process.env.SHADOW_FEWSHOT = 'false';
    if (gateOn) process.env[GATE] = 'true';
    else delete process.env[GATE];
    const insertedRows = [];
    const mockDb = jest.fn((table) => {
      if (table !== 'message_drafts') throw new Error(`unexpected table: ${table}`);
      return { insert: jest.fn((row) => { insertedRows.push(row); return { returning: jest.fn(async () => [{ id: 'draft-1' }]) }; }) };
    });
    const getAvailableSlots = jest.fn(async () => ({
      days: days || [{ date: '2026-11-30', fullDate: 'Monday, November 30', slots: [{ startTime24: '09:00' }] }],
    }));
    const resolveDeliveryMode = jest.fn(async () => 'shadow');
    jest.doMock('../models/db', () => mockDb);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    jest.doMock('../services/context-aggregator', () => ({
      getContextForCustomer: jest.fn(async () => ({
        summary: 'QA customer', flags: [], smsHistory,
        customer: { id: 'customer-1', billingLane: null },
        billing: { outstandingBalance: 0, recentPayments: [] },
      })),
      authorizedDuesCents: jest.fn(() => []),
    }));
    jest.doMock('../services/voice-profile-distiller', () => ({ getApprovedVoiceProfile: jest.fn(async () => null) }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? IDENTITY_NONE : {
        ok: true, text: JSON.stringify({ reply: 'Here are some times.', intended_actions: [], missing_info: null }), model: 'fixture-model',
      })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    jest.doMock('../services/sms-auto-send', () => ({
      autoSendActionsSafe: jest.fn(() => true),
      maybeAutoSend: jest.fn(async () => ({ sent: false, reason: 'ineligible_base' })),
    }));
    jest.doMock('../services/sms-suggest-mode', () => ({
      AUTO_SEND_MODE: 'auto_send', SUGGESTED_STATUS: 'suggested', resolveDeliveryMode,
      publishSuggestion: jest.fn(async () => null), supersedeStaleSuggestions: jest.fn(async () => 0),
      hasRedactionPlaceholder: jest.fn(() => false), hasPriceQuote: jest.fn(() => false),
    }));
    jest.doMock('../services/comms-lint', () => ({ lintComms: jest.fn(() => ({ pass: true, failures: [] })), toFlags: jest.fn(() => []) }));
    const { draftShadowReply } = require('../services/sms-shadow-drafter');
    await draftShadowReply({
      inboundMessage, fromPhone: ME, customer: { id: 'customer-1', city, first_name: 'Pat' }, smsLogId: 'sms-1',
      intent: { intent: 'general_customer_sms_needs_review', confidence: 0.9 }, schedulingIntent,
    });
    const actions = insertedRows[0] ? JSON.parse(insertedRows[0].intended_actions) : null;
    return { row: insertedRows[0], actions, getAvailableSlots, resolveDeliveryMode };
  }

  afterEach(() => {
    delete process.env.SHADOW_DRAFT_VERIFY;
    delete process.env.SHADOW_FEWSHOT;
    delete process.env[GATE];
    for (const m of ['../models/db', '../services/logger', '../services/availability', '../services/context-aggregator',
      '../services/voice-profile-distiller', '../services/call-booking-catalog', '../services/llm/call', '@anthropic-ai/sdk',
      '../services/sms-auto-send', '../services/sms-suggest-mode', '../services/comms-lint']) jest.dontMock(m);
    jest.resetModules();
  });

  const staffAsk = () => ({ direction: 'outbound', type: 'manual', body: 'We can come Monday. What time works for you?', date: new Date(Date.now() - 3600e3).toISOString() });

  test('"Anytime is fine" after a staff booking question: OPEN TIMES shown, scheduling draft, thread reason stored', async () => {
    const { row, actions, getAvailableSlots, resolveDeliveryMode } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()] });
    expect(getAvailableSlots).toHaveBeenCalled();
    expect(row.facts_block).toContain('Monday, November 30: 9:00 AM - 11:00 AM');
    expect(row.scheduling_intent).toBe(true);
    expect(resolveDeliveryMode.mock.calls[0][0].schedulingIntent).toBe(true);
    expect(actions.open_times_from_thread).toBe('staff_asked');
    expect(actions.open_times_withheld).toBeUndefined();
  });

  test('the same follow-up with no booking talk in the thread: no lookup, no keys, not a scheduling draft', async () => {
    const { row, actions, getAvailableSlots } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(row.scheduling_intent).toBe(false);
    expect(actions).not.toHaveProperty('open_times_withheld');
    expect(actions).not.toHaveProperty('open_times_from_thread');
  });

  test('times asked but the finder offers none: open_times_withheld = no_open_days; the thread follow-up stays non-scheduling', async () => {
    const { row, actions } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()], days: [] });
    expect(actions.open_times_withheld).toBe('no_open_days');
    expect(actions.open_times_from_thread).toBe('staff_asked');
    expect(row.scheduling_intent).toBe(false);
  });

  test('times asked with no city to look up: no_location', async () => {
    const { actions } = await runDraft({ inboundMessage: 'Can I reschedule?', schedulingIntent: true, city: null });
    expect(actions.open_times_withheld).toBe('no_location');
  });

  test('gate off: no thread lookup, no new keys (byte-identical row shape)', async () => {
    const { row, actions, getAvailableSlots } = await runDraft({ gateOn: false, inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(row.scheduling_intent).toBe(false);
    expect(actions).not.toHaveProperty('open_times_withheld');
    expect(actions).not.toHaveProperty('open_times_from_thread');
  });
});
