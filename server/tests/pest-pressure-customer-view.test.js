const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const {
  buildPestPressureCustomerView,
  buildPestPressureAdminView,
} = require('../services/pest-pressure/customer-view');

// Default service record fixture for tests that don't otherwise care about
// service-line scoping — passes the scope gates so older tests still
// exercise the core view logic.
const PEST_RECORD = { id: 'svc-1', service_line: 'pest', service_type: 'Monthly Pest Control', client_pest_rating: null };

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
    const view = buildPestPressureCustomerView({ config: DEFAULT_CONFIG, scoreRow: makeScoreRow(), serviceRecord: PEST_RECORD });
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
    const view = buildPestPressureCustomerView({ config, scoreRow: makeScoreRow(), serviceRecord: PEST_RECORD });
    expect(view.showComponentBreakdown).toBe(true);
    expect(view.components).toEqual({ clientRating: { value: 1, weight: 25, present: true } });
  });

  test('returns insufficient placeholder when score is null', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow({ displayed_score: null, data_completeness: 'insufficient', label_name: null, label_key: null, trend: 'insufficient_data' }),
      serviceRecord: PEST_RECORD,
    });
    expect(view.score).toBeNull();
    expect(view.displayScore).toBeNull();
    expect(view.dataCompleteness).toBe('insufficient');
    expect(view.summary).toMatch(/once enough service data is available/);
  });

  test('returns insufficient placeholder when no scoreRow exists', () => {
    const view = buildPestPressureCustomerView({ config: DEFAULT_CONFIG, scoreRow: null, serviceRecord: PEST_RECORD });
    expect(view.score).toBeNull();
    expect(view.dataCompleteness).toBe('insufficient');
  });

  test('omits howCalculated when showHowCalculated is false', () => {
    const config = { ...DEFAULT_CONFIG, showHowCalculated: false };
    const view = buildPestPressureCustomerView({ config, scoreRow: makeScoreRow(), serviceRecord: PEST_RECORD });
    expect(view.howCalculated).toBeNull();
  });
});

describe('buildPestPressureCustomerView: scope gate fails closed without serviceRecord', () => {
  test('returns null when no serviceRecord supplied (allow list is restricted by default)', () => {
    const view = buildPestPressureCustomerView({ config: DEFAULT_CONFIG, scoreRow: makeScoreRow() });
    expect(view).toBeNull();
  });
});

describe('buildPestPressureCustomerView: service-line + frequency scope', () => {
  test('returns null when service_line is not in enabledServiceLines', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG, // pest + mosquito
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'lawn', service_type: 'Monthly Lawn Care', client_pest_rating: null },
    });
    expect(view).toBeNull();
  });

  test('returns null when service_line is unknown and config restricts', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: null, service_type: 'Monthly Pest Control', client_pest_rating: null },
    });
    expect(view).toBeNull();
  });

  test('returns the card when service_line IS enabled (pest)', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'pest', service_type: 'Monthly Pest Control', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
    expect(view.score).toBe(1.2);
  });

  test('mosquito is enabled by default', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'mosquito', service_type: 'Monthly Mosquito Treatment', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
  });

  test.each([
    'One-Time Pest Treatment',
    'One time Pest Treatment',
    'One-off Spot Visit',
    'Single Visit Pest Treatment',
    'Just once mosquito event',
    'Spot Treatment for ants',
  ])('returns null for explicit one-time label "%s"', (label) => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG, // requireRecurringFrequency: true
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'pest', service_type: label, client_pest_rating: null },
    });
    expect(view).toBeNull();
  });

  test('returns the card on a recurring-but-no-cadence-keyword label (e.g. "General Pest Control")', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'pest', service_type: 'General Pest Control', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
  });

  test('returns the card for "Recurring Pest Control" label', () => {
    const view = buildPestPressureCustomerView({
      config: DEFAULT_CONFIG,
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'pest', service_type: 'Recurring Pest Control', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
  });

  test('returns the card on one-time visit when requireRecurringFrequency is off', () => {
    const view = buildPestPressureCustomerView({
      config: { ...DEFAULT_CONFIG, requireRecurringFrequency: false },
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'pest', service_type: 'One-Time Pest Treatment', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
  });

  test('empty enabledServiceLines passes everything through (no allow list)', () => {
    const view = buildPestPressureCustomerView({
      config: { ...DEFAULT_CONFIG, enabledServiceLines: [], requireRecurringFrequency: false },
      scoreRow: makeScoreRow(),
      serviceRecord: { id: 'svc-1', service_line: 'lawn', service_type: 'Monthly Lawn Care', client_pest_rating: null },
    });
    expect(view).not.toBeNull();
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
