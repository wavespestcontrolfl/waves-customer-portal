// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MAP_HEIGHT } from '../components/tech/treatmentZoneSpray';
import { SKETCH_ATTRIBUTION_H, SKETCH_CONCEPT, SKETCH_HEIGHT, SKETCH_WIDTH, buildSketchModel } from './mistingLayoutSketch';
import { MIST_WEDGE_FILL } from './mistingLayoutMistDraw';
import { drawSketch, glassPanelRects } from './mistingLayoutSketchCanvas';

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
  it('draws the photo across the whole frame, with the logo and every label the sketch promises', () => {
    const { ctx, calls } = recordingContext();
    const map = { name: 'map' };
    const logo = { name: 'logo' };
    drawSketch(ctx, model(), { map, logo });

    const images = calls.filter((c) => c[0] === 'drawImage');
    expect(images.find((c) => c[1] === map)).toEqual(['drawImage', map, 0, 0, SKETCH_WIDTH, MAP_HEIGHT]);
    expect(SKETCH_HEIGHT).toBe(MAP_HEIGHT);
    expect(images.find((c) => c[1] === logo)).toBeTruthy();

    const texts = calls.filter((c) => c[0] === 'fillText' || c[0] === 'strokeText').map((c) => c[1]);
    expect(texts).toContain('Proposed misting layout');
    expect(texts).toContain('500 Example Court, Venice, FL');
    expect(texts).toContain('October 26, 2026');
    expect(texts).toContain(SKETCH_CONCEPT);
    expect(texts).toContain('Nozzles: 2 (eave 2, fence 0)');
    expect(texts).toContain('Near water: 0');
    expect(texts).toContain('Pump');
    expect(texts).toContain('No mist: Pool');
    // Nozzles are numbered 1..N.
    expect(texts).toContain('1');
    expect(texts).toContain('2');
    // The scale bar names its feet.
    expect(texts.some((t) => /^\d+ ft$/.test(t))).toBe(true);
    // The key under the counts.
    expect(texts).toContain('Nozzle (number = walking order)');
    expect(texts).toContain('Arrow and mist = spray direction');
  });

  it('keeps every panel off the photo\'s bottom strip where the Google attribution sits, and off each other', () => {
    const attributionTop = SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H;
    [true, false].forEach((withLogo) => {
      const rects = Object.values(glassPanelRects(model(), withLogo));
      rects.forEach((r) => {
        expect(r.y + r.h).toBeLessThanOrEqual(attributionTop);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(SKETCH_WIDTH);
      });
      rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => {
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }));
    });
    // The tallest counts panel (every row there can be) still clears the strip.
    const full = buildSketchModel({
      lat: 26.95, zoom: 20, address: 'x', lines: [], nozzles: [{ x: 500, y: 500, kind: 'eave', lineIndex: null }],
      risers: [], pump: null, zones: [{ kind: 'pool', x: 500, y: 500, radiusFt: 15, radiusPx: 60 }], totals: { eaveCount: 1, fenceCount: 0, linearFt: 0 },
    });
    expect(full.legend).toHaveLength(7);
    const counts = glassPanelRects(full, true).counts;
    expect(counts.y + counts.h).toBeLessThanOrEqual(attributionTop);
  });

  it('draws nothing over the strip after the photo: every fill and clear of a rectangle ends above it', () => {
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, model(), { map: {}, logo: null });
    const attributionTop = SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H;
    const rects = calls.filter((c) => c[0] === 'fillRect' && !(c[3] === 28 && c[4] === 28) && !(c[3] === 18 && c[4] === 18));
    expect(rects.length).toBeGreaterThan(0);
    rects.forEach((c) => expect(c[2] + c[4]).toBeLessThanOrEqual(attributionTop));
  });

  it('draws the pump as one square and the glass panels as rounded boxes', () => {
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, model(), { map: {}, logo: null });
    expect(calls.filter((c) => c[0] === 'fillRect' && c[3] === 28 && c[4] === 28)).toHaveLength(1);
    // Four panels: title, counts and key, concept note, scale bar. Each has a body and a border path.
    expect(calls.filter((c) => c[0] === 'arcTo')).toHaveLength(4 * 2 * 4);
  });

  it('blurs the photo behind the panels when the canvas can, and tints them when it cannot', () => {
    const plain = recordingContext();
    drawSketch(plain.ctx, model(), { map: { name: 'map' }, logo: null });
    expect(plain.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(1); // no blur: only the photo itself

    const calls = [];
    const target = { filter: 'none', measureText: (t) => ({ width: String(t).length * 14 }) };
    const blurring = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop];
        return (...args) => { calls.push([prop, ...args, t.filter]); };
      },
      set(t, prop, value) { t[prop] = value; return true; },
    });
    const map = { name: 'map' };
    drawSketch(blurring, model(), { map, logo: null });
    const blurred = calls.filter((c) => c[0] === 'drawImage' && c[1] === map && /blur/.test(c[c.length - 1]));
    expect(blurred).toHaveLength(4);
    expect(target.filter).toBe('none'); // left off for everything after
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
    // ... nor on a glass panel, nor in the attribution strip.
    const panels = Object.values(glassPanelRects(crowded, false));
    labels.forEach((l) => {
      panels.forEach((r) => expect(l.x0 < r.x + r.w && r.x < l.x1 && l.y0 < r.y + r.h && r.y < l.y1).toBe(false));
      expect(l.y1).toBeLessThanOrEqual(SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H);
    });
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
      expect(discFills).toEqual([[100, '#0b6fb8'], [500, '#f59e0b']]);
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
      expect(fillsOf(calls, 'Near water: 1')).toHaveLength(1); // the nozzle in the pool is within 30 ft of its edge

      const clear = recordingContext();
      drawSketch(clear.ctx, model(), { map: {}, logo: null });
      expect(clear.calls.some((c) => c[0] === 'fillText' && String(c[1]).startsWith('In a no-mist zone'))).toBe(false);
      expect(clear.calls.some((c) => c[0] === 'fillText' && c[1] === '!')).toBe(false);
    });
  });

  describe('spray direction', () => {
    // A single wall, so every nozzle faces the same way by default (down the photo, heading 180).
    const wall = (nozzles, zones = []) => buildSketchModel({
      lat: 26.95,
      zoom: 20,
      address: '500 Example Court, Venice, FL',
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 400, y: 200 }] }],
      nozzles,
      risers: [],
      pump: null,
      zones,
      totals: { eaveCount: nozzles.length, fenceCount: 0, linearFt: 60 },
    });
    const at = (x, extra = {}) => ({ x, y: 200, kind: 'eave', lineIndex: 0, ...extra });

    function styleContext() {
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
    const WEDGE = MIST_WEDGE_FILL;
    const wedgeRadii = (calls) => calls.flatMap((c, i) => (c[0] === 'arc' && calls[i + 2] && calls[i + 2][0] === 'fill' && calls[i + 2][1] === WEDGE ? [c[3]] : []));

    it('gives every nozzle an arrow and a mist wedge, as long as its throw', () => {
      const { ctx, calls } = styleContext();
      const m = wall([at(100), at(250), at(400)]);
      drawSketch(ctx, m, { map: {}, logo: null });
      const radii = wedgeRadii(calls);
      expect(radii).toHaveLength(3);
      radii.forEach((r) => expect(r).toBeCloseTo(m.nozzles[0].reachPx, 5));
      // 10 ft of throw in sketch pixels: the same px-to-feet math as the scale bar.
      expect(m.nozzles[0].reachPx * (m.scale.feet / m.scale.px)).toBeCloseTo(10, 5);
      // Sky-blue arrowheads: one per nozzle, and one in the key.
      expect(calls.filter((c) => c[0] === 'fill' && c[1] === '#7dd3fc')).toHaveLength(3 + 1);
    });

    it('points each arrow along the nozzle\'s aim: the default away from the house, or a manual aim', () => {
      const { ctx, calls } = styleContext();
      drawSketch(ctx, wall([at(100), at(400, { aim: 90 })]), { map: {}, logo: null });
      // Shaft end = nozzle + 30 px (the 40 px arrow less its 10 px head) along the heading.
      const shaftEnds = calls.filter((c) => c[0] === 'lineTo').map((c) => [Math.round(c[1]), Math.round(c[2])]);
      expect(shaftEnds).toContainEqual([100, 230]); // default heading 180: straight down the photo
      expect(shaftEnds).toContainEqual([430, 200]); // manual heading 90: to the right
    });

    it('draws a near-water nozzle amber with an amber arrow and half the throw, but no zone ring', () => {
      const { ctx, calls } = styleContext();
      const pool = { kind: 'pool', x: 100, y: 120, radiusFt: 15, radiusPx: 69 };
      const m = wall([at(100), at(400)], [pool]);
      expect(m.nozzles.map((n) => n.nearWater)).toEqual([true, false]);
      expect(m.nozzles[0].flagged).toBe(false);
      drawSketch(ctx, m, { map: {}, logo: null });
      const discFills = calls
        .map((c, i) => (c[0] === 'arc' && c[3] === 17 && calls[i + 1] && calls[i + 1][0] === 'fill' ? [c[1], calls[i + 1][1]] : null))
        .filter(Boolean);
      expect(discFills).toEqual([[100, '#f59e0b'], [400, '#0b6fb8']]);
      expect(calls.filter((c) => c[0] === 'fill' && c[1] === '#fbbf24').length).toBeGreaterThanOrEqual(1);
      expect(calls.filter((c) => c[0] === 'arc' && c[3] === 24)).toHaveLength(0);
      expect(calls.filter((c) => c[0] === 'fillText' && c[1] === '!')).toHaveLength(0);
      const radii = wedgeRadii(calls);
      expect(radii[0]).toBeCloseTo(radii[1] / 2, 5);
    });

    it('lists the near-water count with the other counts', () => {
      const pool = { kind: 'pool', x: 100, y: 120, radiusFt: 15, radiusPx: 69 };
      const { ctx, calls } = recordingContext();
      drawSketch(ctx, wall([at(100), at(400)], [pool]), { map: {}, logo: null });
      expect(fillsOf(calls, 'Near water: 1')).toHaveLength(1);
    });
  });
});
