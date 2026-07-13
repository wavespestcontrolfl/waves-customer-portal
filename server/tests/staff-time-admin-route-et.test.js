const fs = require('fs');
const path = require('path');

const mockStartBreak = jest.fn();
const mockGetPendingWeeks = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return db;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/time-tracking', () => ({
  startBreak: (...args) => mockStartBreak(...args),
}));
jest.mock('../services/timesheet-approval', () => ({
  getPendingWeeks: (...args) => mockGetPendingWeeks(...args),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config', () => ({
  s3: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
    region: 'us-east-1',
    bucket: 'test',
  },
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const adminTimeTrackingRouter = require('../routes/admin-timetracking');
const adminTimesheetApprovalRouter = require('../routes/admin-timesheet-approval');
const techTimeTrackingRouter = require('../routes/tech-timetracking');

function routeHandler(router, method, routePath) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods[method]
  ));
  if (!layer) throw new Error(`Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseDouble() {
  const res = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('Staff admin ET route boundaries', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('builds analytics defaults from the Eastern work date after 8 PM', () => {
    const now = new Date('2026-07-14T00:30:00.000Z'); // Jul 13, 8:30 PM EDT

    expect(adminTimeTrackingRouter._test.staffAnalyticsDateRange({}, now)).toEqual({
      start: '2026-06-13',
      end: '2026-07-13',
    });
    expect(adminTimeTrackingRouter._test.staffAnalyticsDateRange({
      startDate: '2026-07-01',
      endDate: '2026-07-12',
    }, now)).toEqual({
      start: '2026-07-01',
      end: '2026-07-12',
    });
  });

  test('filters timestamped entries by the shared Eastern work-date expression', () => {
    const query = { whereRaw: jest.fn() };
    query.whereRaw.mockReturnValue(query);

    const result = adminTimeTrackingRouter._test.applyStaffEntryWorkDateRange(
      query,
      '2026-07-01',
      '2026-07-13',
    );

    expect(result).toBe(query);
    expect(query.whereRaw).toHaveBeenCalledWith(
      "(time_entries.clock_in::timestamptz AT TIME ZONE 'America/New_York')::date BETWEEN ?::date AND ?::date",
      ['2026-07-01', '2026-07-13'],
    );

    const source = fs.readFileSync(
      path.join(__dirname, '../routes/admin-timetracking.js'),
      'utf8',
    );
    expect(source).not.toMatch(/\.where\('time_entries\.clock_in'/);
    expect(source.match(/applyStaffEntryWorkDateRange\(/g)).toHaveLength(3);
  });

  test('defaults pending approval to the prior ET week on Sunday evening', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-13T01:00:00.000Z')); // Jul 12, 9 PM EDT
    mockGetPendingWeeks.mockResolvedValue([]);
    const handler = routeHandler(adminTimesheetApprovalRouter, 'get', '/pending');
    const res = responseDouble();
    const next = jest.fn();

    await handler({ query: {} }, res, next);

    expect(mockGetPendingWeeks).toHaveBeenCalledWith('2026-06-29');
    expect(res.json).toHaveBeenCalledWith({ weekStart: '2026-06-29', techs: [] });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Staff timer conflict responses', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns 409 when a technician tries to start a duplicate break', async () => {
    mockStartBreak.mockRejectedValue(
      new Error('Already on break. End the current break first.'),
    );
    const handler = routeHandler(techTimeTrackingRouter, 'post', '/start-break');
    const res = responseDouble();
    const next = jest.fn();

    await handler({ technicianId: 'tech-1' }, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Already on break. End the current break first.',
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Staff approval route ownership', () => {
  afterEach(() => jest.clearAllMocks());

  test.each([
    ['put', '/daily/:id/approve'],
    ['put', '/daily/:id/reject'],
    ['put', '/daily/:id/reopen'],
    ['post', '/daily/bulk-approve'],
    ['get', '/payroll-export'],
  ])('retires legacy %s %s mutations in favor of weekly approval', async (method, pathName) => {
    const handler = routeHandler(adminTimeTrackingRouter, method, pathName);
    const res = responseDouble();

    await handler({}, res);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Legacy daily approval/export endpoints are retired. Use weekly approved snapshots.',
    });
  });
});
