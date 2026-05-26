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

  test('failed-quality photos stay auditable but are hidden from customer surfaces', () => {
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: false })).toBe(false);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({ passed: true })).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck({})).toBe(true);
    expect(adminLawnAssessmentRouter._test.customerVisibleForQualityCheck(null)).toBe(true);
  });

  test('recommendation customer visibility requires approval except low-risk education', () => {
    expect(adminLawnAssessmentRouter._test.canShowRecommendationToCustomer({
      type: 'tier_upgrade',
      approved_at: null,
      requires_human_approval: true,
    })).toBe(false);
    expect(adminLawnAssessmentRouter._test.canShowRecommendationToCustomer({
      type: 'tier_upgrade',
      approved_at: new Date().toISOString(),
      requires_human_approval: true,
    })).toBe(true);
    expect(adminLawnAssessmentRouter._test.canShowRecommendationToCustomer({
      type: 'customer_education',
      approved_at: null,
      requires_human_approval: false,
    })).toBe(true);
  });

  test('customer-facing snapshot and recommendation copy rejects internal or guarantee language', () => {
    expect(adminLawnAssessmentRouter._test.customerCopyViolation(
      'This lawn has callback risk and should be an upsell.',
    )).toMatch(/blocked wording/);
    expect(adminLawnAssessmentRouter._test.customerCopyViolation(
      'We guarantee this diagnosed fungus will recover.',
    )).toMatch(/blocked wording/);
    expect(adminLawnAssessmentRouter._test.customerCopyViolation(
      'WaveGuard Gold may be a better fit because it provides more proactive monitoring.',
    )).toBeNull();
  });

  test('snapshot and recommendation rows normalize json columns for admin review', () => {
    expect(adminLawnAssessmentRouter._test.normalizeSnapshotRow({
      id: 'snapshot-1',
      findings: '[{"key":"weed_pressure"}]',
      property_context: '{"grass_type":"st_augustine"}',
      treatment_context: '{}',
      weather_context: '{}',
      expected_window: '{"min_days":14}',
      next_watch_items: '["Monitor weed pressure"]',
      disclaimers: '[]',
    })).toMatchObject({
      findings: [{ key: 'weed_pressure' }],
      property_context: { grass_type: 'st_augustine' },
      expected_window: { min_days: 14 },
      next_watch_items: ['Monitor weed pressure'],
    });

    expect(adminLawnAssessmentRouter._test.normalizeRecommendationRow({
      id: 'card-1',
      trigger_signals: '[{"key":"confirmed_assessment"}]',
      recommended_action: '{"action_type":"upgrade_plan"}',
      guardrails: '{"admin_approval_required":true}',
      outcome: '{}',
    })).toMatchObject({
      trigger_signals: [{ key: 'confirmed_assessment' }],
      recommended_action: { action_type: 'upgrade_plan' },
      guardrails: { admin_approval_required: true },
    });
  });
});
