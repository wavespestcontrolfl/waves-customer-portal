// @vitest-environment jsdom
// Tree & Shrub Fast Complete, GATE_TS_WATCH_LIST: the "This month's watch list"
// block (only when the context carries watchList), Seen / Not seen on what the
// photo read flagged, Add from watch list, an extent on a seen item, the
// refer-only line, the treeShrubReview.watchItems payload, and nothing here
// ever blocking Complete. Synthetic data only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FastCompleteTreeShrubSheet from './FastCompleteTreeShrubSheet';
import watchConfig from '../../../../server/config/tree-shrub-watch-list.js';

vi.mock('../../lib/completion-photo', () => ({
  prepareCompletionPhoto: vi.fn(async (file) => ({
    data: `data:image/jpeg;base64,${file.name}`,
    name: file.name,
    capturedAt: '2026-10-04T14:00:00.000Z',
  })),
}));

vi.setConfig({ testTimeout: 30000 });

beforeEach(() => { vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CATALOG = [
  { id: 'iron', name: 'Chelated Iron Plus', category: 'micronutrient', tsFlags: {} },
];
const VISIT = {
  id: 'svc-ts', customerId: 'cust-1', propertyId: 'prop-1', catalogServiceId: 'cat-ts',
  serviceType: 'Tree & Shrub Program', scheduledDate: '2026-10-04', address: { line1: '123 Main St' }, status: 'confirmed',
};
const SERVICE = { id: 'svc-ts', customerName: 'Pat Jones', serviceType: 'Tree & Shrub', address: '123 Main St', timeLabel: '2:00 PM' };

const WATCH_LIST = [
  { key: 'scale', label: 'Scale', signal: 'Possible scale', referOnly: false },
  { key: 'whitefly', label: 'Whitefly', signal: 'Possible whitefly', referOnly: false },
  { key: 'root_rot', label: 'Root or collar rot', signal: 'Possible root or collar rot', referOnly: false },
  { key: 'bed_weeds', label: 'Bed weeds', signal: 'Possible bed weeds', referOnly: false },
  { key: 'trunk_conk_base', label: 'Trunk conk at the base', signal: 'Possible trunk conk at the base', referOnly: true },
];
const BASE_CONTEXT = {
  eligible: true, reason: null, service: VISIT, products: CATALOG,
  monthProducts: [{ productId: 'iron', method: 'foliar_spray' }],
  lastVisit: { plantGroups: ['Palms'], areasTreated: [], products: [] },
  warnings: [],
};
const CONTEXT = { ...BASE_CONTEXT, watchList: WATCH_LIST };

const PREVIEW = {
  scores: { foliageFullness: 80 },
  observations: 'Some thin foliage.',
  scoredCount: 2,
  photoCount: 2,
  signature: 'sig-1',
  aiSummary: 'AI flagged 1 item to review.',
  findings: [{ key: 'pest_activity', label: 'Pest-pressure signals', detail: 'Possible pest-pressure signals on foliage.', defaultAction: 'monitor' }],
  watchSignals: ['scale', 'trunk_conk_base'],
  suggestedCondition: 'Fair',
  status: 'complete',
};

function makeRequest({ context = CONTEXT, preview = PREVIEW } = {}) {
  const calls = [];
  const request = vi.fn(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('/tree-shrub/fast-context')) return context;
    if (path.endsWith('/tree-shrub/assess-preview')) return preview;
    if (path.endsWith('/tech-tips')) return { available: false };
    if (path.endsWith('/complete')) return { success: true };
    return {};
  });
  request.calls = calls;
  return request;
}

async function openSheet(request = makeRequest()) {
  render(<FastCompleteTreeShrubSheet service={SERVICE} request={request} onClose={() => {}} />);
  await screen.findByRole('button', { name: /^Chelated Iron Plus/ });
  return request;
}

const addPhoto = async (slot, name) => {
  fireEvent.change(screen.getByLabelText(`${slot} photo file`), { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  await screen.findByAltText(`${slot} photo`);
};
const addBothPhotos = async () => {
  await addPhoto('Front beds', 'front.jpg');
  await addPhoto('Back or side landscape', 'back.jpg');
};
const analyze = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Analyze photos' }));
  await screen.findByText('Pest-pressure signals');
};
const completeButton = () => screen.getByRole('button', { name: 'Complete tree & shrub' });
const completeBody = async (request) => {
  fireEvent.click(completeButton());
  await waitFor(() => expect(request.calls.some((c) => c.path.endsWith('/complete'))).toBe(true));
  return JSON.parse(request.calls.find((c) => c.path.endsWith('/complete')).options.body);
};
const pressed = (name) => screen.getByRole('button', { name }).getAttribute('aria-pressed');
const tick = (label) => fireEvent.click(screen.getByRole('button', { name: label }));
// The list stays open after a pick, so several items can be added in a row.
const addFromList = (label) => {
  const opener = screen.getByRole('button', { name: 'Add from watch list' });
  if (opener.getAttribute('aria-expanded') !== 'true') fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: label }));
};

async function readyVisit(request) {
  await openSheet(request);
  await addBothPhotos();
  fireEvent.click(screen.getByRole('button', { name: 'Good' }));
}

describe('the block', () => {
  test('hidden without watchList (gate off), with no list controls', async () => {
    await openSheet(makeRequest({ context: BASE_CONTEXT }));
    expect(screen.queryByText("This month's watch list")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add from watch list' })).toBeNull();
  });

  test('hidden when the month has no items', async () => {
    await openSheet(makeRequest({ context: { ...BASE_CONTEXT, watchList: [] } }));
    expect(screen.queryByText("This month's watch list")).toBeNull();
  });

  test('shown with the list: nothing flagged before Analyze, the add control on offer', async () => {
    await openSheet();
    expect(screen.getByRole('heading', { name: "This month's watch list" })).toBeTruthy();
    expect(screen.queryByText('Possible scale')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add from watch list' })).toBeTruthy();
  });

  test('follows the finding tiles: the block comes after the photos section', async () => {
    await openSheet();
    const photos = screen.getByRole('heading', { name: 'Photos' });
    const watch = screen.getByRole('heading', { name: "This month's watch list" });
    expect(photos.compareDocumentPosition(watch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('what the read flagged: Seen / Not seen', () => {
  test('flagged items show their signal text, undecided by default', async () => {
    await openSheet();
    await addBothPhotos();
    await analyze();
    expect(screen.getByText('Possible scale')).toBeTruthy();
    expect(screen.getByText('Possible trunk conk at the base')).toBeTruthy();
    expect(screen.queryByText('Possible whitefly')).toBeNull();
    expect(pressed('Seen: Scale')).toBe('false');
    expect(pressed('Not seen: Scale')).toBe('false');
  });

  test('two taps, tap again to go back to undecided; no extent until seen', async () => {
    await openSheet();
    await addBothPhotos();
    await analyze();
    expect(screen.queryByRole('button', { name: 'A few: Scale' })).toBeNull();
    tick('Seen: Scale');
    expect(pressed('Seen: Scale')).toBe('true');
    expect(pressed('Not seen: Scale')).toBe('false');
    expect(screen.getByRole('button', { name: 'A few: Scale' })).toBeTruthy();
    tick('Not seen: Scale');
    expect(pressed('Seen: Scale')).toBe('false');
    expect(pressed('Not seen: Scale')).toBe('true');
    expect(screen.queryByRole('button', { name: 'A few: Scale' })).toBeNull();
    tick('Not seen: Scale');
    expect(pressed('Not seen: Scale')).toBe('false');
  });

  test('a flagged item that is not on this month list is ignored', async () => {
    const preview = { ...PREVIEW, watchSignals: ['scale', 'palm_potassium_deficiency'] };
    await openSheet(makeRequest({ preview }));
    await addBothPhotos();
    await analyze();
    expect(screen.queryByText('Possible potassium deficiency')).toBeNull();
  });

  test('a complete read that flagged nothing on the list says so', async () => {
    await openSheet(makeRequest({ preview: { ...PREVIEW, watchSignals: [], watchSignalsComplete: true } }));
    await addBothPhotos();
    await analyze();
    expect(screen.getByText('The photo read flagged nothing on this list.')).toBeTruthy();
  });

  test('a watch read that did not finish is never shown as a clean result', async () => {
    await openSheet(makeRequest({ preview: { ...PREVIEW, watchSignals: [], watchSignalsComplete: false } }));
    await addBothPhotos();
    await analyze();
    expect(screen.queryByText('The photo read flagged nothing on this list.')).toBeNull();
    expect(screen.getByText('The photo read did not check this list. Add anything you saw.')).toBeTruthy();
  });
});

describe('Add from watch list and the extent', () => {
  test('any other item can be marked seen; the flagged ones are not offered again', async () => {
    await openSheet();
    await addBothPhotos();
    await analyze();
    tick('Add from watch list');
    expect(screen.queryByRole('button', { name: 'Scale' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Whitefly' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Whitefly' }));
    // now a tile of its own (its label), with an extent and a Remove
    expect(screen.getByText('Whitefly', { selector: 'p' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Whitefly' })).toBeNull();
    expect(screen.getByRole('button', { name: 'One plant: Whitefly' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Whitefly' }));
    expect(screen.queryByText('Whitefly', { selector: 'p' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Whitefly' })).toBeTruthy();
  });

  test('works with no photo read at all', async () => {
    await openSheet();
    addFromList('Bed weeds');
    expect(screen.getByRole('button', { name: 'Many: Bed weeds' })).toBeTruthy();
  });

  test('extent is optional, one of three, and tapping it again clears it', async () => {
    await openSheet();
    addFromList('Bed weeds');
    for (const [label, value] of [['One plant', 'one_plant'], ['A few', 'a_few'], ['Many', 'many']]) {
      expect(watchConfig.EXTENTS).toContain(value);
      expect(screen.getByRole('button', { name: `${label}: Bed weeds` }).getAttribute('aria-pressed')).toBe('false');
    }
    tick('A few: Bed weeds');
    expect(pressed('A few: Bed weeds')).toBe('true');
    tick('Many: Bed weeds');
    expect(pressed('A few: Bed weeds')).toBe('false');
    expect(pressed('Many: Bed weeds')).toBe('true');
    tick('Many: Bed weeds');
    expect(pressed('Many: Bed weeds')).toBe('false');
  });

  test('a refer-only item shows the call line when seen and takes no extent', async () => {
    await openSheet();
    await addBothPhotos();
    await analyze();
    expect(screen.queryByText('Take a photo, add a note and call the office.')).toBeNull();
    tick('Seen: Trunk conk at the base');
    expect(screen.getByText('Take a photo, add a note and call the office.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /One plant: Trunk conk/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Many: Trunk conk/ })).toBeNull();
    tick('Not seen: Trunk conk at the base');
    expect(screen.queryByText('Take a photo, add a note and call the office.')).toBeNull();
  });

  test('a refer-only item added from the list shows the line and no extent', async () => {
    await openSheet(makeRequest({ preview: { ...PREVIEW, watchSignals: [] } }));
    addFromList('Trunk conk at the base');
    expect(screen.getByText('Take a photo, add a note and call the office.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /A few: Trunk conk/ })).toBeNull();
  });
});

describe('the body', () => {
  test('nothing decided: no watchItems, no review without a preview (existing contract)', async () => {
    const request = makeRequest();
    await readyVisit(request);
    const body = await completeBody(request);
    expect(body).not.toHaveProperty('treeShrubReview');
  });

  test('read items go as source read, added items as source tech, undecided items stay out', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await analyze();
    tick('Seen: Scale');
    tick('A few: Scale');
    tick('Not seen: Trunk conk at the base');
    addFromList('Bed weeds');
    tick('Many: Bed weeds');
    addFromList('Root or collar rot'); // seen, no extent
    const body = await completeBody(request);
    expect(body.treeShrubReview.signature).toBe('sig-1');
    expect(body.treeShrubReview.watchItems).toEqual([
      { key: 'scale', state: 'seen', extent: 'a_few', source: 'read' },
      { key: 'root_rot', state: 'seen', extent: null, source: 'tech' },
      { key: 'bed_weeds', state: 'seen', extent: 'many', source: 'tech' },
      { key: 'trunk_conk_base', state: 'not_seen', extent: null, source: 'read' },
    ].sort((a, b) => WATCH_LIST.findIndex((i) => i.key === a.key) - WATCH_LIST.findIndex((i) => i.key === b.key)));
  });

  test('a refer-only item goes with no extent', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await analyze();
    tick('Seen: Trunk conk at the base');
    const body = await completeBody(request);
    expect(body.treeShrubReview.watchItems).toEqual([{ key: 'trunk_conk_base', state: 'seen', extent: null, source: 'read' }]);
  });

  test('tech-added items with no photo read ride a review with watchItems only', async () => {
    const request = makeRequest();
    await readyVisit(request);
    addFromList('Whitefly');
    tick('A few: Whitefly');
    const body = await completeBody(request);
    expect(body.treeShrubReview).toEqual({ watchItems: [{ key: 'whitefly', state: 'seen', extent: 'a_few', source: 'tech' }] });
  });

  test('the read finding decisions are untouched beside the watch items', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await analyze();
    tick('Seen: Scale');
    const body = await completeBody(request);
    expect(body.treeShrubReview.decisions).toEqual([
      { key: 'pest_activity', action: 'monitor', detail: 'Possible pest-pressure signals on foliage.' },
    ]);
  });

  test('a photo change drops the read and the review; what the tech chose as seen stays, now as the tech\'s own', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await analyze();
    tick('Seen: Scale');
    tick('Not seen: Trunk conk at the base');
    addFromList('Bed weeds');
    await addPhoto('Whole palm', 'palm.jpg');
    expect(screen.queryByText('Possible scale')).toBeNull();
    const body = await completeBody(request);
    // Not seen on a flagged item goes with the read; Seen stays, no longer 'read'.
    expect(body.treeShrubReview).toEqual({ watchItems: [
      { key: 'scale', state: 'seen', extent: null, source: 'tech' },
      { key: 'bed_weeds', state: 'seen', extent: null, source: 'tech' },
    ] });
  });
});

describe('nothing here blocks Complete', () => {
  test('the button is ready with the block on screen and nothing decided', async () => {
    await readyVisit(makeRequest());
    expect(completeButton().disabled).toBe(false);
  });

  test('a seen item with no extent, a not seen item and a refer-only item never hold Complete', async () => {
    const request = makeRequest();
    await readyVisit(request);
    await analyze();
    tick('Seen: Scale');
    tick('Seen: Trunk conk at the base');
    addFromList('Whitefly');
    expect(completeButton().disabled).toBe(false);
    const body = await completeBody(request);
    expect(body.visitOutcome).toBe('completed');
    expect(body.treeShrubReview.watchItems).toHaveLength(3);
  });

  test('the block adds no requirement of its own: without photos the existing reason is the only one', async () => {
    await openSheet();
    addFromList('Whitefly');
    const button = completeButton();
    expect(within(button.parentElement).queryByText(/watch/i)).toBeNull();
  });
});
