const {
  normalizeSuggestion,
  orthogonalizePerimeter,
  SUGGEST_PROMPT,
  LAWN_SUGGEST_PROMPT,
} = require('../services/treatment-zone-suggest');

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

  test('prompts anchor the target to the image center — never a neighbor (owner 2026-07-29)', () => {
    expect(SUGGEST_PROMPT).toContain('CENTER of the image');
    expect(SUGGEST_PROMPT).toContain('NEVER trace a neighboring building');
    expect(LAWN_SUGGEST_PROMPT).toContain('CENTER of the image');
  });
});

describe('orthogonalizePerimeter (owner 2026-07-29)', () => {
  // Map-frame aspect the helper corrects for (1280x960).
  const ASPECT = 1280 / 960;

  test('squares up a jittered axis-aligned footprint and merges collinear wall points', () => {
    // Rectangle with a mid point on each wall, each nudged off the wall line —
    // the classic sloppy vision read.
    const j = 0.012;
    const pts = [
      { x: 0.3, y: 0.3 }, { x: 0.5, y: 0.3 + j },
      { x: 0.7, y: 0.3 }, { x: 0.7 + j, y: 0.5 },
      { x: 0.7, y: 0.7 }, { x: 0.5, y: 0.7 - j },
      { x: 0.3, y: 0.7 }, { x: 0.3 - j, y: 0.5 },
    ];
    const out = orthogonalizePerimeter(pts);
    // Collinear mid-wall beads merge away, true corners survive.
    expect(out.length).toBe(4);
    // Every edge of the result is axis-aligned (sub-pixel at the 1280x960
    // frame: 1e-3 normalized ≈ 1px).
    for (let i = 0; i < out.length; i += 1) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const axisAligned = Math.abs(a.x - b.x) < 1e-3 || Math.abs(a.y - b.y) < 1e-3;
      expect(axisAligned).toBe(true);
    }
  });

  test('squares up a rotated footprint about its own dominant angle', () => {
    // A 2:1 rectangle rotated 20° (built in aspect-true space so the helper's
    // aspect correction round-trips), corners nudged slightly.
    const theta = (20 * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const base = [
      { x: -0.2, y: -0.1 }, { x: 0.2, y: -0.1 },
      { x: 0.2, y: 0.1 }, { x: -0.2, y: 0.1 },
    ];
    const pts = base.map((p, i) => {
      const nudge = (i % 2 ? 1 : -1) * 0.004;
      const x = p.x * cos - p.y * sin + 0.55;
      const y = p.x * sin + p.y * cos + nudge + 0.5;
      return { x: x / ASPECT, y };
    });
    const out = orthogonalizePerimeter(pts);
    expect(out.length).toBeGreaterThanOrEqual(4);
    // Adjacent edges come out perpendicular (checked in aspect-true space).
    for (let i = 0; i < out.length; i += 1) {
      const p = out[(i - 1 + out.length) % out.length];
      const c = out[i];
      const n = out[(i + 1) % out.length];
      const v1 = { x: (c.x - p.x) * ASPECT, y: c.y - p.y };
      const v2 = { x: (n.x - c.x) * ASPECT, y: n.y - c.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const cosAngle = dot / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      expect(Math.abs(cosAngle)).toBeLessThan(0.06);
    }
  });

  test('leaves genuinely diagonal edges alone', () => {
    // A square with one corner cut at 45° — the chamfer must survive.
    const pts = [
      { x: 0.3, y: 0.3 }, { x: 0.62, y: 0.3 },
      { x: 0.7, y: 0.38 }, // 45° chamfer edge
      { x: 0.7, y: 0.7 }, { x: 0.3, y: 0.7 },
    ];
    const out = orthogonalizePerimeter(pts);
    expect(out.length).toBe(pts.length);
    // The chamfer edge is still diagonal.
    const a = out[1];
    const b = out[2];
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(0.01);
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(0.01);
  });

  test('degenerate input passes through untouched', () => {
    const two = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }];
    expect(orthogonalizePerimeter(two)).toEqual(two);
    expect(orthogonalizePerimeter(null)).toBe(null);
  });
});
