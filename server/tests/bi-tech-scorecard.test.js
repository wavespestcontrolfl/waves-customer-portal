/**
 * GATE_BI_TECH_SCORECARD: the weekly scorecard builder (services/bi-tech-scorecard.js)
 * over mocked sources — the day scorecard, callback credit, review asks, the dashboard
 * leaderboard and the cost cards. Pins the week window, how each figure is derived, and
 * that an unknown value is null with a reason, never 0.
 */
const mockDayScorecard = jest.fn();
const mockCallbacks = jest.fn();
const mockKpis = jest.fn();
const mockCard = jest.fn();
const mockRates = jest.fn();

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/scheduling/day-scorecard', () => ({ getDayScorecard: (...a) => mockDayScorecard(...a) }));
jest.mock('../services/callback-credit', () => ({ callbackCreditByTechnician: (...a) => mockCallbacks(...a) }));
jest.mock('../routes/admin-dashboard', () => ({ computeCoreKpis: (...a) => mockKpis(...a) }));
jest.mock('../services/tech-cost-rates', () => ({
  cardInEffect: (...a) => mockCard(...a),
  loadVisitRates: (...a) => mockRates(...a),
}));

const { buildTechScorecard } = require('../services/bi-tech-scorecard');

// Monday 2026-11-02 05:00 ET: the last full week is Mon 2026-10-26 .. Sun 2026-11-01.
const NOW = new Date('2026-11-02T10:00:00Z');
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

let askRows;
let askError;
function fakeConn() {
  const chain = {};
  for (const m of ['whereNotNull', 'whereBetween', 'where', 'whereRaw', 'groupBy', 'select']) chain[m] = () => chain;
  chain.then = (resolve, reject) => (askError ? Promise.reject(askError) : Promise.resolve(askRows)).then(resolve, reject);
  const conn = jest.fn(() => chain);
  conn.raw = (sql) => sql;
  return conn;
}

const actual = (o) => ({
  stops: o.stops, physicalStops: o.physical ?? o.stops, onSiteMinutes: o.onSite ?? null,
  onSiteCoverage: { covered: o.covered ?? 0, total: o.stops, unbaselined: o.unbaselined ?? 0 },
  driveMinutes: o.drive ?? null,
});
const dayRow = (technicianId, technician, a) => ({ technicianId, technician, actual: a });

function week() {
  return {
    days: [
      { date: '2026-10-26', byTech: [
        dayRow(A, 'Ada', actual({ stops: 5, onSite: 125, covered: 5, drive: 30 })),
        dayRow(B, 'Ben', actual({ stops: 2 })),
        dayRow(null, 'Unassigned', actual({ stops: 3, onSite: 60, covered: 3 })),
      ] },
      { date: '2026-10-27', byTech: [dayRow(A, 'Ada', actual({ stops: 6, onSite: 150, covered: 6, drive: 36 })), dayRow(B, 'Ben', null)] },
      { date: '2026-10-28', byTech: [dayRow(A, 'Ada', actual({ stops: 4, onSite: 100, covered: 4 }))] },
      { date: '2026-11-01', byTech: [dayRow(A, 'Ada', actual({ stops: 0 }))] },
    ],
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.GATE_TECH_COST_RATES;
  askRows = [{ technician_id: A, asks: '6' }];
  askError = null;
  mockDayScorecard.mockResolvedValue(week());
  mockCallbacks.mockResolvedValue(new Map([[A, 1]]));
  mockKpis.mockResolvedValue({ leaderboard: [{ techId: A, revenue: 1500, jobs: 15 }] });
  mockCard.mockResolvedValue({ paid_hours_per_day: '8.00' });
  mockRates.mockResolvedValue({ laborPerWorkedHourCents: 3500 });
});
afterAll(() => { delete process.env.GATE_TECH_COST_RATES; });

describe('buildTechScorecard', () => {
  test('asks every source for the last full week, Monday to Sunday ET', async () => {
    const result = await buildTechScorecard(fakeConn(), NOW);
    expect(result.week).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(mockDayScorecard).toHaveBeenCalledWith({ date_from: '2026-10-26', date_to: '2026-11-01' }, expect.anything(), NOW);
    expect(mockCallbacks).toHaveBeenCalledWith(expect.anything(), { start: '2026-10-26', endDate: '2026-11-01' });
    expect(mockKpis).toHaveBeenCalledWith('last_7', { from: '2026-10-26', to: '2026-11-01' });
  });

  test('one row per technician with a completed visit; each figure from its source', async () => {
    process.env.GATE_TECH_COST_RATES = 'true';
    const { rows } = await buildTechScorecard(fakeConn(), NOW);
    expect(rows.map((r) => r.technician)).toEqual(['Ada', 'Ben']); // not Unassigned, not a zero-stop day
    const [ada] = rows;
    expect(ada).toMatchObject({
      technicianId: A, daysWorked: 3, completedStops: 15, stopsPerDay: 5,
      onSiteMinutesPerStop: 25, onSiteTargetMinutes: 25, onSiteCoverage: { recorded: 15, completed: 15 },
      // 66 timed drive minutes over the 11 stops of the two days that have them
      driveMinutesPerStop: 6, driveCoverage: { days: 2, of: 3 },
      callbacks: 1, reviewAsks: 6, revenuePerDay: 500, costPerDay: 280, lowSample: false, reasons: {},
    });
    expect(mockRates).toHaveBeenCalledWith(expect.anything(), A, '2026-10-26');
  });

  test('a value with no source is null with a reason, never 0', async () => {
    const { rows } = await buildTechScorecard(fakeConn(), NOW);
    const ben = rows.find((r) => r.technician === 'Ben');
    expect(ben).toMatchObject({
      daysWorked: 1, completedStops: 2, stopsPerDay: 2, lowSample: true,
      onSiteMinutesPerStop: null, driveMinutesPerStop: null, revenuePerDay: null, costPerDay: null,
      // the queries ran and found none: a real zero
      callbacks: 0, reviewAsks: 0,
    });
    expect(ben.reasons).toEqual({
      onSiteMinutesPerStop: 'no recorded on-site minutes',
      driveMinutesPerStop: 'no timed Bouncie trips',
      revenuePerDay: 'no revenue on the week\'s service records',
      costPerDay: 'no cost card',
    });
  });

  test('cost stays null with the cost cards gate off, and when any worked day lacks a card', async () => {
    let { rows } = await buildTechScorecard(fakeConn(), NOW);
    expect(rows[0].costPerDay).toBeNull();
    expect(mockCard).not.toHaveBeenCalled();

    process.env.GATE_TECH_COST_RATES = 'true';
    mockCard.mockImplementation(async (_c, _t, _k, _id, date) => (date === '2026-10-28' ? null : { paid_hours_per_day: '8' }));
    ({ rows } = await buildTechScorecard(fakeConn(), NOW));
    expect(rows[0].costPerDay).toBeNull();
    expect(rows[0].reasons.costPerDay).toBe('no cost card');
  });

  test('a failed source nulls only its own figures, each with a reason', async () => {
    mockCallbacks.mockRejectedValue(new Error('boom'));
    askError = new Error('boom');
    mockKpis.mockResolvedValue({ leaderboard: [] }); // the dashboard's own failure value
    const { rows } = await buildTechScorecard(fakeConn(), NOW);
    expect(rows[0]).toMatchObject({ callbacks: null, reviewAsks: null, revenuePerDay: null, stopsPerDay: 5, onSiteMinutesPerStop: 25 });
    expect(rows[0].reasons).toMatchObject({
      callbacks: 'callback query failed', reviewAsks: 'review ask query failed', revenuePerDay: 'revenue unavailable',
    });
  });

  test('no day scorecard means no rows and says why', async () => {
    mockDayScorecard.mockResolvedValue({ error: 'Use a valid date range of at most 31 days.' });
    expect(await buildTechScorecard(fakeConn(), NOW)).toMatchObject({ rows: [], unavailable: 'day scorecard unavailable' });
    mockDayScorecard.mockRejectedValue(new Error('boom'));
    expect(await buildTechScorecard(fakeConn(), NOW)).toMatchObject({ rows: [], unavailable: 'day scorecard unavailable' });
  });

  test('lowSample is under 5 stops, like the KPI rows', async () => {
    mockDayScorecard.mockResolvedValue({ days: [
      { date: '2026-10-26', byTech: [dayRow(A, 'Ada', actual({ stops: 4 }))] },
      { date: '2026-10-27', byTech: [dayRow(B, 'Ben', actual({ stops: 5 }))] },
    ] });
    const { rows } = await buildTechScorecard(fakeConn(), NOW);
    expect(rows.map((r) => [r.technician, r.lowSample])).toEqual([['Ada', true], ['Ben', false]]);
  });

  test('visits added to the route after the saved plan count as completed, so partial timing shows as partial', async () => {
    mockDayScorecard.mockResolvedValue({ days: [
      { date: '2026-10-26', byTech: [dayRow(A, 'Ada', actual({ stops: 5, onSite: 125, covered: 5, unbaselined: 3 }))] },
    ] });
    expect((await buildTechScorecard(fakeConn(), NOW)).rows[0].onSiteCoverage).toEqual({ recorded: 5, completed: 8 });
  });

  test('a visit group with no proven physical stop count falls back to completed visits', async () => {
    mockDayScorecard.mockResolvedValue({ days: [
      { date: '2026-10-26', byTech: [dayRow(A, 'Ada', { ...actual({ stops: 3 }), physicalStops: null })] },
    ] });
    expect((await buildTechScorecard(fakeConn(), NOW)).rows[0].completedStops).toBe(3);
  });
});
