const { normalizeSuggestion, SUGGEST_PROMPT } = require('../services/treatment-zone-suggest');

describe('treatment zone auto-trace (owner 2026-07-21)', () => {
  const squarish = (n = 12) => {
    // n points around a rectangle spanning a healthy chunk of the frame
    const pts = [];
    for (let i = 0; i < n; i += 1) {
      const t = (i / n) * Math.PI * 2;
      pts.push([0.5 + 0.25 * Math.cos(t), 0.5 + 0.2 * Math.sin(t)]);
    }
    return pts;
  };

  test('prompt demands the pool cage in the loop and normalized JSON output', () => {
    expect(SUGGEST_PROMPT).toContain('pool enclosure');
    expect(SUGGEST_PROMPT).toContain('pool cage');
    expect(SUGGEST_PROMPT).toContain('normalized 0-1');
    expect(SUGGEST_PROMPT).toContain('Do NOT include: detached sheds');
  });

  test('accepts a sane perimeter and clamps/labels it', () => {
    const out = normalizeSuggestion({ perimeter: squarish(), includes_pool_enclosure: true, confidence: 0.83 });
    expect(out).toBeTruthy();
    expect(out.perimeter.length).toBeGreaterThanOrEqual(6);
    expect(out.includesPoolEnclosure).toBe(true);
    expect(out.confidence).toBe(0.83);
    for (const p of out.perimeter) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  test('rejects unusable model output', () => {
    expect(normalizeSuggestion(null)).toBe(null);
    expect(normalizeSuggestion({ perimeter: [] })).toBe(null);
    expect(normalizeSuggestion({ perimeter: [[0.1, 0.1], [0.2, 0.2]] })).toBe(null); // too few
    // degenerate cluster — all points inside a tiny box is a bad read
    expect(normalizeSuggestion({ perimeter: Array.from({ length: 10 }, (_, i) => [0.5 + i * 0.001, 0.5]) })).toBe(null);
    // junk values
    expect(normalizeSuggestion({ perimeter: [...Array.from({ length: 8 }, () => ['x', 'y'])] })).toBe(null);
  });

  test('clamps out-of-range coords instead of rejecting the whole read', () => {
    const pts = squarish();
    pts[0] = [-0.2, 1.4];
    const out = normalizeSuggestion({ perimeter: pts, includes_pool_enclosure: false });
    expect(out).toBeTruthy();
    expect(out.perimeter[0]).toEqual({ x: 0, y: 1 });
    expect(out.includesPoolEnclosure).toBe(false);
  });
});
