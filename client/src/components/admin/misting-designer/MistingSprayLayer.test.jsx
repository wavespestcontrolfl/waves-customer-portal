// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MistingSprayLayer from './MistingSprayLayer';

const LAT = 26.95;
const ZOOM = 20;
const nozzles = [{ key: 'a', x: 300, y: 300 }, { key: 'b', x: 400, y: 300 }];
const aims = new Map([
  ['a', { heading: 90, nearWater: false, throwFt: 10, manual: false }],
  ['b', { heading: 270, nearWater: true, throwFt: 5, manual: false }],
]);

let calls;
let frames;
let ctx;

beforeEach(() => {
  calls = [];
  frames = [];
  ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.hidden;
});

const setHidden = (hidden) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};
const layer = (props = {}) => (
  <MistingSprayLayer nozzles={nozzles} aims={aims} lat={LAT} zoom={ZOOM} animate wedges={false} {...props} />
);
const arcs = () => calls.filter((c) => c[0] === 'arc');

describe('MistingSprayLayer', () => {
  it('puffs mist from every nozzle on the next frames and keeps requesting frames', () => {
    render(layer());
    expect(frames).toHaveLength(1);
    frames.shift()(1000);
    expect(arcs()).toHaveLength(0); // the first frame only sets the clock
    frames.shift()(1120);
    const puffs = arcs();
    expect(puffs.length).toBe(nozzles.length);
    // Each puff leaves its nozzle along the aim: nozzle a faces right, nozzle b faces left.
    const xs = puffs.map((c) => c[1]).sort((a, b) => a - b);
    expect(xs[0]).toBeGreaterThan(300);
    expect(xs[0]).toBeLessThan(330);
    expect(xs[1]).toBeLessThan(400);
    expect(xs[1]).toBeGreaterThan(380);
    expect(frames).toHaveLength(1);
  });

  it('stops while the tab is hidden, starts again when it is shown, and stops for good when the designer closes', () => {
    const { unmount } = render(layer());
    setHidden(true);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    const before = frames.length;
    setHidden(false);
    expect(frames.length).toBe(before + 1);
    window.cancelAnimationFrame.mockClear();
    unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    setHidden(true);
    setHidden(false);
    expect(frames.length).toBe(before + 1); // nothing listens any more
  });

  it('draws no puffs when not animating: still wedges per nozzle, or nothing', () => {
    const { rerender } = render(layer({ animate: false, wedges: true }));
    expect(frames).toHaveLength(0);
    expect(calls.filter((c) => c[0] === 'fill')).toHaveLength(nozzles.length);
    // Each wedge is as long as that nozzle's throw: 10 ft, and 5 ft near water.
    const radii = arcs().map((c) => c[3]);
    expect(radii[0]).toBeCloseTo(radii[1] * 2, 5);
    calls.length = 0;
    rerender(layer({ animate: false, wedges: false }));
    expect(calls.filter((c) => c[0] === 'fill')).toHaveLength(0);
    expect(calls.some((c) => c[0] === 'clearRect')).toBe(true);
  });

  it('survives a browser with no canvas', () => {
    HTMLCanvasElement.prototype.getContext.mockReturnValue(null);
    expect(() => render(layer())).not.toThrow();
    expect(frames).toHaveLength(0);
  });
});
