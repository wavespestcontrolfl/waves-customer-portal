// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';
import { putCompletionDraft } from '../../lib/completion-resume-store';

// GATE_REPORT_PHOTO_CONTENT (owner spec 2026-09-27): buildAiReportPayload
// sends the tech's reviewed photo captions to generate-report, capped, and
// excludes a photo the tech removed before Generate — since captions live
// ON the current servicePhotos array, a removed photo's caption is simply
// never in it. The basic (non-typed) flow's photo SUMMARY is never sent in
// the payload at all (pre-push P2, Codex #5145 r4 — simplified from an
// earlier opt-in-ref design): the existing "Add to technician notes"
// button already carries the reviewed text into notes/serviceNotes, which
// is the only provenance it needs. The typed flow keeps sending it
// directly. Mirrors SchedulePage.field-recovery.test.jsx's draft-seeding
// pattern.
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
let nextAnalysisResponse;
beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  generateReportCalls = [];
  // Fresh captions/summary, deliberately DIFFERENT from whatever is
  // currently on the photos — used to prove a re-analysis invalidates an
  // already-installed AI report (pre-push P2, Codex #5145 r1). Individual
  // tests below override this to engineer specific edit scenarios.
  nextAnalysisResponse = {
    captions: ['Re-analyzed: ants at the front porch.', 'Re-analyzed: droppings under the sink.', 'Re-analyzed: garage perimeter treated.'],
    photoSummary: 'Re-analyzed summary of ant and rodent activity.',
  };
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      generateReportCalls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ report: 'WHAT WE DID\n\nTreated the perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }) };
    }
    if (url.includes('photo-analysis/draft')) {
      return { ok: true, json: async () => nextAnalysisResponse };
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

it('sends the reviewed captions to Generate, in current photo order', async () => {
  await seedAndRestore();
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body.photoCaptions).toEqual([
    'Ants at the front porch.',
    'Droppings under the kitchen sink.',
    'Garage perimeter treated.',
  ]);
  expect(body).not.toHaveProperty('photoSummary');
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
});

it('caps captions at 5 entries of 200 chars each, even if more/longer are restored', async () => {
  const longCaption = 'x'.repeat(250);
  const manyPhotos = Array.from({ length: 7 }, (_, i) => ({
    name: `p${i}.jpg`, data: `data:image/jpeg;base64,${i}`, capturedAt: '2099-01-01T12:00:00Z', caption: `${longCaption}`,
  }));
  await seedAndRestore({ servicePhotos: manyPhotos, generationPhotoCount: manyPhotos.length });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body.photoCaptions).toHaveLength(5);
  expect(body.photoCaptions.every((c) => c.length === 200)).toBe(true);
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

// Pre-push P2 (Codex #5145 r4): simplified from an earlier opt-in-ref
// design — the basic flow never sends photoSummary in the payload at all,
// whether or not "Add to technician notes" was clicked. The button still
// does exactly what it always did: put the reviewed text into notes, which
// reaches the writer through serviceNotes — ONE provenance, not two.
it('basic flow: "Add to technician notes" puts the summary into notes once; the payload never includes photoSummary', async () => {
  await seedAndRestore();
  fireEvent.click(screen.getAllByRole('button', { name: 'Add to technician notes' })[0]);
  expect(screen.getByPlaceholderText('Notes about this service...').value).toBe(
    'Treated the exterior perimeter.\n\nPhotos document ant and rodent activity.',
  );
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  const body = generateReportCalls[0];
  expect(body).not.toHaveProperty('photoSummary');
  expect(body.serviceNotes).toContain('Photos document ant and rodent activity.');
  // Reaches the writer exactly ONCE — never duplicated into a second field.
  const occurrences = (JSON.stringify(body).match(/Photos document ant and rodent activity\./g) || []).length;
  expect(occurrences).toBe(1);
});

// Typed flow: the summary "appears on the customer report" directly (no
// opt-in button rendered at all — see the ternary right next to it) — so
// it always sends, exactly as before this fix.
const typedService = {
  id: 'typed-photo-visit', customerId: 'typed-photo-customer', customerName: 'Typed Customer',
  serviceType: 'Termite Bait Station Monitoring', status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
  completionProfile: { serviceKey: 'termite', findingsType: 'termite_bait_station' },
  findingsSchema: {
    type: 'termite_bait_station',
    label: 'Termite Bait Station Inspection',
    fields: [
      { key: 'stations_checked', label: 'Stations checked', type: 'count', section: 'Station inspection' },
    ],
  },
};
const typedKey = `waves_completion_draft_${typedService.id}`;

async function seedAndRestoreTyped(overrides = {}) {
  const draft = {
    serviceId: typedService.id, draftId: 'draft-typed', savedAt: '2099-01-01T12:00:00Z',
    notes: '', generationPhotoCount: photos.length, servicePhotos: photos, sendSms: false,
    typedPhotoSummary: 'Photos document ant and rodent activity.',
    findingsValues: { stations_checked: '3' },
    ...overrides,
  };
  const { servicePhotos: _photos, ...metadata } = draft;
  localStorage.setItem(typedKey, JSON.stringify(metadata));
  await putCompletionDraft(typedService.id, draft);
  render(<CompletionPanel service={typedService} products={[]} onClose={() => {}} onSubmit={vi.fn()} />);
  await screen.findByPlaceholderText('Notes about this service...');
  await waitFor(() => expect(screen.queryByText('Loading saved draft…')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
  await screen.findByAltText(draft.servicePhotos[0].name);
}

it('typed flow: the photo summary sends unconditionally, with no opt-in step', async () => {
  await seedAndRestoreTyped();
  // No "Add to technician notes" button in the typed flow.
  expect(screen.queryByRole('button', { name: 'Add to technician notes' })).toBeNull();
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  expect(generateReportCalls[0].photoSummary).toBe('Photos document ant and rodent activity.');
});

it('typed flow: the photo summary is capped at 600 chars', async () => {
  await seedAndRestoreTyped({ typedPhotoSummary: 'y'.repeat(900) });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  expect(generateReportCalls[0].photoSummary).toHaveLength(600);
});

// Pre-push P2 (Codex #5145 r1, r4): captions are STILL a generation input
// (buildAiReportPayload always sends them; the summary no longer is for
// the basic flow) — editing them after a report is installed must
// invalidate it the same way editing notes/products/etc already does.
const GENERATED_REPORT = 'WHAT WE DID\n\nTreated the perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.';

it('re-analyzing photos (fresh captions) after a GROUNDED report was generated invalidates it', async () => {
  await seedAndRestore({
    // notes === generatedReportText: the tech hasn't touched the installed
    // AI text yet — this is what makes invalidation VISIBLE (the "draft was
    // cleared" banner + a revert to pre-generation notes). Notes the tech
    // already edited away from the installed text stay theirs untouched
    // (invalidateGeneratedReportOnTypedEdit's own documented contract) —
    // not what this test is proving.
    notes: GENERATED_REPORT,
    generatedReportText: GENERATED_REPORT,
    // The server's photoGroundingUsed flag, restored (pre-push P2, Codex
    // #5145 r3) — without it, re-analyzing below must NOT invalidate (see
    // the gate-off test further down).
    generationPhotoGroundingUsed: true,
    aiReportUsed: true,
    preGenerationNotes: 'Treated the exterior perimeter (pre-generation).',
  });
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  await screen.findByText(/the draft\s+was cleared/);
  expect(screen.getByPlaceholderText('Notes about this service...').value)
    .toBe('Treated the exterior perimeter (pre-generation).');
});

// Pre-push P2 (Codex #5145 r3): GATE_REPORT_PHOTO_CONTENT off (the default)
// means the server drops captions before building the prompt — a
// generated draft in this state is UNGROUNDED, and re-analyzing afterward
// must not clear it even though the watcher still runs. The shared
// beforeEach's mocked generate-report response carries no
// photoGroundingUsed flag, which is exactly the gate-off shape.
it('gate-off response (no photoGroundingUsed flag): re-analyzing photos after Generate does NOT clear the draft', async () => {
  await seedAndRestore({ notes: 'Treated the exterior perimeter.' });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
});

// The baseline-rebuild fix itself (pre-push P2, Codex #5145 r3): a FRESH
// grounded generation must not invalidate the draft it JUST installed the
// instant photoGroundingUsed flips from its false default — the watcher's
// own baseline has to be rebuilt under the NEW flag at install time, or
// this self-triggers exactly the same "the draft was cleared" banner on a
// draft the tech never touched.
it('installing a GROUNDED draft does not immediately invalidate itself', async () => {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      const res = await originalFetch(url, options);
      const data = await res.json();
      return { ok: res.ok, json: async () => ({ ...data, photoGroundingUsed: true }) };
    }
    return originalFetch(url, options);
  }));
  await seedAndRestore({ notes: 'Treated the exterior perimeter.' });
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]));
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  // Give the watcher's effect a chance to run before asserting it did NOT
  // invalidate — a real bug here would show the banner right about now.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
});

it('re-analyzing photos WHILE a GROUNDED Generate is in flight still invalidates once the request settles', async () => {
  let resolveGenerate;
  const pending = new Promise((resolve) => { resolveGenerate = resolve; });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    if (url.includes('generate-report')) {
      await pending;
      const res = await originalFetch(url, options);
      const data = await res.json();
      return { ok: res.ok, json: async () => ({ ...data, photoGroundingUsed: true }) };
    }
    return originalFetch(url, options);
  }));
  await seedAndRestore({ notes: 'Treated the exterior perimeter.' });
  act(() => { fireEvent.click(screen.getAllByRole('button', { name: /generate ai/i })[0]); });
  // Mid-request edit: the shared mechanism HOLDS invalidation while
  // `generating` is true (matches every other tracked input's contract) —
  // editing here must not throw, and must apply once the request settles.
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  resolveGenerate();
  await waitFor(() => expect(generateReportCalls.length).toBe(1));
  await screen.findByText(/the draft\s+was cleared/);
});

// Pre-push P2 (Codex #5145 r4): the basic-flow summary is not a generation
// input any more (it is never even sent) — editing the reviewed text in
// the textarea must never invalidate an installed draft, grounded or not.
it('editing the photo summary never invalidates the basic-flow draft — it is not a generation input', async () => {
  await seedAndRestore({
    notes: GENERATED_REPORT,
    generatedReportText: GENERATED_REPORT,
    generationPhotoGroundingUsed: true,
    aiReportUsed: true,
    preGenerationNotes: 'Treated the exterior perimeter (pre-generation).',
  });
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  const summaryBox = screen.getByDisplayValue('Photos document ant and rodent activity.');
  fireEvent.change(summaryBox, { target: { value: 'Edited summary text — not submitted anywhere.' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
});

// Pre-push P2 (Codex #5145 r4): the snapshot must track the EXACT capped
// captions buildAiReportPayload sends (reportPhotoInputs, shared) — an
// edit outside that cap (a 6th/7th photo's caption, with only 5 ever
// submitted) must not invalidate a grounded draft; an edit WITHIN the
// submitted set must.
function sevenPhotoDraftOverrides() {
  const longCaption = 'x'.repeat(250);
  const manyPhotos = Array.from({ length: 7 }, (_, i) => ({
    name: `p${i}.jpg`, data: `data:image/jpeg;base64,${i}`, capturedAt: '2099-01-01T12:00:00Z', caption: `${longCaption}`,
  }));
  return {
    notes: GENERATED_REPORT,
    generatedReportText: GENERATED_REPORT,
    generationPhotoGroundingUsed: true,
    aiReportUsed: true,
    preGenerationNotes: 'Treated the exterior perimeter (pre-generation).',
    servicePhotos: manyPhotos,
    generationPhotoCount: manyPhotos.length,
  };
}

it('grounded draft: re-analysis that only changes captions BEYOND the submitted 5/200 cap does not invalidate', async () => {
  await seedAndRestore(sevenPhotoDraftOverrides());
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  // The first 5 (what actually gets submitted, capped to 200 chars each)
  // come back byte-identical; only the 6th/7th (never submitted) change.
  nextAnalysisResponse = {
    captions: [
      'x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250),
      'a completely different 6th caption, outside the submitted cap',
      'a completely different 7th caption, outside the submitted cap',
    ],
    // handlePhotoAnalyze only applies captions when photoSummary is present.
    photoSummary: 'Re-analyzed summary — not itself a basic-flow generation input.',
  };
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
});

it('grounded draft: re-analysis that changes a caption WITHIN the submitted 5/200 cap does invalidate', async () => {
  await seedAndRestore(sevenPhotoDraftOverrides());
  expect(screen.queryByText(/the draft\s+was cleared/)).toBeNull();
  // The FIRST caption (well inside the submitted cap) changes; the rest
  // stay identical.
  nextAnalysisResponse = {
    captions: [
      'A genuinely different first caption, inside the submitted cap.',
      'x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250), 'x'.repeat(250),
      'x'.repeat(250), 'x'.repeat(250),
    ],
    // handlePhotoAnalyze only applies captions when photoSummary is present.
    photoSummary: 'Re-analyzed summary — not itself a basic-flow generation input.',
  };
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /analyze photos with ai/i })));
  await screen.findByText(/the draft\s+was cleared/);
});
