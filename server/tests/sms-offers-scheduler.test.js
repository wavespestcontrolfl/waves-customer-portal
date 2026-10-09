/**
 * GATE_SMS_OFFERS_SCHEDULER (owner ruling 2026-09-29): with the gate on, every
 * appointment time the texting AI offers comes from the picker that would
 * COMMIT the visit, never the old zone-based availability finder:
 *   slice 1: ONE upcoming visit -> the reschedule link's own picker
 *     (routes/reschedule-public.js buildAvailabilityForService);
 *   slice 1b: an open / linked estimate -> the estimate page's picker
 *     (routes/estimate-slots-public.js offerableEstimateSlots); a new visit
 *     (new_booking / last_completed / engine_default) -> the /book funnel's
 *     (routes/booking.js availabilityForExistingCustomer).
 * A job whose picker offers nothing gets NO OPEN TIMES. Gate off is
 * byte-identical.
 *
 * No DB, no network: the picker pieces, the old finder, the catalog and the
 * identity model lane are all mocked.
 */
const mockIdentity = { answer: { about: 'none', visit: null, service: null }, prompts: [] };
const mockCatalog = { services: [] };
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => mockCatalog.services }));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return {
    ...actual,
    dispatchWithFallback: (policy, payload, options) => {
      if (payload?.laneId === 'sms_service_identity') {
        mockIdentity.prompts.push(payload.text);
        return Promise.resolve({ ok: true, json: mockIdentity.answer });
      }
      return actual.dispatchWithFallback(policy, payload, options);
    },
  };
});

const GATES = ['GATE_SMS_REAL_ANSWERS', 'GATE_SMS_OFFERS_SCHEDULER', 'SHADOW_DRAFT_VERIFY', 'SHADOW_FEWSHOT'];
const prior = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));

const VISIT_ID = 'ss-visit-0001-secret-id';
const SVC = { id: VISIT_ID, customer_id: 'cust-9', service_type: 'Quarterly Pest', customer_deleted_at: null };

// Scheduler days: every feasible start, YYYY-MM-DD dates, fullDate from the
// picker's own dateLabels — and NO other label field the drafter could lean on.
const PICKER_DAYS = [
  { date: '2026-09-29', slots: [{ startTime24: '09:00' }, { startTime24: '09:15' }, { startTime24: '09:30' }, { startTime24: '11:00' }, { startTime24: '13:00' }, { startTime24: '15:00' }] },
  { date: '2026-09-30', slots: [{ startTime24: '14:00' }] },
  { date: '2026-10-01', slots: [] },
  { date: '2026-10-02', slots: [{ startTime24: '08:00' }] },
  { date: '2026-10-03', slots: [{ startTime24: '08:00' }] },
];

function upcomingEntry(type, date, id, seriesKey = null) {
  const entry = { type, date, window: null, status: 'confirmed', tech: null, isToday: false };
  // Same shape context-aggregator builds: the id and the series link are NON-ENUMERABLE.
  if (id) Object.defineProperty(entry, 'scheduledServiceId', { value: id, enumerable: false });
  Object.defineProperty(entry, 'seriesKey', { value: seriesKey, enumerable: false });
  return entry;
}

function makeClient(scripted) {
  const queue = [...scripted];
  const calls = [];
  return {
    calls,
    messages: {
      create: (args) => {
        calls.push(args);
        const next = queue.shift();
        if (next === undefined) throw new Error('out of scripted responses');
        return Promise.resolve({ content: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] });
      },
    },
  };
}

let oldFinder;
let picker;
let book;
let estimateSlots;

// The /book funnel's days for a customer (availabilityForExistingCustomer) and
// the estimate page's primary + expander chips (offerableEstimateSlots).
const BOOK_DAYS = [
  { date: '2026-09-30', slots: [{ startTime24: '08:00' }, { startTime24: '10:00' }] },
  { date: '2026-10-01', slots: [{ startTime24: '13:00' }] },
];
const ESTIMATE_SLOTS = {
  primary: [{ date: '2026-10-02', windowStart: '09:00' }, { date: '2026-10-02', windowStart: '13:00' }],
  expander: [{ date: '2026-10-05', windowStart: '10:00' }],
};
// The funnel keys the real normalizer accepts (booking.js), enough for these cases.
const FUNNEL_KEYS = { pest_control: 'pest_control', lawn_care: 'lawn_care', mosquito: 'mosquito', 'pest control': 'pest_control', 'lawn care': 'lawn_care' };

function mockBookAndEstimate() {
  book = {
    availabilityForExistingCustomer: jest.fn(async () => ({ days: BOOK_DAYS })),
    normalizeBookingServiceKey: (v) => FUNNEL_KEYS[String(v || '').toLowerCase()] || '',
    loadBookingConfig: jest.fn(async () => ({ advance_days_min: 1 })),
  };
  estimateSlots = { offerableEstimateSlots: jest.fn(async () => ESTIMATE_SLOTS) };
  jest.doMock('../routes/booking', () => ({ _internals: book }));
  jest.doMock('../routes/estimate-slots-public', () => ({ _internals: estimateSlots }));
}

function mockPicker({ eligibility = { ok: true }, loaded = SVC, days = PICKER_DAYS, availability } = {}) {
  picker = {
    loadById: jest.fn(async () => loaded),
    pageEligibility: jest.fn(async () => eligibility),
    bookingRange: jest.fn(() => ({ rangeFrom: '2026-09-29', rangeTo: '2026-10-13' })),
    buildAvailabilityForService: jest.fn(async () => (availability !== undefined ? availability : { days })),
  };
  jest.doMock('../routes/reschedule-public', () => ({ _internals: picker }));
}

function mockOldFinder() {
  oldFinder = jest.fn(async () => ({
    zone: 'Venice Zone',
    days: [{ fullDate: 'Friday, October 9', slots: [{ startTime24: '10:00' }] }],
  }));
  jest.doMock('../services/availability', () => ({ getAvailableSlots: oldFinder }));
}

function freshDrafter() {
  jest.resetModules();
  return require('../services/sms-shadow-drafter');
}

const baseContext = (upcomingServices, serviceHistory = []) => ({
  summary: 'Dana — Quarterly Pest, Venice', customer: { id: 'cust-9' }, upcomingServices, serviceHistory,
});

function argsFor(client, context, extra = {}) {
  return {
    client, context, inboundMessage: 'Can we move my visit?',
    intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: true, city: 'Venice', ...extra,
  };
}

const replyWith = (window, date) => [
  { reply: `How about ${window}?`, intended_actions: [], missing_info: null, offered_times: [{ date, window }] },
  { supported: true, violations: [] },
];
const plainReply = () => [
  { reply: 'I will confirm and get right back to you.', intended_actions: [], missing_info: null },
  { supported: true, violations: [] },
];

beforeEach(() => {
  process.env.GATE_SMS_REAL_ANSWERS = 'true';
  delete process.env.GATE_SMS_OFFERS_SCHEDULER;
  process.env.SHADOW_FEWSHOT = 'false';
  mockIdentity.answer = { about: 'none', visit: null, service: null };
  mockIdentity.prompts = [];
  mockOldFinder();
  mockBookAndEstimate();
  mockPicker();
  mockCatalog.services = [];
});

afterEach(() => {
  for (const g of GATES) {
    if (prior[g] === undefined) delete process.env[g];
    else process.env[g] = prior[g];
  }
  jest.dontMock('../services/availability');
  jest.dontMock('../routes/reschedule-public');
  jest.dontMock('../routes/booking');
  jest.dontMock('../routes/estimate-slots-public');
  jest.resetModules();
});

const factsOf = (client) => client.calls[0].messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
  + JSON.stringify(client.calls[0].system || '');

describe('gate off — byte-identical to today', () => {
  test('the zone finder answers, the scheduler picker is never touched, snapshot keeps its old shape', async () => {
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9'));
    const r = await drafter.generateGroundedDraft(argsFor(client, context));
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9', serviceType: 'Quarterly Pest' });
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(picker.buildAvailabilityForService).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toEqual({
      lookup: { city: 'Venice', customerId: 'cust-9', estimateId: null, serviceType: 'Quarterly Pest' },
      quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }],
    });
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('scheduledServiceId');
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('source');
  });

  test('the identity resolution carries no id field into anything else', () => {
    const drafter = freshDrafter();
    // no visit id on the context → identity shape unchanged
    return drafter.serviceIdentityFor('move it', baseContext([upcomingEntry('Quarterly Pest', '2026-10-02')])).then((identity) => {
      expect(identity).toEqual({ serviceType: 'Quarterly Pest', certain: true, reason: 'single_upcoming' });
    });
  });
});

describe('gate off — a recurring series stays ambiguous (Codex #6172 r1 P1)', () => {
  test('several upcoming visits of one service: no next-of-series identity, no prompt line, nothing offered by either path', async () => {
    const drafter = freshDrafter();
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-oct', 'series-1'),
      upcomingEntry('Quarterly Pest', '2027-01-02', 'id-jan', 'series-1'),
    ]);
    expect(await drafter.serviceIdentityFor('can we move my appointment?', context)).toEqual({ serviceType: null, certain: false, reason: 'ambiguous_upcoming' });
    expect(mockIdentity.prompts.join('\n')).not.toContain('it is about the NEXT one');
    // gate off: dates read exactly as before (no year), and the identity is the pre-change cohort
    expect(mockIdentity.prompts.join('\n')).not.toMatch(/, 20\d\d\)/);
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    expect(drafter.currentPromptVersion()).toBe(drafter.REAL_ANSWERS_PROMPT_VERSION);
    expect(drafter.REAL_ANSWERS_PROMPT_VERSION).toBe('house_voice_v12_real_answers7_m');
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, context));
    expect(oldFinder).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });
});

describe('gate on — an upcoming visit is offered through the reschedule link picker', () => {
  beforeEach(() => { process.env.GATE_SMS_OFFERS_SCHEDULER = 'true'; });

  test('single upcoming visit: picker called for THAT visit; same label + 2-hour-from-start window format; caps; old finder untouched', async () => {
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(replyWith('9:00 AM - 11:00 AM', 'Tuesday, September 29'));
    const r = await drafter.generateGroundedDraft(argsFor(client, context));

    expect(picker.loadById).toHaveBeenCalledWith(VISIT_ID);
    expect(picker.pageEligibility).toHaveBeenCalledWith(SVC);
    expect(picker.buildAvailabilityForService).toHaveBeenCalledWith(SVC, expect.objectContaining({ rangeFrom: '2026-09-29', rangeTo: '2026-10-13' }));
    expect(oldFinder).not.toHaveBeenCalled();

    const facts = factsOf(client);
    // day 1: 9:00 (9:15/9:30 overlap it and are dropped), 11:00, 1:00 PM — cap 3 slots/day
    expect(facts).toContain('- Tuesday, September 29: 9:00 AM - 11:00 AM, 11:00 AM - 1:00 PM, 1:00 PM - 3:00 PM');
    expect(facts).toContain('- Wednesday, September 30: 2:00 PM - 4:00 PM');
    // the empty day is skipped; cap 3 days
    expect(facts).not.toContain('Thursday, October 1');
    expect(facts).toContain('- Friday, October 2: 8:00 AM - 10:00 AM');
    expect(facts).not.toContain('Saturday, October 3');
    // the row id never reaches an LLM prompt
    expect(facts).not.toContain(VISIT_ID);
    expect(mockIdentity.prompts.join('\n')).not.toContain(VISIT_ID);

    expect(r.converged).toBe(true);
    expect(r.openTimesSnapshot).toEqual({
      lookup: {
        city: 'Venice', customerId: 'cust-9', estimateId: null, serviceType: 'Quarterly Pest', scheduledServiceId: VISIT_ID, source: 'scheduler',
      },
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('the day label is the same string the zone finder renders (availability.js fullDate)', async () => {
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const { block, days } = await drafter.fetchOpenTimesData({
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID },
    });
    expect(block.split('\n')[0]).toBe('- Tuesday, September 29: 9:00 AM - 11:00 AM, 11:00 AM - 1:00 PM, 1:00 PM - 3:00 PM');
    expect(days[0]).toEqual({ date: 'Tuesday, September 29', windows: ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM'] });
    expect(days).toHaveLength(3);
    expect(context.upcomingServices[0].scheduledServiceId).toBe(VISIT_ID);
    expect(JSON.stringify(context)).not.toContain(VISIT_ID);
  });

  test('two upcoming visits: the model-named visit (V2) is the one offered times', async () => {
    const drafter = freshDrafter();
    mockIdentity.answer = { about: 'visit', visit: 'V2', service: null };
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-v1'),
      upcomingEntry('Lawn Fertilization', '2026-10-09', 'id-v2'),
    ]);
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).toHaveBeenCalledWith('id-v2');
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('two upcoming visits that read identically (same type, same date): no id is used, nothing offered, zone finder not used either (Codex #5379 r3)', async () => {
    const drafter = freshDrafter();
    mockIdentity.answer = { about: 'visit', visit: 'V2', service: null };
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-v1'),
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-v2'),
    ]);
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  // 10-08 audit: every recurring customer has several upcoming visits of ONE service, so an
  // unnamed "can we move my appointment?" read as ambiguous and got no OPEN TIMES.
  test('a recurring series (upcoming visits linked as ONE series), unnamed text: the NEXT visit is the one offered times', async () => {
    const drafter = freshDrafter();
    // listed out of order on purpose, and the series crosses New Year: the earliest DATE wins
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2027-01-02', 'id-jan', 'series-1'),
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-oct', 'series-1'),
      upcomingEntry('Quarterly Pest', '2027-04-02', 'id-apr', 'series-1'),
    ]);
    const identity = await drafter.serviceIdentityFor('can we move my appointment?', context);
    expect(identity).toEqual({ serviceType: 'Quarterly Pest', certain: true, reason: 'next_of_series', scheduledServiceId: 'id-oct' });
    const prompt = mockIdentity.prompts.join('\n');
    // the model is told which id is next (V2 = October), never asked to compute "earliest"
    expect(prompt).toContain('it is about the NEXT one: answer "visit" with "V2".');
    // every date carries its year, so October 2026 cannot read as later than January (Codex r2 P1)
    expect(prompt).toMatch(/V1: Quarterly Pest \(scheduled [^)]*Jan 2, 2027\)/);
    expect(prompt).toMatch(/V2: Quarterly Pest \(scheduled [^)]*Oct 2, 2026\)/);

    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).toHaveBeenCalledWith('id-oct');
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('two visits of the same service that are NOT one series (one-time jobs) stay ambiguous: nothing offered (Codex r2 P1)', async () => {
    const drafter = freshDrafter();
    for (const keys of [[null, null], ['series-1', 'series-2'], ['series-1', null]]) {
      mockIdentity.prompts = [];
      const context = baseContext([
        upcomingEntry('Quarterly Pest', '2026-10-02', 'id-a', keys[0]),
        upcomingEntry('Quarterly Pest', '2026-11-02', 'id-b', keys[1]),
      ]);
      expect(await drafter.serviceIdentityFor('can we move my appointment?', context)).toEqual({ serviceType: null, certain: false, reason: 'ambiguous_upcoming' });
      expect(mockIdentity.prompts.join('\n')).not.toContain('it is about the NEXT one');
    }
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-a'),
      upcomingEntry('Quarterly Pest', '2026-11-02', 'id-b'),
    ])));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('gate on: the effective prompt version is the next-of-series cohort, with or without category tags (Codex r2 P1)', () => {
    const drafter = freshDrafter();
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    expect(drafter.currentPromptVersion()).toBe('house_voice_v12_real_answers8_m');
    expect(drafter.NEXT_OF_SERIES_PROMPT_VERSION).toBe('house_voice_v12_real_answers8_m');
    process.env.GATE_SMS_AGENT_COMPLAINTS = 'true';
    expect(drafter.currentPromptVersion()).toBe('house_voice_v12_real_answers8_m+c');
    delete process.env.GATE_SMS_AGENT_COMPLAINTS;
  });

  test('a single upcoming visit: the identity prompt carries no next-of-series line and no year', async () => {
    const drafter = freshDrafter();
    await drafter.serviceIdentityFor('move it', baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID, 'series-1')]));
    expect(mockIdentity.prompts.join('\n')).not.toContain('it is about the NEXT one');
    expect(mockIdentity.prompts.join('\n')).not.toMatch(/, 20\d\d\)/);
  });

  test('a series whose two earliest visits share a date stays ambiguous: nothing offered', async () => {
    const drafter = freshDrafter();
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-a', 'series-1'),
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-b', 'series-1'),
      upcomingEntry('Quarterly Pest', '2027-01-02', 'id-c', 'series-1'),
    ]);
    expect(await drafter.serviceIdentityFor('can we move it?', context)).toEqual({ serviceType: null, certain: false, reason: 'ambiguous_upcoming' });
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('ambiguous upcoming visits: identity uncertain → nothing offered, neither path called', async () => {
    const drafter = freshDrafter();
    const context = baseContext([
      upcomingEntry('Quarterly Pest', '2026-10-02', 'id-v1'),
      upcomingEntry('Lawn Fertilization', '2026-10-09', 'id-v2'),
    ]);
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('visit the reschedule page refuses (grouped, notice window, …) → OPEN TIMES withheld, old finder NOT used, no snapshot', async () => {
    mockPicker({ eligibility: { ok: false, reason: 'grouped' } });
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.pageEligibility).toHaveBeenCalled();
    expect(picker.buildAvailabilityForService).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).not.toContain('OPEN TIMES (real, bookable slots');
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('an id that belongs to another customer is refused (defensive) — withheld, old finder not used', async () => {
    mockPicker({ loaded: { ...SVC, customer_id: 'someone-else' } });
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.pageEligibility).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).not.toContain('OPEN TIMES (real, bookable slots');
  });

  test('upcoming visit with no id carried → withheld, old finder NOT used', async () => {
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', null)]);
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, context));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).not.toContain('OPEN TIMES (real, bookable slots');
  });

  test('picker error → withheld (never blocks drafting), old finder not used', async () => {
    mockPicker();
    picker.buildAvailabilityForService.mockRejectedValue(new Error('router down'));
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, context));
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('gate on but GATE_SMS_REAL_ANSWERS off → nothing offered at all', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const drafter = freshDrafter();
    const client = makeClient(plainReply());
    await drafter.generateGroundedDraft(argsFor(client, baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)])));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });
});

describe('computeOpenTimesSnapshot', () => {
  const offered = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];
  test('carries scheduledServiceId + source only when given; otherwise the legacy shape', () => {
    const { computeOpenTimesSnapshot } = freshDrafter();
    expect(computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null, schedulerOffer: { source: 'scheduler', scheduledServiceId: 'sv-1' } }).lookup)
      .toEqual({ city: 'Venice', customerId: 'c1', estimateId: null, scheduledServiceId: 'sv-1', source: 'scheduler' });
    expect(computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null }).lookup)
      .toEqual({ city: 'Venice', customerId: 'c1', estimateId: null });
    expect(computeOpenTimesSnapshot({ openTimesBlock: null, offeredTimes: offered, city: 'Venice', schedulerOffer: { source: 'scheduler', scheduledServiceId: 'sv-1' } })).toBeNull();
  });
});

describe('openTimesStillOffered — send-time recheck', () => {
  const quoted = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];

  test('a scheduler snapshot (scheduledServiceId) is rechecked through the same picker; old finder untouched', async () => {
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted })).resolves.toEqual({ ok: true });
    expect(picker.loadById).toHaveBeenCalledWith(VISIT_ID);
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('a legacy snapshot (no scheduledServiceId) keeps the old finder', async () => {
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }],
    });
    expect(result).toEqual({ ok: true });
    expect(oldFinder).toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
  });

  test('scheduler recheck: a quoted window no longer offered fails closed and names it', async () => {
    mockPicker({ days: [{ date: '2026-09-29', slots: [{ startTime24: '11:00' }] }] });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
    expect(result).toEqual({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: quoted });
  });

  test('scheduler recheck: the SAME window on a DIFFERENT day does not count', async () => {
    mockPicker({ days: [{ date: '2026-09-30', slots: [{ startTime24: '09:00' }] }] });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
    expect(result.ok).toBe(false);
  });

  test('scheduler recheck counts a feasible start the fetch cap/overlap filter dropped (09:15 is still offered)', async () => {
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:15 AM - 11:15 AM' }],
    });
    expect(result).toEqual({ ok: true });
  });

  test('scheduler recheck: visit no longer reschedulable → fails closed', async () => {
    mockPicker({ eligibility: { ok: false, reason: 'not_available' } });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
    expect(result).toEqual({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: quoted });
  });

  test('scheduler recheck: picker error → open_times_recheck_failed (fails closed)', async () => {
    mockPicker();
    picker.buildAvailabilityForService.mockRejectedValue(new Error('router down'));
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
    expect(result).toEqual({ ok: false, reason: 'open_times_recheck_failed' });
  });

  test('scheduler recheck: timeout → open_times_recheck_failed, timer cleared', async () => {
    jest.useFakeTimers();
    try {
      mockPicker();
      picker.buildAvailabilityForService.mockImplementation(() => new Promise(() => {}));
      const drafter = freshDrafter();
      const promise = drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
      await jest.advanceTimersByTimeAsync(10100);
      await expect(promise).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('scheduler fetch: timer is cleared on a fast success', async () => {
    jest.useFakeTimers();
    try {
      const drafter = freshDrafter();
      // the (winston) info line the fetch now logs schedules its own stream work under fake timers
      jest.spyOn(require('../services/logger'), 'info').mockImplementation(() => {});
      const before = jest.getTimerCount();
      const result = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID } });
      expect(result.block).toContain('Tuesday, September 29');
      expect(jest.getTimerCount()).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('recheck ownership', () => {
  test('recheck path: loadById returns ANOTHER customer\'s row → refused, picker eligibility never asked', async () => {
    mockPicker({ loaded: { ...SVC, customer_id: 'someone-else' } });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({
      ok: false, reason: 'open_times_no_longer_offered', goneWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(picker.pageEligibility).not.toHaveBeenCalled();
    expect(picker.buildAvailabilityForService).not.toHaveBeenCalled();
  });
});

describe('scheduler path has its own, longer deadline', () => {
  const quoted = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];
  const logs = () => require('../services/logger');

  test('draft fetch: a 4s picker still answers (old 3s finder deadline does not apply)', async () => {
    jest.useFakeTimers();
    try {
      mockPicker();
      picker.buildAvailabilityForService.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ days: PICKER_DAYS }), 4000)));
      const drafter = freshDrafter();
      const promise = drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID } });
      await jest.advanceTimersByTimeAsync(4100);
      const out = await promise;
      expect(out.block).toContain('Tuesday, September 29');
    } finally {
      jest.useRealTimers();
    }
  });

  test('draft fetch: a picker that never answers is cut off at 10s, not before', async () => {
    jest.useFakeTimers();
    try {
      mockPicker();
      picker.buildAvailabilityForService.mockImplementation(() => new Promise(() => {}));
      const drafter = freshDrafter();
      let settled = false;
      const promise = drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID } })
        .then((v) => { settled = true; return v; });
      await jest.advanceTimersByTimeAsync(9900);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toEqual({ block: null, days: [] });
    } finally {
      jest.useRealTimers();
    }
  });

  test('recheck: a 3.2s picker answer is honored (not retired at the old 3s)', async () => {
    jest.useFakeTimers();
    try {
      mockPicker();
      picker.buildAvailabilityForService.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ days: PICKER_DAYS }), 3200)));
      const drafter = freshDrafter();
      const promise = drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
      await jest.advanceTimersByTimeAsync(3300);
      await expect(promise).resolves.toEqual({ ok: true });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the OLD finder keeps its 3s deadline (recheck and draft)', async () => {
    jest.useFakeTimers();
    try {
      oldFinder.mockImplementation(() => new Promise(() => {}));
      const drafter = freshDrafter();
      const recheck = drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }] });
      const fetched = drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true });
      await jest.advanceTimersByTimeAsync(3100);
      await expect(recheck).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
      await expect(fetched).resolves.toEqual({ block: null, days: [] });
    } finally {
      jest.useRealTimers();
    }
  });

  test('elapsed ms is logged at info on the draft fetch and on the recheck (scheduler path only)', async () => {
    const drafter = freshDrafter();
    const logger = logs();
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID } });
    await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: quoted });
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /scheduler open-times draft fetch took \d+ms/.test(l))).toBe(true);
    expect(lines.some((l) => /scheduler open-times recheck took \d+ms/.test(l))).toBe(true);
    info.mockClear();
    await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }] });
    expect(info.mock.calls.map((c) => String(c[0])).some((l) => /took \d+ms/.test(l))).toBe(false);
    info.mockRestore();
  });
});

describe("the visit's own current slot (picker excludes the visit itself, so it reads as open)", () => {
  // visit currently 9:00-11:00 on Tue Sep 29 (window_start 09:00:00)
  const HERE = { ...SVC, scheduled_date: '2026-09-29', window_start: '09:00:00' };

  test('draft: no window overlapping the visit\'s current one is offered; the next non-overlapping start takes its place', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    mockPicker({ loaded: HERE });
    const drafter = freshDrafter();
    const { days } = await drafter.fetchOpenTimesData({
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID },
    });
    // 9:00, 9:15 and 9:30 all overlap the current 9:00-11:00 window and are
    // dropped BEFORE the overlap/cap pass: 11:00 is now the first pick
    expect(days[0]).toEqual({ date: 'Tuesday, September 29', windows: ['11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM'] });
    // other days untouched
    expect(days[1]).toEqual({ date: 'Wednesday, September 30', windows: ['2:00 PM - 4:00 PM'] });
  });

  test('draft: a day whose only slot is the visit\'s own window drops out; the same window on ANOTHER day stays', async () => {
    mockPicker({
      loaded: HERE,
      days: [
        { date: '2026-09-29', slots: [{ startTime24: '09:00' }] },
        { date: '2026-09-30', slots: [{ startTime24: '09:00' }] },
      ],
    });
    const drafter = freshDrafter();
    const { days } = await drafter.fetchOpenTimesData({
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, schedulerOffer: { source: 'scheduler', scheduledServiceId: VISIT_ID },
    });
    expect(days).toEqual([{ date: 'Wednesday, September 30', windows: ['9:00 AM - 11:00 AM'] }]);
  });

  test('recheck: a visit moved ONTO a quoted slot since the draft fails closed (open_times_visit_already_there)', async () => {
    mockPicker({ loaded: HERE });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }, { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' }],
    });
    expect(result).toEqual({ ok: false, reason: 'open_times_visit_already_there' });
  });

  test('recheck: the same window on a different day, or a different window the same day, still passes', async () => {
    mockPicker({ loaded: HERE });
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '11:00 AM - 1:00 PM' }, { date: 'Wednesday, September 30', window: '2:00 PM - 4:00 PM' }],
    })).resolves.toEqual({ ok: true });
  });

  test('recheck: a visit row with no date/start (nothing to compare) keeps the normal verdict', async () => {
    mockPicker({ loaded: SVC });
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    })).resolves.toEqual({ ok: true });
  });

  test('scheduled_date as a Date object (pg date) renders the same label', async () => {
    mockPicker({ loaded: { ...HERE, scheduled_date: new Date('2026-09-29T00:00:00.000Z') } });
    const drafter = freshDrafter();
    const result = await drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    });
    expect(result).toEqual({ ok: false, reason: 'open_times_visit_already_there' });
  });
});

describe('customer with no city on file (Codex #5379 r2)', () => {
  test('gate on + live draft: a visit-backed offer still runs through the picker, and its snapshot rechecks without a city', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(replyWith('9:00 AM - 11:00 AM', 'Tuesday, September 29'));
    const r = await drafter.generateGroundedDraft(argsFor(client, context, { city: null, liveOpenTimes: true }));
    expect(picker.buildAvailabilityForService).toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ city: null, scheduledServiceId: VISIT_ID }));
    await expect(drafter.openTimesStillOffered({ ...r.openTimesSnapshot.lookup, quotedWindows: r.openTimesSnapshot.quotedWindows }))
      .resolves.toEqual({ ok: true });
  });

  test('no liveOpenTimes (replay/backfill callers) or gate off: no city still means no fetch at all', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    let drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), context, { city: null }));
    delete process.env.GATE_SMS_OFFERS_SCHEDULER;
    drafter = freshDrafter();
    await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), context, { city: null, liveOpenTimes: true }));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(mockIdentity.prompts).toEqual([]);
  });

  test('a legacy snapshot with no city and no visit id still fails closed', async () => {
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ city: null, customerId: 'cust-9', quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] }))
      .resolves.toEqual({ ok: false, reason: 'open_times_recheck_no_city' });
  });
});

describe('send-time recheck: a quoted window that OVERLAPS the visit\'s new window (Codex #5379 r2)', () => {
  test('quoted 9-11, visit since moved to 10-12 the same day → refused', async () => {
    mockPicker({ loaded: { ...SVC, scheduled_date: '2026-09-29', window_start: '10:00:00' } });
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({
      city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID,
      quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }],
    })).resolves.toEqual({ ok: false, reason: 'open_times_visit_already_there' });
  });
});

// ── slice 1b: new visits and estimates ────────────────────────────────────────
const OFFER_REPLY = () => replyWith('8:00 AM - 10:00 AM', 'Wednesday, September 30');
// A catalog name the explicit /book funnel table knows (sms-book-funnel-map.js).
const COMPLETED = [{ type: 'General Pest Control (Quarterly)', date: '2026-07-01' }];
const EST_ARGS = { openEstimate: { id: 'est-1', service: 'Lawn' } };
const EST_IDENTITY = { about: 'estimate', visit: null, service: null };

describe('gate off — estimate and new-visit identities stay byte-identical (zone finder)', () => {
  test('last completed visit and open estimate: the zone finder answers, neither new picker is touched, no source on the snapshot', async () => {
    let drafter = freshDrafter();
    let r = await drafter.generateGroundedDraft(argsFor(makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9')), baseContext([], COMPLETED)));
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9', serviceType: 'General Pest Control (Quarterly)' });
    expect(r.openTimesSnapshot.lookup).toEqual({ city: 'Venice', customerId: 'cust-9', estimateId: null, serviceType: 'General Pest Control (Quarterly)' });

    oldFinder.mockClear();
    mockIdentity.answer = EST_IDENTITY;
    drafter = freshDrafter();
    r = await drafter.generateGroundedDraft(argsFor(makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9')), baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]), EST_ARGS));
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-1', { customerId: 'cust-9' });
    expect(r.openTimesSnapshot.lookup).toEqual({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-1' });

    oldFinder.mockClear();
    drafter = freshDrafter();
    r = await drafter.generateGroundedDraft(argsFor(makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9')), baseContext([]), { estimateId: 'est-linked-1' }));
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-linked-1', expect.objectContaining({ customerId: 'cust-9' }));
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    expect(estimateSlots.offerableEstimateSlots).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
  });
});

describe('gate on — a new visit is offered through the /book funnel picker', () => {
  beforeEach(() => { process.env.GATE_SMS_OFFERS_SCHEDULER = 'true'; });

  test('last completed visit: /book asked for THIS customer + the funnel key of that service; same render as slice 1; zone finder and reschedule picker untouched', async () => {
    const drafter = freshDrafter();
    const client = makeClient(OFFER_REPLY());
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([], COMPLETED)));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'pest_control' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(estimateSlots.offerableEstimateSlots).not.toHaveBeenCalled();
    const facts = factsOf(client);
    // 8:00 and 10:00 are 120 minutes apart, so their 2-hour windows do not overlap
    expect(facts).toContain('- Wednesday, September 30: 8:00 AM - 10:00 AM, 10:00 AM - 12:00 PM');
    expect(facts).toContain('- Thursday, October 1: 1:00 PM - 3:00 PM');
    expect(r.openTimesSnapshot).toEqual({
      lookup: { city: 'Venice', customerId: 'cust-9', estimateId: null, serviceType: 'General Pest Control (Quarterly)', source: 'book', serviceKey: 'pest_control' },
      quotedWindows: [{ date: 'Wednesday, September 30', window: '8:00 AM - 10:00 AM' }],
    });
    // no coordinates, no address, anywhere on the lookup
    expect(JSON.stringify(r.openTimesSnapshot)).not.toMatch(/lat|lng|address/i);
  });

  test('a service the model names from the catalog (new_booking) is offered through /book for that funnel key', async () => {
    mockCatalog.services = [{ service_key: 'lawn_care', name: 'Lawn Care' }];
    mockIdentity.answer = { about: 'new_service', visit: null, service: 'lawn_care' };
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)], COMPLETED)));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'lawn_care' });
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ source: 'book', serviceKey: 'lawn_care' }));
  });

  test('engine_default (no service known) → general pest control through /book (owner 2026-09-30); zone finder NOT used', async () => {
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], [])));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'pest_control' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ source: 'book', serviceKey: 'pest_control' }));
  });

  // The explicit funnel table (sms-book-funnel-map.js), not a keyword guess.
  test.each([
    ['Termite Inspection Service', 'termite'],
    ['Termite Inspection', 'termite'],
    ['Rodent Pest Control', 'rodent'],
    ['Rodent Control', 'rodent'],
    ['Seasonal Mosquito Control Service', 'mosquito'],
    ['Tree & Shrub', 'tree_shrub'],
  ])('a completed "%s" visit is offered through /book as funnel key %s', async (type, funnelKey) => {
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], [{ type, date: '2026-07-01' }])));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: funnelKey });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ source: 'book', serviceKey: funnelKey }));
  });

  test('a visit name only the bookable catalog knows resolves through that row\'s service_key, and only when that key is in the table', async () => {
    mockCatalog.services = [
      { service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Care Plan' },
      { service_key: 'termite_bait', name: 'Bait Station Program' },
    ];
    let drafter = freshDrafter();
    await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], [{ type: 'Bi-Monthly Pest Care Plan', date: '2026-07-01' }])));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'pest_control' });
    book.availabilityForExistingCustomer.mockClear();
    drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], [{ type: 'Bait Station Program', date: '2026-07-01' }])));
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('new_booking carries the catalog service_key the model picked: termite_inspection → termite; termite_bait → withheld even if its NAME reads like a funnel label', async () => {
    mockCatalog.services = [
      { service_key: 'termite_inspection', name: 'Termite Inspection Service' },
      { service_key: 'termite_bait', name: 'Termite Inspection Bait Plan' },
    ];
    mockIdentity.answer = { about: 'new_service', visit: null, service: 'termite_inspection' };
    let drafter = freshDrafter();
    await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], [])));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'termite' });
    book.availabilityForExistingCustomer.mockClear();
    mockIdentity.answer = { about: 'new_service', visit: null, service: 'termite_bait' };
    drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], [])));
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  test.each([
    'Rodent Bait Stations', 'Termite Bait Station Renewal', 'WDO Inspection', 'Palm Injection',
    // substring look-alikes the old classifier over-matched: "ant", "fungus"
    'Fire Ant Treatment', 'Lawn Fungus Treatment', 'Giant Wasp Removal', 'Termite Bait Station Installation',
  ])('%s maps to no funnel key → withheld, zone finder NOT used', async (type) => {
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], [{ type, date: '2026-07-01' }])));
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('/book off, no resolvable location, customer gone (availabilityForExistingCustomer → null) → withheld, no snapshot, zone finder NOT used', async () => {
    book.availabilityForExistingCustomer.mockResolvedValue(null);
    const drafter = freshDrafter();
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([], COMPLETED)));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).not.toContain('OPEN TIMES:');
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('/book picker error → withheld (never blocks drafting), zone finder NOT used', async () => {
    book.availabilityForExistingCustomer.mockRejectedValue(new Error('router down'));
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], COMPLETED)));
    expect(r.converged).toBe(true);
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });
});

describe('gate on — an estimate is offered through its public page picker', () => {
  beforeEach(() => { process.env.GATE_SMS_OFFERS_SCHEDULER = 'true'; });

  test('open-estimate identity: the page picker is asked for THAT estimate + THIS customer; primary and expander chips render the slice-1 way; zone finder untouched', async () => {
    mockIdentity.answer = EST_IDENTITY;
    const drafter = freshDrafter();
    const client = makeClient(replyWith('9:00 AM - 11:00 AM', 'Friday, October 2'));
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]), EST_ARGS));
    expect(estimateSlots.offerableEstimateSlots).toHaveBeenCalledWith('est-1', 'cust-9');
    expect(oldFinder).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    const facts = factsOf(client);
    expect(facts).toContain('- Friday, October 2: 9:00 AM - 11:00 AM, 1:00 PM - 3:00 PM');
    expect(facts).toContain('- Monday, October 5: 10:00 AM - 12:00 PM');
    expect(r.openTimesSnapshot).toEqual({
      lookup: { city: 'Venice', customerId: 'cust-9', estimateId: 'est-1', source: 'estimate' },
      quotedWindows: [{ date: 'Friday, October 2', window: '9:00 AM - 11:00 AM' }],
    });
  });

  test('an estimate the caller linked (estimateId) uses the page picker too — and wins over an upcoming visit', async () => {
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(
      makeClient(replyWith('9:00 AM - 11:00 AM', 'Friday, October 2')),
      baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]),
      { estimateId: 'est-linked-1' },
    ));
    expect(estimateSlots.offerableEstimateSlots).toHaveBeenCalledWith('est-linked-1', 'cust-9');
    expect(oldFinder).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-linked-1', source: 'estimate' }));
  });

  test('the page would show none / the estimate is another customer\'s (offerableEstimateSlots → null) → withheld, zone finder NOT used', async () => {
    estimateSlots.offerableEstimateSlots.mockResolvedValue(null);
    const drafter = freshDrafter();
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([]), { estimateId: 'est-someone-else' }));
    expect(estimateSlots.offerableEstimateSlots).toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).not.toContain('OPEN TIMES:');
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('estimate picker error → withheld, zone finder NOT used', async () => {
    estimateSlots.offerableEstimateSlots.mockRejectedValue(new Error('slots down'));
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([]), { estimateId: 'est-1' }));
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });
});

// GATE_MULTI_TECH_TEXT_TIMES (multi-tech booking PR 4, Codex r2 on #6073): with no
// scheduler picker for the text, the city-based fallback asks the website engine
// and STAMPS it on the snapshot; the recheck follows the stamp, not the gate.
describe('GATE_MULTI_TECH_TEXT_TIMES — the city fallback asks the website engine, stamped on the snapshot', () => {
  const WEB = 'GATE_MULTI_TECH_TEXT_TIMES';
  let textOfferDays;
  let funnelKeyForEstimateId;
  beforeEach(() => {
    process.env[WEB] = 'true';
    textOfferDays = jest.fn(async () => ({ days: BOOK_DAYS, pinSource: 'city_table' }));
    funnelKeyForEstimateId = jest.fn(async () => 'lawn_care');
    jest.doMock('../services/scheduling/text-offer-times', () => ({ textOfferDays }));
    jest.doMock('../services/estimate-converter', () => ({ funnelKeyForEstimateId }));
  });
  afterEach(() => {
    if (prior[WEB] === undefined) delete process.env[WEB]; else process.env[WEB] = prior[WEB];
    jest.dontMock('../services/scheduling/text-offer-times');
    jest.dontMock('../services/estimate-converter');
  });

  test('a new visit: the website engine answers for the text\'s funnel service; the snapshot stamps source + serviceKey; the old finder is never called', async () => {
    const drafter = freshDrafter();
    const client = makeClient(OFFER_REPLY());
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([], COMPLETED)));
    expect(textOfferDays).toHaveBeenCalledWith({ city: 'Venice', customerId: 'cust-9', estimateId: null, serviceKey: 'pest_control' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(factsOf(client)).toContain('- Wednesday, September 30: 8:00 AM - 10:00 AM, 10:00 AM - 12:00 PM');
    expect(r.openTimesSnapshot).toEqual({
      lookup: { city: 'Venice', customerId: 'cust-9', estimateId: null, serviceType: 'General Pest Control (Quarterly)', source: 'website_engine', serviceKey: 'pest_control' },
      quotedWindows: [{ date: 'Wednesday, September 30', window: '8:00 AM - 10:00 AM' }],
    });
    // Codex r3 P1 on #6073: a snapshot the drafter really stamped classifies as a picker offer.
    expect(require('../services/sms-suggest-mode').isPickerOfferSnapshot(r.openTimesSnapshot)).toBe(true);
  });

  // Codex r2 P1-1: the customer's visit history (pest) must not size an estimate's offer.
  test('an estimate-linked draft: the funnel service comes from the LINKED ESTIMATE (funnelKeyForEstimate), not the customer\'s visit history or a pest default', async () => {
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], COMPLETED), { estimateId: 'est-linked-1' }));
    expect(funnelKeyForEstimateId).toHaveBeenCalledWith('est-linked-1');
    expect(textOfferDays).toHaveBeenCalledWith({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-linked-1', serviceKey: 'lawn_care' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).toEqual({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-linked-1', serviceType: 'General Pest Control (Quarterly)', source: 'website_engine', serviceKey: 'lawn_care' });
  });

  test('an estimate the website engine cannot represent (empty key): the OLD finder keeps it, exactly as the converter does — no website-engine times, no stamp, never the pest default', async () => {
    funnelKeyForEstimateId.mockResolvedValue('');
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9')), baseContext([], COMPLETED), { estimateId: 'est-linked-1' }));
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-linked-1', expect.objectContaining({ customerId: 'cust-9' }));
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('source');
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('serviceKey');
  });

  test('a failure reading the estimate withholds OPEN TIMES (no guessed service, no old finder)', async () => {
    funnelKeyForEstimateId.mockRejectedValue(new Error('db down'));
    const drafter = freshDrafter();
    const client = makeClient(plainReply());
    const r = await drafter.generateGroundedDraft(argsFor(client, baseContext([], COMPLETED), { estimateId: 'est-linked-1' }));
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot).toBeNull();
  });

  test('with GATE_SMS_OFFERS_SCHEDULER on, its picker keeps the text: the website engine is never asked (unchanged)', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    const drafter = freshDrafter();
    const r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], COMPLETED)));
    expect(textOfferDays).not.toHaveBeenCalled();
    expect(book.availabilityForExistingCustomer).toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup.source).toBe('book');
  });

  // Codex r2 P1-2: the recheck asks the engine that BUILT the snapshot.
  describe('send-time recheck follows the stamped engine, not the current gate', () => {
    const quoted = [{ date: 'Wednesday, September 30', window: '8:00 AM - 10:00 AM' }];
    const stamped = { city: 'Venice', customerId: 'cust-9', estimateId: 'est-linked-1', source: 'website_engine', serviceKey: 'lawn_care' };

    test('a website-engine snapshot is rechecked on the website engine with the recorded estimate + service, even with the gate now OFF', async () => {
      delete process.env[WEB];
      const drafter = freshDrafter();
      await expect(drafter.openTimesStillOffered({ ...stamped, quotedWindows: quoted })).resolves.toEqual({ ok: true });
      expect(textOfferDays).toHaveBeenCalledWith({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-linked-1', serviceKey: 'lawn_care' });
      expect(oldFinder).not.toHaveBeenCalled();
    });

    test('a legacy snapshot (no source) is rechecked on the OLD finder, even with the gate now ON', async () => {
      const drafter = freshDrafter();
      await expect(drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }] })).resolves.toEqual({ ok: true });
      expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9' });
      expect(textOfferDays).not.toHaveBeenCalled();
    });

    test('a window the website engine dropped is refused; an engine error, an empty service key or nothing offered fails CLOSED; the deadline is the longer one', async () => {
      const drafter = freshDrafter();
      await expect(drafter.openTimesStillOffered({ ...stamped, quotedWindows: [{ date: 'Wednesday, September 30', window: '4:00 PM - 6:00 PM' }] }))
        .resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
      textOfferDays.mockResolvedValue(null);
      await expect(drafter.openTimesStillOffered({ ...stamped, quotedWindows: quoted })).resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
      await expect(drafter.openTimesStillOffered({ ...stamped, serviceKey: undefined, quotedWindows: quoted })).resolves.toMatchObject({ ok: false });
      textOfferDays.mockRejectedValue(new Error('engine down'));
      await expect(drafter.openTimesStillOffered({ ...stamped, quotedWindows: quoted })).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
    });
  });

  test('snapshot lookup: website_engine carries serviceKey; absent offer keeps the legacy shape', () => {
    const { computeOpenTimesSnapshot } = freshDrafter();
    const offered = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];
    const snap = (schedulerOffer) => computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null, schedulerOffer }).lookup;
    expect(snap({ source: 'website_engine', serviceKey: 'mosquito', city: 'Venice' })).toEqual({ city: 'Venice', customerId: 'c1', estimateId: null, source: 'website_engine', serviceKey: 'mosquito' });
    expect(snap(null)).toEqual({ city: 'Venice', customerId: 'c1', estimateId: null });
  });
});

describe('snapshot lookup — source + the keys to re-run the SAME picker (slice 1b)', () => {
  const offered = [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }];
  test('book carries serviceKey; estimate carries only its source (estimateId is already on the lookup); scheduler unchanged; none = legacy', () => {
    const { computeOpenTimesSnapshot } = freshDrafter();
    const snap = (schedulerOffer, estimateId = null) => computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: null, customerId: 'c1', estimateId, schedulerOffer }).lookup;
    expect(snap({ source: 'book', serviceKey: 'lawn_care' })).toEqual({ city: null, customerId: 'c1', estimateId: null, source: 'book', serviceKey: 'lawn_care' });
    expect(snap({ source: 'estimate', estimateId: 'e1' }, 'e1')).toEqual({ city: null, customerId: 'c1', estimateId: 'e1', source: 'estimate' });
    expect(snap({ source: 'scheduler', scheduledServiceId: 'sv-1' })).toEqual({ city: null, customerId: 'c1', estimateId: null, source: 'scheduler', scheduledServiceId: 'sv-1' });
    expect(snap(null)).toEqual({ city: null, customerId: 'c1', estimateId: null });
  });
});

describe('send-time recheck through the /book and estimate pickers (slice 1b)', () => {
  const quoted = [{ date: 'Wednesday, September 30', window: '8:00 AM - 10:00 AM' }];
  const bookLookup = { city: 'Venice', customerId: 'cust-9', source: 'book', serviceKey: 'pest_control' };
  const estLookup = { city: 'Venice', customerId: 'cust-9', estimateId: 'est-1', source: 'estimate' };

  test('book snapshot: /book is asked the same question (customer + funnel key); zone finder, reschedule picker and estimate picker untouched', async () => {
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted })).resolves.toEqual({ ok: true });
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'pest_control' });
    expect(oldFinder).not.toHaveBeenCalled();
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(estimateSlots.offerableEstimateSlots).not.toHaveBeenCalled();
  });

  test('estimate snapshot: the page picker is asked for the same estimate + customer', async () => {
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ ...estLookup, quotedWindows: [{ date: 'Friday, October 2', window: '1:00 PM - 3:00 PM' }] })).resolves.toEqual({ ok: true });
    // the RECHECK asks for the page's picker uncached + uncapped
    expect(estimateSlots.offerableEstimateSlots).toHaveBeenCalledWith('est-1', 'cust-9', { fresh: true });
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('estimate recheck: a quoted slot that is not in the DRAFT cut but is in the fresh, uncapped read still passes; one consumed since (absent from the fresh read) is refused', async () => {
    // The draft cut (default) shows only 2026-10-02; the fresh read has every slot.
    estimateSlots.offerableEstimateSlots.mockImplementation(async (id, cust, opts) => (opts && opts.fresh
      ? { primary: [{ date: '2026-10-02', windowStart: '09:00' }, { date: '2026-10-09', windowStart: '10:00' }], expander: [] }
      : { primary: [{ date: '2026-10-02', windowStart: '09:00' }], expander: [] }));
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ ...estLookup, quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }] })).resolves.toEqual({ ok: true });
    await expect(drafter.openTimesStillOffered({ ...estLookup, quotedWindows: [{ date: 'Friday, October 2', window: '1:00 PM - 3:00 PM' }] }))
      .resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
  });

  test('a window no longer offered, the same window on ANOTHER day, or a picker that now offers nothing → fails closed', async () => {
    const drafter = freshDrafter();
    book.availabilityForExistingCustomer.mockResolvedValue({ days: [{ date: '2026-09-30', slots: [{ startTime24: '13:00' }] }] });
    await expect(drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted })).resolves.toEqual({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: quoted });
    book.availabilityForExistingCustomer.mockResolvedValue({ days: [{ date: '2026-10-01', slots: [{ startTime24: '08:00' }] }] });
    await expect(drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted })).resolves.toMatchObject({ ok: false });
    book.availabilityForExistingCustomer.mockResolvedValue(null);
    await expect(drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted })).resolves.toEqual({ ok: false, reason: 'open_times_no_longer_offered', goneWindows: quoted });
    estimateSlots.offerableEstimateSlots.mockResolvedValue(null);
    await expect(drafter.openTimesStillOffered({ ...estLookup, quotedWindows: quoted })).resolves.toMatchObject({ ok: false, reason: 'open_times_no_longer_offered' });
  });

  test('picker error → open_times_recheck_failed; a picker that never answers is cut off at the scheduler 10s deadline with the timer cleared', async () => {
    book.availabilityForExistingCustomer.mockRejectedValue(new Error('router down'));
    let drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted })).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
    jest.useFakeTimers();
    try {
      estimateSlots.offerableEstimateSlots.mockImplementation(() => new Promise(() => {}));
      drafter = freshDrafter();
      let settled = false;
      const promise = drafter.openTimesStillOffered({ ...estLookup, quotedWindows: quoted }).then((v) => { settled = true; return v; });
      await jest.advanceTimersByTimeAsync(9900);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toEqual({ ok: false, reason: 'open_times_recheck_failed' });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('elapsed ms is logged at info on a book / estimate recheck', async () => {
    const drafter = freshDrafter();
    const info = jest.spyOn(require('../services/logger'), 'info').mockImplementation(() => {});
    await drafter.openTimesStillOffered({ ...bookLookup, quotedWindows: quoted });
    await drafter.openTimesStillOffered({ ...estLookup, quotedWindows: quoted });
    expect(info.mock.calls.map((c) => String(c[0])).filter((l) => /scheduler open-times recheck took \d+ms/.test(l))).toHaveLength(2);
    info.mockRestore();
  });

  test('legacy snapshot (no source) keeps the zone finder even when it carries an estimate id; slice-1 snapshot (visit id, no source) keeps the reschedule picker', async () => {
    const drafter = freshDrafter();
    await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', estimateId: 'est-1', quotedWindows: [{ date: 'Friday, October 9', window: '10:00 AM - 12:00 PM' }] });
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-1', expect.objectContaining({ customerId: 'cust-9' }));
    expect(estimateSlots.offerableEstimateSlots).not.toHaveBeenCalled();
    oldFinder.mockClear();
    await drafter.openTimesStillOffered({ city: 'Venice', customerId: 'cust-9', scheduledServiceId: VISIT_ID, quotedWindows: [{ date: 'Tuesday, September 29', window: '9:00 AM - 11:00 AM' }] });
    expect(picker.loadById).toHaveBeenCalledWith(VISIT_ID);
    expect(oldFinder).not.toHaveBeenCalled();
  });

  test('a book / estimate snapshot rechecks without a city; a legacy snapshot without a city still fails closed', async () => {
    const drafter = freshDrafter();
    await expect(drafter.openTimesStillOffered({ ...bookLookup, city: null, quotedWindows: quoted })).resolves.toEqual({ ok: true });
    await expect(drafter.openTimesStillOffered({ city: null, customerId: 'cust-9', estimateId: 'est-1', quotedWindows: quoted })).resolves.toEqual({ ok: false, reason: 'open_times_recheck_no_city' });
  });
});

describe('customer with no city on file — new pickers (slice 1b)', () => {
  beforeEach(() => { process.env.GATE_SMS_OFFERS_SCHEDULER = 'true'; });

  test('live draft: /book and the estimate page still offer times (they locate the job themselves), and the snapshot rechecks without a city', async () => {
    let drafter = freshDrafter();
    let r = await drafter.generateGroundedDraft(argsFor(makeClient(OFFER_REPLY()), baseContext([], COMPLETED), { city: null, liveOpenTimes: true }));
    expect(book.availabilityForExistingCustomer).toHaveBeenCalledWith({ customerId: 'cust-9', serviceKey: 'pest_control' });
    expect(oldFinder).not.toHaveBeenCalled();
    await expect(drafter.openTimesStillOffered({ ...r.openTimesSnapshot.lookup, quotedWindows: r.openTimesSnapshot.quotedWindows })).resolves.toEqual({ ok: true });

    drafter = freshDrafter();
    r = await drafter.generateGroundedDraft(argsFor(makeClient(replyWith('9:00 AM - 11:00 AM', 'Friday, October 2')), baseContext([]), { city: null, liveOpenTimes: true, estimateId: 'est-1' }));
    expect(estimateSlots.offerableEstimateSlots).toHaveBeenCalledWith('est-1', 'cust-9');
    expect(r.openTimesSnapshot.lookup).toEqual(expect.objectContaining({ city: null, source: 'estimate' }));
  });

  test('no liveOpenTimes (replay/backfill), gate off, or an uncertain identity: no city still means no fetch', async () => {
    let drafter = freshDrafter();
    await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], COMPLETED), { city: null }));
    await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([]), { city: null, estimateId: 'est-1' }));
    delete process.env.GATE_SMS_OFFERS_SCHEDULER;
    drafter = freshDrafter();
    await drafter.generateGroundedDraft(argsFor(makeClient(plainReply()), baseContext([], COMPLETED), { city: null, liveOpenTimes: true }));
    expect(book.availabilityForExistingCustomer).not.toHaveBeenCalled();
    expect(estimateSlots.offerableEstimateSlots).not.toHaveBeenCalled();
    expect(oldFinder).not.toHaveBeenCalled();
  });
});
