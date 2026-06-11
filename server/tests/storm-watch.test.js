jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getHourlyRainOutlook: jest.fn().mockResolvedValue(null),
}));

const db = require('../models/db');
const { getHourlyRainOutlook } = require('../services/weather-forecast');
const StormWatch = require('../services/storm-watch');

// 2026-06-11T16:00:00Z = 12:00 PM ET — mid-service-day.
const NOON_ET = new Date('2026-06-11T16:00:00Z');
// 2026-06-12T03:00:00Z = 11:00 PM ET Jun 11 — outside service hours.
const NIGHT_ET = new Date('2026-06-12T03:00:00Z');

function stop(overrides = {}) {
  return {
    id: 'svc-1',
    technician_id: 'tech-1',
    customer_id: 'cust-1',
    service_type: 'Quarterly Pest Control',
    status: 'confirmed',
    window_start: '13:30',
    window_end: '15:30',
    customer_latitude: 27.1,
    customer_longitude: -82.45,
    customer_city: 'Venice',
    ...overrides,
  };
}

function hourlyAt(chance, when = NOON_ET) {
  return [{ startTime: new Date(when.getTime() + 30 * 60 * 1000).toISOString(), rainChance: chance, shortForecast: 'Thunderstorms' }];
}

// db(table) dispatcher: scheduled_services list query (thenable select),
// tech_notifications dedupe lookup + insert. `alertedTechIds` simulates
// which technicians already received an alert today — the dedupe lookup
// resolves a row only when the queried technician_id is in the set.
function wireDb({ stops = [], alertedTechIds = [] } = {}) {
  const notifInsert = jest.fn().mockResolvedValue();
  const dedupeWhere = jest.fn();
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') {
      const builder = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue(stops),
      };
      return builder;
    }
    if (table === 'tech_notifications') {
      let queriedTechId = null;
      const builder = {
        where: jest.fn((args) => {
          dedupeWhere(args);
          if (args && typeof args === 'object') queriedTechId = args.technician_id;
          return builder;
        }),
        whereRaw: jest.fn().mockReturnThis(),
        first: jest.fn(async () => (alertedTechIds.includes(queriedTechId) ? { id: 'n-1' } : undefined)),
        insert: notifInsert,
      };
      return builder;
    }
    throw new Error(`Unexpected db('${table}') call`);
  });
  return { notifInsert, dedupeWhere };
}

describe('storm-watch sweep', () => {
  beforeEach(() => jest.clearAllMocks());

  test('outside ET service hours the sweep is a no-op', async () => {
    const { notifInsert } = wireDb({ stops: [stop()] });

    const result = await StormWatch.sweep(NIGHT_ET);

    expect(result).toEqual({ skipped: true, reason: 'outside_service_hours' });
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    expect(notifInsert).not.toHaveBeenCalled();
  });

  test('probes the CUSTOMER coordinates and alerts when the threshold is crossed', async () => {
    const { notifInsert } = wireDb({ stops: [stop()] });
    getHourlyRainOutlook.mockResolvedValue(hourlyAt(70));

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 1 });
    // Customer lat/lng — never a tech or office location.
    expect(getHourlyRainOutlook).toHaveBeenCalledWith(27.1, -82.45);

    const row = notifInsert.mock.calls[0][0];
    expect(row.technician_id).toBe('tech-1');
    expect(row.type).toBe('storm_watch_alert');
    expect(row.message).toContain('70% storms');
    expect(row.message).toContain('1:30 PM');
    expect(row.message).toContain('Venice');
    const payload = JSON.parse(row.payload);
    expect(payload).toMatchObject({ job_id: 'svc-1', rain_chance: 70, city: 'Venice' });
  });

  test('below the threshold no alert fires', async () => {
    const { notifInsert } = wireDb({ stops: [stop()] });
    getHourlyRainOutlook.mockResolvedValue(hourlyAt(40));

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 0 });
    expect(notifInsert).not.toHaveBeenCalled();
  });

  test('one alert per job per day per tech — existing notification suppresses', async () => {
    const { notifInsert, dedupeWhere } = wireDb({ stops: [stop()], alertedTechIds: ['tech-1'] });
    getHourlyRainOutlook.mockResolvedValue(hourlyAt(90));

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 0 });
    expect(notifInsert).not.toHaveBeenCalled();
    // Dedupe is scoped to the CURRENT technician.
    expect(dedupeWhere).toHaveBeenCalledWith(expect.objectContaining({ technician_id: 'tech-1' }));
  });

  test('a reassigned job still alerts the new tech even though the old tech was already pinged', async () => {
    // Job moved tech-1 → tech-2 after tech-1 got this morning's alert.
    const { notifInsert } = wireDb({
      stops: [stop({ technician_id: 'tech-2' })],
      alertedTechIds: ['tech-1'],
    });
    getHourlyRainOutlook.mockResolvedValue(hourlyAt(80));

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 1 });
    expect(notifInsert).toHaveBeenCalledWith(expect.objectContaining({ technician_id: 'tech-2' }));
  });

  test('ungeocoded customers are skipped without probing NWS', async () => {
    const { notifInsert } = wireDb({
      stops: [stop({ customer_latitude: null, customer_longitude: null })],
    });

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 0 });
    expect(getHourlyRainOutlook).not.toHaveBeenCalled();
    expect(notifInsert).not.toHaveBeenCalled();
  });

  test('stops outside the look-ahead window are filtered out', async () => {
    // 17:00 start is 5h past noon — beyond the 150-minute look-ahead.
    const { notifInsert } = wireDb({ stops: [stop({ window_start: '17:00', window_end: '19:00' })] });
    getHourlyRainOutlook.mockResolvedValue(hourlyAt(90));

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 0, alerted: 0 });
    expect(notifInsert).not.toHaveBeenCalled();
  });

  test('NWS unavailable → fail-open, no alert, no crash', async () => {
    const { notifInsert } = wireDb({ stops: [stop()] });
    getHourlyRainOutlook.mockResolvedValue(null);

    const result = await StormWatch.sweep(NOON_ET);

    expect(result).toEqual({ checked: 1, alerted: 0 });
    expect(notifInsert).not.toHaveBeenCalled();
  });

  test('peakRainChance only counts hours inside the 2h horizon', () => {
    const now = NOON_ET;
    const hours = [
      { startTime: new Date(now.getTime() - 2 * 3600_000).toISOString(), rainChance: 95 }, // past
      { startTime: new Date(now.getTime() + 30 * 60_000).toISOString(), rainChance: 55 },  // inside
      { startTime: new Date(now.getTime() + 5 * 3600_000).toISOString(), rainChance: 99 }, // beyond
    ];
    expect(StormWatch._test.peakRainChance(hours, now)).toBe(55);
    expect(StormWatch._test.peakRainChance(null, now)).toBeNull();
  });
});
