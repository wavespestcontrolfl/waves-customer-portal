// @vitest-environment jsdom
// The Bed line tool (risers about every 10 ft), the pump load notices, the pump cabinet and its distance to the nearest line,
// and the pump being required before a layout can be saved (GATE_MISTING_LAYOUT_DESIGNER).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeBedRisers } from '../../lib/mistingLayoutBeds';
import { pxToFeet } from '../tech/treatmentZoneSpray';

const loadBestMapImage = vi.hoisted(() => vi.fn());
vi.mock('../tech/treatmentZoneSpray', async (importOriginal) => ({ ...(await importOriginal()), loadBestMapImage }));
const adminFetch = vi.hoisted(() => vi.fn());
vi.mock('../../utils/admin-fetch', () => ({ adminFetch }));
const composeSketchPng = vi.hoisted(() => vi.fn());
vi.mock('../../lib/mistingLayoutSketchCanvas', () => ({ composeSketchPng }));
vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');

const { default: MistingLayoutDesigner } = await import('./MistingLayoutDesigner');

const LAT = 26.95;
const LNG = -82.4;
const FRAME = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 };

if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  };
}

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({ layout: null });
  composeSketchPng.mockReset();
  composeSketchPng.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  loadBestMapImage.mockReset();
  loadBestMapImage.mockImplementation(async (_lat, _lng, _key, zooms) => ({ image: {}, url: `https://maps.example/z${zooms[0]}.png`, zoom: zooms[0] }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => FRAME);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function open(extra = {}) {
  render(<MistingLayoutDesigner address="500 Example Court" lat={LAT} lng={LNG} estimateId="est-1" onClose={() => {}} {...extra} />);
  return screen.findByTestId('layout-map');
}
const tap = (frame, x, y) => {
  fireEvent.pointerDown(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
  fireEvent.pointerUp(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
};
const drag = (frame, from, to, pointerId = 2) => {
  fireEvent.pointerDown(frame, { clientX: from.x, clientY: from.y, pointerId, button: 0 });
  fireEvent.pointerMove(frame, { clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2, pointerId });
  fireEvent.pointerMove(frame, { clientX: to.x, clientY: to.y, pointerId });
  fireEvent.pointerUp(frame, { clientX: to.x, clientY: to.y, pointerId, button: 0 });
};
const tool = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const counts = () => screen.getByTestId('layout-counts').textContent;
const risers = () => screen.queryAllByTestId('layout-riser');
const riserXY = (el) => [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))];
const nozzles = () => screen.queryAllByTestId('layout-nozzle');
const stepOut = async (times) => {
  for (let i = 0; i < times; i += 1) {
    const before = screen.getByTestId('layout-zoom').textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(screen.getByTestId('layout-zoom').textContent).not.toBe(before));
  }
};

// A bed line at zoom 21, from css (100, 100) to (300, 100): map (200, 200) to (600, 200).
async function drawBed(frame) {
  tool('Bed line');
  tap(frame, 100, 100);
  tap(frame, 300, 100);
  fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
}
// A layout needs at least one nozzle, so a saved one has an eave line too.
async function drawEave(frame) {
  tool('Eave line');
  tap(frame, 100, 60);
  tap(frame, 300, 60);
  fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
}
const bedAuto = () => placeBedRisers([{ id: 'x', kind: 'bed', points: [{ x: 200, y: 200 }, { x: 600, y: 200 }] }], { lat: LAT, zoom: 21 });

describe('the Bed line tool', () => {
  it('places risers along the bed, at both ends and about every 10 ft, and no nozzles', async () => {
    const frame = await open();
    await drawBed(frame);
    const expected = bedAuto();
    expect(expected.length).toBeGreaterThan(3);
    expect(risers()).toHaveLength(expected.length);
    expect(nozzles()).toHaveLength(0);
    const xs = risers().map((r) => riserXY(r)[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(200, 6);
    expect(xs[xs.length - 1]).toBeCloseTo(600, 6);
    for (let i = 1; i < xs.length; i += 1) expect(pxToFeet(xs[i] - xs[i - 1], LAT, 21)).toBeLessThanOrEqual(10 + 1e-6);
    expect(counts()).toContain(`Risers: ${expected.length}`);
    expect(counts()).toContain('Nozzles: 0');
    expect(counts()).toMatch(/Line: 0 ft \(eave 0 ft, fence 0 ft\)/); // a bed is not eave or fence length
    expect(screen.getByTestId('layout-line-bed')).toBeInTheDocument();
    expect(screen.queryByTestId('layout-line-eave')).not.toBeInTheDocument();
  });

  it('draws the bed line apart from the mist trace: thin, dashed, copper', async () => {
    const frame = await open();
    await drawBed(frame);
    const strokes = [...screen.getByTestId('layout-line-bed').querySelectorAll('polyline')];
    expect(strokes).toHaveLength(2);
    expect(strokes[1].getAttribute('stroke')).toBe('#b87333');
    expect(strokes[1].getAttribute('stroke-dasharray')).toBeTruthy();
    expect(Number(strokes[1].getAttribute('stroke-width'))).toBeLessThan(5);
  });

  it('gives each riser a spray: a still mist wedge for every riser, from the same default aim and the same 10 ft throw', async () => {
    const calls = [];
    const ctx = new Proxy({}, {
      get(t, prop) { return prop in t ? t[prop] : (...args) => { calls.push([prop, ...args]); }; },
      set(t, prop, value) { t[prop] = value; return true; },
    });
    HTMLCanvasElement.prototype.getContext.mockReturnValue(ctx);
    const frame = await open();
    await drawBed(frame);
    expect(screen.getByTestId('layout-spray').getAttribute('data-mode')).toBe('animated');
    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Spray' })); // animated off: still wedges
    expect(screen.getByTestId('layout-spray').getAttribute('data-mode')).toBe('wedges');
    const wedges = calls.filter((c) => c[0] === 'arc');
    expect(wedges).toHaveLength(risers().length);
    const reach = 10 / pxToFeet(1, LAT, 21);
    wedges.forEach((c) => expect(c[3]).toBeCloseTo(reach, 6));
    // A bed along the top of the photo has the house (here, the map center) below it, so the mist goes up.
    expect(wedges.every((c) => Math.abs(Math.atan2(Math.sin((c[4] + c[5]) / 2), Math.cos((c[4] + c[5]) / 2)) + Math.PI / 2) < 1e-6)).toBe(true);
  });

  it('a bed line next to an eave line leaves the eave\'s nozzles alone and the Add nozzle tool off the bed', async () => {
    const frame = await open();
    tool('Eave line');
    tap(frame, 100, 60);
    tap(frame, 300, 60);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const before = nozzles().length;
    await drawBed(frame);
    expect(nozzles()).toHaveLength(before);
    tool('Add nozzle');
    tap(frame, 200, 101); // on the bed line
    expect(nozzles()).toHaveLength(before);
    expect(screen.getByText('Tap on a drawn line to add a nozzle')).toBeInTheDocument();
  });

  it('a riser is moved or deleted like a nozzle, and a change to the lines clears that with the usual notice and Undo', async () => {
    const frame = await open();
    await drawBed(frame);
    const total = risers().length;
    tool('Riser');
    const [x1, y1] = riserXY(risers()[1]);
    drag(frame, { x: x1 / 2, y: y1 / 2 }, { x: x1 / 2 + 10, y: y1 / 2 + 20 });
    expect(risers()).toHaveLength(total);
    expect(risers().map(riserXY).some(([x, y]) => Math.abs(x - (x1 + 20)) < 0.5 && Math.abs(y - (y1 + 40)) < 0.5)).toBe(true);
    const [x2, y2] = riserXY(risers()[0]);
    tap(frame, x2 / 2, y2 / 2);
    expect(risers()).toHaveLength(total - 1);
    expect(counts()).toContain(`Risers: ${total - 1}`);

    // A change to the lines re-places the bed risers: the two edits are cleared, once, with Undo.
    tool('Eave line');
    tap(frame, 100, 300);
    expect(screen.getByTestId('layout-edits-cleared')).toHaveTextContent('Your 2 manual edits were cleared.');
    expect(risers()).toHaveLength(total);
    expect(risers().map(riserXY).some(([x, y]) => Math.abs(x - (x1 + 20)) < 0.5 && Math.abs(y - (y1 + 40)) < 0.5)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the previous lines and edits' }));
    expect(risers()).toHaveLength(total - 1);
    expect(risers().map(riserXY).some(([x, y]) => Math.abs(x - (x1 + 20)) < 0.5 && Math.abs(y - (y1 + 40)) < 0.5)).toBe(true);
  });

  it('a riser dropped with the Riser tool stays when the lines change, and counts with the bed risers', async () => {
    const frame = await open();
    await drawBed(frame);
    const bed = risers().length;
    tool('Riser');
    tap(frame, 150, 250);
    expect(risers()).toHaveLength(bed + 1);
    tool('Bed line');
    tap(frame, 100, 300);
    tap(frame, 300, 300);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(risers().length).toBeGreaterThan(bed + 1);
    expect(risers().some((r) => Math.abs(riserXY(r)[0] - 300) < 0.5 && Math.abs(riserXY(r)[1] - 500) < 0.5)).toBe(true);
    expect(screen.getByRole('button', { name: 'Clear risers, zones and pump' })).toBeEnabled();
  });
});

describe('pump load', () => {
  it('shows "Pump load: N of 60" with nozzles plus risers, and nothing more up to 60', async () => {
    const frame = await open();
    await drawBed(frame);
    tool('Eave line');
    tap(frame, 100, 60);
    tap(frame, 300, 60);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const load = nozzles().length + risers().length;
    expect(counts()).toContain(`Pump load: ${load} of 60`);
    expect(screen.queryByTestId('layout-pump-notice')).not.toBeInTheDocument();
  });

  it('over 60 an amber notice names the Zone Kit, and over 120 a red one says a second system', async () => {
    const frame = await open();
    await stepOut(3); // zoom 18: 1 px is about 0.9 ft, so a long bed line takes many risers
    tool('Bed line');
    tap(frame, 20, 100);
    tap(frame, 420, 100); // about 700 ft: about 71 risers at 10 ft
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const load = () => Number(/Pump load: (\d+) of 60/.exec(counts())[1]);
    expect(load()).toBeGreaterThan(60);
    expect(load()).toBeLessThanOrEqual(120);
    const amber = screen.getByTestId('layout-pump-notice');
    expect(amber).toHaveTextContent('Over 60 nozzles: needs a Pynamite Zone Kit (up to 120)');
    expect(amber.dataset.level).toBe('amber');

    tool('Bed line');
    tap(frame, 20, 200);
    tap(frame, 420, 200);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(load()).toBeGreaterThan(120);
    const red = screen.getByTestId('layout-pump-notice');
    expect(red).toHaveTextContent('Over 120 nozzles: needs a second system');
    expect(red.dataset.level).toBe('red');
    expect(red.className).toContain('text-alert-fg');
    // Taking some away takes the notice with it.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByTestId('layout-pump-notice').dataset.level).toBe('amber');
  });
});

describe('the pump', () => {
  it('is drawn as a cabinet, labeled Pump, and Pump to nearest line appears once it is placed', async () => {
    const frame = await open();
    await drawBed(frame);
    expect(counts()).not.toContain('Pump to nearest line');
    tool('Pump');
    tap(frame, 200, 160); // 160 map px down the photo: 120 px under the line (map y 200)
    const pump = screen.getByTestId('layout-pump');
    const rects = pump.querySelectorAll('rect');
    expect(rects[0].getAttribute('fill')).toBe('#d8c59b'); // the tan body
    expect(rects[1].getAttribute('fill')).toBe('#9a7f46'); // the darker lid
    expect(rects[0].getAttribute('width')).toBe('34');
    expect(pump.textContent).toBe('Pump');
    const feet = Math.round(pxToFeet(120, LAT, 21));
    expect(counts()).toContain(`Pump to nearest line: ${feet} ft`);
    // Moving it updates the distance.
    tap(frame, 200, 120);
    expect(counts()).toContain(`Pump to nearest line: ${Math.round(pxToFeet(40, LAT, 21))} ft`);
  });

  it('measures to the nearest of eave, fence and bed lines, and says nothing with no line drawn', async () => {
    const frame = await open();
    tool('Pump');
    tap(frame, 300, 300);
    expect(counts()).toContain('Pump: placed');
    expect(counts()).not.toContain('Pump to nearest line');
    tool('Fence line');
    tap(frame, 100, 100);
    tap(frame, 500, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(counts()).toContain(`Pump to nearest line: ${Math.round(pxToFeet(400, LAT, 21))} ft`);
    await drawBed(frame); // a bed line at y = 100 css too (map 200): same distance
    tool('Bed line');
    tap(frame, 100, 270);
    tap(frame, 500, 270); // 30 css px = 60 map px above the pump
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(counts()).toContain(`Pump to nearest line: ${Math.round(pxToFeet(60, LAT, 21))} ft`);
  });

  it('is required: Save layout stays off and says "Place the pump first" until it is placed', async () => {
    const frame = await open();
    await drawBed(frame);
    await drawEave(frame);
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled();
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Place the pump first');
    tool('Pump');
    tap(frame, 200, 160);
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeEnabled();
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
    const put = adminFetch.mock.calls.find(([, o]) => o && o.method === 'PUT');
    const sent = JSON.parse(put[1].body.get('payload'));
    expect(sent.pump).toEqual({ x: 400, y: 320 });
    expect(sent.lines.map((l) => l.kind)).toEqual(['bed', 'eave']);
    expect(sent.nozzles.every((n) => n.lineIndex === 1)).toBe(true); // the bed line carries none
    expect(sent.risers.length).toBeGreaterThan(3);
    expect(sent.risers.every((r) => r.source === 'bed')).toBe(true);
  });
});

describe('a saved bed reopens', () => {
  it('re-derives the bed risers and puts the edits back exactly', async () => {
    const frame = await open();
    await drawBed(frame);
    await drawEave(frame);
    tool('Riser');
    const first = risers().map(riserXY);
    tap(frame, first[1][0] / 2, first[1][1] / 2); // delete one
    drag(frame, { x: first[3][0] / 2, y: first[3][1] / 2 }, { x: first[3][0] / 2 + 5, y: first[3][1] / 2 + 15 }); // move one
    tap(frame, 400, 400); // and add a manual one
    tool('Pump');
    tap(frame, 200, 160);
    const finals = risers().map(riserXY).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).sort();
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
    const sent = JSON.parse(adminFetch.mock.calls.find(([, o]) => o && o.method === 'PUT')[1].body.get('payload'));
    expect(sent.risers.filter((r) => r.source === 'manual')).toHaveLength(1);

    cleanup();
    adminFetch.mockReset();
    adminFetch.mockResolvedValue({ layout: { ...sent, id: 'lay-1', savedAt: '2026-10-26T15:30:00Z', counts: {} } });
    await open();
    await waitFor(() => expect(risers().length).toBe(sent.risers.length));
    expect(risers().map(riserXY).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).sort()).toEqual(finals);
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent(/^Saved /);
    expect(nozzles().length).toBeGreaterThan(0);
    expect(nozzles().every((n) => n.getAttribute('cy') === '120')).toBe(true); // all on the eave line, none on the bed
  });
});
