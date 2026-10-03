/**
 * New-sod mode through the REAL response assembly (routes/reports-public.js buildServiceReportV1ResponseData),
 * which serves the web report (/data), the direct PDF route and Ask Waves. Only the data builder and the
 * dynamic-context loader are stubbed; the strips, the reconciliation pass and enforceNewSodAtBoundary are the
 * real functions. The builder hands over its (already enforced) output with the worst case put back: an
 * unscrubbed recommendations.nextVisitFocus the reconciliation would rebuild the follow-up from, and a re-entry
 * context carrying the label irrigation hold (added after the builder). Synthetic data only.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
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
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/service-report/report-data', () => ({
  ...jest.requireActual('../services/service-report/report-data'),
  buildReportV1Data: jest.fn(),
}));
const mockDynamicContext = jest.fn();
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: (...args) => mockDynamicContext(...args),
}));

const { buildReportV1Data } = require('../services/service-report/report-data');
const reportsRouter = require('../routes/reports-public');
const { enforceNewSodPayload } = require('../services/service-report/lawn-new-sod-payload');
const { maximalLawnPayload } = require('./helpers/new-sod-maximal-payload');

const FORBIDDEN = /extra run|no extra|skip|hold off on watering|ease back|easing back|too much water|mower|sprinkler coverage|Hold irrigation|inch of rain/i;

const service = {
  id: 'svc-lawn-1', customer_id: 'cust-1', service_line: 'lawn', service_type: 'Lawn Care Treatment Program',
  report_template_version: 'service_report_v1', service_date: '2026-10-02', zip: '34201',
};

function stubBuilder() {
  const data = enforceNewSodPayload(maximalLawnPayload());
  data.serviceLine = 'lawn';
  data.summary = 'Water the front strip every morning this week.';
  data.lawnAssessment.recommendations = {
    nextVisitFocus: 'Recheck moisture and sprinkler coverage.', customerTip: 'Water the thin areas by hand.',
    recommendations: [{ action: 'Raise the mower one setting', priority: 1 }],
  };
  buildReportV1Data.mockResolvedValue(data);
  mockDynamicContext.mockResolvedValue({
    reentry: { customerSummary: 'Treated areas are ready for normal use.', irrigationReadyAt: '2026-10-03T19:00:00.000Z', petAdvisory: 'Keep pets off treated zones until dry.' },
  });
}

describe('buildServiceReportV1ResponseData: the new-sod boundary step runs AFTER the reconciliation pass', () => {
  beforeEach(() => { jest.clearAllMocks(); stubBuilder(); });

  it.each([['web (/data, live)', 'live'], ['direct PDF route', 'pdf'], ['static / print', 'static']])('%s: clean payload, banner intact, rebuilt follow-up scrubbed', async (_label, mode) => {
    const out = await reportsRouter.buildServiceReportV1ResponseData(service, 'tok-1', { mode });
    expect(out.reportV2.banner.state).toBe('new_sod');
    // The reconciliation pass REBUILT the follow-up (its headline is the pass's own) and the boundary step ran after it.
    expect(out.reportV2.followUp.headline).toBe('Follow-up already planned');
    expect(out.reportV2.followUp.reason).toBeNull();
    expect(out.reportV2.todaysResult).toBeNull();
    expect(out.lawnAssessment.recommendations.nextVisitFocus).toBeNull();
    expect(out.mowingHeight).toBeNull();
    expect(out.dynamicContext.reentry.irrigationReadyAt).toBeNull();
    expect(out.dynamicContext.reentry.petAdvisory).toMatch(/pets/i);
    // The whole payload, minus the record and the customer's own words, says none of the forbidden things.
    const printed = JSON.stringify({ ...out, applications: null, reportV2: { ...out.reportV2, snapshot: { ...out.reportV2.snapshot, treatmentSummary: null } } });
    expect(printed.match(FORBIDDEN)).toBeNull();
  });

  it('the Ask Waves context (same assembler) gets the same payload', async () => {
    const out = await reportsRouter.buildServiceReportV1ResponseData(service, 'tok-1', { mode: 'live' });
    expect(JSON.stringify(out.lawnAssessment.recommendations)).not.toMatch(/moisture|sprinkler|mower|water/i);
  });

  it('a normal (not new-sod) lawn visit is reconciled as before and keeps its watering content', async () => {
    const normal = maximalLawnPayload();
    normal.serviceLine = 'lawn';
    normal.lawnAssessment.recommendations = { nextVisitFocus: 'Recheck moisture and sprinkler coverage.' };
    buildReportV1Data.mockResolvedValue(normal);
    const out = await reportsRouter.buildServiceReportV1ResponseData(service, 'tok-1', { mode: 'live' });
    expect(out.reportV2.banner.state).toBe('water_in');
    expect(out.reportV2.followUp.reason).toMatch(/moisture and sprinkler coverage/i);
    expect(out.mowingHeight).not.toBeNull();
  });
});
