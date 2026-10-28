// @vitest-environment jsdom
// The designer's zoom −/+: it opens as close as the imagery goes, steps out and back, scales everything staff placed so
// it stays on the same ground, refuses a zoom in that would push a point off the photo, and a saved layout reopens at
// its saved center and zoom.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  // The photo at whichever zoom is asked for first (the real loader walks the list until one has imagery).
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
const level = () => screen.getByTestId('layout-zoom').textContent;
const zoomIn = () => screen.getByRole('button', { name: 'Zoom in' });
const zoomOut = () => screen.getByRole('button', { name: 'Zoom out' });
const dots = () => screen.getAllByTestId('layout-nozzle').map((n) => [Number(n.getAttribute('cx')), Number(n.getAttribute('cy'))]);
const arrows = () => screen.queryAllByTestId('layout-aim');
const photo = () => screen.getByRole('img', { name: /Satellite view/ }).getAttribute('src');
const stepped = async (button, to) => {
  fireEvent.click(button);
  await waitFor(() => expect(level()).toBe(`Zoom ${to}`));
};

describe('opening and stepping', () => {
  it('opens as close as the imagery goes, like the Treatment Zone Mapper, and cannot step in past it', async () => {
    await open();
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', [21, 20, 19]);
    expect(level()).toBe('Zoom 21');
    expect(photo()).toBe('https://maps.example/z21.png');
    expect(zoomIn()).toBeDisabled();
    expect(screen.getByTestId('layout-zoom-note')).toHaveTextContent('This is the closest photo there is.');
    expect(zoomOut()).toBeEnabled();
  });

  it('opens at 20 when 21 has no imagery, and steps out to 18 and no further', async () => {
    loadBestMapImage.mockImplementationOnce(async () => ({ image: {}, url: 'https://maps.example/z20.png', zoom: 20 }));
    await open();
    expect(level()).toBe('Zoom 20');
    await stepped(zoomOut(), 19);
    await stepped(zoomOut(), 18);
    expect(zoomOut()).toBeDisabled();
    expect(loadBestMapImage).toHaveBeenLastCalledWith(LAT, LNG, 'test-key', [18]);
    expect(photo()).toBe('https://maps.example/z18.png');
    await stepped(zoomIn(), 19);
    await stepped(zoomIn(), 20);
    expect(zoomIn()).toBeDisabled(); // 20 is the closest this property had
  });

  it('says so and stays where it was when the photo at the new zoom fails to load', async () => {
    await open();
    loadBestMapImage.mockRejectedValueOnce(new Error('no imagery'));
    fireEvent.click(zoomOut());
    await waitFor(() => expect(screen.getByTestId('layout-zoom-note')).toHaveTextContent('That zoom level failed to load. Try again.'));
    expect(level()).toBe('Zoom 21');
    expect(zoomOut()).toBeEnabled();
  });
});

describe('scaling the layout with the photo', () => {
  it('keeps every nozzle on the same ground: out halves its distance from the center, in brings it back', async () => {
    const frame = await open();
    tap(frame, 200, 150);
    tap(frame, 400, 150);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const before = dots();
    expect(before.length).toBeGreaterThan(2);

    await stepped(zoomOut(), 20);
    const out = dots();
    expect(out).toHaveLength(before.length); // the same 10 ft spacing on the ground, so the same nozzles
    out.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(640 + (before[i][0] - 640) / 2, 6);
      expect(y).toBeCloseTo(480 + (before[i][1] - 480) / 2, 6);
    });

    await stepped(zoomIn(), 21);
    dots().forEach(([x, y], i) => {
      expect(x).toBeCloseTo(before[i][0], 6);
      expect(y).toBeCloseTo(before[i][1], 6);
    });
  });

  it('carries manual edits across a zoom: a moved nozzle, a deleted one, a manual aim, risers, the pump and zones', async () => {
    const frame = await open();
    tap(frame, 200, 150);
    tap(frame, 400, 150);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const count = dots().length;
    fireEvent.click(screen.getByRole('button', { name: 'Riser' }));
    tap(frame, 300, 300);
    fireEvent.click(screen.getByRole('button', { name: 'Pump' }));
    tap(frame, 320, 340);
    fireEvent.click(screen.getByRole('button', { name: 'No-mist zone' }));
    tap(frame, 150, 250);

    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    const start = dots();
    // Move the first nozzle, then turn the second one by hand.
    drag(frame, { x: start[0][0] / 2, y: start[0][1] / 2 }, { x: start[0][0] / 2 + 10, y: start[0][1] / 2 + 20 });
    const tip = arrows()[1].querySelector('polygon').getAttribute('points').split(' ')[0].split(',').map(Number);
    drag(frame, { x: tip[0] / 2, y: tip[1] / 2 }, { x: start[1][0] / 2 + 30, y: start[1][1] / 2 }, 3);
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(1);
    const edited = dots();
    const risers = screen.getByTestId('layout-riser');
    const riserAt = [Number(risers.getAttribute('cx')), Number(risers.getAttribute('cy'))];
    const zoneBefore = screen.getByTestId('layout-zone').querySelector('circle');
    const radiusBefore = Number(zoneBefore.getAttribute('r'));
    const pumpBefore = screen.getByTestId('layout-pump').querySelector('rect');
    const pumpAt = [Number(pumpBefore.getAttribute('x')), Number(pumpBefore.getAttribute('y'))];

    await stepped(zoomOut(), 20);
    expect(dots()).toHaveLength(count);
    dots().forEach(([x, y], i) => {
      expect(x).toBeCloseTo(640 + (edited[i][0] - 640) / 2, 6);
      expect(y).toBeCloseTo(480 + (edited[i][1] - 480) / 2, 6);
    });
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(1); // the aim stayed with its nozzle
    const riserOut = screen.getByTestId('layout-riser');
    expect(Number(riserOut.getAttribute('cx'))).toBeCloseTo(640 + (riserAt[0] - 640) / 2, 6);
    expect(Number(screen.getByTestId('layout-pump').querySelector('rect').getAttribute('x'))).toBeCloseTo(640 + (pumpAt[0] + 17 - 640) / 2 - 17, 6);
    // The zone's radius is in feet, so on the photo it is half as wide one zoom out.
    expect(Number(screen.getByTestId('layout-zone').querySelector('circle').getAttribute('r'))).toBeCloseTo(radiusBefore / 2, 6);
  });

  it('drops the Undo notice for a line change, because its restore point is at the old scale', async () => {
    const frame = await open();
    tap(frame, 200, 150);
    tap(frame, 400, 150);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    const start = dots();
    drag(frame, { x: start[0][0] / 2, y: start[0][1] / 2 }, { x: start[0][0] / 2, y: start[0][1] / 2 + 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Eave line' }));
    tap(frame, 100, 300); // re-places the nozzles: the edit is cleared with a notice
    expect(screen.getByTestId('layout-edits-cleared')).toBeInTheDocument();
    await stepped(zoomOut(), 20);
    expect(screen.queryByTestId('layout-edits-cleared')).not.toBeInTheDocument();
  });
});

describe('refusing a zoom in that would push a point off the photo', () => {
  it('disables + with the reason while a point is too far from the center, and enables it once it is moved in', async () => {
    const frame = await open();
    await stepped(zoomOut(), 20);
    tap(frame, 40, 150); // map x = 80: 560 px left of the center, which a zoom in would double past the edge
    tap(frame, 300, 150);
    expect(zoomIn()).toBeDisabled();
    expect(screen.getByTestId('layout-zoom-note')).toHaveTextContent('Zoom in is off: a point would leave the photo.');
    expect(level()).toBe('Zoom 20');
    fireEvent.click(zoomIn()); // a click on a disabled button does nothing
    expect(level()).toBe('Zoom 20');

    // Taking the line back (Undo drops the last point, then the line) makes room again.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(zoomIn()).toBeEnabled();
    expect(screen.queryByTestId('layout-zoom-note')).not.toBeInTheDocument();
  });

  it('checks a riser, the pump and a zone too, not only the lines', async () => {
    const frame = await open();
    await stepped(zoomOut(), 20);
    fireEvent.click(screen.getByRole('button', { name: 'Pump' }));
    tap(frame, 600, 240); // map x = 1200: 560 px right of the center
    expect(zoomIn()).toBeDisabled();
    tap(frame, 330, 240); // moving the pump in lifts the refusal
    expect(zoomIn()).toBeEnabled();
  });

  it('looks again after the photo has loaded: an Undo during the load that puts a far point back cancels the zoom in', async () => {
    const frame = await open();
    await stepped(zoomOut(), 20);
    fireEvent.click(screen.getByRole('button', { name: 'Pump' }));
    tap(frame, 600, 240); // far right: a zoom in would push it off the photo
    expect(zoomIn()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear risers, zones and pump' })); // now it fits
    expect(zoomIn()).toBeEnabled();

    let release;
    loadBestMapImage.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ image: {}, url: 'https://maps.example/z21.png', zoom: 21 }); }));
    fireEvent.click(zoomIn());
    await waitFor(() => expect(release).toBeTypeOf('function'));
    // While the photo loads, the restore button puts the pump back where it was.
    fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the cleared risers, zones and pump' }));
    release();
    await waitFor(() => expect(zoomOut()).toBeEnabled()); // the busy state ended
    expect(level()).toBe('Zoom 20'); // not applied
    expect(photo()).toBe('https://maps.example/z20.png');
    expect(screen.getByTestId('layout-pump')).toBeInTheDocument(); // and the pump is not off the photo
    expect(zoomIn()).toBeDisabled();
    expect(screen.getByTestId('layout-zoom-note')).toHaveTextContent('Zoom in is off: a point would leave the photo.');
  });

  it('a zoom out is never refused', async () => {
    const frame = await open();
    tap(frame, 5, 5);
    tap(frame, 635, 475);
    await stepped(zoomOut(), 20);
    await stepped(zoomOut(), 19);
  });
});

describe('a saved layout', () => {
  it('reopens at its saved center and zoom, on its own photo, with its nozzles where they were saved', async () => {
    const saved = {
      id: 'lay-1', savedAt: '2026-10-26T15:00:00Z', address: '500 Example Court', center: { lat: LAT, lng: LNG }, zoom: 20,
      mapWidth: 1280, mapHeight: 960, counts: {},
      lines: [{ id: 'L1', kind: 'eave', points: [{ x: 300, y: 300 }, { x: 700, y: 300 }] }],
      nozzles: [{ x: 300, y: 300, kind: 'eave', lineIndex: 0 }, { x: 700, y: 300, kind: 'eave', lineIndex: 0 }],
      risers: [], pump: null, zones: [],
    };
    adminFetch.mockResolvedValue({ layout: saved });
    await open();
    await waitFor(() => expect(dots()).toHaveLength(2));
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', [20]); // not the 21, 20, 19 walk
    expect(level()).toBe('Zoom 20');
    expect(photo()).toBe('https://maps.example/z20.png');
    expect(dots()).toEqual([[300, 300], [700, 300]]);
    expect(zoomIn()).toBeDisabled(); // it reopens at its closest; out and back works
    await stepped(zoomOut(), 19);
    expect(dots()).toEqual([[470, 390], [670, 390]]);
    await stepped(zoomIn(), 20);
    expect(dots()).toEqual([[300, 300], [700, 300]]);
  });

  it('saves the zoom it is at, with the lines scaled to it', async () => {
    const frame = await open();
    tap(frame, 200, 150);
    tap(frame, 400, 150);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    await stepped(zoomOut(), 20);
    fireEvent.click(screen.getByRole('button', { name: 'Pump' }));
    tap(frame, 320, 360);
    within(screen.getByTestId('layout-pump-checklist')).getAllByRole('checkbox').forEach((box) => fireEvent.click(box));
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
    const put = adminFetch.mock.calls.find(([, o]) => o && o.method === 'PUT');
    const sent = JSON.parse(put[1].body.get('payload'));
    expect(sent.zoom).toBe(20);
    // Drawn at zoom 21 as (400, 300) and (800, 300); one step out halves their distance from the center (640, 480).
    expect(sent.lines[0].points).toEqual([{ x: 520, y: 390 }, { x: 720, y: 390 }]);
    expect(composeSketchPng.mock.calls[0][0].mapUrl).toBe('https://maps.example/z20.png');
  });
});
