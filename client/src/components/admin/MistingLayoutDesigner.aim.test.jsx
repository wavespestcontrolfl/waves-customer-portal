// @vitest-environment jsdom
// The designer's spray directions: arrows, numbers, near-water, aiming by dragging an arrow tip,
// Reset aim, the clear-on-line-change rule, the spray modes, and that a manual aim is saved and reopened.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MISTING_LEGEND_KEYS } from '../../lib/mistingLayoutCounts';
import { placeNozzles } from '../../lib/mistingLayoutGeometry';

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
const ZOOM = 20;
// 640 css px for 1280 map px: one css px is two map px.
const FRAME = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 };

if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  };
}

const matchMedia = (reduced) => (query) => ({
  matches: reduced && query.includes('prefers-reduced-motion'),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockResolvedValue({ layout: null });
  composeSketchPng.mockReset();
  composeSketchPng.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  loadBestMapImage.mockReset();
  loadBestMapImage.mockResolvedValue({ image: {}, url: 'https://maps.example/test.png', zoom: ZOOM });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => FRAME);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
const arrows = () => screen.queryAllByTestId('layout-aim');
const heading = (el) => Number(el.getAttribute('data-heading'));
const spray = () => screen.getByTestId('layout-spray').getAttribute('data-mode');

// A horizontal eave line from css (100, 100) to (300, 100): map (200, 200) to (600, 200).
async function drawLine() {
  const frame = await open();
  tap(frame, 100, 100);
  tap(frame, 300, 100);
  fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
  return frame;
}
const placed = placeNozzles([{ kind: 'eave', points: [{ x: 200, y: 200 }, { x: 600, y: 200 }] }], { lat: LAT, zoom: ZOOM });
// Nozzle 4 of the walk, in css px, and where its arrow tip is while it points down the photo (heading 180, 40 map px from the nozzle).
const middle = placed.nozzles[3];
const bodyAt = { x: middle.x / 2, y: middle.y / 2 };
const tipAt = { x: middle.x / 2, y: (middle.y + 40) / 2 };

describe('arrows and numbers', () => {
  it('draws an arrow and a walking-order number on every nozzle, and Directions hides the arrows', async () => {
    await drawLine();
    const count = screen.getAllByTestId('layout-nozzle').length;
    expect(arrows()).toHaveLength(count);
    // On a single wall every nozzle faces the same way, away from the middle of the house's points: down.
    arrows().forEach((a) => expect(heading(a)).toBeCloseTo(180, 5));
    const numbers = [...screen.getByTestId('layout-map').querySelectorAll('svg text')].map((t) => t.textContent);
    expect(numbers).toEqual(Array.from({ length: count }, (_, i) => String(i + 1)));

    const toggle = screen.getByRole('button', { name: 'Directions' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(arrows()).toHaveLength(0);
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count);
  });

  it('counts the nozzles near water, turns them amber, and aims them along the line away from the water', async () => {
    const frame = await drawLine();
    expect(screen.getByTestId('layout-counts')).toHaveTextContent('Near water: 0');
    fireEvent.click(screen.getByRole('button', { name: 'No-mist zone' }));
    tap(frame, 200, 60); // a 15 ft pool just above the middle of the line
    const near = arrows().filter((a) => a.getAttribute('data-near-water') === 'true');
    expect(near.length).toBeGreaterThan(0);
    expect(screen.getByTestId('layout-counts')).toHaveTextContent(`Near water: ${near.length}`);
    near.forEach((a) => expect([90, 270]).toContain(heading(a)));
    expect(near.some((a) => heading(a) === 90)).toBe(true);
    expect(near.some((a) => heading(a) === 270)).toBe(true);
    expect(screen.getAllByTestId('layout-nozzle').filter((n) => n.getAttribute('data-near-water') === 'true')).toHaveLength(near.length);
  });
});

describe('aiming in Edit nozzles', () => {
  const arrowOf = (index) => arrows()[index];

  it('dragging an arrow tip turns that nozzle by hand; the nozzle stays put and nothing is deleted', async () => {
    const frame = await drawLine();
    const count = arrows().length;
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    expect(arrowOf(3)).toHaveAttribute('data-manual', 'false');

    drag(frame, tipAt, { x: bodyAt.x + 30, y: bodyAt.y }); // pull the tip to the right of the nozzle
    expect(arrows()).toHaveLength(count);
    expect(heading(arrowOf(3))).toBeCloseTo(90, 5);
    expect(arrowOf(3)).toHaveAttribute('data-manual', 'true');
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count);
    expect(screen.getAllByTestId('layout-nozzle')[3]).toHaveAttribute('cx', String(middle.x));
    // The neighbours keep their automatic aim.
    expect(arrowOf(2)).toHaveAttribute('data-manual', 'false');
    expect(screen.getByTestId('layout-aim-status')).toHaveTextContent('Nozzle 4 aims 90° (set by hand)');
  });

  it('an arrow aimed along the line stops short of the next nozzle, so its tip is grabbed without touching that nozzle', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'No-mist zone' }));
    tap(frame, 200, 60); // a pool just above the middle of the line: the nozzles right of it aim right, along the line
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    const count = screen.getAllByTestId('layout-nozzle').length;
    const xsBefore = screen.getAllByTestId('layout-nozzle').map((n) => n.getAttribute('cx')).sort();

    const tipOf = (a) => a.querySelector('polygon').getAttribute('points').split(' ')[0].split(',').map(Number);
    const from = placed.nozzles[5]; // nozzle 6, one nozzle left of the next
    const along = arrows().find((a) => heading(a) === 90 && Math.abs(tipOf(a)[0] - (from.x + 26)) < 0.5);
    expect(along).toBeTruthy(); // 26 px long (the minimum), not 40: half the 44 px to the next nozzle, but not shorter than its head
    expect(tipOf(along)[1]).toBeCloseTo(from.y, 5);

    const tip = { x: tipOf(along)[0] / 2, y: tipOf(along)[1] / 2 };
    tap(frame, tip.x, tip.y); // a tap on the tip selects; it does not delete the neighbour 19 px away
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count);
    expect(screen.getByTestId('layout-aim-status')).toHaveTextContent('Nozzle 6 aims 90° (automatic)');

    drag(frame, tip, { x: from.x / 2, y: from.y / 2 - 20 }, 4); // pull it straight up
    expect(screen.getAllByTestId('layout-nozzle').map((n) => n.getAttribute('cx')).sort()).toEqual(xsBefore); // nobody moved
    expect(screen.getByTestId('layout-aim-status')).toHaveTextContent('Nozzle 6 aims 0° (set by hand)');
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(1);
  });

  it('a press nearer a nozzle body than the tip beside it takes the body: it still deletes that nozzle', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'No-mist zone' }));
    tap(frame, 200, 60);
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    const count = screen.getAllByTestId('layout-nozzle').length;
    const next = placed.nozzles[6]; // the nozzle the tip of nozzle 6 points at
    tap(frame, next.x / 2, next.y / 2);
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count - 1);
  });

  it('a tap on an arrow tip selects it and never deletes; a drag on the body still moves the nozzle', async () => {
    const frame = await drawLine();
    const count = arrows().length;
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    tap(frame, tipAt.x, tipAt.y);
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count);
    expect(screen.getByTestId('layout-aim-status')).toHaveTextContent('Nozzle 4 aims 180° (automatic)');
    expect(screen.getByRole('button', { name: 'Reset aim' })).toBeDisabled();

    drag(frame, bodyAt, { x: bodyAt.x + 20, y: bodyAt.y + 20 }, 3);
    const moved = screen.getAllByTestId('layout-nozzle').find((n) => Math.abs(Number(n.getAttribute('cx')) - (middle.x + 40)) < 1);
    expect(moved).toBeTruthy();
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(0); // moving does not aim
  });

  it('a manual aim follows its nozzle when it is moved, and Reset aim puts the automatic aim back', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    drag(frame, tipAt, { x: bodyAt.x - 30, y: bodyAt.y });
    expect(heading(arrowOf(3))).toBeCloseTo(270, 5);

    drag(frame, bodyAt, { x: bodyAt.x, y: bodyAt.y + 10 }, 3);
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true').map(heading)).toEqual([270]);

    fireEvent.click(screen.getByRole('button', { name: 'Reset aim' }));
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(0);
    arrows().forEach((a) => expect(heading(a)).toBeCloseTo(180, 5));
  });

  it('no handle is there to grab while Directions is off', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Directions' }));
    const count = screen.getAllByTestId('layout-nozzle').length;
    tap(frame, tipAt.x, tipAt.y); // empty photo now: nothing happens
    expect(screen.getAllByTestId('layout-nozzle')).toHaveLength(count);
    expect(screen.queryByTestId('layout-aim-status')).not.toBeInTheDocument();
  });

  it('a line change that re-places the nozzles clears manual aims with the other manual edits, and Undo brings them back', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    drag(frame, tipAt, { x: bodyAt.x + 30, y: bodyAt.y });
    expect(screen.queryByTestId('layout-edits-cleared')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
    tap(frame, 100, 300); // a new line point re-places the nozzles
    expect(screen.getByTestId('layout-edits-cleared')).toHaveTextContent('Your 1 manual edit was cleared.');
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the previous lines and edits' }));
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true').map(heading)).toEqual([90]);
  });

  it('Clear also drops manual aims', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    drag(frame, tipAt, { x: bodyAt.x + 30, y: bodyAt.y });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(arrows()).toHaveLength(0);
    await drawAgain(frame);
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true')).toHaveLength(0);
  });

  async function drawAgain(frame) {
    fireEvent.click(screen.getByRole('button', { name: 'Eave line' }));
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
  }
});

describe('a plain photo', () => {
  it('holds only the photo, the spray canvas and the drawing: every control, count and word sits outside it', async () => {
    const frame = await drawLine();
    expect([...frame.children].map((el) => el.tagName)).toEqual(['IMG', 'CANVAS', 'svg']);
    [
      screen.getByRole('group', { name: 'Drawing tool' }),
      screen.getByRole('group', { name: 'Preview controls' }),
      screen.getByTestId('layout-counts'),
      screen.getByTestId('layout-legend'),
      screen.getByText('Concept layout — final placement at the design visit and install.'),
    ].forEach((el) => expect(frame.contains(el)).toBe(false));
    // Nothing floats over the photo: no frosted-glass class anywhere in the designer.
    expect(document.querySelector('[class*="backdrop-blur"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Panels' })).not.toBeInTheDocument();
  });

  it('explains the marks in a legend and counts near-water nozzles beside it', async () => {
    await drawLine();
    const legend = screen.getByTestId('layout-legend');
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent)).toEqual(MISTING_LEGEND_KEYS.map((k) => k.label));
    expect(screen.getByTestId('layout-counts')).toHaveTextContent('Near water: 0');
  });
});

describe('spray modes', () => {
  it('animates by default, shows still wedges with Spray off, and nothing with Directions off too', async () => {
    await drawLine();
    expect(spray()).toBe('animated');
    expect(screen.getByRole('button', { name: 'Spray' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Spray' }));
    expect(spray()).toBe('wedges');
    fireEvent.click(screen.getByRole('button', { name: 'Directions' }));
    expect(spray()).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Spray' }));
    expect(spray()).toBe('animated');
  });

  it('with reduced motion nothing moves: Spray starts off and cannot be turned on, and the wedges show', async () => {
    vi.stubGlobal('matchMedia', matchMedia(true));
    await drawLine();
    const button = screen.getByRole('button', { name: 'Spray' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(spray()).toBe('wedges');
  });
});

describe('save and reopen', () => {
  const sentPayload = () => {
    const put = adminFetch.mock.calls.find(([, options]) => options && options.method === 'PUT');
    return JSON.parse(put[1].body.get('payload'));
  };

  it('saves the manual aim of the nozzle that was aimed and no other, and reopens it', async () => {
    const frame = await drawLine();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    drag(frame, tipAt, { x: bodyAt.x + 30, y: bodyAt.y });
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));

    const sent = sentPayload();
    expect(sent.nozzles.filter((n) => 'aim' in n)).toHaveLength(1);
    expect(sent.nozzles[3].aim).toBeCloseTo(90, 5);

    // Reopen from what the server would hand back.
    cleanup();
    adminFetch.mockReset();
    adminFetch.mockResolvedValue({ layout: { ...sent, id: 'lay-1', savedAt: '2026-10-26T15:30:00Z', counts: {} } });
    await open();
    await waitFor(() => expect(arrows().length).toBe(sent.nozzles.length));
    expect(arrows().filter((a) => a.getAttribute('data-manual') === 'true').map(heading)).toEqual([90]);
    expect(within(screen.getByTestId('layout-map')).getAllByTestId('layout-aim')[3]).toHaveAttribute('data-manual', 'true');
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent(/^Saved /);
  });

  it('sends no aim at all when nothing was aimed by hand', async () => {
    await drawLine();
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
    expect(sentPayload().nozzles.some((n) => 'aim' in n)).toBe(false);
  });
});
