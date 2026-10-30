/**
 * GATE_SERVICE_LINE_MAP=live on /book's offer builder (build 4, owner 2026-10-30):
 * buildBookingAvailability({ serviceLines }) keeps only a mapped line's home and gap
 * technician's slots, the home technician claiming a date+start both have, under the
 * plain first-claim rule AND the re-service profile's displacement rule. Not live, not
 * named, an unmapped line or an unreadable map: today's offers, byte for byte.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/packing-geometry', () => ({ loadPackingAnchors: jest.fn() }));
jest.mock('../services/scheduling/line-technician', () => ({
  lineMapLive: jest.fn(),
  lineOfferRanking: jest.fn(),
  serviceLineFor: jest.fn(),
  recordLinePickShadow: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadPackingAnchors } = require('../services/scheduling/packing-geometry');
const lineTech = require('../services/scheduling/line-technician');
const { buildBookingAvailability, buildFunnelAvailability, funnelServiceLines } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const NOW = parseETDateTime(`${etDateString()}T12:00`);
const D = etDateString(addETDays(NOW, 10));
const CONFIG = {
  advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00', max_self_books_per_day: 3,
};

const slotOf = (techId, startTime, extra = {}) => ({
  date: D, start_time: startTime, end_time: null, technician: { id: techId },
  detour_minutes: 3, stops_that_day: 0, rank: 1, score: 10, insertion: {}, ...extra,
});

// Home tech rank 0, gap tech rank 1, anybody else dropped (what lineOfferRanking returns).
const ranking = { lines: ['general'], rankOf: (id) => ({ 'tech-home': 0, 'tech-gap': 1 }[id] ?? null) };

function wireDb() {
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
}

async function build(slots, extra = {}) {
  const gate = process.env.GATE_SCHEDULING_CAPACITY;
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  findAvailableSlots.mockResolvedValue({ slots, total_feasible: slots.length });
  try {
    return await buildBookingAvailability({
      lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: NOW, ...extra,
    });
  } finally {
    if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = gate;
  }
}

const offers = (availability) => (availability.days[0]?.slots || []).map((s) => `${s.start_time}:${s.technician_id}`);
const stripSig = (value) => JSON.parse(JSON.stringify(value, (key, val) => (key === 'slot_sig' ? undefined : val)));

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
  loadPackingAnchors.mockResolvedValue([]);
  lineTech.lineMapLive.mockReturnValue(true);
  lineTech.lineOfferRanking.mockResolvedValue(ranking);
});

describe('buildBookingAvailability — serviceLines (line map live)', () => {
  const shared = () => [
    // find-time scores the gap technician first at 09:00 (lower score): the home technician still wins it.
    slotOf('tech-gap', '09:00', { score: 5 }),
    slotOf('tech-home', '09:00', { score: 9 }),
    slotOf('tech-gap', '11:00', { score: 6 }),
    slotOf('tech-other', '10:00', { score: 1 }),
  ];

  test('the home technician wins a start both have, the gap technician fills the start the home lacks, a third technician is dropped', async () => {
    const result = await build(shared(), { serviceLines: ['general'] });
    expect(lineTech.lineOfferRanking).toHaveBeenCalledWith(db, { lines: ['general'] });
    expect(offers(result)).toEqual(['09:00:tech-home', '11:00:tech-gap']);
  });

  test('the ranking does not leak into the response', async () => {
    const result = await build(shared(), { serviceLines: ['general'] });
    expect(JSON.stringify(result)).not.toMatch(/line_?rank/i);
  });

  test('without serviceLines: no ranking read and today\'s offers (first claim by score, every technician)', async () => {
    const result = await build(shared());
    expect(lineTech.lineOfferRanking).not.toHaveBeenCalled();
    expect(offers(result)).toEqual(['09:00:tech-gap', '10:00:tech-other', '11:00:tech-gap']);
  });

  test('an unmapped line or a gate that is not live (ranking null): identical to the no-serviceLines build', async () => {
    const today = stripSig(await build(shared()));
    lineTech.lineOfferRanking.mockResolvedValue(null);
    expect(stripSig(await build(shared(), { serviceLines: ['general'] }))).toEqual(today);
  });

  test('an unreadable map is logged and offers what today offers', async () => {
    const today = stripSig(await build(shared()));
    lineTech.lineOfferRanking.mockRejectedValue(new Error('db down'));
    expect(stripSig(await build(shared(), { serviceLines: ['general'] }))).toEqual(today);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('line map offer ranking unavailable: db down'));
  });

  test('an empty serviceLines list reads nothing', async () => {
    await build(shared(), { serviceLines: [] });
    expect(lineTech.lineOfferRanking).not.toHaveBeenCalled();
  });

  test('a gap-only day is still offered (the gap technician covers the home technician\'s days off)', async () => {
    const result = await build([slotOf('tech-gap', '10:00'), slotOf('tech-other', '10:00', { score: 1 })], { serviceLines: ['general'] });
    expect(offers(result)).toEqual(['10:00:tech-gap']);
  });

  describe('re-service profile (displacement rule)', () => {
    const GATE = 'GATE_RESERVICE_RANK_AFTER_NEW';
    const withGate = async (fn) => {
      const previous = process.env[GATE];
      process.env[GATE] = 'true';
      try { return await fn(); } finally { if (previous === undefined) delete process.env[GATE]; else process.env[GATE] = previous; }
    };
    // The gap technician has a stop that day (a packed day), the home technician has none: the
    // profile would displace the home technician's empty-day slot at 10:00.
    const slots = () => [slotOf('tech-home', '10:00', { score: 5 }), slotOf('tech-gap', '10:00', { score: 5, stops_that_day: 2 })];
    const anchor = { technician_id: 'tech-gap', customer_id: 'cust-x', date: D, rawStartMin: 480, rawEndMin: 600, expectedEndMin: 600, lat: 27.4, lng: -82.4, hold: false };

    test('without the line rule the packed gap day displaces the empty home day (the control)', async () => {
      loadPackingAnchors.mockResolvedValue([anchor]);
      const result = await withGate(() => build(slots(), { rankProfile: 'reservice' }));
      expect(offers(result)).toEqual(['10:00:tech-gap']);
    });

    test('with the line rule the gap technician cannot displace the home technician', async () => {
      loadPackingAnchors.mockResolvedValue([anchor]);
      const result = await withGate(() => build(slots(), { rankProfile: 'reservice', serviceLines: ['general'] }));
      expect(offers(result)).toEqual(['10:00:tech-home']);
    });
  });
});

describe('funnelServiceLines / buildFunnelAvailability', () => {
  test('a funnel key maps to its unique capability lines; a composite key to both', () => {
    expect(funnelServiceLines('pest_control')).toEqual(['general']);
    expect(funnelServiceLines('tree_shrub')).toEqual(['lawn']);
    expect(funnelServiceLines('lawn_care+tree_shrub')).toEqual(['lawn']);
    expect(funnelServiceLines('pest_control+lawn_care')).toEqual(['general', 'lawn']);
    expect(funnelServiceLines('bora_care')).toEqual(['termite']);
  });

  test('not live, no funnel key or an unknown key: no lines', () => {
    expect(funnelServiceLines('')).toBeNull();
    expect(funnelServiceLines('window_cleaning')).toBeNull();
    lineTech.lineMapLive.mockReturnValue(false);
    expect(funnelServiceLines('pest_control')).toBeNull();
  });

  test('buildFunnelAvailability names the funnel service\'s lines while live, and nothing otherwise', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [slotOf('tech-home', '10:00')], total_feasible: 1 });
    const args = { lat: 27.4, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: NOW, serviceKey: 'pest_control' };
    await buildFunnelAvailability(args);
    expect(lineTech.lineOfferRanking).toHaveBeenCalledWith(db, { lines: ['general'] });
    lineTech.lineOfferRanking.mockClear();
    lineTech.lineMapLive.mockReturnValue(false);
    await buildFunnelAvailability(args);
    expect(lineTech.lineOfferRanking).not.toHaveBeenCalled();
  });
});
