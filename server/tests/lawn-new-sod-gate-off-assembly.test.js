/**
 * GATE_LAWN_NEW_SOD_MODE off must change NOTHING (the PR is byte-identical with the gate off): through the REAL
 * response assembler (routes/reports-public.js buildServiceReportV1ResponseData) and the REAL data builder, a
 * lawn visit whose property has a sod date gives exactly the output of the same visit with no sod date. Also an
 * INACTIVE visit (gate on, but the visit is outside the window) is untouched by the boundary step, and an
 * active one comes out new-sod through the same two real functions. Only the db module is replaced (by the
 * table-keyed fixture knex) and the dynamic-context loader is stubbed. Synthetic data only.
 */
const mockState = { knex: null };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockState.knex(table));
  db.fn = { now: jest.fn(() => 'NOW') };
  db.raw = (sql) => (mockState.knex ? mockState.knex.raw(sql) : sql);
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  return db;
});
jest.mock('../config', () => ({ s3: { bucket: 'test-bucket', region: 'us-east-1' }, jwt: { secret: 'test-jwt-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn().mockImplementation(() => ({})), GetObjectCommand: jest.fn() }));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn().mockResolvedValue(null),
  loadScoreForServiceRecord: jest.fn().mockResolvedValue(null),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({
    reentry: { customerSummary: 'Treated areas are ready for normal use.', irrigationReadyAt: '2026-10-03T19:00:00.000Z', petAdvisory: 'Keep pets off treated zones until dry.' },
  }),
}));

const reportsRouter = require('../routes/reports-public');
const { makeKnex, serviceWith, withIdentity, SOD_PREFS, HOLD } = require('./helpers/new-sod-report-fixtures');

const GATE = 'GATE_LAWN_NEW_SOD_MODE';

describe('the real response assembler with a sod date set', () => {
  let saved;
  beforeEach(() => { saved = process.env[GATE]; delete process.env[GATE]; });
  afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

  const assemble = async (sod, mode = 'live') => {
    mockState.knex = makeKnex(withIdentity(SOD_PREFS(sod)));
    const service = { ...serviceWith(HOLD), report_template_version: 'service_report_v1', service_line: 'lawn' };
    const out = await reportsRouter.buildServiceReportV1ResponseData(service, 'token-w1', { mode });
    return JSON.parse(JSON.stringify(out));
  };

  it.each(['live', 'pdf', 'static'])('gate off, mode %s: the output with a sod date is deep-equal to the output without one', async (mode) => {
    const withDate = await assemble('2026-09-25', mode);
    const without = await assemble(null, mode);
    expect(withDate).toEqual(without);
    expect(withDate.reportV2.banner?.state).not.toBe('new_sod');
    expect(JSON.stringify(withDate)).not.toMatch(/new_sod|New sod/i);
  });

  it('gate on but the visit is outside the window: deep-equal to the output without a date (the boundary step is untouched)', async () => {
    process.env[GATE] = 'true';
    const outside = await assemble('2026-08-01');
    process.env[GATE] = 'true';
    const without = await assemble(null);
    expect(outside).toEqual(without);
  });

  it('gate on and inside the window: the same two real functions give the new-sod report, clean', async () => {
    process.env[GATE] = 'true';
    const out = await assemble('2026-09-25');
    expect(out.reportV2.banner.state).toBe('new_sod');
    expect(out.mowingHeight).toBeNull();
    expect(out.dynamicContext.reentry.irrigationReadyAt).toBeNull();
    expect(out.dynamicContext.reentry.petAdvisory).toMatch(/pets/i);
  });
});
