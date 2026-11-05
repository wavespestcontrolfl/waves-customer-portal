// A technician's own week for the "My hours" card on Today (owner 2026-11-04, D5 A):
// scoped to the signed-in technician, hours only, and an admin's weekly read is unchanged.
const mockGetEntries = jest.fn();
const mockGetDailySummaries = jest.fn();
const mockGetWeeklySummaries = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({
  getEntries: (...args) => mockGetEntries(...args),
  getDailySummaries: (...args) => mockGetDailySummaries(...args),
  getWeeklySummaries: (...args) => mockGetWeeklySummaries(...args),
}));
jest.mock('../services/timesheet-approval', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const router = require('../routes/tech-timetracking');
const { etWeekStart } = require('../utils/datetime-et');

function handler(routePath) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function responseDouble() {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

const DAY_ROW = {
  technician_id: 'tech-1', tech_name: 'Pat Example', work_date: new Date('2026-11-02T00:00:00Z'),
  total_shift_minutes: '480.00', total_job_minutes: '300.00', total_drive_minutes: '60.00',
  total_break_minutes: '30.00', unpaid_meal_minutes: '30.00', job_count: 5,
  first_clock_in: '2026-11-02T12:00:00Z', last_clock_out: '2026-11-02T20:30:00Z',
  revenue_generated: '999.00', rpmh_actual: '77.00', utilization_pct: '62.50', status: 'pending',
};
const ENTRY_ROW = {
  id: 'e-1', technician_id: 'tech-1', entry_type: 'job', status: 'completed',
  clock_in: '2026-11-02T14:00:00Z', clock_out: '2026-11-02T15:00:00Z', duration_minutes: '60.00',
  service_type: 'Quarterly Pest Control', clock_in_lat: '27.1', clock_in_lng: '-82.4',
  customer_first_name: 'Test', customer_last_name: 'Caller', tech_name: 'Pat Example', notes: 'private note',
};
const WEEK_ROW = {
  technician_id: 'tech-1', week_start: new Date('2026-11-02T00:00:00Z'), total_shift_minutes: '480.00',
  regular_minutes: '450.00', overtime_minutes: '0.00', days_worked: 1, job_count: 5,
  total_revenue: '999.00', avg_rpmh: '77.00', utilization_pct: '62.50', status: 'pending', tech_signed_at: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEntries.mockResolvedValue({ entries: [ENTRY_ROW], total: 1 });
  mockGetDailySummaries.mockResolvedValue([DAY_ROW]);
  mockGetWeeklySummaries.mockResolvedValue([WEEK_ROW]);
});

describe('GET /my-hours', () => {
  test('a technician reads only its own rows, whatever the query says', async () => {
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: { weekStart: '2026-11-04', technicianId: 'tech-2' } }, res, jest.fn());
    expect(mockGetEntries).toHaveBeenCalledWith(expect.objectContaining({ technicianId: 'tech-1', startDate: '2026-11-02', endDate: '2026-11-08' }));
    expect(mockGetDailySummaries).toHaveBeenCalledWith({ technicianId: 'tech-1', startDate: '2026-11-02', endDate: '2026-11-08' });
    expect(mockGetWeeklySummaries).toHaveBeenCalledWith({ technicianId: 'tech-1', startDate: '2026-11-02', endDate: '2026-11-02' });
    const body = res.json.mock.calls[0][0];
    expect(body.weekStart).toBe('2026-11-02');
    expect(body.days).toEqual([expect.objectContaining({ date: '2026-11-02', shiftMinutes: 480, jobCount: 5, unpaidMealMinutes: 30 })]);
    expect(body.totals).toMatchObject({ shiftMinutes: 480, jobCount: 5 });
    expect(body.week).toMatchObject({ regularMinutes: 450, overtimeMinutes: 0, signed: false });
    expect(body.entries).toEqual([expect.objectContaining({ id: 'e-1', type: 'job', minutes: 60, serviceType: 'Quarterly Pest Control' })]);
  });

  test('a technician gets no revenue, pay, location, customer, note or coworker field', async () => {
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: {} }, res, jest.fn());
    const text = JSON.stringify(res.json.mock.calls[0][0]);
    for (const leak of ['999', 'revenue', 'rpmh', 'utilization', 'clock_in_lat', 'lat', 'Caller', 'private note', 'tech_name', 'Pat Example', 'rate', 'pay']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  test('a day that has entries but no summary row yet still shows, with its own minutes', async () => {
    mockGetDailySummaries.mockResolvedValue([]);
    mockGetEntries.mockResolvedValue({
      entries: [{ ...ENTRY_ROW, id: 'shift-1', entry_type: 'shift', status: 'active', clock_out: null, duration_minutes: null, service_type: null }, ENTRY_ROW],
      total: 2,
    });
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: { weekStart: '2026-11-02' } }, res, jest.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({ date: '2026-11-02', jobCount: 1, jobMinutes: 60, lastClockOut: null });
  });

  test('a future week is clamped to this week, and the older week links back', async () => {
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: { weekStart: '2099-01-05' } }, res, jest.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.weekStart).toBe(etWeekStart(new Date()));
    expect(body.nextWeekStart).toBeNull();
    expect(body.prevWeekStart < body.weekStart).toBe(true);
  });

  test('a malformed date is refused before any read', async () => {
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: { weekStart: '2026-13-45' } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetEntries).not.toHaveBeenCalled();
  });

  test('a voided entry is left out', async () => {
    mockGetEntries.mockResolvedValue({ entries: [ENTRY_ROW, { ...ENTRY_ROW, id: 'e-void', status: 'voided' }], total: 2 });
    const res = responseDouble();
    await handler('/my-hours')({ technicianId: 'tech-1', techRole: 'technician', query: { weekStart: '2026-11-02' } }, res, jest.fn());
    expect(res.json.mock.calls[0][0].entries.map((e) => e.id)).toEqual(['e-1']);
  });
});

describe('GET /weekly', () => {
  test('a technician gets its hours without revenue, revenue per hour or utilization', async () => {
    const res = responseDouble();
    await handler('/weekly')({ technicianId: 'tech-1', techRole: 'technician', query: {} }, res, jest.fn());
    const [row] = res.json.mock.calls[0][0];
    expect(row).toMatchObject({ regular_minutes: '450.00', total_shift_minutes: '480.00' });
    expect(row).not.toHaveProperty('total_revenue');
    expect(row).not.toHaveProperty('avg_rpmh');
    expect(row).not.toHaveProperty('utilization_pct');
  });

  test('an admin still gets the full weekly row', async () => {
    const res = responseDouble();
    await handler('/weekly')({ technicianId: 'admin-1', techRole: 'admin', query: {} }, res, jest.fn());
    expect(res.json.mock.calls[0][0][0]).toMatchObject({ total_revenue: '999.00', avg_rpmh: '77.00' });
  });
});
