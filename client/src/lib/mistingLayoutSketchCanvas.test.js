// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MAP_HEIGHT } from '../components/tech/treatmentZoneSpray';
import { SKETCH_CONCEPT, SKETCH_HEADER_H, SKETCH_HEIGHT, SKETCH_WIDTH, buildSketchModel } from './mistingLayoutSketch';
import { drawSketch } from './mistingLayoutSketchCanvas';

// A recording 2D context: every method is a spy, every property just stores what was set.
function recordingContext() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls };
}

const model = () => buildSketchModel({
  lat: 26.95,
  zoom: 20,
  address: '500 Example Court, Venice, FL',
  date: new Date('2026-10-26T15:00:00Z'),
  lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }],
  nozzles: [{ x: 400, y: 100, kind: 'eave', lineIndex: 0 }, { x: 100, y: 100, kind: 'eave', lineIndex: 0 }],
  risers: [{ x: 250, y: 300 }],
  pump: { x: 600, y: 300 },
  zones: [{ kind: 'pool', x: 500, y: 500, radiusFt: 15, radiusPx: 60 }],
  totals: { eaveCount: 2, fenceCount: 0, linearFt: 55 },
});

describe('drawSketch', () => {
  it('draws the photo whole between the header and footer, and every label the sketch promises', () => {
    const { ctx, calls } = recordingContext();
    const map = { name: 'map' };
    const logo = { name: 'logo' };
    drawSketch(ctx, model(), { map, logo });

    const images = calls.filter((c) => c[0] === 'drawImage');
    expect(images.find((c) => c[1] === map)).toEqual(['drawImage', map, 0, SKETCH_HEADER_H, SKETCH_WIDTH, MAP_HEIGHT]);
    expect(images.find((c) => c[1] === logo)).toBeTruthy();

    const texts = calls.filter((c) => c[0] === 'fillText' || c[0] === 'strokeText').map((c) => c[1]);
    expect(texts).toContain('Proposed misting layout');
    expect(texts).toContain('500 Example Court, Venice, FL');
    expect(texts).toContain('October 26, 2026');
    expect(texts).toContain(SKETCH_CONCEPT);
    expect(texts).toContain('Nozzles: 2 (eave 2, fence 0)');
    expect(texts).toContain('Pump');
    expect(texts).toContain('No mist: Pool');
    // Nozzles are numbered 1..N.
    expect(texts).toContain('1');
    expect(texts).toContain('2');
    // The scale bar names its feet.
    expect(texts.some((t) => /^\d+ ft$/.test(t))).toBe(true);
  });

  it('draws one triangle for the riser and one square for the pump, and keeps the photo bottom edge clear', () => {
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, model(), { map: {}, logo: null });
    expect(calls.filter((c) => c[0] === 'closePath')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'fillRect' && c[3] === 28 && c[4] === 28)).toHaveLength(1);
    // After the photo, the only filled rectangles are the pump square and the footer, which starts at the photo's bottom
    // edge: nothing covers the photo's own strip where Google's attribution sits.
    const photoBottom = SKETCH_HEADER_H + MAP_HEIGHT;
    const photoAt = calls.findIndex((c) => c[0] === 'drawImage' && c[3] === SKETCH_HEADER_H);
    calls.slice(photoAt + 1).filter((c) => c[0] === 'fillRect').forEach((c) => {
      const isPump = c[3] === 28 && c[4] === 28;
      expect(isPump || c[2] >= photoBottom).toBe(true);
    });
    expect(SKETCH_HEIGHT).toBeGreaterThan(photoBottom);
  });

  it('draws without a logo', () => {
    const { ctx, calls } = recordingContext();
    expect(() => drawSketch(ctx, model(), { map: {}, logo: null })).not.toThrow();
    expect(calls.filter((c) => c[0] === 'drawImage')).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
