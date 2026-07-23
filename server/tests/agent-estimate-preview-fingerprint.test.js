const {
  agentEstimatePreviewFingerprint,
  agentEngineResultDigest,
} = require('../services/agent-estimate-preview');

const ENGINE_RESULT = {
  summary: {
    recurringMonthlyAfterDiscount: 54.17,
    recurringAnnualAfterDiscount: 650,
    oneTimeTotal: 0,
  },
  waveGuard: { tier: 'bronze' },
  lineItems: [{
    service: 'pest_control',
    annualAfterDiscount: 650,
    monthlyAfterDiscount: 54.17,
    tiers: [
      { tier: 'standard', annual: 650, monthly: 54.17 },
      { tier: 'premium', annual: 900, monthly: 75 },
    ],
  }],
  generatedAt: '2026-07-17T01:00:00.000Z',
};

function previewFor(engineResult, extra = {}) {
  return {
    totals: { monthly: 54.17, annual: 650, oneTime: 0 },
    lane: 'green',
    lane_reasons: [],
    lines: [{ service: 'pest_control', annual: 650 }],
    engineResult,
    engine_result_digest: agentEngineResultDigest(engineResult),
    presentation: { template: 'single_service' },
    customer_account: { recognized: false },
    ...extra,
  };
}

describe('agentEngineResultDigest', () => {
  test('ignores the volatile generatedAt stamp', () => {
    const later = { ...ENGINE_RESULT, generatedAt: '2026-07-17T02:00:00.000Z' };
    expect(agentEngineResultDigest(later)).toBe(agentEngineResultDigest(ENGINE_RESULT));
  });

  test('ignores object key insertion order', () => {
    const reordered = {
      generatedAt: ENGINE_RESULT.generatedAt,
      lineItems: ENGINE_RESULT.lineItems,
      waveGuard: ENGINE_RESULT.waveGuard,
      summary: ENGINE_RESULT.summary,
    };
    expect(agentEngineResultDigest(reordered)).toBe(agentEngineResultDigest(ENGINE_RESULT));
  });

  test('changes when a non-selected alternate price changes', () => {
    const bumpedPremium = {
      ...ENGINE_RESULT,
      lineItems: [{
        ...ENGINE_RESULT.lineItems[0],
        tiers: [
          { tier: 'standard', annual: 650, monthly: 54.17 },
          { tier: 'premium', annual: 960, monthly: 80 },
        ],
      }],
    };
    expect(agentEngineResultDigest(bumpedPremium)).not.toBe(agentEngineResultDigest(ENGINE_RESULT));
  });

  test('is null for a missing result', () => {
    expect(agentEngineResultDigest(null)).toBeNull();
    expect(agentEngineResultDigest(undefined)).toBeNull();
  });
});

describe('agentEstimatePreviewFingerprint', () => {
  test('matches between the internal preview and the safe (stripped) preview', () => {
    const internal = previewFor(ENGINE_RESULT);
    const { engineResult: _engineResult, ...safe } = internal;
    expect(agentEstimatePreviewFingerprint(safe)).toBe(agentEstimatePreviewFingerprint(internal));
  });

  test('matches across engine re-runs that differ only by generatedAt', () => {
    const proposal = previewFor({ ...ENGINE_RESULT, generatedAt: '2026-07-17T01:00:00.000Z' });
    const confirm = previewFor({ ...ENGINE_RESULT, generatedAt: '2026-07-17T03:30:00.000Z' });
    expect(agentEstimatePreviewFingerprint(proposal)).toBe(agentEstimatePreviewFingerprint(confirm));
  });

  test('derives the digest from the raw result when no digest field is attached', () => {
    const withDigest = previewFor(ENGINE_RESULT);
    const withoutDigest = { ...withDigest };
    delete withoutDigest.engine_result_digest;
    expect(agentEstimatePreviewFingerprint(withoutDigest))
      .toBe(agentEstimatePreviewFingerprint(withDigest));
  });

  test('still rejects a drifted alternate price', () => {
    const approved = previewFor(ENGINE_RESULT);
    const drifted = previewFor({
      ...ENGINE_RESULT,
      lineItems: [{
        ...ENGINE_RESULT.lineItems[0],
        tiers: [
          { tier: 'standard', annual: 650, monthly: 54.17 },
          { tier: 'premium', annual: 960, monthly: 80 },
        ],
      }],
    });
    expect(agentEstimatePreviewFingerprint(drifted)).not.toBe(agentEstimatePreviewFingerprint(approved));
  });

  test('binds the operator price adjustment — same totals under a different discount label/flag do not match', () => {
    const approved = previewFor(ENGINE_RESULT, {
      operator_price_adjustment: {
        requested: { type: 'PERCENT', value: 5, label: 'Loyalty', internal_reason: 'asked', floor_breach_acknowledged: false },
        adjusted_monthly_total: 51.46,
      },
    });
    const relabeled = previewFor(ENGINE_RESULT, {
      operator_price_adjustment: {
        requested: { type: 'PERCENT', value: 5, label: 'Manager special', internal_reason: 'asked', floor_breach_acknowledged: false },
        adjusted_monthly_total: 51.46,
      },
    });
    const noAdjustment = previewFor(ENGINE_RESULT);
    expect(agentEstimatePreviewFingerprint(relabeled)).not.toBe(agentEstimatePreviewFingerprint(approved));
    expect(agentEstimatePreviewFingerprint(noAdjustment)).not.toBe(agentEstimatePreviewFingerprint(approved));
  });
});
