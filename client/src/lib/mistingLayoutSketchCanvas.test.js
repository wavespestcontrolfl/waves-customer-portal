// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MAP_HEIGHT } from '../components/tech/treatmentZoneSpray';
import { SKETCH_CONCEPT, SKETCH_HEADER_H, SKETCH_HEIGHT, SKETCH_WIDTH, buildSketchModel } from './mistingLayoutSketch';
import { drawSketch } from './mistingLayoutSketchCanvas';

// A recording 2D context: every method is a spy, every property just stores what was set.
function recordingContext() {
  const calls = [];
  // About 14 px per character at the 26 px label size, like the browser's sans-serif.
  const ctx = new Proxy({ measureText: (text) => ({ width: String(text).length * 14 }) }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, calls };
}

// [text, x, y] of every fillText of `text` inside the photo (the label pass draws with the photo origin moved).
const fillsOf = (calls, text) => calls.filter((c) => c[0] === 'fillText' && c[1] === text);
const box = ([, text, x, y]) => ({ x0: x - text.length * 7, x1: x + text.length * 7, y0: y - 13, y1: y + 13 });

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

  it('draws the labels after the nozzles, beside the pump when a nozzle sits under it, and never on top of each other', () => {
    const crowded = buildSketchModel({
      lat: 26.95,
      zoom: 20,
      address: '500 Example Court, Venice, FL',
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 300, y: 340 }, { x: 900, y: 340 }] }],
      // One nozzle right where the pump label would go by default (below the pump).
      nozzles: [{ x: 600, y: 340, kind: 'eave', lineIndex: 0 }],
      risers: [],
      pump: { x: 600, y: 300 },
      // Two zones side by side whose default (above) labels would collide.
      zones: [
        { kind: 'pool', x: 500, y: 600, radiusFt: 15, radiusPx: 60 },
        { kind: 'ac', x: 620, y: 600, radiusFt: 8, radiusPx: 32 },
      ],
      totals: { eaveCount: 1, fenceCount: 0, linearFt: 60 },
    });
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, crowded, { map: {}, logo: null });

    const lastNozzleNumber = calls.map((c) => c[0] === 'fillText' && c[1] === '1').lastIndexOf(true);
    const pump = fillsOf(calls, 'Pump')[0];
    expect(calls.indexOf(pump)).toBeGreaterThan(lastNozzleNumber);
    // The label clears the nozzle (radius 17) under the default spot.
    const p = box(pump);
    expect(600 > p.x0 - 17 && 600 < p.x1 + 17 && 340 > p.y0 - 17 && 340 < p.y1 + 17).toBe(false);

    const labels = [pump, fillsOf(calls, 'No mist: Pool')[0], fillsOf(calls, 'No mist: AC intake')[0]].map(box);
    labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => {
      expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
    }));
  });

  it('keeps the concept note below the legend box', () => {
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, model(), { map: {}, logo: null });
    const legend = calls.find((c) => c[0] === 'strokeRect' && c[1] === 24);
    const concept = fillsOf(calls, SKETCH_CONCEPT)[0];
    // Concept text is 26 px on an alphabetic baseline: its top is about 26 px above y.
    expect(legend[2] + legend[4]).toBeLessThan(concept[3] - 26);
  });

  describe('nozzles inside a no-mist zone', () => {
    const flaggedModel = () => buildSketchModel({
      lat: 26.95,
      zoom: 20,
      address: '500 Example Court, Venice, FL',
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 500 }, { x: 900, y: 500 }] }],
      // Left nozzle is clear; the middle one sits at the pool's center.
      nozzles: [{ x: 100, y: 500, kind: 'eave', lineIndex: 0 }, { x: 500, y: 500, kind: 'eave', lineIndex: 0 }],
      risers: [],
      pump: null,
      zones: [{ kind: 'pool', x: 500, y: 500, radiusFt: 15, radiusPx: 60 }],
      totals: { eaveCount: 2, fenceCount: 0, linearFt: 100 },
    });

    // Records the fillStyle in force at each fill(), so the colour of a nozzle disc can be read back.
    function styleRecordingContext() {
      const calls = [];
      const ctx = new Proxy({ measureText: (t) => ({ width: String(t).length * 14 }) }, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === 'fill') return () => { calls.push(['fill', target.fillStyle]); };
          return (...args) => { calls.push([prop, ...args]); };
        },
        set(target, prop, value) { target[prop] = value; return true; },
      });
      return { ctx, calls };
    }

    it('draws the flagged nozzle amber with a dashed ring and a "!", and the clear one as before', () => {
      const { ctx, calls } = styleRecordingContext();
      drawSketch(ctx, flaggedModel(), { map: {}, logo: null });
      // The fill that follows each nozzle disc (an arc of radius 17).
      const discFills = calls
        .map((c, i) => (c[0] === 'arc' && c[3] === 17 && calls[i + 1] && calls[i + 1][0] === 'fill' ? [c[1], calls[i + 1][1]] : null))
        .filter(Boolean);
      expect(discFills).toEqual([[100, '#000'], [500, '#f59e0b']]);
      // The dashed ring and the "!" belong to the flagged nozzle only, so the warning is not color alone.
      const rings = calls.filter((c) => c[0] === 'arc' && c[3] === 24);
      expect(rings).toHaveLength(1);
      expect(rings[0].slice(1, 3)).toEqual([500, 500]);
      expect(calls.some((c) => c[0] === 'setLineDash' && c[1].join() === '6,4')).toBe(true);
      expect(calls.filter((c) => c[0] === 'fillText' && c[1] === '!')).toHaveLength(1);
    });

    it('prints the legend row, and leaves it out when no nozzle is in a zone', () => {
      const { ctx, calls } = recordingContext();
      drawSketch(ctx, flaggedModel(), { map: {}, logo: null });
      expect(fillsOf(calls, 'In a no-mist zone: 1 (aim away or move)')).toHaveLength(1);
      // six rows still sit above the concept note
      const legend = calls.find((c) => c[0] === 'strokeRect' && c[1] === 24);
      expect(legend[2] + legend[4]).toBeLessThan(fillsOf(calls, SKETCH_CONCEPT)[0][3] - 26);

      const clear = recordingContext();
      drawSketch(clear.ctx, model(), { map: {}, logo: null });
      expect(clear.calls.some((c) => c[0] === 'fillText' && String(c[1]).startsWith('In a no-mist zone'))).toBe(false);
      expect(clear.calls.some((c) => c[0] === 'fillText' && c[1] === '!')).toBe(false);
    });
  });
});
