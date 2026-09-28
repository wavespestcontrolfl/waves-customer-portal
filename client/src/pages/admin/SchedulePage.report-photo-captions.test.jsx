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
    if (url.includes('photo-analysis/draft')) {
      // Fresh captions/summary, deliberately DIFFERENT from whatever is
      // currently on the photos — used to prove a re-analysis invalidates
      // an already-installed AI report (pre-push P2, Codex #5145 r1).
      return {
        ok: true,
        json: async () => ({
          captions: ['Re-analyzed: ants at the front porch.', 'Re-analyzed: droppings under the sink.', 'Re-analyzed: garage perimeter treated.'],
          photoSummary: 'Re-analyzed summary of ant and rodent activity.',
        }),
      };
    }
    return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function seedAndRestore(overrides = {}) {
  const draft = {
    serviceId: service.id, draftId: 'draft-one', savedAt: '2099-01-01T12:00:00Z',
    // Non-empty notes (pre-push P2, Codex #5145 r1): reviewed captions no
    // longer open Generate on their own client-side (see the dedicated test
    // below), so every OTHER test here needs some ordinary substantive
    // input to reach the fetch at all — notes serve that role without
    // touching what these tests actually assert (caption/summary content).
    notes: 'Treated the exterior perimeter.',
    generationPhotoCount: photos.length, servicePhotos: photos, sendSms: false,
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

// Pre-push P2 (Codex #5145 r1): GATE_REPORT_PHOTO_CONTENT is a deploy-wide
// GATE_* flag with no client-visible readout (no dedicated endpoint the way
// GATE_JOB_CARD/GATE_DISCOUNT_STACKING each have one, and it isn't a
// per-user flag `useFeatureFlag` can read) — so with the gate off the
// server always 400s a captions-only generate-report request. Reviewed
// captions must not open Generate client-side on their own, or the tech
// gets a "Generate" button that looks live and fails on click.
it('reviewed captions alone (no other substantive input) never open Generate — nothing is sent, an alert explains why', async () => {
  await seedAndRestore({ notes: '', typedPhotoSummary: 'Photos document ant and rodent activity.' });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  expect(generateReportCalls.length).toBe(0);
  expect(globalThis.alert).toHaveBeenCalledWith('Add service notes, products, or visit details first.');
});

// Pre-push P2 (Codex #5145 r1): captions/typedPhotoSummary are generation
// inputs (buildAiReportPayload), so editing them after a report is installed
// must invalidate it the same way editing notes/products/etc already does —
// previously the generation snapshot tracked only servicePhotos.length, so
// an edited caption (same photo count) or a summary edit (untracked at all)
// left the stale AI copy installed as if nothing had changed.
const GENERATED_REPORT = 'WHAT WE DID\n\nTreated the perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.';

it('editing the photo summary after a report was generated invalidates it', async () => {
  await seedAndRestore({
    // notes === generatedReportText: the tech hasn't touched the installed
    // AI text yet — this is what makes invalidation VISIBLE (the "draft was
    // cleared" banner + a revert to pre-generation notes). Notes the tech
    // already edited away from the installed text stay theirs untouched
    // (invalidateGeneratedReportOnTypedEdit's own documented contract) —
    // not what this test is proving.
    notes: GENERATED_REPORT,
    generatedReportText: GENERATED_REPORT,
    aiReportUsed: true,
    preGenerationNotes: 'Treated the exterior perimeter (pre-generation).',
  });
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  const summaryBox = screen.getByDisplayValue('Photos document ant and rodent activity.');
  fireEvent.change(summaryBox, { target: { value: 'Photos document ant activity and a NEW rodent sighting.' } });
  await screen.findByText(/the draft\s+was cleared/);
  expect(screen.getByPlaceholderText('Notes about this service...').value)
    .toBe('Treated the exterior perimeter (pre-generation).');
});

it('re-analyzing photos (fresh AI captions) after a report was generated invalidates it', async () => {
  await seedAndRestore({
    notes: GENERATED_REPORT,
    generatedReportText: GENERATED_REPORT,
    aiReportUsed: true,
    preGenerationNotes: 'Treated the exterior perimeter (pre-generation).',
  });
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  await screen.findByText(/the draft\s+was cleared/);
});

it('editing the photo summary WHILE Generate is in flight still invalidates once the request settles', async () => {
  let resolveGenerate;
  const pending = new Promise((resolve) => { resolveGenerate = resolve; });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      await pending;
      return originalFetch(url, options);
    }
    return originalFetch(url, options);
  }));
  await seedAndRestore({ notes: 'Treated the exterior perimeter.' });
  act(() => { fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]); });
  // Mid-request edit: the shared mechanism HOLDS invalidation while
  // `generating` is true (matches every other tracked input's contract) —
  // editing here must not throw, and must apply once the request settles.
  const summaryBox = screen.getByDisplayValue('Photos document ant and rodent activity.');
  fireEvent.change(summaryBox, { target: { value: 'Edited mid-generation.' } });
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  resolveGenerate();
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  await screen.findByText(/the draft\s+was cleared/);
});
