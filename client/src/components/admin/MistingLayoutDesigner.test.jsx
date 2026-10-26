// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeNozzles } from '../../lib/mistingLayoutGeometry';

const loadBestMapImage = vi.hoisted(() => vi.fn());
vi.mock('../tech/treatmentZoneSpray', async (importOriginal) => ({
  ...(await importOriginal()),
  loadBestMapImage,
}));
vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');

const { default: MistingLayoutDesigner, CONCEPT_LABEL } = await import('./MistingLayoutDesigner');

const LAT = 26.95;
const LNG = -82.4;
const ZOOM = 20;

// The frame is 640 css px wide for a 1280 px map, so one css px is two map px.
const FULL_RECT = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 };
let RECT = FULL_RECT;

// jsdom has no PointerEvent; the designer reads clientX, clientY and pointerId off it.
if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  };
}

beforeEach(() => {
  RECT = { ...FULL_RECT };
  loadBestMapImage.mockReset();
  loadBestMapImage.mockResolvedValue({ image: {}, url: 'https://maps.example/test.png', zoom: ZOOM });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => RECT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.google;
});

async function open(props = {}) {
  const onUseCounts = vi.fn();
  const onClose = vi.fn();
  render(<MistingLayoutDesigner address="500 Example Court, Venice, FL" lat={LAT} lng={LNG} onUseCounts={onUseCounts} onClose={onClose} {...props} />);
  const frame = await screen.findByTestId('layout-map');
  return { frame, onUseCounts, onClose };
}

const tap = (frame, x, y) => {
  fireEvent.pointerDown(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
  fireEvent.pointerUp(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
};

const countsText = () => screen.getByTestId('layout-counts').textContent;
const nozzleCount = () => screen.queryAllByTestId('layout-nozzle').length;

// A 400 map px (200 css px) line, drawn left to right.
const EAVE_POINTS = [{ x: 200, y: 200 }, { x: 600, y: 200 }];
const expected = placeNozzles([{ kind: 'eave', points: EAVE_POINTS }], { lat: LAT, zoom: ZOOM });

describe('MistingLayoutDesigner', () => {
  it('loads the satellite photo for the property and labels the layout as a concept', async () => {
    await open();
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', expect.any(Array));
    expect(screen.getByRole('img', { name: /Satellite view of 500 Example Court/ })).toHaveAttribute('src', 'https://maps.example/test.png');
    expect(screen.getByText(CONCEPT_LABEL)).toBeInTheDocument();
    expect(CONCEPT_LABEL).toBe('Concept layout — final placement at the design visit and install.');
    expect(countsText()).toContain('Nozzles: 0');
    expect(screen.getByRole('button', { name: 'Use counts' })).toBeDisabled();
  });

  it('shows the error when the photo cannot load', async () => {
    loadBestMapImage.mockRejectedValue(new Error('The satellite photo failed to load.'));
    render(<MistingLayoutDesigner address="x" lat={LAT} lng={LNG} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The satellite photo failed to load.');
    expect(screen.queryByRole('button', { name: 'Use counts' })).not.toBeInTheDocument();
  });

  it('says what to do when the property has no location and the browser cannot geocode it', async () => {
    render(<MistingLayoutDesigner address="500 Example Court" onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/No location for this property/);
    expect(loadBestMapImage).not.toHaveBeenCalled();
  });

  it('geocodes the address in the browser when no coordinates are passed', async () => {
    window.google = {
      maps: {
        Geocoder: class {
          geocode(_req, cb) { cb([{ geometry: { location: { lat: () => LAT, lng: () => LNG } } }], 'OK'); }
        },
      },
    };
    render(<MistingLayoutDesigner address="500 Example Court" onClose={() => {}} />);
    await screen.findByTestId('layout-map');
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', expect.any(Array));
  });

  it('places nozzles live as an eave line is drawn and writes the count on Use counts', async () => {
    const { frame, onUseCounts, onClose } = await open();
    tap(frame, 100, 100);
    expect(nozzleCount()).toBe(1);
    tap(frame, 300, 100);
    expect(nozzleCount()).toBe(expected.totals.count);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(nozzleCount()).toBe(expected.totals.count);
    expect(countsText()).toContain(`Nozzles: ${expected.totals.count}`);
    expect(countsText()).toContain(`eave ${expected.totals.count}, fence 0`);
    expect(countsText()).toMatch(/Line: \d+ ft/);

    fireEvent.click(screen.getByRole('button', { name: 'Use counts' }));
    expect(onUseCounts).toHaveBeenCalledWith(expected.totals.count);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ends a line when the last point is tapped again, and keeps fence nozzles apart from eave nozzles', async () => {
    const { frame } = await open();
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    tap(frame, 300, 100); // double tap on the last point finishes the eave line
    fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
    tap(frame, 100, 300);
    tap(frame, 300, 300);
    tap(frame, 300, 300);
    expect(screen.getAllByTestId('layout-nozzle').filter((n) => n.dataset.kind === 'eave')).toHaveLength(expected.totals.count);
    expect(screen.getAllByTestId('layout-nozzle').filter((n) => n.dataset.kind === 'fence')).toHaveLength(expected.totals.count);
    expect(countsText()).toContain(`Nozzles: ${expected.totals.count * 2}`);
    expect(countsText()).toContain(`fence ${expected.totals.count}`);
  });

  it('closes a loop when the first point is tapped again', async () => {
    const { frame } = await open();
    [[100, 100], [300, 100], [300, 250]].forEach(([x, y]) => tap(frame, x, y));
    tap(frame, 100, 100);
    const closed = placeNozzles([{
      kind: 'eave',
      points: [{ x: 200, y: 200 }, { x: 600, y: 200 }, { x: 600, y: 500 }, { x: 200, y: 200 }],
    }], { lat: LAT, zoom: ZOOM });
    expect(nozzleCount()).toBe(closed.totals.count);
    expect(screen.getByRole('button', { name: 'Finish line' })).toBeDisabled(); // nothing left in progress
  });

  it('undoes the last point, then the last line, and clears everything', async () => {
    const { frame } = await open();
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(nozzleCount()).toBe(1);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(nozzleCount()).toBe(0);
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(nozzleCount()).toBe(0);
    expect(countsText()).toContain('Nozzles: 0');
  });

  it('deletes a nozzle on tap, adds one on a line tap, and moves one by dragging', async () => {
    const { frame, onUseCounts } = await open();
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    const total = expected.totals.count;
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));

    // delete: the first corner is at css (100, 100)
    tap(frame, 100, 100);
    expect(nozzleCount()).toBe(total - 1);

    // Edit nozzles: a tap that is not on a nozzle does nothing, even on a line
    const xs = screen.getAllByTestId('layout-nozzle').map((n) => Number(n.getAttribute('cx'))).sort((a, b) => a - b);
    const wanted = (xs[2] + xs[3]) / 2;
    tap(frame, wanted / 2, 101);
    expect(nozzleCount()).toBe(total - 1);

    // add: Add nozzle, a tap on the line midway between two neighbouring nozzles
    fireEvent.click(screen.getByRole('button', { name: 'Add nozzle' }));
    tap(frame, wanted / 2, 101);
    expect(nozzleCount()).toBe(total);
    const added = screen.getAllByTestId('layout-nozzle').find((n) => Math.abs(Number(n.getAttribute('cx')) - wanted) < 1);
    expect(added).toBeTruthy();

    // a tap away from every line adds nothing and says where to tap
    tap(frame, 400, 400);
    expect(nozzleCount()).toBe(total);
    expect(screen.getByText('Tap on a drawn line to add a nozzle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    expect(screen.queryByText('Tap on a drawn line to add a nozzle')).not.toBeInTheDocument();

    // drag the last corner (css 300, 100) to (320, 140)
    fireEvent.pointerDown(frame, { clientX: 300, clientY: 100, pointerId: 2, button: 0 });
    fireEvent.pointerMove(frame, { clientX: 310, clientY: 120, pointerId: 2 });
    fireEvent.pointerMove(frame, { clientX: 320, clientY: 140, pointerId: 2 });
    fireEvent.pointerUp(frame, { clientX: 320, clientY: 140, pointerId: 2, button: 0 });
    expect(nozzleCount()).toBe(total); // a drag moves, never deletes
    const moved = screen.getAllByTestId('layout-nozzle').find((n) => Math.abs(Number(n.getAttribute('cx')) - 640) < 1);
    expect(moved).toBeTruthy();
    expect(Number(moved.getAttribute('cy'))).toBeCloseTo(280, 0);

    fireEvent.click(screen.getByRole('button', { name: 'Use counts' }));
    expect(onUseCounts).toHaveBeenCalledWith(total);
  });

  it('still adds between nozzles and deletes on a nozzle on a small phone-width map at the zoom-19 fallback', async () => {
    // 320 css px for 1280 map px: one css px is four map px. At zoom 19 a 10 ft gap is ~6 css px.
    RECT = { left: 0, top: 0, width: 320, height: 240, right: 320, bottom: 240, x: 0, y: 0 };
    loadBestMapImage.mockResolvedValue({ image: {}, url: 'https://maps.example/test.png', zoom: 19 });
    const { frame } = await open();
    tap(frame, 20, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    const total = nozzleCount();
    const xs = () => screen.getAllByTestId('layout-nozzle').map((n) => Number(n.getAttribute('cx'))).sort((a, b) => a - b);
    const gap = xs()[3] - xs()[2];
    expect(gap / 4).toBeLessThan(8); // the nozzles really are crowded on screen

    // Add nozzle: midway between two nozzles adds one
    fireEvent.click(screen.getByRole('button', { name: 'Add nozzle' }));
    tap(frame, (xs()[2] + xs()[3]) / 2 / 4, 100);
    expect(nozzleCount()).toBe(total + 1);

    // Edit nozzles: exactly on a nozzle deletes it
    fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
    tap(frame, xs()[6] / 4, 100);
    expect(nozzleCount()).toBe(total);
  });

  describe('Edit nozzles and Add nozzle are separate tools', () => {
    async function drawn() {
      const utils = await open();
      tap(utils.frame, 100, 100);
      tap(utils.frame, 300, 100);
      fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
      return { ...utils, total: nozzleCount() };
    }
    const xsNow = () => screen.getAllByTestId('layout-nozzle').map((n) => Number(n.getAttribute('cx'))).sort((a, b) => a - b);

    it('selects overlapping nozzles one at a time: each Edit tap deletes one, the other stays', async () => {
      const { frame, total } = await drawn();
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      const [, , third, fourth] = xsNow();
      // drag the third nozzle exactly onto the fourth
      fireEvent.pointerDown(frame, { clientX: third / 2, clientY: 100, pointerId: 3, button: 0 });
      fireEvent.pointerMove(frame, { clientX: (third + fourth) / 4, clientY: 100, pointerId: 3 });
      fireEvent.pointerMove(frame, { clientX: fourth / 2, clientY: 100, pointerId: 3 });
      fireEvent.pointerUp(frame, { clientX: fourth / 2, clientY: 100, pointerId: 3, button: 0 });
      expect(nozzleCount()).toBe(total);
      expect(xsNow().filter((x) => Math.abs(x - fourth) < 0.5)).toHaveLength(2);

      tap(frame, fourth / 2, 100);
      expect(nozzleCount()).toBe(total - 1);
      expect(xsNow().filter((x) => Math.abs(x - fourth) < 0.5)).toHaveLength(1);
      tap(frame, fourth / 2, 100);
      expect(nozzleCount()).toBe(total - 2);
      expect(xsNow().filter((x) => Math.abs(x - fourth) < 0.5)).toHaveLength(0);
      // nothing left there: a further Edit tap does nothing
      tap(frame, fourth / 2, 100);
      expect(nozzleCount()).toBe(total - 2);
    });

    it('Add nozzle on a nozzle adds next to it and never deletes', async () => {
      const { frame, total } = await drawn();
      fireEvent.click(screen.getByRole('button', { name: 'Add nozzle' }));
      const [, , third] = xsNow();
      tap(frame, third / 2, 100);
      expect(nozzleCount()).toBe(total + 1);
      tap(frame, third / 2, 100);
      expect(nozzleCount()).toBe(total + 2);
    });

    it('Add nozzle ignores the photo away from every line and shows a hint; Edit tap off a nozzle does nothing', async () => {
      const { frame, total } = await drawn();
      fireEvent.click(screen.getByRole('button', { name: 'Add nozzle' }));
      expect(screen.queryByText('Tap on a drawn line to add a nozzle')).not.toBeInTheDocument();
      tap(frame, 300, 400);
      expect(nozzleCount()).toBe(total);
      expect(screen.getByRole('status')).toHaveTextContent('Tap on a drawn line to add a nozzle');
      tap(frame, 100, 101); // on the line: adds, and the hint goes
      expect(nozzleCount()).toBe(total + 1);
      expect(screen.queryByText('Tap on a drawn line to add a nozzle')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      tap(frame, 300, 400);
      expect(nozzleCount()).toBe(total + 1);
    });
  });

  describe('manual edits belong to the current lines', () => {
    const cleared = () => screen.queryByTestId('layout-edits-cleared');

    // Draws the 200 css px eave line, then deletes its first corner and adds one nozzle mid-gap.
    async function drawAndEdit() {
      const utils = await open();
      const { frame } = utils;
      tap(frame, 100, 100);
      tap(frame, 300, 100);
      fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
      const base = nozzleCount();
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      tap(frame, 100, 100); // delete
      const xs = screen.getAllByTestId('layout-nozzle').map((n) => Number(n.getAttribute('cx'))).sort((a, b) => a - b);
      fireEvent.click(screen.getByRole('button', { name: 'Add nozzle' }));
      tap(frame, (xs[2] + xs[3]) / 2 / 2, 100); // add
      expect(nozzleCount()).toBe(base); // -1 +1
      return { ...utils, base, afterEdits: screen.getAllByTestId('layout-nozzle').map((n) => n.getAttribute('cx')).sort() };
    }

    it('keeps the edits when the lines do not change, and the counts reflect them', async () => {
      const { base, afterEdits } = await drawAndEdit();
      // switching tools and finishing nothing leaves the geometry, so the overlay stays
      fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      expect(cleared()).not.toBeInTheDocument();
      expect(screen.getAllByTestId('layout-nozzle').map((n) => n.getAttribute('cx')).sort()).toEqual(afterEdits);
      expect(countsText()).toContain(`Nozzles: ${base}`);
    });

    it('drawing another line re-places the nozzles, clears the edits and says so', async () => {
      const { frame } = await drawAndEdit();
      const fresh = placeNozzles([{ kind: 'eave', points: EAVE_POINTS }], { lat: LAT, zoom: ZOOM }).totals.count;
      fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
      tap(frame, 100, 300);
      expect(cleared()).toHaveTextContent('Changing the lines re-places the nozzles. Your 2 manual edits were cleared.');
      // eave line back to its automatic nozzles, plus the first fence point
      expect(nozzleCount()).toBe(fresh + 1);
    });

    it('Undo on the notice puts back the previous lines and edits in one step', async () => {
      const { frame, base, afterEdits } = await drawAndEdit();
      fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
      tap(frame, 100, 300);
      tap(frame, 300, 300);
      fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the previous lines and edits' }));
      expect(cleared()).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('layout-nozzle').filter((n) => n.dataset.kind === 'fence')).toHaveLength(0);
      expect(nozzleCount()).toBe(base);
      expect(screen.getAllByTestId('layout-nozzle').map((n) => n.getAttribute('cx')).sort()).toEqual(afterEdits);
    });

    it('clears on Undo of a line and on Clear, and a new edit or Dismiss hides the notice', async () => {
      const { frame } = await drawAndEdit();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(cleared()).toHaveTextContent('Your 2 manual edits were cleared.');
      expect(nozzleCount()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the previous lines and edits' }));
      expect(nozzleCount()).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(cleared()).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
      expect(cleared()).not.toBeInTheDocument();

      // no edits, no notice: drawing then closing a loop says nothing
      fireEvent.click(screen.getByRole('button', { name: 'Eave line' }));
      [[100, 100], [300, 100], [300, 250]].forEach(([x, y]) => tap(frame, x, y));
      tap(frame, 100, 100);
      expect(cleared()).not.toBeInTheDocument();
    });

    it('a new manual edit hides the notice', async () => {
      const { frame } = await drawAndEdit();
      fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
      tap(frame, 100, 300);
      tap(frame, 300, 300);
      fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
      expect(cleared()).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      tap(frame, 100, 300); // delete the fence's first corner
      expect(cleared()).not.toBeInTheDocument();
    });

    it('says "edit was" for a single edit', async () => {
      const { frame } = await open();
      tap(frame, 100, 100);
      tap(frame, 300, 100);
      fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit nozzles' }));
      tap(frame, 100, 100);
      fireEvent.click(screen.getByRole('button', { name: 'Fence line' }));
      tap(frame, 100, 300);
      expect(cleared()).toHaveTextContent('Your 1 manual edit was cleared.');
    });
  });

  it('warns when the count is above the estimator limit', async () => {
    const { frame } = await open({ limits: { minNozzles: 2, maxNozzles: 3 } });
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Finish line' }));
    expect(within(screen.getByTestId('layout-counts')).getByRole('status')).toHaveTextContent(/up to 3 nozzles/);
  });

  it('closes without writing anything on Cancel', async () => {
    const { frame, onUseCounts, onClose } = await open();
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onUseCounts).not.toHaveBeenCalled();
    await waitFor(() => expect(true).toBe(true));
  });
});
