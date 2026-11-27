/**
 * Texting AI gap 1 (owner 2026-11-26 "BUILD 1-6"): the shadow drafter withholds OPEN TIMES less often.
 *  - A short reply to a staff text that asked the customer's availability gets OPEN TIMES, judged on the whole exchange
 *    (cut at the drafted text's own row): the job, the named day and the re-service lane all read it.
 *  - A day the customer named joins the first three days, from the same picker read.
 *  - Why a draft had no OPEN TIMES is stored on the draft row (intended_actions.open_times_withheld).
 * Synthetic names and numbers only.
 */
const { bookingExchange, namedDayMatcher, _internals } = require('../services/sms-open-times-intent');

const GATE = 'GATE_SMS_REAL_ANSWERS';
const ME = '+19415550100';
const OTHER = '+19415550199';
const NOW = new Date('2026-11-26T15:00:00Z').getTime();
const ago = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const IDENTITY_NONE = { ok: true, json: { about: 'none', visit: null, service: null } };

const cur = (body) => ({ id: 'log-9', direction: 'inbound', fromPhone: ME, body, date: ago(0) });
const staff = (body, h = 1, extra = {}) => ({ direction: 'outbound', type: 'manual', toPhone: ME, body, date: ago(h), ...extra });
const mine = (body, h) => ({ direction: 'inbound', fromPhone: ME, body, date: ago(h) });
const exchange = (body, rows, phone = ME) => bookingExchange({ smsHistory: [cur(body), ...rows], currentSmsLogId: 'log-9', inboundMessage: body, inboundPhone: phone });

describe('staffAsksAvailability: only explicit availability asks and visit offers', () => {
  test.each([
    'What day works for you?', 'What time works best?', 'When works for you?', 'Would Thursday work?', 'Would Thursday at 9 work for you?',
    'Are you available Monday?', 'We can come Monday.', 'I can come by tomorrow afternoon, does that work?', 'I have Tuesday at 9 open',
    'We have an opening Friday', 'We have availability at 9 a.m. on Monday. Would this work for you?', 'Let me know what day works',
  ])('asks: %s', (text) => expect(_internals.staffAsksAvailability(text)).toBe(true));

  test.each([
    "Did you see ants after Thursday's treatment?", 'Are you still seeing ants?', 'Good morning! Any roach sightings?',
    'Thanks, see you Thursday!', 'You are all set for Monday at 9.', 'We have your report open now?', 'Can you send a photo?',
  ])('does not ask: %s', (text) => expect(_internals.staffAsksAvailability(text)).toBe(false));
});

describe('bookingExchange', () => {
  test.each(['Anytime is fine', 'Yes, please!', 'Totally flexible. We both work from home.', "That's fine", 'Mornings works better', '12/3', 'Dec 3?', 'Thursday'])(
    '"%s" after "What day works for you?" is a reply in the exchange',
    (text) => expect(exchange(text, [staff('What day works for you?')])).toEqual({ staffText: 'What day works for you?', customerTexts: [text] }),
  );

  test("the customer's texts after the staff text ride along, oldest first; a middle clarification included", () => {
    const rows = [mine('For the lawn treatment', 0.5), staff('Sure. What day works for you?', 1), mine('Can you come for my lawn?', 2)];
    expect(exchange('Thursday', rows)).toEqual({ staffText: 'Sure. What day works for you?', customerTexts: ['For the lawn treatment', 'Thursday'] });
  });

  test('the history is cut at the drafted row: a later staff text never reads as what it answers', () => {
    const later = staff('What day works for you?', -0.1); // logged after the drafted "Yes"
    const r = bookingExchange({ smsHistory: [later, cur('Yes'), staff('You are all set.', 1)], currentSmsLogId: 'log-9', inboundMessage: 'Yes', inboundPhone: ME });
    expect(r).toBeNull();
  });

  test('the drafted row missing from the history, or no id: no exchange', () => {
    expect(bookingExchange({ smsHistory: [staff('What day works for you?')], currentSmsLogId: 'log-9', inboundMessage: 'Yes', inboundPhone: ME })).toBeNull();
    expect(bookingExchange({ smsHistory: [cur('Yes'), staff('What day works for you?')], currentSmsLogId: null, inboundMessage: 'Yes', inboundPhone: ME })).toBeNull();
  });

  test('a staff text that does not ask ends it: a day alone, a pest question, a confirmation', () => {
    expect(exchange('Yes', [staff("Did you see ants after Thursday's treatment?")])).toBeNull();
    expect(exchange('Yes', [staff('Are you still seeing ants?')])).toBeNull();
    expect(exchange('ok', [staff('You are all set for Monday at 9.'), staff('What day works for you?', 2)])).toBeNull();
  });

  test('the customer\'s own earlier booking text never carries a reply on its own', () => {
    expect(exchange('Anytime is fine', [mine('Can you come out and do the ants again?', 1)])).toBeNull();
  });

  test('automated texts and replies to another contact are skipped; the human text to this sender decides', () => {
    const reminder = staff('Reminder: your visit is tomorrow. Reply C to confirm?', 0.5, { type: 'appointment_reminder' });
    const toOther = staff('What day works for you?', 0.7, { toPhone: OTHER });
    expect(exchange('Yes', [reminder, toOther])).toBeNull();
    expect(exchange('Yes', [reminder, toOther, staff('Would Thursday work?', 1)])).toEqual({ staffText: 'Would Thursday work?', customerTexts: ['Yes'] });
    expect(exchange('Yes', [staff('What day works for you?', 1, { toPhone: null })])).toBeNull();
  });

  test("another number's text inside the exchange: nothing is carried", () => {
    expect(exchange('Anytime', [{ direction: 'inbound', fromPhone: OTHER, body: 'Friday for me', date: ago(0.5) }, staff('What day works for you?')])).toBeNull();
  });

  test('older than 72 hours, an undated row, or more than 8 rows back: no exchange', () => {
    expect(exchange('Yes', [staff('What day works for you?', 73)])).toBeNull();
    expect(exchange('Yes', [staff('What day works for you?', 1, { date: 'not a date' })])).toBeNull();
    const reminders = Array.from({ length: 8 }, () => staff('Reminder', 0.5, { type: 'reminder' }));
    expect(exchange('Yes', [...reminders, staff('What day works for you?')])).toBeNull();
  });

  test('not a short reply: a new request, long text, a reaction, no sender phone', () => {
    const q = [staff('What day works for you?')];
    expect(exchange('Please email my receipt', q)).toBeNull();
    expect(exchange('Can you send the invoice again', q)).toBeNull();
    expect(exchange(`Yes ${'x'.repeat(200)}`, q)).toBeNull();
    expect(exchange('Liked “What day works for you?”', q)).toBeNull();
    expect(exchange('Haven\'t seen any.', q)).toBeNull();
    expect(exchange('Anytime is fine', q, null)).toBeNull();
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

describe('draftShadowReply: a reply in a booking exchange gets OPEN TIMES; the withhold reason is stored', () => {
  async function runDraft({ gateOn = true, inboundMessage, smsHistory = [], schedulingIntent = false, city = 'Venice', days, upcomingServices = [], serviceHistory = [], services = [], identity = () => IDENTITY_NONE, pendingEstimate = null, currentRow = true } = {}) {
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
        summary: 'QA customer', flags: [], upcomingServices, serviceHistory, pendingEstimate,
        // the webhook logs the drafted text (sms-1) before drafting: it is the newest row
        smsHistory: currentRow ? [{ id: 'sms-1', direction: 'inbound', fromPhone: ME, body: inboundMessage, date: new Date().toISOString() }, ...smsHistory] : smsHistory,
        customer: { id: 'customer-1', billingLane: null },
        billing: { outstandingBalance: 0, recentPayments: [] },
      })),
      authorizedDuesCents: jest.fn(() => []),
    }));
    jest.doMock('../services/voice-profile-distiller', () => ({ getApprovedVoiceProfile: jest.fn(async () => null) }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => services }));
    const identityPrompts = [];
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? (identityPrompts.push(payload.text), identity(payload.text)) : {
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
    return { row: insertedRows[0], actions, getAvailableSlots, resolveDeliveryMode, identityPrompts };
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


  const staffAsk = () => ({ direction: 'outbound', type: 'manual', toPhone: ME, body: 'We can come Monday. What time works for you?', date: new Date(Date.now() - 3600e3).toISOString() });
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const pestVisit = { type: 'Pest Control', date: '2026-12-08', scheduledServiceId: 'svc-pest-1' };
  const lawnDone = { type: 'Lawn Care', date: '2026-11-02' };
  const LAWN = { service_key: 'lawn_care', name: 'Lawn Care' };
  const PEST = { service_key: 'pest_control', name: 'Pest Control' };
  const pickPest = (prompt) => (/pest/i.test(prompt.split('Their visits:')[0]) ? { ok: true, json: { about: 'visit', visit: 'V1', service: null } } : IDENTITY_NONE);
  const pickLawn = (prompt) => (/lawn/i.test(prompt.split('Their visits:')[0]) ? { ok: true, json: { about: 'new_service', visit: null, service: 'lawn_care' } } : IDENTITY_NONE);

  test('"Anytime is fine" to a staff text naming the job: OPEN TIMES for that job, scheduling draft, exchange stamped', async () => {
    const ask = { ...staffAsk(), body: 'We can come Monday for your pest service. What time works for you?' };
    const { row, actions, getAvailableSlots, resolveDeliveryMode, identityPrompts } = await runDraft({
      inboundMessage: 'Anytime is fine', smsHistory: [ask], upcomingServices: [pestVisit], services: [PEST, LAWN], identity: pickPest,
    });
    expect(identityPrompts[0]).toContain(JSON.stringify(ask.body));
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'customer-1', serviceType: 'Pest Control' });
    expect(row.facts_block).toContain('Monday, November 30: 9:00 AM - 11:00 AM');
    expect(row.scheduling_intent).toBe(true);
    expect(resolveDeliveryMode.mock.calls[0][0].schedulingIntent).toBe(true);
    expect(actions.open_times_from_thread).toBe('staff_asked');
    expect(actions.open_times_withheld).toBeUndefined();
  });

  test('a lawn ask and the clarification after it size lawn times, not the booked pest visit', async () => {
    const rows = [{ direction: 'inbound', fromPhone: ME, body: 'For the lawn treatment', date: at(0.5) }, { ...staffAsk(), body: 'Sure. What day works for you?' }];
    const { getAvailableSlots, identityPrompts } = await runDraft({
      inboundMessage: 'Thursday', smsHistory: rows, upcomingServices: [pestVisit], services: [PEST, LAWN], identity: pickLawn,
    });
    expect(identityPrompts[0]).toContain(JSON.stringify('For the lawn treatment'));
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'customer-1', serviceType: 'Lawn Care' });
  });

  test.each([
    ['one booked visit', { upcomingServices: [pestVisit] }],
    ['a booked visit and a lawn visit done', { upcomingServices: [pestVisit], serviceHistory: [lawnDone] }],
    ['a pending estimate and no visit', { pendingEstimate: { id: 'est-1' } }],
  ])('the exchange names no job (%s): withheld identity_uncertain:thread_unnamed, never the ladder', async (_label, ctx) => {
    const { getAvailableSlots, actions, row } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()], services: [PEST, LAWN], ...ctx });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(actions.open_times_withheld).toBe('identity_uncertain:thread_unnamed');
    expect(actions.open_times_from_thread).toBe('staff_asked');
    expect(row.scheduling_intent).toBe(true);
  });

  test('"Yes, please" to "Would Thursday work?" shows that Thursday even past the first three days', async () => {
    const ask = { ...staffAsk(), body: 'Would Thursday work for your pest service?' };
    const mk = (iso, label) => ({ date: iso, fullDate: label, slots: [{ startTime24: '09:00' }] });
    const { row } = await runDraft({
      inboundMessage: 'Yes, please', smsHistory: [ask], upcomingServices: [pestVisit], identity: pickPest,
      days: [mk('2026-11-30', 'Monday, November 30'), mk('2026-12-01', 'Tuesday, December 1'), mk('2026-12-02', 'Wednesday, December 2'), mk('2026-12-03', 'Thursday, December 3')],
    });
    expect(row.facts_block).toContain('- Thursday, December 3: 9:00 AM - 11:00 AM');
  });

  test('times asked but the finder offers none: no_open_days, still a scheduling draft (delivery rules hold)', async () => {
    const ask = { ...staffAsk(), body: 'We can come Monday for your pest service. What time works for you?' };
    const { row, actions } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [ask], upcomingServices: [pestVisit], identity: pickPest, days: [] });
    expect(actions.open_times_withheld).toBe('no_open_days');
    expect(row.scheduling_intent).toBe(true);
  });

  test('no booking exchange: no lookup, no keys, not a scheduling draft', async () => {
    const { row, actions, getAvailableSlots } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(row.scheduling_intent).toBe(false);
    expect(actions).not.toHaveProperty('open_times_withheld');
    expect(actions).not.toHaveProperty('open_times_from_thread');
  });

  test('the drafted row is not in the history: no exchange (fail closed)', async () => {
    const { getAvailableSlots } = await runDraft({ inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()], currentRow: false });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  test("a text the webhook already calls scheduling keeps today's path: no exchange in the identity prompt, the ladder decides", async () => {
    const { identityPrompts, getAvailableSlots, actions } = await runDraft({
      inboundMessage: 'Thursday', schedulingIntent: true, smsHistory: [staffAsk()], upcomingServices: [pestVisit], serviceHistory: [lawnDone], services: [PEST, LAWN],
    });
    expect(identityPrompts[0]).not.toContain('Earlier in this text thread');
    expect(getAvailableSlots).toHaveBeenCalledWith('Venice', null, { customerId: 'customer-1', serviceType: 'Pest Control' });
    expect(actions).not.toHaveProperty('open_times_from_thread');
  });

  test('times asked with no city to look up: no_location', async () => {
    const { actions } = await runDraft({ inboundMessage: 'Can I reschedule?', schedulingIntent: true, city: null });
    expect(actions.open_times_withheld).toBe('no_location');
  });

  test('gate off: no exchange, no new keys (byte-identical row shape)', async () => {
    const { row, actions, getAvailableSlots } = await runDraft({ gateOn: false, inboundMessage: 'Anytime is fine', smsHistory: [staffAsk()] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(row.scheduling_intent).toBe(false);
    expect(actions).not.toHaveProperty('open_times_withheld');
    expect(actions).not.toHaveProperty('open_times_from_thread');
  });
});

describe('a reply in a booking exchange after a covered pest report books through the free re-service page', () => {
  beforeEach(() => {
    process.env.SHADOW_DRAFT_VERIFY = 'false';
    process.env.SHADOW_FEWSHOT = 'false';
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    process.env.GATE_SMS_PROMPT_B1 = 'true';
  });
  afterEach(() => {
    for (const k of ['SHADOW_DRAFT_VERIFY', 'SHADOW_FEWSHOT', 'GATE_SMS_REAL_ANSWERS', 'GATE_SMS_PROMPT_B1']) delete process.env[k];
    for (const m of ['../services/availability', '../services/call-booking-catalog', '../services/llm/call', '@anthropic-ai/sdk',
      '../services/reservice-scheduler', '../routes/reservice-public']) jest.dontMock(m);
    jest.resetModules();
  });

  function mockDeps({ reply = { reply: 'ok', intended_actions: [], missing_info: null } } = {}) {
    const getAvailableSlots = jest.fn(async () => ({ days: [{ date: '2026-06-16', fullDate: 'Tuesday, June 16', slots: [{ startTime24: '09:00' }] }] }));
    const reserviceOpenings = jest.fn(async () => ({ days: [{ date: '2026-06-17', slots: [{ start_time: '10:00' }] }] }));
    jest.doMock('../services/availability', () => ({ getAvailableSlots }));
    jest.doMock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
    jest.doMock('../services/llm/call', () => ({
      dispatchWithFallback: jest.fn(async (policy, payload) => (payload?.laneId === 'sms_service_identity' ? IDENTITY_NONE : {
        ok: true, text: JSON.stringify(reply), model: 'fixture',
      })),
    }));
    jest.doMock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: jest.fn() } })));
    jest.doMock('../services/reservice-scheduler', () => ({
      ...jest.requireActual('../services/reservice-scheduler'),
      reserviceSelfServeEnabled: () => true,
      loadReserviceLaneAvailability: async () => ({ eligible: ['pest'], bookable: ['pest'], open: {}, verified: true, hasRecurringPlan: true }),
    }));
    jest.doMock('../routes/reservice-public', () => ({ _internals: { reserviceOpeningsFor: reserviceOpenings } }));
    jest.resetModules();
    return { getAvailableSlots, reserviceOpenings };
  }
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const draft = (inboundMessage, rows) => require('../services/sms-shadow-drafter').generateGroundedDraft({
    client: {},
    context: {
      summary: 'Test customer', customer: { id: 'cust-1' }, serviceHistory: [{ type: 'Quarterly Pest', date: '2026-05-20' }],
      smsHistory: [{ id: 'log-9', direction: 'inbound', fromPhone: ME, body: inboundMessage, date: at(0) }, ...rows],
    },
    inboundMessage, inboundPhone: ME, intent: { intent: 'GENERAL' }, schedulingIntent: false, city: 'Venice', voiceProfile: null, liveOpenTimes: true, smsLogId: 'log-9',
  });
  const rows = [
    { direction: 'inbound', fromPhone: ME, body: 'The ants are back in the kitchen', date: at(0.5) },
    { direction: 'outbound', type: 'manual', toPhone: ME, body: 'Sorry to hear that. What day works for you?', date: at(1) },
  ];

  test('"Anytime is fine" after the report: re-service openings, never ordinary OPEN TIMES', async () => {
    const { getAvailableSlots, reserviceOpenings } = mockDeps();
    const result = await draft('Anytime is fine', rows);
    expect(reserviceOpenings).toHaveBeenCalledWith('cust-1', { lanes: ['pest'] });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(result.factsBlock).toContain('FREE RE-SERVICE OPENINGS');
    expect(result.factsBlock).not.toContain('OPEN TIMES (real');
    expect(result.reserviceText).toBe('The ants are back in the kitchen\nAnytime is fine');
    expect(result.openTimesTrace.stamp).toEqual({ open_times_from_thread: 'staff_asked' });
  });

  test('the re-service offer checks read the exchange too: an empty reply to the carried report does not converge', async () => {
    mockDeps({ reply: { reply: '', kind: 'ABSTAIN', intended_actions: [{ type: 'none' }], missing_info: null } });
    const result = await draft('Anytime is fine', rows);
    expect(result.converged).toBe(false);
  });
});
