const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const {
  buildPestPressureCustomerView,
  buildPestPressureAdminView,
} = require('../services/pest-pressure/customer-view');

function makeScoreRow(overrides = {}) {
  return {
    service_record_id: 'svc-1',
    customer_id: 'cust-1',
    service_date: '2026-05-17',
    review_period_start: '2026-02-16',
    review_period_end: '2026-05-17',
    calculated_score: 1.2,
    displayed_score: 1.2,
    label_key: 'low',
    label_name: 'Low',
    trend: 'first_marker',
    trend_delta: null,
    data_completeness: 'complete',
    component_scores: { clientRating: { value: 1, weight: 25, present: true } },
    component_weights: { client: 25, technician: 30, reService: 20, recurring: 15, risk: 10 },
    missing_components: [],
    explanation: 'This is your first Pest Pressure score.',
    config_snapshot: DEFAULT_CONFIG,
    calculation_version: '1.0',
    is_overridden: false,
    override_reason: null,
    overridden_by: null,
    overridden_at: null,
    calculated_at: '2026-05-17T14:35:00Z',
    ...overrides,
  };
}

describe('buildPestPressureCustomerView', () => {
  test('returns null when feature is disabled', () => {
    const config = { ...DEFAULT_CONFIG, enabled: false };
    expect(buildPestPressureCustomerView({ config, scoreRow: makeScoreRow() })).toBeNull();
  });

  test('returns null when showOnCustomerReport is false', () => {
    const config = { ...DEFAULT_CONFIG, showOnCustomerReport: false };
    expect(buildPestPressureCustomerView({ config, scoreRow: makeScoreRow() })).toBeNull();
  });

  test('builds full object when enabled and score is present', () => {
    const view = buildPestPressureCustomerView({ config: DEFAULT_CONFIG, scoreRow: makeScoreRow() });
    expect(view).toMatchObject({
      enabled: true,
      showOnCustomerReport: true,
      score: 1.2,
      displayScore: '1.2',
      maxScore: 5,
      label: 'Low',
      labelKey: 'low',
      trend: 'first_marker',
      trendDelta: null,
      date: '2026-05-17',
      dataCompleteness: 'complete',
      summary: expect.stringContaining('first Pest Pressure score'),
    });
    expect(view.howCalculated).toContain('Pest Pressure is a 0–5 score');
    expect(view.showComponentBreakdown).toBe(false);
    expect(view.components).toBeNull();
  });

  test('includes components when showComponentBreakdownToCustomer is true', () => {
    const config = { ...DEFAULT_CONFIG, showComponentBreakdownToCustomer: true };
    const view = buildPestPressureCustomerView({ config, scoreRow: makeScoreRow() });
    expect(view.showComponentBreakdown).toBe(true);
    expect(view.components).toEqual({ clientRating: { value: 1, weight: 25, present: true } });
  });

  test('returns insufficient placeholder when score is null', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow({ displayed_score: null, data_completeness: 'insufficient', label_name: null, label_key: null, trend: 'insufficient_data' }),
    });
    expect(view.score).toBeNull();
    expect(view.displayScore).toBeNull();
    expect(view.dataCompleteness).toBe('insufficient');
    expect(view.summary).toMatch(/once enough service data is available/);
  });

  test('returns insufficient placeholder when no scoreRow exists', () => {
    const view = buildPestPressureCustomerView({ config: DEFAULT_CONFIG, scoreRow: null });
    expect(view.score).toBeNull();
    expect(view.dataCompleteness).toBe('insufficient');
  });

  test('omits howCalculated when showHowCalculated is false', () => {
    const config = { ...DEFAULT_CONFIG, showHowCalculated: false };
    const view = buildPestPressureCustomerView({ config, scoreRow: makeScoreRow() });
    expect(view.howCalculated).toBeNull();
  });
});

describe('buildPestPressureAdminView', () => {
  test('returns null when no scoreRow', () => {
    expect(buildPestPressureAdminView({ scoreRow: null })).toBeNull();
  });

  test('exposes override + breakdown fields for admin', () => {
    const row = makeScoreRow({
      calculated_score: 2.4,
      displayed_score: 2.0,
      is_overridden: true,
      override_reason: 'Customer dispute',
      overridden_by: 'tech-123',
    });
    const view = buildPestPressureAdminView({ scoreRow: row });
    expect(view).toMatchObject({
      calculatedScore: 2.4,
      displayedScore: 2.0,
      isOverridden: true,
      overrideReason: 'Customer dispute',
      overriddenBy: 'tech-123',
      calculationVersion: '1.0',
      reviewPeriodStart: '2026-02-16',
      reviewPeriodEnd: '2026-05-17',
    });
    expect(view.componentScores).toEqual(row.component_scores);
    expect(view.configSnapshot).toBe(row.config_snapshot);
  });
});
