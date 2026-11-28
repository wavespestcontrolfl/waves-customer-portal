'use strict';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoadBookable = jest.fn();
jest.mock('../services/call-booking-catalog', () => ({
  loadBookableCallServices: (...args) => mockLoadBookable(...args),
}));

const {
  buildLiveCallCopilot,
  matchCatalogPrices,
  buildCallChecklist,
  _test: { resetCaches, statesDifferentProperty },
} = require('../services/live-call-copilot');

const CATALOG = [
  { id: 'svc-1', service_key: 'one_time_pest', name: 'One-Time Pest Control Service', short_name: 'One-Time Pest', base_price: 200, pricing_type: 'fixed', billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-2', service_key: 'cockroach_control', name: 'Cockroach Treatment Service', short_name: 'Cockroach Treatment', base_price: 350, pricing_type: 'fixed', billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-3', service_key: 'bee_wasp_nest_removal', name: 'Bee / Wasp Nest Removal', short_name: 'Bee/Wasp Removal', base_price: 250, pricing_type: 'fixed', billing_type: 'one_time', default_duration_minutes: 45 },
  { id: 'svc-4', service_key: 'wdo_inspection', name: 'WDO Inspection Service', short_name: 'WDO Inspection', base_price: 175, pricing_type: 'variable', billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-5', service_key: 'lawn_inspection', name: 'Waves Assessment', short_name: 'Waves Assessment', base_price: 0, pricing_type: 'fixed', billing_type: 'one_time', default_duration_minutes: 30 },
  { id: 'svc-6', service_key: 'rodent_trapping', name: 'Rodent Trapping Service', short_name: 'Rodent Trapping', base_price: 300, pricing_type: 'fixed', billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-7', service_key: 'pest_control', name: 'Quarterly Pest Control', short_name: 'Quarterly Pest', base_price: 99, pricing_type: 'variable', billing_type: 'recurring', default_duration_minutes: 45 },
];

function makeFakeDb({
  account = null,
  properties = [],
  propertiesError = null,
  nextVisit = null,
  lastVisit = null,
  estimates = [],
  recentCalls = 0,
  recentTexts = 0,
  prefs = null,
  fullUtterances = [],
} = {}) {
  return jest.fn((table) => {
    const state = { table, wheres: [] };
    const chain = {
      where(a, b) {
        state.wheres.push([a, b]);
        return chain;
      },
      whereNull() { return chain; },
      whereNot() { return chain; },
      whereIn() { return chain; },
      whereRaw() { return chain; },
      modify() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      select() {
        if (table === 'estimates') return Promise.resolve(estimates);
        if (table === 'customer_properties') {
          return propertiesError ? Promise.reject(propertiesError) : Promise.resolve(properties);
        }
        if (table === 'call_live_utterances') return Promise.resolve(fullUtterances);
        return Promise.resolve([]);
      },
      count() { return chain; },
      first() {
        if (table === 'customers') return Promise.resolve(account);
        if (table === 'scheduled_services') {
          const isCompleted = state.wheres.some(([a]) => a && a.status === 'completed');
          return Promise.resolve(isCompleted ? lastVisit : nextVisit);
        }
        if (table === 'call_log') return Promise.resolve({ n: String(recentCalls) });
        if (table === 'sms_log') return Promise.resolve({ n: String(recentTexts) });
        if (table === 'property_preferences') return Promise.resolve(prefs);
        return Promise.resolve(null);
      },
    };
    return chain;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetCaches();
  mockLoadBookable.mockResolvedValue(CATALOG);
});

describe('matchCatalogPrices (full-catalog affirmative-only lookup)', () => {
  test('surfaces fixed prices cleanly, labels variable $0 placeholder rows as variable (never Free), and keeps explicitly free Waves Assessment free', () => {
    const withPlaceholder = [
      ...CATALOG,
      { id: 'svc-9', service_key: 'rodent_exclusion', name: 'Rodent Exclusion Service', short_name: 'Rodent Exclusion', base_price: 0, pricing_type: 'variable', billing_type: 'one_time', default_duration_minutes: 60 },
    ];
    const wdo = matchCatalogPrices('Need a WDO inspection for real estate closing', withPlaceholder);
    expect(wdo).toEqual([
      { name: 'WDO Inspection', price: null, pricing_type: 'variable', billing_type: 'one_time', duration_minutes: 60 },
      { name: 'Waves Assessment', price: 0, pricing_type: 'free', billing_type: 'one_time', duration_minutes: 30 },
    ]);

    const rodent = matchCatalogPrices('Hearing rats in the attic', withPlaceholder);
    const excl = rodent.find((r) => r.name === 'Rodent Exclusion');
    expect(excl).toMatchObject({ price: null, pricing_type: 'variable' });

    const roach = matchCatalogPrices('Caller says they have german roaches in the kitchen', CATALOG);
    expect(roach.map((r) => ({ name: r.name, price: r.price, kind: r.pricing_type }))).toEqual([
      { name: 'Cockroach Treatment', price: 350, kind: 'fixed' },
      { name: 'One-Time Pest', price: 200, kind: 'fixed' },
    ]);
  });

  test('excludes palmetto bugs, negated pests, and historical pest mentions from specialty suggestions', () => {
    const palmetto = matchCatalogPrices('Seeing a few palmetto bugs in the garage', CATALOG);
    expect(palmetto.some((r) => r.name === 'Cockroach Treatment')).toBe(false);
    expect(palmetto[0].name).toBe('One-Time Pest');

    const denied = matchCatalogPrices('No roaches, just ants in the pantry', CATALOG);
    expect(denied.some((r) => r.name === 'Cockroach Treatment')).toBe(false);
    expect(denied[0].name).toBe('One-Time Pest');

    const contractedDenied = matchCatalogPrices("We aren't seeing roaches and we don't see any wasp nest, just ants.", CATALOG);
    expect(contractedDenied.some((r) => r.name === 'Cockroach Treatment')).toBe(false);
    expect(contractedDenied.some((r) => r.name === 'Bee/Wasp Removal')).toBe(false);
    expect(contractedDenied[0].name).toBe('One-Time Pest');

    const historical = matchCatalogPrices('We had mice years ago, now there is a wasp nest on the porch', CATALOG);
    expect(historical.map((r) => r.name)).toEqual(['Bee/Wasp Removal']);
  });
});

describe('buildCallChecklist (7-item live missing-info checklist)', () => {
  const byKey = (list) => Object.fromEntries(list.map((i) => [i.key, i.ok]));

  test('marks items green from on-file customer + spoken utterances and amber when missing or withdrawn', () => {
    const list = buildCallChecklist({
      customer: { id: 'c1', name: 'Casey Sample' },
      account: { first_name: 'Casey', address_line1: '123 Maplewood Rd', zip: '34202', email: 'casey@example.com' },
      prefs: { pets_secured_plan: 'Two dogs indoors' },
      assist: { intent: 'Wasp nest removal' },
      assistFacts: { when: 'Thursday morning' },
      lines: [{ speaker: 'staff', text: 'That wasp nest removal is $250 one-time.' }],
      catalogPrices: [{ name: 'Bee/Wasp Removal', price: 250 }],
    });
    expect(byKey(list)).toEqual({
      name: true,
      address: true,
      email: true,
      scope: true,
      price_quoted: true,
      time_preference: true,
      access_notes: true,
    });
    expect(list.find((i) => i.key === 'time_preference').label).toBe('Time Preference');

    const withdrawn = buildCallChecklist({
      customer: null,
      account: { address_line1: '123 Maplewood Rd', zip: '34202', email: null },
      prefs: null,
      assist: null,
      assistFacts: { place_withdrawn: true },
      lines: [{ speaker: 'caller', text: 'Actually not 123 Maplewood Rd, I have ants' }],
      catalogPrices: [{ name: 'One-Time Pest', price: 200 }],
    });
    expect(byKey(withdrawn).address).toBe(false);
    expect(byKey(withdrawn).scope).toBe(true);
  });

  test('detects spoken caller details while keeping unanswered staff questions open', () => {
    const list = buildCallChecklist({
      customer: null,
      account: null,
      prefs: null,
      assist: null,
      assistFacts: null,
      lines: [
        { speaker: 'caller', text: 'My name is Jordan, address is 410 Oakwood Ln, email is jordan@gmail.com, we have a dog behind the gate, Tuesday morning works.' },
        { speaker: 'staff', text: 'We can come Tuesday at 10 AM for $200.' },
      ],
      catalogPrices: [{ name: 'One-Time Pest', price: 200 }],
    });
    expect(byKey(list)).toEqual({
      name: true,
      address: true,
      email: true,
      scope: true,
      price_quoted: true,
      time_preference: true,
      access_notes: true,
    });

    const ordinaryOpenings = buildCallChecklist({
      customer: null,
      account: null,
      prefs: null,
      assist: null,
      assistFacts: null,
      lines: [
        { speaker: 'caller', text: "I'm calling about ants. This is about roaches and I'm interested in lawn care." },
      ],
      catalogPrices: [{ name: 'One-Time Pest', price: 200 }],
    });
    expect(byKey(ordinaryOpenings).name).toBe(false);

    const realIntro = buildCallChecklist({
      customer: null,
      account: null,
      prefs: null,
      assist: null,
      assistFacts: null,
      lines: [
        { speaker: 'caller', text: 'Hi, this is Jordan calling about ants.' },
      ],
      catalogPrices: [{ name: 'One-Time Pest', price: 200 }],
    });
    expect(byKey(realIntro).name).toBe(true);

    const unansweredStaff = buildCallChecklist({
      customer: null,
      account: null,
      prefs: null,
      assist: null,
      assistFacts: null,
      lines: [
        { speaker: 'staff', text: 'Do you have a gate or pets? Can we come Tuesday morning? What is your email at gmail?' },
        { speaker: 'caller', text: 'Hold on let me check with my spouse.' },
      ],
      catalogPrices: [],
    });
    expect(byKey(unansweredStaff)).toEqual({
      name: false,
      address: false,
      email: false,
      scope: false,
      price_quoted: false,
      time_preference: false,
      access_notes: false,
    });
  });
});

describe('buildLiveCallCopilot (Caller Brief, Route Slots, Zero Paid Lookups, Full Call Evidence)', () => {
  const baseAccount = {
    id: 'cust-1',
    first_name: 'Casey',
    last_name: 'Sample',
    email: 'casey@example.com',
    pipeline_stage: 'active_customer',
    waveguard_tier: 'Gold',
    address_line1: '123 Maplewood Rd',
    city: 'Bradenton',
    zip: '34202',
    latitude: 27.4989,
    longitude: -82.5748,
    property_sqft: 2400,
    lot_sqft: 8500,
  };

  test('builds Caller Brief with lawn_sqft (never home_sqft), redacts codes, and passes paidLookups: false with ZERO geocoding', async () => {
    const fakeDb = makeFakeDb({
      account: baseAccount,
      properties: [{ id: 'prop-1', address_line1: '123 Maplewood Rd', city: 'Bradenton', zip: '34202', latitude: 27.4989, longitude: -82.5748 }],
      nextVisit: { scheduled_date: '2026-12-01', window_display: '9-11 AM', service_type: 'Quarterly Pest Control' },
      lastVisit: { scheduled_date: '2026-09-01', service_type: 'Quarterly Pest Control' },
      estimates: [
        { status: 'sent', service_interest: 'Mosquito Control', onetime_total: null, monthly_total: 85, annual_total: 1020 },
        { status: 'draft', service_interest: 'Initial + Plan', onetime_total: 200, monthly_total: 50, annual_total: null },
      ],
      recentCalls: 2,
      recentTexts: 3,
      prefs: {
        pets_secured_plan: 'Golden retriever inside',
        chemical_sensitivities: true,
        chemical_sensitivity_details: 'Avoid orchids',
        special_instructions: 'Gate code 4829# side yard',
      },
    });
    const resolveBookingCoords = jest.fn();
    const buildBookingAvailability = jest.fn().mockResolvedValue({ slots: [{ id: 's1' }, { id: 's2' }] });
    const formatSlots = jest.fn().mockReturnValue('Tue Dec 1 at 9 AM; Wed Dec 2 at 11 AM');

    const result = await buildLiveCallCopilot({
      call: { id: 'call-1', customer_id: 'cust-1', twilio_call_sid: 'CA123' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [{ speaker: 'caller', text: 'I found a wasp nest by the back porch' }],
      assist: null,
    }, {
      db: fakeDb,
      now: new Date('2026-11-28T14:00:00Z'),
      isEnabled: () => true,
      addressMatchesCustomer: () => true,
      booking: {
        loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14, default_duration_minutes: 60 }),
        buildBookingAvailability,
        resolveBookingCoords,
      },
      formatSlots,
    });

    expect(resolveBookingCoords).not.toHaveBeenCalled();
    expect(buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
      today: expect.any(Date),
      bestSlotCount: 2,
      paidLookups: false,
    }));
    expect(result.brief).toMatchObject({
      stage: 'active_customer',
      tier: 'Gold',
      address: '123 Maplewood Rd, Bradenton, 34202',
      lawn_sqft: 2400,
      lot_sqft: 8500,
      next_visit: { date: '2026-12-01', service: 'Quarterly Pest Control', window: '9-11 AM' },
      open_estimates: [
        { service: 'Mosquito Control', status: 'sent', totals: { onetime: null, monthly: 85, annual: 1020 }, price_summary: '$85/mo ($1020/yr)' },
        { service: 'Initial + Plan', status: 'draft', totals: { onetime: 200, monthly: 50, annual: null }, price_summary: '$200 one-time + $50/mo' },
      ],
      recent_48h: { calls: 2, texts: 3 },
    });
    expect(result.brief.home_sqft).toBeUndefined();
    expect(result.brief.property_notes.join(' ')).not.toContain('4829');
    expect(result.catalog_prices).toEqual([
      { name: 'Bee/Wasp Removal', price: 250, pricing_type: 'fixed', billing_type: 'one_time', duration_minutes: 45 },
    ]);
    expect(result.route_slots).toEqual(['Tue Dec 1 at 9 AM', 'Wed Dec 2 at 11 AM']);
  });

  test('withholds account slots on multi-property accounts, property lookup failure, or street/unit mismatch', async () => {
    const buildBookingAvailability = jest.fn();
    const multiDb = makeFakeDb({
      account: baseAccount,
      properties: [
        { id: 'prop-1', address_line1: '123 Maplewood Rd', latitude: 27.49, longitude: -82.57 },
        { id: 'prop-2', address_line1: '999 Rental Way', latitude: 27.51, longitude: -82.55 },
      ],
    });
    const multiRes = await buildLiveCallCopilot({
      call: { id: 'call-m', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [],
      assist: null,
    }, { db: multiDb, isEnabled: () => true, booking: { loadBookingConfig: jest.fn(), buildBookingAvailability } });
    expect(multiRes.route_slots).toEqual([]);
    expect(buildBookingAvailability).not.toHaveBeenCalled();

    resetCaches();
    const errDb = makeFakeDb({ account: baseAccount, propertiesError: new Error('db down') });
    const errRes = await buildLiveCallCopilot({
      call: { id: 'call-e', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [],
      assist: null,
    }, { db: errDb, isEnabled: () => true, booking: { loadBookingConfig: jest.fn(), buildBookingAvailability } });
    expect(errRes.route_slots).toEqual([]);
    expect(buildBookingAvailability).not.toHaveBeenCalled();

    // Same house number on a different street or different unit fails addressMatchesCustomer.
    expect(statesDifferentProperty(
      { address_line1: '123 Maplewood Rd', city: 'Bradenton', zip: '34202' },
      { address_line1: '123 Oakwood Ave', zip: '34202' },
      () => false,
    )).toBe(true);

    // Missing/null latitude with valid longitude must fail closed (Number(null)===0 must not pass).
    resetCaches();
    const missingLatDb = makeFakeDb({
      account: { ...baseAccount, latitude: null, longitude: -82.5748 },
      properties: [{ id: 'prop-1', address_line1: '123 Maplewood Rd', latitude: null, longitude: -82.5748 }],
    });
    const missingLatRes = await buildLiveCallCopilot({
      call: { id: 'call-nolat', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [
        { speaker: 'staff', text: 'Any German roaches?' },
        { speaker: 'caller', text: 'No, just ants.' },
      ],
      assist: null,
    }, { db: missingLatDb, isEnabled: () => true, addressMatchesCustomer: () => true, booking: { loadBookingConfig: jest.fn(), buildBookingAvailability } });
    expect(missingLatRes.route_slots).toEqual([]);
    expect(buildBookingAvailability).not.toHaveBeenCalled();
    // Staff screening question ("Any German roaches?") must not trigger Cockroach Treatment.
    expect(missingLatRes.catalog_prices.some((p) => p.name === 'Cockroach Treatment')).toBe(false);
    expect(missingLatRes.catalog_prices[0].name).toBe('One-Time Pest');

    // Spoken location change when GATE_CALL_LIVE_ASSIST is off (assistFacts null) must withhold account route slots.
    resetCaches();
    const otherLocDb = makeFakeDb({
      account: baseAccount,
      properties: [{ id: 'prop-1', address_line1: '123 Maplewood Rd', city: 'Bradenton', zip: '34202', latitude: 27.4989, longitude: -82.5748 }],
    });
    const otherCityRes = await buildLiveCallCopilot({
      call: { id: 'call-other-city', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [{ speaker: 'caller', text: 'This is actually for our place in Venice, 34285.' }],
      assist: null,
    }, { db: otherLocDb, isEnabled: () => true, addressMatchesCustomer: () => false, booking: { loadBookingConfig: jest.fn(), buildBookingAvailability } });
    expect(otherCityRes.route_slots).toEqual([]);
    expect(buildBookingAvailability).not.toHaveBeenCalled();

    resetCaches();
    const rentalRes = await buildLiveCallCopilot({
      call: { id: 'call-rental', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [{ speaker: 'caller', text: "I'm calling about my mother's house." }],
      assist: null,
    }, { db: otherLocDb, isEnabled: () => true, addressMatchesCustomer: () => true, booking: { loadBookingConfig: jest.fn(), buildBookingAvailability } });
    expect(rentalRes.route_slots).toEqual([]);
    expect(buildBookingAvailability).not.toHaveBeenCalled();
  });

  test('preserves checklist evidence from earlier utterances on long calls (>15 lines)', async () => {
    const preview15 = Array.from({ length: 15 }, (_, i) => ({ speaker: 'caller', text: `Follow-up chat ${i + 1}` }));
    const fullHistoryDesc = [
      ...preview15.slice().reverse(),
      { speaker: 'staff', text: 'That one-time pest treatment is $200.' },
      { speaker: 'caller', text: 'My name is Jordan, email jordan@gmail.com, at 410 Oakwood Ln.' },
    ];
    const res = await buildLiveCallCopilot({
      call: { id: 'call-long', twilio_call_sid: 'CAlong123' },
      customer: null,
      meta: {},
      lines: preview15,
      assist: null,
    }, {
      db: makeFakeDb({ fullUtterances: fullHistoryDesc }),
      isEnabled: () => false,
    });
    const byKey = Object.fromEntries(res.checklist.map((i) => [i.key, i.ok]));
    expect(byKey.name).toBe(true);
    expect(byKey.address).toBe(true);
    expect(byKey.email).toBe(true);
    expect(byKey.price_quoted).toBe(true);
  });

  test('excludes held visits from next-visit brief when GATE_VISIT_HOLD is enabled', async () => {
    const priorGate = process.env.GATE_VISIT_HOLD;
    process.env.GATE_VISIT_HOLD = 'true';
    try {
      const whereNullCalls = [];
      const baseDb = makeFakeDb({
        account: { id: 'cust-hold', first_name: 'Sam', last_name: 'Hold', pipeline_stage: 'active_customer' },
        nextVisit: { scheduled_date: '2026-12-03', window_start: '09:00', service_type: 'Quarterly Pest' },
      });
      const spyDb = jest.fn((table) => {
        const chain = baseDb(table);
        const origWhereNull = chain.whereNull;
        chain.whereNull = (col) => {
          whereNullCalls.push({ table, col });
          return origWhereNull(col);
        };
        return chain;
      });
      await buildLiveCallCopilot({
        call: { id: 'call-hold', customer_id: 'cust-hold' },
        customer: { id: 'cust-hold', name: 'Sam Hold' },
        meta: {},
        lines: [],
        assist: null,
      }, { db: spyDb, isEnabled: () => false });
      expect(whereNullCalls).toContainEqual({ table: 'scheduled_services', col: 'scheduled_services.held_at' });
    } finally {
      if (priorGate === undefined) delete process.env.GATE_VISIT_HOLD;
      else process.env.GATE_VISIT_HOLD = priorGate;
    }
  });

  test('computes route slots with requested service duration/key/lines and recomputes when scope changes', async () => {
    const account = {
      id: 'cust-termite', first_name: 'Alex', last_name: 'Termite',
      address_line1: '100 Oak Dr', city: 'Bradenton', zip: '34202',
      latitude: 27.4989, longitude: -82.5748,
    };
    const prop = { id: 'prop-termite', address_line1: '100 Oak Dr', city: 'Bradenton', zip: '34202', latitude: 27.4989, longitude: -82.5748 };
    const buildBookingAvailability = jest.fn()
      .mockResolvedValueOnce({ slots: [{ date: '2026-12-01', window_start: '09:00', window_end: '10:00' }] })
      .mockResolvedValueOnce({ slots: [{ date: '2026-12-02', window_start: '13:00', window_end: '14:30' }] });
    const deps = {
      db: makeFakeDb({ account, properties: [prop] }),
      isEnabled: () => true,
      now: '2026-11-28T15:00:00Z',
      booking: {
        loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 7, slot_duration_minutes: 60 }),
        buildBookingAvailability,
      },
      formatSlots: (slots) => slots.map((s) => `${s.date} ${s.window_start}-${s.window_end}`).join('; '),
    };

    // Poll 1: caller has not named a service yet -> 60-min default
    const first = await buildLiveCallCopilot({
      call: { id: 'call-scope-1', customer_id: 'cust-termite' },
      customer: { id: 'cust-termite', name: 'Alex Termite' },
      meta: {},
      lines: [{ speaker: 'caller', text: 'Hi, I have a question.' }],
      assist: null,
    }, deps);
    expect(first.route_slots).toEqual(['2026-12-01 09:00-10:00']);
    expect(buildBookingAvailability).toHaveBeenNthCalledWith(1, expect.objectContaining({
      duration: 60,
      paidLookups: false,
    }));

    // Poll 2: caller now asks about termites -> recomputes with 90-min termite duration & termite service line (cache key changes)
    const second = await buildLiveCallCopilot({
      call: { id: 'call-scope-1', customer_id: 'cust-termite' },
      customer: { id: 'cust-termite', name: 'Alex Termite' },
      meta: {},
      lines: [
        { speaker: 'caller', text: 'Hi, I have a question.' },
        { speaker: 'caller', text: 'We found termite mud tubes near the garage.' },
      ],
      assist: null,
    }, deps);
    expect(second.route_slots).toEqual(['2026-12-02 13:00-14:30']);
    expect(buildBookingAvailability).toHaveBeenCalledTimes(2);
    expect(buildBookingAvailability).toHaveBeenNthCalledWith(2, expect.objectContaining({
      duration: 90,
      serviceKey: 'termite',
      serviceLines: ['termite'],
      paidLookups: false,
    }));
  });
});
