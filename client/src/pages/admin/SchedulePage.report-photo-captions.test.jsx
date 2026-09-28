// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';
import { putCompletionDraft } from '../../lib/completion-resume-store';

// GATE_REPORT_PHOTO_CONTENT (owner spec 2026-09-27): buildAiReportPayload
// sends the tech's reviewed photo captions/summary to generate-report,
// capped, and excludes a photo the tech removed before Generate — since
// captions live ON the current servicePhotos array, a removed photo's
// caption is simply never in it. Mirrors SchedulePage.field-recovery.test.jsx's
// draft-seeding pattern.
const service = {
  id: 'photo-caption-visit', customerId: 'photo-caption-customer', customerName: 'Synthetic Customer',
  serviceType: 'Pest Control', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
const key = `waves_completion_draft_${service.id}`;
const photos = [
  { name: 'front.jpg', data: 'data:image/jpeg;base64,AAAA', capturedAt: '2099-01-01T12:00:00Z', caption: 'Ants at the front porch.' },
  { name: 'kitchen.jpg', data: 'data:image/jpeg;base64,BBBB', capturedAt: '2099-01-01T12:01:00Z', caption: 'Droppings under the kitchen sink.' },
  { name: 'garage.jpg', data: 'data:image/jpeg;base64,CCCC', capturedAt: '2099-01-01T12:02:00Z', caption: 'Garage perimeter treated.' },
];

let generateReportCalls;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  generateReportCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      generateReportCalls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ report: 'WHAT WE DID\n\nTreated the perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }) };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function seedAndRestore(overrides = {}) {
  const draft = {
    serviceId: service.id, draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
    notes: '', generationPhotoCount: photos.length, servicePhotos: photos, sendSms: false,
    typedPhotoSummary: 'Photos document ant and rodent activity.',
    ...overrides,
  };
  const { servicePhotos: _photos, ...metadata } = draft;
  localStorage.setItem(key, JSON.stringify(metadata));
  await putCompletionDraft(service.id, draft);
  const view = render(<CompletionPanel service={service} products={[]} onClose={() => {}} onSubmit={vi.fn()} />);
  await screen.findByPlaceholderText('Notes about this service...');
  await waitFor(() => expect(screen.queryByText('Loading saved draft…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
  await screen.findByAltText(draft.servicePhotos[0].name);
  return view;
}

it('sends the reviewed captions and summary to Generate, in current photo order', async () => {
  await seedAndRestore();
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body.photoCaptions).toEqual([
    'Ants at the front porch.',
    'Droppings under the kitchen sink.',
    'Garage perimeter treated.',
  ]);
  expect(body.photoSummary).toBe('Photos document ant and rodent activity.');
});

it('excludes a photo removed before Generate — its caption is never sent', async () => {
  await seedAndRestore();
  // Remove the middle photo (kitchen.jpg). The per-photo remove control is
  // an unlabeled "×" button (SchedulePage.jsx removePhoto callers) — matched
  // by its rendered glyph rather than an accessible name/label.
  const removeButtons = screen.getAllByRole('button', { name: '×' });
  fireEvent.click(removeButtons[1]);
  await waitFor(() => expect(screen.queryByAltText('kitchen.jpg')).toBeNull());
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body.photoCaptions).toEqual(['Ants at the front porch.', 'Garage perimeter treated.']);
  expect(body.photoCaptions).not.toContain('Droppings under the kitchen sink.');
  // Removing a photo also clears the now-stale set-level summary
  // (removePhoto resets typedPhotoSummary) — nothing describing a set that
  // no longer exists should reach the writer.
  expect(body).not.toHaveProperty('photoSummary');
});

it('caps captions at 5 entries of 200 chars each, even if more/longer are restored', async () => {
  const longCaption = 'x'.repeat(250);
  const manyPhotos = Array.from({ length: 7 }, (_, i) => ({
    name: `p${i}.jpg`, data: `data:image/jpeg;base64,${i}`, capturedAt: '2099-01-01T12:00:00Z', caption: `${longCaption}`,
  }));
  await seedAndRestore({ servicePhotos: manyPhotos, generationPhotoCount: manyPhotos.length, typedPhotoSummary: 'y'.repeat(900) });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body.photoCaptions).toHaveLength(5);
  expect(body.photoCaptions.every((c) => c.length === 200)).toBe(true);
  expect(body.photoSummary).toHaveLength(600);
});
