const satelliteAnalyzer = require('../services/satellite-analyzer');

describe('satellite analyzer per-field confidence', () => {
  test('treats matching zero palm counts as valid agreement', () => {
    const result = satelliteAnalyzer.mergeResults([
      { provider: 'claude', analysis: { palm_count: 0, tree_count: 2 } },
      { provider: 'openai', analysis: { palm_count: 0, tree_count: 2 } },
    ]);

    expect(result.palm_count).toBe(0);
    expect(result.confidenceDetails.palm_count).toMatchObject({
      status: 'agree',
      diff: '0%',
      values: [
        { provider: 'claude', value: 0 },
        { provider: 'openai', value: 0 },
      ],
    });
    expect(result.fieldVerify).not.toContain('palm_count');
  });

  test('flags zero versus a positive count as a disagreement', () => {
    const result = satelliteAnalyzer.mergeResults([
      { provider: 'claude', analysis: { palm_count: 0 } },
      { provider: 'openai', analysis: { palm_count: 4 } },
    ]);

    expect(result.palm_count).toBe(2);
    expect(result.confidenceDetails.palm_count.status).toBe('disagree');
    expect(result.confidenceDetails.palm_count.diff).toBe('100%');
    expect(result.fieldVerify).toContain('palm_count');
  });

  test('keeps a single provider zero as an explicit, reviewable value', () => {
    const result = satelliteAnalyzer.mergeResults([
      { provider: 'claude', analysis: { palm_count: 0 } },
    ]);

    expect(result.palm_count).toBe(0);
    expect(result.confidenceDetails.palm_count).toEqual({
      values: [{ provider: 'claude', value: 0 }],
      status: 'single_source',
    });
    expect(result.fieldVerify).toContain('palm_count');
  });

  test('clears invalid supplied measurements but keeps them reviewable', () => {
    const result = satelliteAnalyzer.mergeResults([
      { provider: 'claude', analysis: { palm_count: -2, lawn_sqft: 'unknown' } },
    ]);

    expect(result.palm_count).toBeNull();
    expect(result.lawn_sqft).toBeNull();
    expect(result.fieldVerify).toEqual(expect.arrayContaining(['palm_count', 'lawn_sqft']));
    expect(result.fieldVerify).not.toContain('tree_count');
  });

  test('keeps single-model boolean and string facts reviewable', () => {
    const result = satelliteAnalyzer.mergeResults([
      {
        provider: 'gemini',
        analysis: {
          lawn_sqft: 4000,
          has_pool: true,
          near_water: false,
          property_type: 'single_family',
          tree_density: 'medium',
        },
      },
    ]);

    expect(result.confidence).toBe('single_model');
    expect(result.fieldVerify).toEqual(expect.arrayContaining([
      'lawn_sqft', 'has_pool', 'near_water', 'property_type', 'tree_density',
    ]));
    expect(result.confidenceDetails.has_pool).toEqual({
      values: [{ provider: 'gemini', value: true }],
      status: 'single_source',
    });
    expect(result.confidenceDetails.near_water).toEqual({
      values: [{ provider: 'gemini', value: false }],
      status: 'single_source',
    });
    expect(result.confidenceDetails.property_type).toEqual({
      values: [{ provider: 'gemini', value: 'single_family' }],
      status: 'single_source',
    });
    expect(result.fieldVerify).not.toContain('shrub_density');
  });

  test('flags a boolean reported by only one of multiple providers', () => {
    const result = satelliteAnalyzer.mergeResults([
      { provider: 'claude', analysis: { has_pool: true } },
      { provider: 'openai', analysis: {} },
    ]);

    expect(result.has_pool).toBe(true);
    expect(result.fieldVerify).toContain('has_pool');
    expect(result.confidenceDetails.has_pool).toEqual({
      values: [{ provider: 'claude', value: true }],
      status: 'single_source',
    });
    expect(result.has_pool_cage).toBeNull();
    expect(result.confidenceDetails.has_pool_cage).toEqual({ values: [], status: 'missing' });
  });
});
