// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { MAP_HEIGHT } from '../components/tech/treatmentZoneSpray';
import { SKETCH_ATTRIBUTION_H, SKETCH_HEIGHT, SKETCH_WIDTH, buildSketchModel } from './mistingLayoutSketch';
import { MIST_WEDGE_FILL } from './mistingLayoutMistDraw';
import { drawSketch, scaleBarRect } from './mistingLayoutSketchCanvas';

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
  lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }],
  nozzles: [{ x: 400, y: 100, kind: 'eave', lineIndex: 0 }, { x: 100, y: 100, kind: 'eave', lineIndex: 0 }],
  risers: [{ x: 250, y: 300 }],
  pump: { x: 600, y: 300 },
  zones: [{ kind: 'pool', x: 500, y: 500, radiusFt: 15, radiusPx: 60 }],
});

describe('drawSketch', () => {
  it('draws the photo across the whole frame, then the marks, and no title, legend, counts or note on it', () => {
    const { ctx, calls } = recordingContext();
    const map = { name: 'map' };
    drawSketch(ctx, model(), { map });

    const images = calls.filter((c) => c[0] === 'drawImage');
    expect(images).toEqual([['drawImage', map, 0, 0, SKETCH_WIDTH, MAP_HEIGHT]]);
    expect(SKETCH_HEIGHT).toBe(MAP_HEIGHT);

    const texts = calls.filter((c) => c[0] === 'fillText' || c[0] === 'strokeText').map((c) => c[1]);
    // What the drawing itself says: nozzle numbers, zone and pump labels, the scale.
    expect(texts).toContain('1');
    expect(texts).toContain('2');
    expect(texts).toContain('Pump');
    expect(texts).toContain('No mist: Pool');
    expect(texts.some((t) => /^\d+ ft$/.test(t))).toBe(true);
    // Everything else belongs to the estimate document's card, not the picture.
    const words = texts.join(' | ');
    expect(words).not.toMatch(/Proposed misting layout|Concept layout|Nozzles:|Risers:|Near water|Line:|No-mist zones|Nozzle \(number|Arrow and mist|Example Court|2026/);
    // No glass panels: no rounded box is drawn or clipped to.
    expect(calls.filter((c) => c[0] === 'arcTo' || c[0] === 'clip')).toHaveLength(0);
    expect(calls.some((c) => c[0] === 'fillRect')).toBe(true); // the pump square
    expect(calls.filter((c) => c[0] === 'fillRect' && !(c[3] === 28 && c[4] === 28))).toHaveLength(0);
  });

  it('keeps everything of ours off the photo\'s bottom strip where the Google attribution sits', () => {
    const attributionTop = SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H;
    const m = model();
    const bar = scaleBarRect(m);
    expect(bar.y + bar.h).toBeLessThanOrEqual(attributionTop);
    expect(bar.x + bar.w).toBeLessThanOrEqual(SKETCH_WIDTH);
    // The bar's own strokes and its label stay inside that rectangle.
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, m, { map: {} });
    const label = calls.find((c) => c[0] === 'fillText' && /^\d+ ft$/.test(c[1]));
    expect(label[3] + 13).toBeLessThanOrEqual(attributionTop);
    calls.filter((c) => c[0] === 'fillRect').forEach((c) => expect(c[2] + c[4]).toBeLessThanOrEqual(attributionTop));
    // Even a crowded drawing: no label is ever placed into the strip.
    const low = buildSketchModel({
      lat: 26.95, zoom: 20,
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 300, y: 800 }, { x: 900, y: 800 }] }],
      nozzles: [{ x: 600, y: 800, kind: 'eave', lineIndex: 0 }],
      risers: [], pump: { x: 600, y: 900 }, zones: [{ kind: 'pool', x: 400, y: 880, radiusFt: 15, radiusPx: 60 }],
    });
    const lowCalls = recordingContext();
    drawSketch(lowCalls.ctx, low, { map: {} });
    ['Pump', 'No mist: Pool'].forEach((t) => {
      const [at] = fillsOf(lowCalls.calls, t);
      expect(box(at).y1).toBeLessThanOrEqual(attributionTop);
    });
  });

  it('draws the pump as one square', () => {
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, model(), { map: {} });
    expect(calls.filter((c) => c[0] === 'fillRect' && c[3] === 28 && c[4] === 28)).toHaveLength(1);
  });

  it('draws the labels after the nozzles, beside the pump when a nozzle sits under it, and never on top of each other', () => {
    const crowded = buildSketchModel({
      lat: 26.95,
      zoom: 20,
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
    });
    const { ctx, calls } = recordingContext();
    drawSketch(ctx, crowded, { map: {} });

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
    // ... nor on the scale bar, nor in the attribution strip.
    const bar = scaleBarRect(crowded);
    labels.forEach((l) => {
      expect(l.x0 < bar.x + bar.w && bar.x < l.x1 && l.y0 < bar.y + bar.h && bar.y < l.y1).toBe(false);
      expect(l.y1).toBeLessThanOrEqual(SKETCH_HEIGHT - SKETCH_ATTRIBUTION_H);
    });
  });

  describe('nozzles inside a no-mist zone', () => {
    const flaggedModel = () => buildSketchModel({
      lat: 26.95,
      zoom: 20,
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 500 }, { x: 900, y: 500 }] }],
      // Left nozzle is clear; the middle one sits at the pool's center.
      nozzles: [{ x: 100, y: 500, kind: 'eave', lineIndex: 0 }, { x: 500, y: 500, kind: 'eave', lineIndex: 0 }],
      risers: [],
      pump: null,
      zones: [{ kind: 'pool', x: 500, y: 500, radiusFt: 15, radiusPx: 60 }],
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
      drawSketch(ctx, flaggedModel(), { map: {} });
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

    it('draws the ring and the "!" for a nozzle in a zone only, and prints no legend row for it', () => {
      const { ctx, calls } = recordingContext();
      drawSketch(ctx, flaggedModel(), { map: {} });
      expect(calls.filter((c) => c[0] === 'fillText' && c[1] === '!')).toHaveLength(1);
      expect(calls.some((c) => c[0] === 'fillText' && /no-mist zone:|Near water:/i.test(String(c[1])))).toBe(false);

      const clear = recordingContext();
      drawSketch(clear.ctx, model(), { map: {} });
      expect(clear.calls.some((c) => c[0] === 'fillText' && c[1] === '!')).toBe(false);
    });
  });

  describe('spray direction', () => {
    // A single wall, so every nozzle faces the same way by default (down the photo, heading 180).
    const wall = (nozzles, zones = []) => buildSketchModel({
      lat: 26.95,
      zoom: 20,
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 400, y: 200 }] }],
      nozzles,
      risers: [],
      pump: null,
      zones,
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
      drawSketch(ctx, m, { map: {} });
      const radii = wedgeRadii(calls);
      expect(radii).toHaveLength(3);
      radii.forEach((r) => expect(r).toBeCloseTo(m.nozzles[0].reachPx, 5));
      // 10 ft of throw in sketch pixels: the same px-to-feet math as the scale bar.
      expect(m.nozzles[0].reachPx * (m.scale.feet / m.scale.px)).toBeCloseTo(10, 5);
      // Sky-blue arrowheads: one per nozzle.
      expect(calls.filter((c) => c[0] === 'fill' && c[1] === '#7dd3fc')).toHaveLength(3);
    });

    it('points each arrow along the nozzle\'s aim: the default away from the house, or a manual aim', () => {
      const { ctx, calls } = styleContext();
      drawSketch(ctx, wall([at(100), at(400, { aim: 90 })]), { map: {} });
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
      drawSketch(ctx, m, { map: {} });
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
  });
});
