jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const tracker = require('../services/seo/impact-tracker');
const { computeVerdict } = tracker;
const { median, clicksPct, positionDelta } = tracker._internals;

describe('impact-tracker pure helpers', () => {
  test('median handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test('positionDelta is positive when position improves (number drops)', () => {
    expect(positionDelta(15, 10)).toBe(5);
    expect(positionDelta(10, 14)).toBe(-4);
  });
  test('clicksPct', () => {
    expect(clicksPct(50, 80)).toBe(60);
    expect(clicksPct(0, 5)).toBe(500); // guards divide-by-zero with max(base,1)
  });
});

describe('computeVerdict (diff-in-diff)', () => {
  const ctrlFlat = [{ position_delta: 0, clicks_pct: 5 }, { position_delta: 0, clicks_pct: 0 }];

  test('page improves while controls are flat → improved', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 10, clicks: 80, impressions: 2200 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('improved');
    expect(r.estimated_lift_position).toBeGreaterThanOrEqual(2);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test('page and controls improve equally → neutral (rising tide removed)', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 10, clicks: 80, impressions: 2200 },
      controlDeltas: [{ position_delta: 5, clicks_pct: 60 }, { position_delta: 5, clicks_pct: 60 }],
    });
    expect(r.verdict).toBe('neutral');
    expect(Math.abs(r.estimated_lift_position)).toBeLessThan(2);
  });

  test('clicks jump well above control → improved on clicks alone', () => {
    const r = computeVerdict({
      baseline: { position: 8, clicks: 100, impressions: 5000 },
      window: { position: 8, clicks: 160, impressions: 5200 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 10 }, { position_delta: 0, clicks_pct: 8 }],
    });
    expect(r.verdict).toBe('improved');
    expect(r.estimated_lift_clicks_pct).toBeGreaterThanOrEqual(20);
  });

  test('page drops while controls flat → regressed', () => {
    const r = computeVerdict({
      baseline: { position: 12, clicks: 60, impressions: 3000 },
      window: { position: 16, clicks: 40, impressions: 2800 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('regressed');
    expect(r.estimated_lift_position).toBeLessThanOrEqual(-3);
  });

  test('thin baseline impressions → insufficient_data', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 2, impressions: 12 },
      window: { position: 9, clicks: 5, impressions: 20 },
      controlDeltas: ctrlFlat,
    });
    expect(r.verdict).toBe('insufficient_data');
  });

  test('no control pages → insufficient_data', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 50, impressions: 2000 },
      window: { position: 9, clicks: 90, impressions: 2200 },
      controlDeltas: [],
    });
    expect(r.verdict).toBe('insufficient_data');
  });

  test('large lift but low confidence (thin data) → neutral, not improved', () => {
    const r = computeVerdict({
      baseline: { position: 15, clicks: 4, impressions: 40 },
      window: { position: 8, clicks: 9, impressions: 40 },
      controlDeltas: [{ position_delta: 0, clicks_pct: 0 }],
    });
    expect(r.confidence).toBeLessThan(0.7);
    expect(r.verdict).toBe('neutral');
  });
});
