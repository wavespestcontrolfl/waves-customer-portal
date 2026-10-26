import { describe, expect, it } from 'vitest';
import { MIST_COLOR, hexToRgb, mixWithWhite, rgba } from '../components/tech/treatmentZoneSpray';
import { MIST_TRACE_STROKES, MIST_WEDGE_FILL, drawMistPuff, drawMistWedge } from './mistingLayoutMistDraw';

// A recording context that can make gradients, so the stops can be read back.
function gradientContext() {
  const gradients = [];
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'createRadialGradient') {
        return (...args) => {
          const g = { args, stops: [], addColorStop(at, color) { this.stops.push([at, color]); } };
          gradients.push(g);
          return g;
        };
      }
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  return { ctx, gradients, calls };
}

const MIST = hexToRgb(MIST_COLOR);
const LIGHT = mixWithWhite(MIST, 0.45);
const CORE = mixWithWhite(MIST, 0.5);

describe('the Treatment Zone Mapper\'s mist look, reused', () => {
  it('uses the brand blue #0A7EC2', () => {
    expect(MIST_COLOR).toBe('#0A7EC2');
    expect(MIST).toEqual([10, 126, 194]);
  });

  it('a puff is a radial gradient: white-mixed blue core, lighter blue, then clear blue', () => {
    const { ctx, gradients, calls } = gradientContext();
    drawMistPuff(ctx, 100, 120, 9, 0.4);
    expect(gradients).toHaveLength(1);
    expect(gradients[0].args).toEqual([100, 120, 0, 100, 120, 9]);
    expect(gradients[0].stops).toEqual([
      [0, rgba(CORE, 0.4)],
      [0.55, rgba(LIGHT, 0.4 * 0.6)],
      [1, rgba(MIST, 0)],
    ]);
    expect(ctx.fillStyle).toBe(gradients[0]);
    expect(calls.find((c) => c[0] === 'arc').slice(1, 4)).toEqual([100, 120, 9]);
  });

  it('a wedge fades from the nozzle: bright blue core out to a faint blue edge', () => {
    const { ctx, gradients } = gradientContext();
    drawMistWedge(ctx, { x: 300, y: 300 }, 90, 46);
    expect(gradients[0].args).toEqual([300, 300, 0, 300, 300, 46]);
    expect(gradients[0].stops.map(([at]) => at)).toEqual([0, 0.55, 1]);
    expect(gradients[0].stops[0][1]).toBe(rgba(CORE, 0.55));
    expect(gradients[0].stops[2][1]).toBe(rgba(MIST, 0.12));
  });

  it('falls back to a flat blue where the canvas has no gradients', () => {
    const calls = [];
    const ctx = new Proxy({}, {
      get(t, prop) { return prop in t ? t[prop] : (...args) => { calls.push([prop, ...args]); }; },
      set(t, prop, value) { t[prop] = value; return true; },
    });
    drawMistWedge(ctx, { x: 1, y: 1 }, 0, 40);
    expect(ctx.fillStyle).toBe(MIST_WEDGE_FILL);
    expect(MIST_WEDGE_FILL).toBe(rgba(LIGHT, 0.3));
    drawMistPuff(ctx, 1, 1, 8, 0.5);
    expect(ctx.fillStyle).toBe(rgba(LIGHT, 0.5 * 0.6));
  });

  it('the trace is the layered glow of the pest report: 16 px soft blue, 9 px white, 4.5 px strong blue', () => {
    expect(MIST_TRACE_STROKES).toEqual([
      { width: 16, color: rgba(MIST, 0.28) },
      { width: 9, color: rgba([255, 255, 255], 0.6) },
      { width: 4.5, color: rgba(MIST, 0.92) },
    ]);
  });
});
