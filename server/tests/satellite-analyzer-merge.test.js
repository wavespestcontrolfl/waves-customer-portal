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
});
