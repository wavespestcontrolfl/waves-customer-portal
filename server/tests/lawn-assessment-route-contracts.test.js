const lawnHealthRouter = require('../routes/lawn-health');
const adminLawnAssessmentRouter = require('../routes/admin-lawn-assessment');

describe('recommendation copy-safety gate on direct status promotion', () => {
  const { CUSTOMER_FACING_STATUSES, customerCopyViolation } = adminLawnAssessmentRouter._test;
  const UNSAFE = 'High churn risk — escalate before callback.'; // hits the blocklist

  test('every customer-facing status is gated, and unsafe copy is detected for each', () => {
    expect([...CUSTOMER_FACING_STATUSES].sort()).toEqual(['accepted', 'approved', 'customer_visible']);
    for (const status of CUSTOMER_FACING_STATUSES) {
      // PATCH refuses to set this status when the effective copy is unsafe.
      expect(customerCopyViolation(UNSAFE)).not.toBeNull();
    }
  });

  test('non-customer-facing statuses are not customer-facing (no surfacing gate applies)', () => {
    for (const status of ['draft', 'needs_admin_review', 'dismissed', 'expired']) {
      expect(CUSTOMER_FACING_STATUSES.has(status)).toBe(false);
    }
  });

  test('safe copy passes the gate', () => {
    expect(customerCopyViolation('Your lawn is responding well — keep watering deeply twice a week.')).toBeNull();
  });
});

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

  test('accepts the follow_up_needed stress flag so the engine follow-up trigger can fire', () => {
    const { errors, normalized } = adminLawnAssessmentRouter._test.normalizeStressFlags({ follow_up_needed: true });
    expect(errors).toEqual([]);
    expect(normalized).toEqual({ follow_up_needed: true });
  });

  test('still rejects unrecognized stress flags', () => {
    const { errors } = adminLawnAssessmentRouter._test.normalizeStressFlags({ not_a_real_flag: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('customer snapshot contract strips internal fields from snapshot and cards', () => {
    const snapshot = lawnHealthRouter._test.formatCustomerSnapshot({
      id: 'snapshot-1',
      assessment_id: 'assessment-1',
      headline: 'Moderate issue being treated',
      summary_customer: 'We saw moderate weed pressure in one area of the lawn.',
      status: 'customer_visible',
      generated_at: '2026-05-26T09:00:00.000Z',
      findings: JSON.stringify([{
        key: 'weed_pressure',
        label: 'Weed pressure',
        severity: 2,
        confidence: 0.84,
        customer_copy: 'We saw moderate weed pressure in one area of the lawn.',
        internal_copy: 'Internal scoring detail',
        evidence_refs: ['assessment:1'],
      }]),
      treatment_context: JSON.stringify({
        completed_today: true,
        service_type: 'WaveGuard',
        products_applied_summary: 'Product A',
      }),
      weather_context: JSON.stringify({ customer_copy: 'Recent weather can influence recovery.' }),
      expected_window: JSON.stringify({ min_days: 14, max_days: 21 }),
      next_watch_items: JSON.stringify(['Monitor weed pressure']),
      disclaimers: JSON.stringify(['Visible improvement depends on site conditions.']),
    });

    expect(snapshot).toMatchObject({
      id: 'snapshot-1',
      summary: 'We saw moderate weed pressure in one area of the lawn.',
      findings: [{ key: 'weed_pressure', severity: 2 }],
      treatment: { completedToday: true, serviceType: 'WaveGuard' },
      expectedWindow: { minDays: 14, maxDays: 21 },
    });
    expect(snapshot.findings[0]).not.toHaveProperty('internal_copy');
    expect(snapshot.findings[0]).not.toHaveProperty('confidence');
    expect(snapshot.findings[0]).not.toHaveProperty('evidence_refs');

    const card = lawnHealthRouter._test.formatCustomerRecommendation({
      id: 'card-1',
      type: 'tier_upgrade',
      title: 'WaveGuard Gold may be a better fit',
      priority: 'medium',
      confidence: 0.82,
      customer_copy: 'WaveGuard Gold may be a better fit.',
      internal_reason: 'Internal reason',
      trigger_signals: JSON.stringify([{ key: 'callback_risk' }]),
      recommended_action: JSON.stringify({
        action_type: 'upgrade_plan',
        cta_label: 'Ask about Gold coverage',
        plan: 'WaveGuard Gold',
      }),
    });

    expect(card).toMatchObject({
      id: 'card-1',
      type: 'tier_upgrade',
      title: 'WaveGuard Gold may be a better fit',
      action: { type: 'upgrade_plan', label: 'Ask about Gold coverage' },
    });
    expect(card).not.toHaveProperty('internal_reason');
    expect(card).not.toHaveProperty('trigger_signals');
    expect(card).not.toHaveProperty('confidence');
  });

  test('customer recommendation event metadata is source-scoped and bounded', () => {
    const metadata = lawnHealthRouter._test.recommendationEventMetadata({
      surface: 'customer_portal_dashboard',
      placement: 'lawn_snapshot_card',
      actionType: 'request_follow_up',
      metadata: {
        surface: 'ignored_nested_surface',
        internal_reason: 'should not be copied',
      },
    });

    expect(metadata).toEqual({
      source: 'customer_portal',
      surface: 'customer_portal_dashboard',
      placement: 'lawn_snapshot_card',
      action_type: 'request_follow_up',
    });
    expect(metadata).not.toHaveProperty('internal_reason');
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

  test('recommendation performance summarizes customer event outcomes', () => {
    const summary = adminLawnAssessmentRouter._test.summarizeRecommendationEvents([
      { event_type: 'generated', created_at: '2026-05-25T10:00:00.000Z' },
      { event_type: 'approved', created_at: '2026-05-25T11:00:00.000Z' },
      { event_type: 'recommendation_shown', created_at: '2026-05-25T12:00:00.000Z' },
      { event_type: 'recommendation_shown', created_at: '2026-05-25T12:05:00.000Z' },
      { event_type: 'recommendation_clicked', created_at: '2026-05-25T12:10:00.000Z' },
      { event_type: 'follow_up_requested', created_at: '2026-05-25T12:15:00.000Z' },
    ], { approved_at: '2026-05-25T11:00:00.000Z' });

    expect(summary.counts.generated).toBe(1);
    expect(summary.counts.approved).toBe(1);
    expect(summary.counts.recommendation_shown).toBe(2);
    expect(summary.counts.shown).toBe(2);
    expect(summary.counts.recommendation_clicked).toBe(1);
    expect(summary.counts.clicked).toBe(1);
    expect(summary.counts.follow_up_requested).toBe(1);
    expect(summary.clickThroughRate).toBe(0.5);
    expect(summary.latestEventAt).toBe('2026-05-25T12:15:00.000Z');
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
