const RecommendationEngine = require('../services/lawn-recommendation-engine');

describe('lawn recommendation engine', () => {
  test('blocks internal-risk language from customer copy', () => {
    expect(RecommendationEngine.isCustomerCopySafe('This customer has callback risk')).toBe(false);
    expect(RecommendationEngine.isCustomerCopySafe('AI predicted churn and margin risk')).toBe(false);
    expect(RecommendationEngine.isCustomerCopySafe('WaveGuard Gold may be a better fit for your lawn.')).toBe(true);
  });

  test('single weak signal cannot produce a tier upgrade card', () => {
    const card = RecommendationEngine.evaluateTierUpgrade({
      customer: { id: 'customer-1', waveguard_tier: 'Silver' },
      assessment: { id: 'assessment-1', confirmed_by_tech: true, overall_score: 88 },
      snapshot: {
        id: 'snapshot-1',
        customer_id: 'customer-1',
        findings: JSON.stringify([{ key: 'weed_pressure', severity: 1 }]),
      },
    });

    expect(card).toBeNull();
  });

  test('tier upgrade requires two signals and starts internal with approval required', () => {
    const card = RecommendationEngine.evaluateTierUpgrade({
      customer: { id: 'customer-1', waveguard_tier: 'Bronze' },
      assessment: {
        id: 'assessment-1',
        confirmed_by_tech: true,
        overall_score: 62,
        stress_flags: JSON.stringify({ disease_suspicion: true }),
      },
      snapshot: {
        id: 'snapshot-1',
        customer_id: 'customer-1',
        findings: JSON.stringify([
          { key: 'weed_pressure', severity: 2 },
          { key: 'possible_disease_pressure', severity: 2 },
        ]),
      },
    });

    expect(card).toMatchObject({
      type: 'tier_upgrade',
      status: 'needs_admin_review',
      customer_visible: false,
      requires_human_approval: true,
    });
    expect(card.trigger_signals.length).toBeGreaterThanOrEqual(2);
    expect(card.confidence).toBeGreaterThanOrEqual(0.7);
    expect(RecommendationEngine.isCustomerCopySafe(card.customer_copy)).toBe(true);
  });

  test('education cards can be low-risk but still start hidden until a route approves visibility', () => {
    const card = RecommendationEngine.evaluateCustomerEducation({
      assessment: { stress_flags: JSON.stringify({ drought_stress: true }) },
      snapshot: {
        id: 'snapshot-1',
        customer_id: 'customer-1',
        weather_context: JSON.stringify({ customer_copy: 'Recent weather can influence recovery.' }),
      },
    });

    expect(card).toMatchObject({
      type: 'customer_education',
      requires_human_approval: false,
      customer_visible: false,
    });
    expect(RecommendationEngine.isCustomerCopySafe(card.customer_copy)).toBe(true);
  });
});
