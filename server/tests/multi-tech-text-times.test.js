/**
 * GATE_MULTI_TECH_TEXT_TIMES (multi-technician booking PR 4, owner "go PR 4"
 * 2026-10-06): the lead reply agent's next-available check, the text drafter's
 * city-based OPEN TIMES fallback and its send-time recheck, and the estimate
 * converter's first service day read the website booking engine (routes/
 * booking.js availabilityForPin, per technician and route-aware) instead of
 * the old by-city engine (services/availability.js getAvailableSlots). A lead
 * known only by city is placed at the city centre. Gate off = the old engine,
 * unchanged.
 *
 * No DB, no network: the booking engine, the old finder and the database are
 * mocked, so the test pins WHICH engine each caller asks and with what pin.
 */
const mockRows = { customers: null, estimates: null, leads: null };
jest.mock('../models/db', () => {
  const mk = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'whereNotNull', 'select', 'orderBy', 'forNoKeyUpdate']) q[m] = () => q;
    q.first = async () => (mockRows[table] === undefined ? null : mockRows[table]);
    return q;
  };
  const fn = jest.fn(mk);
  fn.raw = (s) => s;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({}));
jest.mock('../services/pricing-authority-gate', () => ({}));
jest.mock('../services/estimate-automation-duplicates', () => ({}));

const mockBook = {
  availabilityForPin: jest.fn(),
  bookableOfferCustomer: jest.fn(),
  customerBookingLocation: jest.fn(),
  resolveBookingCoords: jest.fn(),
};
jest.mock('../routes/booking', () => ({ _internals: mockBook }));

const mockOld = { getAvailableSlots: jest.fn() };
jest.mock('../services/availability', () => mockOld);

const GATE = 'GATE_MULTI_TECH_TEXT_TIMES';
const prior = process.env[GATE];
const CUSTOMER_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';
const ESTIMATE_ID = '6c9e2d0f-5b3a-4c7f-8d4e-9f0a7b6c5d4e';

// The website engine's day shape: every feasible start, dateLabels fields.
const BOOK_DAYS = [
  { date: '2026-10-08', dayOfWeek: 'Thu', dayNum: 8, month: 'Oct', fullDate: 'Thursday, October 8', slots: [{ start: '9:00 AM', startTime24: '09:00', technician_id: 'tech-b' }, { start: '9:15 AM', startTime24: '09:15', technician_id: 'tech-b' }, { start: '1:00 PM', startTime24: '13:00', technician_id: 'tech-a' }] },
  { date: '2026-10-09', dayOfWeek: 'Fri', dayNum: 9, month: 'Oct', fullDate: 'Friday, October 9', slots: [{ start: '8:00 AM', startTime24: '08:00', technician_id: 'tech-a' }] },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRows.customers = null;
  mockRows.estimates = null;
  mockRows.leads = null;
  delete process.env[GATE];
  mockBook.availabilityForPin.mockResolvedValue({ days: BOOK_DAYS });
  mockBook.customerBookingLocation.mockResolvedValue(null);
  mockBook.bookableOfferCustomer.mockImplementation(async (id) => (id ? { id, city: 'Sarasota' } : null));
  mockBook.resolveBookingCoords.mockResolvedValue({ lat: null, lng: null });
  mockOld.getAvailableSlots.mockResolvedValue({ zone: 'Old Zone', days: [{ date: '2026-10-07', dayOfWeek: 'Wed', slots: [{ start: '9:00 AM' }] }] });
});
afterAll(() => { if (prior === undefined) delete process.env[GATE]; else process.env[GATE] = prior; });

describe('the gate', () => {
  test('is dark: unset, false and 1 all read off; only the exact string true reads on', () => {
    const { multiTechTextTimesLive } = require('../config/feature-gates');
    expect(multiTechTextTimesLive()).toBe(false);
    for (const v of ['false', '1', 'on', 'TRUE', '']) { process.env[GATE] = v; expect(multiTechTextTimesLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(multiTechTextTimesLive()).toBe(true);
  });
});

describe('city centre', () => {
  const { cityCentre, _internals } = require('../services/scheduling/text-offer-times');

  test('a served city uses its fixed point from the forecast table, in any common spelling', async () => {
    const lwr = await cityCentre('Lakewood Ranch');
    expect(lwr).toEqual({ lat: 27.4225, lng: -82.4082, source: 'city_table' });
    expect(await cityCentre('  lakewood ranch, FL ')).toEqual(lwr);
    expect(await cityCentre('Port Charlotte')).toMatchObject({ lat: 26.9762, lng: -82.0906, source: 'city_table' });
    expect(mockBook.resolveBookingCoords).not.toHaveBeenCalled();
  });

  test('a served city with no table row falls to the centre of its service zone (what /book uses for a bare city)', async () => {
    mockBook.resolveBookingCoords.mockResolvedValue({ lat: 27.3364, lng: -82.5307 });
    await expect(cityCentre('University Park')).resolves.toEqual({ lat: 27.3364, lng: -82.5307, source: 'zone_centre' });
    expect(mockBook.resolveBookingCoords).toHaveBeenCalledWith({ city: 'University Park' });
  });

  test('a city Waves does not serve gets no centre: metros in the forecast table outside the served counties never become a pin', async () => {
    for (const city of ['Tampa', 'Fort Myers', 'Naples', 'Orlando']) {
      expect(_internals.tableCityCentre(city)).toBeNull();
      await expect(cityCentre(city)).resolves.toBeNull();
    }
  });

  test('a blank city resolves to nothing without any lookup', async () => {
    mockBook.resolveBookingCoords.mockClear();
    await expect(cityCentre('')).resolves.toBeNull();
    await expect(cityCentre(null)).resolves.toBeNull();
    expect(mockBook.resolveBookingCoords).not.toHaveBeenCalled();
  });

  test('every served city in the forecast table has a point inside the three served counties (Manatee, Sarasota, Charlotte)', () => {
    const { LOCATIONS } = require('../services/pest-forecast/locations');
    const served = LOCATIONS.filter((l) => l.region === 'sw' && _internals.SERVED_COUNTIES.has(l.county));
    expect(served.map((l) => l.slug)).toEqual(expect.arrayContaining(['bradenton-fl', 'lakewood-ranch-fl', 'sarasota-fl', 'venice-fl', 'north-port-fl', 'parrish-fl', 'port-charlotte-fl']));
    for (const l of served) {
      expect(l.lat).toBeGreaterThan(26.8);
      expect(l.lat).toBeLessThan(27.7);
    }
  });
});

describe('textOfferDays — one reader, the website engine, a pin', () => {
  const { textOfferDays } = require('../services/scheduling/text-offer-times');

  test('a lead known only by city is placed at the city centre and gets the website engine\'s days', async () => {
    const out = await textOfferDays({ city: 'Lakewood Ranch' });
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.4225, lng: -82.4082, serviceKey: 'pest_control', internal: false });
    expect(out).toEqual({ days: BOOK_DAYS, pinSource: 'city_table' });
    expect(mockOld.getAvailableSlots).not.toHaveBeenCalled();
  });

  test('a customer with a booking pin is offered from that pin, not the city centre', async () => {
    mockBook.customerBookingLocation.mockResolvedValue({ lat: 27.31, lng: -82.49 });
    const out = await textOfferDays({ customerId: CUSTOMER_ID, city: 'Sarasota', serviceKey: 'lawn_care' });
    expect(mockBook.bookableOfferCustomer).toHaveBeenCalledWith(CUSTOMER_ID, { internal: false });
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.31, lng: -82.49, serviceKey: 'lawn_care', internal: false });
    expect(out.pinSource).toBe('customer');
  });

  test('an estimate with no customer id on the call resolves the customer behind it', async () => {
    mockRows.estimates = { customer_id: CUSTOMER_ID };
    mockBook.customerBookingLocation.mockResolvedValue({ lat: 27.2, lng: -82.45 });
    const out = await textOfferDays({ estimateId: ESTIMATE_ID });
    expect(mockBook.bookableOfferCustomer).toHaveBeenCalledWith(CUSTOMER_ID, { internal: false });
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.2, lng: -82.45, serviceKey: 'pest_control', internal: false });
    expect(out.pinSource).toBe('customer');
  });

  // Codex r1 P1 on #6073: an inactive account, or a blocked pre-customer stage
  // under bookingCustomersOnly, cannot book on /book, so a text must not quote it
  // times — and /book offers such a known customer nothing, so no city centre.
  test('a customer /book would refuse (inactive, blocked pre-customer stage) gets NO times: no pin lookup, no city-centre fallback', async () => {
    mockBook.bookableOfferCustomer.mockResolvedValue(null);
    mockBook.customerBookingLocation.mockResolvedValue({ lat: 27.31, lng: -82.49 });
    await expect(textOfferDays({ customerId: CUSTOMER_ID, city: 'Venice' })).resolves.toBeNull();
    mockRows.estimates = { customer_id: CUSTOMER_ID };
    await expect(textOfferDays({ estimateId: ESTIMATE_ID, city: 'Venice' })).resolves.toBeNull();
    expect(mockBook.customerBookingLocation).not.toHaveBeenCalled();
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('the eligibility check is the ONE shared predicate from booking.js (no local copy of the active / stage rules)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduling/text-offer-times.js'), 'utf8');
    expect(src).toContain('bookableOfferCustomer');
    expect(src).not.toMatch(/active:\s*true|pipeline_stage|PRE_CUSTOMER/);
  });

  test('an eligible customer with no resolvable pin (staff review hold, no address) gets no times, not the city centre', async () => {
    await expect(textOfferDays({ customerId: CUSTOMER_ID, city: 'Venice' })).resolves.toBeNull();
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('internal (the estimate converter): the sign-in rules are skipped, the public-funnel switch is skipped, and an ungeocodable address falls to the city centre', async () => {
    const out = await textOfferDays({ customerId: CUSTOMER_ID, city: 'Venice', internal: true });
    expect(mockBook.bookableOfferCustomer).toHaveBeenCalledWith(CUSTOMER_ID, { internal: true });
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.0998, lng: -82.4543, serviceKey: 'pest_control', internal: true });
    expect(out.pinSource).toBe('city_table');
  });

  test('no customer pin and no served city: nothing is offered and the engine is never asked', async () => {
    await expect(textOfferDays({ city: 'Tampa' })).resolves.toBeNull();
    await expect(textOfferDays({})).resolves.toBeNull();
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('the engine offering nothing (/book off, no funnel service) is nothing offered', async () => {
    mockBook.availabilityForPin.mockResolvedValue(null);
    await expect(textOfferDays({ city: 'Bradenton' })).resolves.toBeNull();
  });
});

describe('lead reply agent: check_next_availability', () => {
  const { executeLeadTool } = require('../services/lead-response-tools');
  const context = { leadId: '00000000-0000-4000-8000-000000000001', customerId: '00000000-0000-4000-8000-000000000002' };
  const run = () => executeLeadTool('check_next_availability', { city: 'Lakewood Ranch' }, context);

  beforeEach(() => {
    mockRows.customers = { id: context.customerId, phone: '+19415550100' };
    mockRows.leads = { id: context.leadId, customer_id: context.customerId };
  });

  test('gate off: the old by-city engine answers, exactly as before', async () => {
    const out = await run();
    expect(mockOld.getAvailableSlots).toHaveBeenCalledWith('Lakewood Ranch');
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
    expect(out.nextAvailable).toMatchObject({ date: '2026-10-07', slotCount: 1 });
  });

  test('gate on: the website engine answers from the middle of the lead\'s city; the old engine is never called', async () => {
    process.env[GATE] = 'true';
    const out = await run();
    expect(mockOld.getAvailableSlots).not.toHaveBeenCalled();
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.4225, lng: -82.4082, serviceKey: 'pest_control', internal: false });
    expect(out.city).toBe('Lakewood Ranch');
    expect(out.nextAvailable).toMatchObject({ date: '2026-10-08', dayOfWeek: 'Thu', firstSlot: '9:00 AM', slotCount: 3 });
    expect(out.options.map((d) => d.date)).toEqual(['2026-10-08', '2026-10-09']);
  });

  test('gate on, a city Waves does not serve: no next available, no error (the old engine said "no zone")', async () => {
    process.env[GATE] = 'true';
    const out = await executeLeadTool('check_next_availability', { city: 'Tampa' }, context);
    expect(out.nextAvailable).toBeNull();
    expect(out.options).toEqual([]);
    expect(out.error).toBeUndefined();
  });
});

describe('estimate converter: first service day', () => {
  const { pickFirstServiceDate, funnelKeyForEstimate, funnelKeyForEstimateId } = require('../services/estimate-converter');
  const customer = { id: CUSTOMER_ID, city: 'Sarasota' };

  test('gate off: the old by-city engine picks the day', async () => {
    await expect(pickFirstServiceDate(customer, ESTIMATE_ID, { serviceKey: 'pest_control' })).resolves.toBe('2026-10-07');
    expect(mockOld.getAvailableSlots).toHaveBeenCalledWith('Sarasota', ESTIMATE_ID);
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('gate on + a funnel service: the first day the website engine has a start, asked INTERNALLY for that estimate\'s service', async () => {
    process.env[GATE] = 'true';
    mockBook.customerBookingLocation.mockResolvedValue({ lat: 27.31, lng: -82.49 });
    await expect(pickFirstServiceDate(customer, ESTIMATE_ID, { serviceKey: 'lawn_care' })).resolves.toBe('2026-10-08');
    expect(mockOld.getAvailableSlots).not.toHaveBeenCalled();
    // Codex r1 P1 on #6073: internal skips GATE_SELF_BOOKING and the sign-in rules
    // (staff scheduling must not depend on the public funnel); the service is the
    // estimate's, not a default 60-minute pest visit.
    expect(mockBook.bookableOfferCustomer).toHaveBeenCalledWith(CUSTOMER_ID, { internal: true });
    expect(mockBook.availabilityForPin).toHaveBeenCalledWith({ lat: 27.31, lng: -82.49, serviceKey: 'lawn_care', internal: true });
  });

  test('gate on, an estimate the website engine cannot represent (no funnel service): the OLD engine keeps it', async () => {
    process.env[GATE] = 'true';
    await expect(pickFirstServiceDate(customer, ESTIMATE_ID, { serviceKey: '' })).resolves.toBe('2026-10-07');
    await expect(pickFirstServiceDate(customer, ESTIMATE_ID)).resolves.toBe('2026-10-07');
    expect(mockOld.getAvailableSlots).toHaveBeenCalledTimes(2);
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('gate on, an empty city and no customer pin: the + 7 days rule, not the old engine', async () => {
    process.env[GATE] = 'true';
    const out = await pickFirstServiceDate({ id: null, city: '' }, ESTIMATE_ID, { serviceKey: 'pest_control' });
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockOld.getAvailableSlots).not.toHaveBeenCalled();
    expect(mockBook.availabilityForPin).not.toHaveBeenCalled();
  });

  test('gate on, the engine throwing falls to the + 7 days rule instead of failing the acceptance', async () => {
    process.env[GATE] = 'true';
    mockBook.availabilityForPin.mockRejectedValue(new Error('engine down'));
    const out = await pickFirstServiceDate({ id: null, city: 'Sarasota' }, ESTIMATE_ID, { serviceKey: 'pest_control' });
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // Codex r1 P1 on #6073: the estimate's own service picks the funnel service.
  describe('funnelKeyForEstimate', () => {
    test('one funnel service across every sold recurring line maps through the explicit table', () => {
      expect(funnelKeyForEstimate([{ service: 'Pest Control' }], {})).toBe('pest_control');
      expect(funnelKeyForEstimate([{ service: 'Lawn Care' }, { serviceKey: 'lawn_care' }], {})).toBe('lawn_care');
      expect(funnelKeyForEstimate([{ service_key: 'tree_shrub' }], {})).toBe('tree_shrub');
      expect(funnelKeyForEstimate([{ service: 'Mosquito Control' }], {})).toBe('mosquito');
    });

    test('a multi-service plan, a combined plan or a service /book does not book is NOT representable (old engine)', () => {
      expect(funnelKeyForEstimate([{ service: 'Pest Control' }, { service: 'Lawn Care' }], {})).toBe('');
      expect(funnelKeyForEstimate([{ service: 'Pest Control' }, { service: 'Termite Bait Stations' }], {})).toBe('');
      expect(funnelKeyForEstimate([{ service: 'Rodent Bait Stations' }], {})).toBe('');
      expect(funnelKeyForEstimate([{ service: 'Palm Injection' }], {})).toBe('');
      expect(funnelKeyForEstimate([{ service: 'Something Unmapped' }], {})).toBe('');
    });

    // Codex r2 P1-1 on #6073: the text drafter reads a STORED estimate through the same function.
    test('funnelKeyForEstimateId reads a stored estimate (jsonb object or JSON string) through the same funnelKeyForEstimate', async () => {
      mockRows.estimates = { service_interest: 'Pest Control', estimate_data: { recurring: { services: [{ service: 'Lawn Care' }] } } };
      await expect(funnelKeyForEstimateId(ESTIMATE_ID)).resolves.toBe('lawn_care');
      mockRows.estimates = { service_interest: 'Pest Control', estimate_data: JSON.stringify({ recurring: { services: [{ service: 'Pest Control' }, { service: 'Lawn Care' }] } }) };
      await expect(funnelKeyForEstimateId(ESTIMATE_ID)).resolves.toBe('');
      mockRows.estimates = { service_interest: 'Mosquito Control', estimate_data: 'not json' };
      await expect(funnelKeyForEstimateId(ESTIMATE_ID)).resolves.toBe('mosquito');
      mockRows.estimates = null;
      await expect(funnelKeyForEstimateId(ESTIMATE_ID)).resolves.toBe('');
      await expect(funnelKeyForEstimateId(null)).resolves.toBe('');
    });

    test('no recurring line: the estimate\'s own service name through the same table, else not representable', () => {
      expect(funnelKeyForEstimate([], { service_interest: 'Lawn Care' })).toBe('lawn_care');
      expect(funnelKeyForEstimate(undefined, { service_interest: 'One-off Wasp Removal' })).toBe('');
      expect(funnelKeyForEstimate([], {})).toBe('');
    });
  });
});
