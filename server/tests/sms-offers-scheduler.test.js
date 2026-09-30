/**
 * GATE_SMS_OFFERS_SCHEDULER (owner ruling 2026-09-29, slice 1): when the
 * texting AI's service-identity step resolves to ONE upcoming visit, the
 * OPEN TIMES it offers come from the reschedule link's own picker
 * (routes/reschedule-public.js buildAvailabilityForService), never the old
 * zone-based availability finder. Estimate / new-service / last-completed
 * identities keep the old finder in this slice; gate off is byte-identical.
 *
 * No DB, no network: the picker pieces, the old finder, the catalog and the
 * identity model lane are all mocked.
 */
const mockIdentity = { answer: { about: 'none', visit: null, service: null }, prompts: [] };
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: async () => [] }));
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

function upcomingEntry(type, date, id) {
  const entry = { type, date, window: null, status: 'confirmed', tech: null, isToday: false };
  // Same shape context-aggregator builds: the id is NON-ENUMERABLE.
  if (id) Object.defineProperty(entry, 'scheduledServiceId', { value: id, enumerable: false });
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

function mockPicker({ eligibility = { ok: true }, loaded = SVC, days = PICKER_DAYS, availability } = {}) {
  picker = {
    loadById: jest.fn(async () => loaded),
    pageEligibility: jest.fn(async () => eligibility),
    bookingRange: jest.fn(() => ({ rangeFrom: '2026-09-29', rangeTo: '2026-10-13' })),
    buildAvailabilityForService: jest.fn(async () => (availability !== undefined ? availability : { days })),
  };
  jest.doMock('../routes/reschedule-public', () => ({ _internals: picker }));
  jest.doMock('../routes/booking', () => ({ _internals: { loadBookingConfig: jest.fn(async () => ({ advance_days_min: 1 })) } }));
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
  mockPicker();
});

afterEach(() => {
  for (const g of GATES) {
    if (prior[g] === undefined) delete process.env[g];
    else process.env[g] = prior[g];
  }
  jest.dontMock('../services/availability');
  jest.dontMock('../routes/reschedule-public');
  jest.dontMock('../routes/booking');
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
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID,
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

  test('non-visit identities keep the old finder even with the gate on (slice 1): last completed visit, open estimate', async () => {
    let drafter = freshDrafter();
    // no upcoming visit, one completed → last_completed
    let client = makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9'));
    let r = await drafter.generateGroundedDraft(argsFor(client, baseContext([], [{ type: 'Quarterly Pest', date: '2026-07-01' }])));
    expect(oldFinder).toHaveBeenCalledWith('Venice', null, { customerId: 'cust-9', serviceType: 'Quarterly Pest' });
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('scheduledServiceId');

    // open estimate identity
    oldFinder.mockClear();
    mockIdentity.answer = { about: 'estimate', visit: null, service: null };
    drafter = freshDrafter();
    client = makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9'));
    r = await drafter.generateGroundedDraft(argsFor(client, baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]), { openEstimate: { id: 'est-1', service: 'Lawn' } }));
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-1', { customerId: 'cust-9' });
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('scheduledServiceId');
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
    expect(computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null, scheduledServiceId: 'sv-1' }).lookup)
      .toEqual({ city: 'Venice', customerId: 'c1', estimateId: null, scheduledServiceId: 'sv-1', source: 'scheduler' });
    expect(computeOpenTimesSnapshot({ openTimesBlock: 'x', offeredTimes: offered, city: 'Venice', customerId: 'c1', estimateId: null }).lookup)
      .toEqual({ city: 'Venice', customerId: 'c1', estimateId: null });
    expect(computeOpenTimesSnapshot({ openTimesBlock: null, offeredTimes: offered, city: 'Venice', scheduledServiceId: 'sv-1' })).toBeNull();
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
      const result = await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID });
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

describe('gate on + LINKED estimate → old finder, scheduler picker untouched', () => {
  test('estimateId passed to generateGroundedDraft (linked estimate, no open-estimate identity) keeps the zone finder', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    const drafter = freshDrafter();
    const context = baseContext([upcomingEntry('Quarterly Pest', '2026-10-02', VISIT_ID)]);
    const client = makeClient(replyWith('10:00 AM - 12:00 PM', 'Friday, October 9'));
    const r = await drafter.generateGroundedDraft(argsFor(client, context, { estimateId: 'est-linked-1' }));
    expect(oldFinder).toHaveBeenCalledWith('Venice', 'est-linked-1', expect.objectContaining({ customerId: 'cust-9' }));
    expect(picker.loadById).not.toHaveBeenCalled();
    expect(picker.buildAvailabilityForService).not.toHaveBeenCalled();
    expect(r.openTimesSnapshot.lookup).not.toHaveProperty('scheduledServiceId');
    expect(r.openTimesSnapshot.lookup.estimateId).toBe('est-linked-1');
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
      const promise = drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID });
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
      const promise = drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID })
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
    await drafter.fetchOpenTimesData({ city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID });
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

  test('draft: the visit\'s current window is not offered; the next feasible start takes its place', async () => {
    process.env.GATE_SMS_OFFERS_SCHEDULER = 'true';
    mockPicker({ loaded: HERE });
    const drafter = freshDrafter();
    const { days } = await drafter.fetchOpenTimesData({
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID,
    });
    // 9:00 dropped BEFORE the overlap/cap pass: 9:15 (own window 9:15-11:15) is now the first pick
    expect(days[0].date).toBe('Tuesday, September 29');
    expect(days[0].windows).not.toContain('9:00 AM - 11:00 AM');
    expect(days[0].windows[0]).toBe('9:15 AM - 11:15 AM');
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
      city: 'Venice', customerId: 'cust-9', schedulingIntent: true, offersFromScheduler: true, scheduledServiceId: VISIT_ID,
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
