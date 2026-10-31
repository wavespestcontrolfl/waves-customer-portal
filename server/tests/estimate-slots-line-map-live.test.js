/**
 * GATE_SERVICE_LINE_MAP=live (build 4, owner 2026-10-30), estimate time picker:
 * the offer names only the technicians the held visit's line(s) map to. The home
 * technician wins a start both have; the gap technician fills the starts the home
 * technician has none for; anyone else is dropped. Gate off or shadow, or no
 * technician set for the line: the very same list, with no map query.
 */
// No live geocoding in tests: coords come from the mocked customer row.
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GATE_ESTIMATE_SLOT_ONE_PER_HOUR;
delete process.env.GATE_SERVICE_LINE_MAP;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0, total_feasible: 0 })),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../services/scheduling/line-technician', () => ({
  serviceLineFor: jest.fn(async () => ({ line: 'general', lineFrom: 'name' })),
  lineOfferRanking: jest.fn(async () => null),
}));
// GATE_CUSTOMER_ROUTE_CHECK stand-in: off unless a test turns it on and names the slots it rejects.
const mockRouteCheck = { mode: 'off', rejects: () => false };
jest.mock('../services/scheduling/customer-route-check', () => ({
  customerRouteCheckMode: () => mockRouteCheck.mode,
  filterOfferedSlots: jest.fn(async ({ slots }) => ({ slots: slots.filter((s) => !mockRouteCheck.rejects(s)) })),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const lineTechnician = require('../services/scheduling/line-technician');
const estimateSlotAvailability = require('../services/estimate-slot-availability');

const { getAvailableSlots } = estimateSlotAvailability;
const { applyLineOfferRule, heldVisitLines, lineOfferRankingFor } = estimateSlotAvailability._internals;

const GATE = 'GATE_SERVICE_LINE_MAP';

const ESTIMATE_ROW = {
  id: 'est-line-map-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Palm Ave, Venice, FL 34293',
  estimate_data: null,
  service_interest: 'Pest Control',
};

const TECHS = [
  { id: 'tech-home', name: 'Alpha One' },
  { id: 'tech-gap', name: 'Bravo Two' },
  { id: 'tech-other', name: 'Charlie Three' },
];

function mockDb() {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.0998, longitude: -82.4543, address_line1: '123 Palm Ave', city: 'Venice', state: 'FL', zip: '34293',
        }),
      };
    }
    if (table === 'technicians') {
      return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(TECHS) };
    }
    if (table === 'service_zones') return { select: jest.fn().mockResolvedValue([]) };
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'technician_absences') {
      return {
        whereBetween: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const slot = (over = {}) => ({
  slotId: `${over.date || '2027-05-20'}_${String(over.windowStart || '09:00').replace(':', '-')}_${over.techId || 'tech-home'}`,
  date: '2027-05-20',
  windowStart: '09:00',
  windowEnd: '10:00',
  durationMinutes: 60,
  techId: 'tech-home',
  techFirstName: 'Alpha',
  routeOptimal: false,
  nearbyJob: null,
  ...over,
});

// The ranking lineOfferRanking returns for a pest line: home 0, gap 1, anyone else out.
const RANKING = {
  lines: ['general'],
  rankOf: (id) => ({ 'tech-home': 0, 'tech-gap': 1 })[id] ?? null,
};

describe('applyLineOfferRule (pure)', () => {
  test('no ranking: the very same array', () => {
    const pool = [slot(), slot({ techId: 'tech-other' })];
    expect(applyLineOfferRule(pool, null)).toBe(pool);
    expect(applyLineOfferRule(pool, null, { sameStart: true })).toBe(pool);
  });

  test('a third technician is dropped; home and gap are kept', () => {
    const pool = [slot({ techId: 'tech-home' }), slot({ techId: 'tech-gap', windowStart: '10:00' }), slot({ techId: 'tech-other', windowStart: '11:00' })];
    expect(applyLineOfferRule(pool, RANKING).map((s) => s.techId)).toEqual(['tech-home', 'tech-gap']);
  });

  test('a slot with no technician is dropped (a mapped line needs a named technician)', () => {
    expect(applyLineOfferRule([slot({ techId: null })], RANKING)).toEqual([]);
  });

  test('home wins a start both have; the gap technician fills a start the home technician lacks', () => {
    const homeNine = slot({ techId: 'tech-home', windowStart: '09:00' });
    const gapNine = slot({ techId: 'tech-gap', windowStart: '09:00' });
    const gapTen = slot({ techId: 'tech-gap', windowStart: '10:00', techFirstName: 'Bravo' });
    const out = applyLineOfferRule([gapNine, homeNine, gapTen], RANKING, { sameStart: true });
    expect(out).toEqual([homeNine, gapTen]);
    // Each kept slot is the whole original object: own technician, own first name.
    expect(out[1].techId).toBe('tech-gap');
    expect(out[1].techFirstName).toBe('Bravo');
  });

  test('another date at the same start is its own start', () => {
    const homeMon = slot({ date: '2027-05-18' });
    const gapTue = slot({ date: '2027-05-19', techId: 'tech-gap' });
    expect(applyLineOfferRule([homeMon, gapTue], RANKING, { sameStart: true })).toEqual([homeMon, gapTue]);
  });

  test('a combined hold: only a technician on every line is kept (rank from lineOfferRanking)', () => {
    // pest + lawn: tech-home is home for both (0); tech-gap is gap on both (2); tech-pest covers pest only (null).
    const combined = { lines: ['general', 'lawn'], rankOf: (id) => ({ 'tech-home': 0, 'tech-gap': 2 })[id] ?? null };
    const pool = [slot({ techId: 'tech-pest' }), slot({ techId: 'tech-gap' }), slot({ techId: 'tech-home' })];
    expect(applyLineOfferRule(pool, combined, { sameStart: true }).map((s) => s.techId)).toEqual(['tech-home']);
  });
});

describe('heldVisitLines', () => {
  beforeEach(() => {
    lineTechnician.serviceLineFor.mockReset();
    lineTechnician.serviceLineFor.mockImplementation(async (_conn, { serviceType }) => (
      /lawn/i.test(serviceType) ? { line: 'lawn', lineFrom: 'name' } : { line: 'general', lineFrom: 'name' }));
  });

  test('one program: the primary program only (pest first, as the hold stamps it)', async () => {
    const profile = { services: [{ service: 'lawn_care', label: 'Lawn Care' }, { service: 'pest_control', label: 'Quarterly Pest Control' }] };
    await expect(heldVisitLines(profile)).resolves.toEqual(['general']);
  });

  test('a combined capacity hold: every program\'s line, each once', async () => {
    const profile = {
      reservationServiceMix: { services: ['pest_control', 'lawn_care'] },
      services: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }, { service: 'pest_control', label: 'Pest Control' }],
    };
    await expect(heldVisitLines(profile)).resolves.toEqual(['general', 'lawn']);
  });

  test('the catalog row is asked first (resolved key, else the keyed quote key)', async () => {
    const profile = { services: [{ service: 'tree_shrub', label: 'Tree & Shrub', resolvedServiceKey: 'tree_shrub_quarterly' }] };
    await heldVisitLines(profile);
    expect(lineTechnician.serviceLineFor).toHaveBeenCalledWith(db, { serviceKey: 'tree_shrub_quarterly', serviceType: 'Tree & Shrub' });
  });

  test('no programs: no lines', async () => {
    await expect(heldVisitLines({ services: [] })).resolves.toEqual([]);
  });
});

describe('lineOfferRankingFor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[GATE];
  });
  afterEach(() => { delete process.env[GATE]; });

  test.each([[undefined], ['shadow'], ['off']])('gate %s: null and no map read', async (mode) => {
    if (mode) process.env[GATE] = mode;
    await expect(lineOfferRankingFor({ services: [{ service: 'pest_control', label: 'Pest Control' }] })).resolves.toBeNull();
    expect(lineTechnician.serviceLineFor).not.toHaveBeenCalled();
    expect(lineTechnician.lineOfferRanking).not.toHaveBeenCalled();
  });

  test('live: asks lineOfferRanking for the held visit\'s lines', async () => {
    process.env[GATE] = 'live';
    lineTechnician.serviceLineFor.mockResolvedValue({ line: 'general', lineFrom: 'name' });
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    await expect(lineOfferRankingFor({ services: [{ service: 'pest_control', label: 'Pest Control' }] })).resolves.toBe(RANKING);
    expect(lineTechnician.lineOfferRanking).toHaveBeenCalledWith(db, { lines: ['general'], place: null });
  });

  test('live: the ZIP typed in the quoted address is the territory place (GATE_TERRITORY_ROUTING)', async () => {
    process.env[GATE] = 'live';
    lineTechnician.serviceLineFor.mockResolvedValue({ line: 'general', lineFrom: 'name' });
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    const profile = { services: [{ service: 'pest_control', label: 'Pest Control' }] };
    await lineOfferRankingFor(profile, { address: '123 Palm Ave, Venice, FL 34293', customer_id: 'cust-1' });
    expect(lineTechnician.lineOfferRanking).toHaveBeenLastCalledWith(db, { lines: ['general'], place: { zip: '34293' } });
    // No ZIP in the quoted address: no place, never the customer's (another property may be quoted).
    await lineOfferRankingFor(profile, { address: '123 Palm Ave', customer_id: 'cust-1' });
    expect(lineTechnician.lineOfferRanking).toHaveBeenLastCalledWith(db, { lines: ['general'], place: null });
  });

  test('live but the map is unreadable: today\'s list (null)', async () => {
    process.env[GATE] = 'live';
    lineTechnician.serviceLineFor.mockResolvedValue({ line: 'general', lineFrom: 'name' });
    lineTechnician.lineOfferRanking.mockRejectedValue(new Error('db down'));
    await expect(lineOfferRankingFor({ services: [{ service: 'pest_control', label: 'Pest Control' }] })).resolves.toBeNull();
  });
});

describe('getAvailableSlots, line map live', () => {
  const WINDOW = { dateFrom: '2027-05-18', dateTo: '2027-05-20' };
  const all = (r) => [...(r.primary || []), ...(r.expander || [])];
  const startKey = (s) => `${s.date}|${s.windowStart}`;
  const strip = (r) => ({
    primary: r.primary.map((s) => ({ ...s })),
    expander: r.expander.map((s) => ({ ...s })),
    nearby: r.nearby,
    firstDayAvailability: r.metadata.firstDayAvailability,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    findAvailableSlots.mockResolvedValue({ slots: [], evaluated: 0, total_feasible: 0 });
    lineTechnician.serviceLineFor.mockResolvedValue({ line: 'general', lineFrom: 'name' });
    lineTechnician.lineOfferRanking.mockResolvedValue(null);
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    delete process.env[GATE];
    mockDb();
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env[GATE];
  });

  test('gate off and shadow: identical output and no map read', async () => {
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'shadow';
    const shadow = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(strip(shadow)).toEqual(strip(off));
    expect(lineTechnician.lineOfferRanking).not.toHaveBeenCalled();
  });

  test('live with no technician set for the line (ranking null): identical to today', async () => {
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'live';
    const live = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(strip(live)).toEqual(strip(off));
  });

  test('live: only the home and gap technicians are offered, home first at a shared start', async () => {
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 80, expanderMaxResults: 0 });
    expect(new Set(all(off).map((s) => s.techId))).toEqual(new Set(['tech-home', 'tech-gap', 'tech-other']));

    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'live';
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    const live = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 80, expanderMaxResults: 0 });
    const slots = all(live);
    expect(slots.length).toBeGreaterThan(0);
    // Everyone has every start in this fixture, so home takes all of them.
    expect(new Set(slots.map((s) => s.techId))).toEqual(new Set(['tech-home']));
    expect(new Set(slots.map(startKey)).size).toBe(slots.length);
    // Each kept slot is complete and names its own technician.
    for (const s of slots) {
      expect(s.slotId).toContain('tech-home');
      expect(s.techFirstName).toBe('Alpha');
    }
  });

  test('live: a start the home technician lacks is filled by the gap technician', async () => {
    process.env[GATE] = 'live';
    lineTechnician.lineOfferRanking.mockResolvedValue({
      lines: ['general'],
      // Home is switched off for the whole day by the fixture below: only the gap technician has slots.
      rankOf: (id) => ({ 'tech-home': 0, 'tech-gap': 1 })[id] ?? null,
    });
    // Remove tech-home from the generator's technician list.
    db.mockImplementation(((impl) => (table) => {
      if (table === 'technicians') return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(TECHS.filter((t) => t.id !== 'tech-home')) };
      return impl(table);
    })(db.getMockImplementation()));
    const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 80, expanderMaxResults: 0 });
    const techs = new Set(all(result).map((s) => s.techId));
    expect(techs).toEqual(new Set(['tech-gap']));
  });

  test('live: the route-aware path is ranked too (a gap technician route slot loses to the home slot)', async () => {
    process.env[GATE] = 'live';
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2027-05-20', start_time: '10:00', technician: { id: 'tech-gap', name: 'Bravo Two' }, detour_minutes: 2, stops_that_day: 3, insertion: { after_stop_id: 's1', after: 'Customer (09:00)' } },
        { date: '2027-05-20', start_time: '10:00', technician: { id: 'tech-other', name: 'Charlie Three' }, detour_minutes: 1, stops_that_day: 3, insertion: { after_stop_id: 's2', after: 'Customer (09:00)' } },
      ],
      evaluated: 2,
      total_feasible: 2,
    });
    const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 80, expanderMaxResults: 0 });
    const ten = all(result).filter((s) => startKey(s) === '2027-05-20|10:00');
    // The home technician's ASAP slot at 10:00 beats the gap technician's route slot; tech-other is gone.
    expect(ten.map((s) => s.techId)).toEqual(['tech-home']);
    expect(all(result).some((s) => s.techId === 'tech-other')).toBe(false);
  });

  test('live + route check on: a home slot the check rejects leaves the gap slot at that start (choice runs after the check)', async () => {
    process.env[GATE] = 'live';
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    mockRouteCheck.mode = 'on';
    mockRouteCheck.rejects = (s) => s.techId === 'tech-home' && s.date === '2027-05-20' && s.windowStart === '10:00';
    try {
      const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, offer: true, maxResults: 80, expanderMaxResults: 0 });
      const ten = all(result).filter((s) => startKey(s) === '2027-05-20|10:00');
      expect(ten.map((s) => s.techId)).toEqual(['tech-gap']);
      // Every other start still goes to the home technician, once.
      const others = all(result).filter((s) => startKey(s) !== '2027-05-20|10:00');
      expect(others.length).toBeGreaterThan(0);
      expect(new Set(others.map((s) => s.techId))).toEqual(new Set(['tech-home']));
      expect(new Set(all(result).map(startKey)).size).toBe(all(result).length);
    } finally {
      mockRouteCheck.mode = 'off';
      mockRouteCheck.rejects = () => false;
    }
  });

  test('live: a ranked list is not served from, or written to, the 5-minute cache', async () => {
    process.env[GATE] = 'live';
    lineTechnician.lineOfferRanking.mockResolvedValue(RANKING);
    await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    const second = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(second.metadata.cacheHit).toBe(false);
    expect(lineTechnician.lineOfferRanking).toHaveBeenCalledTimes(2);
  });
});
