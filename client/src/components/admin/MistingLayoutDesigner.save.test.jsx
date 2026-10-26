// @vitest-environment jsdom
// Step 3: Save layout and reopening a saved layout (GATE_MISTING_LAYOUT_DESIGNER).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNozzleEdits, placeNozzles } from '../../lib/mistingLayoutGeometry';
import { buildLayoutPayload } from '../../lib/mistingLayoutPersist';

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
const FRAME = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 };

if (!window.PointerEvent) {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  };
}

beforeEach(() => {
  adminFetch.mockReset();
  composeSketchPng.mockReset();
  composeSketchPng.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  loadBestMapImage.mockReset();
  loadBestMapImage.mockResolvedValue({ image: {}, url: 'https://maps.example/test.png', zoom: ZOOM });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => FRAME);
  // jsdom has no canvas; the spray layer draws on one, so give it a context-less canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tap = (frame, x, y) => {
  fireEvent.pointerDown(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
  fireEvent.pointerUp(frame, { clientX: x, clientY: y, pointerId: 1, button: 0 });
};
const nozzleCount = () => screen.queryAllByTestId('layout-nozzle').length;
const props = (extra = {}) => ({ address: '500 Example Court', lat: LAT, lng: LNG, onClose: () => {}, ...extra });

// A saved layout as the server returns it, with edits applied to the final nozzles.
function savedLayout() {
  const lines = [{ id: 'L1', kind: 'eave', points: [{ x: 200, y: 200 }, { x: 800, y: 200 }] }];
  const placed = placeNozzles(lines, { lat: LAT, zoom: ZOOM });
  const finals = applyNozzleEdits(placed.nozzles, { removed: [placed.nozzles[2].key], moved: { [placed.nozzles[1].key]: { x: 260, y: 240 } }, added: [] });
  const payload = buildLayoutPayload({
    address: '500 Example Court', center: { lat: LAT, lng: LNG }, zoom: ZOOM, lines, nozzles: finals,
    risers: [{ x: 300, y: 300 }], pump: { x: 500, y: 300 }, zones: [{ kind: 'pool', x: 700, y: 600, radiusFt: 15 }], mapWidth: 1280, mapHeight: 960,
  });
  return { ...payload, id: 'lay-1', savedAt: '2026-10-26T15:00:00Z', counts: {} };
}

describe('Save layout', () => {
  it('asks for the estimate to be saved first when there is no estimate id, and does not read or write', async () => {
    render(<MistingLayoutDesigner {...props({ estimateId: null })} />);
    const frame = await screen.findByTestId('layout-map');
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Save the estimate first');
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled();
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it('is disabled until a layout has a nozzle', async () => {
    adminFetch.mockResolvedValueOnce({ layout: null });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    await screen.findByTestId('layout-map');
    expect(screen.getByRole('button', { name: 'Save layout' })).toBeDisabled();
  });

  it('composes the sketch, sends it with the geometry, then shows Saved with a time; a later edit shows Unsaved changes', async () => {
    adminFetch.mockResolvedValueOnce({ layout: null });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    const frame = await screen.findByTestId('layout-map');
    expect(adminFetch).toHaveBeenCalledWith('/admin/estimates/est-1/misting-layout');
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    tap(frame, 300, 100); // finish line
    const total = nozzleCount();
    expect(total).toBeGreaterThan(1);

    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T15:30:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));

    expect(composeSketchPng).toHaveBeenCalledTimes(1);
    const [path, options] = adminFetch.mock.calls[1];
    expect(path).toBe('/admin/estimates/est-1/misting-layout');
    expect(options.method).toBe('PUT');
    const sent = JSON.parse(options.body.get('payload'));
    expect(sent.nozzles).toHaveLength(total);
    expect(sent).toMatchObject({ zoom: ZOOM, mapWidth: 1280, mapHeight: 960, address: '500 Example Court' });
    expect(sent.lines).toHaveLength(1);
    expect(options.body.get('snapshot')).toBeInstanceOf(Blob);

    // An edit after the save makes the saved state stale.
    fireEvent.click(screen.getByRole('button', { name: 'Riser' }));
    tap(frame, 400, 300);
    expect(screen.getByTestId('layout-save-status')).toHaveTextContent('Unsaved changes');
  });

  it('shows the server error and stays unsaved when the save fails', async () => {
    adminFetch.mockResolvedValueOnce({ layout: null });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    const frame = await screen.findByTestId('layout-map');
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    adminFetch.mockRejectedValueOnce(new Error('Snapshot exceeds the 8MB limit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    expect(await screen.findByTestId('layout-save-error')).toHaveTextContent('Snapshot exceeds the 8MB limit');
    expect(screen.queryByTestId('layout-save-status')?.textContent || '').not.toMatch(/^Saved/);
  });
});

describe('reopening a saved layout', () => {
  it('loads the photo at the saved center and zoom and restores nozzles, risers, pump and zones as saved', async () => {
    const saved = savedLayout();
    adminFetch.mockResolvedValueOnce({ layout: saved });
    // No coordinates are passed: the saved ones win.
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1', lat: undefined, lng: undefined })} />);
    await screen.findByTestId('layout-map');
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', [ZOOM]);
    expect(nozzleCount()).toBe(saved.nozzles.length);
    expect(screen.getAllByTestId('layout-riser')).toHaveLength(1);
    expect(screen.getAllByTestId('layout-zone')).toHaveLength(1);
    expect(screen.getByTestId('layout-pump')).toBeInTheDocument();
    expect(screen.getByTestId('layout-counts').textContent).toContain(`Nozzles: ${saved.nozzles.length}`);
    // The moved nozzle is where it was saved.
    const moved = screen.getAllByTestId('layout-nozzle').find((el) => Number(el.getAttribute('cx')) === 260);
    expect(moved).toBeTruthy();
    // Nothing has changed since the save.
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
  });

  it('changing the lines after the reopen re-places the nozzles and clears the saved edits with the usual notice and undo', async () => {
    const saved = savedLayout();
    adminFetch.mockResolvedValueOnce({ layout: saved });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    const frame = await screen.findByTestId('layout-map');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); // removes the restored line
    expect(screen.getByTestId('layout-edits-cleared')).toHaveTextContent(/manual edits? (was|were) cleared/);
    expect(nozzleCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo and restore the previous lines and edits' }));
    expect(nozzleCount()).toBe(saved.nozzles.length);
    expect(frame).toBeInTheDocument();
  });

  it('does not reopen a layout saved for a different address: the designer starts blank, says so, and a save replaces it', async () => {
    const saved = savedLayout();
    adminFetch.mockResolvedValueOnce({ layout: saved });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1', address: '900 Other Road, Venice, FL' })} />);
    const frame = await screen.findByTestId('layout-map');
    expect(screen.getByTestId('layout-other-address')).toHaveTextContent(/different address/);
    expect(nozzleCount()).toBe(0);
    // The photo is the new address's, not the saved layout's.
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', [21, 20, 19]); // the Treatment Zone Mapper's order: as close as the imagery goes
    tap(frame, 100, 100);
    tap(frame, 300, 100);
    adminFetch.mockResolvedValueOnce({ layout: { savedAt: '2026-10-26T16:00:00Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    await waitFor(() => expect(screen.getByTestId('layout-save-status').textContent).toMatch(/^Saved /));
    expect(JSON.parse(adminFetch.mock.calls[1][1].body.get('payload')).address).toBe('900 Other Road, Venice, FL');
  });

  it('treats the same address typed with different case and punctuation as the same property', async () => {
    const saved = savedLayout();
    adminFetch.mockResolvedValueOnce({ layout: saved });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1', address: '500  EXAMPLE COURT.' })} />);
    await screen.findByTestId('layout-map');
    expect(screen.queryByTestId('layout-other-address')).not.toBeInTheDocument();
    expect(nozzleCount()).toBe(saved.nozzles.length);
  });

  it('a layout that cannot be read blocks the designer instead of opening blank', async () => {
    adminFetch.mockRejectedValueOnce(new Error('Not enabled'));
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not enabled/);
    expect(screen.queryByTestId('layout-map')).not.toBeInTheDocument();
    expect(loadBestMapImage).not.toHaveBeenCalled();
  });

  it('opens blank when the estimate has no saved layout', async () => {
    adminFetch.mockResolvedValueOnce({ layout: null });
    render(<MistingLayoutDesigner {...props({ estimateId: 'est-1' })} />);
    await screen.findByTestId('layout-map');
    expect(nozzleCount()).toBe(0);
    expect(loadBestMapImage).toHaveBeenCalledWith(LAT, LNG, 'test-key', [21, 20, 19]); // the Treatment Zone Mapper's order: as close as the imagery goes
  });
});
