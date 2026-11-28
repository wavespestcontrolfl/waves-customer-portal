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
  { id: 'svc-1', service_key: 'one_time_pest', name: 'One-Time Pest Control Service', short_name: 'One-Time Pest', base_price: 200, billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-2', service_key: 'cockroach_control', name: 'Cockroach Treatment Service', short_name: 'Cockroach Treatment', base_price: 350, billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-3', service_key: 'bee_wasp_nest_removal', name: 'Bee / Wasp Nest Removal', short_name: 'Bee/Wasp Removal', base_price: 250, billing_type: 'one_time', default_duration_minutes: 45 },
  { id: 'svc-4', service_key: 'wdo_inspection', name: 'WDO Inspection Service', short_name: 'WDO Inspection', base_price: 175, billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-5', service_key: 'lawn_inspection', name: 'Waves Assessment', short_name: 'Waves Assessment', base_price: 0, billing_type: 'one_time', default_duration_minutes: 30 },
  { id: 'svc-6', service_key: 'rodent_trapping', name: 'Rodent Trapping Service', short_name: 'Rodent Trapping', base_price: 300, billing_type: 'one_time', default_duration_minutes: 60 },
  { id: 'svc-7', service_key: 'pest_control', name: 'Quarterly Pest Control', short_name: 'Quarterly Pest', base_price: 99, billing_type: 'recurring', default_duration_minutes: 45 },
];

function makeFakeDb({
  account = null,
  nextVisit = null,
  lastVisit = null,
  estimates = [],
  recentCalls = 0,
  recentTexts = 0,
  prefs = null,
} = {}) {
  return jest.fn((table) => {
    const state = { table, wheres: [], statuses: null };
    const chain = {
      where(a, b) {
        state.wheres.push([a, b]);
        return chain;
      },
      whereNull() { return chain; },
      whereNot() { return chain; },
      whereIn(_col, vals) { state.statuses = vals; return chain; },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      select() {
        if (table === 'estimates') return Promise.resolve(estimates);
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

describe('matchCatalogPrices (full-catalog deterministic lookup)', () => {
  test('surfaces both Cockroach Treatment and One-Time Pest on roach mentions, but excludes Palmetto bug from Cockroach 2-visit package', () => {
    const roach = matchCatalogPrices('Caller says they have german roaches in the kitchen', CATALOG);
    expect(roach.map((r) => r.name)).toEqual(['Cockroach Treatment', 'One-Time Pest']);
    expect(roach[0].price).toBe(350);

    const palmetto = matchCatalogPrices('Seeing a few palmetto bugs in the garage', CATALOG);
    expect(palmetto.map((r) => r.name)).toEqual(['One-Time Pest', 'Quarterly Pest']);
    expect(palmetto.some((r) => r.name === 'Cockroach Treatment')).toBe(false);
  });

  test('matches specialty one-time services (wasp nest, WDO, rodent) from live utterances', () => {
    expect(matchCatalogPrices('There is a big wasp nest under our eaves', CATALOG).map((r) => r.name)).toEqual(['Bee/Wasp Removal']);
    expect(matchCatalogPrices('Need a WDO inspection for real estate closing', CATALOG).map((r) => r.name)).toEqual(['WDO Inspection', 'Waves Assessment']);
    expect(matchCatalogPrices('Hearing rats in the attic', CATALOG).map((r) => r.name)).toEqual(['Rodent Trapping']);
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
      time_confirmed: true,
      access_notes: true,
    });

    const withdrawn = buildCallChecklist({
      customer: null,
      account: { address_line1: '123 Maplewood Rd', zip: '34202', email: null },
      prefs: null,
      assist: null,
      assistFacts: { place_withdrawn: true },
      lines: [{ speaker: 'caller', text: 'Hi I have ants in my kitchen' }],
      catalogPrices: [{ name: 'One-Time Pest', price: 200 }],
    });
    expect(byKey(withdrawn)).toEqual({
      name: false,
      address: false,
      email: false,
      scope: true,
      price_quoted: false,
      time_confirmed: false,
      access_notes: false,
    });
  });

  test('detects spoken street, email, time, and pet/gate cues on new prospect calls', () => {
    const list = buildCallChecklist({
      customer: null,
      account: null,
      prefs: null,
      assist: null,
      assistFacts: null,
      lines: [
        { speaker: 'caller', text: 'My name is Jordan, address is 410 Oakwood Ln, email is jordan@gmail.com, we have a dog behind the gate.' },
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
      time_confirmed: true,
      access_notes: true,
    });
  });
});

describe('buildLiveCallCopilot (Caller Brief + Route Slots + Zero Geocode)', () => {
  test('builds instant Caller Brief at ring, redacts access codes/PANs, and computes 2 slots from stored pin with ZERO geocoding', async () => {
    const fakeDb = makeFakeDb({
      account: {
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
      },
      nextVisit: { scheduled_date: '2026-12-01', window_display: '9-11 AM', service_type: 'Quarterly Pest Control' },
      lastVisit: { scheduled_date: '2026-09-01', service_type: 'Quarterly Pest Control' },
      estimates: [{ status: 'sent', service_interest: 'Mosquito Control', onetime_total: null, monthly_total: 85, annual_total: null }],
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
      call: { id: 'call-1', customer_id: 'cust-1' },
      customer: { id: 'cust-1', name: 'Casey Sample' },
      meta: {},
      lines: [{ speaker: 'caller', text: 'I found a wasp nest by the back porch' }],
      assist: null,
    }, {
      db: fakeDb,
      now: new Date('2026-11-28T14:00:00Z'),
      isEnabled: () => true,
      booking: {
        loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14, default_duration_minutes: 60 }),
        buildBookingAvailability,
        resolveBookingCoords,
      },
      formatSlots,
    });

    expect(resolveBookingCoords).not.toHaveBeenCalled();
    expect(buildBookingAvailability).toHaveBeenCalledTimes(1);
    expect(result.brief).toMatchObject({
      stage: 'active_customer',
      tier: 'Gold',
      address: '123 Maplewood Rd, Bradenton, 34202',
      home_sqft: 2400,
      next_visit: { date: '2026-12-01', service: 'Quarterly Pest Control', window: '9-11 AM' },
      open_estimates: [{ service: 'Mosquito Control', status: 'sent', amount: 85 }],
      recent_48h: { calls: 2, texts: 3 },
    });
    expect(result.brief.property_notes.join(' ')).not.toContain('4829');
    expect(result.catalog_prices).toEqual([
      { name: 'Bee/Wasp Removal', price: 250, billing_type: 'one_time', duration_minutes: 45 },
    ]);
    expect(result.route_slots).toEqual(['Tue Dec 1 at 9 AM', 'Wed Dec 2 at 11 AM']);
    expect(result.checklist).toHaveLength(7);
  });

  test('reuses assist.times without calling buildBookingAvailability and suppresses account slots when caller names another property', async () => {
    const buildBookingAvailability = jest.fn();
    const res1 = await buildLiveCallCopilot({
      call: { id: 'call-2' },
      customer: null,
      meta: {},
      lines: [],
      assist: { intent: 'Pest', times: 'Mon Dec 1 at 9 AM; Tue Dec 2 at 1 PM; Wed Dec 3 at 3 PM' },
    }, {
      db: makeFakeDb(),
      isEnabled: () => true,
      booking: { loadBookingConfig: jest.fn(), buildBookingAvailability },
    });
    expect(buildBookingAvailability).not.toHaveBeenCalled();
    expect(res1.route_slots).toEqual(['Mon Dec 1 at 9 AM', 'Tue Dec 2 at 1 PM']);
    expect(statesDifferentProperty({ city: 'Bradenton', zip: '34202', address_line1: '123 Maple Rd' }, { city: 'Venice' })).toBe(true);
  });
});
