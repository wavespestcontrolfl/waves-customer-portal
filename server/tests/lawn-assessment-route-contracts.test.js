const lawnHealthRouter = require('../routes/lawn-health');
const adminLawnAssessmentRouter = require('../routes/admin-lawn-assessment');

describe('lawn assessment route contracts', () => {
  test('normalizes LawnIntel benchmark arrays to the customer portal contract', () => {
    const result = lawnHealthRouter._test.normalizeNeighborBenchmark([
      {
        segment: 'Bradenton',
        segmentType: 'city',
        yourScore: 82,
        avgScore: 74.4,
        percentile: 'top 25%',
        customerCount: 12,
        avgImprovement: 6.2,
      },
    ]);

    expect(result).toMatchObject({
      customerScore: 82,
      neighborhoodAvg: 74.4,
      percentile: 'top 25%',
      customerCount: 12,
      avgImprovement: 6.2,
      segmentName: 'Bradenton',
      segmentType: 'city',
    });
  });

  test('preserves analytics benchmark objects that already match the portal contract', () => {
    const result = lawnHealthRouter._test.normalizeNeighborBenchmark({
      customerScore: 78,
      neighborhoodAvg: 71,
      percentile: 'top 50%',
      customerCount: 8,
      segmentName: '34209 St. Augustine',
    });

    expect(result).toMatchObject({
      customerScore: 78,
      neighborhoodAvg: 71,
      percentile: 'top 50%',
      customerCount: 8,
      segmentName: '34209 St. Augustine',
    });
  });

  test('drops incomplete benchmark payloads instead of sending unusable portal data', () => {
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark([])).toBeNull();
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark({ percentile: 'top 25%' })).toBeNull();
    expect(lawnHealthRouter._test.normalizeNeighborBenchmark(null)).toBeNull();
  });

  test('customer photo lookups require confirmed assessments', () => {
    expect(lawnHealthRouter._test.photoAssessmentLookupCriteria('cust-1', 'assessment-1')).toEqual({
      id: 'assessment-1',
      customer_id: 'cust-1',
      confirmed_by_tech: true,
    });
  });

  test('accepts the follow_up_needed stress flag', () => {
    const { errors, normalized } = adminLawnAssessmentRouter._test.normalizeStressFlags({ follow_up_needed: true });
    expect(errors).toEqual([]);
    expect(normalized).toEqual({ follow_up_needed: true });
  });

  test('still rejects unrecognized stress flags', () => {
    const { errors } = adminLawnAssessmentRouter._test.normalizeStressFlags({ not_a_real_flag: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('failed-quality photos stay auditable but are hidden from customer surfaces', () => {
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: false })).toBe(false);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: true })).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({})).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck(null)).toBe(true);
  });

  test('service assessment lookup prefers the latest captured row', () => {
    const calls = [];
    const query = {
      orderBy: jest.fn((column, direction) => {
        calls.push([column, direction]);
        return query;
      }),
    };

    expect(adminLawnAssessmentRouter._test.applyServiceAssessmentOrder(query)).toBe(query);
    expect(calls).toEqual([
      ['created_at', 'desc'],
      ['updated_at', 'desc'],
    ]);
  });
});
