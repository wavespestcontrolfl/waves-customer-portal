// @vitest-environment jsdom
// Save layout draws the sketch into an image before its upload starts, so no
// save is open yet. The save holds an out-of-date tab's reload until it
// settles (lib/reloadHolds.js).
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../../../lib/mistingLayoutSketchCanvas', () => ({ composeSketchPng: vi.fn() }));
vi.mock('../../../lib/mistingLayoutPersist', () => ({
  buildLayoutPayload: () => ({ nozzles: 1 }),
  layoutForExport: () => ({ lines: [], nozzles: [], risers: [] }),
  putLayout: vi.fn(async () => ({ savedAt: '2026-11-20T08:00:00.000Z' })),
}));
vi.mock('../../../lib/mistingLayoutSketch', () => ({ buildSketchModel: () => ({}) }));
vi.mock('../../../lib/mistingLayoutExtras', () => ({ pumpChecklistDone: () => true }));

import useMistingLayoutSave from './useMistingLayoutSave';
import { composeSketchPng } from '../../../lib/mistingLayoutSketchCanvas';
import { putLayout } from '../../../lib/mistingLayoutPersist';
import { reloadHoldNames } from '../../../lib/reloadHolds';

const mapState = { status: 'ready', center: { lat: 27.3, lng: -82.5 }, zoom: 20, image: null, url: 'https://maps.example/tile.png' };
const layout = { allLines: [], nozzles: [{ id: 'n1' }], risers: [], pump: { id: 'p1' }, zones: [] };

it('holds an out-of-date tab reload from Save layout while the sketch is drawn, until the upload settles', async () => {
  let finishSketch;
  composeSketchPng.mockImplementation(() => new Promise((resolve) => { finishSketch = resolve; }));
  const { result } = renderHook(() => useMistingLayoutSave({ estimateId: 'est-1', mapState, address: '1 Palm Way', layout, saved: null }));
  let saving;
  act(() => { saving = result.current.save(); });
  expect(reloadHoldNames()).toContain('misting-layout');
  expect(putLayout).not.toHaveBeenCalled();
  await act(async () => {
    finishSketch(new Blob(['png']));
    await saving;
  });
  expect(putLayout).toHaveBeenCalledTimes(1);
  expect(reloadHoldNames()).not.toContain('misting-layout');
  expect(result.current.status).toBe('saved');
});
